/**
 * @file consumption-destinations.routes.test.ts
 * @description 27/08/2026, pendientes-2026-08-27.md — gemelo exacto de
 * waste-reasons.routes.test.ts. Mismo patrón: extrae el handler final del
 * stack del router y lo invoca directo, sin Express real.
 *
 * `createConsumptionDestinationsRouter` no tiene ningún seam de inyección
 * -- arma SqlConsumptionDestinationRepository/SqlAuditLogRepository directo
 * desde req.db -- así que se mockea `./consumption-destination.service.js`
 * a nivel de módulo (ConsumptionDestinationService) para no depender de una
 * BD real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createConsumptionDestinationsRouter } from './consumption-destinations.routes.js';
import { ConsumptionDestinationService } from './consumption-destination.service.js';
import { ConsumptionDestinationNotFoundError } from '../domain/errors.js';
import type { ConsumptionDestination } from '../repositories/consumption-destination.repository.js';
import type { AppContainer } from '../container.js';

vi.mock('./consumption-destination.service.js', () => ({
  ConsumptionDestinationService: vi.fn(),
}));
vi.mock('../db/tenant-context.js', () => ({
  buildTenantTransactionManager: vi.fn(() => ({ run: vi.fn(async (fn: (client: unknown) => unknown) => fn({})) })),
}));

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createConsumptionDestinationsRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeDestination(overrides: Partial<ConsumptionDestination> = {}): ConsumptionDestination {
  return {
    id: 'cd-1', businessId: 'biz-1', name: 'Personal', active: true,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('consumption-destinations.routes', () => {
  let listDestinations: ReturnType<typeof vi.fn>;
  let getDestinationById: ReturnType<typeof vi.fn>;
  let createDestination: ReturnType<typeof vi.fn>;
  let updateDestination: ReturnType<typeof vi.fn>;
  let deactivateDestination: ReturnType<typeof vi.fn>;
  let router: ReturnType<typeof createConsumptionDestinationsRouter>;
  let defaultDestination: ConsumptionDestination;

  beforeEach(() => {
    defaultDestination = makeDestination();
    listDestinations = vi.fn(async () => [defaultDestination]);
    getDestinationById = vi.fn(async () => defaultDestination);
    createDestination = vi.fn(async () => defaultDestination);
    updateDestination = vi.fn(async () => makeDestination({ name: 'Degustación / cortesía' }));
    deactivateDestination = vi.fn(async () => {});
    vi.mocked(ConsumptionDestinationService).mockImplementation(() => ({
      listDestinations, getDestinationById, createDestination, updateDestination, deactivateDestination,
    } as unknown as ConsumptionDestinationService));
    router = createConsumptionDestinationsRouter({} as AppContainer);
  });

  function baseReq(overrides: Partial<Request> = {}): Request {
    return {
      db: {}, businessId: 'biz-1', user: { id: 'identity-1', businessId: 'biz-1' },
      params: {}, query: {}, body: {},
      ...overrides,
    } as unknown as Request;
  }

  it('GET / -- lista los destinos del negocio', async () => {
    const handler = getHandler(router, 'get', '/');
    const req = baseReq();
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(listDestinations).toHaveBeenCalledWith('biz-1');
    expect(res.json).toHaveBeenCalledWith([defaultDestination]);
  });

  it('GET /:id -- devuelve el destino puntual', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'cd-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(getDestinationById).toHaveBeenCalledWith('cd-1');
    expect(res.json).toHaveBeenCalledWith(defaultDestination);
  });

  it('GET /:id -- delega a next() si el destino no existe (sin mapeo 404 en la ruta)', async () => {
    getDestinationById.mockRejectedValueOnce(new ConsumptionDestinationNotFoundError('cd-x'));
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'cd-x' } } as Partial<Request>);
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ConsumptionDestinationNotFoundError));
  });

  it('POST / -- crea un destino nuevo (201)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: 'Personal' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(createDestination).toHaveBeenCalledWith('biz-1', 'Personal');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(defaultDestination);
  });

  it('POST / -- 400 si el body no cumple el schema (name vacío)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: '' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createDestination).not.toHaveBeenCalled();
  });

  it('PUT /:id -- actualiza nombre/active y pasa el id de quien edita', async () => {
    const updated = makeDestination({ name: 'Degustación / cortesía' });
    updateDestination.mockResolvedValueOnce(updated);
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'cd-1' }, body: { name: 'Degustación / cortesía' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(updateDestination).toHaveBeenCalledWith('cd-1', { name: 'Degustación / cortesía' }, 'identity-1');
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('PUT /:id -- 400 si el body no cumple el schema (active no booleano)', async () => {
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'cd-1' }, body: { active: 'sí' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateDestination).not.toHaveBeenCalled();
  });

  it('DELETE /:id -- desactiva y responde 204', async () => {
    const handler = getHandler(router, 'delete', '/:id');
    const req = baseReq({ params: { id: 'cd-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(deactivateDestination).toHaveBeenCalledWith('cd-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
