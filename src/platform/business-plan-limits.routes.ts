/**
 * @file business-plan-limits.routes.ts
 * @description Expone los límites de plan del negocio autenticado (L,
 * 23/08/2026, pendientes-2026-08-23.md) — para que el dashboard sepa
 * `maxCustomRoles`/`allowedPermissionGroups` (entre otros) sin necesitar
 * `Roles.MANAGEMENT`. Mismo patrón que `business-modules.routes.ts`: no
 * requiere `req.db` de tenant — usa `container.getBusinessPlan()`/
 * `getPlanLimits()`, que consultan la BD de plataforma. Por eso puede
 * montarse antes de tenantMiddleware, igual que ese archivo.
 *
 * ## GET /api/business/plan-limits
 * 200 — { plan: BusinessPlan, limits: PlanLimits }
 * 401 — JWT sin business_id. Body: { code: 'TOKEN_MISSING_BUSINESS', message }
 * 503 — BD de plataforma no disponible. Body: { code: 'PLATFORM_UNAVAILABLE', message }
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppContainer } from '../container.js';

export function createBusinessPlanLimitsRouter(container: AppContainer): Router {
  const router = Router();

  router.get('/', async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const businessId = req.user?.businessId ?? '';

    if (!businessId) {
      res.status(401).json({
        code:    'TOKEN_MISSING_BUSINESS',
        message: 'El token no tiene un negocio asociado.',
      });
      return;
    }

    try {
      const plan   = await container.getBusinessPlan(businessId);
      const limits = await container.getPlanLimits(plan);
      res.json({ plan, limits });
    } catch {
      res.status(503).json({
        code:    'PLATFORM_UNAVAILABLE',
        message: 'No se pudo obtener los límites de plan del negocio.',
      });
    }
  });

  return router;
}
