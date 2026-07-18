/**
 * @file admin.routes.ts
 * @description Rutas de reparación/mantenimiento puntual, ejecutadas por un
 * ADMIN sobre su propio negocio. Pensadas para no depender de acceso a
 * Shell en Render.
 *
 * ⚠️  `POST /repair-tenant-db` es una herramienta de uso único para negocios
 * sembrados directo por SQL (sin pasar por el flujo real de /register).
 * Una vez que ya no la necesites, se puede borrar este archivo y su mount
 * en app.ts sin efectos secundarios.
 */
 
import { Router, Request, Response, NextFunction } from 'express';
import { authorize } from '../middleware/auth.middleware.wrapper.js';
import { PlatformRepository } from '../../platform/platform.repository.js';
import { encryptConnectionString } from '../../platform/supabase.provisioner.js';
import { UserRole } from '../../types/enums.js';
 
export function createAdminRouter(platformRepo: PlatformRepository | null): Router {
  const router = Router();
 
  // POST /api/admin/repair-tenant-db
  // Apunta el negocio del usuario autenticado a la misma DATABASE_URL que ya
  // usa el proceso (la que tiene el schema de recursos/reservas aplicado),
  // cifrándola con DB_ENCRYPTION_KEY — sin exponer ninguno de los dos
  // valores fuera del servidor.
  router.post(
    '/repair-tenant-db',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        if (!platformRepo) {
          res.status(503).json({
            code: 'PLATFORM_UNAVAILABLE',
            message: 'Requiere PLATFORM_DATABASE_URL.',
          });
          return;
        }
 
        const businessId = req.user!.businessId!;
        const databaseUrl = process.env.DATABASE_URL;
        if (!databaseUrl) {
          res.status(500).json({
            code: 'MISSING_DATABASE_URL',
            message: 'DATABASE_URL no está definida en este proceso.',
          });
          return;
        }
 
        const encrypted = await encryptConnectionString(databaseUrl);
        await platformRepo.activateBusiness(businessId, 'manual-demo', encrypted);
 
        res.json({
          message: `Negocio ${businessId} activado y apuntado a DATABASE_URL.`,
        });
      } catch (err) {
        next(err);
      }
    },
  );
 
  return router;
}
