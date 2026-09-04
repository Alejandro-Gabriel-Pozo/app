import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Arca } from '@arcasdk/core';
import { InvoiceService, hashIds } from './invoice.service.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput, InvoiceLinkage } from './invoice.repository.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus, InvoiceItem, CreateInvoiceItemInput } from './invoice.entities.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from './afip-credentials.repository.js';
import type { FinancialTransactionRepository, FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../clientes-finanzas/accounts-receivable.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import type { IOrderRepository } from '../pos-menu/order.repository.js';
import type { Order } from '../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../pos-menu/product.repository.js';
import type { Product, ProductVariant } from '../pos-menu/product.entities.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { AfipNotConfiguredError, FinancialTransactionNotFoundError, AfipRequestRejectedError, AfipRequestUncertainError, UnsupportedIvaRateError, InvoiceNotReversibleError, NothingToInvoiceError, AccountsReceivableAlreadyInvoicedError } from '../domain/errors.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPO_NOTA_CREDITO_B } from './afip-catalog.constants.js';
import { buildArcaBillingAdapter } from './arca-sdk-billing.adapter.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeInvoiceRepository implements InvoiceRepository {
  public invoices = new Map<string, Invoice>();
  public items = new Map<string, InvoiceItem[]>();
  /** C1-Fase C -- financial_transaction_id -> invoice_id, para getInvoicedFinancialTransactionIds. */
  public charges = new Map<string, string>();

  async getById(id: string) { return this.invoices.get(id) ?? null; }
  async getByIdempotencyKey(key: string) {
    return [...this.invoices.values()].find((i) => i.idempotencyKey === key) ?? null;
  }
  async getByFinancialTransactionId(ftId: string) {
    return [...this.invoices.values()].filter((i) => i.financialTransactionId === ftId);
  }
  async getInvoicedFinancialTransactionIds(ids: string[]): Promise<Set<string>> {
    const result = new Set<string>();
    for (const [ftId, invoiceId] of this.charges) {
      if (ids.includes(ftId) && this.invoices.get(invoiceId)?.status === 'ISSUED') result.add(ftId);
    }
    return result;
  }
  async getByReservationId(): Promise<Invoice[]> { return []; }
  async getOutstandingByCustomerId(): Promise<Array<Invoice & { outstanding: number }>> { return []; }
  async getOutstandingForUpdate(): Promise<number> { return 0; }
  // O2-F2 (03/09/2026)
  async getByCustomerId(customerId: string): Promise<Invoice[]> {
    return [...this.invoices.values()].filter((i) => i.customerId === customerId);
  }
  async resolveInvoiceLinkage(ftId: string): Promise<InvoiceLinkage> {
    const individual = [...this.invoices.values()].find((i) => i.financialTransactionId === ftId);
    const invoice = individual ?? (() => {
      const invoiceId = this.charges.get(ftId);
      return invoiceId ? this.invoices.get(invoiceId) : undefined;
    })();
    if (!invoice) return { kind: 'NONE' };
    if (invoice.status === 'ISSUED') return { kind: 'ISSUED', invoiceId: invoice.id };
    return { kind: 'NOT_ISSUED', invoiceId: invoice.id, status: invoice.status, afipContacted: invoice.afipContacted };
  }
  async create(input: CreateInvoiceInput, afipRequest: unknown, items: CreateInvoiceItemInput[]): Promise<Invoice> {
    return this.createWithClient({} as SqlClient, input, afipRequest, items);
  }
  async createWithClient(
    _client: SqlClient,
    input: CreateInvoiceInput,
    afipRequest: unknown,
    items: CreateInvoiceItemInput[],
    charges?: { financialTransactionId: string; amount: number }[],
  ): Promise<Invoice> {
    const invoice: Invoice = {
      ...input,
      cbteNro: null, cae: null, caeVto: null,
      status: 'PENDING', afipContacted: false, afipRequest, afipResponse: null, errorMessage: null,
      paymentMethod: input.paymentMethod ?? null, cardInstallments: input.cardInstallments ?? null,
      createdAt: new Date(), issuedAt: null,
    };
    this.invoices.set(invoice.id, invoice);
    this.items.set(invoice.id, items.map((item, i) => ({
      ...item, id: `ii-${invoice.id}-${i}`, invoiceId: invoice.id, createdAt: new Date(),
    })));
    for (const charge of charges ?? []) {
      this.charges.set(charge.financialTransactionId, invoice.id);
    }
    return invoice;
  }
  async getItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]> {
    return this.items.get(invoiceId) ?? [];
  }
  async markIssued(id: string, data: MarkIssuedInput): Promise<Invoice> {
    const existing = this.invoices.get(id)!;
    const updated: Invoice = {
      ...existing, cbteNro: data.cbteNro, cae: data.cae, caeVto: data.caeVto,
      afipResponse: data.afipResponse, status: 'ISSUED', issuedAt: new Date(),
    };
    this.invoices.set(id, updated);
    return updated;
  }
  async markFailed(id: string, data: MarkFailedInput): Promise<Invoice> {
    const existing = this.invoices.get(id)!;
    const updated: Invoice = {
      ...existing, status: data.status, errorMessage: data.errorMessage,
      afipResponse: data.afipResponse ?? existing.afipResponse,
      afipContacted: data.afipContacted,
    };
    this.invoices.set(id, updated);
    return updated;
  }
  async getStatus(id: string): Promise<InvoiceStatus | null> { return this.invoices.get(id)?.status ?? null; }
}

class FakeFinancialTransactionRepository implements FinancialTransactionRepository {
  constructor(private readonly tx: FinancialTransaction | null) {}
  async create() { return null; }
  async createWithClient() { return null; }
  async getById() { return this.tx; }
  async getByReservationId() { return []; }
  async getByOrderId() { return []; }
  async getByCustomerId() { return []; }
  async getByStayId() { return []; }
  async getByShiftId() { return []; }
  async getByIdempotencyKey() { return undefined; }
  async settleByReservationId() { return 0; }
  async voidByReservationId() { return 0; }
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

class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get() { return this.profile; }
  async update(_input: UpdateBusinessProfileInput) { return this.profile; }
}

