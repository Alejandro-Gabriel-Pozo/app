import { describe, it, expect, beforeEach } from 'vitest';
import {
  CashRegisterService,
  ShiftAlreadyOpenError,
  NoOpenShiftError,
  ShiftNotFoundError,
} from './cash-register.service.js';
import type {
  CashRegisterShift,
  CashRegisterShiftRepository,
  CloseShiftInput,
  OpenShiftInput,
} from './cash-register-shift.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from './financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

/** Fake en memoria — imita el índice único parcial de la BD (A8.2) a mano. */
class InMemoryShiftRepository implements CashRegisterShiftRepository {
  public shifts: CashRegisterShift[] = [];
  public cashMovementsTotalByShift: Record<string, number> = {};

  async getOpenShift(businessId: string) {
    return this.shifts.find((s) => s.businessId === businessId && s.status === 'OPEN');
  }

  async getById(id: string) {
    return this.shifts.find((s) => s.id === id);
  }

  async open(input: OpenShiftInput) {
    const alreadyOpen = this.shifts.some((s) => s.businessId === input.businessId && s.status === 'OPEN');
    if (alreadyOpen) {
      const err = new Error('duplicate key value violates unique constraint') as Error & { code: string };
      err.code = '23505';
      throw err;
    }
    const shift: CashRegisterShift = {
      id: input.id,
      businessId: input.businessId,
      openedBy: input.openedBy,
      openedAt: new Date(),
      openingAmount: input.openingAmount,
      currency: input.currency,
      status: 'OPEN',
      closedBy: null,
      closedAt: null,
      closingAmountCounted: null,
      expectedCashAmount: null,
      variance: null,
      notes: input.notes ?? null,
    };
    this.shifts.push(shift);
    return shift;
  }

  async getCashMovementsTotal(shiftId: string) {
    return this.cashMovementsTotalByShift[shiftId] ?? 0;
  }

  async close(id: string, input: CloseShiftInput) {
    const shift = this.shifts.find((s) => s.id === id && s.status === 'OPEN');
    if (!shift) throw new Error(`cash_register_shifts ${id} no está OPEN — no se puede cerrar.`);
    shift.status = 'CLOSED';
    shift.closedBy = input.closedBy;
    shift.closedAt = new Date();
    shift.closingAmountCounted = input.closingAmountCounted;
    shift.expectedCashAmount = input.expectedCashAmount;
    shift.variance = input.variance;
    if (input.notes !== undefined && input.notes !== null) shift.notes = input.notes;
    return shift;
  }

  async list(businessId: string) {
    return this.shifts.filter((s) => s.businessId === businessId);
  }
}

class InMemoryFinancialTransactionRepository implements FinancialTransactionRepository {
  public byShift: Record<string, FinancialTransaction[]> = {};

  async create(tx: Omit<FinancialTransaction, 'createdAt'>) { return { ...tx, createdAt: new Date() }; }
  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>) { return this.create(tx); }
  async getByReservationId() { return []; }
  async getByOrderId() { return []; }
  async getByCustomerId() { return []; }
  async getByStayId() { return []; }
  async getByShiftId(shiftId: string) { return this.byShift[shiftId] ?? []; }
  async getByIdempotencyKey() { return undefined; }
  async settleByReservationId() { return 0; }
  async voidByReservationId() { return 0; }
  async settleByOrderId() { return 0; }
  async voidByOrderId() { return 0; }
  async getNetBalanceByCustomerId() { return 0; }
  async getNetBalanceByStayId() { return 0; }
  async linkStayToReservationCharges() { return 0; }
}

