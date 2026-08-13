/**
 * @file orders.routes.ts
 * @description Rutas REST para órdenes (carrito unificado reserva + producto).
 *
 * GET    /api/orders                    — ORDERS (OWNER, ADMIN, WAITER)
 * POST   /api/orders                    — BOOKING (empleados + CUSTOMER desde portal)
 * GET    /api/orders/:id                — ORDERS
 * POST   /api/orders/:id/confirm        — ORDERS
 * POST   /api/orders/:id/complete       — ORDERS
 * POST   /api/orders/:id/cancel         — ORDERS
 * PATCH  /api/orders/:id/notes          — ORDERS
 * POST   /api/orders/:id/items          — BOOKING (el cliente puede agregar ítems en DRAFT)
 * DELETE /api/orders/:id/items/:itemId  — ORDERS
 *
 * ## Multi-tenant
 * buildOrderService(req) instancia SqlOrderRepository usando req.db
 * del tenant activo (inyectado por tenantMiddleware).
 *
 * ## Transacción en createOrder (fix C1)
 * OrderService recibe buildTenantTransactionManager(req) para envolver
 * INSERT orders + INSERT order_items en un único BEGIN/COMMIT.
 *
 * ## exactOptionalPropertyTypes
 * Ver comentarios originales sobre CreateOrderInput, notas y stripItemUndefined.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import type { AppContainer } from '../../container.js';
import {
  OrderService,
  OrderNotFoundError,
  OrderNotEditableError,
  InvalidOrderTransitionError,
} from '../../services/order.service.js';
import { SqlOrderRepository }            from '../../repositories/sql.order.repository.js';
import { SqlDomainEventRepository }      from '../../repositories/sql.domain-event.repository.js';
import { buildTenantTransactionManager } from '../../db/tenant-context.js';
import { compact }                       from '../utils/compact.js';
import { authorize }                     from '../../security/auth.middleware.js';
import { Roles }                         from '../../security/roles.js';
import type { OrderStatus, CreateOrderItemInput } from '../../domain/order.entities.js';
import {
  CreateOrderSchema,
  CreateOrderItemSchema,
  type CreateOrderItemBody,
} from '../schemas/request.schemas.js';

function buildOrderService(req: Request, _container: AppContainer): OrderService {
  return new OrderService(
    new SqlOrderRepository(req.db!),
    buildTenantTransactionManager(req),
    new SqlDomainEventRepository(req.db!),
  );
}

function param(req: Request, key: string): string {
  return String(req.params[key]);
}

function validationError(res: Response, errors: { path: string; message: string }[]): void {
  res.status(400).json({ code: 'VALIDATION_ERROR', errors });
}

function stripItemUndefined(item: CreateOrderItemBody): CreateOrderItemInput {
  return {
    itemType:         item.itemType,
    quantity:         item.quantity,
    unitPrice:        item.unitPrice,
    productId:        item.productId        ?? null,
    productVariantId: item.productVariantId ?? null,
    reservationId:    item.reservationId    ?? null,
  };
}

export function createOrdersRouter(container: AppContainer): Router {
  const router = Router();

  // ── GET /api/orders ─────────────────────────────────────────────────────────
  router.get('/', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildOrderService(req, container);
      const { customerId, status, from, to, limit, offset } = req.query as Record<string, string>;
      const optionalFilters = compact({
        ...(customerId !== undefined && { customerId }),
        ...(status     !== undefined && { status: status as OrderStatus }),
        ...(from       !== undefined && { from:   new Date(from) }),
        ...(to         !== undefined && { to:     new Date(to) }),
        ...(limit      !== undefined && { limit:  Number(limit) }),
        ...(offset     !== undefined && { offset: Number(offset) }),
      });
      const orders = await service.listOrders({ businessId: req.businessId!, ...optionalFilters });
      res.json(orders);
    } catch (err) { next(err); }
  });

  // ── POST /api/orders ────────────────────────────────────────────────────────
  // BOOKING = OWNER, ADMIN, RECEPTIONIST, CUSTOMER
  router.post('/', authorize(Roles.BOOKING), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      const service = buildOrderService(req, container);
      const order = await service.createOrder({
        businessId: req.businessId!,
        customerId: parsed.data.customerId,
        items:      parsed.data.items.map(stripItemUndefined),
        ...(parsed.data.notes  !== undefined && { notes: parsed.data.notes }),
        ...(parsed.data.stayId !== undefined && { stayId: parsed.data.stayId }),
      });
      res.status(201).json(order);
    } catch (err) { next(err); }
  });

  // ── GET /api/orders/:id ─────────────────────────────────────────────────────
  router.get('/:id', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildOrderService(req, container);
      const order = await service.getOrder(param(req, 'id'));
      if (!order) {
        res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Orden no encontrada.' });
        return;
      }
      res.json(order);
    } catch (err) { next(err); }
  });

  // ── POST /api/orders/:id/confirm ─────────────────────────────────────────────
  router.post('/:id/confirm', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).confirmOrder(param(req, 'id'));
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else next(err);
    }
  });

  // ── POST /api/orders/:id/complete ────────────────────────────────────────────
  router.post('/:id/complete', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).completeOrder(param(req, 'id'));
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else next(err);
    }
  });

  // ── POST /api/orders/:id/cancel ──────────────────────────────────────────────
  router.post('/:id/cancel', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).cancelOrder(param(req, 'id'));
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else next(err);
    }
  });

  // ── PATCH /api/orders/:id/notes ──────────────────────────────────────────────
  router.patch('/:id/notes', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { notes } = req.body as { notes?: string | null };
      const order = await buildOrderService(req, container).updateNotes(param(req, 'id'), notes ?? null);
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)         res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof OrderNotEditableError) res.status(409).json({ code: 'ORDER_NOT_EDITABLE', message: (err as Error).message });
      else next(err);
    }
  });

  // ── POST /api/orders/:id/items ────────────────────────────────────────────────
  // BOOKING = el cliente puede agregar ítems a su orden en DRAFT
  router.post('/:id/items', authorize(Roles.BOOKING), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateOrderItemSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      const item = await buildOrderService(req, container).addItem(
        param(req, 'id'),
        stripItemUndefined(parsed.data),
      );
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof OrderNotFoundError)         res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof OrderNotEditableError) res.status(409).json({ code: 'ORDER_NOT_EDITABLE', message: (err as Error).message });
      else next(err);
    }
  });

  // ── DELETE /api/orders/:id/items/:itemId ──────────────────────────────────────
  router.delete('/:id/items/:itemId', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      await buildOrderService(req, container).removeItem(param(req, 'id'), param(req, 'itemId'));
      res.status(204).send();
    } catch (err) {
      if (err instanceof OrderNotFoundError)         res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof OrderNotEditableError) res.status(409).json({ code: 'ORDER_NOT_EDITABLE', message: (err as Error).message });
      else next(err);
    }
  });

  return router;
}
