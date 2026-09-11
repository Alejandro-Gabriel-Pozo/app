import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enumerateRoutes } from '../security/route-enumeration.fixture.js';
import { PUBLIC_ROUTES } from '../security/public-routes.fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');
const REPO_ROOT = join(SRC_DIR, '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'rbac-matriz-endpoints.md');

/**
 * RBAC-MATRIX-SECTION2-001 (09/09/2026, gate `architecture-governor`, bloque
 * 2 -- bloque 1 fue extraer `route-enumeration.fixture.ts`).
 *
 * `rbac-matrix-sync.test.ts` cuenta AGREGADO de `authorize(Roles.X)` contra
 * un número fijo. `rbac-route-coverage.test.ts` exige que CADA ruta real
 * tenga ALGUNA capa de autz. Ninguna de las dos cruza el CONTENIDO
 * fila-por-fila de la sección 2 (`### <dir>/` → `**archivo.routes.ts**` →
 * `- MÉTODO \`path\``) contra el código real -- solo el conteo agregado, que
 * no distingue "la fila describe la ruta correcta" de "el número total
 * coincide por casualidad".
 *
 * ## Por qué el join es por CÓDIGO, no por `docs/inventario-rutas.md`
 * La sección 2 ya está escrita en paths INTERNOS por archivo -- la misma
 * forma `(archivo, método, path interno)` que
 * `route-enumeration.fixture.ts` produce. Cruzar contra el inventario
 * (paths EXTERNOS montados) exigiría un mapa archivo→prefijo que además NO
 * es una función (`facturacion/invoices.routes.ts` monta 2 routers en 2
 * prefijos distintos; `usuarios-roles/user-invitation.routes.ts` también) --
 * un allowlist de ~33 entradas para reconstruir algo que ya está resuelto
 * por la llave correcta con CERO entradas. Ver el gate del 09/09/2026 para
 * el detalle de por qué se descartó esa alternativa.
 *
 * Alcance: EXISTENCIA de la fila, no el GRUPO que declara. `chain` (en
 * `RouteCall`) ya trae la cadena de middlewares con el `authorize(Roles.X)`
 * real -- cruzar el grupo es un bloque futuro habilitado por este fixture,
 * no incluido acá, para no mezclar "existe la fila" con "la fila no
 * miente sobre el grupo".
 *
 * SI ESTO ROMPE:
 *   - Bullet de la sección 2 sin ruta real: se borró/renombró la ruta y
 *     nadie actualizó el doc, o el bullet tiene un typo (ver el caso real
 *     de `accounts-receivable.routes.ts` abajo, en `EXCLUDED_FILES`).
 *   - Ruta real protegida sin bullet en la sección 2: se agregó una ruta
 *     sin actualizar el doc. Agregá el bullet `- MÉTODO \`path\` —
 *     \`GRUPO\`` en el archivo correspondiente, en el mismo cambio que la
 *     ruta.
 *
 * `EXCLUDED_FILES` -- noveno artefacto manual del repo (ver
 * `app-main/CLAUDE.md`, sección RBAC): 11 archivos donde la sección 2
 * describe las rutas protegidas en PROSA (comodines, notación de corchetes
 * `[/:plan]`, párrafos narrativos) en vez de bullets parseables -- esta
 * cerca no intenta parsear prosa libre (`CLOSURE_MOUNTS`/`MOUNT_TO_ROUTES_FILE`
 * ya establecieron ese criterio: allowlist manual chico y verificado, no un
 * parser genérico). Cada entrada lleva el CONTEO de rutas protegidas reales
 * que esconde (verificado contra `route-enumeration.fixture.ts` +
 * `PUBLIC_ROUTES` el 09/09/2026 -- **85, no 83**: el research previo al gate
 * había estimado 83 sin haber corrido el conteo real sobre
 * `accounts-receivable.routes.ts`, que tiene 3 rutas protegidas, no 1). Si
 * alguien agrega una ruta a uno de estos 11 archivos sin normalizar la
 * sección 2, la suite se pone roja -- no queda como deuda invisible.
 *
 * ## `docBullets` -- por qué es un CONJUNTO congelado, no un conteo (11/09/2026)
 * El hueco original: la única aserción sobre `EXCLUDED_FILES` era
 * "¿el conteo total de rutas protegidas sigue coincidiendo con `hiddenCount`?"
 * -- eso NO detecta que alguien normalice un archivo a bullets reales en la
 * sección 2 y se olvide de sacarlo de `EXCLUDED_FILES`: los bullets nuevos
 * describen las mismas rutas que ya se contaban vía prosa, el TOTAL no se
 * mueve, y la cerca queda verde ignorando los bullets nuevos por completo.
 *
 * Un segundo campo `EXPECTED_PARSEABLE_COUNT` (comparar contra un número)
 * tiene el MISMO defecto que el original -- un conteo no distingue "el
 * archivo sigue en prosa" de "alguien reescribió un bullet preservando el
 * tamaño del conjunto". El caso real, ya en este archivo, es
 * `accounts-receivable.routes.ts`: 3 bullets reales, uno de ellos
 * (`GET /?companyCustomerId=`) diverge del código real (`GET /`). Si se
 * corrige esa línea sin sacar el archivo de `EXCLUDED_FILES`, un conteo
 * contra 3 sigue dando 3 -- verde, hueco sin cerrar en el único archivo que
 * hoy tiene bullets de verdad. Por eso `docBullets` es el CONJUNTO exacto
 * (`"MÉTODO path"`, mismo formato que `DocBullet`) esperado bajo el
 * marcador de cada archivo -- comparación de conjunto insensible al orden,
 * no de tamaño. Mismo criterio que `roles-catalog-sync.test.ts` (congela el
 * conjunto ordenado del catálogo de roles, no un conteo, por la misma razón:
 * un conteo no ve un renombre que preserva el tamaño -- verificado por
 * mutación el 09/09/2026).
 */

const EXCLUDED_FILES: Record<string, { hiddenCount: number; motivo: string; docBullets: string[] }> = {
  'api/routes/customer.routes.ts': {
    hiddenCount: 7,
    motivo: 'Párrafo narrativo (líneas 116-124 del doc): "7 rutas de /me/*" descritas en prosa, no como bullets.',
    docBullets: [],
  },
  'facturacion/invoices.routes.ts': {
    hiddenCount: 9, // +1: GET /api/invoices/unreconciled (10/09/2026)
    motivo: 'Prosa por router (2 factories del mismo archivo, createInvoicesRouter + createAfipCredentialsRouter), rutas listadas inline separadas por ";", no como bullets.',
    docBullets: [],
  },
  'platform/admin.routes.ts': {
    hiddenCount: 2,
    motivo: 'Prosa de una línea: "POST /repair-tenant-db, POST /set-tenant-url", no bullets.',
    docBullets: [],
  },
  'platform/platform.routes.ts': {
    hiddenCount: 11,
    motivo: 'Prosa de un párrafo largo con notación de corchetes opcionales ([/:plan], [/:name]) que no es expandible por regex sin reescritura a mano.',
    docBullets: [],
  },
  'pos-menu/waste-reasons.routes.ts': {
    hiddenCount: 5,
    motivo: 'Prosa de una línea: "GET /, GET /:id, POST /, PUT /:id, DELETE /:id — todo MANAGEMENT", no bullets.',
    docBullets: [],
  },
  'pos-menu/consumption-destinations.routes.ts': {
    hiddenCount: 5,
    motivo: 'Mismo patrón que waste-reasons.routes.ts (gemelo declarado en el doc), prosa de una línea, no bullets.',
    docBullets: [],
  },
  'pos-menu/products.routes.ts': {
    hiddenCount: 30,
    motivo: 'Prosa con comodines ("/:id/variants*", "/price-override/*") que agrupan varias rutas reales bajo un solo patrón -- no es 1:1 expandible sin leer cada authorize() real a mano.',
    docBullets: [],
  },
  'reservas/cancellation-policies.routes.ts': {
    hiddenCount: 5,
    motivo: 'Prosa de una línea: "GET /, GET /:id, POST /, PUT /:id, DELETE /:id — todo MANAGEMENT", no bullets.',
    docBullets: [],
  },
  'usuarios-roles/roles.routes.ts': {
    hiddenCount: 5,
    motivo: 'Prosa de una línea: "GET /, GET /:id, POST /, PUT /:id, DELETE /:id — todo MANAGEMENT", no bullets.',
    docBullets: [],
  },
  'usuarios-roles/user-invitation.routes.ts': {
    hiddenCount: 4,
    motivo: 'Prosa de una línea para createUserInvitationsRouter: "GET /, POST /, POST /:id/resend, DELETE /:id", no bullets. (El otro router del archivo, createInvitationAcceptanceRouter, es público -- sección 4.)',
    docBullets: [],
  },
  'clientes-finanzas/accounts-receivable.routes.ts': {
    hiddenCount: 3,
    motivo: 'SÍ tiene bullets (no es prosa), pero uno diverge del código real: el doc dice "GET `/?companyCustomerId=`", el código real es "GET `/`" -- un parser fila-por-fila lo marcaría en las dos direcciones a la vez. Corregir esa línea es edición de docs, fuera de alcance de este bloque (declarado explícitamente por el gate) -- hasta entonces, los 3 bullets del archivo quedan sin verificar, no solo el divergente, para no verificar 2 de 3 y dar una falsa sensación de cobertura completa.',
    // Conjunto CONGELADO a propósito -- incluye el bullet divergente
    // (GET /?companyCustomerId= vs. el código real GET /) tal cual está
    // hoy en el doc. Si alguien corrige esa línea sin sacar el archivo de
    // EXCLUDED_FILES, este conjunto deja de matchear y el test de abajo
    // rompe -- señal correcta: "el archivo cambió, revisá si sigue
    // perteneciendo acá", no una falla espuria.
    docBullets: ['GET /?companyCustomerId=', 'POST /:id/mark-invoiced', 'POST /:id/mark-collected'],
  },
};

const METHODS_RE = '(?:GET|POST|PUT|PATCH|DELETE)';
/** Anclado a inicio de línea (post-trim) -- NO un tokenizer libre. Evita que
 *  un párrafo narrativo que MENCIONA una ruta borrada (ej. el paréntesis de
 *  `housekeeping.routes.ts` sobre `/:id/out-of-service`, eliminada el
 *  25/08/2026) se lea como una fila real. */
const BULLET_RE = new RegExp(`^-\\s+(${METHODS_RE})\\s+\`([^\`]*)\``);
const FILE_HEADER_RE = /\*\*`([\w.-]+\.routes\.ts)`\*\*/g;

interface DocBullet {
  file: string; // basename, ej. 'audit-log.routes.ts'
  method: string;
  path: string;
}

/** Igual que `rbac-matrix-public-routes-sync.test.ts`: mapa basename ->
 *  ruta relativa a `src/`, con detección de basenames duplicados (si dos
 *  `*.routes.ts` distintos comparten nombre, la resolución por basename de
 *  la sección 2 se vuelve ambigua). */
function findRoutesFileMap(dir: string): Map<string, string> {
  const map = new Map<string, string>();
  const dupes: string[] = [];
  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      if (entry === 'node_modules') continue;
      const full = join(d, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.routes.ts') && !entry.endsWith('.test.ts')) {
        if (map.has(entry)) dupes.push(entry);
        map.set(entry, relative(dir, full).replace(/\\/g, '/'));
      }
    }
  }
  walk(dir);
  if (dupes.length > 0) {
    throw new Error(
      `rbac-matrix-section2-sync: basenames de *.routes.ts duplicados (${dupes.join(', ')}) -- la sección 2 del doc solo nombra basenames, la resolución quedó ambigua.`,
    );
  }
  return map;
}

