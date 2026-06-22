import { Router, Request, Response, NextFunction } from 'express';
import { AppContainer } from '../../container.js';
import { toResourceDto } from '../mappers/reservation.mapper.js';
import { AvailabilityQuerySchema } from '../schemas/request.schemas.js';
import { ResourceNotFoundError } from '../../domain/errors.js';
import { ResourceType } from '../../types/enums.js';
import { routeParam } from '../utils/params.js';

export function createResourcesRouter(container: AppContainer): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const resources = await container.resourceRepository.getAll();
      res.json(resources.map(toResourceDto));
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/type/:type',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const type = routeParam(req.params.type) as ResourceType;
        const resources = await container.resourceRepository.getByType(type);
        res.json(resources.map(toResourceDto));
      } catch (err) {
        next(err);
      }
    },
  );

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
          resourceId: routeParam(req.params.id),
          startTime: query.startTime,
          endTime: query.endTime,
          available,
        });
      } catch (err) {
        next(err);
      }
    },
  );

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
