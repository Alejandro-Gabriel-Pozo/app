import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Arca } from '@arcasdk/core';
import { InvoiceService, hashIds } from './invoice.service.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput, InvoiceLinkage } from './invoice.repository.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus, InvoiceItem, CreateInvoiceItemInput } from './invoice.entities.js';
import { INVOICE_STATUSES_CONSUMING_CHARGE } from './invoice.entities.js';
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
import { AfipNotConfiguredError, FinancialTransactionNotFoundError, AfipRequestRejectedError, AfipRequestUncertainError, UnsupportedIvaRateError, InvoiceNotReversibleError, NothingToInvoiceError, AccountsReceivableAlreadyInvoicedError, InvoiceAlreadyLinkedByOtherPathError, OrderCancelledCannotInvoiceError, ReservationCancelledCannotInvoiceError, OrderInvoiceHasNoLinesError } from '../domain/errors.js';
import { CBTE_TIPO_FACTURA_B, CBTE_TIPO_NOTA_CREDITO_B, CBTE_TIPOS_NOTA_CREDITO } from './afip-catalog.constants.js';
import { buildArcaBillingAdapter } from './arca-sdk-billing.adapter.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import { logger } from '../logger.js';

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
    // Predicado corregido 11/09/2026 -- espeja sql.invoice.repository.ts:
    // "¿existe la fila en invoice_charges?", sin mirar status (ver
    // docblock de invoice.repository.ts para el porqué).
    const result = new Set<string>();
    for (const ftId of this.charges.keys()) {
      if (ids.includes(ftId)) result.add(ftId);
    }
    return result;
  }
  async getByReservationId(): Promise<Invoice[]> { return []; }
  async getOutstandingByCustomerId(): Promise<Array<Invoice & { outstanding: number }>> { return []; }
  async getOutstandingForUpdate(): Promise<number> { return 0; }
  async getRefundableForUpdate(): Promise<number> { return 0; }
  // ADR común cancelar-con-NC (06/09/2026, F4) -- sin caller todavía en InvoiceService.
  async getIssuedCreditNoteCompensationTotal(): Promise<number> { return 0; }
  // Bloque 2.4 (tope N5, 08/09/2026) -- SÍ tiene caller real (buildCreditNote()).
  // Default 0 ("nada en vuelo todavía") para no romper los tests de emisión
  // de NC existentes que no ejercitan el tope; los tests DEDICADOS a N5
  // sobreescriben esto o van a integración contra Postgres real (el fake no
  // modela financial_transactions.reversed_invoice_id, C4 del gate).
  async getInFlightCreditNoteTotalForUpdate(): Promise<number> { return 0; }
  // Bloque 3.3-a (08/09/2026) -- mismo criterio que el de arriba: default 0,
  // los tests dedicados al tope por par sobreescriben el método en la instancia.
  async getInFlightCreditNoteTotalForPairForUpdate(
    _client: SqlClient, _invoiceId: string, _subject: { kind: 'RESERVATION' | 'ORDER'; id: string },
  ): Promise<number> { return 0; }
  // O2-F2 (03/09/2026)
  async getByCustomerId(customerId: string): Promise<Invoice[]> {
    return [...this.invoices.values()].filter((i) => i.customerId === customerId);
  }
  // B3 bloque 2.1 (08/09/2026) -- sin caller todavía en InvoiceService.
  async getByStatus(status: InvoiceStatus): Promise<Invoice[]> {
    return [...this.invoices.values()].filter((i) => i.status === status);
  }
  async getFinancialTransactionIdsCoveredByConsolidated(ids: string[]): Promise<Set<string>> {
    // Espeja el SQL real: rama invoice_charges CON filtro de status
    // (INVOICE_STATUSES_CONSUMING_CHARGE) -- a diferencia de
    // getInvoicedFinancialTransactionIds() de arriba, que en esa rama es
    // status-agnóstica a propósito. Ver docblock de la interfaz.
    const result = new Set<string>();
    for (const [chargeFtId, invoiceId] of this.charges) {
      const status = this.invoices.get(invoiceId)?.status;
      if (ids.includes(chargeFtId) && status && (INVOICE_STATUSES_CONSUMING_CHARGE as readonly string[]).includes(status)) {
        result.add(chargeFtId);
      }
    }
    return result;
  }
  async getConsolidatedInvoiceIdsForFinancialTransactions(ids: string[]): Promise<Map<string, string>> {
    // Método hermano de getFinancialTransactionIdsCoveredByConsolidated()
    // de arriba -- mismo predicado, pero devuelve el invoiceId en vez del
    // booleano. INVOICE-CHARGES-BUTTON-DEADEND-01 (11/09/2026).
    const result = new Map<string, string>();
    for (const [chargeFtId, invoiceId] of this.charges) {
      const status = this.invoices.get(invoiceId)?.status;
      if (ids.includes(chargeFtId) && status && (INVOICE_STATUSES_CONSUMING_CHARGE as readonly string[]).includes(status)) {
        result.set(chargeFtId, invoiceId);
      }
    }
    return result;
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
  // 1c-ii-a (11/09/2026) -- sin caller todavía en InvoiceService, mismo
  // criterio que getIssuedCreditNoteCompensationTotal de arriba. Vacío por
  // default: el fake no modela order_items, los tests que lo necesiten lo
  // sobreescriben o van a integración contra Postgres real.
  async getOrderIdsByInvoiceItemId(_invoiceId: string): Promise<Map<string, string>> { return new Map(); }
  // ADR común cancelar-con-NC §3 N1.a(iii) -- inverso de resolveInvoiceLinkage().
  async getChargeIdsForInvoice(invoiceId: string): Promise<string[]> {
    const ids = new Set<string>();
    const individual = [...this.invoices.values()].find((i) => i.id === invoiceId);
    if (individual?.financialTransactionId) ids.add(individual.financialTransactionId);
    for (const [ftId, invId] of this.charges) {
      if (invId === invoiceId) ids.add(ftId);
    }
    return [...ids];
  }
  // ADR común cancelar-con-NC sub-bloque 5 (b) / bloque 3.3-d -- sin caller en InvoiceService.
  async classifyOrderLiveInvoice(): Promise<'RECONCILED' | 'NOT_RECONCILED'> { return 'NOT_RECONCILED'; }
  async classifyReservationLiveInvoice(): Promise<'RECONCILED' | 'NOT_RECONCILED'> { return 'NOT_RECONCILED'; }
  async listUnreconciledLiveInvoices() { return []; } // bandeja -- sin caller en este archivo
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
    return this.markFailedWithClient({} as SqlClient, id, data);
  }
  // Bloque 2 (15/09/2026) -- el fake ignora `client` (sin transacción real
  // en memoria), mismo criterio que createWithClient() de arriba.
  async markFailedWithClient(_client: SqlClient, id: string, data: MarkFailedInput): Promise<Invoice> {
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

class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get() { return this.profile; }
  async update(_input: UpdateBusinessProfileInput) { return this.profile; }
}

/**
 * D8 (22/08/2026) -- `getById()`. ORDER-10 (05/09/2026) -- `getByIdForUpdate()`
 * también, para el guard TOCTOU de `requestInvoice()`; el fake ignora el
 * `client` (no hay lock real fuera de Postgres) y devuelve la misma orden.
 */
