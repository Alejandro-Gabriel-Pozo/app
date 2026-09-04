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
import type { InvoiceRepository, InvoiceLinkage } from '../facturacion/invoice.repository.js';

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
  /** O2F2-A -- para poder aseverar que markCollected() lockea ANTES de leer nada. */
  public lockedIds: string[] = [];

  async lockForUpdate(_client: SqlClient, id: string): Promise<void> {
    this.lockedIds.push(id);
  }

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
  // O2 (03/09/2026) -- este doble no ejercita los efectos de orden.
  async settleChargesByOrderId() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async createOrderChargeIfConfirmed() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async voidByOrderId() { return { tipo: 'NADA_QUE_HACER' } as const; }
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

/**
 * O2-F2 (03/09/2026) -- fake mínimo, solo los dos métodos que
 * `AccountsReceivableService` consume. `outstandingByInvoiceId` simula el
 * saldo real de la factura (default: `requestedAmount`, es decir "nada
 * cobrado todavía") -- los tests que necesitan un saldo distinto lo setean
 * antes de llamar a `markCollected()`.
 */
class FakeInvoiceRepository implements Pick<InvoiceRepository, 'getOutstandingForUpdate' | 'resolveInvoiceLinkage'> {
  public invoiceIdByFinancialTransactionId = new Map<string, string>();
  public outstandingByInvoiceId = new Map<string, number>();
  /** AR-FACT-NO-ISSUED-01 -- configura el caso NOT_ISSUED por ftId. */
  public notIssuedByFinancialTransactionId = new Map<string, { invoiceId: string; status: 'PENDING' | 'REJECTED' | 'FAILED_UNCERTAIN'; afipContacted: boolean }>();

  async resolveInvoiceLinkage(financialTransactionId: string): Promise<InvoiceLinkage> {
    const issuedId = this.invoiceIdByFinancialTransactionId.get(financialTransactionId);
    if (issuedId) return { kind: 'ISSUED', invoiceId: issuedId };
    const notIssued = this.notIssuedByFinancialTransactionId.get(financialTransactionId);
    if (notIssued) return { kind: 'NOT_ISSUED', ...notIssued };
    return { kind: 'NONE' };
  }

  async getOutstandingForUpdate(_client: SqlClient, invoiceId: string): Promise<number> {
    const outstanding = this.outstandingByInvoiceId.get(invoiceId);
    if (outstanding === undefined) {
      throw new Error(`FakeInvoiceRepository: outstanding no seteado para "${invoiceId}"`);
    }
    return outstanding;
  }
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
  let invoiceRepo: FakeInvoiceRepository;
  let stay: Stay;
  let customers: Map<string, Customer>;
  let service: AccountsReceivableService;

  beforeEach(() => {
    arRepo = new FakeAccountsReceivableRepository();
    financialRepo = new FakeFinancialTransactionRepository();
    invoiceRepo = new FakeInvoiceRepository();
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
      invoiceRepo,
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
      invoiceRepo,
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
      invoiceRepo,
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
  let invoiceRepo: FakeInvoiceRepository;
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
    invoiceRepo = new FakeInvoiceRepository();
    const customers = new Map([
      [TEST_COMPANY_ID, new Customer(TEST_COMPANY_ID, 'Empresa SA', [], 'COMPANY')],
    ]);
    service = new AccountsReceivableService(
      arRepo, financialRepo,
      new FakeStayRepository(null) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
      new FakeBusinessProfileRepository(makeProfile()),
      invoiceRepo,
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
    it('O2F2-A -- lockea la fila AR como primera operación de la transacción', async () => {
      seed({ status: 'FACTURADO' });
      await service.markCollected('ar-1');
      expect(arRepo.lockedIds).toEqual(['ar-1']);
    });

    it('sin financialTransactionId (fila legacy, §5.1 del diseño) -- fallback sin cambios: PAYMENT sin settledInvoiceId por el monto exacto', async () => {
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
        settledInvoiceId: null,
      });
    });

    it('rechaza si el id no existe', async () => {
      await expect(service.markCollected('no-existe')).rejects.toThrow(AccountReceivableNotFoundError);
    });

    it('rechaza si todavía está PENDIENTE_FACTURAR (no se puede saltear FACTURADO -- éste sigue siendo genuinamente inválido)', async () => {
      seed({ status: 'PENDIENTE_FACTURAR' });
      await expect(service.markCollected('ar-1')).rejects.toThrow(InvalidAccountsReceivableTransitionError);
      expect(financialRepo.created).toHaveLength(0);
    });

    it('O2-F2 (03/09/2026) -- idempotente si ya está COBRADO: devuelve la fila tal cual, sin crear un segundo PAYMENT ni lanzar 409', async () => {
      const ar = seed({ status: 'COBRADO' });

      const result = await service.markCollected('ar-1');

      expect(result).toEqual(ar);
      expect(financialRepo.created).toHaveLength(0);
    });

    it('O2-F2 -- con financialTransactionId resoluble a una factura: el PAYMENT lleva settledInvoiceId y se capa al saldo vigente', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1', amount: 1000 });
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-1', 'inv-1');
      invoiceRepo.outstandingByInvoiceId.set('inv-1', 1000); // nada cobrado todavía

      const updated = await service.markCollected('ar-1');

      expect(updated.status).toBe('COBRADO');
      expect(financialRepo.created).toHaveLength(1);
      expect(financialRepo.created[0]).toMatchObject({
        amount: 1000,
        settledInvoiceId: 'inv-1',
        idempotencyKey: 'ar-collect:ar-1',
      });
    });

    it('O2-F2 -- si el saldo real de la factura es menor al monto AR (otro camino ya cobró parte), capa contra el saldo real y NO crea PAYMENT por el excedente', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1', amount: 1000 });
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-1', 'inv-1');
      invoiceRepo.outstandingByInvoiceId.set('inv-1', 300); // ya se cobraron 700 por otro camino

      await service.markCollected('ar-1');

      expect(financialRepo.created).toHaveLength(1);
      expect(financialRepo.created[0]).toMatchObject({ amount: 300, settledInvoiceId: 'inv-1' });
    });

    it('H-A (05/09/2026) -- colisión total (otro camino ya cubrió el 100%): cero PAYMENT nuevos, AR pasa a COBRADO, respuesta expone la colisión', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1', amount: 1000 });
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-1', 'inv-1');
      invoiceRepo.outstandingByInvoiceId.set('inv-1', 0); // ya se cobró el 100% por otro camino

      const result = await service.markCollected('ar-1');

      expect(financialRepo.created).toHaveLength(0);
      expect(result.status).toBe('COBRADO');
      expect(result.collection).toEqual({ invoiceId: 'inv-1', appliedAmount: 0, excessAmount: 1000 });
    });

    it('H-A -- reintento tras colisión total sigue siendo idempotente (guarda de status, no la clave de idempotencia -- nunca se consumió)', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1', amount: 1000 });
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-1', 'inv-1');
      invoiceRepo.outstandingByInvoiceId.set('inv-1', 0);

      await service.markCollected('ar-1');
      const second = await service.markCollected('ar-1');

      expect(financialRepo.created).toHaveLength(0);
      expect(second.status).toBe('COBRADO');
    });

    it('O2-F2 -- con excedente parcial (no total), la respuesta también expone la colisión', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1', amount: 1000 });
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-1', 'inv-1');
      invoiceRepo.outstandingByInvoiceId.set('inv-1', 300);

      const result = await service.markCollected('ar-1');

      expect(result.collection).toEqual({ invoiceId: 'inv-1', appliedAmount: 300, excessAmount: 700 });
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
