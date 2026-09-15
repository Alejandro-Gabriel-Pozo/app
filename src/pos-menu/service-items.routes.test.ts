/**
 * @file service-items.routes.test.ts
 * @description Mismo patrón que waste-reasons.routes.test.ts: sin supertest
 * en este repo, se extrae el handler final del stack del router y se lo
 * invoca directo. `createServiceItemsRouter` arma
 * SqlServiceItemRepository/SqlAuditLogRepository directo desde req.db, sin
 * seam de inyección -- se mockea `./service-item.service.js` a nivel de
 * módulo (ServiceItemService) para no depender de una BD real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createServiceItemsRouter } from './service-items.routes.js';
import { ServiceItemService } from './service-item.service.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';
import type { ServiceItem } from './service-item.entities.js';
import type { AppContainer } from '../container.js';

vi.mock('./service-item.service.js', () => ({
  ServiceItemService: vi.fn(),
}));
// updateItem() es transaccional -- buildService() resuelve
// buildTenantTransactionManager(req) como tercer argumento del constructor
// antes de construirlo, aunque ServiceItemService esté mockeado arriba.
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

function getHandler(router: ReturnType<typeof createServiceItemsRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeItem(overrides: Partial<ServiceItem> = {}): ServiceItem {
  return {
    id: 'si-1', businessId: 'biz-1', categoryId: null,
    name: 'Cargo por cancelación', description: null, price: 500,
    active: true, deletedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('service-items.routes', () => {
  let listItems: ReturnType<typeof vi.fn>;
  let getItemById: ReturnType<typeof vi.fn>;
  let createItem: ReturnType<typeof vi.fn>;
  let updateItem: ReturnType<typeof vi.fn>;
  let deactivateItem: ReturnType<typeof vi.fn>;
  let router: ReturnType<typeof createServiceItemsRouter>;
  let defaultItem: ServiceItem;

  beforeEach(() => {
    defaultItem = makeItem();
    listItems = vi.fn(async () => [defaultItem]);
    getItemById = vi.fn(async () => defaultItem);
    createItem = vi.fn(async () => defaultItem);
    updateItem = vi.fn(async () => makeItem({ price: 600 }));
    deactivateItem = vi.fn(async () => {});
    vi.mocked(ServiceItemService).mockImplementation(() => ({
      listItems, getItemById, createItem, updateItem, deactivateItem,
    } as unknown as ServiceItemService));
    router = createServiceItemsRouter({} as AppContainer);
  });

  function baseReq(overrides: Partial<Request> = {}): Request {
    return {
      db: {}, businessId: 'biz-1', user: { id: 'identity-1', businessId: 'biz-1' },
      params: {}, query: {}, body: {},
      ...overrides,
    } as unknown as Request;
  }

  it('GET / -- lista los ítems del negocio', async () => {
    const handler = getHandler(router, 'get', '/');
    const req = baseReq();
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(listItems).toHaveBeenCalledWith('biz-1');
    expect(res.json).toHaveBeenCalledWith([defaultItem]);
  });

  it('GET /:id -- devuelve el ítem puntual', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'si-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(getItemById).toHaveBeenCalledWith('si-1');
    expect(res.json).toHaveBeenCalledWith(defaultItem);
  });

  it('GET /:id -- delega a next() si el ítem no existe (sin mapeo 404 en la ruta)', async () => {
    getItemById.mockRejectedValueOnce(new ServiceItemNotFoundError('si-x'));
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'si-x' } } as Partial<Request>);
    const res = fakeRes();
    const next = vi.fn();

    await handler(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ServiceItemNotFoundError));
  });

  it('POST / -- crea un ítem nuevo (201)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: 'Cargo por cancelación', price: 500 } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(createItem).toHaveBeenCalledWith({
      businessId: 'biz-1', categoryId: undefined, name: 'Cargo por cancelación',
      description: undefined, price: 500,
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(defaultItem);
  });

  it('POST / -- 400 si el body no cumple el schema (name vacío)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: '', price: 500 } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createItem).not.toHaveBeenCalled();
  });

  it('POST / -- 400 si price es negativo', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: 'x', price: -1 } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(createItem).not.toHaveBeenCalled();
  });

  it('PUT /:id -- actualiza campos y pasa el id de quien edita', async () => {
    const updated = makeItem({ price: 600 });
    updateItem.mockResolvedValueOnce(updated);
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'si-1' }, body: { price: 600 } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(updateItem).toHaveBeenCalledWith('si-1', { price: 600 }, 'identity-1');
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('PUT /:id -- 400 si el body no cumple el schema (active no booleano)', async () => {
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'si-1' }, body: { active: 'sí' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(400);
    expect(updateItem).not.toHaveBeenCalled();
  });

  it('DELETE /:id -- desactiva y responde 204', async () => {
    const handler = getHandler(router, 'delete', '/:id');
    const req = baseReq({ params: { id: 'si-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(deactivateItem).toHaveBeenCalledWith('si-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
