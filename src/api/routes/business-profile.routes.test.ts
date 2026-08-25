/**
 * @file business-profile.routes.test.ts
 * @description I7 (24/08/2026) -- 0% de cobertura. El router construye
 * `SqlBusinessProfileRepository`/`SqlAuditLogRepository` desde `req.db`
 * (mismo patrón que users.routes.ts) -- se fakea `req.db.query` devolviendo
 * siempre la misma fila de `business_profile`, que alcanza para GET, PUT
 * (`repository.get()` + `UPDATE ... RETURNING *`) y el INSERT de
 * `audit_log` (no lee `rows`, ver audit-log.repository.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { createBusinessProfileRouter } from './business-profile.routes.js';
import type { Request, Response } from 'express';
import { Roles } from '../../security/roles.js';

// update() ahora es transaccional (25/08/2026, paso 1 del handoff de
// RBAC/auditoría) -- mismo mock que categories.routes.test.ts: `run()`
// ejecuta el callback contra el mismo `req.db` (fakeDb) en vez de resolver
// un pool de tenant real.
vi.mock('../../db/tenant-context.js', () => ({
  buildTenantTransactionManager: vi.fn((req: Request) => ({
    run: vi.fn(async (fn: (client: unknown) => unknown) => fn(req.db)),
  })),
}));

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createBusinessProfileRouter>, method: 'get' | 'put', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'default', display_name: 'Hotel Los Álamos', contact_email: 'contacto@losalamos.test',
    currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires',
    default_check_in_time: '15:00', default_check_out_time: '10:00',
    legal_name: null, tax_id: null, tax_id_type: null, tax_condition: null,
    fiscal_address_line1: null, fiscal_address_city: null, fiscal_address_state: null,
    fiscal_address_postal_code: null, fiscal_address_country: null,
    afip_sales_point: null, afip_cuit: null, default_iva_rate: '21', prices_include_iva: false,
    default_deposit_percentage: null, deposit_hold_hours: null,
    customer_number_prefix: 'CLI', reservation_number_prefix: 'RES', maintenance_horizon_days: 30,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function fakeDb(row: Record<string, unknown> = profileRow()) {
  return { query: vi.fn(async () => ({ rows: [row] })) };
}

describe('GET /api/business-profile', () => {
  it('devuelve el perfil del negocio', async () => {
    const router = createBusinessProfileRouter();
    const handler = getHandler(router, 'get', '/');
    const req = { db: fakeDb() } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Hotel Los Álamos', currency: 'ARS' }));
  });
});

describe('PUT /api/business-profile', () => {
  it('actualiza campos no fiscales sin necesitar OWNER_ONLY', async () => {
    const router = createBusinessProfileRouter();
    const handler = getHandler(router, 'put', '/');
    const req = {
      body: { displayName: 'Hotel Los Álamos Renovado' },
      user: { id: 'identity-admin', businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] },
      db: fakeDb(profileRow({ display_name: 'Hotel Los Álamos Renovado' })),
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ displayName: 'Hotel Los Álamos Renovado' }));
  });

  it('rechaza con 400 un currency mal formado', async () => {
    const router = createBusinessProfileRouter();
    const handler = getHandler(router, 'put', '/');
    const req = {
      body: { currency: 'pesos' },
      user: { id: 'identity-admin', businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] },
      db: fakeDb(),
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });

  it('D3 -- si el CUIT ya está confirmado, tocar un campo fiscal sin OWNER_ONLY se rechaza (FiscalProfileLockedError)', async () => {
    const router = createBusinessProfileRouter();
    const handler = getHandler(router, 'put', '/');
    const req = {
      body: { legalName: 'Los Álamos Hotel SRL' },
      // permissionGroups sin OWNER_ONLY -- solo MANAGEMENT.
      user: { id: 'identity-admin', businessId: 'biz-1', permissionGroups: [Roles.MANAGEMENT] },
      db: fakeDb(profileRow({ tax_id: '30111111112', legal_name: 'Los Álamos SRL' })), // taxId ya cargado
    } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
    expect(res.json).not.toHaveBeenCalled();
  });

  it('D3 -- con OWNER_ONLY sí puede tocar un campo fiscal aunque el CUIT ya esté confirmado', async () => {
    const router = createBusinessProfileRouter();
    const handler = getHandler(router, 'put', '/');
    const req = {
      body: { legalName: 'Los Álamos Hotel SRL' },
      user: { id: 'identity-owner', businessId: 'biz-1', permissionGroups: [Roles.OWNER_ONLY] },
      db: fakeDb(profileRow({ tax_id: '30111111112', legal_name: 'Los Álamos Hotel SRL' })),
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ legalName: 'Los Álamos Hotel SRL' }));
  });
});
