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
  // Los nombres (`financial:*`) son la clave del casillero en
  // `processed_events` (28/08/2026, A10.3). Renombrar uno equivale a declarar
  // que ese handler nunca corrió: todos los eventos pendientes lo volverían a
  // ejecutar. El prefijo `financial:` evita chocar con el handler de
  // inventario, que escucha los MISMOS `order.confirmed`/`order.cancelled`.
  worker
    .on('reservation.confirmed',      handleReservationConfirmed(financialRepo, businessProfileRepo), { name: 'financial:reservation.confirmed' })
    .on('reservation.completed',      handleReservationCompleted(financialRepo),                      { name: 'financial:reservation.completed' })
    .on('reservation.cancelled',      handleReservationCancelled(financialRepo),                      { name: 'financial:reservation.cancelled' })
    .on('reservation.price_adjusted', handleReservationPriceAdjusted(financialRepo, businessProfileRepo), { name: 'financial:reservation.price_adjusted' })
    .on('order.confirmed',       handleOrderConfirmed(financialRepo, businessProfileRepo), { name: 'financial:order.confirmed' })
    .on('order.completed',       handleOrderCompleted(financialRepo),                      { name: 'financial:order.completed' })
    .on('order.cancelled',       handleOrderCancelled(financialRepo),                      { name: 'financial:order.cancelled' });
}

// ---------------------------------------------------------------------------
// Handlers individuales (exportados para testear en aislamiento)
// ---------------------------------------------------------------------------

/**
 * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md) —
 * antes creaba UNA CHARGE PENDING por `totalPrice`. Ahora crea dos, con
 * ciclos de vida distintos:
 *   - CHARGE(depósito) `SETTLED` directo -- `ReservationService.
 *     confirmReservation()` ya verificó que está cobrado (regla de oro,
 *     gate `DepositNotPaidError`) antes de emitir este evento, así que acá
 *     es un hecho consumado, no algo "pendiente" de settlear después.
 *   - CHARGE(saldo = totalPrice - depositAmount) `PENDING` -- mismo rol que
 *     la única CHARGE de antes: sigue flotando durante la estadía, acepta
 *     ADJUSTMENTs (confirmPriceAdjustment) y se salda en bloque recién al
 *     completar (`handleReservationCompleted`, sin cambios). Si el saldo da
 *     0 (deposit_amount === totalPrice, seña 100%) no se crea -- mismo
 *     guard que ya existía para totalPrice <= 0.
 * Dos idempotencyKeys distintas ("${event.id}:CHARGE:DEPOSIT"/
 * "${event.id}:CHARGE:BALANCE") -- un mismo evento reintentado no duplica
 * ninguna de las dos.
 */
export function handleReservationConfirmed(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId, customerId, totalPrice, depositAmount } = event.payload as {
      reservationId: string;
      customerId: string;
      totalPrice: number | undefined;
      depositAmount: number | undefined;
    };

    // Sin precio (recursos sin costo) → no hay movimiento financiero.
    if (totalPrice == null || totalPrice <= 0) return;

    const { currency } = await businessProfileRepo.get();
    // depositAmount puede faltar en eventos viejos (antes de esta fase,
    // todavía en el outbox sin procesar) -- se tratan como "sin seña", todo
    // el total va al saldo, mismo comportamiento que tenían antes.
    const deposit = depositAmount ?? 0;
    const balance = totalPrice - deposit;

    if (deposit > 0) {
      await financialRepo.create({
        id:             randomUUID(),
        businessId:     event.businessId,
        customerId,
        reservationId,
        type:           'CHARGE',
        amount:         deposit,
        currency,
        status:         'SETTLED',
        idempotencyKey: `${event.id}:CHARGE:DEPOSIT`,
      });
    }

    if (balance > 0) {
      await financialRepo.create({
        id:             randomUUID(),
        businessId:     event.businessId,
        customerId,
        reservationId,
        type:           'CHARGE',
        amount:         balance,
        currency,
        status:         'PENDING',
        idempotencyKey: `${event.id}:CHARGE:BALANCE`,
      });
    }
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
