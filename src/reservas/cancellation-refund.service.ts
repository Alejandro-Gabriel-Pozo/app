/**
 * @file cancellation-refund.service.ts
 * @description C2 — reembolso + Nota de Crédito al cancelar una reserva
 * que ya cobró algo (docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md).
 * Archivo propio, no un método más de `ReservationService` (que ya ronda
 * las 700 líneas) — mismo criterio de composición que `InvoiceService`, que
 * agrega repositorios de otros contextos vía `Pick<>` estrecho. Acá el
 * sentido es inverso: `reservas` lee (solo lectura) del repositorio de
 * `facturacion` -- sin ciclo real, depende de la interfaz
 * `InvoiceRepository`, no de `InvoiceService`.
 *
 * No emite la Nota de Crédito acá -- `confirmRefund()` solo crea la(s)
 * fila(s) `REFUND` en el ledger (con `reversedInvoiceId` resuelto, R9).
 * Pedir el CAE es una llamada de red que no debe vivir dentro de la
 * transacción de BD (mismo criterio que `InvoiceService.requestInvoice()`,
 * que separa el INSERT atómico de `issue()`) -- se reusa la MISMA ruta
 * `POST /invoices` ya existente, con `financialTransactionId` = la del
 * `REFUND` creado. `InvoiceService.requestInvoice()` detecta
 * `tx.type === 'REFUND'` y arma la NC en vez de una Factura (R14, un solo
 * camino para pedir CAE).
 */

import { randomUUID } from 'crypto';
import type { ReservationRepository } from './reservation.repository.js';
import type { CancellationPolicyRepository } from './cancellation-policy.repository.js';
import type { FinancialTransactionRepository, FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { ReservationStatus } from '../types/enums.js';
import { ReservationNotFoundError, ReservationNotCancelledError, NothingToRefundError } from '../domain/errors.js';
import { round2 } from '../domain/money.js';
import { CBTE_TIPO_FACTURA_B } from '../facturacion/afip-catalog.constants.js';
import { acquireIdempotencyLock, applyCappedRefundToInvoice, createIdempotentPaymentWithClient } from '../clientes-finanzas/payment-application.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface CancellationRefundPreview {
  collected: number;
  daysBeforeCheckin: number;
  refundPercentage: number;
  refundAmount: number;
}

export class CancellationRefundService {
  constructor(
    private readonly reservationRepo: Pick<ReservationRepository, 'getById'>,
    private readonly policyRepo: Pick<CancellationPolicyRepository, 'findApplicableTier'>,
    private readonly financialTransactionRepo: Pick<FinancialTransactionRepository,
      'getCollectedPaymentTotalForReservation' | 'createWithClient' | 'getByIdempotencyKey' | 'getByReservationId'>,
    private readonly invoiceRepo: Pick<InvoiceRepository, 'getByReservationId' | 'getRefundableForUpdate'>,
    private readonly businessProfileRepo: Pick<BusinessProfileRepository, 'get'>,
    private readonly transactionManager: TransactionManager,
  ) {}

  /**
   * BRECHA-REFUND-01 Fase 3 (05/09/2026, architecture-governor) -- predicado
   * compartido entre el camino rápido (fuera del lock) y el re-chequeo
   * autoritativo (bajo el lock, dentro de `confirmRefund()`). Filtra por
   * PREFIJO de `idempotencyKey`, no por `type === 'REFUND'` a secas: un
   * REFUND manual o de otro origen sobre la misma reserva (sin esta clave)
   * no cuenta como "ya reembolsado por este flujo" y no debe bloquear un
   * reembolso real nuevo.
   */
  private matchesRefundIdempotencyKey(tx: FinancialTransaction, baseIdempotencyKey: string): boolean {
    return tx.type === 'REFUND' && (tx.idempotencyKey?.startsWith(`${baseIdempotencyKey}:`) ?? false);
  }

  async previewRefund(reservationId: string, businessId: string): Promise<CancellationRefundPreview> {
    const reservation = await this.reservationRepo.getById(reservationId);
    if (!reservation) throw new ReservationNotFoundError(reservationId);
    if (reservation.status !== ReservationStatus.CANCELLED) throw new ReservationNotCancelledError(reservationId);

    const collected = await this.financialTransactionRepo.getCollectedPaymentTotalForReservation(reservationId);
    const daysBeforeCheckin = Math.floor((reservation.startTime.getTime() - Date.now()) / MS_PER_DAY);
    const tier = await this.policyRepo.findApplicableTier(businessId, daysBeforeCheckin);
    const refundPercentage = tier?.refundPercentage ?? 0;
    const refundAmount = round2(collected * refundPercentage / 100);

    return { collected, daysBeforeCheckin, refundPercentage, refundAmount };
  }

