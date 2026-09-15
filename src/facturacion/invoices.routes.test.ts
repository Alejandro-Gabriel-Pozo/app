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
import { createInvoicesRouter, createAfipCredentialsRouter, requireManagementForCompanyCharge } from './invoices.routes.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';
import type { FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { Roles } from '../security/roles.js';

// F2-05 (15/09/2026): PUT/DELETE de AfipCredentialsRouter ahora pasan por
// AfipCredentialsService -> buildTenantTransactionManager(req) -- mismo mock
// que business-profile.routes.test.ts/categories.routes.test.ts: `run()`
// ejecuta el callback contra el mismo `req.db` (fakeDb) en vez de resolver
// un pool de tenant real (que no existe en este entorno de test unitario).
vi.mock('../db/tenant-context.js', () => ({
  buildTenantTransactionManager: vi.fn((req: Request) => ({
    run: vi.fn(async (fn: (client: unknown) => unknown) => fn(req.db)),
  })),
}));

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
  // stack real: mutaciones [requireModule(gate), authorize(), handler]; GET de
  // /api/invoices [authorize(), handler]. El handler final es siempre el último.
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

/**
 * Igual que `getHandler()`, pero devuelve el middleware en `index` (no el
 * handler final) -- para ejercitar `authorize(Roles.X)` de verdad y
 * confirmar el 403 real, en vez de solo el resultado del handler asumiendo
 * que la autorización ya pasó (F2-06, 15/09/2026).
 */
function getMiddlewareAt(
  router: ReturnType<typeof createInvoicesRouter> | ReturnType<typeof createAfipCredentialsRouter>,
  method: 'get' | 'post' | 'put' | 'delete',
  path: string,
  index: number,
) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[index]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void;
}

// requireModule(container, ModuleKey.FACTURACION) gatea las MUTACIONES de
// /api/invoices (POST /, POST /consolidated) y todo el router de credenciales
// AFIP; los GET de /api/invoices van SIN gate (exhibición legal de comprobantes
// ya emitidos, diseno-cascada-enforcement-2026-08-30.md §3d). El gate no se
// ejercita acá (module.middleware.ts tiene su propio test), solo hace falta que
// container exista para construir el router.
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

