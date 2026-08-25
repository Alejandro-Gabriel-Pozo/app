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
// F1-Pieza 3 (23/08/2026) -- 191, no 188: accounts-receivable.routes.ts
// nuevo suma 3 authorize(Roles.MANAGEMENT) (GET /, mark-invoiced, mark-collected).
// C1-Fase C (23/08/2026) -- 192, no 191: invoices.routes.ts suma
// POST /consolidated ("Facturar ahora"), authorize(Roles.MANAGEMENT).
// C1-Fase C (23/08/2026) -- 194, no 192: customers.routes.ts suma
// GET/PUT /:id/billing-policy, los dos authorize(Roles.MANAGEMENT).
// Rutas huérfanas (25/08/2026) -- 196, no 198: housekeeping.routes.ts
// pierde los 2 authorize(Roles.MANAGEMENT) de /:id/out-of-service y
// /:id/reset, borradas por no tener caller real (maintenance_window las
// reemplazó el 24/08/2026).
const EXPECTED_AUTHORIZE_CALL_SITES = 196;
// F1-Pieza 3 (23/08/2026) -- 34, no 33: accounts-receivable.routes.ts nuevo.
const EXPECTED_ROUTES_FILE_COUNT = 35;

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
