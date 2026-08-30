/**
 * @file business-context.types.ts
 * @description Formas de entrada y salida de los resolvers del Business
 * Context (Fase 4). Tipos locales al módulo a propósito: hoy los importa
 * sólo `src/business-context/`, así que no van a `src/types/`, que queda
 * para lo genuinamente transversal (convención de `app-main/CLAUDE.md`).
 *
 * Los resolvers son FUNCIONES PURAS: reciben filas ya leídas y devuelven el
 * resultado. No conocen Express, ni `pg`, ni repositorios. Eso es lo que
 * permite probar la cascada entera sin base y, en el Bloque 1, demostrar
 * que no cambia nada de lo vigente antes de cablearla a nada.
 */

import type { BusinessPlan } from '../types/enums.js';

/**
 * Color de contexto del módulo. Enum CERRADO, espejo del CHECK
 * `modules_context_color_valido` en `platform.schema.sql`.
 *
 * El cian NO está y no es asignable: queda reservado al plano técnico
 * (decisión visual del dueño, criterio 12).
 */
export type ContextColor = 'BRASS' | 'CLAY' | 'SAGE' | 'NEUTRAL';

/** `business_modules.source` — de dónde vino la fila del override. */
export type ModuleSource = 'PRESET' | 'SUPERADMIN' | 'TENANT';

/**
 * Qué escalón de la cascada FIJÓ el valor. No es lo mismo que `source`:
 * `source` dice quién escribió la fila de `business_modules`; `origin` dice
 * cuál de los tres escalones de default terminó ganando.
 */
export type CapabilityOrigin =
  | 'SYSTEM_DEFAULT'    // nadie dijo nada -> FALSE (fail-closed)
  | 'INDUSTRY_PRESET'   // lo prendió/apagó el preset del rubro
  | 'TENANT_OVERRIDE';  // hay fila en business_modules

/**
 * Qué RESTRICCIÓN apagó una capacidad que los defaults habían prendido.
 * `null` = ninguna restricción intervino.
 */
export type CapabilityRestriction =
  | 'MIN_PLAN'          // modules.min_plan por encima del plan del negocio
  | 'NOT_ACTIVE'        // modules.active = FALSE
  | 'NOT_IMPLEMENTED'   // modules.implemented = FALSE (catalogada, sin código)
  | 'DELETED';          // modules.deleted_at NOT NULL

/** Fila del catálogo `modules`, tal como la lee el resolver. */
export interface ModuleCatalogRow {
  moduleKey:    string;
  active:       boolean;
  implemented:  boolean;
  deletedAt:    Date | null;
  /** `null` = sin gating por plan. */
  minPlan:      string | null;
  contextColor: ContextColor;
  sortOrder:    number;
}

/** Fila de `industry_capabilities` — el preset del rubro. */
export interface IndustryCapabilityRow {
  moduleKey:        string;
  enabledByDefault: boolean;
  required:         boolean;
}

/** Fila de `business_modules` — el override del tenant. */
export interface BusinessModuleRow {
  moduleKey: string;
  enabled:   boolean;
  source:    ModuleSource;
}

/** Entrada del resolver de capacidades. */
export interface CapabilityResolutionInput {
  /** Plan del negocio (`businesses.plan`), para el escalón de `min_plan`. */
  plan: BusinessPlan;
  /**
   * `businesses.industry_key`. `null` = negocio SIN CLASIFICAR, distinto de
   * `'GENERIC'`: con `null` se OMITE el escalón de rubro y no se infiere
   * ninguno (§5.5.3, decisión D1 del dueño).
   */
  industryKey: string | null;
  catalog:              readonly ModuleCatalogRow[];
  industryCapabilities: readonly IndustryCapabilityRow[];
  businessModules:      readonly BusinessModuleRow[];
}

/** Una capacidad ya resuelta, con el porqué. */
export interface EffectiveCapability {
  moduleKey:    string;
  enabled:      boolean;
  origin:       CapabilityOrigin;
  restrictedBy: CapabilityRestriction | null;
  /** `business_modules.source`, o `null` si no hay override del tenant. */
  source:       ModuleSource | null;
  /**
   * Color de contexto EFECTIVO. `modules.context_color` cuando el negocio
   * tiene rubro (`GENERIC` incluido); `NEUTRAL` para todos los módulos si
   * `industryKey === null` (sin clasificar — §5.5.3). No es el color crudo
   * del catálogo: lo resuelve `resolveCapabilities()`.
   */
  contextColor: ContextColor;
}

/** Scope de `terminology_defaults`. */
export type TerminologyScope = 'SYSTEM' | 'INDUSTRY' | 'TENANT';

/**
 * Fila de `terminology_defaults`.
 *
 * OJO con `scopeId`: en la base es `VARCHAR NOT NULL DEFAULT ''` y el scope
 * SYSTEM usa **cadena vacía** como centinela, no `NULL` — una PRIMARY KEY de
 * Postgres no admite nulos. Consultar con `NULL` devuelve cero filas EN
 * SILENCIO y la cascada cae a la clave sin que nadie se entere.
 */
export interface TerminologyRow {
  scopeType: TerminologyScope;
  scopeId:   string;
  termKey:   string;
  locale:    string;
  value:     string;
}

/** Entrada del resolver de terminología. */
export interface TerminologyResolutionInput {
  businessId:  string;
  industryKey: string | null;
  /** D6: el producto queda en `es-AR`. Una sola pasada, sin fallback entre locales. */
  locale:      string;
  rows:        readonly TerminologyRow[];
}
