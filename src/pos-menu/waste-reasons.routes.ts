/**
 * @file waste-reasons.routes.ts
 * @description Rutas REST para el catálogo de motivos de merma.
 * Fase 2 del carve-out de inventario (17/08/2026,
 * docs/diseno-inventario-carve-out.md).
 *
 * GET    /api/waste-reasons        — MANAGEMENT
 * GET    /api/waste-reasons/:id    — MANAGEMENT
 * POST   /api/waste-reasons        — MANAGEMENT
 * PUT    /api/waste-reasons/:id    — MANAGEMENT
 * DELETE /api/waste-reasons/:id    — MANAGEMENT
 *
 * Config de catálogo del negocio, mismo criterio de roles que
 * categories.routes.ts/products.routes.ts — no ORDERS: quien registra una
 * merma puntual (POST /api/products/stock/waste) no necesariamente puede
 * administrar el catálogo de motivos.
 *
 * ## Aislamiento multi-tenant
 * buildService() instancia SqlWasteReasonRepository usando req.db (SqlClient
 * del tenant inyectado por tenantMiddleware). findAll()/create() reciben
 * req.businessId! explícito (la tabla tiene business_id — Fase 2, a
 * diferencia de resource_categories que no lo necesita porque predata esa
 * convención, ver comentario en schema.sql BLOQUE 17).
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { WasteReasonService } from './waste-reason.service.js';
import { SqlWasteReasonRepository } from '../repositories/sql.waste-reason.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import { CreateWasteReasonSchema, UpdateWasteReasonSchema } from '../api/schemas/waste.schemas.js';
import type { AppContainer } from '../container.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';

export function createWasteReasonsRouter(_container: AppContainer): Router {
  const router = Router();

  function buildService(req: Request): WasteReasonService {
    return new WasteReasonService(
      new SqlWasteReasonRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
      buildTenantTransactionManager(req),
    );
  }

  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      const reasons = await service.listReasons(req.businessId!);
      res.json(reasons);
    } catch (err) { next(err); }
  });

  router.get('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      const reason  = await service.getReasonById(String(req.params['id']));
      res.json(reason);
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body    = CreateWasteReasonSchema.parse(req.body);
      const service = buildService(req);
      const reason  = await service.createReason(req.businessId!, body.name);
      res.status(201).json(reason);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body    = UpdateWasteReasonSchema.parse(req.body);
      const service = buildService(req);
      const reason  = await service.updateReason(
        String(req.params['id']),
        {
          ...(body.name   !== undefined && { name:   body.name }),
          ...(body.active !== undefined && { active: body.active }),
        },
        req.user!.id,
      );
      res.json(reason);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      await service.deactivateReason(String(req.params['id']));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
