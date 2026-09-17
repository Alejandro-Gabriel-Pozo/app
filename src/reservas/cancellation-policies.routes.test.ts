/**
 * @file cancellation-policies.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) -- cobertura de
 * rutas para cancellation-policies.routes.ts (0% antes de esto). Mismo
 * patrón de extracción de handler que categories.routes.test.ts / users.
 * routes.test.ts. `buildService()` del router instancia
 * SqlCancellationPolicyRepository/SqlAuditLogRepository directo desde
 * req.db, así que req.db es un mini fake de SqlClient para la tabla
 * cancellation_policies + el INSERT a audit_log.
 */

import { describe, it, expect, vi } from 'vitest';
import { ZodError } from 'zod';
import { createCancellationPoliciesRouter } from './cancellation-policies.routes.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

// updatePolicy() ahora es transaccional (25/08/2026, paso 1 del handoff de
// RBAC/auditoría) -- mismo mock que categories.routes.test.ts: `run()`
// ejecuta el callback contra el mismo `req.db` (fakeDb) en vez de resolver
// un pool de tenant real.
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

type Row = Record<string, unknown>;

function fakeDb(seed: Row[] = []) {
  const policies = new Map<string, Row>();
  for (const p of seed) policies.set(p['id'] as string, p);
  const auditCalls: unknown[][] = [];

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (/^INSERT INTO audit_log/i.test(s)) {
      auditCalls.push(params);
      return { rows: [] };
    }
    if (/FROM cancellation_policies\s+WHERE business_id = \$1/i.test(s)) {
      return { rows: [...policies.values()].filter((r) => r['business_id'] === params[0]) };
    }
    if (/FROM cancellation_policies WHERE id = \$1/i.test(s)) {
      const row = policies.get(String(params[0]));
      return { rows: row ? [row] : [] };
    }
    if (/^INSERT INTO cancellation_policies/i.test(s)) {
      const [id, businessId, minDays, refundPct, policyResolutionTiming] = params;
      const row: Row = {
        id, business_id: businessId, min_days_before_checkin: minDays,
        refund_percentage: String(refundPct), active: true,
        policy_resolution_timing: policyResolutionTiming,
      };
      policies.set(String(id), row);
      return { rows: [row] };
    }
    if (/^UPDATE cancellation_policies SET/i.test(s)) {
      const id = String(params[params.length - 1]);
      const existing = policies.get(id);
      if (!existing) return { rows: [] };
      const setMatch = s.match(/SET (.+) WHERE/i)!;
      for (const assign of setMatch[1]!.split(',').map((a) => a.trim())) {
        const m = assign.match(/^(\w+) = \$(\d+)/);
        if (!m) continue;
        const col = m[1]!;
        const val = params[Number(m[2]) - 1];
        existing[col] = col === 'refund_percentage' ? String(val) : val;
      }
      policies.set(id, existing);
      return { rows: [existing] };
    }
    throw new Error(`fakeDb: SQL no manejado: ${s}`);
  });

  return { query, _auditCalls: auditCalls };
}

function makePolicyRow(overrides: Row = {}): Row {
  return {
    id: 'pol-1', business_id: 'biz-1', min_days_before_checkin: 3,
    refund_percentage: '50', active: true,
    policy_resolution_timing: 'SNAPSHOT_AT_BOOKING',
    ...overrides,
  };
}

function fakeContainer(): AppContainer {
  return {} as unknown as AppContainer;
}

function getHandler(router: ReturnType<typeof createCancellationPoliciesRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

const router = createCancellationPoliciesRouter(fakeContainer());

describe('GET /api/cancellation-policies', () => {
  it('lista los tramos del negocio', async () => {
    const handler = getHandler(router, 'get', '/');
    const req = { db: fakeDb([makePolicyRow()]), businessId: 'biz-1' } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'pol-1', minDaysBeforeCheckin: 3, refundPercentage: 50 })]);
  });
});

