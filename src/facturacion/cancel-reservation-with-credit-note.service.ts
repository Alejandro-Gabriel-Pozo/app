/**
 * @file cancel-reservation-with-credit-note.service.ts
 * @description Orquestador del escape administrativo "cancelar una RESERVA
 * con factura fiscal viva, emitiendo una Nota de Crédito" — bloque 3.3-b1 de
 * B-reservas del ADR común
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.6.
 *
 * ## Alcance de 3.3-b1 (gate `architecture-governor`, 09/09/2026) — orquestador + puerto
 * Este archivo + `src/reservas/reservation-cancel-for-credit-note.ts` son
 * "orquestador + puerto" completos (interfaz Y adaptador concreto).
 *
 * ## 3.3-b2 (gate `architecture-governor`, 09/09/2026) — ALCANZABLE DESDE HTTP
 * `POST /api/reservations/:id/cancel-with-credit-note`
 * (`reservas/reservations.routes.ts`), detrás de
 * `authorize(Roles.EMISOR_NOTA_CREDITO)`. Los 6 errores tipados del escape
 * de reservas están mapeados en `error.middleware.ts` como red de
 * seguridad, y en `ESCAPE_ROUTES`/`NUCLEO_IMPORT_ALLOWLIST`/
 * `ESCAPE_CHOKEPOINTS` de `credit-note-escape-containment.test.ts`. **La
 * afirmación "inalcanzable desde HTTP por construcción" de b1 ya NO
 * aplica** -- corregida acá para que no quede stale (regla 4 de
 * `CLAUDE.md` raíz, "Pendientes — revalidar antes de arrastrar").
 *
 * ## Diferencias estructurales con el precedente de órdenes (`cancel-order-with-credit-note.service.ts`)
 * "Corrección de encuadre" del §6.6: `invoices.financial_transaction_id` es
 * 1:1 — una factura DIRECTA liga EXACTAMENTE un cargo, misma cardinalidad
 * que una orden. El orquestador de reservas por eso NO bifurca por subcaso
 * directa/consolidada: siempre resuelve, bajo lock, el conjunto de cargos de
 * la reserva y exige EXACTAMENTE una factura `ISSUED` entre ellos. La
 * bifurcación total/parcial la absorbe entera `buildCreditNote()` (bloque
 * 3.3-a, ya deployado) según si el monto revertido cierra o no con el
 * `impTotal` de la factura.
 *
 *  1. **`ADJUSTMENT.reservationId` va SETTEADO** (no `null` como en
 *     órdenes) — es lo que hace que `buildCreditNote()` tome la rama de
 *     atribución por par (3.3-a) cuando la reversión es parcial.
 *  2. **El conjunto que se settlea en tx2 es el CONGELADO en tx1**
 *     (`prep.frozenChargeIds` = intersección factura∩reserva), NUNCA
 *     re-derivado con `getChargeIdsForInvoice()` dentro de tx2 — a
 *     diferencia de órdenes (donde factura=1 cargo siempre, así que
 *     re-derivar es inocuo), acá una factura consolidada liga cargos de
 *     OTRAS reservas: re-derivar en tx2 settlearía el cargo ajeno. Condición
 *     C1 del gate — es el riesgo de copy-paste #1 de este bloque.
 *  3. **El puerto re-lockea la reserva DENTRO de tx2** (`getByIdWithLock`),
 *     porque `ReservationRepository.saveWithClient()` pisa el agregado
 *     entero (a diferencia de `transitionWithClient` de órdenes, un UPDATE
 *     condicional) — el lock de tx1 ya se soltó en su commit.
 *  4. **`stay_id` y el borde de la consolidada al 100%** no tienen
 *     equivalente en órdenes (una orden nunca tiene `stay_id`). Ver los
 *     bloques dedicados abajo.
 *
 * ## Secuencia — dos transacciones con AFIP en el medio (mismo patrón N1.a)
 *   tx1: lock de la reserva → resolver EXACTAMENTE una factura `ISSUED` →
 *        congelar el conjunto de cargos (factura∩reserva) y su `stay_id` →
 *        guard del borde-100% → INSERT del `ADJUSTMENT` `PENDING`.
 *   AFIP: `InvoiceService.requestInvoice()`, sin transacción, sin lock.
 *   tx2 (SOLO si la NC llegó a `ISSUED`): re-lock + RE-VERIFICACIÓN de que
 *        el conjunto de facturas vivas de la reserva sigue siendo
 *        exactamente el revertido (ventana tx1→tx2, hallazgo nuevo del
 *        gate de diseño) → cancelar la reserva (puerto) → settlear
 *        `ADJUSTMENT` + el conjunto CONGELADO de cargos.
 *
 * ## Orden canónico de locks (ADR §7, condición C-b del gate de implementación 09/09/2026)
 * Ninguna transacción de este orquestador sostiene lock de `reservations` Y
 * de `invoices` a la vez. tx1 lockea SOLO `reservations` (`getByIdWithLock`)
 * — la lectura/lock de `invoices` que hace `buildCreditNote()` (tope N5 +
 * tope por par, bloque 2.4/3.3-a) corre DESPUÉS, en su propia transacción,
 * disparada por `requestInvoice()` fuera de tx1. tx2 vuelve a lockear SOLO
 * `reservations` (el re-lock propio + el del puerto, re-entrante en la
 * misma tx/conexión) — no toca `invoices` en absoluto, sólo
 * `financial_transactions` vía `settleByIdsWithClient`. Orden: reserva
 * primero si las dos hicieran falta en la misma tx (nunca ocurre hoy). Por
 * eso este archivo NO entra en `lock-order.test.ts`
 * (`LOCK_CALL_RE` vigila `applyCapped*`/`getOutstandingForUpdate(client`/
 * `getRefundableForUpdate(client`/`getInFlightCreditNoteTotalForUpdate(client`/
 * `getInFlightCreditNoteTotalForPairForUpdate(client` — ninguno de los
 * cuales llama este orquestador directo, los llama `invoice.service.ts`
 * dentro de `requestInvoice()`) — no es un descuido, es que acá no hay
 * ABBA posible por construcción.
 */

