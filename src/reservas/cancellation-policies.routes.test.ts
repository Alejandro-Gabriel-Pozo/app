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
import { createCancellationPoliciesRouter } from './cancellation-policies.routes.js';
import type { AppContainer } from '../container.js';
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
      const [id, businessId, minDays, refundPct] = params;
      const row: Row = {
        id, business_id: businessId, min_days_before_checkin: minDays,
        refund_percentage: String(refundPct), active: true,
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

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
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

    await handler(req, res, () => { throw new Error('no next'); });

    expect(res.status).toHaveBeenCalledWith(400);
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
