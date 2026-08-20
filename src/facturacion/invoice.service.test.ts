import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Arca } from '@arcasdk/core';
import { InvoiceService } from './invoice.service.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput } from './invoice.repository.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus } from './invoice.entities.js';
import type { AfipCredentialsRepository, AfipCredentials, AfipCredentialsStatus, AfipTicketCache } from './afip-credentials.repository.js';
import type { FinancialTransactionRepository, FinancialTransaction, PaymentInfo } from '../clientes-finanzas/financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import { AfipNotConfiguredError, FinancialTransactionNotFoundError, AfipRequestRejectedError, AfipRequestUncertainError } from '../domain/errors.js';
import { CBTE_TIPO_FACTURA_B } from './afip-catalog.constants.js';
import { buildArcaBillingAdapter } from './arca-sdk-billing.adapter.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeInvoiceRepository implements InvoiceRepository {
  public invoices = new Map<string, Invoice>();

  async getById(id: string) { return this.invoices.get(id) ?? null; }
  async getByIdempotencyKey(key: string) {
    return [...this.invoices.values()].find((i) => i.idempotencyKey === key) ?? null;
  }
  async getByFinancialTransactionId(ftId: string) {
    return [...this.invoices.values()].filter((i) => i.financialTransactionId === ftId);
  }
  async create(input: CreateInvoiceInput, afipRequest: unknown): Promise<Invoice> {
    const invoice: Invoice = {
      ...input,
      cbteNro: null, cae: null, caeVto: null,
      status: 'PENDING', afipContacted: false, afipRequest, afipResponse: null, errorMessage: null,
      paymentMethod: input.paymentMethod ?? null, cardInstallments: input.cardInstallments ?? null,
      createdAt: new Date(), issuedAt: null,
    };
    this.invoices.set(invoice.id, invoice);
    return invoice;
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
  async settleByOrderId(_orderId: string, _paymentInfo?: PaymentInfo) { return 0; }
  async voidByOrderId() { return 0; }
  async getNetBalanceByCustomerId() { return 0; }
  async getNetBalanceByStayId() { return 0; }
  async linkStayToReservationCharges() { return 0; }
}

