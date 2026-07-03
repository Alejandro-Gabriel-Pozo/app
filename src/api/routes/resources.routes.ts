/**
 * @file resources.routes.ts
 * @description Rutas de recursos reservables.
 *
 * ## Cambios
 * - Se reemplaza `/type/:type` por `/category/:categoryId`.
 *   El enum `ResourceType` ya no existe — el filtro es por FK a `resource_categories`.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';
import { toResourceDto } from '../mappers/reservation.mapper.js';
import { AvailabilityQuerySchema } from '../schemas/request.schemas.js';
import { ResourceNotFoundError } from '../../domain/errors.js';
import { routeParam } from '../utils/params.js';

export function createResourcesRouter(container: AppContainer): Router {
  const router = Router();

  /** Listar todos los recursos activos */
  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const resources = await container.resourceRepository.getAll();
      res.json(resources.map(toResourceDto));
    } catch (err) {
      next(err);
    }
  });

  /** Filtrar recursos por categoría */
  router.get(
    '/category/:categoryId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const categoryId = routeParam(req.params.categoryId);
        const resources = await container.resourceRepository.getByCategory(categoryId);
        res.json(resources.map(toResourceDto));
      } catch (err) {
        next(err);
      }
    },
  );

  /** Verificar disponibilidad de un recurso en un rango de tiempo */
  router.get(
    '/:id/availability',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resourceId = routeParam(req.params.id);
        const query = AvailabilityQuerySchema.parse(req.query);
        const available = await container.reservationService.checkAvailability(
          resourceId,
          new Date(query.startTime),
          new Date(query.endTime),
        );
        res.json({
          resourceId,
          startTime: query.startTime,
          endTime:   query.endTime,
          available,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  /** Obtener un recurso por ID */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resourceId = routeParam(req.params.id);
      const resource = await container.resourceRepository.getById(resourceId);
      if (!resource) {
        throw new ResourceNotFoundError(resourceId);
      }
      res.json(toResourceDto(resource));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
