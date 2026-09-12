import { describe, it, expect, beforeEach } from 'vitest';
import { ReservationHoldExpiryWorker } from './reservation-hold-expiry.worker.js';
import { Reservation } from '../reservas/Reservation.js';
import { BookableResource } from '../reservas/resource.entities.js';
import { InMemoryReservationRepository } from '../reservas/in-memory.reservation.repository.js';
import { ReservationStatus } from '../types/enums.js';
import type { DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

class InMemoryDomainEventRepository implements DomainEventRepository {
  public events: unknown[] = [];
  async insertWithClient(_client: SqlClient, event: unknown): Promise<void> { this.events.push(event); }
  async getPending() { return []; }
  async markDispatched() {}
  async recordFailure() { return false; }
  async countDeadLettered() { return 0; }
  async getDeadLettered() { return []; }
  async retryDeadLettered() {}
  async purgeResolved() { return 0; }
}

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

class FakePaymentLedger {
  private paid = new Map<string, number>();
  public voidedIds: string[] = [];
  public voidLlamadas: [string, string][] = [];
  setPaid(reservationId: string, amount: number): void { this.paid.set(reservationId, amount); }
  async getSettledPaymentTotalForReservation(reservationId: string): Promise<number> {
    return this.paid.get(reservationId) ?? 0;
  }
  async voidByReservationId(reservationId: string, businessId: string) {
    this.voidedIds.push(reservationId);
    this.voidLlamadas.push([reservationId, businessId]);
    return { tipo: 'APLICADO' as const, filas: 1, rechazos: [] };
  }
}

const resource = new BookableResource('t1', 'Mesa Ventana', 50, 'cat-table', {
  shape: 'RECTANGLE', width: 120, height: 80, positionX: 0, positionY: 0, rotationDegrees: 0,
});
const customer = { id: 'cust-1', fullName: 'Ana García', email: 'ana@example.com' };

function makePendingReservation(id: string, opts: { depositAmount?: number; depositDueBy?: Date | null }): Reservation {
  return Reservation.restore({
    id, customer, resource,
    startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
    details: {}, totalPrice: 100, initialStatus: ReservationStatus.PENDING,
    depositAmount: opts.depositAmount ?? 30,
    depositDueBy: opts.depositDueBy ?? null,
    reservationNumber: 1,
    appliedCustomerRateId: null,
  });
}

describe('ReservationHoldExpiryWorker', () => {
  let reservationRepo: InMemoryReservationRepository;
  let financialRepo: FakePaymentLedger;
  let eventRepo: InMemoryDomainEventRepository;
  let worker: ReservationHoldExpiryWorker;

  beforeEach(() => {
    reservationRepo = new InMemoryReservationRepository();
    financialRepo = new FakePaymentLedger();
    eventRepo = new InMemoryDomainEventRepository();
    worker = new ReservationHoldExpiryWorker(
      'biz-test', reservationRepo, financialRepo, eventRepo, new InMemoryTransactionManager(),
    );
  });

  it('expira una reserva PENDING con deposit_due_by vencido y sin pago registrado', async () => {
    const reservation = makePendingReservation('res-1', { depositDueBy: new Date(Date.now() - 1000) });
    await reservationRepo.save(reservation);

    await worker.poll();

    const updated = await reservationRepo.getById('res-1');
    expect(updated!.status).toBe(ReservationStatus.EXPIRED);
    expect(financialRepo.voidedIds).toContain('res-1');
    expect(eventRepo.events).toHaveLength(1);
    expect((eventRepo.events[0] as { eventType: string }).eventType).toBe('reservation.expired');
  });

  it('NO expira si ya se registró un pago que cubre la seña -- deja que el staff confirme a mano', async () => {
    const reservation = makePendingReservation('res-2', { depositAmount: 30, depositDueBy: new Date(Date.now() - 1000) });
    await reservationRepo.save(reservation);
    financialRepo.setPaid('res-2', 30);

    await worker.poll();

    const updated = await reservationRepo.getById('res-2');
    expect(updated!.status).toBe(ReservationStatus.PENDING);
    expect(financialRepo.voidedIds).not.toContain('res-2');
    expect(eventRepo.events).toHaveLength(0);
  });

  it('no toca reservas cuyo deposit_due_by todavía no venció', async () => {
    const reservation = makePendingReservation('res-3', { depositDueBy: new Date(Date.now() + 60 * 60 * 1000) });
    await reservationRepo.save(reservation);

    await worker.poll();

    const updated = await reservationRepo.getById('res-3');
    expect(updated!.status).toBe(ReservationStatus.PENDING);
  });

  it('no toca reservas sin deposit_due_by (sin vencimiento configurado)', async () => {
    const reservation = makePendingReservation('res-4', { depositDueBy: null });
    await reservationRepo.save(reservation);

    await worker.poll();

    const updated = await reservationRepo.getById('res-4');
    expect(updated!.status).toBe(ReservationStatus.PENDING);
  });
});
