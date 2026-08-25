/**
 * @file waste-reasons.routes.test.ts
 * @description I7 (pendientes-2026-08-24.md) -- cobertura de rutas para
 * waste-reasons.routes.ts (0% antes de este archivo). Mismo patrón que
 * users.routes.test.ts / audit-log.routes.test.ts: se extrae el handler
 * final del stack del router y se lo invoca directo, sin Express real (no
 * hay supertest en este repo, ver src/platform/tenant-isolation.test.ts).
 *
 * `createWasteReasonsRouter` no tiene ningún seam de inyección -- arma
 * SqlWasteReasonRepository/SqlAuditLogRepository directo desde req.db --
 * así que se mockea `./waste-reason.service.js` a nivel de módulo
 * (WasteReasonService) para no depender de una BD real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createWasteReasonsRouter } from './waste-reasons.routes.js';
import { WasteReasonService } from './waste-reason.service.js';
import { WasteReasonNotFoundError } from '../domain/errors.js';
import type { WasteReason } from '../repositories/waste-reason.repository.js';
import type { AppContainer } from '../container.js';

vi.mock('./waste-reason.service.js', () => ({
  WasteReasonService: vi.fn(),
}));

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createWasteReasonsRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeReason(overrides: Partial<WasteReason> = {}): WasteReason {
  return {
    id: 'wr-1', businessId: 'biz-1', name: 'Vencimiento', active: true,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('waste-reasons.routes', () => {
  let listReasons: ReturnType<typeof vi.fn>;
  let getReasonById: ReturnType<typeof vi.fn>;
  let createReason: ReturnType<typeof vi.fn>;
  let updateReason: ReturnType<typeof vi.fn>;
  let deactivateReason: ReturnType<typeof vi.fn>;
  let router: ReturnType<typeof createWasteReasonsRouter>;
  let defaultReason: WasteReason;

  beforeEach(() => {
    defaultReason = makeReason();
    listReasons = vi.fn(async () => [defaultReason]);
    getReasonById = vi.fn(async () => defaultReason);
    createReason = vi.fn(async () => defaultReason);
    updateReason = vi.fn(async () => makeReason({ name: 'Rotura' }));
    deactivateReason = vi.fn(async () => {});
    vi.mocked(WasteReasonService).mockImplementation(() => ({
      listReasons, getReasonById, createReason, updateReason, deactivateReason,
    } as unknown as WasteReasonService));
    router = createWasteReasonsRouter({} as AppContainer);
  });

  function baseReq(overrides: Partial<Request> = {}): Request {
    return {
      db: {}, businessId: 'biz-1', user: { id: 'identity-1', businessId: 'biz-1' },
      params: {}, query: {}, body: {},
      ...overrides,
    } as unknown as Request;
  }

  it('GET / -- lista los motivos del negocio', async () => {
    const handler = getHandler(router, 'get', '/');
    const req = baseReq();
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(listReasons).toHaveBeenCalledWith('biz-1');
    expect(res.json).toHaveBeenCalledWith([defaultReason]);
  });

  it('GET /:id -- devuelve el motivo puntual', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'wr-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(getReasonById).toHaveBeenCalledWith('wr-1');
    expect(res.json).toHaveBeenCalledWith(defaultReason);
  });

  it('GET /:id -- delega a next() si el motivo no existe (sin mapeo 404 en la ruta)', async () => {
    getReasonById.mockRejectedValueOnce(new WasteReasonNotFoundError('wr-x'));
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'wr-x' } } as Partial<Request>);
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(WasteReasonNotFoundError));
  });

  it('POST / -- crea un motivo nuevo (201)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: 'Vencimiento' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(createReason).toHaveBeenCalledWith('biz-1', 'Vencimiento');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(defaultReason);
  });

  it('POST / -- 400 si el body no cumple el schema (name vacío)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: '' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createReason).not.toHaveBeenCalled();
  });

  it('PUT /:id -- actualiza nombre/active y pasa el id de quien edita', async () => {
    const updated = makeReason({ name: 'Rotura' });
    updateReason.mockResolvedValueOnce(updated);
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'wr-1' }, body: { name: 'Rotura' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(updateReason).toHaveBeenCalledWith('wr-1', { name: 'Rotura' }, 'identity-1');
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('PUT /:id -- 400 si el body no cumple el schema (active no booleano)', async () => {
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'wr-1' }, body: { active: 'sí' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateReason).not.toHaveBeenCalled();
  });

  it('DELETE /:id -- desactiva y responde 204', async () => {
    const handler = getHandler(router, 'delete', '/:id');
    const req = baseReq({ params: { id: 'wr-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(deactivateReason).toHaveBeenCalledWith('wr-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
