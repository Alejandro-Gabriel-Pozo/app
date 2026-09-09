/**
 * @file route-enumeration.fixture.ts
 * @description Fuente única de "qué `router.<método>()` existen y si tienen
 * autz en su propia cadena o por un `router.use()` previo" -- extraído de
 * `rbac-route-coverage.test.ts` el 09/09/2026 (gate `architecture-governor`,
 * bloque 1 de RBAC-MATRIX-SECTION2-001).
 *
 * Por qué existe: la sección 2 de `docs/rbac-matriz-endpoints.md` (el cruce
 * fila-por-fila contra rutas reales, bloque 2 de RBAC-MATRIX-SECTION2-001)
 * necesita la MISMA enumeración de `(archivo, método, path interno)` que
 * `rbac-route-coverage.test.ts` ya calcula para decidir "¿tiene autz?".
 * Reimplementarla en un segundo archivo es el drift exacto que esta familia
 * de cercas existe para evitar -- dos regex en paralelo que pueden divergir
 * sin que nada avise. Un fixture no-test (no un `*.test.ts` importado, que
 * haría que Vitest re-ejecute sus `describe()` -- mismo motivo por el que
 * existe `public-routes.fixture.ts`) es el lugar correcto para algo que dos
 * suites comparten.
 *
 * Es una cerca eléctrica, no un parser real: mismo criterio y mismas
 * limitaciones que `rbac-matrix-sync.test.ts`/`rbac-route-coverage.test.ts`
 * (comentarios, `router.use()` encadenado). Ver el docblock de
 * `rbac-route-coverage.test.ts` para los dos límites declarados que esta
 * extracción hereda sin cambiarlos: `guardLines` es por archivo y por línea,
 * no por instancia de `Router()`; y esto no valida el orden de montaje de
 * `src/app.ts` (cubierto aparte por `api-auth-gate-order.test.ts`).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface RouteCall {
  /** Ruta relativa a `src/`, separadores '/'. */
  file: string;
  /** GET, POST, PUT, PATCH o DELETE. */
  method: string;
  /** Path interno tal como aparece como primer string literal de
   *  `router.<método>(...)`. `'?'` si no se pudo extraer un literal. */
  path: string;
  /** Línea 1-indexada de la llamada `router.<método>(` en el archivo. */
  line: number;
  /** Texto entre el cierre de la llamada y el inicio del handler (o hasta
   *  800 caracteres) -- la cadena de middlewares de esa ruta. */
  chain: string;
  /** `AUTHZ_RE` matchea dentro de `chain` -- autz en la propia cadena. */
  hasInlineAuthz: boolean;
  /** Un `router.use(...)` con `AUTHZ_RE` en su cadena aparece ANTES de esta
   *  llamada en el mismo archivo -- autz heredada del guard del router. */
  coveredByPriorUse: boolean;
}

const METHODS = 'get|post|put|patch|delete';
const CALL_RE = new RegExp(String.raw`\brouter\.(${METHODS})\s*\(`, 'g');
const USE_RE = /\brouter\.use\s*\(/g;
/** Inicio de la función handler → marca el fin de la cadena de middlewares. */
const HANDLER_RE = /async\s*\(\s*_?req\b|\(\s*_?req\b|asyncHandler\s*\(/;
/** Cualquiera de las dos capas de autz del repo. */
export const AUTHZ_RE = /authorize\(Roles\.[A-Z_]+\)|authorizePlatform\s*\(/;

export function findRouteFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findRouteFiles(full));
    } else if (entry.endsWith('.routes.ts') && !entry.endsWith('.routes.test.ts')) {
      results.push(full);
    }
  }
  return results;
}

/** Saca comentarios de bloque `/* *\/` y de línea `//` antes de mirar, para
 *  no matchear `authorize(Roles.X)` o `router.get(...)` escritos como
 *  ejemplo en un docblock. */
export function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

/** Líneas donde un `router.use(...)` instala un guard de autz para todo lo
 *  que se registre después en ese router (mismo archivo, número de línea). */
export function findGuardLines(code: string): number[] {
  const guardLines: number[] = [];
  USE_RE.lastIndex = 0;
  let um: RegExpExecArray | null;
  while ((um = USE_RE.exec(code)) !== null) {
    if (AUTHZ_RE.test(code.slice(um.index, um.index + 200))) {
      guardLines.push(lineOf(code, um.index));
    }
  }
  return guardLines;
}

/** Enumera cada `router.<método>()` de todo `*.routes.ts` bajo `srcDir`. */
export function enumerateRoutes(srcDir: string): RouteCall[] {
  const routes: RouteCall[] = [];

  for (const file of findRouteFiles(srcDir)) {
    const rel = relative(srcDir, file).replace(/\\/g, '/');
    const code = stripComments(readFileSync(file, 'utf-8'));
    const guardLines = findGuardLines(code);

    CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CALL_RE.exec(code)) !== null) {
      const callLine = lineOf(code, m.index);
      const method = (m[1] ?? '').toUpperCase();
      const callStart = m.index + m[0].length;
      const after = code.slice(callStart, callStart + 800);
      const handlerAt = after.match(HANDLER_RE)?.index ?? -1;
      const chain = handlerAt >= 0 ? after.slice(0, handlerAt) : after;
      const path = chain.match(/['"`]([^'"`]*)['"`]/)?.[1] ?? '?';

      routes.push({
        file: rel,
        method,
        path,
        line: callLine,
        chain,
        hasInlineAuthz: AUTHZ_RE.test(chain),
        coveredByPriorUse: guardLines.some((g) => g < callLine),
      });
    }
  }

  return routes;
}
