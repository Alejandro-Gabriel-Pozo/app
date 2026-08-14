/**
 * @file categories.routes.ts
 * @description Rutas para gestión de categorías de recursos.
 *
 * ## Aislamiento multi-tenant
 * Cada handler instancia SqlCategoryRepository(req.db!) y construye
 * un CategoryService fresco. El ! es seguro: tenantMiddleware garantiza
 * req.db antes de que cualquier handler aquí ejecute.
 *
 * ## Plan del negocio
 * Se obtiene vía container.getBusinessPlan(businessId) en lugar de
 * platformRepo.findById() — es más eficiente (solo trae el plan,
 * no el objeto completo) y evita una query innecesaria a la BD central.
 *
 * ## Validación de businessId
 * POST / valida explícitamente que req.user.businessId no esté vacío
 * ANTES de llamar a getBusinessPlan. Si está vacío el JWT no tiene
 * business_id (token viejo o token de cliente) → 401 TOKEN_MISSING_BUSINESS
 * en lugar del 503 PLATFORM_UNAVAILABLE que se veía antes.
 * El frontend puede tratar TOKEN_MISSING_BUSINESS igual que TOKEN_EXPIRED
 * y redirigir a /login automáticamente.
 *
 * ## Códigos HTTP de respuesta (POST /)
 * 201 — Categoría creada correctamente.
 * 400 — Body inválido (Zod). Body: { code: 'VALIDATION_ERROR', errors }
 * 401 — JWT sin business_id. Body: { code: 'TOKEN_MISSING_BUSINESS', message }
 * 402 — Límite de plan alcanzado. Body: { code: 'PLAN_LIMIT_REACHED',
 *        message, plan, limit }
 * 503 — BD de plataforma no disponible al consultar el plan.
 *        Body: { code: 'PLATFORM_UNAVAILABLE', message }
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import {
  CategoryService,
  PlanLimitError,
  CategoryNotFoundError,
} from '../../services/category.service.js';
import {
  CreateCategorySchema,
  UpdateCategorySchema,
} from '../schemas/category.schemas.js';
import type { CategoryField } from '../../types/resource-category.types.js';
import { ZodError } from 'zod';
import { SqlCategoryRepository } from '../../repositories/sql.category.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import type { AppContainer } from '../../container.js';

export function createCategoryRouter(container: AppContainer): Router {
  const router = Router();

  function buildService(req: Request): CategoryService {
    return new CategoryService(
      new SqlCategoryRepository(req.db!),
      new SqlAuditLogRepository(req.db!),
    );
  }

  // ---------------------------------------------------------------------------
  // GET /
  // ---------------------------------------------------------------------------
  router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const service = buildService(req);
      const categories = await service.listCategories();
      res.json(categories);
    } catch (err) { next(err); }
  });

  // ---------------------------------------------------------------------------
  // GET /:id
  // ---------------------------------------------------------------------------
  router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const service  = buildService(req);
      const category = await service.getCategoryById(String(req.params['id']));
      res.json(category);
    } catch (err) {
      if (err instanceof CategoryNotFoundError) {
        res.status(404).json({ code: 'NOT_FOUND', message: err.message });
        return;
      }
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /
  // ---------------------------------------------------------------------------
  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body       = CreateCategorySchema.parse(req.body);
      const businessId = req.user?.businessId ?? '';

      // Guard: si el JWT no incluye business_id el token es inválido para
      // esta operación (fue firmado antes del fix o es un token de cliente).
      // Respondemos 401 con un código específico para que el frontend lo
      // trate igual que TOKEN_EXPIRED y redirija a /login.
      if (!businessId) {
        res.status(401).json({
          code:    'TOKEN_MISSING_BUSINESS',
          message: 'Tu sesión no contiene el ID del negocio. Cerrá sesión e ingresá de nuevo.',
        });
        return;
      }

      // Usa getBusinessPlan() en lugar de platformRepo.findById() —
      // solo trae el plan (string), no el objeto completo del negocio.
      let plan;
      try {
        plan = await container.getBusinessPlan(businessId);
      } catch {
        // La BD de plataforma no respondió. El tenant sigue operativo pero
        // no podemos verificar el límite de plan. Respondemos 503 con un
        // código explícito para que el frontend lo trate diferente a un 500.
        res.status(503).json({
          code:    'PLATFORM_UNAVAILABLE',
          message: 'No se pudo verificar el plan del negocio. Reintentá en unos segundos.',
        });
        return;
      }

      const service  = buildService(req);
      const category = await service.createCategory(
        { name: body.name, fields: body.fields as CategoryField[], ...(body.description !== undefined && { description: body.description }) },
        plan,
      );
      res.status(201).json(category);
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors });
        return;
      }
      // 402 Payment Required — semántica correcta para límite de plan.
      // Incluye `plan` y `limit` para que el frontend los muestre
      // sin hardcodear valores.
      if (err instanceof PlanLimitError) {
        res.status(402).json({
          code:    'PLAN_LIMIT_REACHED',
          message: err.message,
          plan:    err.plan,
          limit:   err.limit,
        });
        return;
      }
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // PUT /:id
  // ---------------------------------------------------------------------------
  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body     = UpdateCategorySchema.parse(req.body);
      const service  = buildService(req);
      const category = await service.updateCategory(
        String(req.params['id']),
        {
          ...(body.name        !== undefined && { name:        body.name }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.fields      !== undefined && { fields:      body.fields as CategoryField[] }),
          ...(body.active      !== undefined && { active:      body.active }),
        },
        req.user!.id,
      );
      res.json(category);
    } catch (err) {
      if (err instanceof ZodError)               { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      if (err instanceof CategoryNotFoundError)  { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  // ---------------------------------------------------------------------------
  // DELETE /:id
  // ---------------------------------------------------------------------------
  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const service = buildService(req);
      await service.deleteCategory(String(req.params['id']));
      res.status(204).send();
    } catch (err) {
      if (err instanceof CategoryNotFoundError) { res.status(404).json({ code: 'NOT_FOUND', message: err.message }); return; }
      next(err);
    }
  });

  return router;
}