/** Extrae el texto de la sección 2 (entre su header y el de la sección 3). */
function extractSection2(doc: string): string {
  const headerRe = /^## 2\. Matriz de endpoints por archivo \(\d+ call-sites, \d+ archivos\)$/m;
  const headerMatch = doc.match(headerRe);
  if (!headerMatch || headerMatch.index === undefined) {
    throw new Error('rbac-matrix-section2-sync: no encontré el header de la sección 2 -- ¿cambió el texto?');
  }
  const nextSectionIdx = doc.indexOf('\n## 3.', headerMatch.index);
  if (nextSectionIdx === -1) {
    throw new Error('rbac-matrix-section2-sync: no encontré el header de la sección 3 -- ¿cambió el texto? Sin eso no sé dónde termina la sección 2.');
  }
  return doc.slice(headerMatch.index, nextSectionIdx);
}

/** Recorre la sección 2 marcador por marcador (`**\`archivo.routes.ts\`**`)
 *  y junta los bullets que aparecen ANTES del próximo marcador (o del fin
 *  de la sección) bajo ese archivo. Si un archivo aparece más de una vez
 *  (ej. `business-modules.routes.ts`, listado dos veces como puntero a la
 *  sección 4), los bullets de ambas menciones se acumulan -- no se pisan. */
