/**
 * @file products.routes.ts
 * @description Rutas REST para productos y variantes.
 *
 * ## Endpoints
 *
 * ### Productos
 * GET    /api/products                                    — listar todos los productos
 * POST   /api/products                                    — crear producto
 * GET    /api/products/:id                               — obtener producto por ID
 * PUT    /api/products/:id                               — actualizar producto
 * DELETE /api/products/:id                               — eliminar producto
 *
 * ### Variantes (anidadas bajo producto)
 * GET    /api/products/:id/variants                      — listar variantes
 * POST   /api/products/:id/variants                      — crear variante
 * PUT    /api/products/:id/variants/:variantId           — actualizar variante
 * DELETE /api/products/:id/variants/:variantId           — eliminar variante
 *
 * ### Stock
 * POST   /api/products/:id/stock/decrement                        — descontar stock (sin variante)
 * POST   /api/products/:id/variants/:variantId/stock/decrement    — descontar stock variante
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';

export function createProductsRouter(container: AppContainer): Router {
  const router  = Router();
  const service = container.productService;

  // -------------------------------------------------------------------------
  // GET /api/products
  // -------------------------------------------------------------------------
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const products = await service.listProducts();
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
      const product = await service.createProduct(req.body);
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
      const product = await service.getProduct(req.params.id);
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
      const product = await service.updateProduct(req.params.id, req.body);
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
      await service.deleteProduct(req.params.id);
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
      const variants = await service.listVariants(req.params.id);
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
      const variant = await service.createVariant(req.params.id, req.body);
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
      const variant = await service.updateVariant(req.params.variantId, req.body);
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
      await service.deleteVariant(req.params.variantId);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/products/:id/stock/decrement  — producto sin variantes
  // -------------------------------------------------------------------------
  router.post('/:id/stock/decrement', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { quantity } = req.body as { quantity?: number };
      if (!quantity || quantity < 1) {
        res.status(400).json({ code: 'INVALID_QUANTITY', message: 'quantity debe ser >= 1.' });
        return;
      }
      await service.checkStock(req.params.id, undefined, quantity);
      await service.decrementStock(req.db, req.params.id, undefined, quantity);
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
      await service.checkStock(req.params.id, req.params.variantId, quantity);
      await service.decrementStock(req.db, req.params.id, req.params.variantId, quantity);
      res.status(204).send();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