describe('GET /api/cancellation-policies/:id', () => {
  it('devuelve el tramo', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = { db: fakeDb([makePolicyRow()]), params: { id: 'pol-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'pol-1' }));
  });

  it('propaga CancellationPolicyNotFoundError a next()', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = { db: fakeDb([]), params: { id: 'pol-x' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((next.mock.calls[0]![0] as Error).name).toBe('CancellationPolicyNotFoundError');
  });
});

describe('POST /api/cancellation-policies', () => {
  it('crea el tramo (201)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = { db: fakeDb([]), businessId: 'biz-1', body: { minDaysBeforeCheckin: 7, refundPercentage: 100 } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ minDaysBeforeCheckin: 7, refundPercentage: 100 }));
  });

  it('400 VALIDATION_ERROR con refundPercentage fuera de rango', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = { db: fakeDb([]), businessId: 'biz-1', body: { minDaysBeforeCheckin: 7, refundPercentage: 150 } } as unknown as Request;
    const res = fakeRes();

    let caught: unknown;
    await handler(req, res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  // CANCEL-POLICY-SCOPE-BASE-001 (14/09/2026) -- sin policyResolutionTiming en el
  // body, la fila creada refleja el default de la BD (schema.sql), no un
  // default duplicado en el schema Zod (ver comentario en
  // api/schemas/cancellation-policy.schemas.ts).
  it('sin policyResolutionTiming en el body, crea con el default SNAPSHOT_AT_BOOKING', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = { db: fakeDb([]), businessId: 'biz-1', body: { minDaysBeforeCheckin: 7, refundPercentage: 100 } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.body).toMatchObject({ policyResolutionTiming: 'SNAPSHOT_AT_BOOKING' });
  });

  it('acepta policyResolutionTiming explícito en el body', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = {
      db: fakeDb([]), businessId: 'biz-1',
      body: { minDaysBeforeCheckin: 7, refundPercentage: 100, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.body).toMatchObject({ policyResolutionTiming: 'LIVE_AT_CANCELLATION' });
  });

  it('400 VALIDATION_ERROR con policyResolutionTiming fuera del enum', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = {
      db: fakeDb([]), businessId: 'biz-1',
      body: { minDaysBeforeCheckin: 7, refundPercentage: 100, policyResolutionTiming: 'ALGO_INVALIDO' },
    } as unknown as Request;
    const res = fakeRes();

    let caught: unknown;
    await handler(req, res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe('PUT /api/cancellation-policies/:id', () => {
  it('actualiza y audita el cambio', async () => {
    const db = fakeDb([makePolicyRow()]);
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      db, params: { id: 'pol-1' }, user: { id: 'identity-admin' },
      body: { refundPercentage: 80 },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ refundPercentage: 80 }));
    expect(db._auditCalls).toHaveLength(1);
  });

  it('400 VALIDATION_ERROR con minDaysBeforeCheckin negativo', async () => {
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      db: fakeDb([makePolicyRow()]), params: { id: 'pol-1' }, user: { id: 'identity-1' },
      body: { minDaysBeforeCheckin: -1 },
    } as unknown as Request;
    const res = fakeRes();

    let caught: unknown;
    await handler(req, res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });

  it('actualiza policyResolutionTiming y lo audita', async () => {
    const db = fakeDb([makePolicyRow()]);
    const handler = getHandler(router, 'put', '/:id');
    const req = {
      db, params: { id: 'pol-1' }, user: { id: 'identity-admin' },
      body: { policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ policyResolutionTiming: 'LIVE_AT_CANCELLATION' }));
    expect(db._auditCalls).toHaveLength(1);
  });
});

describe('DELETE /api/cancellation-policies/:id', () => {
  it('desactiva (204) un tramo existente', async () => {
    const handler = getHandler(router, 'delete', '/:id');
    const req = { db: fakeDb([makePolicyRow()]), params: { id: 'pol-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('propaga CancellationPolicyNotFoundError si no existe', async () => {
    const handler = getHandler(router, 'delete', '/:id');
    const req = { db: fakeDb([]), params: { id: 'pol-x' } } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
  });
});
