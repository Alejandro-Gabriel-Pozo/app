import { describe, it, expect, beforeEach } from 'vitest';
import {
  AccountsReceivableService,
  CompanyCustomerRequiredError,
  NoBalanceToTransferError,
  AccountReceivableNotFoundError,
  InvalidAccountsReceivableTransitionError,
  StayChargeAlreadyInvoicedError,
  ArReversalRequiresCreditNoteError,
  ArReversalMissingGuestLinkError,
  ArReversalMissingCompanyLinkError,
  ArReversalChargeNotSettledError,
} from './accounts-receivable.service.js';
import type { ReservationRepoForTransfer } from './accounts-receivable.service.js';
import { StayNotFoundError } from '../pms-estadias/stay.service.js';
import { CustomerNotFoundError, ReceivableInvoiceNotIssuedError, ReceivableInvoiceReconciliationPendingError } from '../domain/errors.js';
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
import type { InvoiceStatus } from '../facturacion/invoice.entities.js';
import type { Reservation } from '../reservas/Reservation.js';

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

  async getByIdWithLock(_client: SqlClient, id: string): Promise<AccountReceivable | undefined> {
    this.lockedIds.push(id);
    return this.rows.get(id);
  }

  /** Wave 12 (18/09/2026) -- guard-espejo de InvoiceService, no ejercitado por este archivo. */
  async getByFinancialTransactionIdWithLock(_client: SqlClient, financialTransactionId: string): Promise<AccountReceivable | undefined> {
    return [...this.rows.values()].find((r) => r.financialTransactionId === financialTransactionId);
  }

  async markRevertedWithClient(
    _client: SqlClient,
    id: string,
    params: { reversedBy: string; reason: string },
  ): Promise<AccountReceivable | undefined> {
    const ar = this.rows.get(id);
    if (!ar || ar.status !== 'PENDIENTE_FACTURAR') return undefined;
    const updated: AccountReceivable = {
      ...ar,
      status: 'REVERTIDO',
      reversedBy: params.reversedBy,
      reversedAt: new Date(),
      reversedReason: params.reason,
    };
    this.rows.set(id, updated);
    return updated;
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
  /** Bloque 6, §9.1 -- cargos de la estadía que el guard nuevo consulta. */
  public stayCharges: FinancialTransaction[] = [];
  /**
   * Bloque 6, §9.1 -- orden real de operaciones, compartido con
   * `FakeReservationRepositoryForTransfer` cuando el test pasa el mismo
   * array a los dos fakes (ver guard §9.1 -- test de orden). Vacío para
   * el resto de los tests, que no lo leen.
   */
  constructor(private readonly ops: string[] = []) {}

  async create(tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    return this.createWithClient({ async query() { return { rows: [], rowCount: 0 }; } }, tx);
  }

  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction | null> {
    this.ops.push('created-financial-transaction');
    this.created.push(tx);
    return { ...tx, createdAt: new Date() };
  }

  /** Bloque 3c-ii -- transacciones "reales" que reverseTransfer() puede lockear/leer por id. */
  public byId = new Map<string, FinancialTransaction>();
  async getById(id: string): Promise<FinancialTransaction | null> {
    return this.byId.get(id) ?? null;
  }
  async getByIdWithLock(_client: SqlClient, id: string): Promise<FinancialTransaction | undefined> {
    this.ops.push('lock-financial-transaction');
    return this.byId.get(id);
  }
  async getByIdempotencyKey(): Promise<FinancialTransaction | undefined> { return undefined; }
  async getByReservationId(): Promise<FinancialTransaction[]> { return []; }
  async getByOrderId(): Promise<FinancialTransaction[]> { return []; }
  async getByCustomerId(): Promise<FinancialTransaction[]> { return []; }
  async getByStayId(): Promise<FinancialTransaction[]> { this.ops.push('read-stay-charges'); return this.stayCharges; }
  async settleByReservationId(): Promise<number> { return 0; }
  async voidByReservationId() { return { tipo: 'NADA_QUE_HACER' as const }; }
  // O2 (03/09/2026) -- este doble no ejercita los efectos de orden.
  async settleChargesByOrderId() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async createOrderChargeIfConfirmed() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async voidByOrderId() { return { tipo: 'NADA_QUE_HACER' } as const; }
  async getNetBalanceByCustomerId(): Promise<number> { return 0; }
  async getNetBalanceByStayId(): Promise<number> { this.ops.push('read-net-balance'); return this.netBalanceByStay; }
  async getSettledPaymentTotalForReservation(): Promise<number> { return 0; }
  async getCollectedPaymentTotalForReservation(): Promise<number> { return 0; }
  async getByShiftId(): Promise<FinancialTransaction[]> { return []; }
  /** CITY-LEDGER-OVERTRANSFER-PAYMENT-001 (13/09/2026) -- red de seguridad (c), test de orden más abajo. */
  public linkStayToReservationChargesCalls: [string, string][] = [];
  async linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number> {
    this.ops.push('link-stay-charges');
    this.linkStayToReservationChargesCalls.push([stayId, reservationId]);
    return 0;
  }
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

/** Bloque 6, §9.1 -- fake mínimo, solo `getByIdWithLock()` (lock de la
 * reserva de origen de la estadía, primera operación del guard). */
class FakeReservationRepositoryForTransfer implements ReservationRepoForTransfer {
  lockCalls: string[] = [];
  /** Ver `FakeFinancialTransactionRepository.ops` -- mismo array compartido. */
  constructor(private readonly ops: string[] = []) {}
  async getByIdWithLock(_client: SqlClient, id: string) {
    this.ops.push('lock-reservation');
    this.lockCalls.push(id);
    return { id } as unknown as Reservation;
  }
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
class FakeInvoiceRepository implements Pick<
  InvoiceRepository,
  'getOutstandingForUpdate' | 'resolveInvoiceLinkage' | 'getAllLinkedInvoicesWithClient' | 'classifyReservationLiveInvoice' | 'classifyOrderLiveInvoice'
> {
  public invoiceIdByFinancialTransactionId = new Map<string, string>();
  public outstandingByInvoiceId = new Map<string, number>();
  /** AR-FACT-NO-ISSUED-01 -- configura el caso NOT_ISSUED por ftId. */
  public notIssuedByFinancialTransactionId = new Map<string, { invoiceId: string; status: 'PENDING' | 'REJECTED' | 'FAILED_UNCERTAIN'; afipContacted: boolean }>();
  /** Bloque 6, §9.1 -- clasificación por reservationId/orderId. Default 'RECONCILED' (no bloquea) para no romper los tests que no ejercitan el guard nuevo. */
  public reservationClassification = new Map<string, 'RECONCILED' | 'NOT_RECONCILED'>();
  public orderClassification = new Map<string, 'RECONCILED' | 'NOT_RECONCILED'>();
  /** Bloque 6, §9.1 (condición C1 del gate) -- cuántas veces se llamó a
   * cualquiera de los dos `classify*LiveInvoice()`. Prueba que el guard
   * NO los llama cuando el pre-filtro `resolveInvoiceLinkage()` ya
   * descartó el cargo (si no hay ningún ISSUED, el loop nunca debería
   * pedir la clasificación). */
  public classifyCalls = 0;
  /** Bloque 1 (23/09/2026) -- override explícito para los tests del guard
   * 8-bis fila-por-fila que necesitan MÁS de una fila no-ISSUED para el
   * mismo ftId (`invoiceIdByFinancialTransactionId`/
   * `notIssuedByFinancialTransactionId` solo modelan una cada uno). Si
   * está seteado para un ftId, `getAllLinkedInvoicesWithClient()` lo usa
   * tal cual y NO deriva de los otros dos mapas para ese ftId. */
  public linkedInvoicesOverride = new Map<string, Array<{ id: string; status: InvoiceStatus; afipContacted: boolean }>>();

  async resolveInvoiceLinkage(financialTransactionId: string): Promise<InvoiceLinkage> {
    const issuedId = this.invoiceIdByFinancialTransactionId.get(financialTransactionId);
    if (issuedId) return { kind: 'ISSUED', invoiceId: issuedId };
    const notIssued = this.notIssuedByFinancialTransactionId.get(financialTransactionId);
    if (notIssued) return { kind: 'NOT_ISSUED', ...notIssued };
    return { kind: 'NONE' };
  }

  /**
   * Bloque 1 (23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md
   * §3.1) -- espeja resolveInvoiceLinkage() de arriba, pero devuelve las
   * DOS filas posibles (una de `invoiceIdByFinancialTransactionId`, una de
   * `notIssuedByFinancialTransactionId`) en vez de elegir una sola --
   * los tests existentes solo configuran una de las dos por ftId, así
   * que esto es compatible con ellos sin cambios; los tests dedicados al
   * guard 8-bis fila-por-fila configuran ambas para el mismo ftId.
   */
  async getAllLinkedInvoicesWithClient(
    _client: SqlClient,
    financialTransactionId: string,
  ): Promise<Array<{ id: string; status: InvoiceStatus; afipContacted: boolean }>> {
    const override = this.linkedInvoicesOverride.get(financialTransactionId);
    if (override) return override;
    const result: Array<{ id: string; status: InvoiceStatus; afipContacted: boolean }> = [];
    const issuedId = this.invoiceIdByFinancialTransactionId.get(financialTransactionId);
    if (issuedId) result.push({ id: issuedId, status: 'ISSUED', afipContacted: true });
    const notIssued = this.notIssuedByFinancialTransactionId.get(financialTransactionId);
    if (notIssued) result.push({ id: notIssued.invoiceId, status: notIssued.status, afipContacted: notIssued.afipContacted });
    return result;
  }

  async getOutstandingForUpdate(_client: SqlClient, invoiceId: string): Promise<number> {
    const outstanding = this.outstandingByInvoiceId.get(invoiceId);
    if (outstanding === undefined) {
      throw new Error(`FakeInvoiceRepository: outstanding no seteado para "${invoiceId}"`);
    }
    return outstanding;
  }

  async classifyReservationLiveInvoice(_client: SqlClient, reservationId: string): Promise<'RECONCILED' | 'NOT_RECONCILED'> {
    this.classifyCalls++;
    return this.reservationClassification.get(reservationId) ?? 'RECONCILED';
  }

  async classifyOrderLiveInvoice(_client: SqlClient, orderId: string): Promise<'RECONCILED' | 'NOT_RECONCILED'> {
    this.classifyCalls++;
    return this.orderClassification.get(orderId) ?? 'RECONCILED';
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
      new FakeReservationRepositoryForTransfer(),
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

    // CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001, paso 1 (13/09/2026)
    // -- la AR vincula las DOS patas: financialTransactionId (empresa, ya
    // existía) y guestPaymentTransactionId (huésped, nuevo). Los ids tienen
    // que coincidir con el PAYMENT/CHARGE reales creados arriba, no ser
    // cualquier string.
    expect(ar.financialTransactionId).toBe(financialRepo.created[1]!.id);
    expect(ar.guestPaymentTransactionId).toBe(financialRepo.created[0]!.id);
    expect(ar.guestPaymentTransactionId).not.toBe(ar.financialTransactionId);
  });

  // CITY-LEDGER-OVERTRANSFER-PAYMENT-001 (13/09/2026) -- (c), red de
  // seguridad: adopta cualquier PAYMENT/CHARGE huérfano de esta reserva
  // antes de leer el saldo a transferir.
  it('llama linkStayToReservationCharges(stay.id, stay.reservationId) antes de leer el saldo', async () => {
    financialRepo.netBalanceByStay = 15000;

    await service.transferStayBalanceToReceivable({
      stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
      companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
    });

    expect(financialRepo.linkStayToReservationChargesCalls).toEqual([[stay.id, stay.reservationId]]);
  });

  it('usa la moneda configurada en business_profile, no un valor fijo (auditoría de hardcodes, 17/08/2026)', async () => {
    service = new AccountsReceivableService(
      arRepo, financialRepo,
      new FakeStayRepository(stay) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
      new FakeBusinessProfileRepository(makeProfile({ currency: 'USD' })),
      invoiceRepo,
      new FakeReservationRepositoryForTransfer(),
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
      new FakeReservationRepositoryForTransfer(),
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

  // Bloque 6, §9.1 (13/09/2026, gate `architecture-governor`) -- guard
  // duro: no se puede transferir el saldo de una estadía con un cargo que
  // ya tiene una Factura B ISSUED vigente (no reconciliada por NC).
  describe('guard §9.1 -- Factura B previa sobre un CHARGE de la estadía', () => {
    beforeEach(() => {
      financialRepo.netBalanceByStay = 15000;
    });

    it('lockea la reserva de origen ANTES de leer los cargos y de crear nada (orden real -- condición C2 del gate, no solo que el lock haya ocurrido)', async () => {
      // Array compartido entre los dos fakes -- registra el ORDEN real de
      // las operaciones, no solo si cada una ocurrió. Mutante que esto
      // caza y el `lockCalls.toEqual(...)` de antes no cazaba: mover
      // `getByIdWithLock()` DESPUÉS del loop del guard (condición C2 del
      // gate `architecture-governor`, 13/09/2026).
      const ops: string[] = [];
      const reservationRepo = new FakeReservationRepositoryForTransfer(ops);
      const orderedFinancialRepo = new FakeFinancialTransactionRepository(ops);
      orderedFinancialRepo.netBalanceByStay = 15000;

      service = new AccountsReceivableService(
        arRepo, orderedFinancialRepo,
        new FakeStayRepository(stay) as unknown as StayRepository,
        new FakeCustomerRepository(customers) as unknown as CustomerRepository,
        new InMemoryTransactionManager(),
        new FakeBusinessProfileRepository(makeProfile()),
        invoiceRepo,
        reservationRepo,
      );

      await service.transferStayBalanceToReceivable({
        stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
        companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
      });

      expect(reservationRepo.lockCalls).toEqual([stay.reservationId]);
      // CITY-LEDGER-OVERTRANSFER-PAYMENT-001 (13/09/2026) -- (c) corre
      // ANTES de leer el saldo, y el saldo se lee ANTES de la transacción
      // (fuera de ella a propósito, ver el comentario en el service) --
      // los dos primeros ops ahora son de ese bloque nuevo, el lock sigue
      // siendo lo primero DENTRO de la transacción.
      expect(ops[0]).toBe('link-stay-charges');
      expect(ops[1]).toBe('read-net-balance');
      expect(ops[2]).toBe('lock-reservation');
      expect(ops[3]).toBe('read-stay-charges');
      expect(ops.slice(4)).toEqual(['created-financial-transaction', 'created-financial-transaction']);
    });

    it('sin ninguna Factura B ISSUED sobre los cargos -- procede sin consultar classify* (condición C1 del gate)', async () => {
      financialRepo.stayCharges = [
        { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
      ];
      // invoiceRepo.invoiceIdByFinancialTransactionId vacío -> resolveInvoiceLinkage da NONE.
      // Trampa deliberada (condición C1 del gate `architecture-governor`,
      // 13/09/2026): si el pre-filtro de `resolveInvoiceLinkage()` se
      // borrara y el guard llamara a `classify*` directo, ESTA
      // clasificación lo haría fallar -- sin el pre-filtro, el mutante ya
      // no pasa este test (antes sobrevivía: el fake devolvía 'RECONCILED'
      // por default y el guard nunca se ejercitaba de verdad).
      invoiceRepo.reservationClassification.set(stay.reservationId, 'NOT_RECONCILED');

      const ar = await service.transferStayBalanceToReceivable({
        stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
        companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
      });

      expect(ar.status).toBe('PENDIENTE_FACTURAR');
      expect(invoiceRepo.classifyCalls).toBe(0);
    });

    it('Factura B ISSUED NO reconciliada (NOT_RECONCILED) -- StayChargeAlreadyInvoicedError, no crea nada', async () => {
      financialRepo.stayCharges = [
        { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
      ];
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge-1', 'inv-1');
      invoiceRepo.reservationClassification.set(stay.reservationId, 'NOT_RECONCILED');

      await expect(service.transferStayBalanceToReceivable({
        stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
        companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
      })).rejects.toThrow(StayChargeAlreadyInvoicedError);

      expect(financialRepo.created).toHaveLength(0);
      expect(arRepo.created).toHaveLength(0);
    });

    it('Factura B ISSUED reconciliada al 100% por NC (RECONCILED) -- procede igual', async () => {
      financialRepo.stayCharges = [
        { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
      ];
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge-1', 'inv-1');
      invoiceRepo.reservationClassification.set(stay.reservationId, 'RECONCILED');

      const ar = await service.transferStayBalanceToReceivable({
        stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
        companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
      });

      expect(ar.status).toBe('PENDIENTE_FACTURAR');
    });

    it('cargo cargado a una ORDEN (orderId, sin reservationId) con Factura B viva NO reconciliada -- también bloquea', async () => {
      financialRepo.stayCharges = [
        { id: 'ft-charge-order-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, orderId: 'order-1', stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
      ];
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge-order-1', 'inv-2');
      invoiceRepo.orderClassification.set('order-1', 'NOT_RECONCILED');

      await expect(service.transferStayBalanceToReceivable({
        stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
        companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
      })).rejects.toThrow(StayChargeAlreadyInvoicedError);
    });

    it('cargo SOLO-ESTADÍA (sin reservationId ni orderId) con Factura B viva -- fail-closed, bloquea (no se puede verificar reconciliación)', async () => {
      financialRepo.stayCharges = [
        { id: 'ft-charge-standalone', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
      ];
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge-standalone', 'inv-3');
      // Ni reservationClassification ni orderClassification tienen entrada
      // para este cargo -- no hay reservationId/orderId contra qué consultar.

      await expect(service.transferStayBalanceToReceivable({
        stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
        companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
      })).rejects.toThrow(StayChargeAlreadyInvoicedError);
    });

    // CITY-LEDGER-GUARD-INVOICE-INFLIGHT-001 (13/09/2026, gate
    // `architecture-governor`, decisión del dueño vía `AskUserQuestion`):
    // el guard también bloquea sobre un comprobante EN VUELO (todavía sin
    // confirmar con AFIP) -- mismo predicado que el guard hermano
    // `ReservationService.findBlockingInvoiceLinkage()`. Sin `classify*`
    // para esta rama (no hay nada que reconciliar sobre algo que ni
    // siquiera se sabe si se emitió).
    describe('extensión -- comprobante EN VUELO (NOT_ISSUED PENDING / FAILED_UNCERTAIN+afipContacted)', () => {
      it('NOT_ISSUED PENDING -- bloquea sin consultar classify*', async () => {
        financialRepo.stayCharges = [
          { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
        ];
        invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge-1', { invoiceId: 'inv-pending', status: 'PENDING', afipContacted: false });

        await expect(service.transferStayBalanceToReceivable({
          stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
          companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
        })).rejects.toThrow(StayChargeAlreadyInvoicedError);

        expect(financialRepo.created).toHaveLength(0);
        expect(arRepo.created).toHaveLength(0);
        // Mutante que esto caza: si alguien agrega una llamada a
        // classify*LiveInvoice() en la rama nueva (no debería -- no hay
        // nada que reconciliar sobre un comprobante que ni siquiera se
        // sabe si AFIP emitió), este assert lo atrapa.
        expect(invoiceRepo.classifyCalls).toBe(0);
      });

      it('NOT_ISSUED FAILED_UNCERTAIN + afipContacted:true -- bloquea (no se sabe con certeza si se emitió)', async () => {
        financialRepo.stayCharges = [
          { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
        ];
        invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge-1', { invoiceId: 'inv-uncertain', status: 'FAILED_UNCERTAIN', afipContacted: true });

        const err = await service.transferStayBalanceToReceivable({
          stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
          companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
        }).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(StayChargeAlreadyInvoicedError);
        expect((err as Error).message).toContain('FAILED_UNCERTAIN');
        expect(invoiceRepo.classifyCalls).toBe(0);
      });

      it('NOT_ISSUED FAILED_UNCERTAIN sin contactar AFIP (afipContacted:false) -- NO bloquea, procede', async () => {
        financialRepo.stayCharges = [
          { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
        ];
        invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge-1', { invoiceId: 'inv-x', status: 'FAILED_UNCERTAIN', afipContacted: false });

        const ar = await service.transferStayBalanceToReceivable({
          stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
          companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
        });

        expect(ar.status).toBe('PENDIENTE_FACTURAR');
      });

      it('NOT_ISSUED REJECTED -- NO bloquea (AFIP ya dijo que no), procede', async () => {
        financialRepo.stayCharges = [
          { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
        ];
        invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge-1', { invoiceId: 'inv-x', status: 'REJECTED', afipContacted: true });

        const ar = await service.transferStayBalanceToReceivable({
          stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
          companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
        });

        expect(ar.status).toBe('PENDIENTE_FACTURAR');
      });

      it('el mensaje del caso ISSUED conserva el texto verbatim ya shippeado (no se degradó al genérico)', async () => {
        financialRepo.stayCharges = [
          { id: 'ft-charge-1', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 15000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
        ];
        invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge-1', 'inv-1');
        invoiceRepo.reservationClassification.set(stay.reservationId, 'NOT_RECONCILED');

        const err = await service.transferStayBalanceToReceivable({
          stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
          companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
        }).catch((e: unknown) => e);

        expect((err as Error).message).toContain('emitida y vigente (no compensada del todo por Nota de Crédito)');
      });

      it('dos cargos -- el primero limpio (NONE) y el segundo EN VUELO -- bloquea igual (el continue no corta el loop antes de tiempo)', async () => {
        financialRepo.stayCharges = [
          { id: 'ft-charge-clean', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 7000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
          { id: 'ft-charge-pending', businessId: TEST_BUSINESS_ID, customerId: TEST_GUEST_ID, reservationId: stay.reservationId, stayId: TEST_STAY_ID, type: 'CHARGE', amount: 8000, currency: 'ARS', status: 'SETTLED' } as FinancialTransaction,
        ];
        // ft-charge-clean: sin entrada en ningún mapa -> resolveInvoiceLinkage da NONE.
        invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge-pending', { invoiceId: 'inv-pending', status: 'PENDING', afipContacted: false });

        await expect(service.transferStayBalanceToReceivable({
          stayId: TEST_STAY_ID, businessId: TEST_BUSINESS_ID,
          companyCustomerId: TEST_COMPANY_ID, transferredBy: 'user-manager',
        })).rejects.toThrow(StayChargeAlreadyInvoicedError);

        expect(financialRepo.created).toHaveLength(0);
        expect(arRepo.created).toHaveLength(0);
      });
    });
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
      new FakeReservationRepositoryForTransfer(),
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

    it('sin financialTransactionId (§5.1(b), facturación manual permanente) -- pasa sin bloquear, no hay ninguna factura interna que verificar', async () => {
      seed();
      const updated = await service.markInvoiced('ar-1', '0001-00001234');
      expect(updated.status).toBe('FACTURADO');
    });

    it('AR-FACT-NO-ISSUED-01 -- factura interna PENDING (no ISSUED): rechaza con ReceivableInvoiceNotIssuedError, espeja el guard del camino automático', async () => {
      seed({ financialTransactionId: 'ft-1' });
      invoiceRepo.notIssuedByFinancialTransactionId.set('ft-1', { invoiceId: 'inv-1', status: 'PENDING', afipContacted: false });

      await expect(service.markInvoiced('ar-1')).rejects.toThrow(ReceivableInvoiceNotIssuedError);
    });

    it('AR-FACT-NO-ISSUED-01 -- FAILED_UNCERTAIN con AFIP contactada: rechaza con ReceivableInvoiceReconciliationPendingError', async () => {
      seed({ financialTransactionId: 'ft-1' });
      invoiceRepo.notIssuedByFinancialTransactionId.set('ft-1', { invoiceId: 'inv-1', status: 'FAILED_UNCERTAIN', afipContacted: true });

      await expect(service.markInvoiced('ar-1')).rejects.toThrow(ReceivableInvoiceReconciliationPendingError);
    });

    it('con factura interna ISSUED: pasa sin bloquear', async () => {
      seed({ financialTransactionId: 'ft-1' });
      invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-1', 'inv-1');

      const updated = await service.markInvoiced('ar-1');
      expect(updated.status).toBe('FACTURADO');
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

    it('AR-FACT-NO-ISSUED-01 -- factura interna PENDING (no ISSUED): rechaza con ReceivableInvoiceNotIssuedError, no cae al fallback', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1' });
      invoiceRepo.notIssuedByFinancialTransactionId.set('ft-1', { invoiceId: 'inv-1', status: 'PENDING', afipContacted: false });

      await expect(service.markCollected('ar-1')).rejects.toThrow(ReceivableInvoiceNotIssuedError);
      expect(financialRepo.created).toHaveLength(0);
    });

    it('AR-FACT-NO-ISSUED-01 -- FAILED_UNCERTAIN con AFIP contactada: rechaza con ReceivableInvoiceReconciliationPendingError (código distinto, no reintentable a ciegas)', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1' });
      invoiceRepo.notIssuedByFinancialTransactionId.set('ft-1', { invoiceId: 'inv-1', status: 'FAILED_UNCERTAIN', afipContacted: true });

      await expect(service.markCollected('ar-1')).rejects.toThrow(ReceivableInvoiceReconciliationPendingError);
      expect(financialRepo.created).toHaveLength(0);
    });

    it('AR-FACT-NO-ISSUED-01 -- FAILED_UNCERTAIN SIN contactar AFIP: se sabe con certeza que no se emitió nada, rechaza con el código reintentable (no el de reconciliación)', async () => {
      seed({ status: 'FACTURADO', financialTransactionId: 'ft-1' });
      invoiceRepo.notIssuedByFinancialTransactionId.set('ft-1', { invoiceId: 'inv-1', status: 'FAILED_UNCERTAIN', afipContacted: false });

      await expect(service.markCollected('ar-1')).rejects.toThrow(ReceivableInvoiceNotIssuedError);
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

describe('AccountsReceivableService.reverseTransfer (Bloque 3c-ii, 14/09/2026, docs/diseno-reconciliacion-city-ledger-2026-09-12.md §4.3)', () => {
  let arRepo: FakeAccountsReceivableRepository;
  let financialRepo: FakeFinancialTransactionRepository;
  let invoiceRepo: FakeInvoiceRepository;
  let stay: Stay;
  let service: AccountsReceivableService;

  function seedAr(overrides: Partial<AccountReceivable> = {}): AccountReceivable {
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
      financialTransactionId: 'ft-charge',
      guestPaymentTransactionId: 'ft-payment',
      ...overrides,
    };
    arRepo.rows.set(ar.id, ar);
    return ar;
  }

  function seedCharge(overrides: Partial<FinancialTransaction> = {}): FinancialTransaction {
    const charge: FinancialTransaction = {
      id: 'ft-charge',
      businessId: TEST_BUSINESS_ID,
      customerId: TEST_COMPANY_ID,
      reservationId: 'res-1',
      stayId: null,
      type: 'CHARGE',
      amount: 15000,
      currency: 'ARS',
      status: 'SETTLED',
      createdAt: new Date(),
      ...overrides,
    };
    financialRepo.byId.set(charge.id, charge);
    return charge;
  }

  function seedGuestPayment(overrides: Partial<FinancialTransaction> = {}): FinancialTransaction {
    const payment: FinancialTransaction = {
      id: 'ft-payment',
      businessId: TEST_BUSINESS_ID,
      customerId: TEST_GUEST_ID,
      stayId: TEST_STAY_ID,
      type: 'PAYMENT',
      amount: 15000,
      currency: 'ARS',
      status: 'SETTLED',
      createdAt: new Date(),
      ...overrides,
    };
    financialRepo.byId.set(payment.id, payment);
    return payment;
  }

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
    const customers = new Map([
      [TEST_COMPANY_ID, new Customer(TEST_COMPANY_ID, 'Empresa SA', [], 'COMPANY')],
      [TEST_GUEST_ID, new Customer(TEST_GUEST_ID, 'Huésped Individual', [], 'INDIVIDUAL')],
    ]);
    service = new AccountsReceivableService(
      arRepo, financialRepo,
      new FakeStayRepository(stay) as unknown as StayRepository,
      new FakeCustomerRepository(customers) as unknown as CustomerRepository,
      new InMemoryTransactionManager(),
      new FakeBusinessProfileRepository(makeProfile()),
      invoiceRepo,
      new FakeReservationRepositoryForTransfer(),
    );
  });

  it('AR ya FACTURADO -- rechaza con ArReversalRequiresCreditNoteError, redirige al circuito de NC (§3.2)', async () => {
    seedAr({ status: 'FACTURADO' });
    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
  });

  it('AR ya COBRADO -- rechaza con ArReversalRequiresCreditNoteError', async () => {
    seedAr({ status: 'COBRADO' });
    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
  });

  it('AR ya REVERTIDO -- idempotente, devuelve el estado actual sin re-ejecutar (mismo criterio que markCollected() sobre COBRADO)', async () => {
    seedAr({ status: 'REVERTIDO' });
    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });
    expect(result.reverted.status).toBe('REVERTIDO');
    expect(result.replacement).toBeNull();
    expect(financialRepo.created).toHaveLength(0);
  });

  it('sin guestPaymentTransactionId (AR anterior a 8f11d19) -- falla fuerte, no reversa parcial (R15)', async () => {
    seedAr({ guestPaymentTransactionId: null });
    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalMissingGuestLinkError);
  });

  it('sin financialTransactionId -- falla fuerte, precondición simétrica', async () => {
    seedAr({ financialTransactionId: null });
    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalMissingCompanyLinkError);
  });

  it('CHARGE original no SETTLED -- rechaza con ArReversalChargeNotSettledError', async () => {
    seedAr();
    seedCharge({ status: 'PENDING' });
    seedGuestPayment();
    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalChargeNotSettledError);
  });

  it('guard 8-bis -- CHARGE con factura ISSUED sin reconciliar, rechaza y no escribe nada', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge', 'inv-1');
    invoiceRepo.reservationClassification.set('res-1', 'NOT_RECONCILED');

    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
    expect(financialRepo.created).toHaveLength(0);
  });

  it('guard 8-bis -- CHARGE con factura ISSUED RECONCILIADA, NO bloquea (condición C1(a) de la ronda de pre-commit del bloque 1 -- caso "sola" que faltaba)', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge', 'inv-1');
    invoiceRepo.reservationClassification.set('res-1', 'RECONCILED');

    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });
    expect(result.reverted.status).toBe('REVERTIDO');
    expect(invoiceRepo.classifyCalls).toBe(1);
  });

  it('guard 8-bis -- CHARGE con factura EN VUELO (NOT_ISSUED, PENDING), rechaza', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge', { invoiceId: 'inv-1', status: 'PENDING', afipContacted: false });

    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
  });

  it('guard 8-bis -- CHARGE con factura FAILED_UNCERTAIN CON afipContacted, bloquea (condición C1(b) -- caso "sola" que faltaba específicamente para reverseTransfer(), ya cubierto para transferStayBalanceToReceivable() pero no acá)', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge', { invoiceId: 'inv-1', status: 'FAILED_UNCERTAIN', afipContacted: true });

    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
    expect(financialRepo.created).toHaveLength(0);
  });

  it('guard 8-bis -- CHARGE con factura FAILED_UNCERTAIN sin afipContacted, NO bloquea (se sabe que no se emitió -- AFIP nunca llegó a contactarse)', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge', { invoiceId: 'inv-1', status: 'FAILED_UNCERTAIN', afipContacted: false });

    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });
    expect(result.reverted.status).toBe('REVERTIDO');
  });

  it('guard 8-bis -- CHARGE con factura REJECTED, NO bloquea (AFIP confirmó que no existe)', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.notIssuedByFinancialTransactionId.set('ft-charge', { invoiceId: 'inv-1', status: 'REJECTED', afipContacted: true });

    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });
    expect(result.reverted.status).toBe('REVERTIDO');
  });

  it('guard 8-bis -- CHARGE con reservationId NULL y factura ISSUED (precisión de la ronda 3 del gate): bloquea NOT_RECONCILED sin llamar a classify*', async () => {
    seedAr();
    seedCharge({ reservationId: null });
    seedGuestPayment();
    invoiceRepo.invoiceIdByFinancialTransactionId.set('ft-charge', 'inv-1');

    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
    expect(invoiceRepo.classifyCalls).toBe(0);
  });

  it('guard 8-bis, bloque 1 (23/09/2026) -- DOS facturas ligadas al mismo cargo (consolidada REJECTED + individual PENDING): bloquea por la PENDING aunque resolveInvoiceLinkage() elegiría la REJECTED', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    // Antes del bloque 1, el guard solo veía UNA fila (la que resolveInvoiceLinkage()
    // elige) -- acá simulamos el caso real que se perdía: el cargo tiene
    // DOS facturas ligadas, una que no bloquea y otra que sí.
    invoiceRepo.linkedInvoicesOverride.set('ft-charge', [
      { id: 'inv-consolidada-rejected', status: 'REJECTED', afipContacted: true },
      { id: 'inv-individual-pending', status: 'PENDING', afipContacted: false },
    ]);

    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
    expect(financialRepo.created).toHaveLength(0);
  });

  it('guard 8-bis, bloque 1, condición C1(c) -- mismo caso que arriba, con el ORDEN del array invertido (PENDING primero, REJECTED después): sigue bloqueando, prueba que el guard no mira solo la última fila', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.linkedInvoicesOverride.set('ft-charge', [
      { id: 'inv-individual-pending', status: 'PENDING', afipContacted: false },
      { id: 'inv-consolidada-rejected', status: 'REJECTED', afipContacted: true },
    ]);

    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
    expect(financialRepo.created).toHaveLength(0);
  });

  it('guard 8-bis, condición C1(d) -- DOS facturas REJECTED sobre el mismo cargo: ninguna bloquea, procede', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.linkedInvoicesOverride.set('ft-charge', [
      { id: 'inv-rejected-1', status: 'REJECTED', afipContacted: true },
      { id: 'inv-rejected-2', status: 'REJECTED', afipContacted: false },
    ]);

    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });
    expect(result.reverted.status).toBe('REVERTIDO');
  });

  it('guard 8-bis, condición C1(e) -- FAILED_UNCERTAIN sin contactar + REJECTED sobre el mismo cargo: ninguna bloquea, procede', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.linkedInvoicesOverride.set('ft-charge', [
      { id: 'inv-failed-uncertain', status: 'FAILED_UNCERTAIN', afipContacted: false },
      { id: 'inv-rejected', status: 'REJECTED', afipContacted: true },
    ]);

    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });
    expect(result.reverted.status).toBe('REVERTIDO');
  });

  it('guard 8-bis, bloque 1 -- ISSUED reconciliada + REJECTED sobre el mismo cargo: NO bloquea (la ISSUED está cubierta por NC, la REJECTED nunca bloquea)', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.reservationClassification.set('res-1', 'RECONCILED');
    invoiceRepo.linkedInvoicesOverride.set('ft-charge', [
      { id: 'inv-issued-reconciliada', status: 'ISSUED', afipContacted: true },
      { id: 'inv-rejected', status: 'REJECTED', afipContacted: true },
    ]);

    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });
    expect(result.reverted.status).toBe('REVERTIDO');
    // Condición C1(g) -- classifyReservationLiveInvoice() se llama UNA
    // sola vez por lote, no una vez por fila ISSUED (acá solo hay una
    // fila ISSUED, pero confirma que el guard no la llama de más).
    expect(invoiceRepo.classifyCalls).toBe(1);
  });

  it('guard 8-bis, bloque 1 -- ISSUED reconciliada + PENDING sobre el mismo cargo: bloquea igual por la PENDING (la reconciliación de la ISSUED no excusa a las demás filas)', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();
    invoiceRepo.reservationClassification.set('res-1', 'RECONCILED');
    invoiceRepo.linkedInvoicesOverride.set('ft-charge', [
      { id: 'inv-issued-reconciliada', status: 'ISSUED', afipContacted: true },
      { id: 'inv-pending', status: 'PENDING', afipContacted: false },
    ]);

    await expect(
      service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(ArReversalRequiresCreditNoteError);
    expect(invoiceRepo.classifyCalls).toBe(1);
    expect(financialRepo.created).toHaveLength(0);
  });

  it('camino feliz -- crea las 2 ADJUSTMENT compensatorias (Finding 1: reservationId pineado en la pata empresa) y marca la AR REVERTIDO', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();

    const result = await service.reverseTransfer({
      accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'reserva se canceló después de la transferencia',
    });

    expect(financialRepo.created).toHaveLength(2);
    // Pata EMPRESA -- Finding 1 (gate, ronda 3): reservationId del CHARGE, no null.
    expect(financialRepo.created[0]).toMatchObject({
      customerId: TEST_COMPANY_ID,
      reservationId: 'res-1',
      type: 'ADJUSTMENT',
      amount: -15000,
      status: 'SETTLED',
      reversedInvoiceId: null,
      reversedTransactionId: 'ft-charge',
    });
    // Pata HUÉSPED -- reabre el folio, reservationId null a propósito.
    expect(financialRepo.created[1]).toMatchObject({
      customerId: TEST_GUEST_ID,
      reservationId: null,
      stayId: TEST_STAY_ID,
      type: 'ADJUSTMENT',
      amount: 15000,
      status: 'SETTLED',
      reversedInvoiceId: null,
      reversedTransactionId: 'ft-payment',
    });

    expect(result.reverted.status).toBe('REVERTIDO');
    expect(result.reverted.reversedBy).toBe('user-manager');
    expect(result.reverted.reversedReason).toBe('reserva se canceló después de la transferencia');
    expect(result.replacement).toBeNull();
  });

  it('Finding C (gate, ronda 5) -- el ADJUSTMENT de la pata empresa hereda el stayId REAL del CHARGE bajo lock, no queda en null fijo (mitigación LOCAL, no invariante -- ver CITY-LEDGER-AR-STAY-ADOPTION-RACE-001)', async () => {
    seedAr();
    seedCharge({ stayId: 'otro-stay-ya-adoptado' });
    seedGuestPayment();

    await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });

    expect(financialRepo.created[0]).toMatchObject({
      customerId: TEST_COMPANY_ID,
      stayId: 'otro-stay-ya-adoptado',
    });
  });

  it('correctedBalance > 0 -- crea una AR de reemplazo con replacesArId, vía postStayTransfer (§4.3 paso 8/13)', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();

    const result = await service.reverseTransfer({
      accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'monto corregido', correctedBalance: 9000,
    });

    expect(result.replacement).not.toBeNull();
    expect(result.replacement!.amount).toBe(9000);
    expect(result.replacement!.replacesArId).toBe('ar-1');
    expect(result.replacement!.status).toBe('PENDIENTE_FACTURAR');
    // 2 ADJUSTMENT de la reversa + PAYMENT + CHARGE del postStayTransfer nuevo.
    expect(financialRepo.created).toHaveLength(4);
  });

  it('correctedBalance omitido -- reversa pura, sin AR nueva', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();

    const result = await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });

    expect(result.replacement).toBeNull();
    expect(arRepo.created).toHaveLength(0);
  });

  it('rechaza si el id no existe', async () => {
    await expect(
      service.reverseTransfer({ accountReceivableId: 'no-existe', reversedBy: 'user-manager', reason: 'motivo' }),
    ).rejects.toThrow(AccountReceivableNotFoundError);
  });

  it('lockea la AR (O2F2-A) -- ver código para el orden real, este fake no graba orden cruzada entre repos', async () => {
    seedAr();
    seedCharge();
    seedGuestPayment();

    await service.reverseTransfer({ accountReceivableId: 'ar-1', reversedBy: 'user-manager', reason: 'motivo' });

    // Solo prueba QUE se lockea la fila correcta -- el orden real
    // (AR antes que CHARGE) está en el código (`getByIdWithLock` de la AR
    // es la primera operación dentro de `transactionManager.run()`), no
    // en este fake: `FakeAccountsReceivableRepository` y
    // `FakeFinancialTransactionRepository` no comparten un array de
    // operaciones acá (a diferencia de otros fakes de este archivo que sí
    // lo hacen, ver `FakeReservationRepositoryForTransfer`/`ops`), así que
    // esta aserción no puede distinguir "lockeó primero" de "lockeó en
    // algún momento".
    expect(arRepo.lockedIds).toEqual(['ar-1']);
  });
});
