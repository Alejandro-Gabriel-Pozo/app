import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// PUBLIC_ROUTES vive en public-routes.fixture.ts (09/09/2026, gate
// architecture-governor) -- rbac-matrix-public-routes-sync.test.ts (RBAC-SYNC-001
// §4) también lo necesita, e importar un *.test.ts como módulo hace que
// Vitest re-ejecute sus describe() de nivel superior (RBAC-ROUTE-001 corría
// dos veces en una corrida de la suite completa). Un fixture no-test es el
// lugar correcto para algo que dos suites comparten.
import { PUBLIC_ROUTES } from './public-routes.fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * RBAC-ROUTE-001 (30/08/2026, docs/diseno-rbac-modelo-y-alcance-2026-08-30.md,
 * "Hueco 2") — la cerca de conteo de `rbac-matrix-sync.test.ts` NO ve una ruta
 * agregada a un `*.routes.ts` que ya existe SIN `authorize()`: no suma un
 * `authorize(Roles.X)` ni un archivo nuevo, así que pasa verde y la ruta queda
 * abierta a cualquier identidad autenticada del tenant (la autz es opt-in por
 * ruta, no deny-by-default — ver el ADR).
 *
 * Este bloque cierra ese hueco: cada `router.<method>()` de un `*.routes.ts`
 * tiene que estar cubierto por una capa de autz — `authorize(Roles.X)` o
 * `authorizePlatform(...)` en su propia cadena de middlewares, o un
 * `router.use(...)` previo en el mismo archivo — o figurar en `PUBLIC_ROUTES`
 * con su motivo.
 *
 * SI ESTO ROMPE: agregaste una ruta sin capa de autz.
 *   - Si debe estar protegida: ponele `authorize(Roles.X)` y actualizá
 *     `rbac-matrix-sync.test.ts` (EXPECTED_AUTHORIZE_CALL_SITES) +
 *     `docs/rbac-matriz-endpoints.md` en el mismo cambio.
 *   - Si es pública a propósito (login, alta, flujo por token, lectura
 *     self-scoped): agregala a `PUBLIC_ROUTES` abajo con el motivo.
 * NO metas acá una ruta que debería estar protegida para "hacer pasar el
 * test" — eso es exactamente el agujero que el Hueco 2 documenta.
 *
 * Es una cerca eléctrica, no un parser: mismo criterio y mismas limitaciones
 * que `rbac-matrix-sync.test.ts` (comentarios, `router.use()` encadenado). Los
 * helpers se duplican de ese archivo a propósito — son scaffolding de test, no
 * lógica de dominio.
 *
 * LO QUE ESTA CERCA **NO** GARANTIZA — dos límites reales, verificados el
 * 30/08/2026. Leerlos antes de confiar de más en el verde:
 *
 * 1. `guardLines` es por archivo y por número de línea, NO por instancia de
 *    `Router()`. Hoy es inofensivo: los dos archivos con dos `Router()`
 *    (`facturacion/invoices.routes.ts`, `usuarios-roles/user-invitation.routes.ts`)
 *    no usan `router.use()`. Pero un segundo `Router()` agregado DEBAJO del
 *    `router.use()` de `customer.routes.ts` (L506), `admin.routes.ts` (L57) o
 *    `platform.routes.ts` (L120) haría pasar todas sus rutas como cubiertas sin
 *    tener guard. Si agregás un `Router()` a uno de esos archivos, revisá acá.
 *
 * 2. NO valida el orden de montaje de `src/app.ts` — esa invariante la cubre
 *    ahora, para el gate de tenant, `src/tests/architecture/api-auth-gate-order.test.ts`
 *    (RBAC-MOUNT-001, 07/09/2026): parte `app.ts` por la línea del gate y
 *    exige que todo `app.use('/api/...')` anterior esté declarado como
 *    pre-auth a propósito. Lo que esa cerca protege es que **7** de las 22
 *    entradas de `PUBLIC_ROUTES` (`me.routes.ts` x3, `business-modules`,
 *    `business-plan-limits`, `categories` x2) — seguras solo porque su
 *    `app.use(...)` va DESPUÉS del `app.use('/api', authenticate(...))` de
 *    `src/app.ts:317` — no suban por encima del gate. Lo que sigue sin
 *    releerse solo es ESTA lista contra ese código.
 *
 *    Las otras 15 NO cuentan acá, y la distinción importa para que nadie
 *    "corrija" este 7 de vuelta a 11: son públicas a propósito y muchas se
 *    montan ANTES del `authenticate()` — `customer.routes.ts` en L275, el
 *    login en L270. Dependen del orden para FUNCIONAR, no para estar
 *    protegidas: moverlas debajo de L317 haría que el login pida token, o
 *    sea que rompe la app de forma ruidosa, no que abra un agujero callado.
 *
 *    Tampoco escanea `src/app.ts`, que registra 4 rutas a mano con
 *    `app.get` (`/health`, `/health/db`, `/`, `/openapi.json`) más `/docs`
 *    por `app.use`.
 */

const METHODS = 'get|post|put|patch|delete';
const CALL_RE = new RegExp(String.raw`\brouter\.(${METHODS})\s*\(`, 'g');
const USE_RE = /\brouter\.use\s*\(/g;
/** Inicio de la función handler → marca el fin de la cadena de middlewares. */
const HANDLER_RE = /async\s*\(\s*_?req\b|\(\s*_?req\b|asyncHandler\s*\(/;
/** Cualquiera de las dos capas de autz del repo. */
const AUTHZ_RE = /authorize\(Roles\.[A-Z_]+\)|authorizePlatform\s*\(/;

function findRouteFiles(dir: string): string[] {
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

/** Igual que en `rbac-matrix-sync.test.ts`: saca `/* *\/` y `//` antes de mirar,
 *  para no matchear `authorize(Roles.X)` escrito como ejemplo en un docblock. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length;

describe('RBAC-ROUTE-001 — toda ruta tiene capa de autz o está en PUBLIC_ROUTES', () => {
  it('no hay `router.<method>()` sin authorize() fuera del allowlist', () => {
    const files = findRouteFiles(SRC_DIR);
    const violations: string[] = [];
    const usedKeys = new Set<string>();

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      const code = stripComments(readFileSync(file, 'utf-8'));

      // Líneas donde un `router.use(...)` instala un guard de autz para todo lo
      // que se registre después en ese router.
      const guardLines: number[] = [];
      USE_RE.lastIndex = 0;
      let um: RegExpExecArray | null;
      while ((um = USE_RE.exec(code)) !== null) {
        if (AUTHZ_RE.test(code.slice(um.index, um.index + 200))) {
          guardLines.push(lineOf(code, um.index));
        }
      }

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
        const key = `${rel}|${method} ${path}`;

        if (AUTHZ_RE.test(chain)) continue;                       // autz en su propia cadena
        if (guardLines.some((g) => g < callLine)) continue;       // autz por router.use() previo
        if (key in PUBLIC_ROUTES) { usedKeys.add(key); continue; } // pública a propósito

        violations.push(key);
      }
    }

    expect(
      violations,
      `Rutas sin capa de autz y fuera de PUBLIC_ROUTES:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);

    const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !usedKeys.has(k));
    expect(
      stale,
      `Entradas de PUBLIC_ROUTES que ya no matchean ninguna ruta (sacalas):\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
