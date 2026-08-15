import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountsReceivableService,
  CompanyCustomerRequiredError,
  NoBalanceToTransferError,
} from './accounts-receivable.service.js';
import { StayNotFoundError } from './stay.service.js';
import { CustomerNotFoundError } from '../domain/errors.js';
import { Customer } from '../domain/entities.js';
import { Stay } from '../domain/stay.js';
import type { AccountsReceivableRepository, AccountReceivable, AccountsReceivableReportRow } from '../repositories/accounts-receivable.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../repositories/financial-transaction.repository.js';
import type { StayRepository } from '../repositories/stay.repository.js';
import type { CustomerRepository } from '../repositories/customer.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

const TEST_BUSINESS_ID = 'biz-test';
const TEST_STAY_ID = 'stay-1';
const TEST_COMPANY_ID = 'cust-empresa';
const TEST_GUEST_ID = 'cust-huesped';

/** Fake mínimo — solo lo que AccountsReceivableService llama. */
class FakeAccountsReceivableRepository implements AccountsReceivableRepository {
  public created: Omit<AccountReceivable, 'createdAt' | 'invoicedAt' | 'collectedAt'>[] = [];

  async createWithClient(
    _client: SqlClient,
    ar: Omit<AccountReceivable, 'createdAt' | 'invoicedAt' | 'collectedAt'>,
  ): Promise<AccountReceivable> {
    this.created.push(ar);
    return { ...ar, createdAt: new Date(), invoicedAt: null, collectedAt: null };
  }

  async getById(): Promise<AccountReceivable | undefined> { return undefined; }
  async getByStayId(): Promise<AccountReceivable[]> { return []; }
  async getByCompanyCustomerId(): Promise<AccountReceivable[]> { return []; }
  async markInvoiced(): Promise<AccountReceivable | undefined> { return undefined; }
  async markCollected(): Promise<AccountReceivable | undefined> { return undefined; }
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
    );
  });

  it('crea un PAYMENT que salda el folio y una fila PENDIENTE_FACTURAR', async () => {
    financialRepo.netBalanceByStay = 15000;

    const ar = await service.transferStayBalanceToReceivable({
      stayId: TEST_STAY_ID,
      businessId: TEST_BUSINESS_ID,
      companyCustomerId: TEST_COMPANY_ID,
      transferredBy: 'user-manager',
    });

    expect(financialRepo.created).toHaveLength(1);
    expect(financialRepo.created[0]).toMatchObject({
      customerId: TEST_GUEST_ID,
      stayId: TEST_STAY_ID,
      type: 'PAYMENT',
      amount: 15000,
      status: 'SETTLED',
    });

    expect(arRepo.created).toHaveLength(1);
    expect(ar.status).toBe('PENDIENTE_FACTURAR');
    expect(ar.amount).toBe(15000);
    expect(ar.companyCustomerId).toBe(TEST_COMPANY_ID);
    expect(ar.transferredBy).toBe('user-manager');
  });

  it('rechaza si la estadía no existe', async () => {
    service = new AccountsReceivableService(
      arRepo, financialRepo,
      new FakeStayRepository(null) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
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
