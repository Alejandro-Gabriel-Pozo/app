/**
 * @file orders.routes.ts
 * @description Rutas REST para órdenes (carrito unificado reserva + producto).
 *
 * GET    /api/orders                    — listar órdenes del negocio
 * POST   /api/orders                    — crear orden (DRAFT)
 * GET    /api/orders/:id                — detalle de orden
 * POST   /api/orders/:id/confirm        — DRAFT → CONFIRMED
 * POST   /api/orders/:id/complete       — CONFIRMED → COMPLETED
 * POST   /api/orders/:id/cancel         — cancelar orden
 * PATCH  /api/orders/:id/notes          — actualizar notas (solo DRAFT)
 * POST   /api/orders/:id/items          — agregar ítem (solo DRAFT)
 * DELETE /api/orders/:id/items/:itemId  — eliminar ítem (solo DRAFT)
 *
 * ## Multi-tenant
 * buildOrderService(req) instancia SqlOrderRepository usando req.db
 * del tenant activo (inyectado por tenantMiddleware).
 *
 * ## exactOptionalPropertyTypes — CreateOrderInput y CreateOrderItemInput
 * Con exactOptionalPropertyTypes=true:
 *   { notes: undefined }  ← NO assignable a CreateOrderInput.notes?: string|null
 *   { notes: 'texto'  }  ← SÍ assignable
 *   {}                    ← SÍ assignable (clave ausente)
 *
 * Zod infiere campos opcionales como `T | undefined` — si el campo no vino
 * en el body, la clave existe con valor undefined en el objeto parseado.
 * Eso viola exactOptionalPropertyTypes al pasarlo a service.createOrder().
 *
 * Solución:
 *  1. Para CreateOrderInput.notes: spread condicional.
 *  2. Para items[].productId / productVariantId / reservationId: stripItemUndefined()
 *     convierte undefined → null (que sí es válido en el tipo `string | null`).
 *
 * NO hacer:
 *   service.createOrder({ ...parsed.data, businessId })  // notes: undefined → TS2379
 *
 * SÍ hacer:
 *   service.createOrder({
 *     businessId,
 *     customerId: parsed.data.customerId,
 *     items: parsed.data.items.map(stripItemUndefined),
 *     ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
 *   })
 *
 * ## Transacción en createOrder
 * OrderService recibe container.transactionManager para envolver
 * INSERT orders + INSERT order_items en un único BEGIN/COMMIT.
 *
 * ## Validación Zod
 * POST /api/orders             → CreateOrderSchema
 * POST /api/orders/:id/items   → CreateOrderItemSchema
 * Respuesta 400 con code VALIDATION_ERROR consistente con el resto de rutas.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';
import {
  OrderService,
  OrderNotFoundError,
  OrderNotEditableError,
  InvalidOrderTransitionError,
} from '../../services/order.service.js';
import { SqlOrderRepository } from '../../repositories/sql.order.repository.js';
import { compact } from '../utils/compact.js';
import type { OrderStatus, CreateOrderItemInput } from '../../domain/order.entities.js';
import {
  CreateOrderSchema,
  CreateOrderItemSchema,
  type CreateOrderItemBody,
} from '../schemas/request.schemas.js';

function buildOrderService(req: Request, container: AppContainer): OrderService {
  return new OrderService(
    new SqlOrderRepository(req.db!),
    container.transactionManager,
  );
}

function param(req: Request, key: string): string {
  return String(req.params[key]);
}

function validationError(res: Response, errors: { path: string; message: string }[]): void {
  res.status(400).json({ code: 'VALIDATION_ERROR', errors });
}

/**
 * Convierte los campos opcionales FK de un ítem de orden de
 * `string | null | undefined` → `string | null`.
 *
 * Zod parsea los campos `.nullable().optional()` con valor ausente como
 * `undefined`, pero CreateOrderItemInput acepta solo `string | null`.
 * Con exactOptionalPropertyTypes, pasar undefined viola el contrato.
 */
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

  // -------------------------------------------------------------------------
  // GET /api/orders
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
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

      const orders = await service.listOrders({
        businessId: req.businessId!,
        ...optionalFilters,
      });
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/orders
  // -------------------------------------------------------------------------
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateOrderSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      const service = buildOrderService(req, container);
      // Spread condicional para notes: Zod puede parsear notes como undefined
      // si el campo no vino en el body, y undefined no cumple exactOptionalPropertyTypes.
      const order = await service.createOrder({
        businessId: req.businessId!,
        customerId: parsed.data.customerId,
        items:      parsed.data.items.map(stripItemUndefined),
        ...(parsed.data.notes !== undefined && { notes: parsed.data.notes }),
      });
      res.status(201).json(order);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/orders/:id
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildOrderService(req, container);
      const order = await service.getOrder(param(req, 'id'));
      if (!order) {
        res.status(404).json({ code: 'ORDER_NOT_FOUND', message: 'Orden no encontrada.' });
        return;
      }
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/orders/:id/confirm
  // -------------------------------------------------------------------------
  router.post('/:id/confirm', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).confirmOrder(param(req, 'id'));
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/orders/:id/complete
  // -------------------------------------------------------------------------
  router.post('/:id/complete', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).completeOrder(param(req, 'id'));
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/orders/:id/cancel
  // -------------------------------------------------------------------------
  router.post('/:id/cancel', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).cancelOrder(param(req, 'id'));
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PATCH /api/orders/:id/notes
  // -------------------------------------------------------------------------
  router.patch('/:id/notes', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { notes } = req.body as { notes?: string | null };
      const order = await buildOrderService(req, container).updateNotes(param(req, 'id'), notes ?? null);
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)        res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof OrderNotEditableError) res.status(409).json({ code: 'ORDER_NOT_EDITABLE', message: (err as Error).message });
      else next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/orders/:id/items
  // -------------------------------------------------------------------------
  router.post('/:id/items', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = CreateOrderItemSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      // stripItemUndefined convierte undefined → null en FK opcionales
      const item = await buildOrderService(req, container).addItem(
        param(req, 'id'),
        stripItemUndefined(parsed.data),
      );
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof OrderNotFoundError)        res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof OrderNotEditableError) res.status(409).json({ code: 'ORDER_NOT_EDITABLE', message: (err as Error).message });
      else next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/orders/:id/items/:itemId
  // -------------------------------------------------------------------------
  router.delete('/:id/items/:itemId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await buildOrderService(req, container).removeItem(param(req, 'id'), param(req, 'itemId'));
      res.status(204).send();
    } catch (err) {
      if (err instanceof OrderNotFoundError)        res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof OrderNotEditableError) res.status(409).json({ code: 'ORDER_NOT_EDITABLE', message: (err as Error).message });
      else next(err);
    }
  });

  return router;
}
