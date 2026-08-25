import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountsReceivableService,
  CompanyCustomerRequiredError,
  NoBalanceToTransferError,
  AccountReceivableNotFoundError,
  InvalidAccountsReceivableTransitionError,
} from './accounts-receivable.service.js';
import { StayNotFoundError } from '../pms-estadias/stay.service.js';
import { CustomerNotFoundError } from '../domain/errors.js';
import { Customer } from './customer.entities.js';
import { Stay } from '../pms-estadias/stay.js';
import type { AccountsReceivableRepository, AccountReceivable, AccountsReceivableReportRow } from './accounts-receivable.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from './financial-transaction.repository.js';
import type { StayRepository } from '../pms-estadias/stay.repository.js';
import type { CustomerRepository } from './customer.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

const TEST_BUSINESS_ID = 'biz-test';
const TEST_STAY_ID = 'stay-1';
const TEST_COMPANY_ID = 'cust-empresa';
const TEST_GUEST_ID = 'cust-huesped';

/**
 * Fake con estado real (no solo no-ops) — F1-Pieza 3 necesita probar las
 * transiciones PENDIENTE_FACTURAR → FACTURADO → COBRADO, así que el fake
 * tiene que rechazarlas igual que el UPDATE con WHERE status=... real
 * (`SqlAccountsReceivableRepository.markInvoiced`/`markCollected`).
 */
class FakeAccountsReceivableRepository implements AccountsReceivableRepository {
  public created: Omit<AccountReceivable, 'createdAt' | 'invoicedAt' | 'collectedAt'>[] = [];
  public rows = new Map<string, AccountReceivable>();

  async createWithClient(
    _client: SqlClient,
    ar: Omit<AccountReceivable, 'createdAt' | 'invoicedAt' | 'collectedAt'>,
  ): Promise<AccountReceivable> {
    this.created.push(ar);
    const full: AccountReceivable = { ...ar, createdAt: new Date(), invoicedAt: null, collectedAt: null };
    this.rows.set(ar.id, full);
    return full;
  }

  async getById(id: string): Promise<AccountReceivable | undefined> { return this.rows.get(id); }
  async getByStayId(): Promise<AccountReceivable[]> { return []; }
  async getByCompanyCustomerId(companyCustomerId: string): Promise<AccountReceivable[]> {
    return [...this.rows.values()].filter((r) => r.companyCustomerId === companyCustomerId);
  }

  async getPendingByCompanyCustomerId(companyCustomerId: string): Promise<AccountReceivable[]> {
    return [...this.rows.values()].filter(
      (r) => r.companyCustomerId === companyCustomerId && r.status === 'PENDIENTE_FACTURAR' && r.financialTransactionId != null,
    );
  }

  async getByFinancialTransactionId(financialTransactionId: string): Promise<AccountReceivable | undefined> {
    return [...this.rows.values()].find((r) => r.financialTransactionId === financialTransactionId);
  }

  async markInvoiced(id: string, invoiceRef?: string | null): Promise<AccountReceivable | undefined> {
    const ar = this.rows.get(id);
    if (!ar || ar.status !== 'PENDIENTE_FACTURAR') return undefined;
    const updated: AccountReceivable = { ...ar, status: 'FACTURADO', invoicedAt: new Date(), invoiceRef: invoiceRef ?? null };
    this.rows.set(id, updated);
    return updated;
  }

  async markCollected(id: string): Promise<AccountReceivable | undefined> {
    return this.markCollectedWithClient({ async query() { return { rows: [], rowCount: 0 }; } }, id);
  }

