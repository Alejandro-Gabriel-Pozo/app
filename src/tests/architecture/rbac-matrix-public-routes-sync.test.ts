import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
// Importa el fixture no-test, NUNCA el *.test.ts -- importar un *.test.ts
// como módulo hace que Vitest re-ejecute sus describe() de nivel superior
// (encontrado 09/09/2026, gate architecture-governor: RBAC-ROUTE-001 corría
// dos veces en una corrida de la suite completa).
import { PUBLIC_ROUTES } from '../security/public-routes.fixture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');
const REPO_ROOT = join(SRC_DIR, '..');
const DOC_PATH = join(REPO_ROOT, 'docs', 'rbac-matriz-endpoints.md');

/**
 * RBAC-SYNC-001 §4 (09/09/2026, gate `architecture-governor`, "camino 3").
 *
 * `rbac-route-coverage.test.ts` (RBAC-ROUTE-001) ya cruza el CÓDIGO real
 * contra su propio allowlist `PUBLIC_ROUTES`. Pero nada cruzaba `PUBLIC_ROUTES`
 * contra la sección 4 de `docs/rbac-matriz-endpoints.md` — el inventario
 * legible por humanos que un auditor externo leería para saber qué
 * endpoints son públicos. `docs/rbac-matriz-endpoints.md` lo declaraba
 * textual: "Ese cruce no lo verifica nada automático: es a ojo".
 *
 * ## Por qué "camino 3" (no reescribir el doc a rutas internas, no parsear `app.ts`)
 * El research previo al gate verificó las 22 filas de la sección 4 una por
 * una contra `PUBLIC_ROUTES`: **19 de 22 ya usan el mismo formato que el
 * código** (ruta INTERNA del router, no la URL externa montada — ej.
 * `me.routes.ts GET /me`, no `GET /api/auth/me`). Solo 3 celdas divergían
 * (el research original había verificado 1 de 22 y generalizado mal). El
 * doc YA ES mayormente interno — no hay legibilidad real que preservar
 * reescribiéndolo, y no hace falta resolver prefijos de `app.ts` (que
 * tiene mounts con middleware intermedio, ej. `requireModule(...)`, que
 * un parser de prefijos perdería en silencio). El fix real es normalizar
 * las 3 celdas divergentes, no construir una cerca de traducción de rutas.
 *
 * ## Qué hace esta cerca
 * Parsea la primera celda de cada fila de la tabla de la sección 4,
 * extrae (archivo, método, path) por fila, y compara el `Record` derivado
 * contra `PUBLIC_ROUTES` (importado, NO duplicado — evita una tercera
 * copia que también pudiera desalinearse) en las DOS direcciones.
 *
 * ## Filosofía: cerca eléctrica, no parser — pero FAIL-LOUD, no fail-skip
 * A diferencia de las cercas de código-contra-código de este repo
 * (`credit-note-escape-containment.test.ts`, `rbac-matrix-sync.test.ts`),
 * esta es la PRIMERA que parsea un `docs/*.md`. No hay precedente de
 * cuánta fragilidad es aceptable. La regla que el gate fijó: una fila que
 * el parser no puede reducir a ≥1 par (método, path) NO se saltea en
 * silencio — tiene que matchear textual una entrada de `EXCLUDED_ROWS`
 * (con motivo, verificada en las dos direcciones más abajo) o el test
 * FALLA con la fila cruda a la vista. Una fila ignorada por accidente es
 * el modo de falla que pudre esta familia de cercas.
 *
 * ## SI ESTO ROMPE
 *  - "Fila sin archivo *.routes.ts reconocible ni excepción declarada":
 *    agregaste/editaste una fila en la sección 4 que el parser no puede
 *    leer. Si es una fila real de rutas públicas, arreglá el formato
 *    (backticks alrededor del archivo y de cada path, MÉTODO en
 *    mayúsculas antes de sus paths). Si es una fila sin contraparte real
 *    (como `app.ts`), sumala a `EXCLUDED_ROWS` con motivo.
 *  - "Faltan en la sección 4" / "Faltan en PUBLIC_ROUTES": alguien tocó
 *    una ruta pública en el código (`PUBLIC_ROUTES`) o en el doc sin tocar
 *    la otra. Actualizá la que falta, en el mismo cambio.
 *  - "Basenames de *.routes.ts duplicados": esta cerca resuelve el
 *    archivo de la sección 4 (que usa solo el basename, ej.
 *    `me.routes.ts`) a una ruta relativa a `src/` buscando ese basename
 *    en todo el árbol. Si dos archivos comparten basename, la resolución
 *    es ambigua — hoy no pasa (verificado, 37 archivos `*.routes.ts`, 0
 *    basenames repetidos), pero es una invariante que hay que custodiar,
 *    no asumir.
 *
 * ## FALSOS NEGATIVOS DECLARADOS
 *  1. No valida NADA de `app.ts` (montaje, orden, prefijos) — ese alcance
 *     es de `api-auth-gate-order.test.ts` (RBAC-MOUNT-001) y
 *     `rbac-route-coverage.test.ts` (límite declarado en su propio
 *     docblock). Esta cerca solo cruza dos listas de texto.
 *  2. Si `docs/rbac-matriz-endpoints.md` cambia de nombre o de estructura
 *     de secciones (el header exacto `## 4. Rutas sin \`authorize()\` —
 *     inventario completo`), esta cerca no encuentra la tabla y tira un
 *     error de "sección 4 no encontrada" — fail-loud, no fail-skip, pero
 *     es un acoplamiento textual real al formato del doc.
 *  3. El tokenizer reconoce `GET|POST|PUT|PATCH|DELETE` como palabra
 *     suelta en mayúsculas y cualquier backtick que empiece con `/` como
 *     path — un texto libre en la columna "Por qué" que por accidente
 *     tuviera ese patrón (ej. "usa \`POST\` internamente") NO contaminaría
 *     el parseo porque esta cerca solo mira la PRIMERA celda de cada fila,
 *     nunca la segunda.
 */

