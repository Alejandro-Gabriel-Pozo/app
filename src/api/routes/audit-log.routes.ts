/**
 * @file audit-log.routes.ts
 * @description Lectura del audit log (docs/criterios-datos.md R8).
 *
 * GET /api/audit-log?entity=X&entityId=Y — MANAGEMENT
 *
 * Solo lectura — la escritura pasa siempre por los servicios que llaman a
 * AuditLogRepository.record() (CategoryService.updateCategory,
 * ProductService.updateProduct/updateVariant hoy), nunca por un endpoint
 * que reciba filas de auditoría desde el cliente.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';

export function createAuditLogRouter(): Router {
  const router = Router();

  router.get(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const entity   = String(req.query['entity']   ?? '');
        const entityId = String(req.query['entityId'] ?? '');

        if (!entity || !entityId) {
          res.status(400).json({
            code: 'VALIDATION_ERROR',
            message: 'entity y entityId son obligatorios como query params.',
          });
          return;
        }

        const entries = await new SqlAuditLogRepository(req.db!).findByEntity(entity, entityId);
        res.json(entries);
      } catch (err) { next(err); }
    },
  );

  return router;
}
