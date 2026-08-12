/**
 * @file resources.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET  /resources          — STAFF (todos los empleados, incluyendo HOUSEKEEPING)
 * GET  /resources/:id      — STAFF
 * POST /resources          — MANAGEMENT (OWNER, ADMIN)
 * PUT  /resources/:id      — MANAGEMENT
 * DELETE /resources/:id    — MANAGEMENT
 *
 * ## Cambios
 * - Validación Zod en POST y PUT (400 VALIDATION_ERROR estructurado).
 * - authenticate() removido de cada handler: app.ts ya lo aplica
 *   globalmente sobre /api antes de que estas rutas sean alcanzadas.
 * - Import estático de PhysicalResource (era BookableResource).
 * - POST y PUT verifican que categoryId exista y esté activa antes de save()
 *   usando repo.findById() (retorna null si no existe o está inactiva)
 *   → 422 INVALID_CATEGORY en lugar de 500 FK violation.
 * - DELETE rechaza con 409 RESOURCE_LOCKED_BY_SERVICE si el recurso todavía
 *   está bloqueado por algún bookable_service activo (resource_locks).
 */

import { Router }                        from 'express';
import { authorize }                      from '../../security/auth.middleware.js';
import { Roles }                          from '../../security/roles.js';
import { SqlResourceRepository }         from '../../repositories/sql.resource.repository.js';
import { SqlCategoryRepository }         from '../../repositories/sql.category.repository.js';
import { SqlResourceLockRepository }     from '../../repositories/sql.resource-lock.repository.js';
import { SqlBookableServiceRepository }  from '../../repositories/sql.bookable-service.repository.js';
import { SqlOperatingHoursRepository }   from '../../repositories/sql.operating-hours.repository.js';
import { PhysicalResource }              from '../../domain/entities.js';
import { randomUUID }                     from 'node:crypto';
import { z, ZodError }                   from 'zod';
import { CreateOperatingWindowSchema }   from '../schemas/request.schemas.js';
import type { VisualMetadata }           from '../../types/visual.interface.js';

// ---------------------------------------------------------------------------
// Schemas de validación
// ---------------------------------------------------------------------------

const CreateResourceSchema = z.object({
  id:          z.string().uuid().optional(),
  name:        z.string().min(1, 'name es obligatorio').max(120),
  basePrice:   z.number({ invalid_type_error: 'basePrice debe ser un número' }).min(0).optional().default(0),
  base_price:  z.number().min(0).optional(),
  // Las categorías NO usan ids UUID — CategoryService.createCategory() las
  // genera como `cat-${slugify(nombre)}-${Date.now()}` (ver category.service.ts).
  // Exigir formato UUID acá rechazaba toda categoría real que existe hoy.
  categoryId:  z.string().min(1, 'categoryId es obligatorio').optional(),
  category_id: z.string().min(1).optional(),
  capacity:    z.number().int().min(1).optional().default(1),
  description: z.string().max(500).nullable().optional(),
  visualData:  z.record(z.unknown()).nullable().optional(),
  visual_data: z.record(z.unknown()).nullable().optional(),
}).superRefine((data, ctx) => {
  if (!data.categoryId && !data.category_id) {
    ctx.addIssue({
      code:    z.ZodIssueCode.custom,
      path:    ['categoryId'],
      message: 'categoryId es obligatorio',
    });
  }
});

const UpdateResourceSchema = z.object({
  name:        z.string().min(1).max(120).optional(),
  basePrice:   z.number().min(0).optional(),
  base_price:  z.number().min(0).optional(),
  categoryId:  z.string().min(1).optional(),
  category_id: z.string().min(1).optional(),
  capacity:    z.number().int().min(1).optional(),
  description: z.string().max(500).nullable().optional(),
  visualData:  z.record(z.unknown()).nullable().optional(),
  visual_data: z.record(z.unknown()).nullable().optional(),
});

