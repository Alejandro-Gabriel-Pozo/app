/**
 * @file service-items.routes.ts
 * @description Rutas REST para el catálogo de service_items. Bloque B de
 * `docs/diseno-factura-borrador-2026-08-31.md` §29.7 (schema en Bloque A,
 * `ffd9ed1`, v56) — SOLO repositorio + rutas CRUD acá; el wiring de precio/
 * descripción en `OrderPricingService`/`InvoiceService` y `ORDER_ITEM_TYPES`
 * en `request.schemas.ts` quedan para los Bloques C/D, con su propio gate.
 *
 * GET    /api/service-items        — ORDERS (§29.7.6: personal armando una
 *                                     orden necesita listar el catálogo para
 *                                     agregar un ítem SERVICE, mismo nivel
 *                                     que products.routes.ts en /stock/decrement)
 * GET    /api/service-items/:id    — ORDERS
 * POST   /api/service-items        — MANAGEMENT (alta de catálogo, mismo nivel que POST /api/products)
 * PUT    /api/service-items/:id    — MANAGEMENT
 * DELETE /api/service-items/:id    — MANAGEMENT (soft-delete: active = FALSE, nunca deleted_at -- ver service-item.entities.ts)
 *
 * ## Aislamiento multi-tenant
 * buildService() instancia SqlServiceItemRepository usando req.db (SqlClient
 * del tenant inyectado por tenantMiddleware). listItems()/createItem()
 * reciben req.businessId! explícito (A2.8 -- la tabla tiene business_id
 * directo, mismo patrón que products, no el de bookable_services).
 *
 * ## Montaje
 * src/pos-menu/ monta todo bajo requireModule(POS_RESTAURANTE) en app.ts
 * (docs/rbac-matriz-endpoints.md, header de la sección `src/pos-menu/`) —
 * mismo gate que products/waste-reasons/consumption-destinations/orders,
 * este archivo sigue esa convención de módulo, no decide una nueva.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { ServiceItemService } from './service-item.service.js';
import { SqlServiceItemRepository } from './sql.service-item.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import { CreateServiceItemSchema, UpdateServiceItemSchema } from '../api/schemas/service-item.schemas.js';
import { ZodError } from 'zod';
import type { AppContainer } from '../container.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';
import { compact } from '../api/utils/compact.js';
import type { CreateServiceItemInput } from './service-item.entities.js';

export function createServiceItemsRouter(_container: AppContainer): Router {
  const router = Router();

  function buildService(req: Request): ServiceItemService {
    return new ServiceItemService(
      new SqlServiceItemRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
      buildTenantTransactionManager(req),
    );
  }

  router.get('/', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      const items   = await service.listItems(req.businessId!);
      res.json(items);
    } catch (err) { next(err); }
  });

  router.get('/:id', authorize(Roles.ORDERS), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      const item    = await service.getItemById(String(req.params['id']));
      res.json(item);
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body    = CreateServiceItemSchema.parse(req.body);
      const service = buildService(req);
      const item    = await service.createItem(compact({
        businessId:  req.businessId!,
        categoryId:  body.categoryId,
        name:        body.name,
        description: body.description,
        price:       body.price,
      }) as CreateServiceItemInput);
      res.status(201).json(item);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body    = UpdateServiceItemSchema.parse(req.body);
      const service = buildService(req);
      const item    = await service.updateItem(
        String(req.params['id']),
        {
          ...(body.categoryId  !== undefined && { categoryId:  body.categoryId }),
          ...(body.name        !== undefined && { name:        body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.price       !== undefined && { price:       body.price }),
          ...(body.active      !== undefined && { active:      body.active }),
        },
        req.user!.id,
      );
      res.json(item);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      await service.deactivateItem(String(req.params['id']));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
