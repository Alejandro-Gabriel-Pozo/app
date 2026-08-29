/**
 * @file capability.resolver.ts
 * @description Cascada de capacidades efectivas del Business Context
 * (Fase 4). Función PURA: recibe filas ya leídas, devuelve el resultado.
 *
 * ## La cascada, en orden
 *
 * ```text
 * 1. system defaults              -> FALSE (fail-closed, ya vigente)
 * 2. industry preset              -> sólo si industryKey !== null
 * 3. tenant overrides             -> business_modules, si hay fila
 * 4. límites del plan             -> modules.min_plan vs businesses.plan
 * 5. capacidades active/implemented/deleted_at
 * ```
 *
 * **Los escalones 1–3 y los 4–5 NO son la misma clase de cosa**, y la
 * diferencia es deliberada:
 *
 * - **1 a 3 son DEFAULTS**: cada uno pisa al anterior, en los dos sentidos.
 *   Un preset puede prender lo que el sistema dejaba apagado, y un override
 *   de tenant puede apagar lo que el preset prendió.
 * - **4 y 5 son RESTRICCIONES**: sólo pueden RESTAR. Nunca prenden nada.
 *   Que un negocio tenga plan ENTERPRISE no habilita un módulo que el dueño
 *   apagó, y que un módulo esté `implemented` no lo prende solo.
 *
 * Si las restricciones pudieran prender, subir de plan encendería módulos
 * que alguien apagó a propósito.
 *
 * ## Por qué esto todavía no está cableado
 *
 * `PlatformRepository.getBusinessModules()` implementa hoy los escalones 1 y
 * 3 solamente. Meter esta cascada ahí adentro cambiaría `requireModule()` y
 * con eso el 402 de todas las rutas con gate: una lectura se volvería un
 * cambio de autorización. El cableado es un bloque posterior y con su propia
 * verificación — ver `equivaleAGetBusinessModules()` más abajo, que existe
 * justamente para demostrar que hoy el cambio sería inerte.
 */

import { BusinessPlan } from '../types/enums.js';
import type {
  CapabilityResolutionInput,
  CapabilityRestriction,
  EffectiveCapability,
  ModuleCatalogRow,
} from './business-context.types.js';

/**
 * Orden de los planes, de menor a mayor. Es el único lugar del resolver que
 * sabe que los planes están ordenados; si mañana se agrega uno, se agrega
 * acá y nada más cambia.
 */
const ORDEN_DE_PLAN: readonly BusinessPlan[] = [
  BusinessPlan.FREE,
  BusinessPlan.STARTER,
  BusinessPlan.PRO,
  BusinessPlan.ENTERPRISE,
];

function rangoDePlan(plan: string): number {
  return ORDEN_DE_PLAN.indexOf(plan as BusinessPlan);
}

/**
 * ¿El plan del negocio alcanza el `min_plan` del módulo?
 *
 * `min_plan` es `VARCHAR(20)` sin CHECK en la base, así que puede contener
 * un valor que no es un plan. En ese caso se resuelve **fail-closed**: no se
 * puede probar que el negocio califica, así que no califica. Es la misma
 * doctrina que `getBusinessModules()` ya aplica para un módulo sin fila.
 *
 * Fail-closed acá significa que un typo en `min_plan` APAGA el módulo en vez
 * de ignorarse. Es ruidoso a propósito: preferimos que se note.
 */
function elPlanAlcanza(planDelNegocio: BusinessPlan, minPlan: string | null): boolean {
  if (minPlan === null || minPlan === '') return true;

  const requerido = rangoDePlan(minPlan);
  if (requerido === -1) return false;          // min_plan desconocido -> fail-closed

  const propio = rangoDePlan(planDelNegocio);
  if (propio === -1) return false;             // plan desconocido -> fail-closed

  return propio >= requerido;
}

/**
 * Primera restricción que aplica, o `null`. El orden importa sólo para
 * REPORTAR el motivo — las cuatro apagan igual.
 */
