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
 *
 * `changed_by` (I3, pendientes-2026-08-24.md) — audit_log vive en la BD del
 * tenant y guarda el id de identity de quien hizo el cambio, pero identities
 * vive en la BD de plataforma: no hay JOIN posible entre las dos. Se
 * resuelve acá, aplicación-side, con un solo lote
 * (`platformRepo.findIdentitiesByIds`) sobre los ids únicos de las filas
 * devueltas, y se agrega `changedByName` (nombre completo si lo cargó,
 * si no el email) a cada entrada — sin tocar `changedBy`, que sigue
 * siendo el id crudo por si el caller lo necesita.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { SqlAuditLogRepository, type AuditLogEntry } from '../../repositories/audit-log.repository.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';

// D-16 (17/09/2026, Wave 9) -- antes era un `if` a mano que respondía
// `{ code: 'VALIDATION_ERROR', message: '...' }` SIN el campo `errors`
// que el resto del contrato de validación (`error.middleware.ts`) siempre
// manda -- una quinta forma de 400, ni siquiera basada en Zod. Convertido
// a un schema chico + `.parse()` para que un query param faltante termine
// en el mismo `catch (err) { next(err); }` de acá abajo, como todo el
// resto del repo después de este bloque.
const AuditLogQuerySchema = z.object({
  entity:   z.string().min(1, 'entity es obligatorio'),
  entityId: z.string().min(1, 'entityId es obligatorio'),
});

export function createAuditLogRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  router.get(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { entity, entityId } = AuditLogQuerySchema.parse(req.query);

        const entries = await new SqlAuditLogRepository(req.db!).findByEntity(entity, entityId);

        const uniqueIds = [...new Set(entries.map((e) => e.changedBy))];
        const identities = await platformRepo.findIdentitiesByIds(uniqueIds);
        const nameById = new Map(identities.map((i) => [i.id, i.fullName ?? i.email]));

        const enriched: Array<AuditLogEntry & { changedByName: string }> = entries.map((e) => ({
          ...e,
          changedByName: nameById.get(e.changedBy) ?? 'Usuario desconocido',
        }));

        res.json(enriched);
      } catch (err) { next(err); }
    },
  );

  return router;
}
