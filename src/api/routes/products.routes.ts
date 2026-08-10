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
 *
 * ## Rationale de roles
 * Los productos son configuración de catálogo del negocio:
 * solo OWNER y ADMIN los crean, editan y eliminan (MANAGEMENT).
 * El WAITER necesita decrementar stock al confirmar una orden, de ahí ORDERS
 * en los endpoints de stock.
 *
 * ## Aislamiento multi-tenant
 * buildProductService() instancia SqlProductRepository usando req.db
 * (SqlClient del tenant inyectado por tenantMiddleware).
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';
import { ProductService } from '../../services/product.service.js';
import {
  SqlProductRepository,
  SqlProductVariantRepository,
} from '../../repositories/sql.product.repository.js';
import { authorize } from '../../security/auth.middleware.js';
import { Roles }     from '../../security/roles.js';

function buildProductService(req: Request): ProductService {
  const db = req.db!;
  return new ProductService(
    new SqlProductRepository(db),
    new SqlProductVariantRepository(db),
  );
}

function param(req: Request, key: string): string {
  return req.params[key] as string;
}

export function createProductsRouter(_container: AppContainer): Router {
  const router = Router();

  // ── GET /api/products ───────────────────────────────────────────────────────
  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service  = buildProductService(req);
      const products = await service.listProducts(req.businessId!);
      res.json(products);
    } catch (err) { next(err); }
  });

  // ── POST /api/products ──────────────────────────────────────────────────────
  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      const product = await service.createProduct({
        ...req.body,
        businessId: req.businessId!,
      });
      res.status(201).json(product);
    } catch (err) { next(err); }
  });

  // ── GET /api/products/:id ────────────────────────────────────────────────────
  router.get('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      const product = await service.getProduct(param(req, 'id'));
      if (!product) {
        res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado.' });
        return;
      }
      res.json(product);
    } catch (err) { next(err); }
  });

  // ── PUT /api/products/:id ────────────────────────────────────────────────────
  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      const product = await service.updateProduct(param(req, 'id'), req.body);
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
      const service  = buildProductService(req);
      const variants = await service.listVariants(param(req, 'id'));
      res.json(variants);
    } catch (err) { next(err); }
  });

  // ── POST /api/products/:id/variants ──────────────────────────────────────────
  router.post('/:id/variants', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      const variant = await service.createVariant(param(req, 'id'), req.body);
      res.status(201).json(variant);
    } catch (err) { next(err); }
  });

  // ── PUT /api/products/:id/variants/:variantId ───────────────────────────────
  router.put('/:id/variants/:variantId', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildProductService(req);
      const variant = await service.updateVariant(param(req, 'variantId'), req.body);
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
      const service = buildProductService(req);
      await service.checkStock(param(req, 'id'), undefined, quantity);
      await service.decrementStock(req.db!, param(req, 'id'), undefined, quantity);
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
      const service = buildProductService(req);
      await service.checkStock(param(req, 'id'), param(req, 'variantId'), quantity);
      await service.decrementStock(req.db!, param(req, 'id'), param(req, 'variantId'), quantity);
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