import { randomUUID } from 'node:crypto';
import { round2 } from '../domain/money.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceRepository } from './invoice.repository.js';
import type { Invoice } from './invoice.entities.js';
import type { InvoiceService } from './invoice.service.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import { ReservationStatus } from '../types/enums.js';
import { CREDIT_NOTE_COMPENSATION_TOLERANCE } from './cancel-with-credit-note.js';
import type { CreditNoteCancellationAuthorization } from './cancel-with-credit-note.js';
import {
  AfipRequestRejectedError,
  AfipRequestUncertainError,
  CreditNoteCancellationPendingError,
  CreditNoteCancellationRejectedError,
  CreditNoteReservationNoLiveInvoiceError,
  CreditNoteReservationMultiInvoiceError,
  CreditNoteMixedStayError,
  CreditNoteConsolidatedFullReversalError,
  CreditNoteReservationInvoiceSetChangedError,
  CreditNoteIssuedReservationNotCancellableError,
  InvalidReservationError,
  ReservationNotFoundError,
} from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Puerto: cancelar la RESERVA dentro de la tx del orquestador
// ---------------------------------------------------------------------------

/**
 * Los cuatro desenlaces posibles de intentar cancelar la reserva dentro de
 * tx2. Espejo de `OrderTransitionOutcome` (`pos-menu/order.repository.ts`),
 * pero sin `ESTADO_DESCONOCIDO`: `ReservationStatus` es un enum de TS
 * respaldado por el `CHECK` de schema, `getByIdWithLock` no puede devolver
 * un status fuera de él.
 *
 * - `CAMBIO`: la transición ocurrió. Única señal para auditar/emitir evento.
 * - `YA_ESTABA`: ya estaba `CANCELLED` — idempotente, sin re-auditar/re-emitir.
 * - `NO_ELEGIBLE`: `COMPLETED`/`EXPIRED` — terminal, no admite `CANCELLED`.
 * - `NO_EXISTE`: no hay reserva con ese id.
 */
export type ReservationCancelOutcome =
  | { resultado: 'CAMBIO'; reservation: Reservation; previousStatus: ReservationStatus }
  | { resultado: 'YA_ESTABA'; reservation: Reservation }
  | { resultado: 'NO_ELEGIBLE'; reservation: Reservation }
  | { resultado: 'NO_EXISTE' };

