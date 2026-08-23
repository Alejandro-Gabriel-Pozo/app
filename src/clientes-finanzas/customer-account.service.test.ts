import { describe, it, expect, beforeEach } from 'vitest';
import { CustomerAccountService } from './customer-account.service.js';
import { Customer } from './customer.entities.js';
import type { CustomerRepository } from './customer.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from './financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

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
  async getById() { return null; }
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
  async getSettledPaymentTotalForReservation() { return 0; }
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
    legalName: null, taxId: null, taxIdType: null, taxCondition: null,
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: null, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    createdAt: now, updatedAt: now,
    ...overrides,
  };
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
      new FakeBusinessProfileRepository(makeProfile()),
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

  it('reservationId se persiste cuando se pasa (C1-Fase A, cobro de seña/saldo)', async () => {
    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 30, reservationId: 'res-1' });

    expect(financialRepo.created[0]).toMatchObject({ reservationId: 'res-1', type: 'PAYMENT', status: 'SETTLED' });
  });

  it('reservationId queda null si no se pasa (pago genérico contra la cuenta del cliente, sin cambios)', async () => {
    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100 });

    expect(financialRepo.created[0]).toMatchObject({ reservationId: null });
  });

  it('usa la moneda configurada en business_profile, no un valor fijo (auditoría de hardcodes, 17/08/2026)', async () => {
    const customers = new Map([[CUSTOMER_ID, new Customer(CUSTOMER_ID, 'Cliente Test', [], 'INDIVIDUAL')]]);
    service = new CustomerAccountService(
      financialRepo,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new FakeBusinessProfileRepository(makeProfile({ currency: 'USD' })),
    );

    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100 });

    expect(financialRepo.created[0]).toMatchObject({ currency: 'USD' });
  });
});