export function createResourcesRouter(): Router {
  const router = Router();

  // ── GET /resources ────────────────────────────────────────────────────────
  router.get(
    '/',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const resources = await new SqlResourceRepository(req.db).getAll();
        res.json(resources);
      } catch (err) { next(err); }
    },
  );

  // ── GET /resources/:id ─────────────────────────────────────────────────────
  router.get(
    '/:id',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const resource = await new SqlResourceRepository(req.db).getById(req.params['id']!);
        if (!resource) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        res.json(resource);
      } catch (err) { next(err); }
    },
  );

  // ── POST /resources ────────────────────────────────────────────────────────
  router.post(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body       = CreateResourceSchema.parse(req.body);
        const categoryId = (body.categoryId ?? body.category_id)!;

        // findById() filtra active=TRUE — retorna null si no existe O está inactiva
        const catExists = await new SqlCategoryRepository(req.db).findById(categoryId);
        if (!catExists) {
          res.status(422).json({
            code:    'INVALID_CATEGORY',
            message: `La categoría '${categoryId}' no existe o fue eliminada.`,
          });
          return;
        }

        const resource = new PhysicalResource(
          body.id        ?? randomUUID(),
          body.name,
          body.basePrice ?? body.base_price ?? 0,
          categoryId,
          (body.visualData ?? body.visual_data ?? null) as VisualMetadata | null,
          body.capacity  ?? 1,
          body.description ?? null,
        );
        await new SqlResourceRepository(req.db).save(resource);
        res.status(201).json(resource);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors });
          return;
        }
        next(err);
      }
    },
  );

  // ── PUT /resources/:id ─────────────────────────────────────────────────────
  router.put(
    '/:id',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body     = UpdateResourceSchema.parse(req.body);
        const repo     = new SqlResourceRepository(req.db);
        const existing = await repo.getById(req.params['id']!);
        if (!existing) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }

        const categoryId = body.categoryId ?? body.category_id ?? existing.categoryId;

        // Solo verificamos si cambia la categoría
        if (categoryId !== existing.categoryId) {
          const catExists = await new SqlCategoryRepository(req.db).findById(categoryId);
          if (!catExists) {
            res.status(422).json({
              code:    'INVALID_CATEGORY',
              message: `La categoría '${categoryId}' no existe o fue eliminada.`,
            });
            return;
          }
        }

        const updated = new PhysicalResource(
          existing.id,
          body.name        ?? existing.name,
          body.basePrice   ?? body.base_price ?? existing.basePrice,
          categoryId,
          (body.visualData ?? body.visual_data ?? existing.visualData) as VisualMetadata | null,
          body.capacity    ?? existing.capacity,
          body.description !== undefined ? body.description : existing.description,
        );
        await repo.save(updated);
        res.json(updated);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors });
          return;
        }
        next(err);
      }
    },
  );

  // ── DELETE /resources/:id ──────────────────────────────────────────────────
  // Guard: el delete es soft (active=FALSE) y por eso el ON DELETE CASCADE de
  // resource_locks nunca dispara solo. Si no se bloquea acá, el próximo intento
  // de reservar un servicio que todavía lo bloquea explota con
  // ResourceNotFoundError de forma no obvia — mejor un 409 explícito ahora.
  router.delete(
    '/:id',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const resourceId = req.params['id']!;
        const lockRepo    = new SqlResourceLockRepository(req.db);
        const serviceRepo = new SqlBookableServiceRepository(req.db);

        const locks = await lockRepo.getByResourceId(resourceId);
        if (locks.length > 0) {
          const services = await Promise.all(
            locks.map((l) => serviceRepo.findById(l.serviceId)),
          );
          const activeServices = services.filter((s) => s?.active);
          if (activeServices.length > 0) {
            res.status(409).json({
              code: 'RESOURCE_LOCKED_BY_SERVICE',
              message: 'No se puede eliminar: está bloqueado por servicios activos. ' +
                'Desasigná el recurso en esos servicios antes de eliminarlo.',
              services: activeServices.map((s) => ({ id: s!.id, name: s!.name })),
            });
            return;
          }
        }

        const deleted = await new SqlResourceRepository(req.db).delete(resourceId);
        if (!deleted) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  // ── Horario propio del recurso (override opcional del horario del negocio) ─
  // Ver docs/conocimiento-del-negocio.md — ej. un barbero con horario propio
  // distinto al del negocio. Vacío = hereda el default de /api/business-hours.

  router.get(
    '/:id/hours',
    authorize(Roles.BOOKING),
    async (req, res, next) => {
      try {
        const repo = new SqlOperatingHoursRepository(req.db);
        res.json(await repo.getResourceWindows(req.params['id']!));
      } catch (err) { next(err); }
    },
  );

  router.post(
    '/:id/hours',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body = CreateOperatingWindowSchema.parse(req.body);
        const repo = new SqlOperatingHoursRepository(req.db);
        const window = await repo.createResourceWindow({
          id: randomUUID(),
          resourceId: req.params['id']!,
          ...body,
        });
        res.status(201).json(window);
      } catch (err) { next(err); }
    },
  );

  router.delete(
    '/:id/hours/:hourId',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const repo = new SqlOperatingHoursRepository(req.db);
        await repo.deleteResourceWindow(req.params['hourId']!);
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  return router;
}