/**
 * Lo que el orquestador necesita hacerle a la reserva en tx2, SIN importar
 * `ReservationService`/`Reservation.cancel()` desde `facturacion/` (cruzaría
 * la cerca de la capa iv). La impl vive en
 * `src/reservas/reservation-cancel-for-credit-note.ts`.
 *
 * `cancelForCreditNote()` hace, dentro de `client` (la tx2 del orquestador):
 * re-lockea la reserva (`getByIdWithLock` — el lock de tx1 ya se soltó),
 * la transición `PENDING|CONFIRMED → CANCELLED` vía `Reservation.cancel()` +
 * `saveWithClient()` (que pisa el agregado entero, a diferencia del UPDATE
 * condicional de órdenes), la fila de `audit_log` (divergencia deliberada
 * A6.5: `ReservationService.cancelReservation()` HOY no audita — el escape
 * es un override administrativo con autor nombrado, sí lo hace), y el evento
 * `reservation.cancelled` con el mismo payload que la cancelación normal.
 *
 * Idempotente por CHEQUEO DE ESTADO (si ya `CANCELLED`, `YA_ESTABA` sin
 * re-auditar/re-emitir) — nunca cazando la excepción de `Reservation.cancel()`,
 * que lanza `InvalidReservationError` genérico e indistinguible de un estado
 * realmente no elegible.
 */
export interface ReservationCancelPort {
  cancelForCreditNote(
    client: SqlClient,
    reservationId: string,
    businessId: string,
    changedBy: string,
  ): Promise<ReservationCancelOutcome>;
}

// ---------------------------------------------------------------------------
// Formas mínimas de cada dependencia (puertos, nunca impls concretas)
// ---------------------------------------------------------------------------

type FinancialTransactionRepoForCancel = Pick<
  FinancialTransactionRepository,
  'getByReservationId' | 'getByIdempotencyKey' | 'createWithClient'
> & {
  settleByIdsWithClient: NonNullable<FinancialTransactionRepository['settleByIdsWithClient']>;
};

type InvoiceRepoForCancel = Pick<InvoiceRepository, 'resolveInvoiceLinkage' | 'getChargeIdsForInvoice' | 'getById'>;
type InvoiceServiceForCancel = Pick<InvoiceService, 'requestInvoice'>;

/**
 * `getByIdWithLock` es OPCIONAL en `ReservationRepository` (los fakes en
 * memoria que no lo necesitan no lo implementan). Acá se lo exige presente
 * — mismo criterio que `settleByIdsWithClient` arriba y que el precedente de
 * órdenes (`getByIdForUpdate`, no-opcional en `IOrderRepository`). Un fake
 * de test sin este método no compila contra el orquestador: no puede
 * degradar en silencio a una lectura sin lock (condición C6 del gate).
 */
type ReservationRepoForCancel = {
  getByIdWithLock: NonNullable<ReservationRepository['getByIdWithLock']>;
};

export interface CancelReservationWithCreditNoteResult {
  reservation: Reservation;
  creditNote: Invoice;
  adjustmentId: string;
  originalInvoiceId: string;
  /** `true` si esta llamada emitió la NC ahora; `false` si la resolvió un fast-path idempotente. */
  emitted: boolean;
}

/** Estado congelado en tx1, atravesado por AFIP hasta tx2 sin volver a derivarse. */
interface FrozenPrep {
  adjustmentId: string;
  originalInvoiceId: string;
  businessId: string;
  /** Intersección factura∩reserva — el ÚNICO conjunto que tx2 puede settlear (C1). */
  frozenChargeIds: string[];
}

// ---------------------------------------------------------------------------
// Orquestador
// ---------------------------------------------------------------------------

export class CancelReservationWithCreditNoteService {
  constructor(
    private readonly invoiceService: InvoiceServiceForCancel,
    private readonly financialTransactionRepo: FinancialTransactionRepoForCancel,
    private readonly invoiceRepo: InvoiceRepoForCancel,
    private readonly reservationRepo: ReservationRepoForCancel,
    private readonly reservationCancelPort: ReservationCancelPort,
    private readonly transactionManager: TransactionManager,
  ) {}

  private idempotencyKey(reservationId: string, invoiceId: string): string {
    // CON el invoiceId, no solo la reserva (§6.6): sin él, el bloque 3.5
    // (pool mixto, N NC para una reserva) colisionaría contra
    // `assertRevertsExpectedInvoice`.
    return `cancel-reservation-with-cn:${reservationId}:${invoiceId}`;
  }

