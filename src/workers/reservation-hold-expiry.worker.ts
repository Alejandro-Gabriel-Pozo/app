/**
 * @file reservation-hold-expiry.worker.ts
 * @description C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-
 * 2026-08-22.md) — libera reservas `PENDING` cuyo `deposit_due_by` venció
 * sin cobrar la seña (A8.7, criterios-negocio.md: un hold provisorio se
 * libera solo, con un límite de tiempo real, no solo si alguien cancela a
 * mano). Mismo patrón `setInterval` + `poll()` que `OutboxWorker`
 * (outbox.worker.ts), sin reinventar un mecanismo de scheduling nuevo —
 * pero sin cola de eventos: lee directo `reservations` vía
 * `getPendingWithExpiredDeposit()`.
 *
 * Cada reserva vencida se procesa en su PROPIA transacción — si una falla
 * (ej. conflicto de lock), no bloquea a las demás del mismo ciclo.
 * `voidByReservationId` (sql.financial-transaction.repository.ts) ya
 * acepta voidear filas `SETTLED` además de `PENDING` — cubre la
 * `CHARGE(depósito)` `SETTLED` sin cambios en ese método (ver diseño,
 * sección 6).
 */

import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

export class ReservationHoldExpiryWorker {
  private intervalId: ReturnType<typeof setInterval> | undefined = undefined;
  private polling = false;

  constructor(
    private readonly businessId: string,
    private readonly reservationRepository: ReservationRepository,
    private readonly financialRepository: Pick<FinancialTransactionRepository, 'voidByReservationId' | 'getSettledPaymentTotalForReservation'>,
    private readonly domainEventRepository: DomainEventRepository,
    private readonly transactionManager: TransactionManager,
    private readonly pollIntervalMs = 60_000,
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
    console.log(`[ReservationHoldExpiryWorker] Iniciado (${this.businessId}) — polling cada ${this.pollIntervalMs}ms`);
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const expired = await this.reservationRepository.getPendingWithExpiredDeposit(new Date());
      for (const reservation of expired) {
        try {
          await this.expireOne(reservation.id);
        } catch (err) {
          console.error(`[ReservationHoldExpiryWorker] Error venciendo reserva id=${reservation.id}:`, err);
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async expireOne(reservationId: string): Promise<void> {
    let shouldVoid = false;

    await this.transactionManager.run(async (client: SqlClient) => {
      const reservation = await this.reservationRepository.getById(reservationId);
      // Puede haberse cobrado/cancelado entre el SELECT del poll y acá --
      // re-chequear el estado real dentro de la transacción antes de expirar.
      if (!reservation || reservation.status !== 'PENDING') return;

      // La seña puede haberse cobrado (PAYMENT registrado) sin que todavía
      // se haya llamado a confirmReservation() -- no expirar una reserva ya
      // pagada solo porque nadie apretó "confirmar" a tiempo. Se deja
      // PENDING para que el staff la confirme a mano; el worker la va a
      // dejar de ver en el próximo poll recién cuando cambie de estado.
      if (reservation.depositAmount > 0) {
        const paidSoFar = await this.financialRepository.getSettledPaymentTotalForReservation(reservationId);
        if (paidSoFar >= reservation.depositAmount) return;
      }

      reservation.expire();
      await this.reservationRepository.saveWithClient(client, reservation);
      await this.domainEventRepository.insertWithClient(client, {
        businessId: this.businessId,
        aggregateType: 'RESERVATION',
        aggregateId: reservation.id,
        eventType: 'reservation.expired',
        payload: {
          reservationId: reservation.id,
          customerId: reservation.customer.id,
          depositAmount: reservation.depositAmount,
        },
      });
      shouldVoid = true;
    });

    if (!shouldVoid) return;

    // Fuera de la transacción de arriba a propósito -- voidByReservationId
    // es su propio UPDATE atómico (mismo criterio que
    // handleReservationCancelled, outbox.handlers.ts, que tampoco lo corre
    // dentro de la transacción que graba el evento). Sin efecto práctico
    // hoy (el CHARGE de depósito recién se crea en confirmReservation(),
    // que nunca llegó a correr para una reserva que expira) -- se deja
    // igual por si el modelo de creación del CHARGE cambia más adelante,
    // mismo criterio defensivo que voidByReservationId ya tiene al aceptar
    // PENDING o SETTLED sin asumir cuál de los dos va a encontrar.
    await this.financialRepository.voidByReservationId(reservationId);
  }
}