function extractDocBullets(section2: string): DocBullet[] {
  const markers: { file: string; index: number }[] = [];
  FILE_HEADER_RE.lastIndex = 0;
  let hm: RegExpExecArray | null;
  while ((hm = FILE_HEADER_RE.exec(section2)) !== null) {
    markers.push({ file: hm[1] ?? '', index: hm.index });
  }

  const bullets: DocBullet[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    if (!marker) continue;
    const start = marker.index;
    const end = i + 1 < markers.length ? (markers[i + 1]?.index ?? section2.length) : section2.length;
    const block = section2.slice(start, end);
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      const m = line.match(BULLET_RE);
      if (m) {
        bullets.push({ file: marker.file, method: (m[1] ?? '').toUpperCase(), path: m[2] ?? '' });
      }
    }
  }
  return bullets;
}

describe('RBAC-MATRIX-SECTION2-001 -- sección 2 de rbac-matriz-endpoints.md sincronizada con el código real', () => {
  const doc = readFileSync(DOC_PATH, 'utf-8');
  const section2 = extractSection2(doc);
  const routesFileMap = findRoutesFileMap(SRC_DIR);
  const docBullets = extractDocBullets(section2);
  const realRoutes = enumerateRoutes(SRC_DIR);

  it('todo EXCLUDED_FILES sigue siendo un *.routes.ts real, con el conteo de rutas protegidas que declara', () => {
    const violations: string[] = [];
    for (const [file, { hiddenCount }] of Object.entries(EXCLUDED_FILES)) {
      const real = realRoutes.filter((r) => r.file === file);
      if (real.length === 0) {
        violations.push(`${file}: no encontré NINGUNA ruta real -- ¿el archivo se movió o se borró?`);
        continue;
      }
      const protectedCount = real.filter((r) => !(`${r.file}|${r.method} ${r.path}` in PUBLIC_ROUTES)).length;
      if (protectedCount !== hiddenCount) {
        violations.push(
          `${file}: EXCLUDED_FILES declara ${hiddenCount} rutas protegidas escondidas, pero el código tiene ${protectedCount} -- actualizá el número (o normalizá el archivo a bullets y sacalo de EXCLUDED_FILES).`,
        );
      }
    }
    expect(violations, violations.join('\n  ')).toEqual([]);
  });

  it('EXCLUDED_FILES sigue sin bullets parseables NUEVOS en la sección 2 (conjunto congelado, no conteo)', () => {
    const violations: string[] = [];
    for (const [file, { docBullets: expected }] of Object.entries(EXCLUDED_FILES)) {
      const actual = docBullets
        .filter((b) => routesFileMap.get(b.file) === file)
        .map((b) => `${b.method} ${b.path}`);

      const expectedSet = new Set(expected);
      const actualSet = new Set(actual);
      const missing = expected.filter((e) => !actualSet.has(e));
      const extra = actual.filter((a) => !expectedSet.has(a));

      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = [];
        if (extra.length > 0) {
          parts.push(
            `bullet(s) NUEVO(s) que EXCLUDED_FILES no declaraba: ${extra.join(', ')} -- si el archivo se normalizó a bullets, sacalo de EXCLUDED_FILES (y agregá sus filas a la verificación fila-por-fila) en el mismo cambio.`,
          );
        }
        if (missing.length > 0) {
          parts.push(`bullet(s) declarado(s) en EXCLUDED_FILES que ya no aparecen en el doc: ${missing.join(', ')}.`);
        }
        violations.push(`${file}: ${parts.join(' ')}`);
      }
    }
    expect(violations, violations.join('\n  ')).toEqual([]);
  });

  it('todo bullet de la sección 2 (archivos NO excluidos) matchea una ruta real', () => {
    const violations: string[] = [];
    for (const b of docBullets) {
      const relFile = routesFileMap.get(b.file);
      if (!relFile) {
        violations.push(`**${b.file}** citado en la sección 2 pero no encontré ese archivo bajo src/ -- ¿se renombró?`);
        continue;
      }
      if (relFile in EXCLUDED_FILES) continue; // ver EXCLUDED_FILES -- ese archivo no se verifica fila por fila todavía.

      const found = realRoutes.some((r) => r.file === relFile && r.method === b.method && r.path === b.path);
      if (!found) {
        violations.push(`**${b.file}**: la sección 2 dice \`${b.method} ${b.path}\`, pero no encontré esa ruta real en ${relFile}.`);
      }
    }
    expect(
      violations,
      `Bullets de la sección 2 sin ruta real correspondiente:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });

  it('toda ruta real protegida (archivos NO excluidos) tiene su bullet en la sección 2', () => {
    const violations: string[] = [];
    for (const r of realRoutes) {
      if (r.file in EXCLUDED_FILES) continue;
      const key = `${r.file}|${r.method} ${r.path}`;
      if (key in PUBLIC_ROUTES) continue; // pública -- alcance de la sección 4, no de esta cerca.

      const found = docBullets.some((b) => {
        const relFile = routesFileMap.get(b.file);
        return relFile === r.file && b.method === r.method && b.path === r.path;
      });
      if (!found) {
        violations.push(`${r.file}: ${r.method} ${r.path} (línea ${r.line}) no tiene bullet en la sección 2.`);
      }
    }
    expect(
      violations,
      `Rutas reales protegidas sin fila en la sección 2:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);
  });
});
