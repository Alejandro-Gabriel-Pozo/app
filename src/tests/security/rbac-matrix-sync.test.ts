import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * L (23/08/2026, docs/rbac-matriz-endpoints.md) — mantiene el maestro RBAC
 * honesto sin un parser de rutas real (frágil: router.use() encadenado,
 * requireModule() envolviendo, comentarios con "authorize(Roles.X)" como
 * ejemplo -- ya hubo un falso positivo real de este último caso en
 * reports.routes.ts). En cambio, es una cerca eléctrica: cuenta cuántos
 * `authorize(Roles.X)` reales hay hoy y lo compara contra un número fijo,
 * mismo criterio que CURRENT_SCHEMA_VERSION.
 *
 * SI ESTO ROMPE: agregaste, sacaste o cambiaste un `authorize(Roles.X)`
 * en alguna ruta. Actualizá `docs/rbac-matriz-endpoints.md` (la fila del
 * endpoint que tocaste) Y el número de `EXPECTED_AUTHORIZE_CALL_SITES` de
 * abajo, en el mismo cambio -- no por separado.
 */
const EXPECTED_AUTHORIZE_CALL_SITES = 188;
// L (23/08/2026) -- 33, no 32: business-plan-limits.routes.ts nuevo (sin
// ningún authorize(), mismo criterio que business-modules.routes.ts --
// no mueve el conteo de arriba).
const EXPECTED_ROUTES_FILE_COUNT = 33;

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

/** Saca comentarios de bloque `/* *\/` y de línea `//` antes de contar --
 * evita el falso positivo real de un docblock que menciona
 * "authorize(Roles.X)" como ejemplo (reports.routes.ts:14, dentro de un
 * `/** ... *\/`). */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

describe('Maestro RBAC (docs/rbac-matriz-endpoints.md) sincronizado con el código real', () => {
  it(`hay ${EXPECTED_ROUTES_FILE_COUNT} archivos *.routes.ts`, () => {
    const files = findRouteFiles(SRC_DIR);
    expect(files.length).toBe(EXPECTED_ROUTES_FILE_COUNT);
  });

  it(`hay ${EXPECTED_AUTHORIZE_CALL_SITES} call-sites de authorize(Roles.X)`, () => {
    const files = findRouteFiles(SRC_DIR);
    let count = 0;
    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      count += (code.match(/authorize\(Roles\.[A-Z_]+\)/g) ?? []).length;
    }
    expect(count).toBe(EXPECTED_AUTHORIZE_CALL_SITES);
  });
});
