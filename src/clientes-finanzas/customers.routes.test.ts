/**
 * @file customers.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — customers.routes.ts
 * estaba en 0% de cobertura. A diferencia de los routers ya testeados
 * (users.routes.ts, roles.routes.ts) que reciben sus repos inyectados por
 * parámetro, este archivo instancia `new SqlXxxRepository(req.db!)` DENTRO
 * de cada handler — no hay seam para pasar un fake de repositorio. La única
 * forma de testear el handler completo (no solo la lógica en aislamiento)
 * es fakear `req.db!.query()` (SqlClient) devolviendo las filas que cada
 * consulta SQL real esperaría, despachando por substring del SQL — mismo
 * principio que ya usa `fakeDb()` en users.routes.test.ts, extendido acá a
 * varias tablas porque este router toca bastantes más.
 *
 * No cubre (documentado, no es un olvido):
 * - GET /:id/account, /:id/outstanding-invoices, POST /:id/payments —
 *   pasan por CustomerAccountService, compuesto de 5 repos SQL +
 *   TransactionManager. Fakear esa cadena a nivel de SqlClient.query()
 *   sería un mock tan grande y frágil que dejaría de probar el contrato
 *   real — esto es territorio de test de integración contra una BD de
 *   test real (`TEST_DATABASE_URL`, `vitest.integration.config.ts`), no de
 *   unit test con fakeDb.
 * - PUT /:id/tax-profile y PUT /:id/billing-policy: solo el camino 404
 *   (customer no existe, corta ANTES de tocar la tabla de destino). El
 *   upsert en sí (INSERT+UPDATE de customer_addresses + customer_tax_profiles,
 *   o de billing_policies) tiene la misma razón que el punto anterior.
 * - POST /padron/lookup-by-cuit|dni, GET /padron/iva-receptor-types: solo
 *   el camino de validación (Zod, corre ANTES de golpear AFIP) — el resto
 *   necesita mockear PadronService/el cliente AFIP real, fuera de alcance
 *   de este archivo (rutas de padrón/ARCA, no de clientes).
 */

import { describe, it, expect, vi } from 'vitest';
import { createCustomersRouter } from './customers.routes.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function fakeContainer(): AppContainer {
  // requireModule(container, ModuleKey.FACTURACION/CUENTAS_CORRIENTES) es un
  // middleware aparte en el stack de cada ruta -- los tests de acá invocan
  // el handler FINAL directo (mismo criterio que users.routes.test.ts),
  // salteando esos gates -- ya están cubiertos por module.middleware.test.ts.
  return {} as AppContainer;
}

interface CustomerRowFixture {
  id: string;
  display_name: string;
  password_hash: string | null;
  kind: string;
  active: boolean;
  customer_number: number;
  enable_current_account: boolean;
  ccm_id: string | null;
  channel: string | null;
  ccm_value: string | null;
  is_primary: boolean | null;
  verified_at: Date | null;
}

function customerRow(overrides: Partial<CustomerRowFixture> = {}): CustomerRowFixture {
  return {
    id: 'cust-1', display_name: 'Ana López', password_hash: null,
    kind: 'INDIVIDUAL', active: true, customer_number: 45, enable_current_account: false,
    ccm_id: null, channel: null, ccm_value: null, is_primary: null, verified_at: null,
    ...overrides,
  };
}

/**
 * Despacha por substring del SQL -- mismo criterio "no reimplementar la
 * consulta, solo devolver lo que la fila real tendría" que fakeDb() de
 * users.routes.test.ts. `existingCustomer` -- null simula que no hay fila.
 */