function restriccionQueAplica(
  modulo: ModuleCatalogRow,
  plan: BusinessPlan,
): CapabilityRestriction | null {
  if (modulo.deletedAt !== null)  return 'DELETED';
  if (!modulo.active)             return 'NOT_ACTIVE';
  if (!modulo.implemented)        return 'NOT_IMPLEMENTED';
  if (!elPlanAlcanza(plan, modulo.minPlan)) return 'MIN_PLAN';
  return null;
}

/**
 * Resuelve la capacidad efectiva de cada módulo del catálogo.
 *
 * Devuelve UNA entrada por fila de `catalog`, incluidas las restringidas
 * (con `enabled: false` y `restrictedBy` explicando por qué). El consumidor
 * decide si las muestra: Superadmin necesita ver "apagada porque no está
 * implementada", el shell del tenant no.
 *
 * El orden de salida sigue `sortOrder` y desempata por `moduleKey`, para que
 * el resultado sea estable entre corridas. Hoy los 6 módulos comparten
 * `sortOrder = 100`, así que en la práctica ordena alfabéticamente — el
 * desempate existe justamente para que eso sea determinista y no dependa del
 * orden en que Postgres devolvió las filas.
 */
export function resolveCapabilities(
  input: CapabilityResolutionInput,
): EffectiveCapability[] {
  const { plan, industryKey, catalog, industryCapabilities, businessModules } = input;

  const presetPorModulo = new Map(
    industryCapabilities.map((fila) => [fila.moduleKey, fila]),
  );
  const overridePorModulo = new Map(
    businessModules.map((fila) => [fila.moduleKey, fila]),
  );

  const resueltas = catalog.map((modulo): EffectiveCapability => {
    // ── Escalones 1 a 3: defaults, cada uno pisa al anterior ──────────
    let enabled = false;                                   // 1. system default
    let origin: EffectiveCapability['origin'] = 'SYSTEM_DEFAULT';

    // 2. Preset del rubro. Se OMITE entero si el negocio no está
    //    clasificado: `industryKey === null` no se infiere ni se cae a
    //    'GENERIC' (§5.5.3, D1).
    if (industryKey !== null) {
      const preset = presetPorModulo.get(modulo.moduleKey);
      if (preset !== undefined) {
        enabled = preset.enabledByDefault;
        origin  = 'INDUSTRY_PRESET';
      }
    }

    // 3. Override del tenant. Gana sobre el preset, en los dos sentidos.
    const override = overridePorModulo.get(modulo.moduleKey);
    if (override !== undefined) {
      enabled = override.enabled;
      origin  = 'TENANT_OVERRIDE';
    }

    // ── Escalones 4 y 5: restricciones, sólo restan ───────────────────
    const restriccion = enabled ? restriccionQueAplica(modulo, plan) : null;
    if (restriccion !== null) enabled = false;

    return {
      moduleKey:    modulo.moduleKey,
      enabled,
      origin,
      restrictedBy: restriccion,
      source:       override?.source ?? null,
      contextColor: modulo.contextColor,
    };
  });

  return resueltas.sort(
    (a, b) => {
      const porOrden = ordenDe(catalog, a.moduleKey) - ordenDe(catalog, b.moduleKey);
      return porOrden !== 0 ? porOrden : a.moduleKey.localeCompare(b.moduleKey);
    },
  );
}

function ordenDe(catalog: readonly ModuleCatalogRow[], moduleKey: string): number {
  return catalog.find((m) => m.moduleKey === moduleKey)?.sortOrder ?? 0;
}

// ---------------------------------------------------------------------------
// Proyecciones para los consumidores
// ---------------------------------------------------------------------------

/** Las claves habilitadas, para `BusinessContext.enabledModules`. */
export function enabledModuleKeys(capacidades: readonly EffectiveCapability[]): string[] {
  return capacidades.filter((c) => c.enabled).map((c) => c.moduleKey);
}

