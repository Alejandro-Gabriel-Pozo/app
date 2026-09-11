import { describe, it, expect, vi } from 'vitest';
import { InvoicePdfService } from './invoice-pdf.service.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput } from './invoice.repository.js';
import type { Invoice, CreateInvoiceInput, CreateInvoiceItemInput, InvoiceItem, InvoiceStatus } from './invoice.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';
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
  /** D8-Nivel B (23/08/2026) -- `items` vacío (default) = factura Nivel A, sin líneas reales. */
  constructor(private readonly invoice: Invoice | null, private readonly items: InvoiceItem[] = []) {}
  async getById(id: string) { return this.invoice?.id === id ? this.invoice : null; }
  async getByIdempotencyKey() { return null; }
  async getByFinancialTransactionId() { return []; }
  async getInvoicedFinancialTransactionIds() { return new Set<string>(); }
  async getFinancialTransactionIdsCoveredByConsolidated() { return new Set<string>(); } // Bloque 2 (11/09/2026) -- sin caller en este test
  async getConsolidatedInvoiceIdsForFinancialTransactions() { return new Map<string, string>(); } // INVOICE-CHARGES-BUTTON-DEADEND-01 (11/09/2026) -- sin caller en este test
  async getByReservationId() { return []; }
  async getOutstandingByCustomerId() { return []; }
  async getOutstandingForUpdate() { return 0; }
  async getRefundableForUpdate() { return 0; }
  async getIssuedCreditNoteCompensationTotal() { return 0; } // ADR común cancelar-con-NC (F4)
  async getInFlightCreditNoteTotalForUpdate() { return 0; } // bloque 2.4 (tope N5) -- sin caller en este test
  async getInFlightCreditNoteTotalForPairForUpdate() { return 0; } // bloque 3.3-a -- sin caller en este test
  async getByCustomerId() { return []; } // O2-F2 (03/09/2026)
  async getByStatus() { return []; } // B3 bloque 2.1 (08/09/2026) -- sin caller en este test
  async resolveInvoiceLinkage() { return { kind: 'NONE' as const }; }
  async create(_input: CreateInvoiceInput, _afipRequest: unknown, _items: CreateInvoiceItemInput[]): Promise<Invoice> { throw new Error('no usado en este test'); }
  async createWithClient(_client: SqlClient, _input: CreateInvoiceInput, _afipRequest: unknown, _items: CreateInvoiceItemInput[]): Promise<Invoice> { throw new Error('no usado en este test'); }
  async markIssued(_id: string, _data: MarkIssuedInput): Promise<Invoice> { throw new Error('no usado en este test'); }
  async markFailed(_id: string, _data: MarkFailedInput): Promise<Invoice> { throw new Error('no usado en este test'); }
  async getStatus(): Promise<InvoiceStatus | null> { return this.invoice?.status ?? null; }
  async getItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]> { return this.invoice?.id === invoiceId ? this.items : []; }
  async getOrderIdsByInvoiceItemId() { return new Map<string, string>(); } // 1c-ii-a (11/09/2026) -- sin caller en este test
  async getChargeIdsForInvoice() { return []; } // ADR común cancelar-con-NC (N1.a iii) -- sin caller en este test
  async classifyOrderLiveInvoice(): Promise<'RECONCILED' | 'NOT_RECONCILED'> { return 'NOT_RECONCILED'; } // sub-bloque 5 (b) -- sin caller acá
  async classifyReservationLiveInvoice(): Promise<'RECONCILED' | 'NOT_RECONCILED'> { return 'NOT_RECONCILED'; } // bloque 3.3-d -- sin caller acá
  async listUnreconciledLiveInvoices() { return []; } // bandeja -- sin caller acá
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
    paymentMethod: null, cardInstallments: null,
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
    defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
    maintenanceHorizonDays: 30,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

