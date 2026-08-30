/**
 * @file context.row-validation.ts
 * @description Validación de la FORMA de la fila que devuelve
 * `PlatformRepository.getContextInputs()`, ANTES de construir
 * `RawContextInputs`.
 *
 * ## Protocolo — validación de filas SQL antes del mapeo
 *
 * Distingue explícitamente cuatro casos por columna y **nunca** usa un
 * default silencioso (`?? []`, `?? ''`, `?? false`, `?? null`) para taparlos:
 *
 * | caso | qué es | qué se hace acá |
 * |---|---|---|
 * | columna ausente del resultado | cambió el `SELECT` / un alias / el schema | `ContextDataError` |
 * | presente, `NULL` permitido | parte del contrato | se conserva `null` |
 * | presente, `NULL` no permitido | dato corrupto o query rota | `ContextDataError` |
 * | presente, valor fuera de tipo/dominio (enums, fecha) | lo valida el ADAPTADOR | — (pasa) |
 *
 * ## Tabla de nulabilidad esperada (Bloque 4A)
 *
 * | Campo | `NULL` permitido | Columna/campo ausente | `NULL` inesperado |
 * |---|:--:|---|---|
 * | `plan`                       | No  | `ContextDataError` | `ContextDataError` |
 * | `industry_key`              | Sí  | `ContextDataError` | se conserva `null` |
 * | `industry_name`            | Sí  | `ContextDataError` | se conserva `null` |
 * | `catalog`                    | No  | `ContextDataError` | `ContextDataError` |
 * | `industry_capabilities`     | No  | `ContextDataError` | `ContextDataError` |
 * | `business_modules`          | No  | `ContextDataError` | `ContextDataError` |
 * | `terminology_rows`         | No  | `ContextDataError` | `ContextDataError` |
 * | catálogo[].`moduleKey`      | No  | `ContextDataError` | `ContextDataError` |
 * | catálogo[].`active`         | No  | `ContextDataError` | `ContextDataError` |
 * | catálogo[].`implemented`    | No  | `ContextDataError` | `ContextDataError` |
 * | catálogo[].`contextColor`   | No  | `ContextDataError` | `ContextDataError` (enum: adaptador) |
 * | catálogo[].`deletedAt`      | Sí  | `ContextDataError` | se conserva `null` (parse: adaptador) |
 * | catálogo[].`minPlan`        | Sí  | `ContextDataError` | se conserva `null` |
 * | catálogo[].`sortOrder`      | No  | `ContextDataError` | `ContextDataError` |
 * | business_modules[].`moduleKey` | No | `ContextDataError` | `ContextDataError` |
 * | business_modules[].`enabled`   | No | `ContextDataError` | `ContextDataError` |
 * | business_modules[].`source`    | No | `ContextDataError` | `ContextDataError` (enum: adaptador) |
 *
 * Los `NULL` permitidos son parte del contrato y se conservan. Las columnas
 * ausentes y los `NULL` no permitidos son errores de datos o de forma —
 * nunca un valor por defecto silencioso.
 */

import { ContextDataError } from './context.errors.js';
import type {
  RawContextInputs,
  RawModuleCatalogRow,
  IndustryCapabilityRow,
  BusinessModuleRow,
  TerminologyRow,
} from './business-context.types.js';

function has(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function asObject(v: unknown, ctx: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new ContextDataError(`getContextInputs: ${ctx} no es un objeto (${v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v})`);
  }
  return v as Record<string, unknown>;
}

/** Presente + no `NULL` + del tipo primitivo esperado. */
function requiredPrimitive(o: Record<string, unknown>, key: string, type: 'string' | 'boolean' | 'number', ctx: string): void {
  if (!has(o, key)) throw new ContextDataError(`getContextInputs: falta "${key}" en ${ctx} (¿cambió el SELECT / json_build_object / el schema?)`);
  if (o[key] === null) throw new ContextDataError(`getContextInputs: ${ctx}.${key} vino NULL y no está permitido`);
  if (typeof o[key] !== type) throw new ContextDataError(`getContextInputs: ${ctx}.${key} no es ${type} (${typeof o[key]})`);
}

/** Presente; `NULL` permitido; si no es `NULL`, del tipo esperado. */
function nullablePrimitive(o: Record<string, unknown>, key: string, type: 'string' | 'number', ctx: string): void {
  if (!has(o, key)) throw new ContextDataError(`getContextInputs: falta "${key}" en ${ctx} (¿cambió el SELECT / json_build_object / el schema?)`);
  if (o[key] !== null && typeof o[key] !== type) throw new ContextDataError(`getContextInputs: ${ctx}.${key} no es ${type}|null (${typeof o[key]})`);
}

/** Presente; no `NULL` (el `COALESCE(...,'[]')` lo garantiza); array. */
function requiredArray(o: Record<string, unknown>, key: string): unknown[] {
  if (!has(o, key)) throw new ContextDataError(`getContextInputs: falta la columna "${key}" en el resultado (¿cambió el SELECT/alias?)`);
  if (o[key] === null) throw new ContextDataError(`getContextInputs: ${key} vino NULL — el COALESCE(...,'[]'::json) debería impedirlo`);
  if (!Array.isArray(o[key])) throw new ContextDataError(`getContextInputs: ${key} no es un array (${typeof o[key]})`);
  return o[key] as unknown[];
}

