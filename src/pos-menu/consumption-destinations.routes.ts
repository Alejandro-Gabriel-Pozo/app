/**
 * @file consumption-destinations.routes.ts
 * @description Rutas REST para el catálogo de destinos de consumo interno.
 * 27/08/2026, pendientes-2026-08-27.md — gemelo exacto de
 * waste-reasons.routes.ts.
 *
 * GET    /api/consumption-destinations        — MANAGEMENT
 * GET    /api/consumption-destinations/:id    — MANAGEMENT
 * POST   /api/consumption-destinations        — MANAGEMENT
 * PUT    /api/consumption-destinations/:id    — MANAGEMENT
 * DELETE /api/consumption-destinations/:id    — MANAGEMENT
 *
 * Config de catálogo del negocio, mismo criterio de roles que
 * waste-reasons.routes.ts — no ORDERS: quien registra un consumo puntual
 * (POST /api/products/stock/consumption) no necesariamente puede
 * administrar el catálogo de destinos.
 *
 * ## Aislamiento multi-tenant
 * buildService() instancia SqlConsumptionDestinationRepository usando
 * req.db (SqlClient del tenant inyectado por tenantMiddleware).
 * findAll()/create() reciben req.businessId! explícito, mismo criterio que
 * WasteReasonRepository.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { ConsumptionDestinationService } from './consumption-destination.service.js';
import { SqlConsumptionDestinationRepository } from '../repositories/sql.consumption-destination.repository.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import { CreateConsumptionDestinationSchema, UpdateConsumptionDestinationSchema } from '../api/schemas/consumption.schemas.js';
import { ZodError } from 'zod';
import type { AppContainer } from '../container.js';
import { buildTenantTransactionManager } from '../db/tenant-context.js';

export function createConsumptionDestinationsRouter(_container: AppContainer): Router {
  const router = Router();

  function buildService(req: Request): ConsumptionDestinationService {
    return new ConsumptionDestinationService(
      new SqlConsumptionDestinationRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
      buildTenantTransactionManager(req),
    );
  }

  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      const destinations = await service.listDestinations(req.businessId!);
      res.json(destinations);
    } catch (err) { next(err); }
  });

  router.get('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service     = buildService(req);
      const destination = await service.getDestinationById(String(req.params['id']));
      res.json(destination);
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body        = CreateConsumptionDestinationSchema.parse(req.body);
      const service      = buildService(req);
      const destination = await service.createDestination(req.businessId!, body.name);
      res.status(201).json(destination);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body        = UpdateConsumptionDestinationSchema.parse(req.body);
      const service      = buildService(req);
      const destination = await service.updateDestination(
        String(req.params['id']),
        {
          ...(body.name   !== undefined && { name:   body.name }),
          ...(body.active !== undefined && { active: body.active }),
        },
        req.user!.id,
      );
      res.json(destination);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      next(err);
    }
  });

  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const service = buildService(req);
      await service.deactivateDestination(String(req.params['id']));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
