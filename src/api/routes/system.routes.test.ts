/**
 * @file system.routes.test.ts
 * @description I7 (24/08/2026) -- 0% de cobertura. `repo` viaja inyectado
 * (no se construye desde req.db acá), así que alcanza con un fake de
 * DomainEventRepository con vi.fn().
 */

import { describe, it, expect, vi } from 'vitest';
import { createSystemRouter } from './system.routes.js';
import type { DomainEventRepository } from '../../repositories/domain-event.repository.js';
import type { Request, Response } from 'express';

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createSystemRouter>, method: 'get' | 'post', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

describe('GET /api/system/outbox/dead-letter', () => {
  it('devuelve el count y los eventos dead-lettered', async () => {
    const repo = {
      countDeadLettered: vi.fn(async () => 3),
      getDeadLettered: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
    } as unknown as DomainEventRepository;
    const router = createSystemRouter(repo);
    const handler = getHandler(router, 'get', '/outbox/dead-letter');
    const req = {} as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(repo.getDeadLettered).toHaveBeenCalledWith(50);
    expect(res.json).toHaveBeenCalledWith({ count: 3, events: [{ id: 1 }, { id: 2 }] });
  });

  it('propaga un error del repo a next()', async () => {
    const repo = {
      countDeadLettered: vi.fn(async () => { throw new Error('boom'); }),
      getDeadLettered: vi.fn(async () => []),
    } as unknown as DomainEventRepository;
    const router = createSystemRouter(repo);
    const handler = getHandler(router, 'get', '/outbox/dead-letter');
    const res = fakeRes();
    const next = vi.fn();

    await handler({} as Request, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

describe('POST /api/system/outbox/:id/retry', () => {
  it('reintenta el evento y responde 204', async () => {
    const repo = { retryDeadLettered: vi.fn(async () => {}) } as unknown as DomainEventRepository;
    const router = createSystemRouter(repo);
    const handler = getHandler(router, 'post', '/outbox/:id/retry');
    const req = { params: { id: '42' }, user: { id: 'identity-1', businessId: 'biz-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(repo.retryDeadLettered).toHaveBeenCalledWith(42);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('rechaza con 400 si :id no es un entero', async () => {
    const repo = { retryDeadLettered: vi.fn(async () => {}) } as unknown as DomainEventRepository;
    const router = createSystemRouter(repo);
    const handler = getHandler(router, 'post', '/outbox/:id/retry');
    const req = { params: { id: 'no-numerico' }, user: { id: 'identity-1' } } as unknown as Request;
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(repo.retryDeadLettered).not.toHaveBeenCalled();
  });
});
