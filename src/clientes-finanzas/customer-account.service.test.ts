import { describe, it, expect, beforeEach } from 'vitest';
import { CustomerAccountService } from './customer-account.service.js';
import { Customer } from './customer.entities.js';
import type { CustomerRepository } from './customer.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from './financial-transaction.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { Invoice } from '../facturacion/invoice.entities.js';
import type { TransactionManager } from '../db/transaction-manager.js';

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
  async getCollectedPaymentTotalForReservation() { return 0; }
  async linkStayToReservationCharges() { return 0; }
}

/** Fake mínimo para el path de allocations (I4) — un mapa de facturas por id, todas ISSUED por default. */
class FakeInvoiceRepository {
  constructor(private readonly invoices: Map<string, Invoice>) {}
  async getById(id: string): Promise<Invoice | null> { return this.invoices.get(id) ?? null; }
  async getOutstandingByCustomerId(): Promise<Array<Invoice & { outstanding: number }>> { return []; }
}

/** Corre el callback directo, sin BEGIN/COMMIT real -- alcanza para testear la orquestación. */
class FakeTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    return work({} as SqlClient);
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
      new FakeInvoiceRepository(new Map()) as unknown as InvoiceRepository,
      new FakeTransactionManager(),
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
      new FakeInvoiceRepository(new Map()) as unknown as InvoiceRepository,
      new FakeTransactionManager(),
    );

    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100 });

    expect(financialRepo.created[0]).toMatchObject({ currency: 'USD' });
  });
});

// I4 (23/08/2026) — conciliación de pagos: recordPayment() con allocations.
describe('CustomerAccountService.recordPayment — allocations (I4)', () => {
  let financialRepo: InMemoryFinancialTransactionRepository;
  let invoices: Map<string, Invoice>;
  let service: CustomerAccountService;

  function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
      id: 'inv-1', businessId: BUSINESS_ID, financialTransactionId: 'ft-orig',
      customerId: CUSTOMER_ID, idempotencyKey: 'idem-1', environment: 'homologacion',
      ptoVta: 1, cbteTipo: 6, cbteNro: 1, concepto: 1, docTipo: 96, docNro: '0',
      condicionIvaReceptorId: 5, moneda: 'PES', impNeto: 1000, impIva: 210, impTotal: 1210,
      cae: '123', caeVto: '2026-09-01', status: 'ISSUED', afipContacted: true, emisorCuit: null,
      paymentMethod: null, cardInstallments: null, afipRequest: null, afipResponse: null,
      errorMessage: null, createdAt: new Date(), issuedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    financialRepo = new InMemoryFinancialTransactionRepository();
    invoices = new Map([['inv-1', makeInvoice()]]);
    const customers = new Map([[CUSTOMER_ID, new Customer(CUSTOMER_ID, 'Cliente Test', [], 'INDIVIDUAL')]]);
    service = new CustomerAccountService(
      financialRepo,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new FakeBusinessProfileRepository(makeProfile()),
      new FakeInvoiceRepository(invoices) as unknown as InvoiceRepository,
      new FakeTransactionManager(),
    );
  });

  it('crea una fila PAYMENT por factura asignada, con settledInvoiceId', async () => {
    const result = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 1210,
      allocations: [{ invoiceId: 'inv-1', amount: 1210 }],
    });

    expect(result).toHaveLength(1);
    expect(financialRepo.created[0]).toMatchObject({ settledInvoiceId: 'inv-1', amount: 1210, status: 'SETTLED' });
  });

  it('si el monto pagado excede lo asignado, crea una fila extra sin asociar por el resto', async () => {
    await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 1500,
      allocations: [{ invoiceId: 'inv-1', amount: 1210 }],
    });

    expect(financialRepo.created).toHaveLength(2);
    expect(financialRepo.created[0]).toMatchObject({ settledInvoiceId: 'inv-1', amount: 1210 });
    expect(financialRepo.created[1]).toMatchObject({ settledInvoiceId: null, amount: 290 });
  });

  it('rechaza si lo asignado supera el monto pagado', async () => {
    await expect(service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100,
      allocations: [{ invoiceId: 'inv-1', amount: 1210 }],
    })).rejects.toThrow();
  });

  it('rechaza una factura que no pertenece a este cliente', async () => {
    invoices.set('inv-otro', makeInvoice({ id: 'inv-otro', customerId: 'otro-cliente' }));

    await expect(service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100,
      allocations: [{ invoiceId: 'inv-otro', amount: 100 }],
    })).rejects.toThrow();
  });

  it('rechaza una factura que no está ISSUED', async () => {
    invoices.set('inv-pending', makeInvoice({ id: 'inv-pending', status: 'PENDING' }));

    await expect(service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100,
      allocations: [{ invoiceId: 'inv-pending', amount: 100 }],
    })).rejects.toThrow();
  });

  it('rechaza una factura inexistente', async () => {
    await expect(service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100,
      allocations: [{ invoiceId: 'inv-no-existe', amount: 100 }],
    })).rejects.toThrow();
  });

  it('cardInstallments/cardSurchargeAmount van solo en la primera fila, no se duplican', async () => {
    invoices.set('inv-2', makeInvoice({ id: 'inv-2' }));

    await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 2420,
      paymentMethod: 'CARD', cardInstallments: 3, cardSurchargeAmount: 100,
      allocations: [{ invoiceId: 'inv-1', amount: 1210 }, { invoiceId: 'inv-2', amount: 1210 }],
    });

    expect(financialRepo.created[0]).toMatchObject({ cardInstallments: 3, cardSurchargeAmount: 100 });
    expect(financialRepo.created[1]).toMatchObject({ cardInstallments: null, cardSurchargeAmount: null });
  });
});
