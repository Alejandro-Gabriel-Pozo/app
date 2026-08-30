/**
 * @file module.middleware.ts
 * @description Gating por módulo (add-ons modulares) — mismo contrato de
 * errores que ya usaba el gating por plan en categories.routes.ts, para que
 * el frontend pueda tratarlos con el mismo interceptor.
 *
 * ## Códigos HTTP
 * 401 — JWT sin business_id. Body: { code: 'TOKEN_MISSING_BUSINESS', message }
 * 402 — Módulo no habilitado. Body: { code: 'MODULE_NOT_ENABLED', message,
 *        module, restrictedBy, origin }. `restrictedBy` (`'NOT_IMPLEMENTED'`
 *        | null en el bloque acotado) y `origin` (`'SYSTEM_DEFAULT'` |
 *        `'TENANT_OVERRIDE'`) son ADITIVOS — backend-only, sin cambio de
 *        frontend. Ver docs/diseno-cascada-enforcement-2026-08-30.md §3e.
 * 503 — BD de plataforma no disponible al consultar entitlements.
 *        Body: { code: 'PLATFORM_UNAVAILABLE', message }
 */

import type { Request, Response, NextFunction } from 'express';
import type { AppContainer, ModuleGate } from '../container.js';
import type { ModuleKey } from '../types/enums.js';
import { logger } from '../logger.js';

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

    let gates: Record<string, ModuleGate>;
    try {
      gates = await container.getBusinessModuleGates(businessId);
    } catch {
      res.status(503).json({
        code:    'PLATFORM_UNAVAILABLE',
        message: 'No se pudo verificar los módulos habilitados del negocio.',
      });
      return;
    }

    const gate = gates[moduleKey];
    if (!gate?.enabled) {
      const restrictedBy = gate?.restrictedBy ?? null;
      const origin       = gate?.origin ?? 'SYSTEM_DEFAULT';
      // Un 402 fail-closed normal (el negocio no contrató el módulo) es una
      // condición de cliente esperada -> `info`. `NOT_IMPLEMENTED` es un
      // estado inesperado (hay override `enabled = true` para un módulo sin
      // código) -> `warn` (DEFENSIVE_DEVELOPING.md §1.4: ruido sólo ante lo
      // inesperado). Sin PII: sólo ids y enums (criterios-negocio.md A7.1).
      const logLine = { businessId, moduleKey, restrictedBy, origin };
      const logMsg  = '[requireModule] 402 MODULE_NOT_ENABLED';
      if (restrictedBy === 'NOT_IMPLEMENTED') logger.warn(logLine, logMsg);
      else logger.info(logLine, logMsg);
      res.status(402).json({
        code:         'MODULE_NOT_ENABLED',
        message:      `El módulo ${moduleKey} no está habilitado para este negocio.`,
        module:       moduleKey,
        restrictedBy,
        origin,
      });
      return;
    }

    next();
  };
}