/**
 * `Record<moduleKey, ContextColor>` — lo que reemplaza a `navigation` en el
 * payload (decisión D-A, 29/08/2026). El backend dice qué color le
 * corresponde a cada módulo; las rutas, los iconos y `managementOnly` siguen
 * siendo del catálogo de presentación del frontend.
 *
 * Se emite para TODOS los módulos del catálogo, no sólo los habilitados: el
 * color de un módulo no depende de si está prendido.
 */
export function moduleColors(
  capacidades: readonly EffectiveCapability[],
): Record<string, string> {
  const colores: Record<string, string> = {};
  for (const c of capacidades) colores[c.moduleKey] = c.contextColor;
  return colores;
}

/** `moduleSources` de §5.4 — sólo los módulos que tienen override de tenant. */
export function moduleSources(
  capacidades: readonly EffectiveCapability[],
): Record<string, string> {
  const fuentes: Record<string, string> = {};
  for (const c of capacidades) if (c.source !== null) fuentes[c.moduleKey] = c.source;
  return fuentes;
}

// ---------------------------------------------------------------------------
// Equivalencia con el comportamiento vigente — la prueba del Bloque 1
// ---------------------------------------------------------------------------

/**
 * Proyecta el resultado a la MISMA forma que devuelve hoy
 * `PlatformRepository.getBusinessModules()`: `Record<moduleKey, boolean>`
 * con una entrada por módulo del catálogo.
 *
 * Existe para comparar, no para consumir.
 */
export function comoRecordDeModulos(
  capacidades: readonly EffectiveCapability[],
): Record<string, boolean> {
  const modulos: Record<string, boolean> = {};
  for (const c of capacidades) modulos[c.moduleKey] = c.enabled;
  return modulos;
}

/**
 * Bajo qué condiciones esta cascada da EXACTAMENTE lo mismo que
 * `getBusinessModules()`.
 *
 * `getBusinessModules()` implementa hoy los escalones 1 y 3, y nada más:
 *
 * ```ts
 * modules[moduleKey] = enabledByKey.get(moduleKey) ?? false
 * ```
 *
 * Así que los dos coinciden si y sólo si los escalones 2, 4 y 5 son inertes:
 *
 * | Escalón | Inerte cuando |
 * |---|---|
 * | 2 — preset de rubro | `industryKey === null` |
 * | 4 — `min_plan`      | ningún módulo tiene `min_plan` |
 * | 5 — active/impl.    | los módulos están activos, implementados y sin borrar |
 *
 * **Devolver `true` acá NO es una garantía permanente.** Es una foto de los
 * datos que se le pasaron. El día que un negocio tenga rubro, o alguien
 * ponga `implemented = FALSE`, esta función devuelve `false` y ahí la
 * divergencia es REAL y buscada — es exactamente el cambio de comportamiento
 * que el bloque de cableado tiene que decidir a propósito, no heredar.
 */
export function equivaleAGetBusinessModules(
  input: CapabilityResolutionInput,
): { equivalente: boolean; motivos: string[] } {
  const motivos: string[] = [];

  if (input.industryKey !== null) {
    motivos.push(
      `el negocio tiene rubro (${input.industryKey}): el escalón de preset interviene`,
    );
  }

  const conMinPlan = input.catalog.filter((m) => m.minPlan !== null && m.minPlan !== '');
  if (conMinPlan.length > 0) {
    motivos.push(
      `${conMinPlan.length} módulo(s) con min_plan: ${conMinPlan.map((m) => m.moduleKey).join(', ')}`,
    );
  }

  const restringibles = input.catalog.filter(
    (m) => !m.active || !m.implemented || m.deletedAt !== null,
  );
  if (restringibles.length > 0) {
    motivos.push(
      `${restringibles.length} módulo(s) inactivos/no implementados/borrados: ` +
      restringibles.map((m) => m.moduleKey).join(', '),
    );
  }

  return { equivalente: motivos.length === 0, motivos };
}
