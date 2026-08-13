import { describe, it, expect, beforeEach } from 'vitest';
import { StayService, StayBalanceOwedError, ResourceOccupiedError } from './stay.service.js';
import type { Stay } from '../domain/stay.js';
import { Reservation } from '../domain/Reservation.js';
import { Customer, PhysicalResource } from '../domain/entities.js';
import { ReservationStatus } from '../types/enums.js';
import { InMemoryReservationRepository } from '../repositories/in-memory.reservation.repository.js';
import { InMemoryHousekeepingRepository } from '../repositories/in-memory.housekeeping.repository.js';
import type { StayRepository } from '../repositories/stay.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../repositories/financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

const TEST_BUSINESS_ID = 'biz-test';
const TEST_RESERVATION_ID = 'res-1';
const TEST_RESOURCE_ID = 'room-1';
const TEST_CUSTOMER_ID = 'cust-1';

/** Fake mínimo — memoria plana, solo lo que StayService llama. */
class FakeStayRepository implements StayRepository {
  private stays = new Map<string, Stay>();
  async save(stay: Stay): Promise<void> { this.stays.set(stay.id, stay); }
  async update(stay: Stay): Promise<void> { this.stays.set(stay.id, stay); }
  async findById(id: string): Promise<Stay | null> { return this.stays.get(id) ?? null; }
  async findByReservation(reservationId: string): Promise<Stay | null> {
    return [...this.stays.values()].find((s) => s.reservationId === reservationId) ?? null;
  }
  async findActiveByResource(resourceId: string): Promise<Stay | null> {
    return [...this.stays.values()].find((s) => s.resourceId === resourceId && s.status === 'CHECKED_IN') ?? null;
  }
  async findActiveByCustomer(): Promise<Stay[]> { return []; }
  async findByStatus(): Promise<Stay[]> { return []; }
}

/** Fake mínimo — expone linkStayToReservationCharges/getNetBalanceByStayId de forma inspeccionable. */
class FakeFinancialTransactionRepository implements FinancialTransactionRepository {
  public netBalanceByStay = 0;
  public linkedCalls: { stayId: string; reservationId: string }[] = [];

  async create(tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    return { ...tx, createdAt: new Date() };
  }
  async createWithClient(_c: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    return { ...tx, createdAt: new Date() };
  }
  async getByIdempotencyKey(): Promise<FinancialTransaction | undefined> { return undefined; }
  async getByReservationId(): Promise<FinancialTransaction[]> { return []; }
  async getByOrderId(): Promise<FinancialTransaction[]> { return []; }
  async getByCustomerId(): Promise<FinancialTransaction[]> { return []; }
  async getByStayId(): Promise<FinancialTransaction[]> { return []; }
  async settleByReservationId(): Promise<number> { return 0; }
  async voidByReservationId(): Promise<number> { return 0; }
  async settleByOrderId(): Promise<number> { return 0; }
  async voidByOrderId(): Promise<number> { return 0; }
  async getNetBalanceByCustomerId(): Promise<number> { return 0; }
  async getNetBalanceByStayId(): Promise<number> { return this.netBalanceByStay; }
  async linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number> {
    this.linkedCalls.push({ stayId, reservationId });
    return 1;
  }
}

describe('StayService — ledger (A1, paso 3)', () => {
  let stayRepo: FakeStayRepository;
  let reservationRepo: InMemoryReservationRepository;
  let housekeepingRepo: InMemoryHousekeepingRepository;
  let financialRepo: FakeFinancialTransactionRepository;
  let service: StayService;

  beforeEach(async () => {
    stayRepo = new FakeStayRepository();
    reservationRepo = new InMemoryReservationRepository();
    housekeepingRepo = new InMemoryHousekeepingRepository();
    financialRepo = new FakeFinancialTransactionRepository();
    service = new StayService(stayRepo, reservationRepo, housekeepingRepo, financialRepo);

    const resource = new PhysicalResource(TEST_RESOURCE_ID, 'Habitación 1', 15000, 'cat-1');
    const customer = new Customer(TEST_CUSTOMER_ID, 'Huésped', 'huesped@example.com');
    const reservation = new Reservation({
      id: TEST_RESERVATION_ID,
      customer,
      resource,
      startTime: new Date('2026-08-13T15:00:00Z'),
      endTime: new Date('2026-08-14T11:00:00Z'),
      details: {},
      initialStatus: ReservationStatus.CONFIRMED,
      totalPrice: 15000,
    });
    await reservationRepo.save(reservation);
  });

  it('checkIn() adopta bajo stay_id los cargos que ya existían para la reserva', async () => {
    const stay = await service.checkIn({
      reservationId: TEST_RESERVATION_ID,
      resourceId: TEST_RESOURCE_ID,
      businessId: TEST_BUSINESS_ID,
      assignedBy: 'user-1',
    });

    expect(financialRepo.linkedCalls).toEqual([{ stayId: stay.id, reservationId: TEST_RESERVATION_ID }]);
  });

  it('checkOut() bloquea si la estadía tiene saldo pendiente', async () => {
    const stay = await service.checkIn({
      reservationId: TEST_RESERVATION_ID,
      resourceId: TEST_RESOURCE_ID,
      businessId: TEST_BUSINESS_ID,
      assignedBy: 'user-1',
    });
    financialRepo.netBalanceByStay = 15000;

    await expect(
      service.checkOut({ stayId: stay.id, businessId: TEST_BUSINESS_ID }),
    ).rejects.toThrow(StayBalanceOwedError);

    // No debe haber mutado el estado de la Stay si el checkout se bloqueó.
    const stillCheckedIn = await stayRepo.findById(stay.id);
    expect(stillCheckedIn?.status).toBe('CHECKED_IN');
  });

  it('checkOut() procede si el saldo es 0 (ej. ya se pagó o se transfirió a AR)', async () => {
    const stay = await service.checkIn({
      reservationId: TEST_RESERVATION_ID,
      resourceId: TEST_RESOURCE_ID,
      businessId: TEST_BUSINESS_ID,
      assignedBy: 'user-1',
    });
    financialRepo.netBalanceByStay = 0;

    const checkedOut = await service.checkOut({ stayId: stay.id, businessId: TEST_BUSINESS_ID });

    expect(checkedOut.status).toBe('CHECKED_OUT');
  });

  it('checkIn() sigue rechazando un recurso ya ocupado (comportamiento previo intacto)', async () => {
    await service.checkIn({
      reservationId: TEST_RESERVATION_ID,
      resourceId: TEST_RESOURCE_ID,
      businessId: TEST_BUSINESS_ID,
      assignedBy: 'user-1',
    });

    await expect(
      service.checkIn({
        reservationId: TEST_RESERVATION_ID,
        resourceId: TEST_RESOURCE_ID,
        businessId: TEST_BUSINESS_ID,
        assignedBy: 'user-2',
      }),
    ).rejects.toThrow(ResourceOccupiedError);
  });

  it('getFolio() devuelve saldo + transacciones de la estadía (A1, paso 6)', async () => {
    const stay = await service.checkIn({
      reservationId: TEST_RESERVATION_ID,
      resourceId: TEST_RESOURCE_ID,
      businessId: TEST_BUSINESS_ID,
      assignedBy: 'user-1',
    });
    financialRepo.netBalanceByStay = 15000;

    const folio = await service.getFolio(stay.id, TEST_BUSINESS_ID);

    expect(folio.stayId).toBe(stay.id);
    expect(folio.balance).toBe(15000);
  });
});
