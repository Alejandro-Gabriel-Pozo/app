/**
 * @file categories.routes.ts
 * @description Rutas para gestión de categorías de recursos.
 *
 * ## Aislamiento multi-tenant
 * Cada handler instancia SqlCategoryRepository(req.db) y construye
 * un CategoryService fresco, de modo que todas las operaciones operen
 * sobre la BD del negocio autenticado (inyectada por tenantMiddleware).
 *
 * ## Endpoints
 * GET    /          — listar categorías activas
 * GET    /:id       — obtener categoría por ID
 * POST   /          — crear categoría (ADMIN) — valida límite de plan
 * PUT    /:id       — actualizar categoría (ADMIN)
 * DELETE /:id       — dar de baja categoría (ADMIN)
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { UserRole } from '../../types/enums.js';
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
import type { PlatformRepository } from '../../platform/platform.repository.js';

export function createCategoryRouter(
  platformRepo: PlatformRepository | null,
): Router {
  const router = Router();

  // GET /api/categories
  router.get(
    '/',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const service = new CategoryService(new SqlCategoryRepository(req.db));
        const categories = await service.listCategories();
        res.json(categories);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/categories/:id
  router.get(
    '/:id',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const service = new CategoryService(new SqlCategoryRepository(req.db));
        const category = await service.getCategoryById(String(req.params['id']));
        res.json(category);
      } catch (err) {
        if (err instanceof CategoryNotFoundError) {
          res.status(404).json({ code: 'NOT_FOUND', message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // POST /api/categories — solo ADMIN
  router.post(
    '/',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body       = CreateCategorySchema.parse(req.body);
        const businessId = String((req as any).user?.businessId ?? '');

        // Resolver plan del negocio desde platformRepo
        if (!platformRepo) {
          res.status(503).json({
            code: 'PLATFORM_UNAVAILABLE',
            message: 'La gestión de categorías requiere PLATFORM_DATABASE_URL.',
          });
          return;
        }
        const business = await platformRepo.findById(businessId);
        if (!business) {
          res.status(404).json({
            code: 'BUSINESS_NOT_FOUND',
            message: `Negocio "${businessId}" no encontrado.`,
          });
          return;
        }

        const service  = new CategoryService(new SqlCategoryRepository(req.db));
        const category = await service.createCategory(
          {
            name:   body.name,
            fields: body.fields as CategoryField[],
            ...(body.description !== undefined && { description: body.description }),
          },
          business.plan,
        );
        res.status(201).json(category);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors });
          return;
        }
        if (err instanceof PlanLimitError) {
          res.status(403).json({ code: 'PLAN_LIMIT_REACHED', message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // PUT /api/categories/:id — solo ADMIN
  router.put(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = UpdateCategorySchema.parse(req.body);
        const service = new CategoryService(new SqlCategoryRepository(req.db));
        const category = await service.updateCategory(
          String(req.params['id']),
          {
            ...(body.name        !== undefined && { name:        body.name }),
            ...(body.description !== undefined && { description: body.description }),
            ...(body.fields      !== undefined && { fields:      body.fields as CategoryField[] }),
            ...(body.active      !== undefined && { active:      body.active }),
          },
        );
        res.json(category);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors });
          return;
        }
        if (err instanceof CategoryNotFoundError) {
          res.status(404).json({ code: 'NOT_FOUND', message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  // DELETE /api/categories/:id — solo ADMIN
  router.delete(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const service = new CategoryService(new SqlCategoryRepository(req.db));
        await service.deleteCategory(String(req.params['id']));
        res.status(204).send();
      } catch (err) {
        if (err instanceof CategoryNotFoundError) {
          res.status(404).json({ code: 'NOT_FOUND', message: err.message });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