/** Filas de la sección 4 SIN contraparte real en `PUBLIC_ROUTES`, con motivo.
 *  Verificado en las DOS direcciones (test de abajo): si una de estas deja
 *  de aparecer tal cual en el doc, el test también falla -- no se puede
 *  agregar ni sacar una exclusión en silencio. Clave = texto de la fila sin
 *  backticks ni `**`, espacios colapsados. */
const EXCLUDED_ROWS: Record<string, string> = {
  'platform.routes.ts (resto)':
    'Resuelto 23/08/2026 (sección 2 del doc) -- ya exige authorizePlatform([SUPERADMIN]); fila histórica, no inventario de rutas públicas vigente.',
  'app.ts GET /health, /health/db':
    'Infraestructura -- ni esta cerca ni rbac-route-coverage.test.ts escanean app.ts (mismo límite declarado ahí, docblock punto 2).',
  'app.ts GET /, /openapi.json, /docs':
    'Ya NO se montan con NODE_ENV=production (api/docs-exposure.ts, 01/09/2026) -- no hay ruta real que cubrir hoy.',
};

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const FILE_RE = /`([\w.-]+\.routes\.ts)`/;
/** Método suelto en mayúsculas, o un path entre backticks que empieza con `/`. */
const TOKEN_RE = new RegExp(String.raw`\b(${METHODS.join('|')})\b|` + '`(/[^`]*)`', 'g');

function stripFormatting(cell: string): string {
  return cell.replace(/\*\*/g, '');
}

/** Texto crudo de la fila para matchear contra `EXCLUDED_ROWS`: sin `**`, sin
 *  backticks, espacios colapsados. */
function rawDescriptor(cell: string): string {
  return stripFormatting(cell).replace(/`/g, '').trim().replace(/\s+/g, ' ');
}

interface ParsedRoute { file: string; method: string; path: string }

/** Parsea la primera celda de una fila en pares (archivo, método, path).
 *  `null` si la fila no declara ningún *.routes.ts ni ningún par -- el
 *  caller decide si eso es una exclusión válida o un fallo. */
function parseRow(rawCell: string): ParsedRoute[] | null {
  const cell = stripFormatting(rawCell);
  const fileMatch = FILE_RE.exec(cell);
  if (!fileMatch) return null;
  const file = fileMatch[1]!;
  // Saca el token del archivo (una sola vez) y cualquier paréntesis --
  // "(createPasswordResetRouter)", "(resto)", "(nuevo, L 23/08/2026)" --
  // para que no interfieran con el tokenizer de método/path.
  const rest = cell.replace(`\`${file}\``, '').replace(/\([^)]*\)/g, '');

  const routes: ParsedRoute[] = [];
  let currentMethod: string | null = null;
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(rest))) {
    if (m[1]) {
      currentMethod = m[1];
    } else if (m[2]) {
      if (!currentMethod) {
        throw new Error(
          `rbac-matrix-public-routes-sync: la fila de "${file}" tiene un path (\`${m[2]}\`) sin un MÉTODO antes -- formato de la sección 4 roto, fila cruda: "${rawCell}"`,
        );
      }
      routes.push({ file, method: currentMethod, path: m[2] });
    }
  }
  return routes.length > 0 ? routes : null;
}

