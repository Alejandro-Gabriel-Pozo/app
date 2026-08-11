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
 */

import { Router }                        from 'express';
import { authorize }                      from '../../security/auth.middleware.js';
import { Roles }                          from '../../security/roles.js';
import { SqlResourceRepository }         from '../../repositories/sql.resource.repository.js';
import { SqlCategoryRepository }         from '../../repositories/sql.category.repository.js';
import { PhysicalResource }              from '../../domain/entities.js';
import { randomUUID }                     from 'node:crypto';
import { z, ZodError }                   from 'zod';
import type { VisualMetadata }           from '../../types/visual.interface.js';

// ---------------------------------------------------------------------------
// Schemas de validación
// ---------------------------------------------------------------------------

const CreateResourceSchema = z.object({
  id:          z.string().uuid().optional(),
  name:        z.string().min(1, 'name es obligatorio').max(120),
  basePrice:   z.number({ invalid_type_error: 'basePrice debe ser un número' }).min(0).optional().default(0),
  base_price:  z.number().min(0).optional(),
  categoryId:  z.string().uuid('categoryId debe ser un UUID válido').optional(),
  category_id: z.string().uuid().optional(),
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
  categoryId:  z.string().uuid().optional(),
  category_id: z.string().uuid().optional(),
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
  router.delete(
    '/:id',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const deleted = await new SqlResourceRepository(req.db).delete(req.params['id']!);
        if (!deleted) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  return router;
}
