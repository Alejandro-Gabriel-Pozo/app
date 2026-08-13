/**
 * @file module.middleware.ts
 * @description Gating por módulo (add-ons modulares) — mismo contrato de
 * errores que ya usaba el gating por plan en categories.routes.ts, para que
 * el frontend pueda tratarlos con el mismo interceptor.
 *
 * ## Códigos HTTP
 * 401 — JWT sin business_id. Body: { code: 'TOKEN_MISSING_BUSINESS', message }
 * 402 — Módulo no habilitado. Body: { code: 'MODULE_NOT_ENABLED', message, module }
 * 503 — BD de plataforma no disponible al consultar entitlements.
 *        Body: { code: 'PLATFORM_UNAVAILABLE', message }
 */

import { Request, Response, NextFunction } from 'express';
import type { AppContainer } from '../container.js';
import type { ModuleKey } from '../types/enums.js';

export function requireModule(container: AppContainer, moduleKey: ModuleKey) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const businessId = req.user?.businessId ?? '';

    if (!businessId) {
      res.status(401).json({
        code:    'TOKEN_MISSING_BUSINESS',
        message: 'El token no tiene un negocio asociado.',
      });
      return;
    }

    let modules: Record<string, boolean>;
    try {
      modules = await container.getBusinessModules(businessId);
    } catch {
      res.status(503).json({
        code:    'PLATFORM_UNAVAILABLE',
        message: 'No se pudo verificar los módulos habilitados del negocio.',
      });
      return;
    }

    if (!modules[moduleKey]) {
      res.status(402).json({
        code:    'MODULE_NOT_ENABLED',
        message: `El módulo ${moduleKey} no está habilitado para este negocio.`,
        module:  moduleKey,
      });
      return;
    }

    next();
  };
}
