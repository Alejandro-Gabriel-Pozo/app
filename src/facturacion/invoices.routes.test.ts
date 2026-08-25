/**
 * @file invoices.routes.test.ts
 * @description I7 (24/08/2026) -- 0% de cobertura de rutas. La lógica de
 * negocio completa de emisión (Factura B, Nota de Crédito C2, consolidada
 * C1-Fase C, auditoría I9) ya está cubierta a fondo en
 * invoice.service.test.ts -- acá el gap real es la CAPA HTTP: validación de
 * body (Zod), 404, y el mapeo status/body de cada endpoint.
 *
 * `buildInvoiceService(req)` arma ~10 repos SQL inline desde `req.db`
 * (financial-transaction, business-profile, afip-credentials, order,
 * product, product-variant, reservation, resource, accounts-receivable,
 * audit-log) -- mockear el camino feliz completo de POST /
 * requestInvoice() acá sería reimplementar todo ese wiring a mano sin
 * agregar señal real (ya está probado en invoice.service.test.ts con fakes
 * apropiados). Por eso este archivo prioriza: validación Zod (no llega a
 * tocar la DB), 404/validación de los GET (SqlInvoiceRepository sí es
 * fakeable con un `req.db.query` simple), y el router de AfipCredentials
 * completo (una sola tabla, fakeable igual de simple). GET /:id/pdf
 * (Puppeteer real) queda fuera a propósito -- ver el reporte del fork.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createInvoicesRouter, createAfipCredentialsRouter } from './invoices.routes.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(
  router: ReturnType<typeof createInvoicesRouter> | ReturnType<typeof createAfipCredentialsRouter>,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  // stack real: [requireModule(gate), authorize(), handler] -- el handler final es siempre el último.
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

// requireModule(container, ModuleKey.FACTURACION) es el primer layer de
// TODAS las rutas de este archivo -- no se ejercita acá (module.middleware.ts
// ya tiene su propio test), solo hace falta que container exista para
// construir el router.
const FAKE_CONTAINER = {} as AppContainer;

function fakeDb(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return { query: vi.fn(queryImpl) };
}

const INVOICE_ROW = {
  id: 'inv-1', business_id: 'biz-1', financial_transaction_id: 'ft-1', customer_id: 'cust-1',
  idempotency_key: 'invoice:ft-1', environment: 'homologacion', pto_vta: 3, cbte_tipo: 6,
  cbte_nro: '42', concepto: 2, doc_tipo: 99, doc_nro: '0', condicion_iva_receptor_id: 5,
  moneda: 'PES', imp_neto: '82.64', imp_iva: '17.36', imp_total: '100',
  cae: 'CAE-1', cae_vto: new Date('2026-09-01'), status: 'ISSUED', afip_contacted: true,
  emisor_cuit: '20111111112', payment_method: null, card_installments: null,
  afip_request: {}, afip_response: {}, error_message: null,
  created_at: new Date(), issued_at: new Date(),
};

describe('GET /api/invoices/:id', () => {
  it('devuelve el comprobante', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/:id');
    const req = { params: { id: 'inv-1' }, db: fakeDb(async () => ({ rows: [INVOICE_ROW] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'inv-1', cbteTipo: 6, status: 'ISSUED' }));
  });

  it('404 INVOICE_NOT_FOUND si no existe', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/:id');
    const req = { params: { id: 'inv-inexistente' }, db: fakeDb(async () => ({ rows: [] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({ code: 'INVOICE_NOT_FOUND' });
  });
});

describe('GET /api/invoices?financialTransactionId=...', () => {
  it('devuelve los comprobantes de esa transacción', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/');
    const req = { query: { financialTransactionId: 'ft-1' }, db: fakeDb(async () => ({ rows: [INVOICE_ROW] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'inv-1' })]);
  });

  it('400 si falta financialTransactionId', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/');
    const req = { query: {}, db: fakeDb(async () => ({ rows: [] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('POST /api/invoices -- validación de body (Zod)', () => {
  it('400 si falta financialTransactionId, nunca llega a construir InvoiceService', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'post', '/');
    // req.db explota si algo llega a usarlo -- confirma que Zod cortó antes.
    const req = {
      body: {}, user: { id: 'identity-1', businessId: 'biz-1' },
      db: { query: vi.fn(async () => { throw new Error('no debería tocar la DB'); }) },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('400 si buyer.docTipo no es un entero positivo', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'post', '/');
    const req = {
      body: { financialTransactionId: 'ft-1', buyer: { docTipo: -1, docNro: '20111111112', condicionIvaReceptorId: 5 } },
      user: { id: 'identity-1', businessId: 'biz-1' },
      db: { query: vi.fn(async () => { throw new Error('no debería tocar la DB'); }) },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('POST /api/invoices/consolidated -- validación de body (Zod)', () => {
  it('400 si falta companyCustomerId', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'post', '/consolidated');
    const req = {
      body: {}, user: { id: 'identity-1', businessId: 'biz-1' },
      db: { query: vi.fn(async () => { throw new Error('no debería tocar la DB'); }) },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// createAfipCredentialsRouter -- cuelga de /api/business-profile/afip-credentials.
// ---------------------------------------------------------------------------

describe('AfipCredentialsRouter', () => {
  const ORIGINAL_KEY = process.env.DB_ENCRYPTION_KEY;
  // deriveEncryptionKey() (tenant-db.setup.ts) exige 32 bytes en HEX (64
  // caracteres 0-9a-f) -- 'x' no es un dígito hex válido, Buffer.from(...,
  // 'hex') lo trunca a 0 bytes y explota "debe ser 32 bytes en hex".
  beforeAll(() => { process.env.DB_ENCRYPTION_KEY = 'a'.repeat(64); });
  afterAll(() => {
    if (ORIGINAL_KEY !== undefined) process.env.DB_ENCRYPTION_KEY = ORIGINAL_KEY;
    else delete process.env.DB_ENCRYPTION_KEY;
  });

  it('GET /status -- configured:true si hay cert+key cargados', async () => {
    const router = createAfipCredentialsRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/status');
    const req = { db: fakeDb(async () => ({ rows: [{ afip_environment: 'homologacion', has_cert: true }] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith({ configured: true, environment: 'homologacion' });
  });

  it('GET /status -- configured:false si no hay nada cargado', async () => {
    const router = createAfipCredentialsRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/status');
    const req = { db: fakeDb(async () => ({ rows: [{ afip_environment: null, has_cert: false }] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith({ configured: false, environment: null });
  });

  it('PUT / -- guarda cert/key/environment y devuelve el status actualizado', async () => {
    const router = createAfipCredentialsRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'put', '/');
    const req = {
      body: { cert: 'CERT-PEM', key: 'KEY-PEM', environment: 'homologacion' },
      db: fakeDb(async (sql: string) => {
        if (sql.startsWith('SELECT')) return { rows: [{ afip_environment: 'homologacion', has_cert: true }] };
        return { rows: [] };
      }),
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith({ configured: true, environment: 'homologacion' });
  });

  it('PUT / -- 400 si falta el certificado', async () => {
    const router = createAfipCredentialsRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'put', '/');
    const req = {
      body: { key: 'KEY-PEM', environment: 'homologacion' },
      db: { query: vi.fn(async () => { throw new Error('no debería tocar la DB'); }) },
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('DELETE / -- limpia las credenciales con 204', async () => {
    const router = createAfipCredentialsRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'delete', '/');
    const req = { db: fakeDb(async () => ({ rows: [] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });
});
