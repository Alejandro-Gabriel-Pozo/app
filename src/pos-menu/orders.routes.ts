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
 * POST   /api/orders/:id/serve          — ORDERS (marca servedAt, no cambia status)
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
import type { AppContainer } from '../container.js';
import {
  OrderService,
  OrderNotFoundError,
  OrderNotEditableError,
  InvalidOrderTransitionError,
  InvalidPaymentInfoError,
  OrderNotServableError,
  OrderAlreadyServedError,
} from './order.service.js';
import {
  ProductService,
  ProductNotFoundError,
  VariantNotFoundError,
  VariantRequiredError,
  InsufficientStockError,
} from './product.service.js';
import { SqlOrderRepository }            from './sql.order.repository.js';
import { SqlDomainEventRepository }      from '../repositories/sql.domain-event.repository.js';
import { SqlProductRepository, SqlProductVariantRepository } from './sql.product.repository.js';
import { SqlAuditLogRepository }         from '../repositories/audit-log.repository.js';
import { SqlInventoryLevelRepository }   from '../repositories/sql.inventory-level.repository.js';
import { RecipeService }                 from './recipe.service.js';
import { SqlRecipeItemRepository }       from '../repositories/sql.recipe-item.repository.js';
import { resolveDefaultLocationId }      from '../platform/location.repository.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';
import { compact }                       from '../api/utils/compact.js';
import { authorize }                     from '../security/auth.middleware.js';
import { Roles }                         from '../security/roles.js';
import type { OrderStatus, CreateOrderItemInput } from './order.entities.js';
import {
  CreateOrderSchema,
  CreateOrderItemSchema,
  CompleteOrderSchema,
  type CreateOrderItemBody,
} from '../api/schemas/request.schemas.js';

function buildOrderService(req: Request, _container: AppContainer): OrderService {
  return new OrderService(
    new SqlOrderRepository(req.db!),
    buildTenantTransactionManager(req),
    new SqlDomainEventRepository(req.db!),
    new ProductService(
      new SqlProductRepository(req.db!),
      new SqlProductVariantRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
      new SqlInventoryLevelRepository(req.db!),
    ),
    new RecipeService(
      new SqlRecipeItemRepository(req.db!),
      new SqlProductRepository(req.db!),
      new SqlProductVariantRepository(req.db!),
    ),
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
      const service    = buildOrderService(req, container);
      const locationId = await resolveDefaultLocationId(req.db!, parsed.data.locationId);
      const order = await service.createOrder({
        businessId: req.businessId!,
        customerId: parsed.data.customerId,
        locationId,
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
      if (err instanceof OrderNotFoundError)                res.status(404).json({ code: 'ORDER_NOT_FOUND',       message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError)  res.status(409).json({ code: 'INVALID_TRANSITION',    message: (err as Error).message });
      else if (err instanceof InsufficientStockError)       res.status(400).json({ code: 'INSUFFICIENT_STOCK',    message: (err as Error).message });
      else if (err instanceof VariantRequiredError)         res.status(400).json({ code: 'VARIANT_REQUIRED',      message: (err as Error).message });
      else if (err instanceof ProductNotFoundError)         res.status(404).json({ code: 'PRODUCT_NOT_FOUND',     message: (err as Error).message });
      else if (err instanceof VariantNotFoundError)         res.status(404).json({ code: 'VARIANT_NOT_FOUND',     message: (err as Error).message });
      else next(err);
    }
  });

  // ── POST /api/orders/:id/serve ───────────────────────────────────────────────
  // Marca servedAt=NOW() — no cambia `status`. Señal de "se consumió
  // físicamente" que cancelOrder() usa para decidir si restaurar stock.
  router.post('/:id/serve', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).markServed(param(req, 'id'));
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)          res.status(404).json({ code: 'ORDER_NOT_FOUND',      message: (err as Error).message });
      else if (err instanceof OrderNotServableError)  res.status(409).json({ code: 'ORDER_NOT_SERVABLE',   message: (err as Error).message });
      else if (err instanceof OrderAlreadyServedError) res.status(409).json({ code: 'ORDER_ALREADY_SERVED', message: (err as Error).message });
      else next(err);
    }
  });

  // ── POST /api/orders/:id/complete ────────────────────────────────────────────
  // body opcional { paymentMethod?, cardInstallments?, cardSurchargeAmount? } —
  // 'CASH' vincula el CHARGE al turno de caja OPEN del negocio, si hay uno
  // (Gap Tango #2); cardInstallments/cardSurchargeAmount solo con 'CARD'
  // (Gap Tango #3, puramente descriptivo — no dispara plan de cuotas).
  router.post('/:id/complete', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CompleteOrderSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      const order = await buildOrderService(req, container).completeOrder(
        param(req, 'id'),
        {
          paymentMethod:       parsed.data.paymentMethod ?? null,
          cardInstallments:    parsed.data.cardInstallments ?? null,
          cardSurchargeAmount: parsed.data.cardSurchargeAmount ?? null,
        },
      );
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else if (err instanceof InvalidPaymentInfoError)     res.status(400).json({ code: 'VALIDATION_ERROR',   message: (err as Error).message });
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
