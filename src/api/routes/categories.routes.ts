/**
 * @file categories.routes.ts
 * @description Rutas para gestión de categorías de recursos.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { UserRole, BusinessPlan } from '../../types/enums.js';
import {
  CategoryService,
  PlanLimitError,
  CategoryNotFoundError,
} from '../../services/category.service.js';
import {
  CreateCategorySchema,
  UpdateCategorySchema,
} from '../schemas/category.schemas.js';
import { ZodError } from 'zod';

export function createCategoryRouter(
  categoryService: CategoryService,
  getBusinessPlan: (businessId: string) => Promise<BusinessPlan>,
): Router {
  const router = Router();

  router.use(authenticate());

  // GET /api/categories
  router.get(
    '/',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = String((req as any).user?.businessId ?? '');
        const categories = await categoryService.listCategories(businessId);
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
        const category = await categoryService.getCategoryById(String(req.params['id']));
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
        const body = CreateCategorySchema.parse(req.body);
        const businessId = String((req as any).user?.businessId ?? '');
        const plan = await getBusinessPlan(businessId);
        const category = await categoryService.createCategory(body, plan);
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
        const category = await categoryService.updateCategory(String(req.params['id']), body);
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
        await categoryService.deleteCategory(String(req.params['id']));
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
