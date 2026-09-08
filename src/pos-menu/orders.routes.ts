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
  OrderStateUnknownError,
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
import { OrderPricingService }           from './order-pricing.service.js';
import { SqlCustomerRateRepository }     from '../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlFinancialTransactionRepository } from '../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository }          from '../facturacion/sql.invoice.repository.js';
import { buildInvoiceService }           from '../facturacion/invoices.routes.js';
import {
  CancelOrderWithCreditNoteService,
} from '../facturacion/cancel-order-with-credit-note.service.js';
import { OrderCancelForCreditNote }      from './order-cancel-for-credit-note.js';
import { authorizeCreditNoteCancellation } from '../facturacion/cancel-with-credit-note.js';
import {
  DomainError,
  CreditNoteCancellationPendingError,
  CreditNoteCancellationRejectedError,
  CreditNoteMultiInvoiceError,
  CreditNoteIssuedOrderNotCancellableError,
  AfipRequestRejectedError,
  AfipNotConfiguredError,
} from '../domain/errors.js';
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
  CancelWithCreditNoteSchema,
  GetOrdersQuerySchema,
  type CreateOrderItemBody,
} from '../api/schemas/request.schemas.js';
import { ZodError } from 'zod';

function buildOrderService(req: Request, _container: AppContainer): OrderService {
  const productService = new ProductService(
    new SqlProductRepository(req.db!),
    new SqlProductVariantRepository(req.db!),
    new SqlAuditLogRepository(req.db!),
    new SqlInventoryLevelRepository(req.db!),
    buildTenantTransactionManager(req),
  );
  return new OrderService(
    new SqlOrderRepository(req.db!),
    buildTenantTransactionManager(req),
    new SqlDomainEventRepository(req.db!),
    productService,
    new RecipeService(
      new SqlRecipeItemRepository(req.db!),
      new SqlProductRepository(req.db!),
      new SqlProductVariantRepository(req.db!),
    ),
    // D9-Parte 2 -- resuelve unitPrice server-side para PRODUCT/PRODUCT_VARIANT.
    new OrderPricingService(productService, new SqlCustomerRateRepository(req.db!)),
    // ORDER-10 (05/09/2026, architecture-governor, bloque 1) -- guard
    // fail-closed de cancelOrder() contra una factura ya vinculada.
    new SqlFinancialTransactionRepository(req.db!),
    new SqlInvoiceRepository(req.db!),
    // Bug #4 (27/08/2026) -- audita las transiciones de estado de la orden.
    // Mismo pool de tenant (req.db!) que el resto, así comparte la transacción.
    new SqlAuditLogRepository(req.db!),
  );
}

/**
 * Composition root del orquestador del escape "cancelar con Nota de Crédito"
 * (ADR común cancelar-con-NC, sub-bloque 4). Reusa `buildInvoiceService()` de
 * `invoices.routes.ts` para el `InvoiceService` y cablea la impl pos-menu del
 * `OrderCancelPort`. Todo desde `req.db!` (mismo pool de tenant → misma
 * transacción). Ver `DEFENSIVE_DEVELOPING.md` §3: `req.db` en todos lados,
 * un solo `buildTenantTransactionManager(req)`.
 */
function buildCancelOrderWithCreditNoteService(req: Request): CancelOrderWithCreditNoteService {
  const db = req.db!;
  return new CancelOrderWithCreditNoteService(
    buildInvoiceService(req),
    new SqlFinancialTransactionRepository(db),
    new SqlInvoiceRepository(db),
    new SqlOrderRepository(db),
    new OrderCancelForCreditNote(
      new SqlOrderRepository(db),
      new SqlDomainEventRepository(db),
      new SqlAuditLogRepository(db),
    ),
    buildTenantTransactionManager(req),
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
    productId:        item.productId        ?? null,
    productVariantId: item.productVariantId ?? null,
    reservationId:    item.reservationId    ?? null,
    // D9-Parte 2 -- ausente para PRODUCT/PRODUCT_VARIANT (el schema ya lo
    // prohíbe ahí, el servidor lo resuelve); presente y obligatorio para
    // RESERVATION (sin cambios).
    ...(item.unitPrice !== undefined && { unitPrice: item.unitPrice }),
  };
}

/** D9-Parte 2 -- createOrder()/addItem() ahora resuelven precio (ProductService.resolveTarget()) al armar cada ítem, no solo al confirmar -- mismo mapeo de errores que ya usaba confirmOrder() más abajo. */
function handleItemPricingError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof ProductNotFoundError)      res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: (err as Error).message });
  else if (err instanceof VariantNotFoundError) res.status(404).json({ code: 'VARIANT_NOT_FOUND', message: (err as Error).message });
  else if (err instanceof VariantRequiredError) res.status(400).json({ code: 'VARIANT_REQUIRED',  message: (err as Error).message });
  else next(err);
}