class FakeOrderRepository implements Pick<IOrderRepository, 'getById' | 'getByIdForUpdate'> {
  constructor(private readonly order: Order | null = null) {}
  async getById(id: string): Promise<Order | undefined> {
    return this.order && this.order.id === id ? this.order : undefined;
  }
  async getByIdForUpdate(_client: SqlClient, id: string): Promise<Order | undefined> {
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
  implements Pick<AccountsReceivableRepository, 'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId' | 'getByStayId'>
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
  /** §9.4 (13/09/2026) -- exposición de AR viva en `requestInvoice()`. */
  async getByStayId(stayId: string): Promise<AccountReceivable[]> {
    return [...this.rows.values()].filter((r) => r.stayId === stayId);
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

  describe('ORDER-10 (05/09/2026) -- guard TOCTOU: no facturar un cargo de una orden ya CANCELLED', () => {
    it('rechaza si la orden del cargo ya está CANCELLED', async () => {
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: 'ord-1' }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CANCELLED', totalAmount: 121,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: new Date(),
          completedAt: null, servedAt: null, items: [],
        } as unknown as Order,
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(/no se puede facturar un cargo de una orden cancelada/);
    });

    it('permite facturar si la orden está CONFIRMED (camino normal)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: 'ord-1' }),
        order: {
          id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CONFIRMED', totalAmount: 121,
          notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: null,
          completedAt: null, servedAt: null, items: [],
        } as unknown as Order,
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(invoice.status).toBe('ISSUED');
    });

    it('sin tx.orderId (factura directa de una reserva, sin orden) no consulta ninguna orden y no bloquea', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121, orderId: null }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(invoice.status).toBe('ISSUED');
    });
  });

  describe('RESERVA-10 (05/09/2026) -- guard TOCTOU: no facturar un cargo de una reserva ya CANCELLED', () => {
    it('rechaza si la reserva del cargo ya está CANCELLED', async () => {
      const service = buildService({
        tx: makeTx({ amount: 121, reservationId: 'res-1' }),
        reservation: { id: 'res-1', status: 'CANCELLED', resource: { name: 'Mesa 1' } } as unknown as Reservation,
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(/no se puede facturar un cargo de una reserva cancelada/);
    });

    it('permite facturar si la reserva está CONFIRMED (camino normal)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ amount: 121, reservationId: 'res-1' }),
        reservation: { id: 'res-1', status: 'CONFIRMED', resource: { name: 'Mesa 1' } } as unknown as Reservation,
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(invoice.status).toBe('ISSUED');
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
      // INVOICE-ITEM-ORIGIN-XOR-001 (11/09/2026) -- esta aserción congelaba
      // la forma INVÁLIDA (orderItemId Y reservationId no-null a la vez),
      // que Postgres rechaza con 23514 contra chk_invoice_item_origin
      // (reproducido contra Postgres real). El origen documental de esta
      // línea es el order_item -- reservationId va null, recuperable por
      // JOIN a order_items si hiciera falta (ver comentario en
      // resolveOrderItemLine()). El nombre del recurso de la reserva se
      // sigue resolviendo bien para la descripción -- eso no cambia.
      expect(items[0]).toMatchObject({ description: 'Mesa Ventana', orderItemId: expect.any(String), reservationId: null });
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

    /** Siembra las `invoice_items` de una factura ya seedeada (Nivel B). */
    function seedOriginalItems(invoiceId: string, items: Array<Partial<InvoiceItem>>): void {
      invoiceRepo.items.set(
        invoiceId,
        items.map((it, i) => ({
          id: `ii-${invoiceId}-${i}`, invoiceId,
          orderItemId: null, reservationId: null,
          description: 'linea', quantity: 1, unitPrice: 0, subtotal: 0, ivaRate: 21,
          unit: null, arcaUnitCode: null, createdAt: new Date(),
          ...it,
        })),
      );
    }

    it('bloque 1.4 -- el routing (`:357`) de una FT REFUND/ADJUSTMENT produce un cbte_tipo que F4 reconoce como NC', async () => {
      // F4 (`getIssuedCreditNoteCompensationTotal`) filtra `nc.cbte_tipo` por
      // `CBTE_TIPOS_NOTA_CREDITO`. Ese filtro es correcto sólo mientras el
      // routing de `requestInvoice()` emita una NC para toda FT revertidora.
      // Si el `if (tx.type === 'REFUND' || tx.type === 'ADJUSTMENT')` de
      // `:357` dejara de mandar a `buildCreditNote()`, o `buildCreditNote()`
      // hardcodeara otro `CbteTipo`, F4 dejaría de contar esa compensación
      // (fail-closed: la cancelación queda bloqueada de más). Este test ata
      // las dos puntas.
      seedOriginalInvoice();
      const service = buildService({
        tx: makeTx({ type: 'REFUND', amount: 100, reservationId: 'res-1', reversedInvoiceId: 'inv-original' }),
        client: fakeArcaClient({ createNextVoucher: vi.fn().mockResolvedValue(afipApprovedResponse(1)) }),
      });
      const invoiceRefund = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(CBTE_TIPOS_NOTA_CREDITO).toContain(invoiceRefund.cbteTipo);

      seedOriginalInvoice({ id: 'inv-orden-1_4', financialTransactionId: 'ft-charge-1_4' });
      const serviceAdj = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -100, orderId: 'ord-1_4', reversedInvoiceId: 'inv-orden-1_4' }),
        client: fakeArcaClient({ createNextVoucher: vi.fn().mockResolvedValue(afipApprovedResponse(1)) }),
      });
      const invoiceAdj = await serviceAdj.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(CBTE_TIPOS_NOTA_CREDITO).toContain(invoiceAdj.cbteTipo);
    });

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

    it('F2 (sub-bloque 3) -- un ADJUSTMENT sin reversedInvoiceId ya NO emite una Factura B: InvoiceNotReversibleError', async () => {
      // Divergencia intencional. Antes de F2 un ADJUSTMENT (ej. el de
      // handleReservationPriceAdjusted, que ajusta el precio de una reserva
      // y NO lleva reversedInvoiceId) caía al camino de Factura B. Ahora el
      // discriminador lo manda a buildCreditNote(), que exige la factura a
      // revertir. En la práctica no hay exposición: `POST /api/invoices` se
      // ofrece solo para tx `type === 'CHARGE'` (appfrontend cuentas-corrientes),
      // y la ruta consolidada siempre factura un CHARGE nuevo, nunca un ADJUSTMENT.
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: 30, reservationId: 'res-1', reversedInvoiceId: null }),
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

    it('reembolso total, factura Nivel A (sin invoice_items): línea sintética, CbtesAsoc a la original', async () => {
      seedOriginalInvoice(); // sin seedOriginalItems -> getItemsByInvoiceId devuelve []
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
      expect(items[0]).toMatchObject({ unitPrice: 100, subtotal: 100, reservationId: 'res-1', orderItemId: null });

      // I9 -- la NC también se audita, con SU PROPIO id (no el de la factura original).
      const entries = await auditLogRepo.findByEntity('invoices', invoice.id);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ field: 'cbteTipo', newValue: String(CBTE_TIPO_NOTA_CREDITO_B), changedBy: 'identity-1' });
    });

    it('reembolso total, factura Nivel B (con invoice_items): la NC COPIA las líneas de la original 1-a-1 (N3)', async () => {
      seedOriginalInvoice();
      seedOriginalItems('inv-original', [
        { reservationId: 'res-1', description: 'Noche 1', quantity: 1, unitPrice: 50, subtotal: 50, ivaRate: 21 },
        { reservationId: 'res-1', description: 'Noche 2', quantity: 1, unitPrice: 50, subtotal: 50, ivaRate: 21 },
      ]);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'REFUND', amount: 100, reservationId: 'res-1', reversedInvoiceId: 'inv-original' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      // totales congelados de la original, tal cual (factor = 1)
      expect(invoice.impTotal).toBe(100);
      expect(invoice.impNeto).toBe(82.64);
      expect(invoice.impIva).toBe(17.36);

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ description: 'Noche 1', unitPrice: 50, subtotal: 50, ivaRate: 21, reservationId: 'res-1', orderItemId: null });
      expect(items[1]).toMatchObject({ description: 'Noche 2', unitPrice: 50, subtotal: 50, reservationId: 'res-1' });
    });

    it('ADJUSTMENT compensatorio de orden (amount negativo, reversión total): arma la NC copiando las líneas con order_item_id', async () => {
      seedOriginalInvoice({ id: 'inv-orden', financialTransactionId: 'ft-charge-orden' });
      seedOriginalItems('inv-orden', [
        { orderItemId: 'oi-1', description: 'Café x2', quantity: 2, unitPrice: 30, subtotal: 60, ivaRate: 21 },
        { orderItemId: 'oi-2', description: 'Medialuna', quantity: 1, unitPrice: 40, subtotal: 40, ivaRate: 21 },
      ]);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -100, orderId: 'ord-1', reversedInvoiceId: 'inv-orden' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.cbteTipo).toBe(CBTE_TIPO_NOTA_CREDITO_B);
      expect(invoice.impTotal).toBe(100); // abs(-100), positivo -- el signo lo pone CbteTipo 8
      const sentRequest = createNextVoucher.mock.calls[0]![0] as { CbtesAsoc: unknown[] };
      expect(sentRequest.CbtesAsoc).toEqual([{ Tipo: CBTE_TIPO_FACTURA_B, PtoVta: 3, Nro: 42 }]);

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ orderItemId: 'oi-1', reservationId: null, description: 'Café x2', quantity: 2, subtotal: 60 });
      expect(items[1]).toMatchObject({ orderItemId: 'oi-2', reservationId: null, subtotal: 40 });
    });

    it('ADJUSTMENT de orden contra una factura sin invoice_items (Nivel A): OrderInvoiceHasNoLinesError', async () => {
      seedOriginalInvoice({ id: 'inv-orden-nivel-a' }); // sin seedOriginalItems
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -100, orderId: 'ord-1', reversedInvoiceId: 'inv-orden-nivel-a' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toThrow(OrderInvoiceHasNoLinesError);
      expect(createNextVoucher).not.toHaveBeenCalled();
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

  describe('Bloque 3.3-a (08/09/2026, gate architecture-governor) -- ADJUSTMENT parcial atribuido a UNA reserva de una consolidada', () => {
    function sum3(a: number, b: number, c: number): number {
      return Math.round((a + b + c) * 100) / 100;
    }

    function seedConsolidadaTresReservasDosTasas() {
      // 3 reservas, 2 grupos de tasa (21% y 10.5%) -- necesario para que el
      // escenario ejercite de verdad el reparto por grupo, no solo un
      // factor único (una consolidada de una sola tasa no distingue el
      // mecanismo nuevo del viejo `factor` heredado).
      seedOriginalInvoice({
        id: 'inv-consolidada', financialTransactionId: null,
        impNeto: 1100, impIva: 220.5, impTotal: 1320.5,
        afipRequest: { Iva: [{ Id: 5, BaseImp: 1000, Importe: 210 }, { Id: 4, BaseImp: 100, Importe: 10.5 }] },
      });
      seedOriginalItems('inv-consolidada', [
        { reservationId: 'res-A', description: 'Res A', subtotal: 800, unitPrice: 800, ivaRate: 21 },
        { reservationId: 'res-B', description: 'Res B', subtotal: 200, unitPrice: 200, ivaRate: 21 },
        { reservationId: 'res-C', description: 'Res C', subtotal: 100, unitPrice: 100, ivaRate: 10.5 },
      ]);
    }

    it('reconstruye EXACTAMENTE el desglose congelado -- la suma de las 3 porciones cierra con la factura original, no un factor de cabecera', async () => {
      seedConsolidadaTresReservasDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));

      async function emitFor(reservationId: string, amount: number, ftId: string) {
        const service = buildService({
          tx: makeTx({ id: ftId, type: 'ADJUSTMENT', amount: -amount, reservationId, reversedInvoiceId: 'inv-consolidada' }),
          client: fakeArcaClient({ createNextVoucher }),
        });
        return service.requestInvoice({ businessId: 'biz-1', financialTransactionId: ftId, changedBy: 'identity-1' });
      }

      const invA = await emitFor('res-A', 968, 'ft-a');     // 800 neto + 168 iva (21%)
      const invB = await emitFor('res-B', 242, 'ft-b');     // 200 neto + 42 iva (21%)
      const invC = await emitFor('res-C', 110.5, 'ft-c');   // 100 neto + 10.5 iva (10.5%)

      expect(invA).toMatchObject({ impNeto: 800, impIva: 168, impTotal: 968 });
      expect(invB).toMatchObject({ impNeto: 200, impIva: 42, impTotal: 242 });
      expect(invC).toMatchObject({ impNeto: 100, impIva: 10.5, impTotal: 110.5 });

      // LA RECONSTRUCCIÓN -- esto es lo que un `factor = amount/impTotal`
      // (rama heredada) NO puede garantizar si se aplicara acá: escalaría
      // contra el impTotal de la FACTURA ENTERA (1320.5), no contra la
      // participación real de cada reserva dentro de su grupo de tasa.
      expect(sum3(invA.impNeto, invB.impNeto, invC.impNeto)).toBe(1100);
      expect(sum3(invA.impIva, invB.impIva, invC.impIva)).toBe(220.5);
      expect(sum3(invA.impTotal, invB.impTotal, invC.impTotal)).toBe(1320.5);

      // Líneas copiadas 1-a-1 -- SOLO la de su propia reserva (N3 aplicado a la porción).
      const itemsA = await invoiceRepo.getItemsByInvoiceId(invA.id);
      expect(itemsA).toHaveLength(1);
      expect(itemsA[0]).toMatchObject({ reservationId: 'res-A', subtotal: 800, ivaRate: 21 });

      const itemsC = await invoiceRepo.getItemsByInvoiceId(invC.id);
      expect(itemsC).toHaveLength(1);
      expect(itemsC[0]).toMatchObject({ reservationId: 'res-C', subtotal: 100, ivaRate: 10.5 });

      // El Iva[] de cada NC sólo lleva SU grupo de tasa -- A y B no arrastran
      // el grupo 10.5% de C, ni viceversa.
      const sentA = createNextVoucher.mock.calls[0]![0] as { Iva?: unknown[] };
      const sentC = createNextVoucher.mock.calls[2]![0] as { Iva?: Array<{ Id: number }> };
      expect(sentA.Iva).toEqual([{ Id: 5, BaseImp: 800, Importe: 168 }]);
      expect(sentC.Iva).toEqual([{ Id: 4, BaseImp: 100, Importe: 10.5 }]);
    });

    it('BLOQUEA (RESERVATION_NOT_IN_INVOICE) -- la reserva del ADJUSTMENT no tiene ningún ítem en esta factura, nunca aproxima', async () => {
      seedConsolidadaTresReservasDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -500, reservationId: 'res-fantasma', reversedInvoiceId: 'inv-consolidada' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_ATTRIBUTION_BLOCKED' });
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('BLOQUEA (MISSING_FROZEN_IVA_ENTRY) -- la factura tiene el ítem pero afip_request.Iva[] no trae su grupo de tasa', async () => {
      seedOriginalInvoice({ id: 'inv-sin-iva-d', financialTransactionId: null, impTotal: 1000, afipRequest: { Iva: [] } });
      seedOriginalItems('inv-sin-iva-d', [{ reservationId: 'res-A', subtotal: 800, ivaRate: 21 }]);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -800, reservationId: 'res-A', reversedInvoiceId: 'inv-sin-iva-d' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_ATTRIBUTION_BLOCKED' });
    });

    it('el monto del ledger no coincide con lo atribuible -- CreditNoteAttributionMismatchError, nunca se concilia en silencio', async () => {
      seedConsolidadaTresReservasDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      // res-A atribuye 968 (ver test de reconstrucción) -- se pide 500, que
      // no coincide. Si el código escalara `factor` sobre esto en vez de
      // re-derivar y cruzar, emitiría una NC de 500 mal prorrateada en vez
      // de rechazar.
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -500, reservationId: 'res-A', reversedInvoiceId: 'inv-consolidada' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_ATTRIBUTION_MISMATCH' });
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('tope POR PAR: si ya hay NC en vuelo contra esta reserva dentro de la consolidada, rechaza aunque el tope GLOBAL tenga cupo de sobra', async () => {
      seedConsolidadaTresReservasDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -968, reservationId: 'res-A', reversedInvoiceId: 'inv-consolidada' }),
        client: fakeArcaClient({ createNextVoucher }),
      });
      // Simula que ya hay 500 en vuelo contra el PAR (inv-consolidada, res-A)
      // -- el tope GLOBAL (mock por default en 0, sobra cupo contra 1320.5)
      // no vería ningún problema; el tope POR PAR sí.
      invoiceRepo.getInFlightCreditNoteTotalForPairForUpdate = async () => 500;

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_PAIR_CAP_EXCEEDED' });
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('un ADJUSTMENT de ORDEN, reversión TOTAL, sigue sin tocar esta rama -- cae a N3 antes de llegar acá', async () => {
      // No-regresión explícita (criterio 5 del gate 08/09/2026, reconfirmada
      // por el gate de 1c-ii-b 11/09/2026 -- ahora hay DOS ramas nuevas que
      // podrían tentar a este caso, no una): un ADJUSTMENT de orden que
      // revierte el 100% de la factura sigue cayendo a N3 (copia 1-a-1 con
      // orderItemId) porque `isFullReversal` se evalúa PRIMERO en la cadena
      // if/else -- nunca llega ni a la rama de atribución por reserva
      // (`tx.reservationId != null`, que de todos modos no cumple) ni a la
      // nueva rama por orden (`tx.orderId != null`, bloque 1c-ii-b, ver el
      // test dedicado más abajo para el caso PARCIAL que sí la ejercita).
      seedOriginalInvoice({ id: 'inv-orden-3-3-a', financialTransactionId: 'ft-charge-3-3-a' });
      seedOriginalItems('inv-orden-3-3-a', [
        { orderItemId: 'oi-1', description: 'Café', quantity: 1, unitPrice: 100, subtotal: 100, ivaRate: 21 },
      ]);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -100, orderId: 'ord-1', reversedInvoiceId: 'inv-orden-3-3-a' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items[0]).toMatchObject({ orderItemId: 'oi-1', reservationId: null });
    });

    it('REFUND-ATTRIBUTION-RESIDUAL-001, RESUELTO (11/09/2026) -- consolidada que mezcla una orden y una reserva en el MISMO grupo de tasa: la NC parcial de la reserva emite por su porción real, ya no revienta con CreditNoteAttributionMismatchError', async () => {
      // Camino de PRODUCCIÓN real (no resolveOrderPairAttribution, que
      // todavía no tiene consumidor -- bloque 1b). Antes del fix de
      // distributeGroupAmount(), resolveRefundableForPair() atribuía 2420
      // a res-A en vez de su porción real (1210) porque el ítem de orden
      // sin clave en el mismo grupo de tasa (21%) se sumaba entero al
      // residuo de la única clave presente. El ledger (el ADJUSTMENT real)
      // siempre pidió 1210 -- antes del fix, el cruce
      // `amountToReverse` (1210) vs. `attribution.attributedTotal` (2420)
      // no coincidía y tiraba CreditNoteAttributionMismatchError SIEMPRE
      // que una consolidada mezclaba origen orden + reserva a la misma
      // tasa -- un camino de negocio legítimo (multirubro) quedaba
      // bloqueado por el bug, no por una razón real de negocio.
      seedOriginalInvoice({
        id: 'inv-mixta-residual', financialTransactionId: null,
        impNeto: 2000, impIva: 420, impTotal: 2420,
        afipRequest: { Iva: [{ Id: 5, BaseImp: 2000, Importe: 420 }] },
      });
      seedOriginalItems('inv-mixta-residual', [
        { reservationId: 'res-A', description: 'Res A', subtotal: 1000, unitPrice: 1000, ivaRate: 21 },
        { orderItemId: 'oi-orden-Z', description: 'Orden Z', subtotal: 1000, unitPrice: 1000, ivaRate: 21 },
      ]);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        // 1210 = 1000 neto + 210 iva -- la porción REAL de res-A, la que
        // el fix hace que resolveRefundableForPair() atribuya de verdad.
        tx: makeTx({ type: 'ADJUSTMENT', amount: -1210, reservationId: 'res-A', reversedInvoiceId: 'inv-mixta-residual' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(invoice).toMatchObject({ impNeto: 1000, impIva: 210, impTotal: 1210 });

      // La línea copiada es SOLO la de res-A -- la de la orden no se
      // arrastra (N3 aplicado a la porción, mismo criterio que el test de
      // reconstrucción de arriba).
      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ reservationId: 'res-A', subtotal: 1000, ivaRate: 21 });
    });
  });

  describe('Bloque 1c-ii-b (11/09/2026, gate architecture-governor) -- ADJUSTMENT parcial atribuido a UNA orden de una consolidada', () => {
    function seedConsolidadaTresOrdenesDosTasas() {
      // Espejo EXACTO del fixture de reservas de 3.3-a (mismos números, 2
      // grupos de tasa) -- si el mecanismo realmente es simétrico, los
      // resultados tienen que ser idénticos con `orderId` en vez de
      // `reservationId`.
      seedOriginalInvoice({
        id: 'inv-consolidada-ord', financialTransactionId: null,
        impNeto: 1100, impIva: 220.5, impTotal: 1320.5,
        afipRequest: { Iva: [{ Id: 5, BaseImp: 1000, Importe: 210 }, { Id: 4, BaseImp: 100, Importe: 10.5 }] },
      });
      seedOriginalItems('inv-consolidada-ord', [
        { orderItemId: 'oi-A', description: 'Orden A', subtotal: 800, unitPrice: 800, ivaRate: 21 },
        { orderItemId: 'oi-B', description: 'Orden B', subtotal: 200, unitPrice: 200, ivaRate: 21 },
        { orderItemId: 'oi-C', description: 'Orden C', subtotal: 100, unitPrice: 100, ivaRate: 10.5 },
      ]);
      // `invoice_items.id` es determinístico (`ii-${invoiceId}-${i}`, ver
      // seedOriginalItems) -- el fake de getOrderIdsByInvoiceItemId() lo
      // usa tal cual, mismo contrato que el productor real (JOIN por
      // order_item_id -> order_items.order_id).
      invoiceRepo.getOrderIdsByInvoiceItemId = async (invoiceId: string) => {
        if (invoiceId !== 'inv-consolidada-ord') return new Map();
        return new Map([
          ['ii-inv-consolidada-ord-0', 'ord-A'],
          ['ii-inv-consolidada-ord-1', 'ord-B'],
          ['ii-inv-consolidada-ord-2', 'ord-C'],
        ]);
      };
    }

    it('reconstruye EXACTAMENTE el desglose congelado -- mismos números que el fixture de reservas, con orderId en vez de reservationId', async () => {
      seedConsolidadaTresOrdenesDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));

      async function emitFor(orderId: string, amount: number, ftId: string) {
        const service = buildService({
          tx: makeTx({ id: ftId, type: 'ADJUSTMENT', amount: -amount, orderId, reservationId: null, reversedInvoiceId: 'inv-consolidada-ord' }),
          client: fakeArcaClient({ createNextVoucher }),
        });
        return service.requestInvoice({ businessId: 'biz-1', financialTransactionId: ftId, changedBy: 'identity-1' });
      }

      const invA = await emitFor('ord-A', 968, 'ft-a');
      const invB = await emitFor('ord-B', 242, 'ft-b');
      const invC = await emitFor('ord-C', 110.5, 'ft-c');

      expect(invA).toMatchObject({ impNeto: 800, impIva: 168, impTotal: 968 });
      expect(invB).toMatchObject({ impNeto: 200, impIva: 42, impTotal: 242 });
      expect(invC).toMatchObject({ impNeto: 100, impIva: 10.5, impTotal: 110.5 });

      const itemsA = await invoiceRepo.getItemsByInvoiceId(invA.id);
      expect(itemsA).toHaveLength(1);
      expect(itemsA[0]).toMatchObject({ orderItemId: 'oi-A', reservationId: null, subtotal: 800, ivaRate: 21 });

      const itemsC = await invoiceRepo.getItemsByInvoiceId(invC.id);
      expect(itemsC).toHaveLength(1);
      expect(itemsC[0]).toMatchObject({ orderItemId: 'oi-C', reservationId: null, subtotal: 100, ivaRate: 10.5 });

      const pairAttributionCalls = createNextVoucher.mock.calls.length;
      expect(pairAttributionCalls).toBe(3);
    });

    it('BLOQUEA (SUBJECT_NOT_IN_INVOICE) -- la orden del ADJUSTMENT no tiene ningún ítem en esta factura, nunca aproxima', async () => {
      seedConsolidadaTresOrdenesDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -500, orderId: 'ord-fantasma', reservationId: null, reversedInvoiceId: 'inv-consolidada-ord' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_ATTRIBUTION_BLOCKED' });
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('BLOQUEA (MISSING_FROZEN_IVA_ENTRY) -- la factura tiene el ítem pero afip_request.Iva[] no trae su grupo de tasa', async () => {
      seedOriginalInvoice({ id: 'inv-sin-iva-ord', financialTransactionId: null, impTotal: 1000, afipRequest: { Iva: [] } });
      seedOriginalItems('inv-sin-iva-ord', [{ orderItemId: 'oi-X', subtotal: 800, ivaRate: 21 }]);
      invoiceRepo.getOrderIdsByInvoiceItemId = async (invoiceId: string) =>
        invoiceId === 'inv-sin-iva-ord' ? new Map([['ii-inv-sin-iva-ord-0', 'ord-X']]) : new Map();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -800, orderId: 'ord-X', reservationId: null, reversedInvoiceId: 'inv-sin-iva-ord' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_ATTRIBUTION_BLOCKED' });
    });

    it('el monto del ledger no coincide con lo atribuible -- CreditNoteAttributionMismatchError, nunca se concilia en silencio', async () => {
      seedConsolidadaTresOrdenesDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -500, orderId: 'ord-A', reservationId: null, reversedInvoiceId: 'inv-consolidada-ord' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_ATTRIBUTION_MISMATCH' });
      expect(createNextVoucher).not.toHaveBeenCalled();
    });

    it('tope POR PAR: si ya hay NC en vuelo contra esta orden dentro de la consolidada, rechaza aunque el tope GLOBAL tenga cupo de sobra', async () => {
      seedConsolidadaTresOrdenesDosTasas();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -968, orderId: 'ord-A', reservationId: null, reversedInvoiceId: 'inv-consolidada-ord' }),
        client: fakeArcaClient({ createNextVoucher }),
      });
      // Corrección F1 (gate architecture-governor, review de commit) --
      // `async () => 500` (como el test espejo de reservas) no discrimina
      // el DISCRIMINADOR: un mutante que invirtiera `kind: 'ORDER'` por
      // `kind: 'RESERVATION'` en `pairAttribution` seguía viendo este test
      // en verde (la función sobreescrita ignora sus argumentos). Captura
      // real de la llamada -- el mutante ahora rompe acá.
      const pairCapCalls: Array<{ invoiceId: string; subject: { kind: 'RESERVATION' | 'ORDER'; id: string } }> = [];
      invoiceRepo.getInFlightCreditNoteTotalForPairForUpdate = async (
        _client: SqlClient, invoiceId: string, subject: { kind: 'RESERVATION' | 'ORDER'; id: string },
      ) => {
        pairCapCalls.push({ invoiceId, subject });
        return 500;
      };

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_PAIR_CAP_EXCEEDED' });
      expect(createNextVoucher).not.toHaveBeenCalled();
      expect(pairCapCalls).toHaveLength(1);
      expect(pairCapCalls[0]).toMatchObject({
        invoiceId: 'inv-consolidada-ord',
        subject: { kind: 'ORDER', id: 'ord-A' },
      });
    });

    it('consolidada que mezcla una orden y una reserva en el MISMO grupo de tasa -- la NC parcial de la orden emite por su porción real (espejo de REFUND-ATTRIBUTION-RESIDUAL-001)', async () => {
      // La reserva (sin clave desde el punto de vista de la orden) cuenta
      // en el denominador del grupo de tasa pero no recibe entrada propia
      // -- si `orderIdMap.get(i.id) ?? null` se reemplazara por un
      // `.filter()` antes de mapear, la porción de la reserva desaparecería
      // del denominador y la orden se llevaría el total del grupo entero
      // (2420 en vez de 1210, mismo bug que REFUND-ATTRIBUTION-RESIDUAL-001
      // pero del lado orden).
      seedOriginalInvoice({
        id: 'inv-mixta-residual-ord', financialTransactionId: null,
        impNeto: 2000, impIva: 420, impTotal: 2420,
        afipRequest: { Iva: [{ Id: 5, BaseImp: 2000, Importe: 420 }] },
      });
      seedOriginalItems('inv-mixta-residual-ord', [
        { orderItemId: 'oi-Z', description: 'Orden Z', subtotal: 1000, unitPrice: 1000, ivaRate: 21 },
        { reservationId: 'res-mix-ord', description: 'Res mix', subtotal: 1000, unitPrice: 1000, ivaRate: 21 },
      ]);
      invoiceRepo.getOrderIdsByInvoiceItemId = async (invoiceId: string) =>
        invoiceId === 'inv-mixta-residual-ord' ? new Map([['ii-inv-mixta-residual-ord-0', 'ord-Z']]) : new Map();
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -1210, orderId: 'ord-Z', reservationId: null, reversedInvoiceId: 'inv-mixta-residual-ord' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });
      expect(invoice).toMatchObject({ impNeto: 1000, impIva: 210, impTotal: 1210 });

      const items = await invoiceRepo.getItemsByInvoiceId(invoice.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ orderItemId: 'oi-Z', reservationId: null, subtotal: 1000, ivaRate: 21 });
    });

    it('CREDIT_NOTE_AMBIGUOUS_SUBJECT -- una fila con orderId Y reservationId no-nulos a la vez nunca se atribuye en silencio a ninguno de los dos', async () => {
      // Invariante de APLICACIÓN, no de schema (condición C2 del gate,
      // grounding auditor-circuitos-erp) -- financial_transactions no tiene
      // CHECK que impida esto. Fail-loud ANTES de cualquier rama, incluso
      // una reversión TOTAL (isFullReversal=true acá: amount=-100 contra
      // impTotal=100 por default de seedOriginalInvoice) -- el guard corre
      // antes del if/else, no depende de qué rama hubiera matcheado.
      seedOriginalInvoice({ id: 'inv-ambigua', financialTransactionId: 'ft-charge-ambigua' });
      seedOriginalItems('inv-ambigua', [{ orderItemId: 'oi-1', subtotal: 100, ivaRate: 21 }]);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -100, orderId: 'ord-ambiguo', reservationId: 'res-ambigua', reversedInvoiceId: 'inv-ambigua' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
        .rejects.toMatchObject({ code: 'CREDIT_NOTE_AMBIGUOUS_SUBJECT' });
      expect(createNextVoucher).not.toHaveBeenCalled();
    });
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

  describe('INVOICE-CHARGES-GUARD-INDIVIDUAL-01 (11/09/2026, gate architecture-governor) -- guard cruzado contra un comprobante del OTRO camino', () => {
    /** Simula lo que deja `requestConsolidatedInvoice()`: una factura SIN `financialTransactionId` propio, con `ft-1` linkeado vía `invoice_charges`. */
    function seedConsolidatedInvoiceForCharge(status: InvoiceStatus): void {
      const id = 'inv-consolidada';
      invoiceRepo.invoices.set(id, {
        id, businessId: 'biz-1', financialTransactionId: null, customerId: 'cust-empresa',
        idempotencyKey: 'invoice:consolidated:otro-lote', environment: 'homologacion', ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B,
        cbteNro: status === 'ISSUED' ? 7 : null, concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5, moneda: 'PES',
        impNeto: 826.45, impIva: 173.55, impTotal: 1000, cae: status === 'ISSUED' ? 'CAE-CONSOLIDADA' : null,
        caeVto: status === 'ISSUED' ? '2026-12-31' : null, status,
        afipContacted: true, emisorCuit: '20111111112', paymentMethod: null, cardInstallments: null,
        afipRequest: {}, afipResponse: {}, errorMessage: status === 'REJECTED' ? 'rechazado por AFIP' : null,
        createdAt: new Date(), issuedAt: status === 'ISSUED' ? new Date() : null,
      });
      invoiceRepo.charges.set('ft-1', id);
    }

    it.each(['ISSUED', 'PENDING', 'FAILED_UNCERTAIN'] as const)(
      'rechaza con InvoiceAlreadyLinkedByOtherPathError si ft-1 ya está en invoice_charges de una consolidada %s',
      async (status) => {
        seedConsolidatedInvoiceForCharge(status);
        const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
        const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

        await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }))
          .rejects.toThrow(InvoiceAlreadyLinkedByOtherPathError);
        expect(createNextVoucher).not.toHaveBeenCalled(); // rechaza ANTES de tocar AFIP
      },
    );

    it('NO rechaza si la consolidada que linkea ft-1 está REJECTED -- AFIP la rechazó, no consume el cargo (mismo estándar que Odoo/ERPNext)', async () => {
      seedConsolidatedInvoiceForCharge('REJECTED');
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(9));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.id).not.toBe('inv-consolidada'); // factura NUEVA, propia del camino individual
      expect(createNextVoucher).toHaveBeenCalledTimes(1);
    });

    it('posición del guard (load-bearing): una NC (ADJUSTMENT) que YA tiene su propia invoice PENDING sigue cayendo en retryExisting(), no en el guard cruzado', async () => {
      // Reproduce lo que dependen los 4 call-sites reales de cancelación-con-NC
      // (cancel-order-with-credit-note.service.ts / cancel-reservation-with-credit-note.service.ts):
      // un reintento del MISMO ADJUSTMENT tiene que devolver la NC ya creada
      // por ESTE camino -- idempotencyKey `invoice:ft-1` matchea ANTES
      // (:333-334) de que el guard cruzado (:335+) llegue a mirar `invoice_charges`.
      // No hace falta seedear la factura original que revierte -- retryExisting()
      // (`:1014-1032`) nunca toca `reversedInvoiceId`/tx.type, solo credentials
      // + profile + el afipRequest ya guardado en la fila existente.
      const pendingNc: Invoice = {
        id: 'inv-nc-pendiente', businessId: 'biz-1', financialTransactionId: 'ft-1', customerId: 'cust-1',
        idempotencyKey: 'invoice:ft-1', environment: 'homologacion', ptoVta: 3, cbteTipo: CBTE_TIPO_NOTA_CREDITO_B,
        cbteNro: null, concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5, moneda: 'PES',
        impNeto: 82.64, impIva: 17.36, impTotal: 100, cae: null, caeVto: null, status: 'PENDING',
        afipContacted: false, emisorCuit: '20111111112', paymentMethod: null, cardInstallments: null,
        afipRequest: {}, afipResponse: {}, errorMessage: null, createdAt: new Date(), issuedAt: null,
      };
      invoiceRepo.invoices.set(pendingNc.id, pendingNc);

      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(3));
      const service = buildService({
        tx: makeTx({ type: 'ADJUSTMENT', amount: -100, orderId: 'ord-guard-pos', reversedInvoiceId: 'inv-orden-guard-pos' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const result = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      // retryExisting() sobre un PENDING sin afipContacted SÍ reintenta contra
      // AFIP (mismo camino que el test de FAILED_UNCERTAIN sin contactar) --
      // lo que importa acá es que NO tiró InvoiceAlreadyLinkedByOtherPathError.
      expect(result.id).toBe('inv-nc-pendiente');
      expect(createNextVoucher).toHaveBeenCalledTimes(1);
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

  describe('§9.4 (13/09/2026, gate `architecture-governor`, decisión del dueño -- "Exponer, no bloquear") -- exposición de AR viva en requestInvoice()', () => {
    function makeArRow(overrides: Partial<AccountReceivable> = {}): AccountReceivable {
      return {
        id: 'ar-1', businessId: 'biz-1', stayId: 'stay-1', companyCustomerId: 'cust-empresa',
        amount: 15000, currency: 'ARS', status: 'PENDIENTE_FACTURAR', transferredBy: 'user-1',
        ...overrides,
      };
    }

    it('cargo del huésped con AR viva sobre la misma estadía -- expone accountsReceivableWarning y loguea', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      arRepo.rows.set('ar-1', makeArRow());
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ stayId: 'stay-1' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.accountsReceivableWarning).toEqual([
        { accountsReceivableId: 'ar-1', companyCustomerId: 'cust-empresa', status: 'PENDIENTE_FACTURAR', amount: 15000 },
      ]);
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]![0]).toMatchObject({ evento: 'factura_con_ar_viva', financialTransactionId: 'ft-1', stayId: 'stay-1' });
      warnSpy.mockRestore();
    });

    it('cargo del huésped SIN ninguna AR sobre la estadía -- undefined, no [], sin loguear', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ stayId: 'stay-1' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.accountsReceivableWarning).toBeUndefined();
      // No solo `undefined` -- la CLAVE tiene que estar ausente, para que
      // `res.json(invoice)` no serialice `"accountsReceivableWarning":null`
      // ni la incluya como `undefined` (JSON.stringify la omite igual, pero
      // el objeto en sí no debe cargar la propiedad -- mismo criterio que §9.2).
      expect('accountsReceivableWarning' in invoice).toBe(false);
      expect(warnSpy).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('AR REVERTIDO -- filtrada, no cuenta como viva', async () => {
      arRepo.rows.set('ar-1', makeArRow({ status: 'REVERTIDO' as unknown as AccountReceivable['status'] }));
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ stayId: 'stay-1' }),
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.accountsReceivableWarning).toBeUndefined();
    });

    it('cargo sin stayId (el CHARGE propio de la empresa, F1-Pieza 3/C1-Fase C) -- undefined, ni siquiera consulta el repo de AR', async () => {
      const getByStayIdSpy = vi.spyOn(arRepo, 'getByStayId');
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({
        tx: makeTx({ customerId: 'cust-empresa' }), // sin stayId -- makeTx() no lo setea por default
        client: fakeArcaClient({ createNextVoucher }),
      });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' });

      expect(invoice.accountsReceivableWarning).toBeUndefined();
      expect(getByStayIdSpy).not.toHaveBeenCalled();
    });

    it('tx.type ADJUSTMENT (escape de NC) con AR viva -- NO expone acá (los 2 orquestadores de §9.2 ya calculan/exponen lo mismo por su propio camino), no consulta el repo de AR', async () => {
      const getByStayIdSpy = vi.spyOn(arRepo, 'getByStayId');
      arRepo.rows.set('ar-1', makeArRow());
      const service = buildService({
        tx: makeTx({ id: 'ft-1', type: 'ADJUSTMENT', stayId: 'stay-1', reservationId: 'res-1' }),
      });

      // El resto del camino NC (buildCreditNote) no está fixtureado acá a
      // propósito -- lo único que importa para este test es que el guard
      // de §9.4 corre y decide ANTES de llegar a esa lógica, así que no
      // hace falta simular una factura original para revertir.
      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }).catch(() => {});

      expect(getByStayIdSpy).not.toHaveBeenCalled();
    });

    it('tx.type REFUND con AR viva -- NO expone acá, no consulta el repo de AR', async () => {
      const getByStayIdSpy = vi.spyOn(arRepo, 'getByStayId');
      arRepo.rows.set('ar-1', makeArRow());
      const service = buildService({
        tx: makeTx({ id: 'ft-1', type: 'REFUND', stayId: 'stay-1' }),
      });

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1', changedBy: 'identity-1' }).catch(() => {});

      expect(getByStayIdSpy).not.toHaveBeenCalled();
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
 * FACT-CONSOL-TOCTOU-01 (05/09/2026) -- a diferencia de FakeReservationRepository (una
 * sola reserva fija), el guard TOCTOU de requestConsolidatedInvoice()
 * lockea N reservas distintas por id -- acá hacen falta N reservas
 * simultáneas en el mismo fake, mismo criterio que
 * FakeMultiFinancialTransactionRepository de arriba. El `client` se
 * ignora (no hay lock real fuera de Postgres, ver el .integration.test.ts
 * para el lock real).
 */
class FakeMultiReservationRepository implements Pick<ReservationRepository, 'getById' | 'getByIdWithLock'> {
  /** ids consultados vía getByIdWithLock, en orden -- para verificar deduplicación del guard. */
  public lockCalls: string[] = [];
  constructor(private readonly reservations: Map<string, Reservation>) {}
  async getById(id: string): Promise<Reservation | undefined> { return this.reservations.get(id); }
  async getByIdWithLock(_client: SqlClient, id: string): Promise<Reservation | undefined> {
    this.lockCalls.push(id);
    return this.reservations.get(id);
  }
}

/** FACT-CONSOL-TOCTOU-01 -- mismo criterio que FakeMultiReservationRepository, para el lado órdenes del guard. */
class FakeMultiOrderRepository implements Pick<IOrderRepository, 'getById' | 'getByIdForUpdate'> {
  /** ids consultados vía getByIdForUpdate, en orden -- para verificar deduplicación del guard. */
  public lockCalls: string[] = [];
  constructor(private readonly orders: Map<string, Order>) {}
  async getById(id: string): Promise<Order | undefined> { return this.orders.get(id); }
  async getByIdForUpdate(_client: SqlClient, id: string): Promise<Order | undefined> {
    this.lockCalls.push(id);
    return this.orders.get(id);
  }
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
      /** FACT-CONSOL-TOCTOU-01 -- solo hace falta cuando algún tx.orderId/reservationId de `txs` participa del guard TOCTOU. */
      orders?: Map<string, Order>;
      reservations?: Map<string, Reservation>;
    }) {
      const invoiceRepo = new FakeInvoiceRepository();
      const arRepo = new FakeAccountsReceivableRepo();
      const auditLogRepo = new InMemoryAuditLogRepository();
      for (const ar of opts.pending) arRepo.rows.set(ar.id, ar);
      const createNextVoucher = opts.createNextVoucher ?? vi.fn().mockResolvedValue(afipApprovedResponse(99));
      const orderRepo = new FakeMultiOrderRepository(opts.orders ?? new Map());
      const reservationRepo = new FakeMultiReservationRepository(opts.reservations ?? new Map());
      const service = new InvoiceService(
        invoiceRepo,
        new FakeMultiFinancialTransactionRepository(opts.txs),
        new FakeBusinessProfileRepository(PROFILE),
        new FakeAfipCredentialsRepository(makeCredentials()),
        orderRepo,
        new FakeProductRepository(),
        new FakeProductVariantRepository(),
        reservationRepo,
        new FakeTransactionManager(),
        arRepo,
        auditLogRepo,
        () => buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher })),
      );
      return { service, invoiceRepo, arRepo, auditLogRepo, createNextVoucher, orderRepo, reservationRepo };
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

    it.each(['PENDING', 'FAILED_UNCERTAIN', 'REJECTED'] as const)(
      'rechaza (guard anti double-billing, hueco de doble comprobante 11/09/2026) si algún cargo pendiente YA tiene una fila en invoice_charges apuntando a una factura %s -- no solo ISSUED',
      async (priorStatus) => {
        // Antes del fix (bug real): el guard SOLO miraba status='ISSUED'. Una
        // factura previa PENDING (proceso murió antes de la respuesta de
        // AFIP), FAILED_UNCERTAIN (AFIP respondió ambiguo) o REJECTED (AFIP
        // la rechazó, pero invoice_charges NUNCA se borra -- ver docblock de
        // invoice.repository.ts) dejaba pasar un segundo intento hasta el
        // INSERT real, que recién ahí chocaba contra idx_invoice_charges_ft
        // con un 23505 crudo en vez de este error tipado.
        const pending = [makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 })];
        const txs = new Map([['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100 })]]);
        const { service, invoiceRepo } = buildConsolidatedService({ pending, txs });

        const priorInvoiceId = 'inv-previa';
        invoiceRepo.invoices.set(priorInvoiceId, {
          id: priorInvoiceId, businessId: 'biz-1', financialTransactionId: null, customerId: 'cust-empresa',
          idempotencyKey: 'invoice:consolidated:otra', environment: 'homologacion', ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B,
          cbteNro: null, concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5, moneda: 'PES',
          impNeto: 100, impIva: 0, impTotal: 100, cae: null, caeVto: null, status: priorStatus,
          afipContacted: true, emisorCuit: '20111111112', paymentMethod: null, cardInstallments: null,
          afipRequest: {}, afipResponse: {}, errorMessage: priorStatus === 'REJECTED' ? 'rechazado por AFIP' : null,
          createdAt: new Date(), issuedAt: null,
        });
        invoiceRepo.charges.set('ft-1', priorInvoiceId);

        await expect(service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' }))
          .rejects.toThrow(AccountsReceivableAlreadyInvoicedError);
      },
    );

    describe('FACT-CONSOL-TOCTOU-01 (05/09/2026) -- guard TOCTOU generalizado a N cargos: rechaza el lote entero si CUALQUIERA de las órdenes/reservas de origen ya está CANCELLED', () => {
      it('rechaza TODO el lote si la reserva de uno solo de los N cargos ya está CANCELLED -- no emite ningún CAE, no marca ninguna AR', async () => {
        const pending = [
          makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 }),
          makeAr({ id: 'ar-2', financialTransactionId: 'ft-2', amount: 50 }),
        ];
        const txs = new Map([
          ['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100, reservationId: 'res-1' })],
          ['ft-2', makeTx({ id: 'ft-2', customerId: 'cust-empresa', amount: 50, reservationId: 'res-2' })],
        ]);
        const reservations = new Map([
          ['res-1', { id: 'res-1', status: 'CONFIRMED', resource: { name: 'Hab 1' } } as unknown as Reservation],
          ['res-2', { id: 'res-2', status: 'CANCELLED', resource: { name: 'Hab 2' } } as unknown as Reservation],
        ]);
        const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
        const { service, arRepo } = buildConsolidatedService({ pending, txs, reservations, createNextVoucher });

        await expect(service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' }))
          .rejects.toThrow(ReservationCancelledCannotInvoiceError);

        // Rechazo del LOTE ENTERO (decisión del dueño, AskUserQuestion
        // 05/09/2026) -- ni siquiera ar-1 (cuya reserva sigue CONFIRMED) se
        // factura: no se pide CAE, ninguna de las dos filas AR se marca.
        expect(createNextVoucher).not.toHaveBeenCalled();
        expect(arRepo.rows.get('ar-1')!.status).toBe('PENDIENTE_FACTURAR');
        expect(arRepo.rows.get('ar-2')!.status).toBe('PENDIENTE_FACTURAR');
      });

      it('rechaza TODO el lote si la orden de uno de los N cargos ya está CANCELLED -- hoy ningún camino real de accounts_receivable setea orderId, pero el guard es simétrico al de requestInvoice() (paridad, no duplica lógica nueva)', async () => {
        const pending = [makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 })];
        const txs = new Map([['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100, orderId: 'ord-1' })]]);
        const orders = new Map([
          ['ord-1', { id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'CANCELLED', totalAmount: 100, notes: null, stayId: null, locationId: 'loc-1', confirmedAt: new Date(), cancelledAt: new Date(), completedAt: null, servedAt: null, items: [] } as unknown as Order],
        ]);
        const { service } = buildConsolidatedService({ pending, txs, orders });

        await expect(service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' }))
          .rejects.toThrow(OrderCancelledCannotInvoiceError);
      });

      it('permite facturar si todas las reservas involucradas siguen CONFIRMED, y lockea en orden ASCENDENTE de id sin importar el orden de llegada (fake -- el lock real está en consolidated-invoice-toctou.integration.test.ts)', async () => {
        const pending = [
          makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 }),
          makeAr({ id: 'ar-2', financialTransactionId: 'ft-2', amount: 50 }),
        ];
        // res-b llega ANTES que res-a (orden de pending/txs) -- si el guard
        // no ordenara de verdad (A8.1/A8.2) y solo reflejara el orden de
        // llegada, lockCalls saldría ['res-b', 'res-a']. La aserción de abajo
        // NO usa .sort() sobre el resultado a propósito: es lo que pinea que
        // el `.sort()` de producción (requestConsolidatedInvoice()) es real,
        // no un artefacto del orden en que este test sembró los datos.
        const txs = new Map([
          ['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100, reservationId: 'res-b' })],
          ['ft-2', makeTx({ id: 'ft-2', customerId: 'cust-empresa', amount: 50, reservationId: 'res-a' })],
        ]);
        const reservations = new Map([
          ['res-b', { id: 'res-b', status: 'CONFIRMED', resource: { name: 'Hab 1' } } as unknown as Reservation],
          ['res-a', { id: 'res-a', status: 'CONFIRMED', resource: { name: 'Hab 2' } } as unknown as Reservation],
        ]);
        const { service, reservationRepo } = buildConsolidatedService({ pending, txs, reservations });

        const invoice = await service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' });

        expect(invoice.status).toBe('ISSUED');
        expect(reservationRepo.lockCalls).toEqual(['res-a', 'res-b']);
      });

      it('deduplica: dos cargos de la MISMA reserva lockean esa reserva una sola vez', async () => {
        const pending = [
          makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 60 }),
          makeAr({ id: 'ar-2', financialTransactionId: 'ft-2', amount: 40 }),
        ];
        const txs = new Map([
          ['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 60, reservationId: 'res-1' })],
          ['ft-2', makeTx({ id: 'ft-2', customerId: 'cust-empresa', amount: 40, reservationId: 'res-1' })],
        ]);
        const reservations = new Map([
          ['res-1', { id: 'res-1', status: 'CONFIRMED', resource: { name: 'Hab 1' } } as unknown as Reservation],
        ]);
        const { service, reservationRepo } = buildConsolidatedService({ pending, txs, reservations });

        const invoice = await service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' });

        expect(invoice.status).toBe('ISSUED');
        expect(reservationRepo.lockCalls).toEqual(['res-1']);
      });

      it('sin ningún tx.orderId/reservationId en el lote, no consulta ninguna orden ni reserva y no bloquea', async () => {
        const pending = [makeAr({ id: 'ar-1', financialTransactionId: 'ft-1', amount: 100 })];
        const txs = new Map([['ft-1', makeTx({ id: 'ft-1', customerId: 'cust-empresa', amount: 100 })]]);
        const { service, orderRepo, reservationRepo } = buildConsolidatedService({ pending, txs });

        const invoice = await service.requestConsolidatedInvoice({ businessId: 'biz-1', companyCustomerId: 'cust-empresa', changedBy: 'identity-1' });

        expect(invoice.status).toBe('ISSUED');
        expect(orderRepo.lockCalls).toEqual([]);
        expect(reservationRepo.lockCalls).toEqual([]);
      });
    });
  });
});