describe('gating de FACTURACION en el router', () => {
  it('los 4 GET de /api/invoices NO llevan el gate: stack [authorize, handler]', () => {
    const router = createInvoicesRouter(FAKE_CONTAINER) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: unknown[] } }>;
    };
    const gets = router.stack.filter((l) => l.route && l.route.methods['get']);
    // /unreconciled (10/09/2026, bandeja) -- sin gate de módulo, mismo
    // criterio que el resto de los GET de este router.
    expect(gets.map((l) => l.route!.path).sort()).toEqual(['/', '/:id', '/:id/pdf', '/unreconciled']);
    for (const l of gets) expect(l.route!.stack.length).toBe(2);
  });

  it('/unreconciled está registrada ANTES de /:id -- si no, Express la sombrea y nunca se alcanza', () => {
    const router = createInvoicesRouter(FAKE_CONTAINER) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
    };
    const paths = router.stack.filter((l) => l.route).map((l) => l.route!.path);
    expect(paths.indexOf('/unreconciled')).toBeLessThan(paths.indexOf('/:id'));
  });

  it('las mutaciones de /api/invoices SÍ llevan el gate: stack [gate, authorize, handler]', () => {
    const router = createInvoicesRouter(FAKE_CONTAINER) as unknown as {
      stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: unknown[] } }>;
    };
    const posts = router.stack.filter((l) => l.route && l.route.methods['post']);
    expect(posts.map((l) => l.route!.path).sort()).toEqual(['/', '/consolidated']);
    for (const l of posts) expect(l.route!.stack.length).toBe(3);
  });
});

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

  it('400 si falta financialTransactionId, customerId y status', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/');
    const req = { query: {}, db: fakeDb(async () => ({ rows: [] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /api/invoices?status=... -- B3 bloque 2.1 (08/09/2026, #4a)', () => {
  it('devuelve los comprobantes en ese status', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/');
    const req = { query: { status: 'PENDING' }, db: fakeDb(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain('WHERE status = $1');
      expect(params).toEqual(['PENDING']);
      return { rows: [{ ...INVOICE_ROW, status: 'PENDING', cae: null, cae_vto: null, issued_at: null }] };
    }) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'inv-1', status: 'PENDING' })]);
  });

  it('400 VALIDATION_ERROR si status no es un InvoiceStatus válido', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'get', '/');
    const req = { query: { status: 'CANCELLED' }, db: { query: vi.fn(async () => { throw new Error('no debería tocar la DB'); }) } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
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

describe('requireManagementForCompanyCharge() -- hallazgo 3 de INVOICE-CHARGES-GUARD-INDIVIDUAL-01 (13/09/2026, gate `architecture-governor`)', () => {
  function fakeFinancialTransactionRepo(tx: FinancialTransaction | null) {
    return { getById: vi.fn(async () => tx) };
  }
  function fakeCustomerRepo(customer: Customer | undefined) {
    return { getById: vi.fn(async () => customer) };
  }
  function makeTx(overrides: Partial<FinancialTransaction> = {}): FinancialTransaction {
    return {
      id: 'ft-1', businessId: 'biz-1', customerId: 'cust-empresa', type: 'CHARGE',
      amount: 1000, currency: 'ARS', status: 'SETTLED', createdAt: new Date(),
      ...overrides,
    } as FinancialTransaction;
  }
  function reqWithGroups(groups: string[]): Request {
    return { user: { id: 'identity-1', businessId: 'biz-1', permissionGroups: groups } } as unknown as Request;
  }

  it('cliente COMPANY, sin MANAGEMENT -- bloquea con 403 FORBIDDEN', async () => {
    const financialTransactionRepo = fakeFinancialTransactionRepo(makeTx());
    const customerRepo = fakeCustomerRepo(new Customer('cust-empresa', 'Empresa SA', [], 'COMPANY'));
    const req = reqWithGroups(['FRONT_DESK']);
    const res = fakeRes();

    const allowed = await requireManagementForCompanyCharge('ft-1', financialTransactionRepo, customerRepo, req, res);

    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('cliente COMPANY, con MANAGEMENT -- deja pasar', async () => {
    const financialTransactionRepo = fakeFinancialTransactionRepo(makeTx());
    const customerRepo = fakeCustomerRepo(new Customer('cust-empresa', 'Empresa SA', [], 'COMPANY'));
    const req = reqWithGroups(['FRONT_DESK', 'MANAGEMENT']);
    const res = fakeRes();

    const allowed = await requireManagementForCompanyCharge('ft-1', financialTransactionRepo, customerRepo, req, res);

    expect(allowed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('cliente INDIVIDUAL -- FRONT_DESK solo alcanza, sin regresión del mostrador normal', async () => {
    const financialTransactionRepo = fakeFinancialTransactionRepo(makeTx({ customerId: 'cust-individual' }));
    const customerRepo = fakeCustomerRepo(new Customer('cust-individual', 'Huésped', [], 'INDIVIDUAL'));
    const req = reqWithGroups(['FRONT_DESK']);
    const res = fakeRes();

    const allowed = await requireManagementForCompanyCharge('ft-1', financialTransactionRepo, customerRepo, req, res);

    expect(allowed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    // No hace falta resolver el cliente si el guard de tipo ya dejó pasar --
    // pero acá SÍ es COMPANY-candidato (CHARGE), así que el guard consulta
    // el cliente igual; lo que importa es que no bloquea.
  });

  it('tx.type REFUND -- Nota de Crédito del escape de cancelación, NO aplica el guard aunque el cliente sea COMPANY sin MANAGEMENT', async () => {
    const financialTransactionRepo = fakeFinancialTransactionRepo(makeTx({ type: 'REFUND' }));
    const customerRepo = fakeCustomerRepo(new Customer('cust-empresa', 'Empresa SA', [], 'COMPANY'));
    const req = reqWithGroups(['EMISOR_NOTA_CREDITO']);
    const res = fakeRes();

    const allowed = await requireManagementForCompanyCharge('ft-1', financialTransactionRepo, customerRepo, req, res);

    expect(allowed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    // Mutante que esto caza: si alguien saca la condición `tx.type ===
    // 'REFUND' || tx.type === 'ADJUSTMENT'`, este test empieza a fallar
    // (pasaría a exigir MANAGEMENT también acá).
    expect(customerRepo.getById).not.toHaveBeenCalled();
  });

  it('tx.type ADJUSTMENT -- mismo bypass que REFUND', async () => {
    const financialTransactionRepo = fakeFinancialTransactionRepo(makeTx({ type: 'ADJUSTMENT' }));
    const customerRepo = fakeCustomerRepo(new Customer('cust-empresa', 'Empresa SA', [], 'COMPANY'));
    const req = reqWithGroups(['EMISOR_NOTA_CREDITO']);
    const res = fakeRes();

    const allowed = await requireManagementForCompanyCharge('ft-1', financialTransactionRepo, customerRepo, req, res);

    expect(allowed).toBe(true);
    expect(customerRepo.getById).not.toHaveBeenCalled();
  });

  it('financial_transaction inexistente -- deja pasar, requestInvoice() decide el 404', async () => {
    const financialTransactionRepo = fakeFinancialTransactionRepo(null);
    const customerRepo = fakeCustomerRepo(undefined);
    const req = reqWithGroups(['FRONT_DESK']);
    const res = fakeRes();

    const allowed = await requireManagementForCompanyCharge('ft-inexistente', financialTransactionRepo, customerRepo, req, res);

    expect(allowed).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
    expect(customerRepo.getById).not.toHaveBeenCalled();
  });

  it('cliente irresoluble (inalcanzable hoy por la FK NOT NULL de schema.sql) -- fail-closed, 403', async () => {
    const financialTransactionRepo = fakeFinancialTransactionRepo(makeTx());
    const customerRepo = fakeCustomerRepo(undefined);
    const req = reqWithGroups(['MANAGEMENT']);
    const res = fakeRes();

    const allowed = await requireManagementForCompanyCharge('ft-1', financialTransactionRepo, customerRepo, req, res);

    expect(allowed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('POST /api/invoices -- guard MANAGEMENT para cliente EMPRESA, cableado en el handler real', () => {
  const COMPANY_TX_ROW = {
    id: 'ft-1', business_id: 'biz-1', customer_id: 'cust-empresa', reservation_id: null,
    order_id: null, stay_id: null, idempotency_key: null, type: 'CHARGE', amount: '1000',
    currency: 'ARS', status: 'SETTLED', notes: null, payment_method: null, shift_id: null,
    card_installments: null, card_surcharge_amount: null, confirmed_by: null,
    reversed_invoice_id: null, settled_invoice_id: null, created_at: new Date(),
  };
  const COMPANY_CUSTOMER_ROW = {
    id: 'cust-empresa', display_name: 'Empresa SA', password_hash: null, kind: 'COMPANY',
    active: true, customer_number: 1, enable_current_account: true,
    ccm_id: null, channel: null, ccm_value: null, is_primary: null, verified_at: null,
  };

  it('FRONT_DESK sin MANAGEMENT, cargo de una EMPRESA -- 403, nunca llama next() ni construye InvoiceService', async () => {
    const router = createInvoicesRouter(FAKE_CONTAINER);
    const handler = getHandler(router, 'post', '/');
    const req = {
      body: { financialTransactionId: 'ft-1' },
      user: { id: 'identity-1', businessId: 'biz-1', permissionGroups: ['FRONT_DESK'] },
      db: fakeDb(async (sql: string) => {
        if (sql.includes('FROM financial_transactions')) return { rows: [COMPANY_TX_ROW] };
        if (sql.includes('FROM customers')) return { rows: [COMPANY_CUSTOMER_ROW] };
        throw new Error(`no debería llegar acá -- requestInvoice() no debe construirse: ${sql}`);
      }),
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
    expect(next).not.toHaveBeenCalled();
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
      user: { id: 'identity-owner', businessId: 'biz-1', permissionGroups: [Roles.OWNER_ONLY] },
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
      user: { id: 'identity-owner', businessId: 'biz-1', permissionGroups: [Roles.OWNER_ONLY] },
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
    const req = {
      user: { id: 'identity-owner', businessId: 'biz-1', permissionGroups: [Roles.OWNER_ONLY] },
      // AfipCredentialsService.clear() ahora arranca con getStatus() (SELECT,
      // para armar el diff de auditoría) antes de la transacción -- necesita
      // una fila, no `{ rows: [] }` a secas (eso hacía que getStatus()
      // tirara "business_profile sin la fila 'default'").
      db: fakeDb(async (sql: string) => {
        if (sql.startsWith('SELECT')) return { rows: [{ afip_environment: 'homologacion', has_cert: true }] };
        return { rows: [] };
      }),
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });

  // F2-06 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md #1):
  // PUT/DELETE pasan de MANAGEMENT a OWNER_ONLY -- las 2 pruebas de abajo
  // ejercitan el middleware `authorize()` real (índice 1 del stack
  // [gate, authorize, handler]), no solo el handler final asumiendo que la
  // autorización ya pasó.
  describe('PUT/DELETE / -- exigen OWNER_ONLY, no alcanza con MANAGEMENT (F2-06)', () => {
    it('PUT / -- 403 si el actor tiene MANAGEMENT pero no OWNER_ONLY', () => {
      const router = createAfipCredentialsRouter(FAKE_CONTAINER);
      const authorizeMw = getMiddlewareAt(router, 'put', '/', 1);
      const req = { user: { id: 'identity-admin', businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] } } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      authorizeMw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('OWNER_ONLY') });
      expect(next).not.toHaveBeenCalled();
    });

    it('DELETE / -- 403 si el actor tiene MANAGEMENT pero no OWNER_ONLY', () => {
      const router = createAfipCredentialsRouter(FAKE_CONTAINER);
      const authorizeMw = getMiddlewareAt(router, 'delete', '/', 1);
      const req = { user: { id: 'identity-admin', businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] } } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      authorizeMw(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN', message: expect.stringContaining('OWNER_ONLY') });
      expect(next).not.toHaveBeenCalled();
    });

    it('PUT / -- deja pasar (next()) con OWNER_ONLY', () => {
      const router = createAfipCredentialsRouter(FAKE_CONTAINER);
      const authorizeMw = getMiddlewareAt(router, 'put', '/', 1);
      const req = { user: { id: 'identity-owner', businessId: 'biz-1', permissionGroups: [Roles.OWNER_ONLY] } } as unknown as Request;
      const res = fakeRes();
      const next = vi.fn();

      authorizeMw(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(res.status).not.toHaveBeenCalled();
    });
  });

  it('GET /status -- sigue alcanzando con MANAGEMENT (no escaló, no expone el secreto)', () => {
    const router = createAfipCredentialsRouter(FAKE_CONTAINER);
    const authorizeMw = getMiddlewareAt(router, 'get', '/status', 1);
    const req = { user: { id: 'identity-admin', businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    authorizeMw(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.status).not.toHaveBeenCalled();
  });
});
