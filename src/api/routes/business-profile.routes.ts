/**
 * @file business-profile.routes.ts
 * @description Identidad del negocio ("Mi Negocio") — punto 5/E5,
 * pendientes-2026-08-15.md. Nombre + contacto (remitente del mail de
 * reserva confirmada) más, desde el 17/08/2026 (auditoría de hardcodes,
 * pendientes-2026-08-17.md sección F3), `currency`/`timezone` — antes
 * eran constantes fijas en código/SQL, ahora config real por negocio
 * (A2.9). Ver domain/business-profile.entities.ts.
 *
 * GET /api/business-profile — Roles.MANAGEMENT
 * PUT /api/business-profile — Roles.MANAGEMENT, con un candado extra (D3,
 * pendientes-2026-08-19.md): una vez que el CUIT ya está cargado, tocar
 * cualquier campo del perfil fiscal (razón social/CUIT/domicilio/etc.)
 * exige además Roles.OWNER_ONLY — ver domain/business-profile.service.ts
 * para la regla completa y por qué. Todo `update()` queda auditado en
 * `audit_log` (R8), no solo los campos fiscales.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { BusinessProfileService } from '../../domain/business-profile.service.js';
import { UpdateBusinessProfileSchema } from '../schemas/request.schemas.js';
import { buildTenantTransactionManager } from '../../db/tenant-context.js';

export function createBusinessProfileRouter(): Router {
  const router = Router();

  function buildService(req: Request): BusinessProfileService {
    return new BusinessProfileService(
      new SqlBusinessProfileRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
      buildTenantTransactionManager(req),
    );
  }

  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.json(await buildService(req).get());
    } catch (err) { next(err); }
  });

  router.put('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = UpdateBusinessProfileSchema.parse(req.body);
      const isOwner = (req.user?.permissionGroups ?? []).includes(Roles.OWNER_ONLY);
      const updated = await buildService(req).update(body, req.user!.id, isOwner);
      res.json(updated);
    } catch (err) { next(err); }
  });

  return router;
}
