import { describe, it, expect } from 'vitest';
import { InvoicePdfService } from './invoice-pdf.service.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput } from './invoice.repository.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus } from './invoice.entities.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';
import type { CustomerRepository } from '../clientes-finanzas/customer.repository.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { InvoiceNotFoundError, InvoiceNotIssuedError } from '../domain/errors.js';
import { CBTE_TIPO_FACTURA_B, CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL, CONCEPTO_SERVICIOS, DOC_TIPO_CONSUMIDOR_FINAL } from './afip-catalog.constants.js';

// ---------------------------------------------------------------------------
// Fakes -- solo lo que InvoicePdfService toca. No se invoca el generador
// real (Puppeteer) en este archivo: eso ya se verificó a mano contra un
// fixture real (ver pendientes-2026-08-18.md) -- acá se cubren los guards
// de "no hay nada que imprimir todavía", que sí son lógica propia.
// ---------------------------------------------------------------------------

class FakeInvoiceRepository implements InvoiceRepository {
  constructor(private readonly invoice: Invoice | null) {}
  async getById(id: string) { return this.invoice?.id === id ? this.invoice : null; }
  async getByIdempotencyKey() { return null; }
  async getByFinancialTransactionId() { return []; }
  async create(_input: CreateInvoiceInput): Promise<Invoice> { throw new Error('no usado en este test'); }
  async markIssued(_id: string, _data: MarkIssuedInput): Promise<Invoice> { throw new Error('no usado en este test'); }
  async markFailed(_id: string, _data: MarkFailedInput): Promise<Invoice> { throw new Error('no usado en este test'); }
  async getStatus(): Promise<InvoiceStatus | null> { return this.invoice?.status ?? null; }
}

class FakeBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly profile: BusinessProfile) {}
  async get() { return this.profile; }
  async update(_input: UpdateBusinessProfileInput) { return this.profile; }
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date('2026-08-19T12:00:00Z');
  return {
    id: 'inv-1', businessId: 'biz-1', financialTransactionId: 'ft-1', customerId: 'cust-1',
    idempotencyKey: 'invoice:ft-1', environment: 'homologacion',
    ptoVta: 3, cbteTipo: CBTE_TIPO_FACTURA_B, cbteNro: 1,
    concepto: CONCEPTO_SERVICIOS, docTipo: DOC_TIPO_CONSUMIDOR_FINAL, docNro: '0',
    condicionIvaReceptorId: CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL,
    moneda: 'PES', impNeto: 100, impIva: 21, impTotal: 121,
    cae: 'CAE-123', caeVto: '2026-09-01',
    status: 'ISSUED', afipContacted: true, emisorCuit: '20111111112',
    afipRequest: {}, afipResponse: {}, errorMessage: null,
    createdAt: now, issuedAt: now,
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

function buildService(opts: { invoice: Invoice | null; profile?: BusinessProfile }) {
  return new InvoicePdfService(
    new FakeInvoiceRepository(opts.invoice),
    new FakeBusinessProfileRepository(opts.profile ?? makeProfile()),
    { getById: async () => new Customer('cust-1', 'Juan Garcia', 'juan@example.com') } as unknown as CustomerRepository,
  );
}

describe('InvoicePdfService -- guards antes de generar (sin invocar Puppeteer)', () => {
  it('rechaza si el comprobante no existe', async () => {
    const service = buildService({ invoice: null });
    await expect(service.generate('inv-inexistente')).rejects.toThrow(InvoiceNotFoundError);
  });

  it('rechaza si el comprobante todavía no tiene CAE (PENDING)', async () => {
    const service = buildService({ invoice: makeInvoice({ status: 'PENDING', cae: null, cbteNro: null, caeVto: null }) });
    await expect(service.generate('inv-1')).rejects.toThrow(InvoiceNotIssuedError);
  });

  it('rechaza si el comprobante quedó FAILED_UNCERTAIN (sin CAE real)', async () => {
    const service = buildService({ invoice: makeInvoice({ status: 'FAILED_UNCERTAIN', cae: null, cbteNro: null, caeVto: null }) });
    await expect(service.generate('inv-1')).rejects.toThrow(InvoiceNotIssuedError);
  });
});
