import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');
const REPO_ROOT = join(SRC_DIR, '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'rbac-matriz-endpoints.md');

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
// F2 (25/08/2026) -- 197, no 196: users.routes.ts suma
// POST /:id/reactivate, authorize(Roles.MANAGEMENT).
// A6.1 en stock (27/08/2026, pendientes-2026-08-27.md, adoptado de
// `proyecto script`) -- 203, no 197: consumption-destinations.routes.ts
// nuevo suma 5 authorize(Roles.MANAGEMENT) (GET /, GET /:id, POST /,
// PUT /:id, DELETE /:id) + products.routes.ts suma 1 más
// (POST /stock/consumption).
// Fase 4 Bloque 4B (30/08/2026, commit 9119a50) -- 204, no 203:
// business-context.routes.ts nuevo suma 1 authorize(Roles.STAFF) en
// GET /api/business/context. La sync del maestro quedó pendiente en ese
// commit; se cierra acá.
// ADR común cancelar-con-NC sub-bloque 4 (07/09/2026) -- 205, no 204:
// orders.routes.ts suma POST /:id/cancel-with-credit-note,
// authorize(Roles.EMISOR_NOTA_CREDITO) -- el escape administrativo que
// cancela una orden con Factura B viva emitiendo una Nota de Crédito.
// Bloque 3.3-b2 (09/09/2026, gate `architecture-governor`) -- 206, no 205:
// reservations.routes.ts suma POST /:id/cancel-with-credit-note, mismo
// authorize(Roles.EMISOR_NOTA_CREDITO) -- el mismo escape, del lado reservas.
// 10/09/2026 -- 207, no 206: GET /api/invoices/unreconciled nuevo.
// Bloque 3c-iii (14/09/2026, gate architecture-governor) -- 209, no 207:
// accounts-receivable.routes.ts suma POST /:id/reverse, DOS authorize()
// en cadena (Roles.MANAGEMENT Y Roles.EMISOR_NOTA_CREDITO, §3.7 del ADR
// de City Ledger) -- primer endpoint del repo que encadena dos.
// service_items Bloque B (15/09/2026, docs/diseno-factura-borrador-2026-08-31.md
// §29.7.6) -- 214, no 209: service-items.routes.ts nuevo suma 5
// authorize() (GET / y GET /:id -> Roles.ORDERS; POST /, PUT /:id,
// DELETE /:id -> Roles.MANAGEMENT).
const EXPECTED_AUTHORIZE_CALL_SITES = 214;
// F1-Pieza 3 (23/08/2026) -- 34, no 33: accounts-receivable.routes.ts nuevo.
// A6.1 en stock (27/08/2026) -- 36, no 35: consumption-destinations.routes.ts nuevo.
// Fase 4 Bloque 4B (30/08/2026, commit 9119a50) -- 37, no 36:
// business-context.routes.ts nuevo.
// service_items Bloque B (15/09/2026) -- 38, no 37: service-items.routes.ts nuevo.
const EXPECTED_ROUTES_FILE_COUNT = 38;

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

  /**
   * RBAC-MATRIX-HEADER-STALE-001 (09/09/2026, gate `architecture-governor`).
   * El encabezado de `docs/rbac-matriz-endpoints.md` sección 2 repite a mano
   * los mismos dos números que las constantes de arriba -- y ya se
   * desincronizó dos veces en el mismo lugar (198/204 el 01/09/2026, 205/206
   * el 09/09/2026, ver la nota de esa sección). Los dos tests de arriba
   * validan CÓDIGO contra CONSTANTE; ninguno mira esta prosa. Esta cerca
   * cierra ese hueco puntual -- no es un parser de markdown genérico, es
   * "un número que ya se pudrió dos veces en este archivo exacto, con una
   * constante propia para comparar".
   *
   * LO QUE NO CUBRE: cualquier otro número de este documento (la fecha de
   * "Última actualización" del encabezado del doc, las filas de la matriz, la
   * sección 4 -- esa la cruza `rbac-matrix-public-routes-sync.test.ts` con
   * un criterio distinto). Solo el encabezado exacto de la sección 2.
   */
  it('el encabezado de la sección 2 de docs/rbac-matriz-endpoints.md coincide con EXPECTED_*', () => {
    const doc = readFileSync(DOC_PATH, 'utf-8');
    const headerRe = /## 2\. Matriz de endpoints por archivo \((\d+) call-sites, (\d+) archivos\)/g;
    const matches = [...doc.matchAll(headerRe)];

    expect(
      matches.length,
      matches.length === 0
        ? `no encontré el encabezado de la sección 2 en ${DOC_PATH} -- ¿cambió el texto? Actualizá este regex y EXPECTED_* en el mismo cambio.`
        : `encontré ${matches.length} ocurrencias del texto del encabezado en ${DOC_PATH} (una de ellas probablemente dentro de una nota que lo cita textualmente) -- esta cerca no puede saber cuál es el header real. Hacé que el texto citado en la nota difiera del encabezado real (ej. una palabra de más), o ajustá el regex para que solo matchee el encabezado real de la sección 2.`,
    ).toBe(1);

    const match = matches[0]!;
    const [, docCallSites, docRoutesFileCount] = match;

    expect(
      Number(docCallSites),
      `docs/rbac-matriz-endpoints.md dice "${docCallSites} call-sites" pero EXPECTED_AUTHORIZE_CALL_SITES es ${EXPECTED_AUTHORIZE_CALL_SITES} -- actualizá el encabezado de la sección 2.`,
    ).toBe(EXPECTED_AUTHORIZE_CALL_SITES);

    expect(
      Number(docRoutesFileCount),
      `docs/rbac-matriz-endpoints.md dice "${docRoutesFileCount} archivos" pero EXPECTED_ROUTES_FILE_COUNT es ${EXPECTED_ROUTES_FILE_COUNT} -- actualizá el encabezado de la sección 2.`,
    ).toBe(EXPECTED_ROUTES_FILE_COUNT);
  });
});
