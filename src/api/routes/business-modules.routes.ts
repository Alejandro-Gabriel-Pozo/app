/**
 * @file business-modules.routes.ts
 * @description Expone los entitlements (módulos habilitados) del negocio
 * autenticado, para que el frontend condicione la navegación del dashboard.
 * No requiere req.db de tenant — usa container.getBusinessModules, que
 * consulta la BD de plataforma. Por eso puede montarse antes de
 * tenantMiddleware, igual que /api/admin.
 *
 * ## GET /api/business/modules
 * 200 — { modules: Record<ModuleKey, boolean> }
 * 401 — JWT sin business_id. Body: { code: 'TOKEN_MISSING_BUSINESS', message }
 * 503 — BD de plataforma no disponible. Body: { code: 'PLATFORM_UNAVAILABLE', message }
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import type { AppContainer } from '../../container.js';

export function createBusinessModulesRouter(container: AppContainer): Router {
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
      const modules = await container.getBusinessModules(businessId);
      res.json({ modules });
    } catch {
      res.status(503).json({
        code:    'PLATFORM_UNAVAILABLE',
        message: 'No se pudo obtener los módulos habilitados del negocio.',
      });
    }
  });

  return router;
}
