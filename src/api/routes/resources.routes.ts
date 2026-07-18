/**
 * @file resources.routes.ts
 * @description Rutas de recursos reservables.
 *
 * ## Aislamiento multi-tenant
 * Cada handler instancia SqlResourceRepository(req.db) donde req.db es el
 * SqlClient inyectado por tenantMiddleware para el negocio del token JWT.
 * Así cada request opera sobre la BD correcta sin importar cuántos negocios
 * haya en el sistema.
 *
 * ## Endpoints
 * GET    /                        — Listar todos los recursos activos
 * GET    /category/:categoryId    — Filtrar por categoría
 * GET    /:id/availability        — Verificar disponibilidad en rango
 * GET    /:id                     — Obtener recurso por ID
 * POST   /                        — Crear recurso (ADMIN)
 * PUT    /:id                     — Actualizar recurso (ADMIN)
 * DELETE /:id                     — Dar de baja recurso — soft delete (ADMIN)
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppContainer } from '../../container.js';
import { SqlResourceRepository } from '../../repositories/sql.resource.repository.js';
import { toResourceDto } from '../mappers/reservation.mapper.js';
import { AvailabilityQuerySchema, CreateResourceSchema } from '../schemas/request.schemas.js';
import { ResourceNotFoundError } from '../../domain/errors.js';
import { routeParam } from '../utils/params.js';
import { authorize } from '../middleware/auth.middleware.wrapper.js';
import { BookableResource } from '../../domain/entities.js';
import { UserRole } from '../../types/enums.js';
import {
  SqlReservationRepository,
} from '../../repositories/sql.reservation.repository.js';
import {
  SqlOccupancyRepository,
} from '../../repositories/sql.occupancy.repository.js';
import {
  SqlCategoryRepository,
} from '../../repositories/sql.category.repository.js';
import {
  SqlDomainEventRepository,
} from '../../repositories/sql.domain-event.repository.js';
import { ReservationService } from '../../services/reservation.service.js';

export function createResourcesRouter(container: AppContainer): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Rutas GET
  // -------------------------------------------------------------------------

  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const repo = new SqlResourceRepository(req.db);
      const resources = await repo.getAll();
      res.json(resources.map(toResourceDto));
    } catch (err) {
      next(err);
    }
  });

  router.get(
    '/category/:categoryId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const categoryId = routeParam(req.params.categoryId);
        const resources = await repo.getByCategory(categoryId);
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

        const resourceRepo     = new SqlResourceRepository(req.db);
        const reservationRepo  = new SqlReservationRepository(req.db, resourceRepo);
        const occupancyRepo    = new SqlOccupancyRepository(req.db);
        const categoryRepo     = new SqlCategoryRepository(req.db);
        const domainEventRepo  = new SqlDomainEventRepository(req.db);
        const reservationService = new ReservationService(
          reservationRepo,
          resourceRepo,
          occupancyRepo,
          categoryRepo,
          domainEventRepo,
          container.transactionManager,
        );

        const available = await reservationService.checkAvailability(
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

  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const repo = new SqlResourceRepository(req.db);
      const resourceId = routeParam(req.params.id);
      const resource = await repo.getById(resourceId);
      if (!resource) {
        throw new ResourceNotFoundError(resourceId);
      }
      res.json(toResourceDto(resource));
    } catch (err) {
      next(err);
    }
  });

  // -------------------------------------------------------------------------
  // Rutas de escritura — solo ADMIN
  // -------------------------------------------------------------------------

  router.post(
    '/',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const body = CreateResourceSchema.parse(req.body);
        const id = body.id ?? randomUUID();

        const existing = await repo.getByName(body.name);
        if (existing) {
          res.status(409).json({
            code: 'RESOURCE_NAME_CONFLICT',
            message: `Ya existe un recurso con el nombre "${body.name}".`,
          });
          return;
        }

        const resource = new BookableResource(
          id,
          body.name,
          body.basePrice,
          body.categoryId,
          body.visualData ?? null,
        );

        await repo.save(resource);
        res.status(201).json(toResourceDto(resource));
      } catch (err) {
        next(err);
      }
    },
  );

  router.put(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const resourceId = routeParam(req.params.id);

        const current = await repo.getById(resourceId);
        if (!current) {
          throw new ResourceNotFoundError(resourceId);
        }

        const body = CreateResourceSchema.parse(req.body);

        if (body.name !== current.name) {
          const nameConflict = await repo.getByName(body.name);
          if (nameConflict && nameConflict.id !== resourceId) {
            res.status(409).json({
              code: 'RESOURCE_NAME_CONFLICT',
              message: `Ya existe otro recurso con el nombre "${body.name}".`,
            });
            return;
          }
        }

        const updated = new BookableResource(
          resourceId,
          body.name,
          body.basePrice,
          body.categoryId,
          body.visualData ?? current.visualData,
        );

        await repo.save(updated);
        res.json(toResourceDto(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const resourceId = routeParam(req.params.id);
        const deleted = await repo.delete(resourceId);
        if (!deleted) {
          throw new ResourceNotFoundError(resourceId);
        }
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
