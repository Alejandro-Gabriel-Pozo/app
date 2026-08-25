/**
 * @file maintenance-windows.routes.ts
 * @description Ventanas de mantenimiento (24/08/2026, reemplaza al flag
 * OUT_OF_SERVICE de housekeeping_tasks como mecanismo de bloqueo de
 * disponibilidad — docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md).
 *
 * ## Permisos por endpoint
 *
 * | Endpoint | Roles | Descripción |
 * |---|---|---|
 * | GET  /maintenance-windows                    | STAFF      | Ventanas todavía relevantes del negocio |
 * | GET  /maintenance-windows/resource/:id       | STAFF      | Todas las ventanas (histórico incluido) de un recurso |
 * | POST /maintenance-windows                    | MANAGEMENT | Crea una ventana — rechaza si hay reserva conflictiva |
 * | POST /maintenance-windows/:id/close          | MANAGEMENT | Cierra la ventana — única forma de liberar el recurso |
 *
 * authenticate() fue removido de cada handler: app.ts lo aplica
 * globalmente sobre /api/* antes de tenantMiddleware.
 */

import { Router } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import type { MaintenanceWindowService } from './maintenance-window.service.js';
import { CreateMaintenanceWindowSchema, CloseMaintenanceWindowSchema } from '../api/schemas/maintenance-window.schemas.js';

export function createMaintenanceWindowsRouter(service: MaintenanceWindowService): Router {
  const router = Router();

  // ── GET /maintenance-windows ─────────────────────────────────────────────
  router.get(
    '/',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const windows = await service.listActive(req.user!.businessId as string);
        res.json(windows.map((w) => w.toJSON()));
      } catch (err) { next(err); }
    },
  );

  // ── GET /maintenance-windows/resource/:resourceId ────────────────────────
  router.get(
    '/resource/:resourceId',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const windows = await service.listByResource(
          String(req.params['resourceId']),
          req.user!.businessId as string,
        );
        res.json(windows.map((w) => w.toJSON()));
      } catch (err) { next(err); }
    },
  );

  // ── POST /maintenance-windows ─────────────────────────────────────────────
  // Solo MANAGEMENT -- mismo criterio que el POST /:id/out-of-service que
  // reemplaza (housekeeping.routes.ts).
  router.post(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body = CreateMaintenanceWindowSchema.parse(req.body);
        const window = await service.createWindow({
          businessId: req.user!.businessId as string,
          resourceId: body.resourceId,
          startDate: body.startDate,
          ...(body.endDate !== undefined && { endDate: body.endDate }),
          ...(body.reason !== undefined && { reason: body.reason }),
          createdBy: req.user!.id,
        });
        res.status(201).json(window.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /maintenance-windows/:id/close ──────────────────────────────────
  router.post(
    '/:id/close',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body = CloseMaintenanceWindowSchema.parse(req.body ?? {});
        const window = await service.closeWindow(
          String(req.params['id']),
          req.user!.businessId as string,
          req.user!.id,
          body.closeDate,
        );
        res.json(window.toJSON());
      } catch (err) { next(err); }
    },
  );

  return router;
}
