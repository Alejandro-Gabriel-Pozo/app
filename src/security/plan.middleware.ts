/**
 * @file plan.middleware.ts
 * @description Gating por plan de suscripción (18/08/2026, empresas
 * multipropiedad — pendientes-2026-08-18.md, deuda estructural: "Empresas
 * multipropiedad sin gate de plan"). Mismo contrato de errores que
 * module.middleware.ts (`requireModule`) — incluido el mismo motivo:
 * el frontend trata todos los 402 de gating con el mismo interceptor.
 *
 * A diferencia de `requireModule` (on/off por negocio, tabla
 * `business_modules`), esto compara el plan actual del negocio
 * (`container.getBusinessPlan`) contra el plan mínimo requerido — hoy solo
 * lo usa `POST /api/companies` y `POST /api/companies/link` (plan
 * ENTERPRISE), pero queda genérico por si otra feature futura se gatea
 * igual por plan en vez de por módulo.
 *
 * ## Códigos HTTP
 * 401 — JWT sin business_id. Body: { code: 'TOKEN_MISSING_BUSINESS', message }
 * 402 — Plan insuficiente. Body: { code: 'PLAN_UPGRADE_REQUIRED', message, plan, requiredPlan }
 * 503 — BD de plataforma no disponible al consultar el plan.
 *        Body: { code: 'PLATFORM_UNAVAILABLE', message }
 */

import type { Request, Response, NextFunction } from 'express';
import type { AppContainer } from '../container.js';
import type { BusinessPlan } from '../types/enums.js';

export function requirePlan(container: AppContainer, requiredPlan: BusinessPlan) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const businessId = req.user?.businessId ?? '';

    if (!businessId) {
      res.status(401).json({
        code:    'TOKEN_MISSING_BUSINESS',
        message: 'El token no tiene un negocio asociado.',
      });
      return;
    }

    let plan: BusinessPlan;
    try {
      plan = await container.getBusinessPlan(businessId);
    } catch {
      res.status(503).json({
        code:    'PLATFORM_UNAVAILABLE',
        message: 'No se pudo verificar el plan del negocio.',
      });
      return;
    }

    if (plan !== requiredPlan) {
      res.status(402).json({
        code:         'PLAN_UPGRADE_REQUIRED',
        message:      `Esta función requiere el plan ${requiredPlan}. Tu plan actual es ${plan}.`,
        plan,
        requiredPlan,
      });
      return;
    }

    next();
  };
}
