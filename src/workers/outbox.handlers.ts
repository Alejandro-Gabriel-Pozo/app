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
 * - `reservation.confirmed`      → crea CHARGE PENDING en financial_transactions
 * - `reservation.completed`      → pasa CHARGE/ADJUSTMENT a SETTLED (por reservation_id, blanket update)
 * - `reservation.cancelled`      → pasa CHARGE/ADJUSTMENT a VOIDED (si existía)
 * - `reservation.price_adjusted` → crea ADJUSTMENT PENDING (19/08/2026, pendientes-2026-08-18.md punto I;
 *                                   monto con signo — positivo = cargo extra, negativo = nota de crédito)
 * - `order.confirmed`        → crea CHARGE PENDING (mismo mecanismo, por order_id)
 * - `order.completed`        → pasa CHARGE a SETTLED
 * - `order.cancelled`        → pasa CHARGE a VOIDED (si existía)
 */

import { randomUUID } from 'crypto';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { FinancialTransactionRepository, PaymentInfo, PaymentMethod } from '../clientes-finanzas/financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
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
  businessProfileRepo: BusinessProfileRepository,
): void {
  worker
    .on('reservation.confirmed',      handleReservationConfirmed(financialRepo, businessProfileRepo))
    .on('reservation.completed',      handleReservationCompleted(financialRepo))
    .on('reservation.cancelled',      handleReservationCancelled(financialRepo))
    .on('reservation.price_adjusted', handleReservationPriceAdjusted(financialRepo, businessProfileRepo))
    .on('order.confirmed',       handleOrderConfirmed(financialRepo, businessProfileRepo))
    .on('order.completed',       handleOrderCompleted(financialRepo))
    .on('order.cancelled',       handleOrderCancelled(financialRepo));
}

// ---------------------------------------------------------------------------
// Handlers individuales (exportados para testear en aislamiento)
// ---------------------------------------------------------------------------

export function handleReservationConfirmed(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId, customerId, totalPrice } = event.payload as {
      reservationId: string;
      customerId: string;
      totalPrice: number | undefined;
    };

    // Sin precio (recursos sin costo) → no hay movimiento financiero.
    if (totalPrice == null || totalPrice <= 0) return;

    const { currency } = await businessProfileRepo.get();

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
      currency,
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

/**
 * Ajuste de precio de una reserva CONFIRMED (19/08/2026, pendientes-2026-
 * 08-18.md punto I) — crea el `ADJUSTMENT` correspondiente al cargo/nota
 * de crédito que un empleado confirmó a mano
 * (`ReservationService.confirmPriceAdjustment`). `amount` viaja CON SIGNO
 * en el payload (positivo = cargo extra, negativo = nota de crédito) — se
 * pasa tal cual, `getNetBalanceByX` ya suma `amount` de ADJUSTMENT sin
 * `ABS()` (schema.sql BLOQUE financial_transactions, v22). Status PENDING
 * como el CHARGE original — `handleReservationCompleted`/`Cancelled` lo
 * arrastran a SETTLED/VOIDED junto con él (`settleByReservationId`/
 * `voidByReservationId` son un UPDATE por `reservation_id`, no por id de
 * transacción puntual, así que agarran cualquier PENDING de esa reserva).
 */
export function handleReservationPriceAdjusted(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId, customerId, amount, confirmedByUserId } = event.payload as {
      reservationId: string;
      customerId: string;
      amount: number;
      confirmedByUserId?: string;
    };

    if (amount === 0) return;

    const { currency } = await businessProfileRepo.get();

    // idempotencyKey: "${eventId}:ADJUSTMENT" — mismo criterio que
    // "${eventId}:CHARGE" en handleReservationConfirmed. confirmedBy queda
    // grabado en la fila (accountability — quién autorizó este movimiento,
    // no solo que "el sistema" lo hizo).
    await financialRepo.create({
      id:             randomUUID(),
      businessId:     event.businessId,
      customerId,
      reservationId,
      type:           'ADJUSTMENT',
      amount,
      currency,
      status:         'PENDING',
      idempotencyKey: `${event.id}:ADJUSTMENT`,
      confirmedBy:    confirmedByUserId ?? null,
    });
  };
}

// ---------------------------------------------------------------------------
// Handlers de Order — cierra el gap de "Order nunca toca el ledger"
// (auditoría de deuda estructural, item #3). Mismo mecanismo que Reservation:
// CHARGE PENDING al confirmar, SETTLED al completar, VOIDED al cancelar.
// ---------------------------------------------------------------------------

export function handleOrderConfirmed(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
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

    const { currency } = await businessProfileRepo.get();

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
      currency,
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