function buildService(opts: { invoice: Invoice | null; profile?: BusinessProfile; items?: InvoiceItem[] }) {
  return new InvoicePdfService(
    new FakeInvoiceRepository(opts.invoice, opts.items ?? []),
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

// ---------------------------------------------------------------------------
// Regresión (19/08/2026): el PDF descargado en producción no abría --
// "page.pdf()" de Puppeteer devuelve Uint8Array en runtime (@arcasdk/pdf
// declara Buffer pero no lo es), y Express.res.send() solo reconoce un
// Buffer.isBuffer() real como binario -- con un Uint8Array crudo cae a
// res.json(), que serializa cada byte como clave de un objeto
// ({"0":37,"1":80,...}) en vez de mandar el archivo. Se mockea
// @arcasdk/pdf devolviendo un Uint8Array puro (lo que realmente hace
// Puppeteer) para no depender de Chromium instalado en esta suite.
// ---------------------------------------------------------------------------
const generateSpy = vi.fn(async (_data: unknown) => new Uint8Array([0x25, 0x50, 0x44, 0x46])); // "%PDF" -- no un Buffer real

vi.mock('@arcasdk/pdf', () => ({
  InvoicePdfGenerator: class {
    async generate(data: unknown) {
      return generateSpy(data);
    }
  },
}));

describe('InvoicePdfService -- el resultado siempre es un Buffer real', () => {
  it('convierte el Uint8Array que devuelve @arcasdk/pdf a un Buffer de Node', async () => {
    const service = buildService({ invoice: makeInvoice() });

    const result = await service.generate('inv-1');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.subarray(0, 4).toString()).toBe('%PDF');
  });
});

// Regresión (19/08/2026, auditoría de producto): financial_transactions ya
// tenía forma de pago completa pero el comprobante nunca la mostraba.
describe('InvoicePdfService -- condicionVenta (forma de pago congelada)', () => {
  it('CARD con cuotas: arma el label con la cantidad de cuotas', async () => {
    const service = buildService({ invoice: makeInvoice({ paymentMethod: 'CARD', cardInstallments: 6 }) });

    await service.generate('inv-1');

    expect(generateSpy).toHaveBeenCalledWith(expect.objectContaining({
      condicionVenta: 'Tarjeta de Crédito/Débito (6 cuotas)',
    }));
  });

  it('sin forma de pago cargada en la transacción de origen: condicionVenta ausente, no un string vacío', async () => {
    const service = buildService({ invoice: makeInvoice({ paymentMethod: null, cardInstallments: null }) });

    await service.generate('inv-1');

    const data = generateSpy.mock.calls.at(-1)![0] as Record<string, unknown>;
    expect('condicionVenta' in data).toBe(false);
  });
});

// D8-Nivel B (23/08/2026, docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md)
describe('InvoicePdfService -- D8-Nivel B (líneas reales vs. fallback Nivel A)', () => {
  it('con invoice_items reales, arma items[] con los productos reales, no el ítem sintético por tasa', async () => {
    const service = buildService({
      invoice: makeInvoice(),
      items: [
        {
          id: 'ii-1', invoiceId: 'inv-1', orderItemId: 'oi-1', reservationId: null,
          description: 'Coca-Cola 500ml', quantity: 2, unitPrice: 50, subtotal: 100,
          ivaRate: 21, unit: 'unidad', arcaUnitCode: 7, createdAt: new Date(),
        },
      ],
    });

    await service.generate('inv-1');

    const data = generateSpy.mock.calls.at(-1)![0] as { items: unknown[] };
    expect(data.items).toEqual([{
      descripcion: 'Coca-Cola 500ml', cantidad: 2, unidadMedida: 'unidad',
      precioUnitario: 50, subtotal: 100, alicuotaIva: 21,
    }]);
  });

  it('sin invoice_items (factura Nivel A, vieja), sigue mostrando el ítem agrupado por tasa -- sin reconstrucción retroactiva', async () => {
    const service = buildService({
      invoice: makeInvoice({ afipRequest: { Iva: [{ Id: 5, BaseImp: 100, Importe: 21 }] } }),
      items: [],
    });

    await service.generate('inv-1');

    const data = generateSpy.mock.calls.at(-1)![0] as { items: Array<{ descripcion: string }> };
    expect(data.items).toHaveLength(1);
    expect(data.items[0]?.descripcion).toContain('21%');
  });
});
