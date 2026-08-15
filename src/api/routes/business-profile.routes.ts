/**
 * @file business-profile.routes.ts
 * @description Identidad del negocio ("Mi Negocio") — punto 5/E5,
 * pendientes-2026-08-15.md. Hoy solo nombre + contacto, lo que necesita el
 * remitente del mail de reserva confirmada (A2.9: eso es config por
 * tenant, nunca una constante de la plataforma). Ver domain/
 * business-profile.entities.ts para por qué arranca mínimo.
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
