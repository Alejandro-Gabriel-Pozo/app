/**
 * @file outbox.handlers.ts
 * @description Handlers concretos del OutboxWorker.
 *
 * Cada handler es idempotente: si se ejecuta dos veces para el mismo evento
 * (garantía at-least-once del outbox), el resultado es el mismo.
 * La idempotencia se garantiza con ON CONFLICT DO NOTHING en `createIfNotExists`
 * usando (reservation_id, type) como clave de unicidad de negocio.
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
    const { reservationId, customerId, totalPrice, businessId } = event.payload as {
      reservationId: string;
      customerId: string;
      totalPrice: number | undefined;
      businessId: string;
    };

    // totalPrice puede ser undefined si la reserva no tiene precio (recursos sin costo).
    // En ese caso no hay nada que registrar financieramente.
    if (totalPrice == null || totalPrice <= 0) return;

    await financialRepo.create({
      id:            randomUUID(),
      businessId:    event.businessId,
      customerId,
      reservationId,
      type:          'CHARGE',
      amount:        totalPrice,
      currency:      'ARS',
      status:        'PENDING',
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
