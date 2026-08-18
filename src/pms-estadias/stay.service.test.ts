import { describe, it, expect, beforeEach } from 'vitest';
import { StayService, StayBalanceOwedError, ResourceOccupiedError } from './stay.service.js';
import type { Stay } from './stay.js';
import { Reservation } from '../reservas/Reservation.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { PhysicalResource } from '../reservas/resource.entities.js';
import { ReservationStatus } from '../types/enums.js';
import { InMemoryReservationRepository } from '../reservas/in-memory.reservation.repository.js';
import { InMemoryHousekeepingRepository } from './in-memory.housekeeping.repository.js';
import type { StayRepository } from './stay.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { NextArrivalConflictError } from '../domain/errors.js';
import { HousekeepingTask } from './housekeeping-task.js';

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
  public createdCalls: Omit<FinancialTransaction, 'createdAt'>[] = [];

  async create(tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    this.createdCalls.push(tx);
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
  async getByShiftId(): Promise<FinancialTransaction[]> { return []; }
  async linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number> {
    this.linkedCalls.push({ stayId, reservationId });
    return 1;
  }
}

/** Fake mínimo — devuelve un perfil fijo. */
class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get(): Promise<BusinessProfile> { return this.profile; }
  async update(_input: UpdateBusinessProfileInput): Promise<BusinessProfile> { return this.profile; }
}

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  const now = new Date();
  return {
    id: 'default', displayName: null, contactEmail: null,
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires',
    defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe('StayService — ledger (A1, paso 3)', () => {
  let stayRepo: FakeStayRepository;
  let reservationRepo: InMemoryReservationRepository;
  let housekeepingRepo: InMemoryHousekeepingRepository;
  let financialRepo: FakeFinancialTransactionRepository;
  let businessProfileRepo: FakeBusinessProfileRepository;
  let service: StayService;

  beforeEach(async () => {
    stayRepo = new FakeStayRepository();
    reservationRepo = new InMemoryReservationRepository();
    housekeepingRepo = new InMemoryHousekeepingRepository();
    financialRepo = new FakeFinancialTransactionRepository();
    businessProfileRepo = new FakeBusinessProfileRepository(makeProfile());
    service = new StayService(stayRepo, reservationRepo, housekeepingRepo, financialRepo, businessProfileRepo);

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

// Regresión (18/08/2026, pendientes-2026-08-18.md punto N): flujo completo
// de horario de check-in/check-out — pedido, conflicto con la próxima
// llegada, cargo, y housekeeping (notBefore).
describe('StayService — horario de check-in/check-out', () => {
  const NEXT_RESERVATION_ID = 'res-2';

  let stayRepo: FakeStayRepository;
  let reservationRepo: InMemoryReservationRepository;
  let housekeepingRepo: InMemoryHousekeepingRepository;
  let financialRepo: FakeFinancialTransactionRepository;
  let businessProfileRepo: FakeBusinessProfileRepository;
  let service: StayService;

  beforeEach(async () => {
    stayRepo = new FakeStayRepository();
    reservationRepo = new InMemoryReservationRepository();
    housekeepingRepo = new InMemoryHousekeepingRepository();
    financialRepo = new FakeFinancialTransactionRepository();
    businessProfileRepo = new FakeBusinessProfileRepository(makeProfile());
    service = new StayService(stayRepo, reservationRepo, housekeepingRepo, financialRepo, businessProfileRepo);

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

  function addNextReservation(startTime: string): void {
    const resource = new PhysicalResource(TEST_RESOURCE_ID, 'Habitación 1', 15000, 'cat-1');
    const customer = new Customer('cust-2', 'Otro huésped', 'otro@example.com');
    const next = new Reservation({
      id: NEXT_RESERVATION_ID,
      customer,
      resource,
      startTime: new Date(startTime),
      endTime: new Date('2026-08-15T11:00:00Z'),
      details: {},
      initialStatus: ReservationStatus.CONFIRMED,
      totalPrice: 15000,
    });
    void reservationRepo.save(next);
  }

  it('requestScheduleChange() deja el pedido en PENDING', async () => {
    const reservation = await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '13:00:00',
    });

    expect(reservation.scheduleApprovalStatus).toBe('PENDING');
    expect(reservation.requestedCheckOutTime).toBe('13:00:00');
  });

  it('approveScheduleChange() aprueba sin conflicto si no hay próxima reserva en la habitación', async () => {
    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '13:00:00',
    });

    const approved = await service.approveScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      businessId: TEST_BUSINESS_ID,
      approvedBy: 'staff-1',
    });

    expect(approved.scheduleApprovalStatus).toBe('APPROVED');
    expect(approved.scheduleApprovedBy).toBe('staff-1');
  });

  it('approveScheduleChange() rechaza con NextArrivalConflictError si la próxima llegada es antes del checkout pedido', async () => {
    // Próxima reserva arranca el mismo día calendario (14/08) — con el
    // check-in ESTÁNDAR del negocio (14:00 local, default de makeProfile())
    // como hora de llegada efectiva (no pidió su propio horario).
    addNextReservation('2026-08-14T18:00:00Z');

    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '15:00:00', // después de las 14:00 de la próxima llegada -> conflicto
    });

    await expect(
      service.approveScheduleChange({
        reservationId: TEST_RESERVATION_ID,
        businessId: TEST_BUSINESS_ID,
        approvedBy: 'staff-1',
      }),
    ).rejects.toThrow(NextArrivalConflictError);

    // No debe haber quedado aprobado tras el rechazo.
    const reservation = await reservationRepo.getById(TEST_RESERVATION_ID);
    expect(reservation!.scheduleApprovalStatus).toBe('PENDING');
  });

  it('approveScheduleChange() permite el checkout pedido si es antes de la llegada de la próxima reserva', async () => {
    addNextReservation('2026-08-14T18:00:00Z'); // llega a las 14:00 local (default)

    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '12:30:00', // antes de las 14:00 -> sin conflicto
    });

    const approved = await service.approveScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      businessId: TEST_BUSINESS_ID,
      approvedBy: 'staff-1',
    });

    expect(approved.scheduleApprovalStatus).toBe('APPROVED');
  });

  it('approveScheduleChange() crea un CHARGE si se aprueba con cargo', async () => {
    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '13:00:00',
    });

    await service.approveScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      businessId: TEST_BUSINESS_ID,
      approvedBy: 'staff-1',
      chargeAmount: 5000,
    });

    expect(financialRepo.createdCalls).toHaveLength(1);
    expect(financialRepo.createdCalls[0]).toMatchObject({
      type: 'CHARGE',
      amount: 5000,
      reservationId: TEST_RESERVATION_ID,
      businessId: TEST_BUSINESS_ID,
    });
  });

  it('approveScheduleChange() NO crea un CHARGE si no se pasa cargo', async () => {
    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '13:00:00',
    });

    await service.approveScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      businessId: TEST_BUSINESS_ID,
      approvedBy: 'staff-1',
    });

    expect(financialRepo.createdCalls).toHaveLength(0);
  });

  it('approveScheduleChange() actualiza el notBefore de una tarea de housekeeping ya existente', async () => {
    const existingTask = HousekeepingTask.create({
      businessId: TEST_BUSINESS_ID,
      resourceId: TEST_RESOURCE_ID,
      shift: 'MORNING',
      scheduledFor: new Date('2026-08-14T08:00:00Z'),
    });
    housekeepingRepo.seed(existingTask);

    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '13:00:00',
    });
    await service.approveScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      businessId: TEST_BUSINESS_ID,
      approvedBy: 'staff-1',
    });

    const updated = await housekeepingRepo.findById(existingTask.id, TEST_BUSINESS_ID);
    expect(updated!.notBefore).not.toBeNull();
  });

  it('rejectScheduleChange() marca el pedido REJECTED', async () => {
    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '13:00:00',
    });

    const rejected = await service.rejectScheduleChange(TEST_RESERVATION_ID, 'staff-1');

    expect(rejected.scheduleApprovalStatus).toBe('REJECTED');
    expect(rejected.scheduleApprovedBy).toBe('staff-1');
  });

  it('checkOut() crea la tarea de limpieza con notBefore si hubo un late check-out aprobado (tarea sin crear todavía)', async () => {
    const stay = await service.checkIn({
      reservationId: TEST_RESERVATION_ID,
      resourceId: TEST_RESOURCE_ID,
      businessId: TEST_BUSINESS_ID,
      assignedBy: 'user-1',
    });
    await service.requestScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      requestedCheckOutTime: '13:00:00',
    });
    await service.approveScheduleChange({
      reservationId: TEST_RESERVATION_ID,
      businessId: TEST_BUSINESS_ID,
      approvedBy: 'staff-1',
    });

    await service.checkOut({ stayId: stay.id, businessId: TEST_BUSINESS_ID });

    const tasks = await housekeepingRepo.findByResource(TEST_RESOURCE_ID, TEST_BUSINESS_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.notBefore).not.toBeNull();
  });

  it('checkOut() no fija notBefore si no hubo pedido de horario aprobado (comportamiento previo intacto)', async () => {
    const stay = await service.checkIn({
      reservationId: TEST_RESERVATION_ID,
      resourceId: TEST_RESOURCE_ID,
      businessId: TEST_BUSINESS_ID,
      assignedBy: 'user-1',
    });

    await service.checkOut({ stayId: stay.id, businessId: TEST_BUSINESS_ID });

    const tasks = await housekeepingRepo.findByResource(TEST_RESOURCE_ID, TEST_BUSINESS_ID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.notBefore).toBeNull();
  });
});
