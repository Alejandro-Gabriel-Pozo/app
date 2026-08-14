/**
 * @file outbox.handlers.ts
 * @description Handlers concretos del OutboxWorker.
 *
 * ## Idempotencia
 * Cada handler es idempotente. El worker tiene garantía at-least-once:
 * un evento puede procesarse más de una vez si el proceso muere después
 * del handler pero antes de `markDispatched`.
 *
 * - `handleReservationConfirmed`: pasa `idempotencyKey = "${event.id}:CHARGE"`
 *   al repo. ON CONFLICT DO NOTHING en SQL garantiza que el CHARGE se crea
 *   una sola vez aunque el handler se ejecute N veces.
 * - `handleReservationCompleted` y `handleReservationCancelled`: idempotentes
 *   por construcción (filtran por status).
 *
 * ## Handlers registrados
 * - `reservation.confirmed`  → crea CHARGE PENDING en financial_transactions
 * - `reservation.completed`  → pasa CHARGE a SETTLED
 * - `reservation.cancelled`  → pasa CHARGE a VOIDED (si existía)
 * - `order.confirmed`        → crea CHARGE PENDING (mismo mecanismo, por order_id)
 * - `order.completed`        → pasa CHARGE a SETTLED
 * - `order.cancelled`        → pasa CHARGE a VOIDED (si existía)
 */

import { randomUUID } from 'crypto';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { FinancialTransactionRepository, PaymentInfo, PaymentMethod } from '../repositories/financial-transaction.repository.js';
import type { OutboxWorker } from './outbox.worker.js';

/**
 * Registra todos los handlers financieros en el worker.
 * Llamar una sola vez al iniciar el servidor.
 *
 * @example
 * ```ts
 * registerFinancialHandlers(worker, financialTransactionRepository);
 * worker.start();
 * ```
 */
export function registerFinancialHandlers(
  worker: OutboxWorker,
  financialRepo: FinancialTransactionRepository,
): void {
  worker
    .on('reservation.confirmed', handleReservationConfirmed(financialRepo))
    .on('reservation.completed', handleReservationCompleted(financialRepo))
    .on('reservation.cancelled', handleReservationCancelled(financialRepo))
    .on('order.confirmed',       handleOrderConfirmed(financialRepo))
    .on('order.completed',       handleOrderCompleted(financialRepo))
    .on('order.cancelled',       handleOrderCancelled(financialRepo));
}

// ---------------------------------------------------------------------------
// Handlers individuales (exportados para testear en aislamiento)
// ---------------------------------------------------------------------------

export function handleReservationConfirmed(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId, customerId, totalPrice } = event.payload as {
      reservationId: string;
      customerId: string;
      totalPrice: number | undefined;
    };

    // Sin precio (recursos sin costo) → no hay movimiento financiero.
    if (totalPrice == null || totalPrice <= 0) return;

    // idempotencyKey: garantiza que este evento solo crea un CHARGE,
    // aunque el handler se reintente múltiples veces.
    // Convención: "${eventId}:CHARGE" — único por evento de dominio + tipo.
    await financialRepo.create({
      id:             randomUUID(),
      businessId:     event.businessId,
      customerId,
      reservationId,
      type:           'CHARGE',
      amount:         totalPrice,
      currency:       'ARS',
      status:         'PENDING',
      idempotencyKey: `${event.id}:CHARGE`,
    });
  };
}

export function handleReservationCompleted(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId } = event.payload as { reservationId: string };
    await financialRepo.settleByReservationId(reservationId);
  };
}

export function handleReservationCancelled(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId } = event.payload as { reservationId: string };
    await financialRepo.voidByReservationId(reservationId);
  };
}

// ---------------------------------------------------------------------------
// Handlers de Order — cierra el gap de "Order nunca toca el ledger"
// (auditoría de deuda estructural, item #3). Mismo mecanismo que Reservation:
// CHARGE PENDING al confirmar, SETTLED al completar, VOIDED al cancelar.
// ---------------------------------------------------------------------------

export function handleOrderConfirmed(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { orderId, customerId, totalAmount, stayId } = event.payload as {
      orderId: string;
      customerId: string;
      totalAmount: number | undefined;
      stayId?: string | null;
    };

    // Orden sin ítems con precio (ej. solo notas) → no hay movimiento financiero.
    if (totalAmount == null || totalAmount <= 0) return;

    await financialRepo.create({
      id:             randomUUID(),
      businessId:     event.businessId,
      customerId,
      orderId,
      // "Cargo a la habitación" (A1, paso 4) — si la orden se asoció a una
      // Stay, el CHARGE hereda stayId para que getNetBalanceByStayId lo cuente.
      stayId:         stayId ?? null,
      type:           'CHARGE',
      amount:         totalAmount,
      currency:       'ARS',
      status:         'PENDING',
      idempotencyKey: `${event.id}:CHARGE`,
    });
  };
}

export function handleOrderCompleted(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { orderId, paymentMethod, cardInstallments, cardSurchargeAmount } = event.payload as {
      orderId: string;
      paymentMethod?: PaymentMethod | null;
      cardInstallments?: number | null;
      cardSurchargeAmount?: number | null;
    };
    // paymentMethod viaja desde OrderService.completeOrder() — si es 'CASH'
    // y hay un turno OPEN para el negocio, settleByOrderId vincula el CHARGE
    // al turno en la misma UPDATE (Gap Tango #2). cardInstallments/
    // cardSurchargeAmount son descriptivos, solo tienen efecto si es 'CARD'
    // (Gap Tango #3).
    const paymentInfo: PaymentInfo = {
      paymentMethod: paymentMethod ?? null,
      cardInstallments: cardInstallments ?? null,
      cardSurchargeAmount: cardSurchargeAmount ?? null,
    };
    await financialRepo.settleByOrderId(orderId, paymentInfo);
  };
}

export function handleOrderCancelled(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { orderId } = event.payload as { orderId: string };
    await financialRepo.voidByOrderId(orderId);
  };
}