/** D8 (22/08/2026) -- `getById()` es lo único que InvoiceService usa. */
class FakeOrderRepository implements Pick<IOrderRepository, 'getById'> {
  constructor(private readonly order: Order | null = null) {}
  async getById(id: string): Promise<Order | undefined> {
    return this.order && this.order.id === id ? this.order : undefined;
  }
}

/** D8-Nivel B (23/08/2026) -- fakes mínimos para armar líneas del comprobante. */
class FakeProductRepository implements Pick<IProductRepository, 'getById'> {
  constructor(private readonly products: Map<string, Product> = new Map()) {}
  async getById(id: string): Promise<Product | undefined> { return this.products.get(id); }
}

class FakeProductVariantRepository implements Pick<IProductVariantRepository, 'getById'> {
  constructor(private readonly variants: Map<string, ProductVariant> = new Map()) {}
  async getById(id: string): Promise<ProductVariant | undefined> { return this.variants.get(id); }
}

class FakeReservationRepository implements Pick<ReservationRepository, 'getById'> {
  constructor(private readonly reservation: Reservation | null = null) {}
  async getById(id: string): Promise<Reservation | undefined> {
    return this.reservation && this.reservation.id === id ? this.reservation : undefined;
  }
}

class FakeTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    return work({} as SqlClient);
  }
}

/** C1-Fase C -- Pick angosto, mismo que usa InvoiceService (bounded contexts). */
class FakeAccountsReceivableRepo
  implements Pick<AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId'>
{
  public rows = new Map<string, AccountReceivable>();
  public markInvoicedCalls: { id: string; invoiceRef: string | null | undefined }[] = [];

  async getByFinancialTransactionId(financialTransactionId: string): Promise<AccountReceivable | undefined> {
    return [...this.rows.values()].find((r) => r.financialTransactionId === financialTransactionId);
  }
  async getPendingByCompanyCustomerId(companyCustomerId: string): Promise<AccountReceivable[]> {
    return [...this.rows.values()].filter(
      (r) => r.companyCustomerId === companyCustomerId && r.status === 'PENDIENTE_FACTURAR' && r.financialTransactionId != null,
    );
  }
  async markInvoiced(id: string, invoiceRef?: string | null): Promise<AccountReceivable | undefined> {
    this.markInvoicedCalls.push({ id, invoiceRef });
    const ar = this.rows.get(id);
    if (!ar) return undefined;
    const updated: AccountReceivable = { ...ar, status: 'FACTURADO', invoiceRef: invoiceRef ?? null };
    this.rows.set(id, updated);
    return updated;
  }
}

class FakeAfipCredentialsRepository implements AfipCredentialsRepository {
  constructor(private readonly credentials: AfipCredentials | null) {}
  async getStatus(): Promise<AfipCredentialsStatus> {
    return { configured: this.credentials !== null, environment: this.credentials?.environment ?? null };
  }
  async getDecrypted() { return this.credentials; }
  async save() {}
  async clear() {}
  async getTicket(): Promise<AfipTicketCache | null> { return null; }
  async saveTicket() {}
  async clearTicket() {}
}

function makeTx(overrides: Partial<FinancialTransaction> = {}): FinancialTransaction {
  return {
    id: 'ft-1', businessId: 'biz-1', customerId: 'cust-1', type: 'CHARGE',
    amount: 121, currency: 'ARS', status: 'SETTLED',
    ...overrides,
  };
}