  async markCollectedWithClient(_client: SqlClient, id: string): Promise<AccountReceivable | undefined> {
    const ar = this.rows.get(id);
    if (!ar || ar.status !== 'FACTURADO') return undefined;
    const updated: AccountReceivable = { ...ar, status: 'COBRADO', collectedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async getReportByPeriod(): Promise<AccountsReceivableReportRow[]> { return []; }
}

class FakeFinancialTransactionRepository implements FinancialTransactionRepository {
  public netBalanceByStay = 0;
  public created: Omit<FinancialTransaction, 'createdAt'>[] = [];

  async create(tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    return this.createWithClient({ async query() { return { rows: [], rowCount: 0 }; } }, tx);
  }

  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    this.created.push(tx);
    return { ...tx, createdAt: new Date() };
  }

  async getById(): Promise<FinancialTransaction | null> { return null; }
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
  async getSettledPaymentTotalForReservation(): Promise<number> { return 0; }
  async getCollectedPaymentTotalForReservation(): Promise<number> { return 0; }
  async getByShiftId(): Promise<FinancialTransaction[]> { return []; }
  async linkStayToReservationCharges(): Promise<number> { return 0; }
}

class FakeStayRepository implements StayRepository {
  constructor(private readonly stay: Stay | null) {}
  async save(): Promise<void> {}
  async update(): Promise<void> {}
  async findById(): Promise<Stay | null> { return this.stay; }
  async findByReservation(): Promise<Stay | null> { return this.stay; }
  async findActiveByResource(): Promise<Stay | null> { return this.stay; }
  async findActiveByCustomer(): Promise<Stay[]> { return this.stay ? [this.stay] : []; }
  async findByStatus(): Promise<Stay[]> { return this.stay ? [this.stay] : []; }
}

/** Fake mínimo — el servicio solo llama getById(), no hace falta el resto de CustomerRepository. */
class FakeCustomerRepository {
  constructor(private readonly customers: Map<string, Customer>) {}
  async getById(id: string): Promise<Customer | undefined> { return this.customers.get(id); }
}

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
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
    legalName: null, taxId: null, taxIdType: null, taxCondition: null,
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    maintenanceHorizonDays: 30,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe('AccountsReceivableService.transferStayBalanceToReceivable', () => {
  let arRepo: FakeAccountsReceivableRepository;
  let financialRepo: FakeFinancialTransactionRepository;
  let stay: Stay;
  let customers: Map<string, Customer>;
  let service: AccountsReceivableService;

  beforeEach(() => {
    arRepo = new FakeAccountsReceivableRepository();
    financialRepo = new FakeFinancialTransactionRepository();
    stay = Stay.checkIn({
      businessId: TEST_BUSINESS_ID,
      reservationId: 'res-1',
      resourceId: 'room-1',
      customerId: TEST_GUEST_ID,
      assignedBy: 'user-1',
    });
    customers = new Map([
      [TEST_COMPANY_ID, new Customer(TEST_COMPANY_ID, 'Empresa SA', [], 'COMPANY')],
      [TEST_GUEST_ID, new Customer(TEST_GUEST_ID, 'Huésped Individual', [], 'INDIVIDUAL')],
    ]);

    service = new AccountsReceivableService(
      arRepo,
      financialRepo,
      new FakeStayRepository(stay) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
      new FakeBusinessProfileRepository(makeProfile()),
    );
  });

  it('crea un PAYMENT que salda el folio, un CHARGE contra la empresa y una fila PENDIENTE_FACTURAR', async () => {
    financialRepo.netBalanceByStay = 15000;

    const ar = await service.transferStayBalanceToReceivable({
      stayId: TEST_STAY_ID,
      businessId: TEST_BUSINESS_ID,
      companyCustomerId: TEST_COMPANY_ID,
      transferredBy: 'user-manager',
    });

    expect(financialRepo.created).toHaveLength(2);
    expect(financialRepo.created[0]).toMatchObject({
      customerId: TEST_GUEST_ID,
      stayId: TEST_STAY_ID,
      type: 'PAYMENT',
      amount: 15000,
      status: 'SETTLED',
    });

    // F1-Pieza 3 (23/08/2026) — la deuda tiene que aparecer en la cuenta
    // corriente de la EMPRESA desde el momento de la transferencia. Sin
    // stayId a propósito: getNetBalanceByStayId() suma por stay_id sin
    // filtrar por customer_id -- si este CHARGE llevara el mismo stayId
    // que el PAYMENT de arriba, el saldo de la ESTADÍA volvería a quedar
    // positivo y el check-out que la transferencia recién desbloqueó
    // volvería a rechazar. reservationId cumple el mismo rol de
    // trazabilidad (documento de origen, F1-Pieza 2) sin ese efecto.
    expect(financialRepo.created[1]).toMatchObject({
      customerId: TEST_COMPANY_ID,
      reservationId: stay.reservationId,
      type: 'CHARGE',
      amount: 15000,
      status: 'SETTLED',
    });
    expect(financialRepo.created[1]!.stayId).toBeUndefined();

    expect(arRepo.created).toHaveLength(1);
    expect(ar.status).toBe('PENDIENTE_FACTURAR');
    expect(ar.amount).toBe(15000);
    expect(ar.companyCustomerId).toBe(TEST_COMPANY_ID);
    expect(ar.transferredBy).toBe('user-manager');
  });

  it('usa la moneda configurada en business_profile, no un valor fijo (auditoría de hardcodes, 17/08/2026)', async () => {
    service = new AccountsReceivableService(
      arRepo, financialRepo,
      new FakeStayRepository(stay) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
      new FakeBusinessProfileRepository(makeProfile({ currency: 'USD' })),
    );
    financialRepo.netBalanceByStay = 500;

    const ar = await service.transferStayBalanceToReceivable({
      stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
      companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
    });

    expect(financialRepo.created[0]).toMatchObject({ currency: 'USD' });
    expect(financialRepo.created[1]).toMatchObject({ currency: 'USD' });
    expect(ar.currency).toBe('USD');
  });

  it('rechaza si la estadía no existe', async () => {
    service = new AccountsReceivableService(
      arRepo, financialRepo,
      new FakeStayRepository(null) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
      new FakeBusinessProfileRepository(makeProfile()),
    );

    await expect(service.transferStayBalanceToReceivable({
      stayId: 'no-existe', businessId: TEST_BUSINESS_ID,
      companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
    })).rejects.toThrow(StayNotFoundError);
  });

  it('rechaza si el cliente destino no existe', async () => {
    await expect(service.transferStayBalanceToReceivable({
      stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
      companyCustomerId: 'no-existe', transferredBy: 'user-manager',
    })).rejects.toThrow(CustomerNotFoundError);
  });

  it('rechaza si el cliente destino no es una empresa (kind INDIVIDUAL)', async () => {
    financialRepo.netBalanceByStay = 1000;

    await expect(service.transferStayBalanceToReceivable({
      stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
      companyCustomerId: TEST_GUEST_ID, transferredBy: 'user-manager',
    })).rejects.toThrow(CompanyCustomerRequiredError);
  });

  it('rechaza si la estadía no tiene saldo pendiente', async () => {
    financialRepo.netBalanceByStay = 0;

    await expect(service.transferStayBalanceToReceivable({
      stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
      companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
    })).rejects.toThrow(NoBalanceToTransferError);
  });
});

describe('AccountsReceivableService — markInvoiced/markCollected (F1-Pieza 3, 23/08/2026)', () => {
  let arRepo: FakeAccountsReceivableRepository;
  let financialRepo: FakeFinancialTransactionRepository;
  let service: AccountsReceivableService;

  function seed(overrides: Partial<AccountReceivable> = {}): AccountReceivable {
    const ar: AccountReceivable = {
      id: 'ar-1',
      businessId: TEST_BUSINESS_ID,
      stayId: TEST_STAY_ID,
      companyCustomerId: TEST_COMPANY_ID,
      amount: 15000,
      currency: 'ARS',
      status: 'PENDIENTE_FACTURAR',
      transferredBy: 'user-manager',
      notes: null,
      createdAt: new Date(),
      invoicedAt: null,
      collectedAt: null,
      invoiceRef: null,
      ...overrides,
    };
    arRepo.rows.set(ar.id, ar);
    return ar;
  }

  beforeEach(() => {
    arRepo = new FakeAccountsReceivableRepository();
    financialRepo = new FakeFinancialTransactionRepository();
    const customers = new Map([
      [TEST_COMPANY_ID, new Customer(TEST_COMPANY_ID, 'Empresa SA', [], 'COMPANY')],
    ]);
    service = new AccountsReceivableService(
      arRepo, financialRepo,
      new FakeStayRepository(null) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
      new FakeBusinessProfileRepository(makeProfile()),
    );
  });

  describe('markInvoiced — solo cambia el estado, NO toca el ledger', () => {
    it('PENDIENTE_FACTURAR → FACTURADO, guarda invoiceRef', async () => {
      seed();

      const updated = await service.markInvoiced('ar-1', '0001-00001234');

      expect(updated.status).toBe('FACTURADO');
      expect(updated.invoiceRef).toBe('0001-00001234');
      expect(updated.invoicedAt).not.toBeNull();
      expect(financialRepo.created).toHaveLength(0);
    });

    it('invoiceRef es opcional', async () => {
      seed();
      const updated = await service.markInvoiced('ar-1');
      expect(updated.invoiceRef).toBeNull();
    });

    it('rechaza si el id no existe', async () => {
      await expect(service.markInvoiced('no-existe')).rejects.toThrow(AccountReceivableNotFoundError);
    });

    it('rechaza si ya está FACTURADO o COBRADO (R12 — solo avanza, nunca vuelve atrás)', async () => {
      seed({ status: 'FACTURADO' });
      await expect(service.markInvoiced('ar-1')).rejects.toThrow(InvalidAccountsReceivableTransitionError);
    });
  });

  describe('markCollected — FACTURADO → COBRADO, crea el PAYMENT que cierra la deuda', () => {
    it('crea un PAYMENT contra la empresa por el monto exacto', async () => {
      seed({ status: 'FACTURADO', invoiceRef: '0001-00001234' });

      const updated = await service.markCollected('ar-1');

      expect(updated.status).toBe('COBRADO');
      expect(updated.collectedAt).not.toBeNull();
      expect(financialRepo.created).toHaveLength(1);
      expect(financialRepo.created[0]).toMatchObject({
        customerId: TEST_COMPANY_ID,
        type: 'PAYMENT',
        amount: 15000,
        currency: 'ARS',
        status: 'SETTLED',
      });
    });

    it('rechaza si el id no existe', async () => {
      await expect(service.markCollected('no-existe')).rejects.toThrow(AccountReceivableNotFoundError);
    });

    it('rechaza si todavía está PENDIENTE_FACTURAR (no se puede saltear FACTURADO)', async () => {
      seed({ status: 'PENDIENTE_FACTURAR' });
      await expect(service.markCollected('ar-1')).rejects.toThrow(InvalidAccountsReceivableTransitionError);
      expect(financialRepo.created).toHaveLength(0);
    });

    it('rechaza si ya está COBRADO (no se cobra dos veces)', async () => {
      seed({ status: 'COBRADO' });
      await expect(service.markCollected('ar-1')).rejects.toThrow(InvalidAccountsReceivableTransitionError);
      expect(financialRepo.created).toHaveLength(0);
    });
  });

  describe('listByCompany', () => {
    it('devuelve solo las filas de esa empresa', async () => {
      seed({ id: 'ar-1', companyCustomerId: TEST_COMPANY_ID });
      seed({ id: 'ar-2', companyCustomerId: 'otra-empresa' });

      const rows = await service.listByCompany(TEST_COMPANY_ID);

      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe('ar-1');
    });
  });
});