/**
 * Valida la FORMA de la fila cruda y devuelve el tipo estricto
 * `RawContextInputs`. Los enums (`source`, `contextColor`), el parseo de
 * `deletedAt` y la validez de `plan` como `BusinessPlan` los valida el
 * adaptador (`buildContextPayloadCore`).
 *
 * @throws {ContextDataError} ante columna ausente, `NULL` no permitido,
 *   colección no-array, o item de colección con campos obligatorios ausentes.
 */
export function assertContextRowShape(raw: unknown): RawContextInputs {
  const row = asObject(raw, 'la fila');

  // Columnas top-level: presencia primero (detecta alias/SELECT cambiados).
  for (const col of [
    'plan', 'industry_key', 'industry_name',
    'catalog', 'industry_capabilities', 'business_modules', 'terminology_rows',
  ]) {
    if (!has(row, col)) {
      throw new ContextDataError(`getContextInputs: falta la columna "${col}" en el resultado (¿cambió el SELECT/alias?)`);
    }
  }

  // plan: NOT NULL, string.
  if (row['plan'] === null) throw new ContextDataError('getContextInputs: businesses.plan vino NULL (NOT NULL en el schema)');
  if (typeof row['plan'] !== 'string') throw new ContextDataError(`getContextInputs: plan no es string (${typeof row['plan']})`);

  // industry_key / industry_name: NULL permitido (contrato); si no es NULL, string.
  nullablePrimitive(row, 'industry_key', 'string', 'fila');
  nullablePrimitive(row, 'industry_name', 'string', 'fila');

  // Agregados: NOT NULL + array.
  const catalog     = requiredArray(row, 'catalog');
  const industryCap = requiredArray(row, 'industry_capabilities');
  const businessMod = requiredArray(row, 'business_modules');
  const termRows    = requiredArray(row, 'terminology_rows');

  // Forma de cada item del catálogo (claves obligatorias; el dominio del
  // color y el parseo de la fecha van en el adaptador).
  catalog.forEach((item, i) => {
    const m = asObject(item, `catalog[${i}]`);
    requiredPrimitive(m, 'moduleKey', 'string', `catalog[${i}]`);
    requiredPrimitive(m, 'active', 'boolean', `catalog[${i}]`);
    requiredPrimitive(m, 'implemented', 'boolean', `catalog[${i}]`);
    requiredPrimitive(m, 'sortOrder', 'number', `catalog[${i}]`);
    if (!has(m, 'contextColor')) throw new ContextDataError(`getContextInputs: catalog[${i}] sin "contextColor"`);
    if (m['contextColor'] === null) throw new ContextDataError(`getContextInputs: catalog[${i}].contextColor NULL (NOT NULL DEFAULT 'NEUTRAL')`);
    if (typeof m['contextColor'] !== 'string') throw new ContextDataError(`getContextInputs: catalog[${i}].contextColor no es string`);
    nullablePrimitive(m, 'deletedAt', 'string', `catalog[${i}]`);   // NULL permitido; string se parsea en el adaptador
    nullablePrimitive(m, 'minPlan', 'string', `catalog[${i}]`);      // NULL permitido
  });

  industryCap.forEach((item, i) => {
    const ic = asObject(item, `industry_capabilities[${i}]`);
    requiredPrimitive(ic, 'moduleKey', 'string', `industry_capabilities[${i}]`);
    requiredPrimitive(ic, 'enabledByDefault', 'boolean', `industry_capabilities[${i}]`);
    requiredPrimitive(ic, 'required', 'boolean', `industry_capabilities[${i}]`);
  });

  businessMod.forEach((item, i) => {
    const bm = asObject(item, `business_modules[${i}]`);
    requiredPrimitive(bm, 'moduleKey', 'string', `business_modules[${i}]`);
    requiredPrimitive(bm, 'enabled', 'boolean', `business_modules[${i}]`);
    if (!has(bm, 'source')) throw new ContextDataError(`getContextInputs: business_modules[${i}] sin "source"`);
    if (bm['source'] === null) throw new ContextDataError(`getContextInputs: business_modules[${i}].source NULL (NOT NULL DEFAULT 'SUPERADMIN')`);
    if (typeof bm['source'] !== 'string') throw new ContextDataError(`getContextInputs: business_modules[${i}].source no es string`);
  });

  termRows.forEach((item, i) => {
    const td = asObject(item, `terminology_rows[${i}]`);
    requiredPrimitive(td, 'scopeType', 'string', `terminology_rows[${i}]`);
    requiredPrimitive(td, 'scopeId', 'string', `terminology_rows[${i}]`);
    requiredPrimitive(td, 'termKey', 'string', `terminology_rows[${i}]`);
    requiredPrimitive(td, 'locale', 'string', `terminology_rows[${i}]`);
    requiredPrimitive(td, 'value', 'string', `terminology_rows[${i}]`);
  });

  // Pasó la forma. El tipo estricto es seguro para el adaptador.
  return {
    industryKey:          row['industry_key'] as string | null,
    industryName:         row['industry_name'] as string | null,
    plan:                 row['plan'] as string,
    catalog:              catalog as RawModuleCatalogRow[],
    industryCapabilities: industryCap as IndustryCapabilityRow[],
    businessModules:      businessMod as BusinessModuleRow[],
    terminologyRows:      termRows as TerminologyRow[],
  };
}
