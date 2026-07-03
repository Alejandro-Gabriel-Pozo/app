/**
 * @file categories.routes.ts
 * @description Rutas para gestión de categorías de recursos.
 *
 * Todos los endpoints requieren autenticación de empleado.
 * Solo ADMIN puede crear, actualizar y eliminar categorías.
 * ADMIN y RECEPTIONIST pueden listar y consultar.
 *
 * POST   /api/categories           → crear categoría (ADMIN)
 * GET    /api/categories           → listar categorías activas
 * GET    /api/categories/:id       → detalle de una categoría
 * PUT    /api/categories/:id       → actualizar categoría (ADMIN)
 * DELETE /api/categories/:id       → desactivar categoría (ADMIN)
 */

import { Router, type Request, type Response } from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { authorize } from '../middleware/authorize.middleware.js';
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

  // Todas las rutas requieren empleado autenticado
  router.use(authenticate);

  // GET /api/categories
  router.get('/', async (req: Request, res: Response) => {
    const categories = await categoryService.listCategories();
    res.json(categories);
  });

  // GET /api/categories/:id
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const category = await categoryService.getCategoryById(req.params.id);
      res.json(category);
    } catch (err) {
      if (err instanceof CategoryNotFoundError) {
        res.status(404).json({ code: 'NOT_FOUND', message: err.message });
        return;
      }
      throw err;
    }
  });

  // POST /api/categories — solo ADMIN
  router.post(
    '/',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response) => {
      try {
        const body = CreateCategorySchema.parse(req.body);
        const plan = await getBusinessPlan((req as any).user.businessId);
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
        throw err;
      }
    },
  );

  // PUT /api/categories/:id — solo ADMIN
  router.put(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response) => {
      try {
        const body = UpdateCategorySchema.parse(req.body);
        const category = await categoryService.updateCategory(req.params.id, body);
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
        throw err;
      }
    },
  );

  // DELETE /api/categories/:id — solo ADMIN
  router.delete(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response) => {
      try {
        await categoryService.deleteCategory(req.params.id);
        res.status(204).send();
      } catch (err) {
        if (err instanceof CategoryNotFoundError) {
          res.status(404).json({ code: 'NOT_FOUND', message: err.message });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
