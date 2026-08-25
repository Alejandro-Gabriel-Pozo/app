/**
 * @file locations.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) -- este router
 * estaba en 0% de cobertura. Mismo patrón que el resto del repo: extraer el
 * handler final del stack del router (después de authorize()) e invocarlo
 * directo con req/res fake, sin levantar Express real (no hay supertest en
 * este repo -- ver src/platform/tenant-isolation.test.ts).
 */

import { describe, it, expect, vi } from 'vitest';
import { createLocationsRouter } from './locations.routes.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createLocationsRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function fakeDb(queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  return { query: vi.fn(queryImpl) };
}

describe('GET /api/locations', () => {
  it('devuelve las locations activas', async () => {
    const router = createLocationsRouter();
    const handler = getHandler(router, 'get', '/');
    const req = {
      db: fakeDb(async () => ({
        rows: [{ id: 'loc-1', name: 'Sucursal Centro', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
      })),
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'loc-1', name: 'Sucursal Centro' })]);
  });

  it('propaga un error de la BD a next()', async () => {
    const router = createLocationsRouter();
    const handler = getHandler(router, 'get', '/');
    const req = { db: fakeDb(async () => { throw new Error('conexión caída'); }) } as unknown as Request;
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('POST /api/locations', () => {
  it('crea una location nueva con 201', async () => {
    const router = createLocationsRouter();
    const handler = getHandler(router, 'post', '/');
    const req = {
      body: { name: 'Sucursal Sur' },
      db: fakeDb(async (sql: string) => {
        if (sql.startsWith('INSERT')) {
          return { rows: [{ id: 'loc-new', name: 'Sucursal Sur', active: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
        }
        return { rows: [] };
      }),
    } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ name: 'Sucursal Sur' }));
  });

  it('rechaza con 400 si falta name', async () => {
    const router = createLocationsRouter();
    const handler = getHandler(router, 'post', '/');
    const req = { body: {}, db: fakeDb(async () => ({ rows: [] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('rechaza con 400 si name está vacío', async () => {
    const router = createLocationsRouter();
    const handler = getHandler(router, 'post', '/');
    const req = { body: { name: '' }, db: fakeDb(async () => ({ rows: [] })) } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
