/**
 * @file context.adapter.ts
 * @description Read path del Business Context — Fase 4 Bloque 4A.
 *
 * Composición IMPURA y delgada: toma las filas que devuelve
 * `PlatformRepository.getContextInputs()` y las pasa por los dos resolvers
 * PUROS (`capability.resolver`, `terminology.resolver`). No hace I/O propio
 * más allá de llamar a la fuente inyectada.
 *
 * ## Qué NO hace este bloque (4A)
 *
 * - No lee `req.db` (`business_profile` -> `currency`/`timezone`) ni
 *   `req.user` (`permissionGroups`). Esos tres campos los agrega la RUTA del
 *   Bloque 4B. Por eso la salida es `ContextPayloadCore`, no el payload HTTP
 *   completo.
 * - No monta ninguna ruta, no toca `getBusinessModules()` ni el gate de
 *   módulos (402).
 *
 * ## Decisiones fijadas
 *
 * 1. `deletedAt` llega como **string ISO** desde `json_build_object`; se
 *    normaliza acá, explícito, a `Date | null` antes del resolver.
 * 2. Negocio inexistente -> `getContextInputs()` devuelve `null` y esta
 *    función propaga `null`. La traducción a `404 BUSINESS_NOT_FOUND` es de
 *    la ruta (4B). Nunca un `Error` genérico para eso.
 * 4. `businesses.plan` es `VARCHAR(50)` sin CHECK: se valida contra
 *    `BusinessPlan` y, si es desconocido, se lanza `ContextDataError`
 *    (fail-closed: se surfacea, no se sirve un contexto quizá-incorrecto).
 *    No se hace `as BusinessPlan` a ciegas ni `?? FREE`.
 */

import { BusinessPlan } from '../types/enums.js';
import {
  resolveCapabilities,
  enabledModuleKeys,
  moduleSources,
  moduleColors,
} from './capability.resolver.js';
import { resolveTerminology } from './terminology.resolver.js';
import { ContextDataError } from './context.errors.js';
import type {
  ContextColor,
  ContextPayloadCore,
  ModuleCatalogRow,
  ModuleSource,
  RawContextInputs,
} from './business-context.types.js';

export { ContextDataError } from './context.errors.js';

const PLANES_VALIDOS      = new Set<string>(Object.values(BusinessPlan));
const SOURCES_VALIDOS     = new Set<ModuleSource>(['PRESET', 'SUPERADMIN', 'TENANT']);
const CONTEXT_COLORS      = new Set<ContextColor>(['BRASS', 'CLAY', 'SAGE', 'NEUTRAL']);

/** Fuente de las filas de plataforma. Interfaz mínima -> el adaptador no
 *  depende de `PlatformRepository` entero (testeable con un fake trivial). */
export interface ContextInputsSource {
  getContextInputs(
    businessId: string,
    locale: string,
  ): Promise<RawContextInputs | null>;
}

/**
 * Parte PURA: filas crudas -> `ContextPayloadCore`. Exportada para poder
 * probar la composición sin fuente.
 *
 * Valida en el borde (`json_build_object` no tipa nada): `plan` contra
 * `BusinessPlan` (la columna no tiene CHECK), y `source` / `contextColor`
 * contra su enum como defensa en profundidad además de los CHECK de la base
 * (`business_modules_source_valido`, `modules_context_color_valido`).
 * `deletedAt` se normaliza a `Date | null` y se rechaza si no parsea.
 * Cualquier violación -> `ContextDataError` (fail-closed). Ningún cast
 * silencioso.
 *
 * @throws {ContextDataError}
 */
export function buildContextPayloadCore(
  businessId: string,
  raw: RawContextInputs,
  locale: string,
): ContextPayloadCore {
  if (raw.plan == null || !PLANES_VALIDOS.has(raw.plan)) {
    throw new ContextDataError(
      `businesses.plan = ${JSON.stringify(raw.plan)} para "${businessId}" no es un BusinessPlan conocido`,
    );
  }
  const plan = raw.plan as BusinessPlan;   // recién acá, ya validado

  // Decisión 1: normalización EXPLÍCITA de deletedAt (string ISO | null) -> (Date | null),
  // con rechazo si el string no es una fecha válida (nunca un `Invalid Date` al resolver).
  const catalog: ModuleCatalogRow[] = raw.catalog.map((m) => {
    if (!CONTEXT_COLORS.has(m.contextColor)) {
      throw new ContextDataError(
        `modules.context_color = ${JSON.stringify(m.contextColor)} (módulo ${m.moduleKey}) fuera del enum`,
      );
    }
    let deletedAt: Date | null = null;
    if (m.deletedAt !== null) {
      const d = new Date(m.deletedAt);
      if (Number.isNaN(d.getTime())) {
        throw new ContextDataError(
          `modules.deleted_at = ${JSON.stringify(m.deletedAt)} (módulo ${m.moduleKey}) no es una fecha válida`,
        );
      }
      deletedAt = d;
    }
    return { ...m, deletedAt };
  });

  for (const bm of raw.businessModules) {
    if (!SOURCES_VALIDOS.has(bm.source)) {
      throw new ContextDataError(
        `business_modules.source = ${JSON.stringify(bm.source)} (módulo ${bm.moduleKey}) fuera del enum`,
      );
    }
  }

  const capacidades = resolveCapabilities({
    plan,
    industryKey:          raw.industryKey,
    catalog,
    industryCapabilities: raw.industryCapabilities,
    businessModules:      raw.businessModules,
  });

  const terminology = resolveTerminology({
    businessId,
    industryKey: raw.industryKey,
    locale,
    rows:        raw.terminologyRows,
  });

  return {
    businessId,
    industryKey:    raw.industryKey,
    industryName:   raw.industryName,
    enabledModules: enabledModuleKeys(capacidades),
    moduleSources:  moduleSources(capacidades),
    moduleColors:   moduleColors(capacidades),
    terminology,
    locale,
  };
}

/**
 * Parte IMPURA: lee de la fuente y compone. Devuelve `null` si el negocio no
 * existe (decisión 2). `locale` fijo en `es-AR` (D6) salvo que el caller
 * pida otro.
 */
export async function loadBusinessContextCore(
  businessId: string,
  source: ContextInputsSource,
  locale = 'es-AR',
): Promise<ContextPayloadCore | null> {
  const raw = await source.getContextInputs(businessId, locale);
  if (raw === null) return null;
  return buildContextPayloadCore(businessId, raw, locale);
}