/** Fake mínimo — devuelve un perfil fijo, currency configurable por test. */
class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get(): Promise<BusinessProfile> { return this.profile; }
  async update(_input: UpdateBusinessProfileInput): Promise<BusinessProfile> { return this.profile; }
}

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  const now = new Date();
  return {
    id: 'default', displayName: null, contactEmail: null,
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

const BUSINESS_ID = 'biz-test';

describe('CashRegisterService', () => {
  let shiftRepo: InMemoryShiftRepository;
  let financialRepo: InMemoryFinancialTransactionRepository;
  let service: CashRegisterService;

  beforeEach(() => {
    shiftRepo = new InMemoryShiftRepository();
    financialRepo = new InMemoryFinancialTransactionRepository();
    service = new CashRegisterService(shiftRepo, financialRepo, new FakeBusinessProfileRepository(makeProfile()));
  });

  describe('openShift', () => {
    it('abre un turno nuevo con el monto inicial', async () => {
      const shift = await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });

      expect(shift.status).toBe('OPEN');
      expect(shift.openingAmount).toBe(500);
      expect(shift.openedBy).toBe('user-1');
    });

    it('rechaza abrir un segundo turno mientras hay uno OPEN (A8.2 — vía constraint traducida)', async () => {
      await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });

      await expect(
        service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-2', openingAmount: 300 }),
      ).rejects.toThrow(ShiftAlreadyOpenError);
    });

    it('permite abrir un turno nuevo para otro negocio en paralelo', async () => {
      await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });

      const otherShift = await service.openShift({ businessId: 'biz-otro', openedBy: 'user-3', openingAmount: 200 });
      expect(otherShift.status).toBe('OPEN');
    });

    it('usa la moneda configurada en business_profile, no un valor fijo (auditoría de hardcodes, 17/08/2026)', async () => {
      service = new CashRegisterService(shiftRepo, financialRepo, new FakeBusinessProfileRepository(makeProfile({ currency: 'USD' })));

      const shift = await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });

      expect(shift.currency).toBe('USD');
    });
  });

  describe('closeShift', () => {
    it('rechaza cerrar si no hay turno abierto', async () => {
      await expect(
        service.closeShift({ businessId: BUSINESS_ID, closedBy: 'user-1', closingAmountCounted: 100 }),
      ).rejects.toThrow(NoOpenShiftError);
    });

    it('calcula expectedCashAmount = apertura + movimientos en efectivo, y variance = contado - esperado', async () => {
      const shift = await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });
      shiftRepo.cashMovementsTotalByShift[shift.id] = 300; // ventas en efectivo del turno

      const closed = await service.closeShift({
        businessId: BUSINESS_ID, closedBy: 'user-2', closingAmountCounted: 750,
      });

      expect(closed.status).toBe('CLOSED');
      expect(closed.expectedCashAmount).toBe(800); // 500 + 300
      expect(closed.variance).toBe(-50); // 750 contado - 800 esperado = falta $50
    });

    it('variance positivo cuando sobra efectivo', async () => {
      const shift = await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });
      shiftRepo.cashMovementsTotalByShift[shift.id] = 0;

      const closed = await service.closeShift({
        businessId: BUSINESS_ID, closedBy: 'user-2', closingAmountCounted: 520,
      });

      expect(closed.variance).toBe(20);
    });

    it('permite abrir un turno nuevo después de cerrar el anterior', async () => {
      await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });
      await service.closeShift({ businessId: BUSINESS_ID, closedBy: 'user-1', closingAmountCounted: 500 });

      const second = await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-2', openingAmount: 100 });
      expect(second.status).toBe('OPEN');
    });
  });

  describe('getShiftDetail', () => {
    it('lanza ShiftNotFoundError si el turno no existe', async () => {
      await expect(service.getShiftDetail('shift-inexistente')).rejects.toThrow(ShiftNotFoundError);
    });

    it('devuelve el turno junto con sus transacciones', async () => {
      const shift = await service.openShift({ businessId: BUSINESS_ID, openedBy: 'user-1', openingAmount: 500 });
      financialRepo.byShift[shift.id] = [
        { id: 'tx-1', businessId: BUSINESS_ID, customerId: 'cust-1', type: 'PAYMENT', amount: 100, currency: 'ARS', status: 'SETTLED' },
      ];

      const detail = await service.getShiftDetail(shift.id);
      expect(detail.shift.id).toBe(shift.id);
      expect(detail.transactions).toHaveLength(1);
    });
  });
});
