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
 */

import { randomUUID } from 'crypto';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { FinancialTransactionRepository } from '../repositories/financial-transaction.repository.js';
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
    .on('reservation.cancelled', handleReservationCancelled(financialRepo));
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
