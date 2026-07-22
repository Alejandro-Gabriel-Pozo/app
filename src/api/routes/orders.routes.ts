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
 * ## exactOptionalPropertyTypes
 * compact() se usa solo para los filtros OPCIONALES.
 * businessId es obligatorio y se pasa directamente a listOrders(),
 * evitando la clave duplicada que causa TS2783.
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
import type { OrderStatus } from '../../domain/order.entities.js';

function buildOrderService(req: Request): OrderService {
  return new OrderService(new SqlOrderRepository(req.db!));
}

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

export function createOrdersRouter(_container: AppContainer): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // GET /api/orders
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildOrderService(req);
      const { customerId, status, from, to, limit, offset } = req.query as Record<string, string>;

      // compact() solo recibe los filtros OPCIONALES para no duplicar businessId
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
      const service = buildOrderService(req);
      const order = await service.createOrder({
        ...req.body,
        businessId: req.businessId!,
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
      const service = buildOrderService(req);
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
      const order = await buildOrderService(req).confirmOrder(param(req, 'id'));
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
      const order = await buildOrderService(req).completeOrder(param(req, 'id'));
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
      const order = await buildOrderService(req).cancelOrder(param(req, 'id'));
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
      const order = await buildOrderService(req).updateNotes(param(req, 'id'), notes ?? null);
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
      const item = await buildOrderService(req).addItem(param(req, 'id'), req.body);
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
      await buildOrderService(req).removeItem(param(req, 'id'), param(req, 'itemId'));
      res.status(204).send();
    } catch (err) {
      if (err instanceof OrderNotFoundError)        res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof OrderNotEditableError) res.status(409).json({ code: 'ORDER_NOT_EDITABLE', message: (err as Error).message });
      else next(err);
    }
  });

  return router;
}