class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get() { return this.profile; }
  async update(_input: UpdateBusinessProfileInput) { return this.profile; }
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

  beforeEach(() => {
    invoiceRepo = new FakeInvoiceRepository();
  });

  function buildService(opts: {
    tx?: FinancialTransaction | null;
    profile?: BusinessProfile;
    credentials?: AfipCredentials | null;
    client?: Arca;
  } = {}) {
    const client = opts.client ?? fakeArcaClient();
    return new InvoiceService(
      invoiceRepo,
      new FakeFinancialTransactionRepository(opts.tx === undefined ? makeTx() : opts.tx),
      new FakeBusinessProfileRepository(opts.profile ?? makeProfile()),
      new FakeAfipCredentialsRepository(opts.credentials === undefined ? makeCredentials() : opts.credentials),
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
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-inexistente' }))
        .rejects.toThrow(FinancialTransactionNotFoundError);
    });

    it('rechaza si falta el CUIT del negocio', async () => {
      const service = buildService({ profile: makeProfile({ taxId: null }) });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
        .rejects.toThrow(AfipNotConfiguredError);
    });

    it('rechaza si falta el punto de venta AFIP', async () => {
      const service = buildService({ profile: makeProfile({ afipSalesPoint: null }) });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
        .rejects.toThrow(AfipNotConfiguredError);
    });

    it('rechaza si todavía no se cargó el certificado AFIP', async () => {
      const service = buildService({ credentials: null });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
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
        clientFactory,
      );

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(clientFactory).toHaveBeenCalledWith(expect.anything(), '20111111112', expect.anything());
    });

    it('con afipCuit cargado, se autentica con ESE cuit, no con taxId -- no ensucia la identidad fiscal real', async () => {
      const clientFactory = vi.fn().mockReturnValue(buildArcaBillingAdapter(fakeArcaClient({ createNextVoucher: vi.fn().mockResolvedValue(afipApprovedResponse(1)) })));
      const service = new InvoiceService(
        invoiceRepo,
        new FakeFinancialTransactionRepository(makeTx()),
        new FakeBusinessProfileRepository(makeProfile({ taxId: '20111111112', afipCuit: '20333333335' })),
        new FakeAfipCredentialsRepository(makeCredentials()),
        clientFactory,
      );

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(clientFactory).toHaveBeenCalledWith(expect.anything(), '20333333335', expect.anything());
    });

    it('sin taxId NI afipCuit, rechaza (nada con qué autenticarse)', async () => {
      const service = buildService({ profile: makeProfile({ taxId: null, afipCuit: null }) });
      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
        .rejects.toThrow(AfipNotConfiguredError);
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

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

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

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(invoice.impNeto).toBe(100);
      expect(invoice.impIva).toBe(21);
      expect(invoice.impTotal).toBe(121);
    });
  });

  describe('idempotencia (A8.5/R13, clave determinística por financial_transaction_id)', () => {
    it('un segundo pedido para la MISMA financial_transaction devuelve la invoice ya creada, sin llamar de nuevo a AFIP', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      const first = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });
      const second = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(second.id).toBe(first.id);
      expect(createNextVoucher).toHaveBeenCalledTimes(1);
    });

    it('FAILED_UNCERTAIN sin haber contactado a AFIP (falla el chequeo previo al CAE) SÍ reintenta contra AFIP en el segundo pedido', async () => {
      const getLastVoucher = vi.fn()
        .mockRejectedValueOnce(new Error('timeout de red'))
        .mockResolvedValueOnce({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 });
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(11));
      const service = buildService({ client: fakeArcaClient({ getLastVoucher, createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
        .rejects.toThrow(AfipRequestUncertainError);
      const failed = await invoiceRepo.getByIdempotencyKey('invoice:ft-1');
      expect(failed?.status).toBe('FAILED_UNCERTAIN');
      expect(failed?.afipContacted).toBe(false);

      const retried = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });
      expect(retried.status).toBe('ISSUED');
      expect(retried.id).toBe(failed!.id); // misma fila, nunca una segunda
      expect(createNextVoucher).toHaveBeenCalledTimes(1);
    });

    it('FAILED_UNCERTAIN habiendo contactado a AFIP (createNextVoucher se invocó, red cortada después) NO reintenta solo -- A8.6', async () => {
      const getLastVoucher = vi.fn().mockResolvedValue({ cbteNro: 10, cbteTipo: CBTE_TIPO_FACTURA_B, ptoVta: 3 });
      const createNextVoucher = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
      const service = buildService({ client: fakeArcaClient({ getLastVoucher, createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
        .rejects.toThrow(AfipRequestUncertainError);
      const failed = await invoiceRepo.getByIdempotencyKey('invoice:ft-1');
      expect(failed?.afipContacted).toBe(true);

      const second = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });
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

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
        .rejects.toThrow(AfipRequestRejectedError);
      const rejected = await invoiceRepo.getByIdempotencyKey('invoice:ft-1');
      expect(rejected?.status).toBe('REJECTED');

      const retried = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });
      expect(retried.status).toBe('ISSUED');
      expect(retried.id).toBe(rejected!.id);
      expect(createNextVoucher).toHaveBeenCalledTimes(2);
    });
  });

  describe('emisión exitosa', () => {
    it('marca la invoice ISSUED con cbteNro/CAE/CAEFchVto de la respuesta', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(42, 'CAE-XYZ', '20261231'));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(invoice.status).toBe('ISSUED');
      expect(invoice.cbteNro).toBe(42);
      expect(invoice.cae).toBe('CAE-XYZ');
      expect(invoice.caeVto).toBe('2026-12-31');
    });

    it('sin buyer explícito, factura a Consumidor Final (DocTipo 99, sin CUIT/DNI)', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(createNextVoucher).toHaveBeenCalledWith(expect.objectContaining({ DocTipo: 99, DocNro: 0 }));
    });

    it('con buyer explícito, usa su DocTipo/DocNro/condición IVA', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipApprovedResponse(1));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      await service.requestInvoice({
        businessId: 'biz-1', financialTransactionId: 'ft-1',
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

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

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

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(invoice.paymentMethod).toBeNull();
      expect(invoice.cardInstallments).toBeNull();
    });
  });

  describe('rechazo explícito de AFIP', () => {
    it('marca REJECTED y lanza AfipRequestRejectedError con el detalle de la observación', async () => {
      const createNextVoucher = vi.fn().mockResolvedValue(afipRejectedResponse('10015: motivo de prueba'));
      const service = buildService({ client: fakeArcaClient({ createNextVoucher }) });

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
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

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
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

      await expect(service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' }))
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

      const invoice = await service.requestInvoice({ businessId: 'biz-1', financialTransactionId: 'ft-1' });

      expect(getVoucherInfo).toHaveBeenCalledWith(11, 3, CBTE_TIPO_FACTURA_B);
      expect(invoice.status).toBe('ISSUED');
      expect(invoice.cbteNro).toBe(11);
      expect(invoice.cae).toBe('CAE-RECOVERED');
    });
  });
});