export function createOrdersRouter(container: AppContainer): Router {
  const router = Router();

  // ── GET /api/orders ─────────────────────────────────────────────────────────
  router.get('/', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildOrderService(req, container);
      const { customerId, status, from, to, limit, offset } = GetOrdersQuerySchema.parse(req.query);
      const optionalFilters = compact({
        ...(customerId !== undefined && { customerId }),
        ...(status     !== undefined && { status: status as OrderStatus }),
        ...(from       !== undefined && { from:   new Date(from) }),
        ...(to         !== undefined && { to:     new Date(to) }),
        ...(limit      !== undefined && { limit }),
        ...(offset     !== undefined && { offset }),
      });
      const orders = await service.listOrders({ businessId: req.businessId!, ...optionalFilters });
      res.json(orders);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
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
    } catch (err) { handleItemPricingError(err, res, next); }
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
      const order = await buildOrderService(req, container).confirmOrder(param(req, 'id'), req.user!.id);
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)                res.status(404).json({ code: 'ORDER_NOT_FOUND',       message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError)  res.status(409).json({ code: 'INVALID_TRANSITION',    message: (err as Error).message });
      else if (err instanceof OrderStateUnknownError)       res.status(409).json({ code: 'ORDER_STATE_UNKNOWN',   message: (err as Error).message });
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
      const order = await buildOrderService(req, container).markServed(param(req, 'id'), req.user!.id);
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)          res.status(404).json({ code: 'ORDER_NOT_FOUND',      message: (err as Error).message });
      else if (err instanceof OrderNotServableError)  res.status(409).json({ code: 'ORDER_NOT_SERVABLE',   message: (err as Error).message });
      else if (err instanceof OrderStateUnknownError) res.status(409).json({ code: 'ORDER_STATE_UNKNOWN',  message: (err as Error).message });
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
        req.user!.id,
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
      else if (err instanceof OrderStateUnknownError)      res.status(409).json({ code: 'ORDER_STATE_UNKNOWN', message: (err as Error).message });
      else if (err instanceof InvalidPaymentInfoError)     res.status(400).json({ code: 'VALIDATION_ERROR',   message: (err as Error).message });
      else next(err);
    }
  });

  // ── POST /api/orders/:id/cancel ──────────────────────────────────────────────
  router.post('/:id/cancel', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await buildOrderService(req, container).cancelOrder(param(req, 'id'), req.user!.id);
      res.json(order);
    } catch (err) {
      if (err instanceof OrderNotFoundError)               res.status(404).json({ code: 'ORDER_NOT_FOUND',    message: (err as Error).message });
      else if (err instanceof InvalidOrderTransitionError) res.status(409).json({ code: 'INVALID_TRANSITION', message: (err as Error).message });
      else if (err instanceof OrderStateUnknownError)      res.status(409).json({ code: 'ORDER_STATE_UNKNOWN', message: (err as Error).message });
      else next(err);
    }
  });

  // ── POST /api/orders/:id/cancel-with-credit-note ─────────────────────────────
  // ADR común cancelar-con-NC (sub-bloque 4). Escape administrativo: cancela
  // una orden con Factura B viva EMITIENDO una Nota de Crédito. `authorize`
  // con el grupo dedicado `EMISOR_NOTA_CREDITO` (no `ORDERS`). Primer y único
  // caller de `authorizeCreditNoteCancellation()` (token branded, sub-bloque 2):
  // `confirmedBy` sale del JWT verificado server-side, NUNCA del body (A2.2).
  router.post(
    '/:id/cancel-with-credit-note',
    authorize(Roles.EMISOR_NOTA_CREDITO),
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = CancelWithCreditNoteSchema.safeParse(req.body);
      if (!parsed.success) {
        validationError(res, parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })));
        return;
      }
      const orderId = param(req, 'id');
      try {
        const auth = authorizeCreditNoteCancellation({
          confirmedBy: req.user!.id,
          reason: parsed.data.reason,
          scope: { kind: 'ORDER', orderId },
        });
        const result = await buildCancelOrderWithCreditNoteService(req).cancelOrderWithCreditNote(orderId, auth);
        res.json(result);
      } catch (err) {
        if (err instanceof OrderNotFoundError)                      res.status(404).json({ code: 'ORDER_NOT_FOUND',                 message: err.message });
        else if (err instanceof InvalidOrderTransitionError)        res.status(409).json({ code: 'INVALID_TRANSITION',              message: err.message });
        else if (err instanceof CreditNoteMultiInvoiceError)        res.status(409).json({ code: 'CREDIT_NOTE_MULTI_INVOICE',       message: err.message });
        else if (err instanceof CreditNoteIssuedOrderNotCancellableError) res.status(422).json({ code: 'CREDIT_NOTE_ISSUED_ORDER_NOT_CANCELLABLE', message: err.message });
        else if (err instanceof CreditNoteCancellationPendingError) res.status(422).json({ code: 'CREDIT_NOTE_CANCELLATION_PENDING', message: err.message });
        else if (err instanceof AfipRequestRejectedError)           res.status(409).json({ code: 'AFIP_REQUEST_REJECTED',           message: err.message });
        else if (err instanceof CreditNoteCancellationRejectedError) res.status(409).json({ code: 'CREDIT_NOTE_CANCELLATION_REJECTED', message: err.message });
        else if (err instanceof AfipNotConfiguredError)             res.status(422).json({ code: 'AFIP_NOT_CONFIGURED',             message: err.message });
        else if (err instanceof DomainError)                        res.status(409).json({ code: err.code,                         message: err.message });
        else next(err);
      }
    },
  );

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
      else handleItemPricingError(err, res, next);
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
