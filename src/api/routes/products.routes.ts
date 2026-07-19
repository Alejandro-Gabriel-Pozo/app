/**
 * @file products.routes.ts
 * @description Rutas REST para productos y variantes.
 *
 * GET    /api/products
 * POST   /api/products
 * GET    /api/products/:id
 * PUT    /api/products/:id
 * DELETE /api/products/:id
 *
 * GET    /api/products/:id/variants
 * POST   /api/products/:id/variants
 * PUT    /api/products/:id/variants/:variantId
 * DELETE /api/products/:id/variants/:variantId
 *
 * POST   /api/products/:id/stock/decrement
 * POST   /api/products/:id/variants/:variantId/stock/decrement
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';

/** Helper: extrae un param de ruta siempre como string. */
function param(req: Request, key: string): string {
  return req.params[key] as string;
}

export function createProductsRouter(container: AppContainer): Router {
  const router  = Router();
  const service = container.productService;

  // -------------------------------------------------------------------------
  // GET /api/products
  // -------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const products = await service.listProducts(req.businessId!);
      res.json(products);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/products
  // -------------------------------------------------------------------------
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await service.createProduct({
        ...req.body,
        businessId: req.businessId!,
      });
      res.status(201).json(product);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/products/:id
  // -------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await service.getProduct(param(req, 'id'));
      if (!product) {
        res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado.' });
        return;
      }
      res.json(product);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/products/:id
  // -------------------------------------------------------------------------
  router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const product = await service.updateProduct(param(req, 'id'), req.body);
      if (!product) {
        res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: 'Producto no encontrado.' });
        return;
      }
      res.json(product);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/products/:id
  // -------------------------------------------------------------------------
  router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await service.deleteProduct(param(req, 'id'));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/products/:id/variants
  // -------------------------------------------------------------------------
  router.get('/:id/variants', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const variants = await service.listVariants(param(req, 'id'));
      res.json(variants);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/products/:id/variants
  // -------------------------------------------------------------------------
  router.post('/:id/variants', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const variant = await service.createVariant(param(req, 'id'), req.body);
      res.status(201).json(variant);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // PUT /api/products/:id/variants/:variantId
  // -------------------------------------------------------------------------
  router.put('/:id/variants/:variantId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const variant = await service.updateVariant(param(req, 'variantId'), req.body);
      if (!variant) {
        res.status(404).json({ code: 'VARIANT_NOT_FOUND', message: 'Variante no encontrada.' });
        return;
      }
      res.json(variant);
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // DELETE /api/products/:id/variants/:variantId
  // -------------------------------------------------------------------------
  router.delete('/:id/variants/:variantId', async (req: Request, res: Response, next: NextFunction) => {
    try {
      await service.deleteVariant(param(req, 'variantId'));
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/products/:id/stock/decrement
  // -------------------------------------------------------------------------
  router.post('/:id/stock/decrement', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { quantity } = req.body as { quantity?: number };
      if (!quantity || quantity < 1) {
        res.status(400).json({ code: 'INVALID_QUANTITY', message: 'quantity debe ser >= 1.' });
        return;
      }
      await service.checkStock(param(req, 'id'), undefined, quantity);
      await service.decrementStock(req.db!, param(req, 'id'), undefined, quantity);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/products/:id/variants/:variantId/stock/decrement
  // -------------------------------------------------------------------------
  router.post('/:id/variants/:variantId/stock/decrement', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { quantity } = req.body as { quantity?: number };
      if (!quantity || quantity < 1) {
        res.status(400).json({ code: 'INVALID_QUANTITY', message: 'quantity debe ser >= 1.' });
        return;
      }
      await service.checkStock(param(req, 'id'), param(req, 'variantId'), quantity);
      await service.decrementStock(req.db!, param(req, 'id'), param(req, 'variantId'), quantity);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