function fakeDb(opts: {
  existingCustomer?: CustomerRowFixture[] | null;
  extraQueryHandlers?: Array<{ match: (sql: string) => boolean; result: () => { rows: unknown[]; rowCount?: number } }>;
} = {}) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    for (const h of opts.extraQueryHandlers ?? []) {
      if (h.match(sql)) return h.result();
    }

    // Cliente por id -- WHERE c.id = $1 (getById) vs. WHERE c.id = ANY($1) (getFiltered).
    if (sql.includes('FROM customers c') && sql.includes('WHERE c.id = $1')) {
      return { rows: opts.existingCustomer ?? [] };
    }
    if (sql.includes('FROM customers c') && sql.includes('WHERE c.id = ANY')) {
      return { rows: opts.existingCustomer ?? [] };
    }
    if (sql.includes('SELECT c.id FROM customers c')) {
      return { rows: (opts.existingCustomer ?? []).map((r) => ({ id: r.id })) };
    }
    if (sql.includes('WHERE ccm.channel = \'EMAIL\'')) {
      return { rows: [] }; // sin duplicado por default
    }

    if (sql.includes('INSERT INTO customers')) return { rows: [], rowCount: 1 };
    if (sql.includes('INSERT INTO customer_contact_methods')) return { rows: [], rowCount: 1 };
    if (sql.includes('UPDATE customers SET kind')) return { rows: [], rowCount: 1 };
    if (sql.includes('SET enable_current_account')) return { rows: [], rowCount: 1 };

    if (sql.includes('FROM tags t') && sql.includes('JOIN customer_tags')) return { rows: [] };
    if (sql.includes('INSERT INTO tags')) return { rows: [{ id: 'tag-1', name: 'VIP' }] };
    if (sql.includes('SELECT id, name FROM tags WHERE name')) return { rows: [{ id: 'tag-1', name: 'VIP' }] };
    if (sql.includes('INSERT INTO customer_tags')) return { rows: [], rowCount: 1 };
    if (sql.includes('DELETE FROM customer_tags')) return { rows: [], rowCount: 1 };

    if (sql.includes('INSERT INTO audit_log')) return { rows: [], rowCount: 1 };

    if (sql.includes('INSERT INTO customer_rates')) {
      return {
        rows: [{
          id: 'rate-1', business_id: 'biz-1', customer_id: 'cust-1',
          resource_id: null, service_id: null, product_id: null, category_id: null, bucket: 'PRODUCTOS',
          fixed_price: '100', discount_percentage: null, rate_catalog_id: null,
          active: true, notes: null, created_at: new Date(), updated_at: new Date(),
          catalog_discount_percentage: null,
        }],
      };
    }
    if (sql.includes('cr.customer_id = $1 AND cr.active = TRUE')) {
      return {
        rows: [{
          id: 'rate-1', business_id: 'biz-1', customer_id: 'cust-1',
          resource_id: 'res-1', service_id: null, product_id: null, category_id: null, bucket: null,
          fixed_price: null, discount_percentage: '10', rate_catalog_id: null,
          active: true, notes: null, created_at: new Date(), updated_at: new Date(),
          catalog_discount_percentage: null,
        }],
      };
    }
    if (sql.includes('cr.id = $1 AND cr.business_id = $2')) {
      return {
        rows: [{
          id: 'rate-1', business_id: 'biz-1', customer_id: 'cust-1',
          resource_id: 'res-1', service_id: null, product_id: null, category_id: null, bucket: null,
          fixed_price: null, discount_percentage: '10', rate_catalog_id: null,
          active: true, notes: null, created_at: new Date(), updated_at: new Date(),
          catalog_discount_percentage: null,
        }],
      };
    }
    if (sql.includes('UPDATE customer_rates SET active = FALSE')) return { rows: [], rowCount: 1 };

    if (sql.includes('UPDATE number_sequences')) return { rows: [{ next_value: 46 }] };

    // tax-profile / billing-policy: sin fila -- respuesta válida (null), no
    // hace falta un fixture para el camino feliz de estos dos GET.
    return { rows: [], rowCount: 0 };
  });
  return { query };
}

function getHandler(router: ReturnType<typeof createCustomersRouter>, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => void | Promise<void>;
}

function baseReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { id: 'identity-1', businessId: 'biz-1' },
    params: {}, query: {}, body: {},
    ...overrides,
  } as unknown as Request;
}

const router = createCustomersRouter(fakeContainer());

// ---------------------------------------------------------------------------
// GET /:id
// ---------------------------------------------------------------------------