function makeProfile(overrides: Partial<BusinessProfile> = {}): BusinessProfile {
  const now = new Date();
  return {
    id: 'default', displayName: null, contactEmail: null,
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: 'Hotel Test SRL', taxId: '20111111112', taxIdType: 'CUIT', taxCondition: 'Responsable Inscripto',
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: 3, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    maintenanceHorizonDays: 30,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function makeCredentials(overrides: Partial<AfipCredentials> = {}): AfipCredentials {
  return { cert: 'CERT', key: 'KEY', environment: 'homologacion', ...overrides };
}

/** Fake mínimo de Arca -- solo lo que InvoiceService usa (electronicBillingService). */
function fakeArcaClient(overrides: {
  getLastVoucher?: ReturnType<typeof vi.fn>;
  createNextVoucher?: ReturnType<typeof vi.fn>;
  getVoucherInfo?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    electronicBillingService: {
      getLastVoucher: overrides.getLastVoucher ?? vi.fn().mockResolvedValue({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }),
      createNextVoucher: overrides.createNextVoucher ?? vi.fn(),
      getVoucherInfo: overrides.getVoucherInfo ?? vi.fn(),
    },
  } as unknown as Arca;
}

function afipApprovedResponse(cbteDesde: number, cae = 'CAE-APPROVED-123', caeFchVto = '20261231') {
  return {
    response: {
      FeCabResp: { Resultado: 'A', CbteTipo: CBTE_TIPO_FACTURA_B },
      FeDetResp: { FECAEDetResponse: [{ Resultado: 'A', CbteDesde: cbteDesde }] },
    },
    cae,
    caeFchVto,
  };
}

function afipRejectedResponse(msg = '10015: Factura B no cumple condicion') {
  return {
    response: {
      FeCabResp: { Resultado: 'R' },
      FeDetResp: { FECAEDetResponse: [{ Resultado: 'R', Observaciones: { Obs: [{ Code: 10015, Msg: msg.split(': ')[1] }] } }] },
    },
    cae: '',
    caeFchVto: '',
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('InvoiceService', () => {
  let invoiceRepo: FakeInvoiceRepository;
  let arRepo: FakeAccountsReceivableRepo;
  let auditLogRepo: InMemoryAuditLogRepository;

  beforeEach(() => {
    invoiceRepo = new FakeInvoiceRepository();
    arRepo = new FakeAccountsReceivableRepo();
    auditLogRepo = new InMemoryAuditLogRepository();
  });

  function buildService(opts: {
    tx?: FinancialTransaction | null;
    profile?: BusinessProfile;
    credentials?: AfipCredentials | null;
    client?: Arca;
    /** D8 -- solo hace falta cuando `tx.orderId` está seteado y se quiere ejercitar el agrupado por tasa. */
    order?: Order | null;
    /** D8-Nivel B -- productos/variantes referenciados por los order_items del `order` de arriba. */
    products?: Map<string, Product>;
    productVariants?: Map<string, ProductVariant>;
    /** D8-Nivel B -- solo hace falta cuando `tx.reservationId` está seteado (factura directa de una reserva). */
    reservation?: Reservation | null;
  } = {}) {
    const client = opts.client ?? fakeArcaClient();
    return new InvoiceService(
      invoiceRepo,
      new FakeFinancialTransactionRepository(opts.tx === undefined ? makeTx() : opts.tx),
      new FakeBusinessProfileRepository(opts.profile ?? makeProfile()),
      new FakeAfipCredentialsRepository(opts.credentials === undefined ? makeCredentials() : opts.credentials),
      new FakeOrderRepository(opts.order ?? null),
      new FakeProductRepository(opts.products),
      new FakeProductVariantRepository(opts.productVariants),
      new FakeReservationRepository(opts.reservation ?? null),
      new FakeTransactionManager(),
      arRepo,
      auditLogRepo,
      // buildService sigue armando un Arca fake (fakeArcaClient) igual que
      // antes del puerto/adapter -- se envuelve acá para que los ~16 usos
      // existentes de fakeArcaClient({...}) en esta suite no necesiten
      // tocarse uno por uno.
      () => buildArcaBillingAdapter(client),
    );
  }

  describe('validaciones antes de llamar a AFIP', () => {
    it('rechaza si la financial_transaction no existe (A3.9 -- no se factura un monto sin origen)', async () => {
      const service = buildService({ tx: null });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-inexistente', changedBy: 'identity-1' }))
        .rejects.toThrow(FinancialTransactionNotFoundError);
    });

    it('rechaza si falta el CUIT del negocio', async () => {
      const service = buildService({ profile: makeProfile({ taxId: null }) });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipNotConfiguredError);
    });

    it('rechaza si falta el punto de venta AFIP', async () => {
      const service = buildService({ profile: makeProfile({ afipSalesPoint: null }) });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipNotConfiguredError);
    });

    it('rechaza si todavía no se cargó el certificado AFIP', async () => {
      const service = buildService({ credentials: null });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipNotConfiguredError);
    });
  });

  describe('afipCuit (schema v25) -- CUIT de autenticación distinto del legal (taxId)', () => {
    it('sin afipCuit cargado, se autentica con taxId (comportamiento de siempre)', async () => {
      const clientFactory = vi.fn().mockReturnValue(buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher: vi.fn().mockResolvedValue(afipApprovedResponse(1)) })));
      const service = new InvoiceService(
        invoiceRepo,
        new FakeFinancialTransactionRepository(makeTx()),
        new FakeBusinessProfileRepository(makeProfile({ taxId: '20111111112', afipCuit: null })),
        new FakeAfipCredentialsRepository(makeCredentials()),
        new FakeOrderRepository(),
        new FakeProductRepository(),
        new FakeProductVariantRepository(),
        new FakeReservationRepository(),
        new FakeTransactionManager(),
        arRepo,
        new InMemoryAuditLogRepository(),
        clientFactory,
      );

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(clientFactory).toHaveBeenCalledWith(expect.anything(), '20111111112', expect.anything());
    });

    it('con afipCuit cargado, se autentica con ESE cuit, no con taxId -- no ensucia la identidad fiscal real', async () => {
      const clientFactory = vi.fn().mockReturnValue(buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher: vi.fn().mockResolvedValue(afipApprovedResponse(1)) })));
      const service = new InvoiceService(
        invoiceRepo,
        new FakeFinancialTransactionRepository(makeTx()),
        new FakeBusinessProfileRepository(makeProfile({ taxId: '20111111112', afipCuit: '20333333335' })),
        new FakeAfipCredentialsRepository(makeCredentials()),
        new FakeOrderRepository(),
        new FakeProductRepository(),
        new FakeProductVariantRepository(),
        new FakeReservationRepository(),
        new FakeTransactionManager(),
        arRepo,
        new InMemoryAuditLogRepository(),
        clientFactory,
      );

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(clientFactory).toHaveBeenCalledWith(expect.anything(), '20333333335', expect.anything());
    });

    it('sin taxId NI afipCuit, rechaza (nada con qué autenticarse)', async () => {
      const service = buildService({ profile: makeProfile({ taxId: null, afipCuit: null }) });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipNotConfiguredError);
    });
  });

  describe('I9 (24/08/2026) -- auditoría de comprobantes (invoices es DOCUMENTO, se audita como evento único, no como diff)', () => {
    it('registra un evento en audit_log al crear una Factura B, con el id de quien la pidió', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-admin' });

      const entries = await auditLogRepo.findByEntity('invoices', invoice.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entity: 'invoices', entityId: invoice.id, field: 'cbteTipo',
        oldValue: null, changedBy: 'identity-admin',
      });
    });

    it('un reintento idempotente (mismo financialTransactionId) no duplica el evento de auditoría', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      const first = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-admin' });
      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-admin' });

      const entries = await auditLogRepo.findByEntity('invoices', first.id);
      expect(entries).toHaveLength(1);
    });
  });

  describe('desglose neto/IVA (A2.9 -- según config real del negocio, no un supuesto fijo)', () => {
    it('precio con IVA incluido: 121 -> neto 100, IVA 21', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121 }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.impNeto).toBe(100);
      expect(invoice.impIva).toBe(21);
      expect(invoice.impTotal).toBe(121);
    });

    it('precio neto (sin IVA incluido): 100 -> neto 100, IVA 21, total 121', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 100 }),
        profile: makeProfile({ pricesIncludeIva: false, defaultIvaRate: 21 }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.impNeto).toBe(100);
      expect(invoice.impIva).toBe(21);
      expect(invoice.impTotal).toBe(121);
    });
  });

  // ---------------------------------------------------------------------------
  // D8 (22/08/2026, pendientes-2026-08-19.md sección D) -- agrupado por
  // tasa de IVA cuando la FinancialTransaction viene de una Order con
  // productos a distinta alícuota.
  // ---------------------------------------------------------------------------
  describe('D8 -- agrupado de IVA por tasa (órdenes con productos a distinta alícuota)', () => {
    function makeOrderItem(overrides: Partial<{ subtotal: number; ivaRate: number | null }> = {}) {
      return {
        id: `oi-${Math.random()}`, orderId: 'ord-1', itemType: 'PRODUCT' as const,
        productId: 'prod-1', productVariantId: null, reservationId: null,
        quantity: 1, unitPrice: overrides.subtotal ?? 100, subtotal: overrides.subtotal ?? 100,
        notes: null, stockSnapshot: null, ivaRate: overrides.ivaRate ?? null,
        createdAt: new Date(), updatedAt: new Date(),
      };
    }

    it('una orden con UNA sola tasa (todos los ítems al mismo % o sin override) da el mismo resultado que antes de D8', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: 'ord-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 121,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null,
          items: [makeOrderItem({ subtotal: 121, ivaRate: 21 })],
        } as unknown as Order,
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.impNeto).toBe(100);
      expect(invoice.impIva).toBe(21);
      expect(invoice.impTotal).toBe(121);
      expect((invoice.afipRequest as { Iva: unknown[] }).Iva).toHaveLength(1);
    });

    it('una orden con DOS tasas distintas (21% y 10.5%) agrupa en dos entradas de Iva[] -- cumplimiento fiscal estricto', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 155.25, orderId: 'ord-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 155.25,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null,
          items: [
            // 21% -- 121 incluye IVA -> neto 100, iva 21
            makeOrderItem({ subtotal: 121, ivaRate: 21 }),
            // 10.5% -- 34.25 incluye IVA -> neto 31, iva 3.25
            makeOrderItem({ subtotal: 34.25, ivaRate: 10.5 }),
          ],
        } as unknown as Order,
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.impNeto).toBe(131);
      expect(invoice.impIva).toBe(24.25);
      expect(invoice.impTotal).toBe(155.25);

      const iva = (invoice.afipRequest as { Iva: Array<{ Id: number; BaseImp: number; Importe: number }> }).Iva;
      expect(iva).toHaveLength(2);
      expect(iva).toEqual(expect.arrayContaining([
        { Id: 5, BaseImp: 100, Importe: 21 },     // 21%
        { Id: 4, BaseImp: 31, Importe: 3.25 },    // 10.5%
      ]));
    });

    it('un ítem sin override (ivaRate null) cae al default_iva_rate del negocio, no queda sin clasificar', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: 'ord-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 121,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null,
          items: [makeOrderItem({ subtotal: 121, ivaRate: null })],
        } as unknown as Order,
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.impNeto).toBe(100);
      expect(invoice.impIva).toBe(21);
    });

    it('una tasa sin Id de AFIP confirmado (ej. 27%) rechaza explícito en vez de mandar un Id inventado', async () => {
      const service = buildService({
        tx: makeTx({ amount: 127, orderId: 'ord-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 127,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null,
          items: [makeOrderItem({ subtotal: 127, ivaRate: 27 })],
        } as unknown as Order,
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(UnsupportedIvaRateError);
    });

    it('una reserva (sin orderId) sigue exactamente igual que antes de D8 -- una sola tasa, la del negocio', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: null, reservationId: 'res-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.impNeto).toBe(100);
      expect(invoice.impIva).toBe(21);
    });
  });

  // ---------------------------------------------------------------------------
  // D8-Nivel B (23/08/2026, docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md)
  // -- líneas reales del comprobante (invoice_items).
  // ---------------------------------------------------------------------------
  describe('D8-Nivel B -- líneas reales del comprobante', () => {
    function makeOrderItem(overrides: Partial<{
      subtotal: number; ivaRate: number | null; itemType: 'PRODUCT' | 'PRODUCT_VARIANT' | 'RESERVATION';
      productId: string | null; productVariantId: string | null; reservationId: string | null; quantity: number;
    }> = {}) {
      return {
        id: `oi-${Math.random()}`, orderId: 'ord-1',
        itemType: overrides.itemType ?? 'PRODUCT',
        productId: overrides.productId !== undefined ? overrides.productId : 'prod-1',
        productVariantId: overrides.productVariantId ?? null,
        reservationId: overrides.reservationId ?? null,
        quantity: overrides.quantity ?? 1,
        unitPrice: overrides.subtotal ?? 100, subtotal: overrides.subtotal ?? 100,
        notes: null, stockSnapshot: null, ivaRate: overrides.ivaRate ?? null,
        appliedCustomerRateId: null,
        createdAt: new Date(), updatedAt: new Date(),
      };
    }

    function makeReservationFake(id: string, resourceName: string): Reservation {
      return { id, resource: { name: resourceName } } as unknown as Reservation;
    }

    it('una orden con un producto real arma una línea con nombre/cantidad/unidad/código ARCA del producto', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const products = new Map<string, Product>([
        ['prod-1', { id: 'prod-1', name: 'Coca-Cola 500ml', unit: 'unidad', arcaUnitCode: 7 } as unknown as Product],
      ]);
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: 'ord-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 121,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null,
          items: [makeOrderItem({ subtotal: 121, ivaRate: 21, quantity: 2 })],
        } as unknown as Order,
        products,
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        description: 'Coca-Cola 500ml', quantity: 2, subtotal: 121, ivaRate: 21,
        unit: 'unidad', arcaUnitCode: 7, orderItemId: expect.any(String), reservationId: null,
      });
    });

    it('un producto con variante muestra el nombre de la variante entre paréntesis', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const products = new Map<string, Product>([
        ['prod-1', { id: 'prod-1', name: 'Remera', unit: null, arcaUnitCode: null } as unknown as Product],
      ]);
      const productVariants = new Map<string, ProductVariant>([
        ['var-1', { id: 'var-1', name: 'Talle M' } as unknown as ProductVariant],
      ]);
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: 'ord-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 121,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null,
          items: [makeOrderItem({ subtotal: 121, ivaRate: 21, itemType: 'PRODUCT_VARIANT', productVariantId: 'var-1' })],
        } as unknown as Order,
        products, productVariants,
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items[0]?.description).toBe('Remera (Talle M)');
    });

    it('un ítem RESERVATION dentro de una orden usa el nombre del recurso de la reserva', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: 'ord-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 121,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null,
          items: [makeOrderItem({ subtotal: 121, itemType: 'RESERVATION', productId: null, reservationId: 'res-1' })],
        } as unknown as Order,
        reservation: makeReservationFake('res-1', 'Mesa Ventana'),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items[0]).toMatchObject({ description: 'Mesa Ventana', orderItemId: expect.any(String), reservationId: 'res-1' });
    });

    it('una reserva facturada directo (sin orderId) arma UNA línea con tx.amount, no reservation.totalPrice', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      // tx.amount=60 -- ej. la seña de una reserva de totalPrice=200 (C1-Fase A) --
      // la línea tiene que reflejar el comprobante puntual, no el total de la reserva.
      const service = buildService({
        tx: makeTx({ amount: 60, orderId: null, reservationId: 'res-1' }),
        profile: makeProfile({ pricesIncludeIva: true, defaultIvaRate: 21 }),
        reservation: makeReservationFake('res-1', 'Habitación Doble'),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        description: 'Habitación Doble', quantity: 1, unitPrice: 60, subtotal: 60,
        reservationId: 'res-1', orderItemId: null,
      });
    });

    it('sin orden ni reserva asociada, cae a una línea genérica (mismo fallback que Nivel A)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 100, orderId: null, reservationId: null }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      expect(items[0]?.description).toBe('Servicios');
    });
  });

  describe('C2 -- Nota de Crédito para una FinancialTransaction REFUND', () => {
    function seedOriginalInvoice(overrides: Partial<Invoice> = {}): Invoice {
      const original: Invoice = {
        id: 'inv-original', businessId: 'biz-1', financialTransactionId: 'ft-original', customerId: 'cust-1',
        idempotencyKey: 'invoice:ft-original', environment: 'homologacion',
        ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B, cbteNro: 42,
        concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5,
        moneda: 'PES', impNeto: 82.64, impIva: 17.36, impTotal: 100,
        cae: 'CAE-ORIGINAL', caeVto: '2026-09-01',
        status: 'ISSUED', afipContacted: true, emisorCuit: '20111111112',
        paymentMethod: null, cardInstallments: null,
        afipRequest: { Iva: [{ Id: 5, BaseImp: 82.64, Importe: 17.36 }] },
        afipResponse: {}, errorMessage: null,
        createdAt: new Date(), issuedAt: new Date(),
        ...overrides,
      };
      invoiceRepo.invoices.set(original.id, original);
      return original;
    }

    it('rechaza un REFUND sin reversedInvoiceId (ledger-only, sin factura que corregir)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'REFUND', amount: 50, reversedInvoiceId: null }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(InvoiceNotReversibleError);
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('rechaza un REFUND cuya factura asociada no existe', async () => {
      const service = buildService({
        tx: makeTx({ type: 'REFUND', amount: 50, reversedInvoiceId: 'inv-inexistente' }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(InvoiceNotReversibleError);
    });

    it('rechaza un REFUND cuya factura asociada no está ISSUED', async () => {
      seedOriginalInvoice({ status: 'PENDING', cbteNro: null });
      const service = buildService({
        tx: makeTx({ type: 'REFUND', amount: 50, reversedInvoiceId: 'inv-original' }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(InvoiceNotReversibleError);
    });

    it('F-A (05/09/2026) -- rechaza un REFUND cuyo reversedInvoiceId apunta a OTRA Nota de Crédito, no a una Factura B', async () => {
      seedOriginalInvoice({ id: 'nc-anterior', cbteTipo: CBTE_TIPO_NOTA_CREDITO_B, cbteNro: 7 });
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'REFUND', amount: 50, reversedInvoiceId: 'nc-anterior' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(InvoiceNotReversibleError);
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('reembolso total: arma una NC (CbteTipo 8) con CbtesAsoc apuntando a la factura original', async () => {
      seedOriginalInvoice();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'REFUND', amount: 100, reservationId: 'res-1', reversedInvoiceId: 'inv-original' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.cbteTipo).toBe(CBTE_TIPO_NOTA_CREDITO_B);
      expect(invoice.impTotal).toBe(100);
      expect(invoice.impNeto).toBe(82.64);
      expect(invoice.impIva).toBe(17.36);
      const sentRequest = createNextVoucher.mock.calls[0]![0] as { CbtesAsoc: Array<{ Tipo: number; PtoVta: number; Nro: number }> };
      expect(sentRequest.CbtesAsoc).toEqual([{ Tipo: CBTE_TIPO_FACTURA_B, PtoVta: 3, Nro: 42 }]);

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ unitPrice: 100, subtotal: 100, reservationId: 'res-1' });

      // I9 -- la NC también se audita, con SU PROPIO id (no el de la factura original).
      const entries = await auditLogRepo.findByEntity('invoices', invoice.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ field: 'cbteTipo', newValue: String(CBTE_TIPO_NOTA_CREDITO_B), changedBy: 'identity-1' });
    });

    it('reembolso parcial: escala proporcionalmente el neto/IVA de la factura original, no los recalcula desde la config actual', async () => {
      seedOriginalInvoice(); // impTotal=100, impNeto=82.64, impIva=17.36
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        // pricesIncludeIva=false acá a propósito -- si el código recalculara
        // desde la config actual (bug ya autocorregido en D8-Nivel B) esto
        // daría un resultado distinto al escalado proporcional correcto.
        tx: makeTx({ type: 'REFUND', amount: 50, reversedInvoiceId: 'inv-original' }),
        profile: makeProfile({ pricesIncludeIva: false, defaultIvaRate: 21 }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      // factor = 50/100 = 0.5 -- mitad del neto/IVA original, no un IVA recalculado sobre 50.
      expect(invoice.impTotal).toBe(50);
      expect(invoice.impNeto).toBe(41.32);
      expect(invoice.impIva).toBe(8.68);
    });
  });

  describe('idempotencia (A8.5/R13, clave determinística por financial_transaction_id)', () => {
    it('un segundo pedido para la MISMA financial_transaction devuelve la invoice ya creada, sin llamar de nuevo a AFIP', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      const first = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      const second = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(second.id).toBe(first.id);
      expect(createNextVoucher).toHaveBeenCalledTimes(1);
    });

    it('FAILED_UNCERTAIN sin haber contactado a AFIP (falla el chequeo previo al CAE) SÍ reintenta contra AFIP en el segundo pedido', async () => {
      const getLastVoucher = vi.fn()
        .mockRejectedValueOnce(new Error('timeout de red'))
        .mockResolvedValueOnce({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 });
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(11));
      const service = buildService({ client: fakeArcaClient({ getLastVoucher, createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipRequestUncertainError);
      const failed = await invoiceRepo.getByIdempotencyKey('invoice:ft-1');
      expect(failed?.status).toBe('FAILED_UNCERTAIN');
      expect(failed?.afipContacted).toBe(false);

      const retried = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(retried.status).toBe('ISSUED');
      expect(retried.id).toBe(failed!.id); // misma fila, nunca una segunda
      expect(createNextVoucher).toHaveBeenCalledTimes(1);
    });

    it('FAILED_UNCERTAIN habiendo contactado a AFIP (createNextVoucher se invocó, red cortada después) NO reintenta solo -- A8.6', async () => {
      const getLastVoucher = vi.fn().mockResolvedValue({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 });
      const createNextVoucher = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
      const service = buildService({ client: fakeArcaClient({ getLastVoucher, createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipRequestUncertainError);
      const failed = await invoiceRepo.getByIdempotencyKey('invoice:ft-1');
      expect(failed?.afipContacted).toBe(true);

      const second = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(second.status).toBe('FAILED_UNCERTAIN');
      expect(second.id).toBe(failed!.id);
      // nunca se volvió a llamar createNextVoucher -- ambiguo, requiere revisión manual antes de reintentar
      expect(createNextVoucher).toHaveBeenCalledTimes(1);
    });

    it('REJECTED (AFIP evaluó y dijo que no) SÍ reintenta contra AFIP en el segundo pedido', async () => {
      const createNextVoucher = vi.fn()
        .mockResolvedValueOnce(afipRejectedResponse())
        .mockResolvedValueOnce(afipApprovedResponse(5));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipRequestRejectedError);
      const rejected = await invoiceRepo.getByIdempotencyKey('invoice:ft-1');
      expect(rejected?.status).toBe('REJECTED');

      const retried = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(retried.status).toBe('ISSUED');
      expect(retried.id).toBe(rejected!.id);
      expect(createNextVoucher).toHaveBeenCalledTimes(2);
    });
  });

  describe('emisión exitosa', () => {
    it('marca la invoice ISSUED con cbteNro/CAE/CAEFchVto de la respuesta', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(42, 'CAE-XYZ', '20261231'));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.cbteNro).toBe(42);
      expect(invoice.cae).toBe('CAE-XYZ');
      expect(invoice.caeVto).toBe('2026-12-31');
    });

    it('sin buyer explícito, factura a Consumidor Final (DocTipo 99, sin CUIT/DNI)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(createNextVoucher).toHaveBeenCalledWith(expect.objectContaining({ DocTipo: 99, DocNro: 0 }));
    });

    it('con buyer explícito, usa su DocTipo/DocNro/condición IVA', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      await service.requestInvoice({
        businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1',
        buyer: { docTipo: 80, docNro: '20333333335', condicionIvaReceptorId: 1 },
      });

      expect(createNextVoucher).toHaveBeenCalledWith(expect.objectContaining({
        DocTipo: 80, DocNro: 20333333335, CondicionIVAReceptorId: 1,
      }));
    });

    // Regresión (19/08/2026, auditoría de producto): financial_transactions
    // ya tenía forma de pago completa (cash-register, orders,
    // customer-account.service.ts) pero el comprobante nunca la reflejaba.
    it('congela paymentMethod/cardInstallments de la FinancialTransaction al crear (R9)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ paymentMethod: 'CARD', cardInstallments: 3 }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.paymentMethod).toBe('CARD');
      expect(invoice.cardInstallments).toBe(3);
    });

    it('sin forma de pago cargada en la transacción, queda null (no se inventa un valor)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      // makeTx() sin overrides ya omite paymentMethod/cardInstallments --
      // exactamente el caso "transacción sin forma de pago cargada".
      const service = buildService({
        tx: makeTx(),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.paymentMethod).toBeNull();
      expect(invoice.cardInstallments).toBeNull();
    });
  });

  describe('rechazo explícito de AFIP', () => {
    it('marca REJECTED y lanza AfipRequestRejectedError con el detalle de la observación', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipRejectedResponse('10015: motivo de prueba'));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipRequestRejectedError);

      const invoice = [...invoiceRepo.invoices.values()][0]!;
      expect(invoice.status).toBe('REJECTED');
      expect(invoice.errorMessage).toContain('10015');
    });
  });

  describe('A8.6 -- falla ambigua de red, nunca reintento automático', () => {
    it('si no se puede ni consultar FECompUltimoAutorizado ANTES de pedir el CAE, no intenta el pedido y queda FAILED_UNCERTAIN', async () => {
      const getLastVoucher = vi.fn().mockRejectedValue(new Error('timeout'));
      const createNextVoucher = vi.fn();
      const service = buildService({ client: fakeArcaClient({ getLastVoucher, createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipRequestUncertainError);

      expect(createNextVoucher).not.toHaveBeenCalled();
      const invoice = [...invoiceRepo.invoices.values()][0]!;
      expect(invoice.status).toBe('FAILED_UNCERTAIN');
    });

    it('si createNextVoucher explota y FECompUltimoAutorizado NO avanzó, queda FAILED_UNCERTAIN (no se sabe si AFIP lo procesó)', async () => {
      const getLastVoucher = vi.fn().mockResolvedValue({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 });
      const createNextVoucher = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
      const getVoucherInfo = vi.fn();
      const service = buildService({ client: fakeArcaClient({ getLastVoucher, createNextVoucher, getVoucherInfo }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(AfipRequestUncertainError);

      expect(getVoucherInfo).not.toHaveBeenCalled(); // no avanzó -- no hay nada que reconciliar
      const invoice = [...invoiceRepo.invoices.values()][0]!;
      expect(invoice.status).toBe('FAILED_UNCERTAIN');
      expect(invoice.cae).toBeNull();
    });

    it('si createNextVoucher explota pero FECompUltimoAutorizado SÍ avanzó, recupera el CAE real en vez de perderlo (reconciliación, no reintento)', async () => {
      const getLastVoucher = vi.fn()
        .mockResolvedValueOnce({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }) // antes
        .mockResolvedValueOnce({ cbteNro: 11, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 }); // después -- avanzó
      const createNextVoucher = vi.fn().mockRejectedValue(new Error('timeout, pero AFIP sí lo proceso'));
      const getVoucherInfo = vi.fn().mockResolvedValue({ codAutorizacion: 'CAE-RECOVERED', fchVto: '20261231' });
      const service = buildService({ client: fakeArcaClient({ getLastVoucher, createNextVoucher, getVoucherInfo }) });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(getVoucherInfo).toHaveBeenCalledWith(11, 3, CBTE_TIPO_FACTURA_B);
      expect(invoice.status).toBe('ISSUED');
      expect(invoice.cbteNro).toBe(11);
      expect(invoice.cae).toBe('CAE-RECOVERED');
    });
  });
});

// ---------------------------------------------------------------------------
// C1-Fase C (23/08/2026, pendientes-2026-08-23.md) -- facturación
// consolidada + cierre del gap FacturarButton/accounts_receivable.
// ---------------------------------------------------------------------------

/** A diferencia de FakeFinancialTransactionRepository (un solo tx fijo), acá hacen falta N transactions distintas por id. */
class FakeMultiFinancialTransactionRepository implements FinancialTransactionRepository {
  constructor(private readonly txs: Map<string, FinancialTransaction>) {}
  async create() { return null; }
  async createWithClient() { return null; }
  async getById(id: string) { return this.txs.get(id) ?? null; }
  async getByReservationId() { return []; }
  async getByOrderId() { return []; }
  async getByCustomerId() { return []; }
  async getByStayId() { return []; }
  async getByShiftId() { return []; }
  async getByIdempotencyKey() { return undefined; }
  async settleByReservationId() { return 0; }
  async voidByReservationId() { return 0; }
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

describe('InvoiceService — C1-Fase C', () => {
  const PROFILE = {
    id: 'default', displayName: null, contactEmail: null,
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
    legalName: 'Hotel Test SRL', taxId: '20111111112', taxIdType: 'CUIT', taxCondition: 'Responsable Inscripto',
    fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
    fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: 3, afipCuit: null,
    defaultIvaRate: 21, pricesIncludeIva: true,
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    maintenanceHorizonDays: 30,
    createdAt: new Date(), updatedAt: new Date(),
  } satisfies BusinessProfile;

  function makeAr(overrides: Partial<AccountReceivable> = {}): AccountReceivable {
    return {
      id: 'ar-1', businessId: 'biz-1', stayId: 'stay-1', companyCustomerId: 'cust-empresa',
      amount: 121, currency: 'ARS', status: 'PENDIENTE_FACTURAR', transferredBy: 'user-1',
      financialTransactionId: 'ft-1',
      ...overrides,
    };
  }

  describe('finalizeIssued -- cierra el gap FacturarButton/accounts_receivable (camino per-reservation)', () => {
    it('marca la fila accounts_receivable como FACTURADO con el comprobante real, tras emitir vía requestInvoice', async () => {
      const invoiceRepo = new FakeInvoiceRepository();
      const arRepo = new FakeAccountsReceivableRepo();
      arRepo.rows.set('ar-1', makeAr());
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(42));
      const service = new InvoiceService(
        invoiceRepo,
        new FakeFinancialTransactionRepository(makeTx({ id: 'ft-1', customerId: 'cust-empresa' })),
        new FakeBusinessProfileRepository(PROFILE),
        new FakeAfipCredentialsRepository(makeCredentials()),
        new FakeOrderRepository(),
        new FakeProductRepository(),
        new FakeProductVariantRepository(),
        new FakeReservationRepository(),
        new FakeTransactionManager(),
        arRepo,
        new InMemoryAuditLogRepository(),
        () => buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher })),
      );

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(arRepo.rows.get('ar-1')!.status).toBe('FACTURADO');
      expect(arRepo.rows.get('ar-1')!.invoiceRef).toBe('0003-00000042');
    });

    it('no hace nada si la CHARGE facturada no tiene ninguna fila accounts_receivable asociada (cliente individual, caso normal)', async () => {
      const invoiceRepo = new FakeInvoiceRepository();
      const arRepo = new FakeAccountsReceivableRepo(); // vacío
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = new InvoiceService(
        invoiceRepo,
        new FakeFinancialTransactionRepository(makeTx()),
        new FakeBusinessProfileRepository(PROFILE),
        new FakeAfipCredentialsRepository(makeCredentials()),
        new FakeOrderRepository(),
        new FakeProductRepository(),
        new FakeProductVariantRepository(),
        new FakeReservationRepository(),
        new FakeTransactionManager(),
        arRepo,
        new InMemoryAuditLogRepository(),
        () => buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher })),
      );

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.status).toBe('ISSUED');
      expect(arRepo.markInvoicedCalls).toHaveLength(0);
    });
  });

  describe('requestConsolidatedInvoice -- "Facturar ahora"', () => {
    function buildConsolidatedService(opts: {
      pending: AccountReceivable[];
      txs: Map<string, FinancialTransaction>;
      createNextVoucher?: ReturnType<typeof vi.fn>;
    }) {
      const invoiceRepo = new FakeInvoiceRepository();
      const arRepo = new FakeAccountsReceivableRepo();
      const auditLogRepo = new InMemoryAuditLogRepository();
      for (const ar of opts.pending) arRepo.rows.set(ar.id, ar);
      const createNextVoucher = opts.createNextVoucher ?? vi.fn().mockResolvedValue(afipApprovedResponse(99));
      const service = new InvoiceService(
        invoiceRepo,
        new FakeMultiFinancialTransactionRepository(opts.txs),
        new FakeBusinessProfileRepository(PROFILE),
        new FakeAfipCredentialsRepository(makeCredentials()),
        new FakeOrderRepository(),
        new FakeProductRepository(),
        new FakeProductVariantRepository(),
        new FakeReservationRepository(),
        new FakeTransactionManager(),
        arRepo,
        auditLogRepo,
        () => buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher })),
      );
      return { service, invoiceRepo, arRepo, auditLogRepo, createNextVoucher };
    }

    it('rechaza si la empresa no tiene nada PENDIENTE_FACTURAR', async () => {
      const { service } = buildConsolidatedService({ pending: [], txs: new Map() });
      await expect(service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' }))
        .rejects.toThrow(NothingToInvoiceError);
    });

    it('un comprobante cubre N cargos: suma los montos y marca las N filas FACTURADO con el mismo comprobante', async () => {
      const pending = [
        makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 }),
        makeAr({ id: 'ar-2', financialTransactionId: 'ft-2', amount: 50 }),
      ];
      const txs = new Map([
        ['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100, reservationId: 'res-1' })],
        ['ft-2', makeTx({ id: 'ft-2', customerId: 'cust-empresa', amount: 50, reservationId: 'res-2' })],
      ]);
      const { service, invoiceRepo, arRepo, auditLogRepo } = buildConsolidatedService({ pending, txs });

      const invoice = await service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' });

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.financialTransactionId).toBeNull();
      expect(invoice.impTotal).toBe(150); // suma de los dos cargos (100 + 50), precios con IVA incluido
      expect(invoiceRepo.items.get(invoice.id)).toHaveLength(2); // una línea por cargo (resolveInvoiceItems x2)
      expect(invoiceRepo.charges.get('ft-1')).toBe(invoice.id);
      expect(invoiceRepo.charges.get('ft-2')).toBe(invoice.id);

      expect(arRepo.rows.get('ar-1')!.status).toBe('FACTURADO');
      expect(arRepo.rows.get('ar-2')!.status).toBe('FACTURADO');
      expect(arRepo.rows.get('ar-1')!.invoiceRef).toBe(arRepo.rows.get('ar-2')!.invoiceRef); // mismo comprobante para las dos

      // I9 -- un solo evento de auditoría para la consolidada, no uno por cargo cubierto.
      expect(await auditLogRepo.findByEntity('invoices', invoice.id)).toHaveLength(1);
    });

    it('idempotencia: reintentar tras un fallo a mitad de camino (factura ya ISSUED, accounts_receivable sin marcar todavía) no pide un segundo CAE', async () => {
      // Simula el escenario real que la idempotencia tiene que cubrir: la
      // factura consolidada YA se emitió (ISSUED, con invoice_charges),
      // pero el loop best-effort que marca accounts_receivable FACTURADO
      // falló a mitad de camino -- la fila sigue PENDIENTE_FACTURAR. Un
      // reintento con el MISMO set de cargos pendientes tiene que
      // encontrar la factura existente por idempotencyKey, no pedir un
      // segundo CAE ni caer en el guard anti double-billing (ver el
      // reordenamiento en requestConsolidatedInvoice: idempotencia antes
      // que el guard, a propósito).
      const pending = [makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 })];
      const txs = new Map([['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100 })]]);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(5));
      const { invoiceRepo, arRepo } = buildConsolidatedService({ pending, txs, createNextVoucher });

      const priorInvoiceId = 'inv-previa';
      const idempotencyKey = `invoice:consolidated:${hashIds(['ft-1'])}`;
      invoiceRepo.invoices.set(priorInvoiceId, {
        id: priorInvoiceId, businessId: 'biz-1', financialTransactionId: null, customerId: 'cust-empresa',
        idempotencyKey, environment: 'homologacion', ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B,
        cbteNro: 5, concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5, moneda: 'PES',
        impNeto: 100, impIva: 0, impTotal: 100, cae: 'CAE-PREVIA', caeVto: '2026-12-31', status: 'ISSUED',
        afipContacted: true, emisorCuit: '20111111112', paymentMethod: null, cardInstallments: null,
        afipRequest: {}, afipResponse: {}, errorMessage: null, createdAt: new Date(), issuedAt: new Date(),
      });
      invoiceRepo.charges.set('ft-1', priorInvoiceId);

      const service = new InvoiceService(
        invoiceRepo,
        new FakeMultiFinancialTransactionRepository(txs),
        new FakeBusinessProfileRepository(PROFILE),
        new FakeAfipCredentialsRepository(makeCredentials()),
        new FakeOrderRepository(),
        new FakeProductRepository(),
        new FakeProductVariantRepository(),
        new FakeReservationRepository(),
        new FakeTransactionManager(),
        arRepo,
        new InMemoryAuditLogRepository(),
        () => buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher })),
      );

      const result = await service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' });

      expect(result.id).toBe(priorInvoiceId);
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('rechaza (guard anti double-billing) si algún cargo pendiente YA tiene una factura ISSUED real', async () => {
      const pending = [makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 })];
      const txs = new Map([['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100 })]]);
      const { service, invoiceRepo } = buildConsolidatedService({ pending, txs });

      // Simula la inconsistencia: ft-1 ya está en una factura ISSUED
      // (ej. el paso de marcar accounts_receivable falló la vez anterior),
      // pero la fila AR sigue diciendo PENDIENTE_FACTURAR.
      const priorInvoiceId = 'inv-previa';
      invoiceRepo.invoices.set(priorInvoiceId, {
        id: priorInvoiceId, businessId: 'biz-1', financialTransactionId: null, customerId: 'cust-empresa',
        idempotencyKey: 'invoice:consolidated:otra', environment: 'homologacion', ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B,
        cbteNro: 1, concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5, moneda: 'PES',
        impNeto: 100, impIva: 0, impTotal: 100, cae: 'CAE-X', caeVto: '2026-12-31', status: 'ISSUED',
        afipContacted: true, emisorCuit: '20111111112', paymentMethod: null, cardInstallments: null,
        afipRequest: {}, afipResponse: {}, errorMessage: null, createdAt: new Date(), issuedAt: new Date(),
      });
      invoiceRepo.charges.set('ft-1', priorInvoiceId);

      await expect(service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' }))
        .rejects.toThrow(AccountsReceivableAlreadyInvoicedError);
    });
  });
});
