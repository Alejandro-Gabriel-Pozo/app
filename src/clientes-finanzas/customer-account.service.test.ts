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
  /** Filas ya "confirmadas" -- createdAt se fija una sola vez, al crear, para que un reintento (getByIdempotencyKey) devuelva el mismo objeto en vez de uno con un timestamp nuevo. */
  public created: FinancialTransaction[] = [];

  /**
   * Paso 2(b) (14/09/2026) -- único de los 7 fakes de
   * FinancialTransactionRepository del repo que necesita este método
   * (ver §4.3 del diseño): configurable por test con `setCityLedgerOutstanding()`,
   * default 0 (sin transferencia vigente).
   */
  private cityLedgerOutstanding = 0;
  setCityLedgerOutstanding(amount: number) { this.cityLedgerOutstanding = amount; }
  async getCityLedgerOutstandingByCustomerId(_customerId: string): Promise<number> {
    return this.cityLedgerOutstanding;
  }

  /** Simula ON CONFLICT DO NOTHING sobre idempotencyKey -- null si ya existe una fila con la misma key. */
  async create(tx: Omit<FinancialTransaction, 'createdAt'>) {
    if (tx.idempotencyKey && this.created.some((c) => c.idempotencyKey === tx.idempotencyKey)) return null;
    const stored: FinancialTransaction = { ...tx, createdAt: new Date() };
    this.created.push(stored);
    return stored;
  }
  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>) { return this.create(tx); }
  async getById() { return null; }
  async getByReservationId() { return []; }
  async getByOrderId() { return []; }
  async getByCustomerId() { return []; }
  async getByStayId() { return []; }
  async getByShiftId() { return []; }
  async getByIdempotencyKey(key: string) {
    return this.created.find((c) => c.idempotencyKey === key);
  }
  async settleByReservationId() { return 0; }
  async voidByReservationId() { return { tipo: 'NADA_QUE_HACER' as const }; }
  // O2 (03/09/2026) -- este doble no ejercita los efectos de orden.
  async settleChargesByOrderId() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async createOrderChargeIfConfirmed() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async voidByOrderId() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async getNetBalanceByCustomerId() { return 0; }
  async getNetBalanceByStayId() { return 0; }
  async getSettledPaymentTotalForReservation() { return 0; }
  async getCollectedPaymentTotalForReservation() { return 0; }
  async linkStayToReservationCharges() { return 0; }
}

/**
 * Fake mínimo para el path de allocations (I4/O2-F1) — un mapa de facturas
 * por id, todas ISSUED por default. `getOutstandingForUpdate` devuelve
 * `impTotal` salvo que el test configure un override explícito con
 * `setOutstanding()` (para simular una factura parcialmente saldada por
 * un pago anterior, el caso central de O2-F1).
 */
class FakeInvoiceRepository {
  private readonly outstandingOverrides = new Map<string, number>();
  constructor(private readonly invoices: Map<string, Invoice>) {}
  async getById(id: string): Promise<Invoice | null> { return this.invoices.get(id) ?? null; }
  async getOutstandingByCustomerId(): Promise<Array<Invoice & { outstanding: number }>> { return []; }
  async getOutstandingForUpdate(_client: SqlClient, invoiceId: string): Promise<number> {
    if (this.outstandingOverrides.has(invoiceId)) return this.outstandingOverrides.get(invoiceId)!;
    const invoice = this.invoices.get(invoiceId);
    if (!invoice) throw new Error(`getOutstandingForUpdate: factura "${invoiceId}" no existe en el fake`);
    return invoice.impTotal;
  }
  setOutstanding(invoiceId: string, outstanding: number) {
    this.outstandingOverrides.set(invoiceId, outstanding);
  }
}

