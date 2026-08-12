/**
 * @file business-hours.routes.ts
 * @description Horario de atención por defecto del negocio ("Mi Negocio").
 *
 * Un recurso puntual puede tener horario propio (ver /:id/hours en
 * resources.routes.ts) que lo reemplaza para ese recurso — esto acá es
 * solo el default cuando el recurso no tiene uno propio cargado. Ver
 * docs/conocimiento-del-negocio.md para el caso real que motivó el diseño.
 *
 * GET    /api/business-hours       — Roles.BOOKING
 * POST   /api/business-hours       — Roles.MANAGEMENT
 * DELETE /api/business-hours/:id   — Roles.MANAGEMENT
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { SqlOperatingHoursRepository } from '../../repositories/sql.operating-hours.repository.js';
import { CreateOperatingWindowSchema } from '../schemas/request.schemas.js';
import type { AppContainer } from '../../container.js';

export function createBusinessHoursRouter(_container: AppContainer): Router {
  const router = Router();

  router.get('/', authorize(Roles.BOOKING), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const repo = new SqlOperatingHoursRepository(req.db!);
      res.json(await repo.getAllBusinessWindows());
    } catch (err) { next(err); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = CreateOperatingWindowSchema.parse(req.body);
      const repo = new SqlOperatingHoursRepository(req.db!);
      const window = await repo.createBusinessWindow({ id: randomUUID(), ...body });
      res.status(201).json(window);
    } catch (err) { next(err); }
  });

  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const repo = new SqlOperatingHoursRepository(req.db!);
      await repo.deleteBusinessWindow(String(req.params['id']));
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}
