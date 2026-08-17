/**
 * @file products.routes.ts
 * @description Rutas REST para productos y variantes.
 *
 * GET    /api/products                                   — MANAGEMENT
 * POST   /api/products                                   — MANAGEMENT
 * GET    /api/products/:id                               — MANAGEMENT
 * PUT    /api/products/:id                               — MANAGEMENT
 * DELETE /api/products/:id                               — MANAGEMENT
 *
 * GET    /api/products/:id/variants                      — MANAGEMENT
 * POST   /api/products/:id/variants                      — MANAGEMENT
 * PUT    /api/products/:id/variants/:variantId            — MANAGEMENT
 * DELETE /api/products/:id/variants/:variantId            — MANAGEMENT
 *
 * POST   /api/products/:id/stock/decrement               — ORDERS (OWNER, ADMIN, WAITER)
 * POST   /api/products/:id/variants/:variantId/stock/decrement — ORDERS
 * POST   /api/products/stock/transfer                     — MANAGEMENT
 *
 * ## Rationale de roles
 * Los productos son configuración de catálogo del negocio:
 * solo OWNER y ADMIN los crean, editan y eliminan (MANAGEMENT).
 * El WAITER necesita decrementar stock al confirmar una orden, de ahí ORDERS
 * en los endpoints de stock. La transferencia entre ubicaciones queda en
 * MANAGEMENT — sin flujo de aprobación propio: cada negocio decide quién
 * puede transferir asignando ese rol, no es una decisión técnica nuestra
 * (16/08/2026, ver memoria de la sesión sobre decisiones técnicas vs.
 * organizacionales).
 *
 * ## Aislamiento multi-tenant
 * buildProductService() instancia SqlProductRepository usando req.db
 * (SqlClient del tenant inyectado por tenantMiddleware).
 *
 * ## Fase 1 del carve-out de inventario (16/08/2026)
 * `stockQuantity`/`reservedQuantity` ya no son campos de Product/
 * ProductVariant — viven en InventoryLevel, por ubicación. Todo endpoint
 * de acá abajo resuelve una ubicación (query param `locationId`, o la
 * primera activa del tenant si no se especifica — mismo criterio que
 * reservas/resources.routes.ts) y enriquece la respuesta con esos campos
 * en el JSON para no romper el contrato que ya consume el frontend, aunque
 * ya no sean parte del dominio Product/ProductVariant.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import type { AppContainer } from '../container.js';
import { ProductService } from './product.service.js';
import {
  SqlProductRepository,
  SqlProductVariantRepository,
} from './sql.product.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import { SqlInventoryLevelRepository } from '../repositories/sql.inventory-level.repository.js';
import { SqlStockMovementRepository } from '../repositories/sql.stock-movement.repository.js';
import { resolveDefaultLocationId } from '../platform/location.repository.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';
import { authorize } from '../security/auth.middleware.js';
import { Roles }     from '../security/roles.js';
import { randomUUID } from 'crypto';
import { z, ZodError } from 'zod';
import type { Product, ProductVariant, CreateProductInput, CreateProductVariantInput } from './product.entities.js';
import type { InventoryLevel } from '../repositories/inventory-level.repository.js';
import { compact } from '../api/utils/compact.js';

function buildProductService(req: Request): ProductService {
  const db = req.db!;
  return new ProductService(
    new SqlProductRepository(db),
    new SqlProductVariantRepository(db),
    new SqlAuditLogRepository(db),
    new SqlInventoryLevelRepository(db),
  );
}

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

/** locationId explícito por query string, o la ubicación por defecto del tenant. */
async function resolveLocation(req: Request): Promise<string> {
  const explicit = (req.query['locationId'] as string | undefined) ?? undefined;
  return resolveDefaultLocationId(req.db!, explicit);
}

function levelFor(levels: InventoryLevel[], productId: string | null, variantId: string | null): InventoryLevel | undefined {
  return levels.find((l) =>
    variantId ? l.productVariantId === variantId : l.productId === productId,
  );
}

function withStock(product: Product, level: InventoryLevel | undefined) {
  return {
    ...product,
    stockQuantity:    level?.stockQuantity ?? 0,
    reservedQuantity: level?.reservedQuantity ?? 0,
    stockMinAlert:    level?.stockMinAlert ?? 0,
  };
}