/** Corre el callback directo, sin BEGIN/COMMIT real -- alcanza para testear la orquestación. */
class FakeTransactionManager implements TransactionManager {
  /** O2F2-B -- queries crudas emitidas sobre `client` (ej. el advisory lock de
   * `acquireIdempotencyLock`), para poder aseverar que se pidió sin depender
   * de un mock que lo trague en silencio (architecture-governor, 03/09/2026). */
  public rawQueries: { sql: string; params: unknown[] | undefined }[] = [];
  /** Residual B-1 / 3.2-b (13/09/2026) -- cuántas veces se abrió una
   * transacción, para aseverar que la rama sin `allocations` ahora
   * transaccionaliza (antes: 0 llamadas, `create()` corría suelto). */
  public runCallCount = 0;

  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    this.runCallCount++;
    const client: SqlClient = {
      query: async (sql: string, params?: unknown[]) => {
        this.rawQueries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    return work(client);
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

  // Residual B-1 / 3.2-b (13/09/2026) -- antes de este fix, la rama sin
  // `allocations` llamaba `financialRepo.create()` directo, sin abrir
  // ninguna transacción (0 llamadas a `transactionManager.run()`).
  it('transaccionaliza la rama sin allocations (antes corría suelto por el pool)', async () => {
    const txManager = new FakeTransactionManager();
    const svc = new CustomerAccountService(
      financialRepo,
      new FakeCustomerRepository(new Map([[CUSTOMER_ID, new Customer(CUSTOMER_ID, 'Cliente Test', [], 'INDIVIDUAL')]])) as unknown as CustomerRepository,
      new FakeBusinessProfileRepository(makeProfile()),
      new FakeInvoiceRepository(new Map()) as unknown as InvoiceRepository,
      txManager,
    );

    await svc.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100 });

    expect(txManager.runCallCount).toBe(1);
    expect(financialRepo.created[0]).toMatchObject({ type: 'PAYMENT', amount: 100, status: 'SETTLED' });
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

  // CITY-LEDGER-OVERTRANSFER-PAYMENT-001 (13/09/2026)
  it('stayId se persiste cuando se pasa -- la ruta lo resuelve, este servicio solo lo reenvía', async () => {
    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 30, reservationId: 'res-1', stayId: 'stay-1' });

    expect(financialRepo.created[0]).toMatchObject({ reservationId: 'res-1', stayId: 'stay-1' });
  });

