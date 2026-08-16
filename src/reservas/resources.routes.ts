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
 * - Validación Zod en POST y PUT. ZodError se propaga con next(err) al
 *   errorHandler central (igual que el resto de las rutas) en vez de
 *   manejarse inline — la versión inline mandaba err.errors sin
 *   .flatten(), así que extractFieldErrors() del frontend (que lee
 *   errors.fieldErrors) nunca encontraba nada y el resaltado de campo en
 *   el formulario de recursos no funcionaba (jscpd C1, 13/08/2026).
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
import type { Request }                  from 'express';
import { authorize }                      from '../security/auth.middleware.js';
import { Roles }                          from '../security/roles.js';
import { SqlResourceRepository }         from './sql.resource.repository.js';
import { SqlCategoryRepository }         from './sql.category.repository.js';
import { SqlLocationRepository }         from '../platform/location.repository.js';
import { SqlResourceLockRepository }     from './sql.resource-lock.repository.js';
import { SqlBookableServiceRepository }  from './sql.bookable-service.repository.js';
import { SqlOperatingHoursRepository }   from '../platform/sql.operating-hours.repository.js';
import { windowsOverlap }                from '../platform/operating-hours.repository.js';
import { PhysicalResource }              from './resource.entities.js';
import { randomUUID }                     from 'node:crypto';
import { z }                              from 'zod';
import { CreateOperatingWindowSchema }   from '../api/schemas/request.schemas.js';
import type { VisualMetadata }           from '../types/visual.interface.js';
import { SqlAuditLogRepository }         from '../repositories/audit-log.repository.js';
import { diffFields }                    from '../domain/audit.js';

const AUDIT_ENTITY_RESOURCE = 'resources';

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
  // Opcional a propósito: hoy no hay ningún selector de sucursal en el
  // frontend. Si no viene, POST /resources resuelve la location por
  // defecto del tenant (ver handler abajo) — no bloquea la creación.
  locationId:  z.string().min(1).optional(),
  location_id: z.string().min(1).optional(),
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
  locationId:  z.string().min(1).optional(),
  location_id: z.string().min(1).optional(),
});

/**
 * Resuelve la location a usar cuando el caller no mandó una explícita.
 * Hoy todo tenant tiene exactamente una (`loc-default`, ver bloque
 * LOCATIONS de schema.sql) — `findAll()[0]` es determinístico mientras
 * eso siga siendo cierto. El día que exista más de una, esto deja de ser
 * válido y hay que pedir la location explícitamente (o resolverla por
 * algún otro criterio) en vez de asumir la primera.
 */
async function resolveLocationId(req: Request, explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const locations = await new SqlLocationRepository(req.db).findAll();
  const [first] = locations;
  if (!first) {
    throw new Error('[resources.routes] El tenant no tiene ninguna location — revisar que schema.sql corrió el backfill.');
  }
  return first.id;
}

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

        // findById() ya no filtra por estado (docs/criterios-datos.md R2) —
        // el chequeo de "¿se puede usar para algo nuevo?" es explícito acá,
        // distinguiendo no-existe de pausada/borrada (R15: fallar fuerte,
        // no colapsar dos motivos de rechazo distintos en un mismo mensaje).
        const category = await new SqlCategoryRepository(req.db).findById(categoryId);
        if (!category) {
          res.status(422).json({
            code:    'INVALID_CATEGORY',
            message: `La categoría '${categoryId}' no existe.`,
          });
          return;
        }
        if (!category.active) {
          res.status(422).json({
            code:    'INVALID_CATEGORY',
            message: `La categoría '${categoryId}' está desactivada — reactivala o elegí otra.`,
          });
          return;
        }

        const locationId = await resolveLocationId(req, body.locationId ?? body.location_id);

        const resource = new PhysicalResource(
          body.id        ?? randomUUID(),
          body.name,
          body.basePrice ?? body.base_price ?? 0,
          categoryId,
          (body.visualData ?? body.visual_data ?? null) as VisualMetadata | null,
          body.capacity  ?? 1,
          body.description ?? null,
          /* categoryName */ null,
          locationId,
        );
        await new SqlResourceRepository(req.db).save(resource);
        res.status(201).json(resource);
      } catch (err) { next(err); }
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

        // Solo verificamos si cambia la categoría — mismo criterio que POST
        // (docs/criterios-datos.md R2/R15): no-existe y pausada son
        // motivos de rechazo distintos, con mensajes distintos.
        if (categoryId !== existing.categoryId) {
          const category = await new SqlCategoryRepository(req.db).findById(categoryId);
          if (!category) {
            res.status(422).json({
              code:    'INVALID_CATEGORY',
              message: `La categoría '${categoryId}' no existe.`,
            });
            return;
          }
          if (!category.active) {
            res.status(422).json({
              code:    'INVALID_CATEGORY',
              message: `La categoría '${categoryId}' está desactivada — reactivala o elegí otra.`,
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
          existing.categoryName,
          body.locationId ?? body.location_id ?? existing.locationId,
        );
        await repo.save(updated);

        // Auditoría (R8/A9.4) — diff contra lo que realmente vino en el
        // body, no contra el objeto merged de arriba (si no cambió no debe
        // quedar como "cambio"). visualData queda afuera a propósito: es
        // posición en el plano, no un dato de negocio que alguien vaya a
        // disputar — auditarlo generaría ruido en cada drag-and-drop.
        // Sin ResourceService propio (ver comentario de archivo), se
        // audita acá directo, mismo patrón que CategoryService/
        // ProductService/BookableServiceService.
        const changes = diffFields(existing, {
          name:        body.name,
          basePrice:   body.basePrice ?? body.base_price,
          categoryId:  body.categoryId ?? body.category_id,
          capacity:    body.capacity,
          description: body.description,
          locationId:  body.locationId ?? body.location_id,
        });
        if (changes.length > 0) {
          await new SqlAuditLogRepository(req.db).record(
            changes.map((c) => ({
              entity: AUDIT_ENTITY_RESOURCE,
              entityId: existing.id,
              field: c.field,
              oldValue: c.oldValue,
              newValue: c.newValue,
              changedBy: req.user!.id,
            })),
          );
        }

        res.json(updated);
      } catch (err) { next(err); }
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
        const resourceId = req.params['id']!;
        const repo = new SqlOperatingHoursRepository(req.db);

        const existing = await repo.getResourceWindows(resourceId);
        const sameDay = existing.filter((w) => w.dayOfWeek === body.dayOfWeek);
        if (sameDay.some((w) => windowsOverlap(w, body))) {
          res.status(409).json({
            code: 'OPERATING_WINDOW_OVERLAP',
            message: 'Ya existe una franja horaria que se superpone con esa, para ese día.',
          });
          return;
        }

        const window = await repo.createResourceWindow({
          id: randomUUID(),
          resourceId,
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
