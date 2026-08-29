/**
 * @file terminology.resolver.ts
 * @description Cascada de terminología del Business Context (Fase 4).
 * Función PURA, mismo criterio que `capability.resolver.ts`.
 *
 * ```text
 * TENANT(businessId) -> INDUSTRY(industryKey) -> SYSTEM('') -> la clave misma
 * ```
 *
 * El último escalón es a propósito: una pantalla nunca se rompe por un
 * término que falte (§5.3).
 *
 * ## La trampa del centinela
 *
 * `terminology_defaults.scope_id` es `VARCHAR NOT NULL DEFAULT ''`. El scope
 * SYSTEM usa **cadena vacía**, no `NULL`, porque una PRIMARY KEY de Postgres
 * no admite nulos — está documentado en `platform.schema.sql` y amarrado con
 * el CHECK `terminology_defaults_scope_valido`.
 *
 * Consecuencia para quien lea la tabla: filtrar por `scope_id IS NULL`
 * devuelve **cero filas en silencio** y la cascada cae hasta la clave sin que
 * nadie vea un error. Este resolver compara contra `''`, y hay un test que lo
 * fija.
 *
 * ## `locale`
 *
 * D6: el producto queda en `es-AR`. Una sola pasada con el locale pedido, sin
 * selector de idioma y **sin fallback entre locales** — una fila en otro
 * locale no se usa como reemplazo.
 */

import type {
  TerminologyResolutionInput,
  TerminologyRow,
} from './business-context.types.js';

/** Centinela de `scope_id` para el scope SYSTEM. Nunca `null`. */
export const SCOPE_ID_SISTEMA = '';

/**
 * Precedencia: el índice más bajo gana. Se usa para elegir entre varias
 * filas que compiten por la misma clave.
 */
const PRECEDENCIA: Record<TerminologyRow['scopeType'], number> = {
  TENANT:   0,
  INDUSTRY: 1,
  SYSTEM:   2,
};

/**
 * ¿Esta fila le corresponde a este negocio?
 *
 * Una fila TENANT de OTRO negocio, o INDUSTRY de otro rubro, no participa.
 * Con `industryKey === null` el escalón INDUSTRY se omite entero: no se
 * infiere ningún rubro (§5.5.3).
 */
function filaAplica(fila: TerminologyRow, input: TerminologyResolutionInput): boolean {
  if (fila.locale !== input.locale) return false;

  switch (fila.scopeType) {
    case 'TENANT':   return fila.scopeId === input.businessId;
    case 'INDUSTRY': return input.industryKey !== null && fila.scopeId === input.industryKey;
    case 'SYSTEM':   return fila.scopeId === SCOPE_ID_SISTEMA;
  }
}

/**
 * Resuelve todos los términos conocidos para este negocio.
 *
 * Devuelve un `Record<termKey, value>` con una entrada por clave que exista
 * en alguno de los escalones aplicables. **No** inyecta pares clave→clave
 * para términos que no existen: eso llenaría el payload de ruido. El
 * fallback a la clave lo hace `resolveTerm()`, y en el frontend
 * `useTermino(clave, fallback)`.
 */
export function resolveTerminology(
  input: TerminologyResolutionInput,
): Record<string, string> {
  const ganadora = new Map<string, TerminologyRow>();

  for (const fila of input.rows) {
    if (!filaAplica(fila, input)) continue;

    const actual = ganadora.get(fila.termKey);
    if (actual === undefined || PRECEDENCIA[fila.scopeType] < PRECEDENCIA[actual.scopeType]) {
      ganadora.set(fila.termKey, fila);
    }
  }

  const terminos: Record<string, string> = {};
  for (const [clave, fila] of ganadora) terminos[clave] = fila.value;
  return terminos;
}

/**
 * Un término, con el último escalón de la cascada aplicado: si no hay
 * ninguna fila para esa clave, devuelve **la clave misma**. Nunca lanza y
 * nunca devuelve vacío.
 */
export function resolveTerm(
  input: TerminologyResolutionInput,
  termKey: string,
): string {
  return resolveTerminology(input)[termKey] ?? termKey;
}
