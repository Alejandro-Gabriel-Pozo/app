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
      'getCollectedPaymentTotalForReservation' | 'createWithClient'>,
    private readonly invoiceRepo: Pick<InvoiceRepository, 'getByReservationId'>,
    private readonly businessProfileRepo: Pick<BusinessProfileRepository, 'get'>,
    private readonly transactionManager: TransactionManager,
  ) {}

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
   */
  async confirmRefund(
    reservationId: string,
    businessId: string,
    confirmedByUserId: string,
  ): Promise<FinancialTransaction[]> {
    const reservation = await this.reservationRepo.getById(reservationId);
    if (!reservation) throw new ReservationNotFoundError(reservationId);
    if (reservation.status !== ReservationStatus.CANCELLED) throw new ReservationNotCancelledError(reservationId);

    const collected = await this.financialTransactionRepo.getCollectedPaymentTotalForReservation(reservationId);
    const daysBeforeCheckin = Math.floor((reservation.startTime.getTime() - Date.now()) / MS_PER_DAY);
    const tier = await this.policyRepo.findApplicableTier(businessId, daysBeforeCheckin);
    const refundPercentage = tier?.refundPercentage ?? 0;
    const refundAmount = round2(collected * refundPercentage / 100);

    if (refundAmount <= 0) throw new NothingToRefundError(reservationId);

    const issuedInvoices = (await this.invoiceRepo.getByReservationId(reservationId))
      .filter((inv) => inv.status === 'ISSUED')
      .sort((a, b) => (b.issuedAt?.getTime() ?? 0) - (a.issuedAt?.getTime() ?? 0));

    const chunks: Array<{ amount: number; reversedInvoiceId: string | null }> = [];
    let remaining = refundAmount;
    for (const invoice of issuedInvoices) {
      if (remaining <= 0) break;
      const chunkAmount = round2(Math.min(remaining, invoice.impTotal));
      chunks.push({ amount: chunkAmount, reversedInvoiceId: invoice.id });
      remaining = round2(remaining - chunkAmount);
    }
    if (remaining > 0) {
      chunks.push({ amount: remaining, reversedInvoiceId: null });
    }

    const { currency } = await this.businessProfileRepo.get();

    const created: FinancialTransaction[] = [];
    await this.transactionManager.run(async (client: SqlClient) => {
      for (const chunk of chunks) {
        const tx = await this.financialTransactionRepo.createWithClient(client, {
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
        });
        if (tx) created.push(tx);
      }
    });

    return created;
  }
}
