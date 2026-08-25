/**
 * @file rate-catalog.routes.test.ts
 * @description I7 (24/08/2026, pendientes-2026-08-24.md) — cobertura de
 * rutas para rate-catalog.routes.ts (0% hasta ahora). `buildService(req)` y
 * los repos de existencia (resource/service/product/category) se
 * construyen adentro del handler -- se mockean los módulos (mismo
 * mecanismo que cash-register.routes.test.ts) en vez de intentar inyectar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

const { list, create, update, deactivate } = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn(),
}));
const { resourceGetById, serviceFindById, productGetById, categoryFindById } = vi.hoisted(() => ({
  resourceGetById: vi.fn(), serviceFindById: vi.fn(), productGetById: vi.fn(), categoryFindById: vi.fn(),
}));

vi.mock('./rate-catalog.service.js', () => ({
  RateCatalogService: vi.fn().mockImplementation(() => ({ list, create, update, deactivate })),
}));
vi.mock('./sql.rate-catalog.repository.js', () => ({ SqlRateCatalogRepository: vi.fn() }));
vi.mock('../repositories/audit-log.repository.js', () => ({ SqlAuditLogRepository: vi.fn() }));
vi.mock('../reservas/sql.resource.repository.js', () => ({ SqlResourceRepository: vi.fn().mockImplementation(() => ({ getById: resourceGetById })) }));
vi.mock('../reservas/sql.bookable-service.repository.js', () => ({ SqlBookableServiceRepository: vi.fn().mockImplementation(() => ({ findById: serviceFindById })) }));
vi.mock('../reservas/sql.category.repository.js', () => ({ SqlCategoryRepository: vi.fn().mockImplementation(() => ({ findById: categoryFindById })) }));
vi.mock('../pos-menu/sql.product.repository.js', () => ({ SqlProductRepository: vi.fn().mockImplementation(() => ({ getById: productGetById })) }));

const { createRateCatalogRouter } = await import('./rate-catalog.routes.js');
const { RateCatalogEntryNotFoundError } = await import('../domain/errors.js');

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createRateCatalogRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

const FIXED_DATE = new Date('2026-08-24T12:00:00Z');

function makeEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rc-1', businessId: 'biz-1', name: 'Corporativo -10%', discountPercentage: 10,
    resourceId: null, serviceId: null, productId: null, categoryId: null, bucket: 'ALOJAMIENTO',
    active: true, createdAt: FIXED_DATE, updatedAt: FIXED_DATE,
    ...overrides,
  };
}

function fakeReq(overrides: Partial<Request> = {}): Request {
  return {
    body: {}, params: {}, db: {}, user: { id: 'user-1', businessId: 'biz-1' },
    ...overrides,
  } as unknown as Request;
}

const router = createRateCatalogRouter();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/rate-catalog', () => {
  it('lista el catálogo activo del negocio', async () => {
    list.mockResolvedValue([makeEntry()]);
    const res = fakeRes();

    await getHandler(router, 'get', '/')(fakeReq(), res, () => { throw new Error('no next()'); });

    expect(list).toHaveBeenCalledWith('biz-1');
    expect(res.json).toHaveBeenCalledWith([makeEntry()]);
  });
});

describe('POST /api/rate-catalog', () => {
  it('crea una entrada scope bucket (sin lookups de existencia)', async () => {
    create.mockResolvedValue(makeEntry());
    const res = fakeRes();

    await getHandler(router, 'post', '/')(fakeReq({ body: { name: 'Corporativo -10%', discountPercentage: 10, bucket: 'ALOJAMIENTO' } }), res, () => { throw new Error('no next()'); });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ businessId: 'biz-1', name: 'Corporativo -10%', discountPercentage: 10, bucket: 'ALOJAMIENTO' }));
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(makeEntry());
  });

  it('crea una entrada scope resourceId, validando existencia primero', async () => {
    resourceGetById.mockResolvedValue({ id: 'res-1' });
    create.mockResolvedValue(makeEntry({ resourceId: 'res-1', bucket: null }));
    const res = fakeRes();

    await getHandler(router, 'post', '/')(fakeReq({ body: { name: 'Descuento recurso', discountPercentage: 5, resourceId: 'res-1' } }), res, () => { throw new Error('no next()'); });

    expect(resourceGetById).toHaveBeenCalledWith('res-1');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('400 (zod) si manda más de un campo de scope a la vez', async () => {
    const next = vi.fn();

    await getHandler(router, 'post', '/')(fakeReq({ body: { name: 'X', discountPercentage: 5, resourceId: 'res-1', serviceId: 'svc-1' } }), fakeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('propaga vía next() si el resourceId no existe', async () => {
    resourceGetById.mockResolvedValue(undefined);
    const next = vi.fn();

    await getHandler(router, 'post', '/')(fakeReq({ body: { name: 'X', discountPercentage: 5, resourceId: 'res-x' } }), fakeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('404 PRODUCT_NOT_FOUND si el productId no existe (D9-Parte 2, manejo local)', async () => {
    productGetById.mockResolvedValue(undefined);
    const res = fakeRes();

    await getHandler(router, 'post', '/')(fakeReq({ body: { name: 'X', discountPercentage: 5, productId: 'prod-x' } }), res, () => { throw new Error('no next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRODUCT_NOT_FOUND' }));
  });

  it('propaga vía next() (RateCatalogEntryConflictError) si el nombre ya existe (23505)', async () => {
    create.mockRejectedValue({ code: '23505' });
    const next = vi.fn();

    await getHandler(router, 'post', '/')(fakeReq({ body: { name: 'Corporativo -10%', discountPercentage: 10, bucket: 'ALOJAMIENTO' } }), fakeRes(), next);

    expect(next).toHaveBeenCalled();
  });
});

describe('PUT /api/rate-catalog/:id', () => {
  it('actualiza name/discountPercentage', async () => {
    update.mockResolvedValue(makeEntry({ discountPercentage: 15 }));
    const res = fakeRes();

    await getHandler(router, 'put', '/:id')(fakeReq({ params: { id: 'rc-1' }, body: { discountPercentage: 15 } }), res, () => { throw new Error('no next()'); });

    expect(update).toHaveBeenCalledWith('rc-1', 'biz-1', { discountPercentage: 15 }, 'user-1');
    expect(res.json).toHaveBeenCalledWith(makeEntry({ discountPercentage: 15 }));
  });

  it('400 (zod) si no manda ni name ni discountPercentage', async () => {
    const next = vi.fn();

    await getHandler(router, 'put', '/:id')(fakeReq({ params: { id: 'rc-1' }, body: {} }), fakeRes(), next);

    expect(next).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('propaga vía next() si la entrada no existe', async () => {
    update.mockRejectedValue(new RateCatalogEntryNotFoundError('rc-x'));
    const next = vi.fn();

    await getHandler(router, 'put', '/:id')(fakeReq({ params: { id: 'rc-x' }, body: { name: 'Y' } }), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(RateCatalogEntryNotFoundError));
  });
});

describe('DELETE /api/rate-catalog/:id', () => {
  it('204 al desactivar', async () => {
    deactivate.mockResolvedValue(true);
    const res = fakeRes();

    await getHandler(router, 'delete', '/:id')(fakeReq({ params: { id: 'rc-1' } }), res, () => { throw new Error('no next()'); });

    expect(deactivate).toHaveBeenCalledWith('rc-1', 'biz-1', 'user-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('propaga RateCatalogEntryNotFoundError vía next() si ya estaba inactiva/no existe', async () => {
    deactivate.mockResolvedValue(false);
    const next = vi.fn();

    await getHandler(router, 'delete', '/:id')(fakeReq({ params: { id: 'rc-x' } }), fakeRes(), next);

    expect(next).toHaveBeenCalledWith(expect.any(RateCatalogEntryNotFoundError));
  });
});

