/**
 * @file business-hours.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — cobertura de
 * rutas para business-hours.routes.ts (horario de atención por defecto del
 * negocio). Mismo patrón que users.routes.test.ts: se extrae el handler
 * final del stack del router (después de authorize()) y se lo invoca
 * directo con req/res fake, sin levantar Express real — el gate de
 * authorize() en sí ya lo cubre auth.middleware.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { createBusinessHoursRouter } from './business-hours.routes.js';
import type { AppContainer } from '../container.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createBusinessHoursRouter>, method: 'get' | 'post' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

interface FakeRow { id: string; day_of_week: number; start_time: string; end_time: string }

/** Fake mínimo de req.db -- SqlOperatingHoursRepository se construye directo desde req.db!, no hay inyección de repo. */
function fakeDb(opts: { existing?: FakeRow[]; insertReturns?: FakeRow } = {}) {
  const existing = opts.existing ?? [];
  return {
    query: vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes('SELECT') && sql.includes('business_hours')) {
        return { rows: existing };
      }
      if (sql.includes('INSERT INTO business_hours')) {
        return { rows: [opts.insertReturns ?? { id: 'win-1', day_of_week: 1, start_time: '09:00', end_time: '18:00' }] };
      }
      if (sql.includes('DELETE')) {
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
}

const container = {} as AppContainer;

describe('GET /api/business-hours', () => {
  it('devuelve las franjas horarias del negocio', async () => {
    const router = createBusinessHoursRouter(container);
    const handler = getHandler(router, 'get', '/');
    const db = fakeDb({ existing: [{ id: 'win-1', day_of_week: 0, start_time: '09:00:00', end_time: '13:00:00' }] });
    const req = { db } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith([{ id: 'win-1', dayOfWeek: 0, startTime: '09:00:00', endTime: '13:00:00' }]);
  });
});

describe('POST /api/business-hours', () => {
  it('crea una franja horaria nueva sin solapamiento', async () => {
    const router = createBusinessHoursRouter(container);
    const handler = getHandler(router, 'post', '/');
    const db = fakeDb({ existing: [], insertReturns: { id: 'win-2', day_of_week: 1, start_time: '09:00:00', end_time: '18:00:00' } });
    const req = { db, body: { dayOfWeek: 1, startTime: '09:00:00', endTime: '18:00:00' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'win-2', dayOfWeek: 1 }));
  });

  it('rechaza con 409 si la franja se superpone con una existente el mismo día', async () => {
    const router = createBusinessHoursRouter(container);
    const handler = getHandler(router, 'post', '/');
    const db = fakeDb({ existing: [{ id: 'win-1', day_of_week: 1, start_time: '08:00:00', end_time: '12:00:00' }] });
    const req = { db, body: { dayOfWeek: 1, startTime: '10:00:00', endTime: '14:00:00' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'OPERATING_WINDOW_OVERLAP' }));
  });

  it('body inválido: llama a next() con el ZodError, no responde 201 a ciegas', async () => {
    const router = createBusinessHoursRouter(container);
    const handler = getHandler(router, 'post', '/');
    const db = fakeDb();
    const req = { db, body: { dayOfWeek: 9 } } as unknown as Request; // dayOfWeek fuera de rango / falta startTime-endTime

    const next = vi.fn();
    const res = fakeRes();
    await handler(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalledWith(201);
  });
});

describe('DELETE /api/business-hours/:id', () => {
  it('borra la franja y responde 204', async () => {
    const router = createBusinessHoursRouter(container);
    const handler = getHandler(router, 'delete', '/:id');
    const db = fakeDb();
    const req = { db, params: { id: 'win-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(204);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('DELETE'), ['win-1']);
  });
});
