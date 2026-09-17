/**
 * @file orders.routes.test.ts
 * @description I7 (pendientes-2026-08-24.md) -- cobertura de rutas para
 * orders.routes.ts (0% antes de este archivo). Mismo patrón que
 * users.routes.test.ts: handler extraído del stack del router, sin
 * Express real.
 *
 * `createOrdersRouter` arma OrderService (y sus dependencias: ProductService,
 * RecipeService, OrderPricingService) directo desde req.db, sin seam de
 * inyección -- se mockea `./order.service.js` a nivel de módulo, quedándose
 * con las clases de error reales (son las que el router usa en los
 * `instanceof` de cada catch) vía `importOriginal`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZodError } from 'zod';
import type { Request, Response } from 'express';
import { createOrdersRouter } from './orders.routes.js';
import {
  OrderService,
  OrderNotFoundError,
  OrderNotEditableError,
  InvalidOrderTransitionError,
  InvalidPaymentInfoError,
  OrderNotServableError,
  OrderStateUnknownError,
} from './order.service.js';
import { ProductNotFoundError, InsufficientStockError } from './product.service.js';
import type { Order, OrderItem } from './order.entities.js';
import type { AppContainer } from '../container.js';
import type * as OrderServiceModule from './order.service.js';

vi.mock('./order.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof OrderServiceModule>();
  return { ...actual, OrderService: vi.fn() };
});

// buildOrderService() arma buildTenantTransactionManager(req) como argumento
// del constructor -- se evalúa igual aunque OrderService esté mockeado, y la
// implementación real busca un pool de tenant registrado (getTenantRawPool)
// que no existe en este test.
vi.mock('../db/tenant-context.js', () => ({
  buildTenantTransactionManager: vi.fn(() => ({})),
}));

function fakeRes() {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json   = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  res.send   = vi.fn(() => res as Response);
  return res as Response & { statusCode?: number; body?: unknown };
}

function getHandler(router: ReturnType<typeof createOrdersRouter>, method: 'get' | 'post' | 'patch' | 'delete', path: string) {
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...args: unknown[]) => unknown }> } }> }).stack;
  const layer = stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer?.route) throw new Error(`${method.toUpperCase()} ${path} no está montado`);
  return layer.route.stack[layer.route.stack.length - 1]!.handle as (req: Request, res: Response, next: (err?: unknown) => void) => Promise<void>;
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'ord-1', businessId: 'biz-1', customerId: 'cust-1', status: 'DRAFT',
    notes: null, stayId: null, locationId: 'loc-1', confirmedAt: null, cancelledAt: null,
    completedAt: null, servedAt: null, items: [],
    ...overrides,
  } as unknown as Order;
}

function makeItem(overrides: Partial<OrderItem> = {}): OrderItem {
  return {
    id: 'oi-1', orderId: 'ord-1', itemType: 'PRODUCT', productId: 'prod-1', productVariantId: null,
    reservationId: null, quantity: 1, unitPrice: 100, subtotal: 100, notes: null, stockSnapshot: null,
    ivaRate: null, appliedCustomerRateId: null, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as unknown as OrderItem;
}

describe('orders.routes', () => {
  let listOrders: ReturnType<typeof vi.fn>;
  let createOrder: ReturnType<typeof vi.fn>;
  let getOrder: ReturnType<typeof vi.fn>;
  let confirmOrder: ReturnType<typeof vi.fn>;
  let markServed: ReturnType<typeof vi.fn>;
  let completeOrder: ReturnType<typeof vi.fn>;
  let cancelOrder: ReturnType<typeof vi.fn>;
  let updateNotes: ReturnType<typeof vi.fn>;
  let addItem: ReturnType<typeof vi.fn>;
  let removeItem: ReturnType<typeof vi.fn>;
  let router: ReturnType<typeof createOrdersRouter>;

  beforeEach(() => {
    listOrders = vi.fn(async () => [makeOrder()]);
    createOrder = vi.fn(async () => makeOrder());
    getOrder = vi.fn(async () => makeOrder());
    confirmOrder = vi.fn(async () => makeOrder({ status: 'CONFIRMED' }));
    markServed = vi.fn(async () => makeOrder({ servedAt: new Date() }));
    completeOrder = vi.fn(async () => makeOrder({ status: 'COMPLETED' }));
    cancelOrder = vi.fn(async () => makeOrder({ status: 'CANCELLED' }));
    updateNotes = vi.fn(async () => makeOrder({ notes: 'nueva nota' }));
    addItem = vi.fn(async () => makeItem());
    removeItem = vi.fn(async () => {});
    vi.mocked(OrderService).mockImplementation(() => ({
      listOrders, createOrder, getOrder, confirmOrder, markServed, completeOrder,
      cancelOrder, updateNotes, addItem, removeItem,
    } as unknown as OrderService));
    router = createOrdersRouter({} as AppContainer);
  });

  function baseReq(overrides: Partial<Request> = {}): Request {
    return {
      db: {}, businessId: 'biz-1', user: { id: 'identity-1', businessId: 'biz-1' },
      params: {}, query: {}, body: {},
      ...overrides,
    } as unknown as Request;
  }

  it('GET / -- lista órdenes del negocio, con filtros compactados', async () => {
    const handler = getHandler(router, 'get', '/');
    const req = baseReq({ query: { status: 'DRAFT' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(listOrders).toHaveBeenCalledWith({ businessId: 'biz-1', status: 'DRAFT' });
    expect(res.json).toHaveBeenCalled();
  });

  it('GET / -- 400 si `from` no es una fecha ISO válida', async () => {
    const handler = getHandler(router, 'get', '/');
    const req = baseReq({ query: { from: 'ayer' } } as Partial<Request>);
    const res = fakeRes();

    let caught: unknown;
    await handler(req, res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(listOrders).not.toHaveBeenCalled();
  });

  it('POST / -- crea la orden (201)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({
      body: {
        customerId: 'cust-1', locationId: 'loc-1',
        items: [{ itemType: 'RESERVATION', quantity: 1, reservationId: 'res-1', unitPrice: 100 }],
      },
    } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(createOrder).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('POST / -- 400 si el body no cumple el schema (sin customerId)', async () => {
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({ body: { locationId: 'loc-1', items: [] } } as Partial<Request>);
    const res = fakeRes();

    let caught: unknown;
    await handler(req, res, (err) => { caught = err; });

    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(createOrder).not.toHaveBeenCalled();
  });

  it('POST / -- mapea ProductNotFoundError a 404 (handleItemPricingError)', async () => {
    createOrder.mockRejectedValueOnce(new ProductNotFoundError('prod-x'));
    const handler = getHandler(router, 'post', '/');
    const req = baseReq({
      body: {
        customerId: 'cust-1', locationId: 'loc-1',
        items: [{ itemType: 'PRODUCT', quantity: 1, productId: 'prod-x' }],
      },
    } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PRODUCT_NOT_FOUND' }));
  });

  it('GET /:id -- devuelve la orden', async () => {
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'ord-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(getOrder).toHaveBeenCalledWith('ord-1');
    expect(res.json).toHaveBeenCalled();
  });

  it('GET /:id -- 404 si no existe', async () => {
    getOrder.mockResolvedValueOnce(null);
    const handler = getHandler(router, 'get', '/:id');
    const req = baseReq({ params: { id: 'ord-x' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('POST /:id/confirm -- camino feliz', async () => {
    const handler = getHandler(router, 'post', '/:id/confirm');
    const req = baseReq({ params: { id: 'ord-1' } } as Partial<Request>);
    const res = fakeRes();

    await handler(req, res, () => { throw new Error('no debería llamar next()'); });

    // Bug #4 (27/08/2026) -- la ruta ahora pasa el actor (req.user.id) para auditar la transición.
    expect(confirmOrder).toHaveBeenCalledWith('ord-1', 'identity-1');
    expect(res.json).toHaveBeenCalledWith(makeOrder({ status: 'CONFIRMED' }));
  });

  it('POST /:id/confirm -- 404 orden inexistente, 409 transición inválida, 400 stock insuficiente', async () => {
    const handler = getHandler(router, 'post', '/:id/confirm');
    const req = baseReq({ params: { id: 'ord-1' } } as Partial<Request>);

    confirmOrder.mockRejectedValueOnce(new OrderNotFoundError('ord-1'));
    let res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(404);

    confirmOrder.mockRejectedValueOnce(new InvalidOrderTransitionError('CONFIRMED', 'CONFIRMED'));
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(409);

    confirmOrder.mockRejectedValueOnce(new InsufficientStockError(0, 1));
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_STOCK' }));
  });

  it('POST /:id/serve -- camino feliz y errores (404/409)', async () => {
    const handler = getHandler(router, 'post', '/:id/serve');
    const req = baseReq({ params: { id: 'ord-1' } } as Partial<Request>);

    let res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    // ORDER-16 (03/09/2026): la ruta pasa el actor real (req.user.id) para
    // que el sello de served_at deje una fila de audit_log con quién lo hizo.
    expect(markServed).toHaveBeenCalledWith('ord-1', 'identity-1');
    expect(res.json).toHaveBeenCalled();

    markServed.mockRejectedValueOnce(new OrderNotServableError('ord-1', 'DRAFT'));
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORDER_NOT_SERVABLE' }));

    // O1 (02/09/2026): ORDER_ALREADY_SERVED dejó de existir -- servir una
    // orden ya servida es 200 idempotente. Lo que sí tiene que mapear acá es
    // el estado desconocido, con código propio y distinto de INVALID_TRANSITION.
    markServed.mockRejectedValueOnce(new OrderStateUnknownError('ord-1'));
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'ORDER_STATE_UNKNOWN' }));
  });

  it('POST /:id/complete -- camino feliz, 400 validación, 409 InvalidPaymentInfoError', async () => {
    const handler = getHandler(router, 'post', '/:id/complete');
    let req = baseReq({ params: { id: 'ord-1' }, body: { paymentMethod: 'CASH' } } as Partial<Request>);

    let res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(completeOrder).toHaveBeenCalledOnce();
    expect(res.json).toHaveBeenCalled();

    req = baseReq({ params: { id: 'ord-1' }, body: { paymentMethod: 'BITCOIN' } } as Partial<Request>);
    res = fakeRes();
    let caught: unknown;
    await handler(req, res, (err) => { caught = err; });
    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();

    completeOrder.mockRejectedValueOnce(new InvalidPaymentInfoError('cardInstallments solo aplica con CARD'));
    req = baseReq({ params: { id: 'ord-1' }, body: { paymentMethod: 'CASH' } } as Partial<Request>);
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('POST /:id/cancel -- camino feliz y 409 transición inválida', async () => {
    const handler = getHandler(router, 'post', '/:id/cancel');
    const req = baseReq({ params: { id: 'ord-1' } } as Partial<Request>);

    let res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(cancelOrder).toHaveBeenCalledWith('ord-1', 'identity-1');

    cancelOrder.mockRejectedValueOnce(new InvalidOrderTransitionError('COMPLETED', 'CANCELLED'));
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('PATCH /:id/notes -- camino feliz y 404', async () => {
    const handler = getHandler(router, 'patch', '/:id/notes');
    const req = baseReq({ params: { id: 'ord-1' }, body: { notes: 'nueva nota' } } as Partial<Request>);

    let res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(updateNotes).toHaveBeenCalledWith('ord-1', 'nueva nota');

    updateNotes.mockRejectedValueOnce(new OrderNotFoundError('ord-1'));
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('POST /:id/items -- camino feliz, 400 validación, 409 orden no editable', async () => {
    const handler = getHandler(router, 'post', '/:id/items');
    let req = baseReq({
      params: { id: 'ord-1' },
      body: { itemType: 'RESERVATION', quantity: 1, reservationId: 'res-1', unitPrice: 50 },
    } as Partial<Request>);

    let res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(addItem).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(201);

    req = baseReq({ params: { id: 'ord-1' }, body: { itemType: 'RESERVATION' } } as Partial<Request>);
    res = fakeRes();
    let caught: unknown;
    await handler(req, res, (err) => { caught = err; });
    expect(caught).toBeInstanceOf(ZodError);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();

    addItem.mockRejectedValueOnce(new OrderNotEditableError('ord-1', 'CONFIRMED'));
    req = baseReq({
      params: { id: 'ord-1' },
      body: { itemType: 'RESERVATION', quantity: 1, reservationId: 'res-1', unitPrice: 50 },
    } as Partial<Request>);
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it('DELETE /:id/items/:itemId -- camino feliz y 404', async () => {
    const handler = getHandler(router, 'delete', '/:id/items/:itemId');
    const req = baseReq({ params: { id: 'ord-1', itemId: 'oi-1' } } as Partial<Request>);

    let res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(removeItem).toHaveBeenCalledWith('ord-1', 'oi-1');
    expect(res.status).toHaveBeenCalledWith(204);

    removeItem.mockRejectedValueOnce(new OrderNotFoundError('ord-1'));
    res = fakeRes();
    await handler(req, res, () => { throw new Error('no next'); });
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
