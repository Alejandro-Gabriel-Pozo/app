/**
 * @file plan-limits.ts
 * @description Límites de uso por plan de suscripción.
 *
 * Estos valores se leen en CategoryService (maxCategories -- maxResources
 * está en la interfaz pero ningún service lo aplica todavía, gap
 * preexistente sin relación con este cambio) y, desde el 17/08/2026 (F2,
 * pendientes-2026-08-17.md), en api/routes/users.routes.ts
 * (maxActiveMemberships/allowedRoleNames) para rechazar operaciones que
 * superen el plan del negocio.
 *
 * Simplificación deliberada (F3, misma fecha): esto sigue siendo una
 * constante en código, no una tabla editable por el superadmin sin
 * deploy -- mismo criterio que ya tenía maxCategories/maxResources. Migrar
 * TODO esto a la BD de plataforma es un lift más grande (schema nuevo +
 * endpoint de admin) que se evaluó y se decidió no hacer en esta ronda.
 *
 * PRO usa Infinity para evitar comparaciones especiales en el código.
 */

import { BusinessPlan } from '../types/enums.js';

export interface PlanLimits {
  maxCategories: number;  // máximo de resource_categories activas
  maxResources: number;   // máximo de resources activos
  /** Máximo de memberships ACTIVAS que no sean OWNER (el owner es estructural, no ocupa asiento) -- api/routes/users.routes.ts POST /users. */
  maxActiveMemberships: number;
  /** `roles.name` que este plan puede asignar a una membership vía POST/PUT /users. 'ALL' = sin restricción. OWNER nunca pasa por acá (no se asigna desde esta API). */
  allowedRoleNames: readonly string[] | 'ALL';
}

export const PLAN_LIMITS: Record<BusinessPlan, PlanLimits> = {
  [BusinessPlan.FREE]: {
    maxCategories: 1,
    maxResources: 5,
    maxActiveMemberships: 1,
    allowedRoleNames: ['ADMIN'],
  },
  [BusinessPlan.STARTER]: {
    maxCategories: 3,
    maxResources: 20,
    maxActiveMemberships: 5,
    allowedRoleNames: ['ADMIN', 'RECEPTIONIST', 'HOUSEKEEPING', 'WAITER'],
  },
  [BusinessPlan.PRO]: {
    maxCategories: Infinity,
    maxResources: Infinity,
    maxActiveMemberships: Infinity,
    allowedRoleNames: 'ALL',
  },
};