  /**
   * Recorre los `CHARGE` de la reserva y agrupa los que tienen una factura
   * `ISSUED` viva, por invoiceId. Se usa DOS veces con requisitos distintos:
   * sin lock en el fast-path (resolución best-effort, un miss cae al camino
   * lento — falla al lado seguro) y BAJO LOCK en tx1 (autoritativa) y tx2
   * (re-verificación de la ventana).
   */
  private async liveInvoiceIdsForReservation(reservationId: string): Promise<{
    charges: FinancialTransaction[];
    issuedInvoiceIds: Set<string>;
  }> {
    const charges = (await this.financialTransactionRepo.getByReservationId(reservationId)).filter(
      (t) => t.type === 'CHARGE',
    );
    const issuedInvoiceIds = new Set<string>();
    for (const charge of charges) {
      const linkage = await this.invoiceRepo.resolveInvoiceLinkage(charge.id);
      if (linkage.kind === 'ISSUED') issuedInvoiceIds.add(linkage.invoiceId);
    }
    return { charges, issuedInvoiceIds };
  }

  /**
   * Único punto de entrada. `auth` es el token branded (capa iii de la
   * contención) — sin él, o con `auth.scope.kind !== 'RESERVATION'`, esto no
   * compila / aborta.
   */
  async cancelReservationWithCreditNote(
    reservationId: string,
    auth: CreditNoteCancellationAuthorization,
  ): Promise<CancelReservationWithCreditNoteResult> {
    if (auth.scope.kind !== 'RESERVATION' || auth.scope.reservationId !== reservationId) {
      throw new Error(
        `cancelReservationWithCreditNote: el token de autorización no corresponde a la reserva "${reservationId}" (scope: ${JSON.stringify(auth.scope)}).`,
      );
    }

    // --- FAST-PATH idempotencia (sin tx, sin lock) --------------------------
    // Resuelve la factura candidata SIN lock (§6.6: "resolver la factura
    // antes del fast-path"). Si hay 0 o >1 candidatas acá, no se arma key —
    // cae directo al camino lento, que hace la resolución AUTORITATIVA bajo
    // lock y tira el error tipado correcto.
    const { issuedInvoiceIds: candidateIds } = await this.liveInvoiceIdsForReservation(reservationId);
    let prior: FinancialTransaction | undefined;
    if (candidateIds.size === 1) {
      const candidateInvoiceId = [...candidateIds][0]!;
      prior = await this.financialTransactionRepo.getByIdempotencyKey(
        this.idempotencyKey(reservationId, candidateInvoiceId),
      );
      if (prior?.reversedInvoiceId) {
        const priorReservation = await this.readReservationOrThrow(reservationId);
        if (priorReservation.status === ReservationStatus.CANCELLED) {
          try {
            const creditNote = await this.invoiceService.requestInvoice({
              businessId: prior.businessId,
              financialTransactionId: prior.id,
              changedBy: auth.confirmedBy,
            });
            if (creditNote.status === 'ISSUED') {
              return {
                reservation: priorReservation,
                creditNote,
                adjustmentId: prior.id,
                originalInvoiceId: prior.reversedInvoiceId,
                emitted: false,
              };
            }
          } catch {
            // cae al camino normal
          }
        }
      }
    }

    // --- tx1: lock + resolver factura viva + congelar conjunto + ADJUSTMENT PENDING ---
    const prep = await this.transactionManager.run(async (client): Promise<FrozenPrep> => {
      const reservation = await this.reservationRepo.getByIdWithLock(client, reservationId); // lock RESERVA-10
      if (!reservation) throw new ReservationNotFoundError(reservationId);

      // Resolución AUTORITATIVA bajo lock — ignora lo que haya resuelto el
      // fast-path sin lock; solo se reusa `prior` más abajo si coincide.
      const { charges, issuedInvoiceIds } = await this.liveInvoiceIdsForReservation(reservationId);
      if (issuedInvoiceIds.size === 0) {
        throw new CreditNoteReservationNoLiveInvoiceError(reservationId);
      }
      if (issuedInvoiceIds.size > 1) {
        // Pool mixto sin pedirlo explícito -- fail-closed SIN llamar a AFIP
        // y SIN crear ADJUSTMENT (§6.6, grounding ERPNext/Odoo/QloApps
        // 09/09/2026: las 3 referencias exigen elección explícita del
        // operador, nunca una heurística implícita). Bloque 3.5, gate propio.
        throw new CreditNoteReservationMultiInvoiceError(reservationId, [...issuedInvoiceIds]);
      }
      const originalInvoiceId = [...issuedInvoiceIds][0]!;
      const key = this.idempotencyKey(reservationId, originalInvoiceId);

      if (reservation.status === ReservationStatus.CANCELLED) {
        // Solo puede venir de un escape previo (RESERVA-10 bloquea la
        // cancelación normal con factura viva). Si el fast-path no la
        // resolvió, la NC no llegó a ISSUED -- reanudable con la misma key.
        //
        // DEUDA DECLARADA (gate 09/09/2026, condición "reusar
        // CreditNoteCancellationPendingError/…RejectedError", `domain/errors.ts`
        // append-only en b1): el texto de estas dos clases dice "la orden
        // ...", literal, porque nacieron para el escape de órdenes. Reusarlas
        // acá para reservas dejamos el `.message` con la palabra equivocada
        // (el `.code` y el `financialTransactionId` sí son correctos). No se
        // corrige en b1 -- corregir el texto exige tocar clases existentes,
        // fuera del "solo append" autorizado. Candidato: generalizar el texto
        // (o parametrizarlo por tipo de documento) en un bloque aparte.
        const adj = await this.financialTransactionRepo.getByIdempotencyKey(key);
        if (adj) throw new CreditNoteCancellationPendingError(reservationId, adj.id);
        throw new InvalidReservationError(
          `cancelReservationWithCreditNote: la reserva "${reservationId}" está CANCELLED sin un ADJUSTMENT del escape (key "${key}") -- invariante rota.`,
        );
      }
      if (reservation.status !== ReservationStatus.PENDING && reservation.status !== ReservationStatus.CONFIRMED) {
        throw new InvalidReservationError(
          `Transición inválida: ${reservation.status} → ${ReservationStatus.CANCELLED}.`,
        );
      }

      const original = await this.invoiceRepo.getById(originalInvoiceId);
      if (!original) {
        throw new Error(
          `cancelReservationWithCreditNote: resolveInvoiceLinkage() devolvió ISSUED para "${originalInvoiceId}" pero getById() no la encontró -- invariante rota.`,
        );
      }

      // N2.a -- el conjunto que la factura facturó (N1.a iii), derivado de
      // la FACTURA, intersectado con los cargos de ESTA reserva. Para una
      // factura directa el resultado es {charge.id} (mismo caso que
      // órdenes); para una consolidada, solo la porción de esta reserva.
      const invoiceChargeIds = await this.invoiceRepo.getChargeIdsForInvoice(originalInvoiceId);
      const reservationChargeIds = new Set(charges.map((c) => c.id));
      const frozenChargeIds = invoiceChargeIds.filter((id) => reservationChargeIds.has(id));
      if (frozenChargeIds.length === 0) {
        // No puede pasar por construcción: `originalInvoiceId` se resolvió
        // desde un cargo de ESTA reserva. Defensivo (gate, condición 5).
        throw new Error(
          `cancelReservationWithCreditNote: la intersección factura∩reserva para "${reservationId}"/"${originalInvoiceId}" quedó vacía -- invariante rota.`,
        );
      }
      const frozenCharges = charges.filter((c) => frozenChargeIds.includes(c.id));
      const absAmount = round2(frozenCharges.reduce((sum, c) => sum + c.amount, 0));

      // Borde de la consolidada al 100% (§6.6, condición C2 del gate): si el
      // conjunto congelado es un subconjunto PROPIO de los cargos de la
      // factura (hay cargos de OTRA reserva en la misma consolidada) pero
      // igual suma el 100% del impTotal, `buildCreditNote()` tomaría la
      // rama N3 (total) y copiaría TODAS las líneas -- incluida la ajena --
      // sin correr el tope por par. El predicado es el complemento EXACTO
      // de `isFullReversal` en `invoice.service.ts` (misma tolerancia), no
      // un `<` a secas: un monto `impTotal - 0.005` pasaría un `<` pero
      // igual caería en la rama total.
      const isProperSubset = frozenChargeIds.length < invoiceChargeIds.length;
      if (isProperSubset && absAmount >= round2(original.impTotal - CREDIT_NOTE_COMPENSATION_TOLERANCE)) {
        throw new CreditNoteConsolidatedFullReversalError(reservationId, originalInvoiceId, absAmount, original.impTotal);
      }

      // `stay_id` (§6.6, decisión de 3.3-b1, gate 09/09/2026): heredar si
      // TODOS los cargos congelados comparten uno -- `null` es un valor
      // DISTINTO, no un comodín. Si difieren (incluida la mezcla
      // null+'S1'), fallar cerrado: `getNetBalanceByStayId()` sumaría por
      // `stay_id` un ADJUSTMENT que también revierte cargos fuera de esa
      // estadía, sub-declarando su saldo.
      const distinctStayIds = new Set(frozenCharges.map((c) => c.stayId ?? null));
      if (distinctStayIds.size > 1) {
        throw new CreditNoteMixedStayError(reservationId, originalInvoiceId, [...distinctStayIds]);
      }
      const stayId = [...distinctStayIds][0] ?? null;

      const assertRevertsExpectedInvoice = (adj: FinancialTransaction): void => {
        // Extiende el assert del precedente de órdenes con dos comparaciones
        // propias de reservas (condición C4 del gate): un ADJUSTMENT
        // adoptado por la clave tiene que revertir la MISMA factura, la
        // MISMA reserva y el MISMO stayId que se acaban de resolver -- si
        // no, la clave colisionó con otro documento (imposible bajo R12 +
        // la resolución determinística de arriba) y hay que verlo, no
        // propagar un dato inconsistente.
        if (
          adj.reversedInvoiceId !== originalInvoiceId ||
          adj.reservationId !== reservationId ||
          (adj.stayId ?? null) !== stayId
        ) {
          throw new Error(
            `cancelReservationWithCreditNote: el ADJUSTMENT idempotente de la reserva "${reservationId}" ` +
              `(key "${key}", id "${adj.id}") revierte factura="${adj.reversedInvoiceId}" reservationId="${adj.reservationId}" ` +
              `stayId="${adj.stayId ?? null}", pero se esperaba factura="${originalInvoiceId}" reservationId="${reservationId}" stayId="${stayId}".`,
          );
        }
      };

      // Reusa `prior` del fast-path SOLO si coincide con la factura
      // AUTORITATIVA recién resuelta -- si difieren (carrera entre la
      // lectura sin lock y esta), `prior` está resuelto contra una key
      // vieja y usarlo sería exactamente el bug que la nota de §6.6 pide
      // evitar. Falla al lado seguro: una query de más, nunca un dato stale.
      const existing =
        prior && prior.reversedInvoiceId === originalInvoiceId
          ? prior
          : await this.financialTransactionRepo.getByIdempotencyKey(key);

      let adjustment: FinancialTransaction;
      if (existing) {
        assertRevertsExpectedInvoice(existing);
        adjustment = existing;
      } else {
        const created = await this.financialTransactionRepo.createWithClient(client, {
          id: randomUUID(),
          businessId: original.businessId,
          customerId: frozenCharges[0]!.customerId,
          orderId: null,
          reservationId,
          stayId,
          type: 'ADJUSTMENT',
          // Signo negativo -- mismo CHECK/consumidores que el precedente de
          // órdenes (`chk_financial_transactions_amount`, N1.b en
          // `getOutstandingForUpdate`/`getRefundableForUpdate`/
          // `getOutstandingByCustomerId`, `getNetBalanceBy*`).
          amount: round2(-absAmount),
          currency: frozenCharges[0]!.currency,
          status: 'PENDING',
          idempotencyKey: key,
          notes: auth.reason,
          confirmedBy: auth.confirmedBy,
          reversedInvoiceId: originalInvoiceId,
        });
        if (created) {
          adjustment = created;
        } else {
          // ON CONFLICT DO NOTHING -- otra tx ganó la carrera. Bajo el
          // índice único de `idempotency_key`, para cuando llegamos acá esa
          // fila está COMMITEADA y visible (mismo razonamiento que el
          // precedente de órdenes).
          const reread = await this.financialTransactionRepo.getByIdempotencyKey(key);
          if (!reread) {
            throw new Error(
              `cancelReservationWithCreditNote: createWithClient devolvió null (ON CONFLICT) para la key ` +
                `"${key}" pero getByIdempotencyKey no encontró el ADJUSTMENT -- invariante rota.`,
            );
          }
          assertRevertsExpectedInvoice(reread);
          adjustment = reread;
        }
      }

      return {
        adjustmentId: adjustment.id,
        originalInvoiceId,
        businessId: original.businessId,
        frozenChargeIds,
      };
    });

    // --- AFIP: emitir la NC (fuera de toda tx, sin lock) ------------------
    let creditNote: Invoice;
    try {
      creditNote = await this.invoiceService.requestInvoice({
        businessId: prep.businessId,
        financialTransactionId: prep.adjustmentId,
        changedBy: auth.confirmedBy,
      });
    } catch (err) {
      if (err instanceof AfipRequestUncertainError) {
        throw new CreditNoteCancellationPendingError(reservationId, prep.adjustmentId);
      }
      if (err instanceof AfipRequestRejectedError) {
        throw new CreditNoteCancellationRejectedError(reservationId, prep.adjustmentId, err.message);
      }
      throw err;
    }
    if (creditNote.status !== 'ISSUED') {
      throw new CreditNoteCancellationPendingError(reservationId, prep.adjustmentId);
    }

    // --- tx2: re-lock + re-verificación de ventana + settlement -----------
    const finalReservation = await this.transactionManager.run(async (client) => {
      // C3 del gate: lock propio primero, re-verificación, RECIÉN AHÍ el
      // puerto (que vuelve a lockear la misma fila -- re-entrante en la
      // misma tx/conexión, costo cero bajo Postgres).
      const locked = await this.reservationRepo.getByIdWithLock(client, reservationId);
      if (!locked) throw new ReservationNotFoundError(reservationId);

      // Ventana tx1→tx2 (hallazgo nuevo del gate de diseño, §6.6): entre el
      // commit de tx1 y este punto, `requestInvoice()` pudo haber emitido
      // una factura NUEVA para otro cargo de la misma reserva. Re-verificar
      // que el conjunto de facturas vivas sigue siendo EXACTAMENTE el
      // revertido -- si no, abortar dejando el estado visible (NC ISSUED,
      // ADJUSTMENT PENDING, mismo N11 que el resto de este ADR).
      const { issuedInvoiceIds: stillIssued } = await this.liveInvoiceIdsForReservation(reservationId);
      if (stillIssued.size !== 1 || !stillIssued.has(prep.originalInvoiceId)) {
        throw new CreditNoteReservationInvoiceSetChangedError(reservationId, prep.originalInvoiceId);
      }

      const outcome = await this.reservationCancelPort.cancelForCreditNote(
        client, reservationId, prep.businessId, auth.confirmedBy,
      );
      if (outcome.resultado === 'CAMBIO' || outcome.resultado === 'YA_ESTABA') {
        await this.financialTransactionRepo.settleByIdsWithClient(client, [prep.adjustmentId], prep.businessId);
        // C1 del gate: settlea el conjunto CONGELADO en tx1, NUNCA
        // re-derivado acá -- una re-derivación con `getChargeIdsForInvoice`
        // settlearía también el cargo de OTRA reserva en una consolidada.
        await this.financialTransactionRepo.settleByIdsWithClient(client, prep.frozenChargeIds, prep.businessId);
        return outcome.reservation;
      }
      if (outcome.resultado === 'NO_EXISTE') throw new ReservationNotFoundError(reservationId);
      // NO_ELEGIBLE -- la NC ya está emitida (irreversible), pero la
      // reserva cambió a un estado terminal (COMPLETED/EXPIRED) entre tx1 y
      // tx2. Se aborta tx2, el caso queda visible (N11). Clase DEDICADA
      // (condición C1 del gate de 3.3-b2, 09/09/2026) -- no
      // `InvalidReservationError`: ese código mapea a 400 en
      // `error.middleware.ts` ("request mal armado"), la peor señal posible
      // para "plata movida sin el documento completo, no reintentes".
      throw new CreditNoteIssuedReservationNotCancellableError(reservationId, creditNote.id, outcome.reservation.status);
    });

    return {
      reservation: finalReservation,
      creditNote,
      adjustmentId: prep.adjustmentId,
      originalInvoiceId: prep.originalInvoiceId,
      emitted: true,
    };
  }

  private async readReservationOrThrow(reservationId: string): Promise<Reservation> {
    const reservation = await this.transactionManager.run((client) =>
      this.reservationRepo.getByIdWithLock(client, reservationId),
    );
    if (!reservation) throw new ReservationNotFoundError(reservationId);
    return reservation;
  }
}
