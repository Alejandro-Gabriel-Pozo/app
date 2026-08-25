/**
 * @file rate-catalog.routes.ts
 * @description Catálogo de tarifas reutilizables (D5, pendientes-2026-08-19.md,
 * decisión confirmada con el dueño 22/08/2026) — "Corporativo -10%" como
 * preset, en vez de retipear el % en cada tarifa de cliente. Ver
 * rate-catalog.repository.ts para el porqué `POST /customers/:id/rates`
 * con `rateCatalogId` ES una referencia viva, y rate-catalog.service.ts
 * para el porqué PUT/DELETE quedan auditados.
 *
 * GET    /api/rate-catalog     — Roles.FRONT_DESK (mismo criterio que
 *                                 GET /customers/:id/rates: hace falta
 *                                 verlo para armar una tarifa, no solo
 *                                 gestión)
 * POST   /api/rate-catalog     — Roles.MANAGEMENT
 * PUT    /api/rate-catalog/:id — Roles.MANAGEMENT (name/discountPercentage
 *                                 únicamente — cambiar el % PROPAGA de
 *                                 inmediato a todo cliente ya asignado,
 *                                 ver rate-catalog.repository.ts)
 * DELETE /api/rate-catalog/:id — Roles.MANAGEMENT (soft — desactiva, no
 *                                 borra; tarifas ya creadas la siguen
 *                                 referenciando por trazabilidad)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { authorize } from '../api/middleware/auth.middleware.wrapper.js';
import { Roles } from '../security/roles.js';
import { SqlRateCatalogRepository } from './sql.rate-catalog.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import { RateCatalogService } from './rate-catalog.service.js';
import { SqlResourceRepository } from '../reservas/sql.resource.repository.js';
import { SqlBookableServiceRepository } from '../reservas/sql.bookable-service.repository.js';
import { SqlCategoryRepository } from '../reservas/sql.category.repository.js';
import { CreateRateCatalogEntrySchema, UpdateRateCatalogEntrySchema } from '../api/schemas/request.schemas.js';
import { ResourceNotFoundError, RateCatalogEntryNotFoundError, RateCatalogEntryConflictError, CategoryNotFoundError } from '../domain/errors.js';
import { BookableServiceNotFoundError } from '../reservas/bookable-service.service.js';
import { SqlProductRepository } from '../pos-menu/sql.product.repository.js';
import { ProductNotFoundError } from '../pos-menu/product.service.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';

export function createRateCatalogRouter(): Router {
  const router = Router();

  function buildService(req: Request): RateCatalogService {
    return new RateCatalogService(
      new SqlRateCatalogRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
      buildTenantTransactionManager(req),
    );
  }

  router.get('/', authorize(Roles.FRONT_DESK), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      res.json(await buildService(req).list(businessId));
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      const body = CreateRateCatalogEntrySchema.parse(req.body);

      if (body.resourceId) {
        const resource = await new SqlResourceRepository(req.db!).getById(body.resourceId);
        if (!resource) throw new ResourceNotFoundError(body.resourceId);
      }
      if (body.serviceId) {
        const service = await new SqlBookableServiceRepository(req.db!).findById(body.serviceId);
        if (!service) throw new BookableServiceNotFoundError(body.serviceId);
      }
      if (body.productId) {
        const product = await new SqlProductRepository(req.db!).getById(body.productId);
        if (!product) throw new ProductNotFoundError(body.productId);
      }
      if (body.categoryId) {
        const category = await new SqlCategoryRepository(req.db!).findById(body.categoryId);
        if (!category) throw new CategoryNotFoundError(body.categoryId);
      }

      // D9-Parte 2 (pendientes-2026-08-22.md) — 5 modos de scope posibles;
      // productId/bucket='PRODUCTOS' ya están habilitados.
      const target = body.resourceId  ? { resourceId: body.resourceId }
        : body.serviceId  ? { serviceId: body.serviceId }
        : body.productId  ? { productId: body.productId }
        : body.categoryId ? { categoryId: body.categoryId }
        : { bucket: body.bucket! };
      try {
        const entry = await buildService(req).create({
          id: randomUUID(),
          businessId,
          name: body.name,
          discountPercentage: body.discountPercentage,
          ...target,
        });
        res.status(201).json(entry);
      } catch (dbErr) {
        // uq_rate_catalog_business_name (schema.sql) — mismo criterio que
        // CustomerRateConflictError en customers.routes.ts.
        if ((dbErr as { code?: string }).code === '23505') {
          throw new RateCatalogEntryConflictError(body.name);
        }
        throw dbErr;
      }
    } catch (err) {
      // ProductNotFoundError no es un DomainError -- se captura acá
      // localmente (D9-Parte 2), mismo criterio que customers.routes.ts.
      if (err instanceof ProductNotFoundError) { res.status(404).json({ code: 'PRODUCT_NOT_FOUND', message: (err as Error).message }); return; }
      next(err);
    }
  });

  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      const body = UpdateRateCatalogEntrySchema.parse(req.body);
      const entry = await buildService(req).update(String(req.params['id']), businessId, body, req.user!.id);
      res.json(entry);
    } catch (err) { next(err); }
  });

  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      const deactivated = await buildService(req).deactivate(String(req.params['id']), businessId, req.user!.id);
      if (!deactivated) throw new RateCatalogEntryNotFoundError(String(req.params['id']));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
