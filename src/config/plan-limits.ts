/**
 * @file plan-limits.ts
 * @description Límites de uso por plan de suscripción.
 *
 * Estos valores se leen en CategoryService y ResourceService para
 * rechazar operaciones que superen el plan del negocio.
 *
 * PRO usa Infinity para evitar comparaciones especiales en el código.
 */

import { BusinessPlan } from '../types/enums.js';

export interface PlanLimits {
  maxCategories: number;  // máximo de resource_categories activas
  maxResources: number;   // máximo de resources activos
}

export const PLAN_LIMITS: Record<BusinessPlan, PlanLimits> = {
  [BusinessPlan.FREE]: {
    maxCategories: 1,
    maxResources: 5,
  },
  [BusinessPlan.STARTER]: {
    maxCategories: 3,
    maxResources: 20,
  },
  [BusinessPlan.PRO]: {
    maxCategories: Infinity,
    maxResources: Infinity,
  },
};