  it('stayId queda null si no se pasa (comportamiento sin cambios -- pago sin estadía activa)', async () => {
    await service.recordPayment({ customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 100 });

    expect(financialRepo.created[0]).toMatchObject({ stayId: null });
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
  let invoiceRepo: FakeInvoiceRepository;
  let service: CustomerAccountService;

  function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
      id: 'inv-1', businessId: BUSINESS_ID, financialTransactionId: 'ft-orig',
      customerId: CUSTOMER_ID, idempotencyKey: 'idem-1', environment: 'homologacion',
      ptoVta: 1, cbteTipo: 6, cbteNro: 1, concepto: 1, docTipo: 96, docNro: '0',
      condicionIvaReceptorId: 5, moneda: 'PES', impNeto: 1000, impIva: 210, impTotal: 1210,
      cae: '123', caeVto: '2026-09-01', status: 'ISSUED', afipContacted: true, pendingSince: null, uncertainClearedAt: null, uncertainClearedBy: null, emisorCuit: null,
      paymentMethod: null, cardInstallments: null, afipRequest: null, afipResponse: null,
      errorMessage: null, createdAt: new Date(), issuedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    financialRepo = new InMemoryFinancialTransactionRepository();
    invoices = new Map([['inv-1', makeInvoice()]]);
    invoiceRepo = new FakeInvoiceRepository(invoices);
    const customers = new Map([[CUSTOMER_ID, new Customer(CUSTOMER_ID, 'Cliente Test', [], 'INDIVIDUAL')]]);
    service = new CustomerAccountService(
      financialRepo,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new FakeBusinessProfileRepository(makeProfile()),
      invoiceRepo as unknown as InvoiceRepository,
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

  // CITY-LEDGER-OVERTRANSFER-PAYMENT-001 (13/09/2026) -- la rama con
  // allocations también seteaba stayId como huérfano; un pago del huésped
  // en el mostrador contra una factura ya emitida es la misma plata.
  it('stayId se persiste en la fila asignada Y en la fila sin asignar (las dos ramas de create())', async () => {
    await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 1500, stayId: 'stay-1',
      allocations: [{ invoiceId: 'inv-1', amount: 1210 }],
    });

    expect(financialRepo.created).toHaveLength(2);
    expect(financialRepo.created[0]).toMatchObject({ settledInvoiceId: 'inv-1', stayId: 'stay-1' });
    expect(financialRepo.created[1]).toMatchObject({ settledInvoiceId: null, stayId: 'stay-1' });
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

// O2-F1 (03/09/2026, decisión del dueño: opción B -- truncamiento
// controlado) -- recordPayment() no puede sobre-aplicar contra el saldo
// vigente de una factura; el excedente queda como pago sin asignar,
// nunca se pierde ni se rechaza el pago completo.
describe('CustomerAccountService.recordPayment — truncamiento controlado (O2-F1)', () => {
  let financialRepo: InMemoryFinancialTransactionRepository;
  let invoices: Map<string, Invoice>;
  let invoiceRepo: FakeInvoiceRepository;
  let transactionManager: FakeTransactionManager;
  let service: CustomerAccountService;

  function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
    return {
      id: 'inv-1', businessId: BUSINESS_ID, financialTransactionId: 'ft-orig',
      customerId: CUSTOMER_ID, idempotencyKey: 'idem-1', environment: 'homologacion',
      ptoVta: 1, cbteTipo: 6, cbteNro: 1, concepto: 1, docTipo: 96, docNro: '0',
      condicionIvaReceptorId: 5, moneda: 'PES', impNeto: 1000, impIva: 210, impTotal: 1210,
      cae: '123', caeVto: '2026-09-01', status: 'ISSUED', afipContacted: true, pendingSince: null, uncertainClearedAt: null, uncertainClearedBy: null, emisorCuit: null,
      paymentMethod: null, cardInstallments: null, afipRequest: null, afipResponse: null,
      errorMessage: null, createdAt: new Date(), issuedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    financialRepo = new InMemoryFinancialTransactionRepository();
    invoices = new Map([['inv-1', makeInvoice()], ['inv-2', makeInvoice({ id: 'inv-2' })]]);
    invoiceRepo = new FakeInvoiceRepository(invoices);
    const customers = new Map([[CUSTOMER_ID, new Customer(CUSTOMER_ID, 'Cliente Test', [], 'INDIVIDUAL')]]);
    transactionManager = new FakeTransactionManager();
    service = new CustomerAccountService(
      financialRepo,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new FakeBusinessProfileRepository(makeProfile()),
      invoiceRepo as unknown as InvoiceRepository,
      transactionManager,
    );
  });

  it('O2F2-B -- con idempotencyKey, pide el advisory lock antes de aplicar; sin ella, no pide ningún lock', async () => {
    invoiceRepo.setOutstanding('inv-1', 250);

    await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 250, idempotencyKey: 'pay-1',
      allocations: [{ invoiceId: 'inv-1', amount: 250 }],
    });
    expect(transactionManager.rawQueries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(true);

    transactionManager.rawQueries = [];
    await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 250,
      allocations: [{ invoiceId: 'inv-2', amount: 250 }],
    });
    expect(transactionManager.rawQueries.some((q) => q.sql.includes('pg_advisory_xact_lock'))).toBe(false);
  });

  it('ejemplo del dueño: factura con saldo 250, allocation de 400 -- aplica 250, 150 queda sin asignar', async () => {
    invoiceRepo.setOutstanding('inv-1', 250);

    const result = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 400,
      allocations: [{ invoiceId: 'inv-1', amount: 400 }],
    });

    expect(result).toHaveLength(2);
    expect(financialRepo.created[0]).toMatchObject({ settledInvoiceId: 'inv-1', amount: 250 });
    expect(financialRepo.created[1]).toMatchObject({ settledInvoiceId: null, amount: 150 });
  });

  it('nunca aplica de más aunque la factura ya esté saldada (saldo 0)', async () => {
    invoiceRepo.setOutstanding('inv-1', 0);

    const result = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 300,
      allocations: [{ invoiceId: 'inv-1', amount: 300 }],
    });

    // amount=0 no genera fila propia (no documenta ningún movimiento real);
    // los 300 completos van a la fila sin asignar.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ settledInvoiceId: null, amount: 300 });
  });

  it('pago exacto al saldo vigente no deja excedente sin asignar', async () => {
    invoiceRepo.setOutstanding('inv-1', 250);

    const result = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 250,
      allocations: [{ invoiceId: 'inv-1', amount: 250 }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ settledInvoiceId: 'inv-1', amount: 250 });
  });

  it('consolida allocations duplicadas a la misma factura en una sola fila', async () => {
    const result = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 1210,
      allocations: [{ invoiceId: 'inv-1', amount: 600 }, { invoiceId: 'inv-1', amount: 610 }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ settledInvoiceId: 'inv-1', amount: 1210 });
  });

  it('reintento con la misma idempotencyKey no duplica filas, aunque el saldo haya cambiado entre medio', async () => {
    invoiceRepo.setOutstanding('inv-1', 250);

    const first = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 400, idempotencyKey: 'pay-1',
      allocations: [{ invoiceId: 'inv-1', amount: 400 }],
    });
    expect(financialRepo.created).toHaveLength(2);

    // Simula que, entre el primer intento (ya commiteado) y el reintento,
    // el saldo de la factura cambió -- no tiene que afectar el resultado
    // del reintento, que debe devolver las filas YA creadas, no recalcular.
    invoiceRepo.setOutstanding('inv-1', 0);

    const retry = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 400, idempotencyKey: 'pay-1',
      allocations: [{ invoiceId: 'inv-1', amount: 400 }],
    });

    expect(financialRepo.created).toHaveLength(2);
    expect(retry).toEqual(first);
  });

  it('cada factura se trunca de forma independiente en un pago multi-factura', async () => {
    invoiceRepo.setOutstanding('inv-1', 250);
    invoiceRepo.setOutstanding('inv-2', 1210);

    const result = await service.recordPayment({
      customerId: CUSTOMER_ID, businessId: BUSINESS_ID, amount: 1460,
      allocations: [{ invoiceId: 'inv-1', amount: 400 }, { invoiceId: 'inv-2', amount: 1060 }],
    });

    expect(result).toHaveLength(3);
    expect(financialRepo.created[0]).toMatchObject({ settledInvoiceId: 'inv-1', amount: 250 });
    expect(financialRepo.created[1]).toMatchObject({ settledInvoiceId: 'inv-2', amount: 1060 });
    expect(financialRepo.created[2]).toMatchObject({ settledInvoiceId: null, amount: 150 });
  });
});

