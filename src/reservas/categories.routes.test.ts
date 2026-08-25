/**
 * @file categories.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) -- cobertura de
 * rutas para categories.routes.ts (0% antes de esto). Mismo patrón que
 * usuarios-roles/users.routes.test.ts: extraer el handler final del stack
 * del router (después de authorize()) e invocarlo directo con req/res
 * fake, sin levantar Express real (este repo no tiene supertest, ver
 * docblock de platform/tenant-isolation.test.ts).
 *
 * `buildService()` del router instancia SqlCategoryRepository/
 * SqlAuditLogRepository directo desde req.db -- no hay forma de inyectar
 * un fake in-memory, así que req.db acá es un mini fake de SqlClient que
 * entiende las queries reales que emite sql.category.repository.ts (y el
 * INSERT a audit_log de recordFieldChanges()).
 */

import { describe, it, expect, vi } from 'vitest';
import { createCategoryRouter } from './categories.routes.js';
import { BusinessPlan } from '../types/enums.js';
import type { AppContainer } from '../container.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

type Row = Record<string, unknown>;

function fakeDb(seed: Row[] = []) {
  const categories = new Map<string, Row>();
  for (const c of seed) categories.set(c['id'] as string, c);
  const auditCalls: unknown[][] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^INSERT INTO audit_log/i.test(s)) {
      auditCalls.push(params);
      return { rows: [] };
    }
    if (/SELECT COUNT\(\*\)::int AS total FROM resource_categories/i.test(s)) {
      return { rows: [{ total: [...categories.values()].filter((r) => r['active']).length }] };
    }
    if (/FROM resource_categories\s+WHERE active = TRUE/i.test(s)) {
      return { rows: [...categories.values()].filter((r) => r['active']) };
    }
    if (/FROM resource_categories\s+WHERE id = \$1/i.test(s)) {
      const row = categories.get(String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (/^INSERT INTO resource_categories/i.test(s)) {
      const [id, name, description, fieldsJson, isLodging] = params;
      const row: Row = {
        id, name, description: description ?? undefined,
        fields: JSON.parse(String(fieldsJson)), active: true, is_lodging: isLodging,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      };
      categories.set(String(id), row);
      return { rows: [row] };
    }
    if (/^UPDATE resource_categories\s+SET/i.test(s)) {
      const id = String(params[params.length - 1]);
      const existing = categories.get(id);
      if (!existing) return { rows: [] };
      const setMatch = s.match(/SET (.+) WHERE/i)!;
      for (const assign of setMatch[1]!.split(',').map((a) => a.trim())) {
        const m = assign.match(/^(\w+) = \$(\d+)/);
        if (!m) continue;
        const col = m[1]!;
        const val = params[Number(m[2]) - 1];
        existing[col] = col === 'fields' ? JSON.parse(String(val)) : val;
      }
      categories.set(id, existing);
      return { rows: [existing] };
    }
    throw new Error(`fakeDb: SQL no manejado: ${s}`);
  });

  return { query, _categories: categories, _auditCalls: auditCalls };
}

function makeCategoryRow(overrides: Row = {}): Row {
  return {
    id: 'cat-1', name: 'Habitaciones', description: null, fields: [], active: true,
    is_lodging: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const PLAN_LIMITS: PlanLimits = {
  maxCategories: 5, maxResources: 20, maxActiveMemberships: 5,
  allowedRoleNames: 'ALL', maxCustomRoles: 2, allowedPermissionGroups: 'ALL',
};

function fakeContainer(limits: PlanLimits = PLAN_LIMITS): AppContainer {
  return {
    getBusinessPlan: vi.fn(async () => BusinessPlan.PRO),
    getPlanLimits: vi.fn(async () => limits),
  } as unknown as AppContainer;
}

function getHandler(router: ReturnType<typeof createCategoryRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

describe('GET /api/categories', () => {
  it('lista las categorías activas', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'get', '/');
    const req = { db: fakeDb([makeCategoryRow()]) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'cat-1', name: 'Habitaciones' })]);
  });
});

describe('GET /api/categories/:id', () => {
  it('devuelve la categoría', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'get', '/:id');
    const req = { db: fakeDb([makeCategoryRow()]), params: { id: 'cat-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'cat-1' }));
  });

  it('propaga CategoryNotFoundError a next() -- 404 vía error.middleware.ts', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'get', '/:id');
    const req = { db: fakeDb([]), params: { id: 'cat-inexistente' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next.mock.calls[0]![0] as Error).name).toBe('CategoryNotFoundError');
  });
});

describe('POST /api/categories', () => {
  it('crea la categoría (201) cuando hay cupo en el plan', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'post', '/');
    const req = {
      db: fakeDb([]),
      user: { id: 'identity-1', businessId: 'biz-1' },
      body: { name: 'Salones', fields: [] },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ name: 'Salones' }));
  });

  it('401 TOKEN_MISSING_BUSINESS si el JWT no trae businessId', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'post', '/');
    const req = { db: fakeDb([]), user: { id: 'identity-1' }, body: { name: 'Salones' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.body).toMatchObject({ code: 'TOKEN_MISSING_BUSINESS' });
  });

  it('400 VALIDATION_ERROR si falta el nombre', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'post', '/');
    const req = { db: fakeDb([]), user: { id: 'identity-1', businessId: 'biz-1' }, body: {} } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('402 PLAN_LIMIT_REACHED si ya se alcanzó maxCategories', async () => {
    const router = createCategoryRouter(fakeContainer({ ...PLAN_LIMITS, maxCategories: 1 }));
    const handler = getHandler(router, 'post', '/');
    const req = {
      db: fakeDb([makeCategoryRow()]),
      user: { id: 'identity-1', businessId: 'biz-1' },
      body: { name: 'Salones', fields: [] },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.body).toMatchObject({ code: 'PLAN_LIMIT_REACHED', plan: BusinessPlan.PRO, limit: 1 });
  });
});

describe('PUT /api/categories/:id', () => {
  it('actualiza y audita el cambio (recordFieldChanges -> INSERT audit_log)', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'put', '/:id');
    const db = fakeDb([makeCategoryRow()]);
    const req = {
      db, params: { id: 'cat-1' }, user: { id: 'identity-admin', businessId: 'biz-1' },
      body: { name: 'Habitaciones Premium' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ name: 'Habitaciones Premium' }));
    expect(db._auditCalls).toHaveLength(1);
    expect(db._auditCalls[0]).toEqual(expect.arrayContaining(['identity-admin']));
  });

  it('400 VALIDATION_ERROR con un body inválido (fields mal formado)', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      db: fakeDb([makeCategoryRow()]), params: { id: 'cat-1' }, user: { id: 'identity-1', businessId: 'biz-1' },
      body: { fields: [{ name: 'x' }] }, // sin label/type/required -- inválido
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(400);
  });
});

describe('DELETE /api/categories/:id', () => {
  it('desactiva (204) una categoría existente', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'delete', '/:id');
    const req = { db: fakeDb([makeCategoryRow()]), params: { id: 'cat-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('propaga CategoryNotFoundError si no existe', async () => {
    const router = createCategoryRouter(fakeContainer());
    const handler = getHandler(router, 'delete', '/:id');
    const req = { db: fakeDb([]), params: { id: 'cat-x' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
