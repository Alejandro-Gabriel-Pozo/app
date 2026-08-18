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
 * PUT /api/business-profile — Roles.MANAGEMENT
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { UpdateBusinessProfileSchema } from '../schemas/request.schemas.js';

export function createBusinessProfileRouter(): Router {
  const router = Router();

  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const repo = new SqlBusinessProfileRepository(req.db!);
      res.json(await repo.get());
    } catch (err) { next(err); }
  });

  router.put('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = UpdateBusinessProfileSchema.parse(req.body);
      const repo = new SqlBusinessProfileRepository(req.db!);
      res.json(await repo.update(body));
    } catch (err) { next(err); }
  });

  return router;
}
