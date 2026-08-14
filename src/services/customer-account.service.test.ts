import { describe, it, expect, beforeEach } from 'vitest';
import { CustomerAccountService } from './customer-account.service.js';
import { Customer } from '../domain/entities.js';
import type { CustomerRepository } from '../repositories/customer.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../repositories/financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

class FakeCustomerRepository {
  constructor(private readonly customers: Map<string, Customer>) {}
  async getById(id: string): Promise<Customer | undefined> { return this.customers.get(id); }
}

class InMemoryFinancialTransactionRepository implements FinancialTransactionRepository {
  public created: Omit<FinancialTransaction, 'createdAt'>[] = [];

  async create(tx: Omit<FinancialTransaction, 'createdAt'>) {
    this.created.push(tx);
    return { ...tx, createdAt: new Date() };
  }
  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>) { return this.create(tx); }
  async getByReservationId() { return []; }
  async getByOrderId() { return []; }
  async getByCustomerId() { return []; }
  async getByStayId() { return []; }
  async getByShiftId() { return []; }
  async getByIdempotencyKey() { return undefined; }
  async settleByReservationId() { return 0; }
  async voidByReservationId() { return 0; }
  async settleByOrderId() { return 0; }
  async voidByOrderId() { return 0; }
  async getNetBalanceByCustomerId() { return 0; }
  async getNetBalanceByStayId() { return 0; }
  async linkStayToReservationCharges() { return 0; }
}

const CUSTOMER_ID = 'cust-1';
const BUSINESS_ID = 'biz-test';

describe('CustomerAccountService.recordPayment — payment_method (Gap Tango #2)', () => {
  let financialRepo: InMemoryFinancialTransactionRepository;
  let service: CustomerAccountService;

  beforeEach(() => {
    financialRepo = new InMemoryFinancialTransactionRepository();
    const customers = new Map([[CUSTOMER_ID, new Customer(CUSTOMER_ID, 'Cliente Test', [], 'INDIVIDUAL')]]);
    service = new CustomerAccountService(
      financialRepo,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
    );
  });

  it('persiste paymentMethod cuando se pasa', async () => {
    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100, paymentMethod: 'CASH' });

    expect(financialRepo.created[0]).toMatchObject({ paymentMethod: 'CASH', type: 'PAYMENT', status: 'SETTLED' });
  });

  it('paymentMethod queda null si no se pasa (compatibilidad con callers viejos)', async () => {
    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100 });

    expect(financialRepo.created[0]).toMatchObject({ paymentMethod: null });
  });

  it('persiste cardInstallments/cardSurchargeAmount cuando se pasan (Gap Tango #3)', async () => {
    await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 1150,
      paymentMethod: 'CARD', cardInstallments: 6, cardSurchargeAmount: 150,
    });

    expect(financialRepo.created[0]).toMatchObject({ cardInstallments: 6, cardSurchargeAmount: 150 });
  });

  it('cardInstallments/cardSurchargeAmount quedan null si no se pasan', async () => {
    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100, paymentMethod: 'CASH' });

    expect(financialRepo.created[0]).toMatchObject({ cardInstallments: null, cardSurchargeAmount: null });
  });
});