function variantWithStock(variant: ProductVariant, level: InventoryLevel | undefined) {
  return {
    ...variant,
    stockQuantity:    level?.stockQuantity ?? 0,
    reservedQuantity: level?.reservedQuantity ?? 0,
    stockMinAlert:    level?.stockMinAlert ?? 0,
  };
}

export function createProductsRouter(_container: AppContainer): Router {
  const router = Router();

  // ── GET /api/products ───────────────────────────────────────────────────────
  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service    = buildProductService(req);
      const locationId = await resolveLocation(req);
      const products   = await service.listProducts(req.businessId!);
      const levels      = await new SqlInventoryLevelRepository(req.db!).getAllByLocation(req.businessId!, locationId);
      res.json(products.map((p) => withStock(p, levelFor(levels, p.id, null))));
    } catch (err) { next(err); }
  });

  // ── POST /api/products ──────────────────────────────────────────────────────
  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service    = buildProductService(req);
      const locationId = await resolveLocation(req);
      const { stockQuantity, stockMinAlert, ...body } = req.body;
      const product = await service.createProduct(
        compact({
          ...body,
          businessId: req.businessId!,
          initialStockQuantity: stockQuantity as number | undefined,
          initialStockMinAlert: stockMinAlert as number | undefined,
        }) as CreateProductInput,
        req.db!,
        locationId,
      );
      const level = await new SqlInventoryLevelRepository(req.db!).get({
        productId: product.hasVariants ? null : product.id,
        productVariantId: null,
        locationId,
      });
      res.status(201).json(withStock(product, product.hasVariants ? undefined : level));
    } catch (err) { next(err); }
  });

  // ── GET /api/products/:id ────────────────────────────────────────────────────
  router.get('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service    = buildProductService(req);
      const locationId = await resolveLocation(req);
      const product = await service.getProduct(param(req, 'id'));
      if (!product) {
        res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado.' });
        return;
      }
      const level = await new SqlInventoryLevelRepository(req.db!).get({
        productId: product.hasVariants ? null : product.id,
        productVariantId: null,
        locationId,
      });
      res.json(withStock(product, product.hasVariants ? undefined : level));
    } catch (err) { next(err); }
  });

  // ── PUT /api/products/:id ────────────────────────────────────────────────────
  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      const product = await service.updateProduct(param(req, 'id'), req.body, req.user!.id);
      if (!product) {
        res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado.' });
        return;
      }
      res.json(product);
    } catch (err) { next(err); }
  });

  // ── DELETE /api/products/:id ──────────────────────────────────────────────────
  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      await service.deleteProduct(param(req, 'id'));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── GET /api/products/:id/variants ───────────────────────────────────────────
  router.get('/:id/variants', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service    = buildProductService(req);
      const locationId = await resolveLocation(req);
      const variants   = await service.listVariants(param(req, 'id'));
      const levels     = await new SqlInventoryLevelRepository(req.db!).getAllByLocation(req.businessId!, locationId);
      res.json(variants.map((v) => variantWithStock(v, levelFor(levels, null, v.id))));
    } catch (err) { next(err); }
  });

  // ── POST /api/products/:id/variants ──────────────────────────────────────────
  router.post('/:id/variants', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service    = buildProductService(req);
      const locationId = await resolveLocation(req);
      const { stockQuantity, stockMinAlert, ...body } = req.body;
      const variant = await service.createVariant(
        param(req, 'id'),
        compact({ ...body, initialStockQuantity: stockQuantity as number | undefined, initialStockMinAlert: stockMinAlert as number | undefined }) as Omit<CreateProductVariantInput, 'productId'>,
        req.db!,
        locationId,
      );
      const level = await new SqlInventoryLevelRepository(req.db!).get({ productId: null, productVariantId: variant.id, locationId });
      res.status(201).json(variantWithStock(variant, level));
    } catch (err) { next(err); }
  });

  // ── PUT /api/products/:id/variants/:variantId ───────────────────────────────
  router.put('/:id/variants/:variantId', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      const variant = await service.updateVariant(param(req, 'variantId'), req.body, req.user!.id);
      if (!variant) {
        res.status(404).json({ code: 'VARIANT_NOT_FOUND', message: 'Variante no encontrada.' });
        return;
      }
      res.json(variant);
    } catch (err) { next(err); }
  });

  // ── DELETE /api/products/:id/variants/:variantId ───────────────────────────
  router.delete('/:id/variants/:variantId', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      await service.deleteVariant(param(req, 'variantId'));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── POST /api/products/:id/stock/decrement ─────────────────────────────────
  // ORDERS = OWNER, ADMIN, WAITER — el mozo decrementa stock al confirmar
  router.post('/:id/stock/decrement', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { quantity } = req.body as { quantity?: number };
      if (!quantity || quantity < 1) {
        res.status(400).json({ code: 'INVALID_QUANTITY', message: 'quantity debe ser >= 1.' });
        return;
      }
      const service    = buildProductService(req);
      const locationId = await resolveLocation(req);
      await service.checkStock(param(req, 'id'), undefined, locationId, quantity);
      await service.decrementStock(req.db!, param(req, 'id'), undefined, locationId, quantity);
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── POST /api/products/:id/variants/:variantId/stock/decrement ──────────────
  router.post('/:id/variants/:variantId/stock/decrement', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { quantity } = req.body as { quantity?: number };
      if (!quantity || quantity < 1) {
        res.status(400).json({ code: 'INVALID_QUANTITY', message: 'quantity debe ser >= 1.' });
        return;
      }
      const service    = buildProductService(req);
      const locationId = await resolveLocation(req);
      await service.checkStock(param(req, 'id'), param(req, 'variantId'), locationId, quantity);
      await service.decrementStock(req.db!, param(req, 'id'), param(req, 'variantId'), locationId, quantity);
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── POST /api/products/stock/transfer ───────────────────────────────────────
  // Fase 1 del carve-out de inventario (16/08/2026) — mueve stock disponible
  // (no reservado) de una ubicación a otra del mismo tenant, como una sola
  // operación atómica (manual-inventario.md sección 8). `movementId`
  // opcional: si el caller lo repite en un reintento, la transferencia no se
  // aplica dos veces (mismo mecanismo insert-then-act que el resto de
  // stock_movements — A8.5).
  const TransferStockSchema = z.object({
    productId: z.string().min(1).nullable().optional(),
    productVariantId: z.string().min(1).nullable().optional(),
    fromLocationId: z.string().min(1),
    toLocationId: z.string().min(1),
    quantity: z.number().int().positive(),
    movementId: z.string().min(1).optional(),
  }).refine((b) => Boolean(b.productId) !== Boolean(b.productVariantId), {
    message: 'Especificá productId O productVariantId, nunca los dos ni ninguno.',
  });

  router.post('/stock/transfer', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = TransferStockSchema.parse(req.body);
      if (body.fromLocationId === body.toLocationId) {
        res.status(400).json({ code: 'SAME_LOCATION', message: 'fromLocationId y toLocationId no pueden ser la misma ubicación.' });
        return;
      }

      const stockMovementRepo   = new SqlStockMovementRepository();
      const inventoryLevelRepo  = new SqlInventoryLevelRepository(req.db!);
      const transactionManager  = buildTenantTransactionManager(req);
      const movementId          = body.movementId ?? randomUUID();

      await transactionManager.run(async (client) => {
        const inserted = await stockMovementRepo.createWithClient(client, movementId, {
          businessId:       req.businessId!,
          productId:        body.productId ?? null,
          productVariantId: body.productVariantId ?? null,
          movementType:     'TRANSFER',
          quantity:         body.quantity,
          orderItemId:      null,
          createdBy:        req.user!.id,
          notes:            null,
          locationId:       null,
          fromLocationId:   body.fromLocationId,
          toLocationId:     body.toLocationId,
        });

        if (!inserted) return; // reintento con el mismo movementId -- ya aplicada, no-op

        await inventoryLevelRepo.transferStock(
          client, req.businessId!, body.productId ?? null, body.productVariantId ?? null,
          body.fromLocationId, body.toLocationId, body.quantity,
        );
      });

      res.status(201).json({ movementId });
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors });
        return;
      }
      next(err);
    }
  });

  return router;
}