// Paso 2(b), CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001 (14/09/2026)
// docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md §1.
//
// La exclusión real por status (PENDIENTE_FACTURAR/FACTURADO cuentan,
// COBRADO/REVERTIDO no) vive en el SQL de
// SqlFinancialTransactionRepository.getCityLedgerOutstandingByCustomerId()
// -- este fake no reimplementa esa lógica, solo devuelve el valor que el
// test configura. Verificar la exclusión real contra Postgres es un test
// de integración (ver src/tests/integration/), no de este archivo.
describe('CustomerAccountService.getStatement — cityLedgerOutstanding (paso 2b)', () => {
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

  it('cityLedgerOutstanding presente y con el monto vigente cuando hay una AR viva', async () => {
    financialRepo.setCityLedgerOutstanding(700);

    const statement = await service.getStatement(CUSTOMER_ID);

    expect(statement.cityLedgerOutstanding).toBe(700);
  });

  it('cityLedgerOutstanding en 0 cuando no hay ninguna transferencia a City Ledger', async () => {
    const statement = await service.getStatement(CUSTOMER_ID);

    expect(statement.cityLedgerOutstanding).toBe(0);
  });

  it('nunca se suma a balance -- son dos números independientes en el statement', async () => {
    financialRepo.setCityLedgerOutstanding(700);

    const statement = await service.getStatement(CUSTOMER_ID);

    expect(statement.balance).toBe(0); // InMemoryFinancialTransactionRepository.getNetBalanceByCustomerId() -- default 0
    expect(statement.cityLedgerOutstanding).toBe(700);
  });

  // A1 del gate de implementación (14/09/2026) -- guard explícito: un fake
  // que NO implementa el método opcional tiene que hacer fallar getStatement()
  // ruidosamente, nunca degradar en silencio a `undefined`.
  it('getStatement() lanza si el repo inyectado no implementa getCityLedgerOutstandingByCustomerId', async () => {
    const incompleteRepo = new InMemoryFinancialTransactionRepository() as FinancialTransactionRepository;
    // El método vive en el prototipo de la clase -- `delete` sobre la
    // instancia no lo saca (no es own property). Sobreescribir con
    // `undefined` sí simula el caso real de un fake que nunca lo implementó.
    (incompleteRepo as { getCityLedgerOutstandingByCustomerId?: unknown }).getCityLedgerOutstandingByCustomerId = undefined;

    const customers = new Map([[CUSTOMER_ID, new Customer(CUSTOMER_ID, 'Cliente Test', [], 'INDIVIDUAL')]]);
    const incompleteService = new CustomerAccountService(
      incompleteRepo,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new FakeBusinessProfileRepository(makeProfile()),
      new FakeInvoiceRepository(new Map()) as unknown as InvoiceRepository,
      new FakeTransactionManager(),
    );

    await expect(incompleteService.getStatement(CUSTOMER_ID)).rejects.toThrow(
      /getCityLedgerOutstandingByCustomerId no está implementado/,
    );
  });
});
