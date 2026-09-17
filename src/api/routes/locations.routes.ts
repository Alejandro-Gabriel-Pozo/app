/**
 * @file locations.routes.ts
 * @description CRUD mínimo de locations (sucursales).
 *
 * GET  /api/locations  — STAFF
 * POST /api/locations  — MANAGEMENT
 *
 * Alcance deliberadamente chico: esto existe para que la entidad no quede
 * como scaffolding muerto (alguien tiene que poder crear una segunda
 * location si el negocio abre una sucursal), no para resolver selección de
 * sucursal en el resto de la app — eso es trabajo aparte, todavía sin
 * ningún router/UI que lo use.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { SqlLocationRepository } from '../../platform/location.repository.js';

const CreateLocationSchema = z.object({
  name: z.string().min(1, 'name es obligatorio').max(120),
});

export function createLocationsRouter(): Router {
  const router = Router();

  router.get(
    '/',
    authorize(Roles.STAFF),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const locations = await new SqlLocationRepository(req.db!).findAll();
        res.json(locations);
      } catch (err) { next(err); }
    },
  );

  router.post(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateLocationSchema.parse(req.body);
        const location = await new SqlLocationRepository(req.db!).create({
          id: randomUUID(),
          name: body.name,
        });
        res.status(201).json(location);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