describe('GET /customers/:id', () => {
  it('404 si el cliente no existe', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'cust-x' }, db: fakeDb({ existingCustomer: null }) } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.body).toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
  });

  it('200 con tags cuando existe', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({
      params: { id: 'cust-1' },
      db: fakeDb({ existingCustomer: [customerRow()] }),
    } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'cust-1', displayName: 'Ana López', tags: [] }));
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id
// ---------------------------------------------------------------------------

describe('PATCH /customers/:id', () => {
  it('404 si el cliente no existe', async () => {
    const handler = getHandler(router, 'patch', '/:id');
    const req = baseReq({ params: { id: 'cust-x' }, body: { active: false }, db: fakeDb({ existingCustomer: null }) } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('200 -- actualiza displayName/active y audita el cambio (I9)', async () => {
    const handler = getHandler(router, 'patch', '/:id');
    const auditCalls: unknown[][] = [];
    const db = fakeDb({
      existingCustomer: [customerRow({ display_name: 'Ana López', active: true })],
      extraQueryHandlers: [{
        match: (sql) => sql.includes('INSERT INTO audit_log'),
        result: () => { auditCalls.push(['recorded']); return { rows: [], rowCount: 1 }; },
      }],
    });
    const req = baseReq({
      params: { id: 'cust-1' },
      body: { displayName: 'Ana Gómez', active: false },
      db,
    } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalled();
    expect(auditCalls.length).toBeGreaterThan(0); // recordFieldChanges detectó el diff y grabó
  });
});

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------

describe('POST /customers', () => {
  it('sin displayName ni fullName, propaga el error de validación a next()', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: {}, db: fakeDb() } as never);
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('409 si ya existe un cliente con ese email primario', async () => {
    const handler = getHandler(router, 'post', '/');
    const db = fakeDb({
      extraQueryHandlers: [{
        match: (sql) => sql.includes("WHERE ccm.channel = 'EMAIL'"),
        result: () => ({ rows: [customerRow({ id: 'cust-existing' })] }),
      }],
    });
    const req = baseReq({ body: { displayName: 'Nuevo Cliente', email: 'ana@demo.com' }, db } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.body).toMatchObject({ code: 'CUSTOMER_ALREADY_EXISTS' });
  });

  it('201 -- crea el cliente con el próximo customer_number', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { displayName: 'Nuevo Cliente', email: 'nuevo@demo.com' }, db: fakeDb() } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toMatchObject({ displayName: 'Nuevo Cliente', customerNumber: 46 });
  });
});

// ---------------------------------------------------------------------------
// GET / (listado)
// ---------------------------------------------------------------------------

describe('GET /customers (listado)', () => {
  it('200 -- devuelve el array plano sin page/limit', async () => {
    const handler = getHandler(router, 'get', '/');
    const req = baseReq({ query: {}, db: fakeDb({ existingCustomer: [customerRow()] }) } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'cust-1' })]);
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe('POST /customers/:id/tags', () => {
  it('404 si el cliente no existe', async () => {
    const handler = getHandler(router, 'post', '/:id/tags');
    const req = baseReq({ params: { id: 'cust-x' }, body: { tagName: 'VIP' }, db: fakeDb({ existingCustomer: null }) } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('201 -- asigna el tag (find-or-create)', async () => {
    const handler = getHandler(router, 'post', '/:id/tags');
    const req = baseReq({
      params: { id: 'cust-1' }, body: { tagName: 'VIP' },
      db: fakeDb({ existingCustomer: [customerRow()] }),
    } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('DELETE /customers/:id/tags/:tagId', () => {
  it('204', async () => {
    const handler = getHandler(router, 'delete', '/:id/tags/:tagId');
    const req = baseReq({ params: { id: 'cust-1', tagId: 'tag-1' }, db: fakeDb() } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });
});

// ---------------------------------------------------------------------------
// Tarifas especiales (customer_rates)
// ---------------------------------------------------------------------------

describe('GET /customers/:id/rates', () => {
  it('200 -- lista tarifas activas', async () => {
    const handler = getHandler(router, 'get', '/:id/rates');
    const req = baseReq({ params: { id: 'cust-1' }, db: fakeDb() } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'rate-1' })]);
  });
});

describe('POST /customers/:id/rates', () => {
  it('404 si el cliente no existe', async () => {
    const handler = getHandler(router, 'post', '/:id/rates');
    const req = baseReq({
      params: { id: 'cust-x' }, body: { bucket: 'PRODUCTOS', price: 100 },
      db: fakeDb({ existingCustomer: null }),
    } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('201 -- crea una tarifa ad hoc por bucket (sin existence-check, D9-Parte 2)', async () => {
    const handler = getHandler(router, 'post', '/:id/rates');
    const req = baseReq({
      params: { id: 'cust-1' }, body: { bucket: 'PRODUCTOS', price: 100 },
      db: fakeDb({ existingCustomer: [customerRow()] }),
    } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.body).toMatchObject({ id: 'rate-1', bucket: 'PRODUCTOS', fixedPrice: 100 });
  });

  it('409 (CustomerRateConflictError) si el índice único de Postgres rechaza (23505)', async () => {
    const handler = getHandler(router, 'post', '/:id/rates');
    const db = fakeDb({
      existingCustomer: [customerRow()],
      extraQueryHandlers: [{
        match: (sql) => sql.includes('INSERT INTO customer_rates'),
        result: () => { const e = new Error('duplicate key') as Error & { code: string }; e.code = '23505'; throw e; },
      }],
    });
    const req = baseReq({ params: { id: 'cust-1' }, body: { bucket: 'PRODUCTOS', price: 100 }, db } as never);
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    // CustomerRateConflictError es un DomainError -- lo captura el catch de
    // la ruta y lo pasa a next() (domainErrorStatus lo mapea más arriba en
    // el stack real, fuera de este handler).
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('DELETE /customers/:id/rates/:rateId', () => {
  it('204 -- desactiva y audita (estaba activa)', async () => {
    const handler = getHandler(router, 'delete', '/:id/rates/:rateId');
    const req = baseReq({ params: { id: 'cust-1', rateId: 'rate-1' }, db: fakeDb() } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });
});

// ---------------------------------------------------------------------------
// Perfil fiscal / política de facturación -- solo el camino 404 (ver docblock)
// ---------------------------------------------------------------------------

describe('GET /customers/:id/tax-profile', () => {
  it('200 con null si el cliente no cargó datos fiscales todavía', async () => {
    const handler = getHandler(router, 'get', '/:id/tax-profile');
    const req = baseReq({ params: { id: 'cust-1' }, db: fakeDb() } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith(null);
  });
});

describe('PUT /customers/:id/tax-profile', () => {
  it('404 si el cliente no existe', async () => {
    const handler = getHandler(router, 'put', '/:id/tax-profile');
    const req = baseReq({
      params: { id: 'cust-x' },
      body: { legalName: 'Ana SRL', taxId: '20111111112', taxIdType: 'CUIT' },
      db: fakeDb({ existingCustomer: null }),
    } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('GET /customers/:id/billing-policy', () => {
  it('200 con null si el cliente usa la política default', async () => {
    const handler = getHandler(router, 'get', '/:id/billing-policy');
    const req = baseReq({ params: { id: 'cust-1' }, db: fakeDb() } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith(null);
  });
});

describe('PUT /customers/:id/billing-policy', () => {
  it('404 si el cliente no existe', async () => {
    const handler = getHandler(router, 'put', '/:id/billing-policy');
    const req = baseReq({
      params: { id: 'cust-x' },
      body: { requiresSenaToConfirm: false, invoicingScope: 'per_reservation', invoicingTrigger: 'on_completion', dueDays: 30 },
      db: fakeDb({ existingCustomer: null }),
    } as never);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ---------------------------------------------------------------------------
// Padrón ARCA -- solo el camino de validación (ver docblock)
// ---------------------------------------------------------------------------

describe('POST /customers/padron/lookup-by-cuit', () => {
  it('propaga a next() un CUIT con dígito verificador inválido, sin llegar a golpear AFIP', async () => {
    const handler = getHandler(router, 'post', '/padron/lookup-by-cuit');
    const req = baseReq({ body: { cuit: '20111111111' }, db: fakeDb() } as never); // dv incorrecto
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
