/**
 * @file resources.routes.ts
 * @description Rutas de recursos reservables.
 *
 * ## Endpoints
 * GET    /                        — Listar todos los recursos activos
 * GET    /category/:categoryId    — Filtrar por categoría
 * GET    /:id/availability        — Verificar disponibilidad en rango
 * GET    /:id                     — Obtener recurso por ID
 * POST   /                        — Crear recurso (ADMIN)
 * PUT    /:id                     — Actualizar recurso (ADMIN)
 * DELETE /:id                     — Dar de baja recurso — soft delete (ADMIN)
 *
 * ## Cambios
 * - Se reemplaza `/type/:type` por `/category/:categoryId`.
 *   El enum `ResourceType` ya no existe — el filtro es por FK a `resource_categories`.
 * - Se agregan POST, PUT y DELETE protegidos con `authorize([UserRole.ADMIN])`.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppContainer } from '../../container.js';
import { toResourceDto } from '../mappers/reservation.mapper.js';
import { AvailabilityQuerySchema, CreateResourceSchema } from '../schemas/request.schemas.js';
import { ResourceNotFoundError } from '../../domain/errors.js';
import { routeParam } from '../utils/params.js';
import { authorize } from '../middleware/auth.middleware.wrapper.js';
import { BookableResource } from '../../domain/entities.js';
import { UserRole } from '../../types/enums.js';

export function createResourcesRouter(container: AppContainer): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // Rutas GET (públicas dentro de /api — requieren JWT pero no rol específico)
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Rutas de escritura — solo ADMIN
  // -------------------------------------------------------------------------

  /**
   * POST /api/resources
   * Crea un nuevo recurso.
   * Si no se envía `id`, se genera un UUID automáticamente.
   */
  router.post(
    '/',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = CreateResourceSchema.parse(req.body);
        const id = body.id ?? randomUUID();

        // Evitar duplicados por nombre dentro del mismo negocio
        const existing = await container.resourceRepository.getByName(body.name);
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

        await container.resourceRepository.save(resource);
        res.status(201).json(toResourceDto(resource));
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * PUT /api/resources/:id
   * Actualiza un recurso existente (reemplaza campos enviados).
   * Usa el mismo upsert de `save()` — todos los campos son obligatorios
   * porque `BookableResource` es inmutable.
   */
  router.put(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resourceId = routeParam(req.params.id);

        const current = await container.resourceRepository.getById(resourceId);
        if (!current) {
          throw new ResourceNotFoundError(resourceId);
        }

        const body = CreateResourceSchema.parse(req.body);

        // Si cambia el nombre, verificar que no colisione con otro recurso
        if (body.name !== current.name) {
          const nameConflict = await container.resourceRepository.getByName(body.name);
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

        await container.resourceRepository.save(updated);
        res.json(toResourceDto(updated));
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * DELETE /api/resources/:id
   * Soft-delete: marca el recurso como `active = FALSE`.
   * No elimina registros de la BD para mantener integridad referencial
   * con reservas históricas.
   */
  router.delete(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const resourceId = routeParam(req.params.id);
        const deleted = await container.resourceRepository.delete(resourceId);
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
