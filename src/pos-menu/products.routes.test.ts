/**
 * @file products.routes.test.ts
 * @description I7 (pendientes-2026-08-24.md) -- cobertura de rutas para
 * products.routes.ts (755 líneas, 23 endpoints, 0% antes de este archivo).
 * Mismo patrón que users.routes.test.ts: handler extraído del stack del
 * router, sin Express real (no hay supertest en este repo, ver
 * src/platform/tenant-isolation.test.ts).
 *
 * `createProductsRouter` arma TODO directo desde req.db/req.businessId, sin
 * seam de inyección -- se mockea a nivel de módulo:
 * - ProductService/RecipeService/CompanyCatalogService (clases completas)
 * - SqlInventoryLevelRepository/SqlStockMovementRepository/SqlWasteReasonRepository
 *   (usadas directo en la ruta para stock/enriquecimiento)
 * - buildTenantTransactionManager (stock/transfer, stock/waste, stock/production
 *   -- la implementación real busca un pool de tenant registrado que no existe acá)
 * - createPlatformPool (buildCompanyCatalogService la llama antes de construir
 *   CompanyCatalogService -- explota si PLATFORM_DATABASE_URL no está seteada)
 *
 * `locationId` se pasa siempre explícito por query/body en los tests -- la
 * implementación real de resolveDefaultLocationId (no mockeada) hace
 * `explicit ? explicit : <query real>`, así que con explicit nunca toca la BD.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { createProductsRouter } from './products.routes.js';
import { ProductService, InsufficientStockError } from './product.service.js';
import { RecipeService } from './recipe.service.js';
import { CompanyCatalogService } from './company-catalog.service.js';
import type { Product, ProductVariant } from './product.entities.js';
import type { InventoryLevel } from '../repositories/inventory-level.repository.js';
import type { AppContainer } from '../container.js';
import type * as ProductServiceModule from './product.service.js';
import type * as ContainerModule from '../container.js';

vi.mock('./product.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ProductServiceModule>();
  return { ...actual, ProductService: vi.fn() };
});
vi.mock('./recipe.service.js', () => ({ RecipeService: vi.fn() }));
vi.mock('./company-catalog.service.js', () => ({ CompanyCatalogService: vi.fn() }));
vi.mock('../repositories/sql.inventory-level.repository.js', () => ({ SqlInventoryLevelRepository: vi.fn() }));
vi.mock('../repositories/sql.stock-movement.repository.js', () => ({ SqlStockMovementRepository: vi.fn() }));
vi.mock('../repositories/sql.waste-reason.repository.js', () => ({ SqlWasteReasonRepository: vi.fn() }));
vi.mock('../db/tenant-context.js', () => ({ buildTenantTransactionManager: vi.fn(() => ({ run: vi.fn(async (fn: (c: unknown) => unknown) => fn({})) })) }));
vi.mock('../container.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ContainerModule>();
  return { ...actual, createPlatformPool: vi.fn(() => ({})) };
});
vi.mock('../platform/company.repository.js', () => ({ CompanyRepository: vi.fn() }));
vi.mock('../platform/platform.repository.js', () => ({ PlatformRepository: vi.fn() }));

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createProductsRouter>, method: 'get' | 'post' | 'put' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 'prod-1', businessId: 'biz-1', categoryId: null, name: 'Coca-Cola', description: null,
    basePrice: 100, sku: null, hasVariants: false, active: true, productType: 'RETAIL',
    assembleOnDemand: false, companyProductId: null, priceOverrideStatus: 'INACTIVO',
    pricePendingMasterValue: null, recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
    ivaRate: null, unit: null, arcaUnitCode: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

function makeVariant(overrides: Partial<ProductVariant> = {}): ProductVariant {
  return {
    id: 'var-1', productId: 'prod-1', name: 'Talle M', attributes: {}, sku: null,
    priceOverride: null, active: true, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

function makeLevel(overrides: Partial<InventoryLevel> = {}): InventoryLevel {
  return {
    id: 'lvl-1', businessId: 'biz-1', productId: 'prod-1', productVariantId: null, locationId: 'loc-1',
    stockQuantity: 10, reservedQuantity: 2, stockMinAlert: 1, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('products.routes', () => {
  // ProductService
  let listProducts: ReturnType<typeof vi.fn>;
  let createProduct: ReturnType<typeof vi.fn>;
  let getProduct: ReturnType<typeof vi.fn>;
  let updateProduct: ReturnType<typeof vi.fn>;
  let deleteProduct: ReturnType<typeof vi.fn>;
  let listVariants: ReturnType<typeof vi.fn>;
  let createVariant: ReturnType<typeof vi.fn>;
  let updateVariant: ReturnType<typeof vi.fn>;
  let deleteVariant: ReturnType<typeof vi.fn>;
  let checkStock: ReturnType<typeof vi.fn>;
  let decrementStock: ReturnType<typeof vi.fn>;
  // RecipeService
  let listRecipe: ReturnType<typeof vi.fn>;
  let addRecipeItem: ReturnType<typeof vi.fn>;
  let updateRecipeItem: ReturnType<typeof vi.fn>;
  let removeRecipeItem: ReturnType<typeof vi.fn>;
  let explodeRecipeForProduction: ReturnType<typeof vi.fn>;
  // CompanyCatalogService
  let listCompanyCatalog: ReturnType<typeof vi.fn>;
  let createLinkedProduct: ReturnType<typeof vi.fn>;
  let autoShareIfLinked: ReturnType<typeof vi.fn>;
  let shareProduct: ReturnType<typeof vi.fn>;
  let publishUpdate: ReturnType<typeof vi.fn>;
  let activatePriceOverride: ReturnType<typeof vi.fn>;
  let deactivatePriceOverride: ReturnType<typeof vi.fn>;
  let acceptPriceReview: ReturnType<typeof vi.fn>;
  let rejectPriceReview: ReturnType<typeof vi.fn>;
  let activateRecipeOverride: ReturnType<typeof vi.fn>;
  let deactivateRecipeOverride: ReturnType<typeof vi.fn>;
  let acceptRecipeReview: ReturnType<typeof vi.fn>;
  let rejectRecipeReview: ReturnType<typeof vi.fn>;
  // Repos SQL directos
  let invGet: ReturnType<typeof vi.fn>;
  let invGetAllByLocation: ReturnType<typeof vi.fn>;
  let invTransferStock: ReturnType<typeof vi.fn>;
  let invDecrementAvailableStock: ReturnType<typeof vi.fn>;
  let invIncrementStock: ReturnType<typeof vi.fn>;
  let stockCreateWithClient: ReturnType<typeof vi.fn>;
  let wasteFindById: ReturnType<typeof vi.fn>;

  let router: ReturnType<typeof createProductsRouter>;

  beforeEach(async () => {
    listProducts = vi.fn(async () => [makeProduct()]);
    createProduct = vi.fn(async () => makeProduct());
    getProduct = vi.fn(async () => makeProduct());
    updateProduct = vi.fn(async () => makeProduct({ name: 'Coca-Cola Zero' }));
    deleteProduct = vi.fn(async () => {});
    listVariants = vi.fn(async () => [makeVariant()]);
    createVariant = vi.fn(async () => makeVariant());
    updateVariant = vi.fn(async () => makeVariant({ name: 'Talle L' }));
    deleteVariant = vi.fn(async () => {});
    checkStock = vi.fn(async () => {});
    decrementStock = vi.fn(async () => {});
    vi.mocked(ProductService).mockImplementation(() => ({
      listProducts, createProduct, getProduct, updateProduct, deleteProduct,
      listVariants, createVariant, updateVariant, deleteVariant, checkStock, decrementStock,
    } as unknown as ProductService));

    listRecipe = vi.fn(async () => []);
    addRecipeItem = vi.fn(async () => ({ id: 'ri-1', parentProductId: 'prod-1' }));
    updateRecipeItem = vi.fn(async () => ({ id: 'ri-1', quantityPerUnit: 2 }));
    removeRecipeItem = vi.fn(async () => true);
    explodeRecipeForProduction = vi.fn(async () => [{ productId: 'comp-1', productVariantId: null, quantity: 3 }]);
    vi.mocked(RecipeService).mockImplementation(() => ({
      listRecipe, addRecipeItem, updateRecipeItem, removeRecipeItem, explodeRecipeForProduction,
    } as unknown as RecipeService));

    listCompanyCatalog = vi.fn(async () => []);
    createLinkedProduct = vi.fn(async () => makeProduct({ companyProductId: 'cp-1' }));
    autoShareIfLinked = vi.fn(async () => {});
    shareProduct = vi.fn(async () => makeProduct({ companyProductId: 'cp-1' }));
    publishUpdate = vi.fn(async () => {});
    activatePriceOverride = vi.fn(async () => makeProduct({ priceOverrideStatus: 'ACTIVO' }));
    deactivatePriceOverride = vi.fn(async () => makeProduct({ priceOverrideStatus: 'INACTIVO' }));
    acceptPriceReview = vi.fn(async () => makeProduct());
    rejectPriceReview = vi.fn(async () => makeProduct());
    activateRecipeOverride = vi.fn(async () => makeProduct({ recipeOverrideStatus: 'ACTIVO' }));
    deactivateRecipeOverride = vi.fn(async () => makeProduct({ recipeOverrideStatus: 'INACTIVO' }));
    acceptRecipeReview = vi.fn(async () => makeProduct());
    rejectRecipeReview = vi.fn(async () => makeProduct());
    vi.mocked(CompanyCatalogService).mockImplementation(() => ({
      listCompanyCatalog, createLinkedProduct, autoShareIfLinked, shareProduct, publishUpdate,
      activatePriceOverride, deactivatePriceOverride, acceptPriceReview, rejectPriceReview,
      activateRecipeOverride, deactivateRecipeOverride, acceptRecipeReview, rejectRecipeReview,
    } as unknown as CompanyCatalogService));

    invGet = vi.fn(async () => makeLevel());
    invGetAllByLocation = vi.fn(async () => [makeLevel()]);
    invTransferStock = vi.fn(async () => {});
    invDecrementAvailableStock = vi.fn(async () => {});
    invIncrementStock = vi.fn(async () => {});
    const { SqlInventoryLevelRepository } = await import('../repositories/sql.inventory-level.repository.js');
    vi.mocked(SqlInventoryLevelRepository).mockImplementation(() => ({
      get: invGet, getAllByLocation: invGetAllByLocation, transferStock: invTransferStock,
      decrementAvailableStock: invDecrementAvailableStock, incrementStock: invIncrementStock,
    } as unknown as InstanceType<typeof SqlInventoryLevelRepository>));

    stockCreateWithClient = vi.fn(async () => true);
    const { SqlStockMovementRepository } = await import('../repositories/sql.stock-movement.repository.js');
    vi.mocked(SqlStockMovementRepository).mockImplementation(() => ({
      createWithClient: stockCreateWithClient,
    } as unknown as InstanceType<typeof SqlStockMovementRepository>));

    wasteFindById = vi.fn(async () => ({ id: 'wr-1', businessId: 'biz-1', name: 'Vencimiento', active: true, createdAt: new Date(), updatedAt: new Date() }));
    const { SqlWasteReasonRepository } = await import('../repositories/sql.waste-reason.repository.js');
    vi.mocked(SqlWasteReasonRepository).mockImplementation(() => ({
      findById: wasteFindById,
    } as unknown as InstanceType<typeof SqlWasteReasonRepository>));

    router = createProductsRouter({} as AppContainer);
  });

  function baseReq(overrides: Partial<Request> = {}): Request {
    return {
      db: {}, businessId: 'biz-1', user: { id: 'identity-1', businessId: 'biz-1' },
      params: {}, query: { locationId: 'loc-1' }, body: {},
      ...overrides,
    } as unknown as Request;
  }

  async function expectHappy(handler: (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>, req: Request, res: Response) {
    await handler(req, res, () => { throw new Error('no debería llamar next()'); });
  }

  // ── Producto ────────────────────────────────────────────────────────────
  it('GET / -- lista productos con stock enriquecido', async () => {
    const handler = getHandler(router, 'get', '/');
    const res = fakeRes();
    await expectHappy(handler, baseReq(), res);
    expect(listProducts).toHaveBeenCalledWith('biz-1', undefined);
    expect(res.json).toHaveBeenCalledWith([expect.objectContaining({ id: 'prod-1', stockQuantity: 10 })]);
  });

  it('POST / -- crea un producto local (sin companyProductId)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { name: 'Coca-Cola', basePrice: 100, locationId: 'loc-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(createProduct).toHaveBeenCalledOnce();
    expect(autoShareIfLinked).toHaveBeenCalledWith('biz-1', 'prod-1');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('POST / -- con companyProductId usa el catálogo de empresa, no createProduct', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { companyProductId: 'cp-1', locationId: 'loc-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(createLinkedProduct).toHaveBeenCalledWith('biz-1', 'cp-1');
    expect(createProduct).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('GET /company-catalog -- delega al catálogo de la empresa', async () => {
    const handler = getHandler(router, 'get', '/company-catalog');
    const res = fakeRes();
    await expectHappy(handler, baseReq(), res);
    expect(listCompanyCatalog).toHaveBeenCalledWith('biz-1');
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it('GET /:id -- devuelve el producto con stock', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'prod-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(getProduct).toHaveBeenCalledWith('prod-1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'prod-1', stockQuantity: 10 }));
  });

  it('GET /:id -- 404 si no existe', async () => {
    getProduct.mockResolvedValueOnce(null);
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'prod-x' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('PUT /:id -- actualiza y pasa el id de quien edita', async () => {
    const updated = makeProduct({ name: 'Coca-Cola Zero' });
    updateProduct.mockResolvedValueOnce(updated);
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'prod-1' }, body: { name: 'Coca-Cola Zero' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(updateProduct).toHaveBeenCalledWith('prod-1', { name: 'Coca-Cola Zero' }, 'identity-1');
    expect(res.json).toHaveBeenCalledWith(updated);
  });

  it('PUT /:id -- 404 si no existe', async () => {
    updateProduct.mockResolvedValueOnce(null);
    const handler = getHandler(router, 'put', '/:id');
    const req = baseReq({ params: { id: 'prod-x' }, body: {} } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('DELETE /:id -- 204', async () => {
    const handler = getHandler(router, 'delete', '/:id');
    const req = baseReq({ params: { id: 'prod-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(deleteProduct).toHaveBeenCalledWith('prod-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  // ── Variantes ───────────────────────────────────────────────────────────
  it('GET /:id/variants -- lista variantes con stock', async () => {
    const handler = getHandler(router, 'get', '/:id/variants');
    const req = baseReq({ params: { id: 'prod-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(listVariants).toHaveBeenCalledWith('prod-1');
    expect(res.json).toHaveBeenCalled();
  });

  it('POST /:id/variants -- crea variante (201)', async () => {
    const handler = getHandler(router, 'post', '/:id/variants');
    const req = baseReq({ params: { id: 'prod-1' }, body: { name: 'Talle M', locationId: 'loc-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(createVariant).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('PUT /:id/variants/:variantId -- actualiza variante', async () => {
    const handler = getHandler(router, 'put', '/:id/variants/:variantId');
    const req = baseReq({ params: { id: 'prod-1', variantId: 'var-1' }, body: { name: 'Talle L' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(updateVariant).toHaveBeenCalledWith('var-1', { name: 'Talle L' }, 'identity-1');
  });

  it('PUT /:id/variants/:variantId -- 404 si no existe', async () => {
    updateVariant.mockResolvedValueOnce(null);
    const handler = getHandler(router, 'put', '/:id/variants/:variantId');
    const req = baseReq({ params: { id: 'prod-1', variantId: 'var-x' }, body: {} } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('DELETE /:id/variants/:variantId -- 204', async () => {
    const handler = getHandler(router, 'delete', '/:id/variants/:variantId');
    const req = baseReq({ params: { id: 'prod-1', variantId: 'var-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(deleteVariant).toHaveBeenCalledWith('var-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });

  // ── Receta ──────────────────────────────────────────────────────────────
  it('GET /:id/recipe-items -- lista la receta', async () => {
    const handler = getHandler(router, 'get', '/:id/recipe-items');
    const req = baseReq({ params: { id: 'prod-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(listRecipe).toHaveBeenCalledWith('prod-1');
  });

  it('POST /:id/recipe-items -- agrega un ítem (201)', async () => {
    const handler = getHandler(router, 'post', '/:id/recipe-items');
    const req = baseReq({ params: { id: 'prod-1' }, body: { componentProductId: 'comp-1', quantityPerUnit: 2 } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(addRecipeItem).toHaveBeenCalledWith(expect.objectContaining({ parentProductId: 'prod-1', componentProductId: 'comp-1' }));
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('POST /:id/recipe-items -- 400 si viola el refine (ambos componentes)', async () => {
    const handler = getHandler(router, 'post', '/:id/recipe-items');
    const req = baseReq({
      params: { id: 'prod-1' },
      body: { componentProductId: 'comp-1', componentVariantId: 'var-1', quantityPerUnit: 2 },
    } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(addRecipeItem).not.toHaveBeenCalled();
  });

  it('PUT /:id/recipe-items/:itemId -- actualiza cantidad', async () => {
    const handler = getHandler(router, 'put', '/:id/recipe-items/:itemId');
    const req = baseReq({ params: { id: 'prod-1', itemId: 'ri-1' }, body: { quantityPerUnit: 2 } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(updateRecipeItem).toHaveBeenCalledWith('ri-1', { quantityPerUnit: 2 });
  });

  it('DELETE /:id/recipe-items/:itemId -- 204, o 404 si no existía', async () => {
    const handler = getHandler(router, 'delete', '/:id/recipe-items/:itemId');
    const req = baseReq({ params: { id: 'prod-1', itemId: 'ri-1' } } as Partial<Request>);

    let res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(204);

    removeRecipeItem.mockResolvedValueOnce(false);
    res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  // ── Stock ───────────────────────────────────────────────────────────────
  it('POST /:id/stock/decrement -- camino feliz y 400 si quantity inválida', async () => {
    const handler = getHandler(router, 'post', '/:id/stock/decrement');
    let req = baseReq({ params: { id: 'prod-1' }, body: { quantity: 2 } } as Partial<Request>);
    let res = fakeRes();
    await expectHappy(handler, req, res);
    expect(checkStock).toHaveBeenCalledWith('prod-1', undefined, 'loc-1', 2);
    expect(decrementStock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(204);

    req = baseReq({ params: { id: 'prod-1' }, body: { quantity: 0 } } as Partial<Request>);
    res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('POST /:id/variants/:variantId/stock/decrement -- camino feliz', async () => {
    const handler = getHandler(router, 'post', '/:id/variants/:variantId/stock/decrement');
    const req = baseReq({ params: { id: 'prod-1', variantId: 'var-1' }, body: { quantity: 1 } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(checkStock).toHaveBeenCalledWith('prod-1', 'var-1', 'loc-1', 1);
    expect(res.status).toHaveBeenCalledWith(204);
  });

  it('POST /stock/transfer -- camino feliz (201) y 400 misma ubicación', async () => {
    const handler = getHandler(router, 'post', '/stock/transfer');
    let req = baseReq({
      body: { productId: 'prod-1', fromLocationId: 'loc-1', toLocationId: 'loc-2', quantity: 3 },
    } as Partial<Request>);
    let res = fakeRes();
    await expectHappy(handler, req, res);
    expect(stockCreateWithClient).toHaveBeenCalled();
    expect(invTransferStock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);

    req = baseReq({
      body: { productId: 'prod-1', fromLocationId: 'loc-1', toLocationId: 'loc-1', quantity: 3 },
    } as Partial<Request>);
    res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('POST /stock/transfer -- 404 producto inexistente, 400 si tiene variantes', async () => {
    const handler = getHandler(router, 'post', '/stock/transfer');

    getProduct.mockResolvedValueOnce(null);
    let req = baseReq({ body: { productId: 'prod-x', fromLocationId: 'loc-1', toLocationId: 'loc-2', quantity: 1 } } as Partial<Request>);
    let res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(404);

    getProduct.mockResolvedValueOnce(makeProduct({ hasVariants: true }));
    req = baseReq({ body: { productId: 'prod-1', fromLocationId: 'loc-1', toLocationId: 'loc-2', quantity: 1 } } as Partial<Request>);
    res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRODUCT_HAS_VARIANTS' }));
  });

  it('POST /stock/waste -- camino feliz (201)', async () => {
    const handler = getHandler(router, 'post', '/stock/waste');
    const req = baseReq({
      body: { productId: 'prod-1', quantity: 1, wasteReasonId: 'wr-1' },
    } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(wasteFindById).toHaveBeenCalledWith('wr-1');
    expect(stockCreateWithClient).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('POST /stock/waste -- 404 motivo inexistente, 400 motivo inactivo, 400 stock insuficiente', async () => {
    const handler = getHandler(router, 'post', '/stock/waste');
    const req = baseReq({ body: { productId: 'prod-1', quantity: 1, wasteReasonId: 'wr-1' } } as Partial<Request>);

    wasteFindById.mockResolvedValueOnce(undefined);
    let res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(404);

    wasteFindById.mockResolvedValueOnce({ id: 'wr-1', businessId: 'biz-1', name: 'x', active: false, createdAt: new Date(), updatedAt: new Date() });
    res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'WASTE_REASON_INACTIVE' }));

    invGet.mockResolvedValueOnce(makeLevel({ stockQuantity: 1, reservedQuantity: 1 })); // available = 0 < quantity 1
    res = fakeRes();
    const next = vi.fn();
    await handler(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(InsufficientStockError));
  });

  it('POST /stock/production -- camino feliz (201), explota receta y aplica componentes', async () => {
    const handler = getHandler(router, 'post', '/stock/production');
    const req = baseReq({ body: { productId: 'prod-1', quantity: 5 } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(explodeRecipeForProduction).toHaveBeenCalledWith('prod-1', 5);
    expect(invDecrementAvailableStock).toHaveBeenCalled();
    expect(invIncrementStock).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('POST /stock/production -- 400 si el body no cumple el schema', async () => {
    const handler = getHandler(router, 'post', '/stock/production');
    const req = baseReq({ body: { quantity: 5 } } as Partial<Request>); // sin productId
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  // ── Empresas multipropiedad ─────────────────────────────────────────────
  it('POST /:id/company/share -- delega a CompanyCatalogService.shareProduct(businessId, id)', async () => {
    const handler = getHandler(router, 'post', '/:id/company/share');
    const req = baseReq({ params: { id: 'prod-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(shareProduct).toHaveBeenCalledWith('biz-1', 'prod-1');
    expect(res.json).toHaveBeenCalled();
  });

  it.each([
    ['/:id/company/price-override/activate', 'post', 'activatePriceOverride', () => activatePriceOverride],
    ['/:id/company/price-override/deactivate', 'post', 'deactivatePriceOverride', () => deactivatePriceOverride],
    ['/:id/company/price-override/accept', 'post', 'acceptPriceReview', () => acceptPriceReview],
    ['/:id/company/price-override/reject', 'post', 'rejectPriceReview', () => rejectPriceReview],
    ['/:id/company/recipe-override/activate', 'post', 'activateRecipeOverride', () => activateRecipeOverride],
    ['/:id/company/recipe-override/deactivate', 'post', 'deactivateRecipeOverride', () => deactivateRecipeOverride],
    ['/:id/company/recipe-override/accept', 'post', 'acceptRecipeReview', () => acceptRecipeReview],
    ['/:id/company/recipe-override/reject', 'post', 'rejectRecipeReview', () => rejectRecipeReview],
  ] as const)('%s -- delega a CompanyCatalogService.%s y devuelve 200', async (path, method, _name, getMock) => {
    const handler = getHandler(router, method, path);
    const req = baseReq({ params: { id: 'prod-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(getMock()).toHaveBeenCalledWith('prod-1');
    expect(res.json).toHaveBeenCalled();
  });

  it('POST /:id/company/publish -- 204, sin devolver body', async () => {
    const handler = getHandler(router, 'post', '/:id/company/publish');
    const req = baseReq({ params: { id: 'prod-1' } } as Partial<Request>);
    const res = fakeRes();
    await expectHappy(handler, req, res);
    expect(publishUpdate).toHaveBeenCalledWith('biz-1', 'prod-1');
    expect(res.status).toHaveBeenCalledWith(204);
  });
});