/** Basename -> ruta relativa a src/ (POSIX). Tira si dos archivos
 *  `*.routes.ts` comparten basename -- la resolución de la sección 4 (que
 *  solo nombra basenames) se vuelve ambigua. */
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
        map.set(entry, relative(SRC_DIR, full).replace(/\\/g, '/'));
      }
    }
  }
  walk(dir);
  if (dupes.length > 0) {
    throw new Error(
      `rbac-matrix-public-routes-sync: basenames de *.routes.ts duplicados (${dupes.join(', ')}) -- la sección 4 del doc solo nombra basenames, la resolución quedó ambigua.`,
    );
  }
  return map;
}

/** Extrae las filas de datos de la tabla de la sección 4 (excluye header y
 *  separador `|---|---|`). */
function extractSection4Rows(doc: string): string[] {
  const headerIdx = doc.indexOf("## 4. Rutas sin `authorize()` — inventario completo");
  if (headerIdx === -1) {
    throw new Error('rbac-matrix-public-routes-sync: no encontré el header de la sección 4 en rbac-matriz-endpoints.md -- ¿cambió el título?');
  }
  const nextSectionIdx = doc.indexOf('\n## 5.', headerIdx);
  const section = doc.slice(headerIdx, nextSectionIdx === -1 ? undefined : nextSectionIdx);
  const lines = section.split('\n').filter((l) => l.trim().startsWith('|'));
  // Primera línea de tabla = header (`| Ruta | Por qué |`), segunda = separador (`|---|---|`).
  return lines.slice(2);
}

function firstCell(tableLine: string): string {
  const parts = tableLine.split('|');
  // parts[0] es '' (antes del primer |); parts[1] es la primera celda real.
  return (parts[1] ?? '').trim();
}

describe('RBAC-SYNC-001 §4 -- sección 4 de rbac-matriz-endpoints.md sincronizada con PUBLIC_ROUTES', () => {
  const doc = readFileSync(DOC_PATH, 'utf-8');
  const rows = extractSection4Rows(doc);
  const routesFileMap = findRoutesFileMap(SRC_DIR);

  it('cada fila de la sección 4 se parsea a ≥1 ruta, o matchea una exclusión declarada', () => {
    const unrecognized: string[] = [];
    for (const line of rows) {
      const cell = firstCell(line);
      const parsed = parseRow(cell);
      if (!parsed && !(rawDescriptor(cell) in EXCLUDED_ROWS)) {
        unrecognized.push(cell);
      }
    }
    expect(
      unrecognized,
      'Filas de la sección 4 que ni se parsean a rutas ni matchean EXCLUDED_ROWS -- arreglá el formato o agregalas a EXCLUDED_ROWS con motivo.',
    ).toEqual([]);
  });

  it('EXCLUDED_ROWS no tiene entradas huérfanas (cada exclusión existe realmente en el doc)', () => {
    const descriptors = new Set(rows.map((line) => rawDescriptor(firstCell(line))));
    const orphaned = Object.keys(EXCLUDED_ROWS).filter((key) => !descriptors.has(key));
    expect(
      orphaned,
      'Entradas de EXCLUDED_ROWS que ya no matchean ninguna fila real de la sección 4 -- la fila cambió o se borró, sacá la entrada.',
    ).toEqual([]);
  });

  it('el Record derivado de la sección 4 coincide EXACTO con PUBLIC_ROUTES, en las dos direcciones', () => {
    const derived = new Map<string, string>();
    for (const line of rows) {
      const cell = firstCell(line);
      const parsed = parseRow(cell);
      if (!parsed) continue; // ya cubierto por el test de arriba (exclusión válida)
      const relPath = routesFileMap.get(parsed[0]!.file);
      expect(relPath, `"${parsed[0]!.file}" no se encontró como *.routes.ts real bajo src/`).toBeDefined();
      for (const r of parsed) {
        derived.set(`${relPath}|${r.method} ${r.path}`, cell);
      }
    }

    const docKeys = [...derived.keys()].sort();
    const codeKeys = Object.keys(PUBLIC_ROUTES).sort();

    const faltanEnDoc = codeKeys.filter((k) => !derived.has(k));
    const faltanEnCodigo = docKeys.filter((k) => !(k in PUBLIC_ROUTES));

    expect(faltanEnDoc, 'Rutas en PUBLIC_ROUTES (código) que la sección 4 del doc no lista -- agregalas al doc.').toEqual([]);
    expect(faltanEnCodigo, 'Rutas en la sección 4 del doc que PUBLIC_ROUTES (código) no lista -- agregalas a PUBLIC_ROUTES o corregí el doc.').toEqual([]);
  });
});
