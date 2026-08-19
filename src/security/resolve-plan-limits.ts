/**
 * @file resolve-plan-limits.ts
 * @description Resuelve plan + límites de un negocio contra la BD de
 * plataforma, con el mismo contrato de error 503 PLATFORM_UNAVAILABLE que
 * ya usan `requireModule`/`requirePlan` (Fase 3, docs/auditoria-modularidad.md,
 * hallazgo DRY-3) — pero no es un middleware de gate: los tres call sites
 * (`categories.routes.ts`, `users.routes.ts` POST y PUT) necesitan los
 * VALORES de `plan`/`limits` para su propia lógica después (chequear
 * `allowedRoleNames`, `maxActiveMemberships`, etc.), no solo pasar o
 * cortar la cadena — por eso es una función que se llama adentro del
 * handler, no un middleware de Express en la firma de la ruta.
 *
 * Ya envió la respuesta 503 y devolvió `null` en caso de falla — el call
 * site solo tiene que chequear `if (!resolved) return;`.
 */

import type { Response } from 'express';
import type { AppContainer } from '../container.js';
import type { BusinessPlan } from '../types/enums.js';
import type { PlanLimits } from '../config/plan-limits.js';

export async function resolvePlanLimits(
  container: AppContainer,
  res: Response,
  businessId: string,
): Promise<{ plan: BusinessPlan; limits: PlanLimits } | null> {
  try {
    const plan   = await container.getBusinessPlan(businessId);
    const limits = await container.getPlanLimits(plan);
    return { plan, limits };
  } catch {
    res.status(503).json({
      code:    'PLATFORM_UNAVAILABLE',
      message: 'No se pudo verificar el plan del negocio. Reintentá en unos segundos.',
    });
    return null;
  }
}
