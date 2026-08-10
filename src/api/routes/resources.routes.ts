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
 * El servicio se construye por request usando req.db (SqlClient del tenant
 * inyectado por tenantMiddleware). Patrón idéntico a housekeeping y stays.
 *
 * ## Cambios
 * - Validación Zod en POST y PUT (400 VALIDATION_ERROR estructurado).
 * - authenticate() removido de cada handler: app.ts ya lo aplica
 *   globalmente sobre /api antes de que estas rutas sean alcanzadas.
 * - Import estático de BookableResource (era dynamic import en cada handler).
 * - POST y PUT verifican que categoryId exista antes de save()
 *   → 422 INVALID_CATEGORY en lugar de 500 FK violation.
 */

import { Router }                        from 'express';
import { authorize }                      from '../../security/auth.middleware.js';
import { Roles }                          from '../../security/roles.js';
import { SqlResourceRepository }         from '../../repositories/sql.resource.repository.js';
import { SqlCategoryRepository }         from '../../repositories/sql.category.repository.js';
import { BookableResource }              from '../../domain/entities.js';
import { randomUUID }                     from 'node:crypto';
import { z, ZodError }                   from 'zod';

// ---------------------------------------------------------------------------
// Schemas de validación
// ---------------------------------------------------------------------------

const CreateResourceSchema = z.object({
  id:          z.string().uuid().optional(),
  name:        z.string().min(1, 'name es obligatorio').max(120),
  basePrice:   z.number({ invalid_type_error: 'basePrice debe ser un número' }).min(0).optional().default(0),
  base_price:  z.number().min(0).optional(),  // alias snake_case (compatibilidad frontend)
  categoryId:  z.string().uuid('categoryId debe ser un UUID válido').optional(),
  category_id: z.string().uuid().optional(),  // alias snake_case
  capacity:    z.number().int().min(1).optional().default(1),
  description: z.string().max(500).nullable().optional(),
  visualData:  z.record(z.unknown()).nullable().optional(),
  visual_data: z.record(z.unknown()).nullable().optional(),
}).superRefine((data, ctx) => {
  const cat = data.categoryId ?? data.category_id;
  if (!cat) {
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

// ---------------------------------------------------------------------------
// Helper: verifica que una categoría exista en el tenant (req.db)
// Retorna false si no existe → el handler responde 422 INVALID_CATEGORY.
// ---------------------------------------------------------------------------
async function categoryExists(db: typeof undefined extends undefined ? never : NonNullable<unknown>, categoryId: string): Promise<boolean> {
  const repo = new SqlCategoryRepository(db as Parameters<typeof SqlCategoryRepository['prototype']['getCategoryById']>[0] extends never ? never : any); // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    await repo.getCategoryById(categoryId);
    return true;
  } catch {
    return false;
  }
}

export function createResourcesRouter(): Router {
  const router = Router();

  // ── GET /resources ─────────────────────────────────────────────────────────
  router.get(
    '/',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const repo = new SqlResourceRepository(req.db);
        const resources = await repo.getAll();
        res.json(resources);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /resources/:id ─────────────────────────────────────────────────────
  router.get(
    '/:id',
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const repo     = new SqlResourceRepository(req.db);
        const resource = await repo.getById(req.params['id'] as string);
        if (!resource) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        res.json(resource);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /resources ────────────────────────────────────────────────────────
  router.post(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body = CreateResourceSchema.parse(req.body);

        const categoryId = body.categoryId ?? body.category_id as string;
        const catRepo    = new SqlCategoryRepository(req.db);
        const catExists  = await catRepo.getCategoryById(categoryId).then(() => true).catch(() => false);
        if (!catExists) {
          res.status(422).json({
            code:    'INVALID_CATEGORY',
            message: `La categoría '${categoryId}' no existe en este tenant.`,
          });
          return;
        }

        const resource = new BookableResource(
          body.id        ?? randomUUID(),
          body.name,
          body.basePrice ?? body.base_price ?? 0,
          categoryId,
          (body.visualData ?? body.visual_data ?? null) as import('../../types/visual.interface.js').VisualMetadata | null,
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
        const body = UpdateResourceSchema.parse(req.body);
        const repo = new SqlResourceRepository(req.db);

        const existing = await repo.getById(req.params['id'] as string);
        if (!existing) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }

        const categoryId = body.categoryId ?? body.category_id ?? existing.categoryId;

        // Solo verificamos la categoría si el cliente la está cambiando
        if (categoryId !== existing.categoryId) {
          const catExists = await new SqlCategoryRepository(req.db)
            .getCategoryById(categoryId)
            .then(() => true)
            .catch(() => false);
          if (!catExists) {
            res.status(422).json({
              code:    'INVALID_CATEGORY',
              message: `La categoría '${categoryId}' no existe en este tenant.`,
            });
            return;
          }
        }

        const updated = new BookableResource(
          existing.id,
          body.name        ?? existing.name,
          body.basePrice   ?? body.base_price   ?? existing.basePrice,
          categoryId,
          (body.visualData ?? body.visual_data ?? existing.visualData) as import('../../types/visual.interface.js').VisualMetadata | null,
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
        const repo    = new SqlResourceRepository(req.db);
        const deleted = await repo.delete(req.params['id'] as string);
        if (!deleted) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Recurso no encontrado' });
          return;
        }
        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