  /**
   * Recalcula el mismo cálculo que `previewRefund` (no confía en lo que
   * mostró la pantalla -- mismo criterio que `confirmPriceAdjustment`).
   * Reparto LIFO del monto a devolver entre las facturas ISSUED de la
   * reserva (decisión del dueño, ver diseño): la más nueva primero, cada
   * una consumida hasta el 100% de su `impTotal` antes de pasar a la
   * anterior. Si sobra monto sin ninguna factura que cubrir, un chunk
   * final con `reversedInvoiceId = null` (ledger-only).
   *
   * BRECHA-REFUND-01 Fase 3 (05/09/2026, architecture-governor, Q-A/Q-C
   * confirmadas por el dueño: nunca más de lo cobrado, único e
   * irrepetible por reserva) -- el reparto se mueve DENTRO de la
   * transacción, capado contra `getRefundableForUpdate()` (con lock, foto
   * fresca) en vez de `invoice.impTotal` a secas, y cada fila lleva una
   * `idempotencyKey` derivada server-side de la reserva -- nunca la manda
   * el caller, así que un reintento de red (no solo una carrera genuina)
   * queda protegido de verdad, no solo "si el frontend la manda".
   */
  async confirmRefund(
    reservationId: string,
    businessId: string,
    confirmedByUserId: string,
  ): Promise<FinancialTransaction[]> {
    const reservation = await this.reservationRepo.getById(reservationId);
    if (!reservation) throw new ReservationNotFoundError(reservationId);
    if (reservation.status !== ReservationStatus.CANCELLED) throw new ReservationNotCancelledError(reservationId);

    // Único e irrepetible por reserva (Q-C) -- derivada server-side, nunca
    // provista por el caller. Un reintento de red (misma clave) devuelve
    // las filas ya creadas en vez de duplicar.
    const baseIdempotencyKey = `refund:cancellation:${reservationId}`;

    // BRECHA-REFUND-01 Fase 3 -- camino RÁPIDO, fuera de la transacción:
    // cubre el reintento EN SERIE después de que un llamado anterior ya
    // comprometió su REFUND (no una carrera -- la transacción anterior ya
    // hizo commit). Sin esto, `collected` más abajo ya sale neto de ese
    // REFUND -- para un reembolso 100% ya aplicado, da 0 y dispara
    // NothingToRefundError en vez de devolver lo ya creado, rompiendo la
    // idempotencia que el docblock de este método promete.
    //
    // NO alcanza para una carrera genuina: el perdedor puede llegar hasta
    // acá con `existing` vacío (leyó antes de que el ganador hiciera
    // commit) y seguir de largo. Por eso hay un SEGUNDO chequeo, idéntico,
    // BAJO el lock (ver dentro de `transactionManager.run()`) -- ese es el
    // autoritativo. Este de acá es solo para no pagar la vuelta completa
    // (lock + N locks de factura) en el caso común de un reintento después
    // de que todo ya terminó.
    const existing = (await this.financialTransactionRepo.getByReservationId(reservationId))
      .filter((tx) => this.matchesRefundIdempotencyKey(tx, baseIdempotencyKey));
    if (existing.length > 0) return existing;

    const collected = await this.financialTransactionRepo.getCollectedPaymentTotalForReservation(reservationId);
    const daysBeforeCheckin = Math.floor((reservation.startTime.getTime() - Date.now()) / MS_PER_DAY);
    const tier = await this.policyRepo.findApplicableTier(businessId, daysBeforeCheckin);
    const refundPercentage = tier?.refundPercentage ?? 0;
    const refundAmount = round2(collected * refundPercentage / 100);

    if (refundAmount <= 0) throw new NothingToRefundError(reservationId);

    // F-A (05/09/2026, architecture-governor) -- getByReservationId() trae
    // CUALQUIER factura de la reserva, incluidas las Notas de Crédito ya
    // emitidas (una NC se persiste en la MISMA tabla `invoices`, con
    // financial_transaction_id = la tx REFUND que la originó, que también
    // lleva reservationId). Sin este filtro, un segundo confirmRefund()
    // repartiría LIFO empezando por la NC más reciente -- issuedAt de la NC
    // es más nuevo que el de la factura que revierte -- y
    // buildCreditNote() emitiría una NC apuntando a OTRA NC, no a la
    // factura original. Solo Factura B es reversible por este camino.
    const issuedInvoices = (await this.invoiceRepo.getByReservationId(reservationId))
      .filter((inv) => inv.status === 'ISSUED' && inv.cbteTipo === CBTE_TIPO_FACTURA_B)
      // Desempate explícito por id -- documenta el invariante de que el
      // orden LIFO tiene que ser determinístico incluso si dos facturas
      // comparten el mismo issuedAt (no cambia el resultado de ningún test
      // existente, ninguno tiene ese empate).
      .sort((a, b) => (b.issuedAt?.getTime() ?? 0) - (a.issuedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));

    const { currency } = await this.businessProfileRepo.get();

    const created: FinancialTransaction[] = [];
    await this.transactionManager.run(async (client: SqlClient) => {
      // Primera operación de la transacción -- serializa TODAS las
      // llamadas concurrentes sobre la MISMA reserva antes de tocar
      // ninguna factura (mismo criterio que O2F2-B).
      await acquireIdempotencyLock(client, baseIdempotencyKey);

      // Re-chequeo AUTORITATIVO, ya bajo el lock (architecture-governor,
      // 05/09/2026 -- mismo mecanismo que O2F2-A,
      // accounts-receivable.service.ts:321). El camino rápido de arriba
      // corrió ANTES del lock: en una carrera genuina, el perdedor puede
      // haber leído `existing` vacío porque el ganador todavía no había
      // hecho commit. Si acá no se repite el chequeo, el perdedor sigue de
      // largo con SU PROPIO `refundAmount`/`issuedInvoices` (calculados
      // antes de que el ganador tocara nada) y, al capar contra
      // `getRefundableForUpdate()` ya con la factura consumida por el
      // ganador, el remanente completo cae al chunk ":sin-asignar" -- una
      // clave que el ganador nunca creó, así que el INSERT no la frena:
      // crédito fantasma, doble reembolso real. El lock garantiza que si
      // el ganador ya comprometió, este SELECT (sobre el pool, no sobre
      // `client` -- mismo patrón que customer-account.service.ts:240) ya
      // lo ve.
      const lockedExisting = (await this.financialTransactionRepo.getByReservationId(reservationId))
        .filter((tx) => this.matchesRefundIdempotencyKey(tx, baseIdempotencyKey));
      if (lockedExisting.length > 0) {
        created.push(...lockedExisting);
        return;
      }

      // Lockear las N facturas candidatas en orden CANÓNICO (por id) antes
      // de aplicar ninguna lógica de negocio en orden LIFO -- desacopla
      // "en qué orden tomamos los locks" de "en qué orden repartimos la
      // plata", para no depender de que el orden de negocio sea también
      // libre de ABBA contra otros callers (ej. recordPayment(), que
      // lockea en el orden que le manda el caller, no canónico -- cerrar
      // eso del todo es un bloque aparte, registrado, no de acá). Costo
      // real: un lock ya sostenido por esta misma transacción es
      // instantáneo -- no es una segunda espera.
      const canonicalOrder = [...issuedInvoices].sort((a, b) => a.id.localeCompare(b.id));
      for (const invoice of canonicalOrder) {
        await this.invoiceRepo.getRefundableForUpdate(client, invoice.id);
      }

      const chunks: Array<{ amount: number; reversedInvoiceId: string | null; idempotencyKey: string }> = [];
      let remaining = refundAmount;
      for (const invoice of issuedInvoices) {
        if (remaining <= 0) break;
        // Ya lockeada arriba -- esta llamada relee la foto fresca (§7.1),
        // no vuelve a esperar ningún lock.
        const { appliedAmount, unallocatedAmount } = await applyCappedRefundToInvoice(
          this.invoiceRepo, client, invoice.id, remaining,
        );
        if (appliedAmount > 0) {
          chunks.push({ amount: appliedAmount, reversedInvoiceId: invoice.id, idempotencyKey: `${baseIdempotencyKey}:${invoice.id}` });
        }
        remaining = unallocatedAmount;
      }
      if (remaining > 0) {
        chunks.push({ amount: remaining, reversedInvoiceId: null, idempotencyKey: `${baseIdempotencyKey}:sin-asignar` });
      }

      for (const chunk of chunks) {
        const tx = await createIdempotentPaymentWithClient(this.financialTransactionRepo, client, {
          id: randomUUID(),
          businessId,
          customerId: reservation.customer.id,
          reservationId,
          type: 'REFUND',
          amount: chunk.amount,
          currency,
          status: 'SETTLED',
          reversedInvoiceId: chunk.reversedInvoiceId,
          confirmedBy: confirmedByUserId,
          idempotencyKey: chunk.idempotencyKey,
        });
        if (tx) created.push(tx);
      }
    });

    return created;
  }
}
