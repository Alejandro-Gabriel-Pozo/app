import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * SCHEMA-ANCHOR-DRIFT-001 (11/09/2026, `architecture-governor`, componente
 * "próximo bloque" del hallazgo original de `pendientes-2026-09-10.md`).
 *
 * Cualquier edición de `src/db/schema.sql` o `src/db/platform.schema.sql`
 * corre en silencio toda ancla `archivo.ts:N` posterior que cite una línea
 * de esos dos archivos -- pasó 2 veces (5 anclas en `f91d7ad`, 2 más en
 * `8fc30c3` aterrizando en paralelo) mientras el hallazgo original estaba
 * abierto. El fix de fondo ya se aplicó: **0 anclas de línea a los 2
 * schemas dentro de `src/`** (se cita por nombre -- tabla, constraint,
 * bloque -- no por línea). Esta cerca impide que el patrón reaparezca.
 *
 * ## ALCANCE
 * Cubre únicamente `src/` de este repo (`app-main`). NO cubre:
 *  - `docs/` -- tiene 293 anclas de línea a estos schemas hoy, deuda
 *    declarada, no se toca acá. Ampliar la cerca a `docs/` chocaría de
 *    frente con `docs/erp-auditoria-v2/00-programa-v2.md:20`, que EXIGE
 *    `archivo:linea` en toda marca `[V]` de sus fichas -- ampliar esto
 *    a `docs/` es su propio bloque, con su propia decisión del dueño.
 *  - `appfrontend-main/src/` -- otro repo, sin CI compartida.
 *  - Anclas a OTROS archivos `.ts` (no a los 2 schemas) -- ~42 vivas hoy,
 *    se mueven solas con el desarrollo normal, no es lo que este hallazgo
 *    ataca.
 *  - Otros `.sql` (`seed.*.sql`, `migrations/*.sql`) -- fuera de alcance,
 *    no investigado.
 *
 * ## RELACIÓN CON `docs/erp-auditoria-v2/scripts/validar-anclas.py`
 * Concern DISTINTO, superficie disjunta. `validar-anclas.py` recorre solo
 * `docs/erp-auditoria-v2/**\/*.md` y valida RESOLUBILIDAD (¿el archivo
 * citado existe y tiene esa cantidad de líneas?) -- dejaría pasar en
 * verde una cita por línea a `platform.schema.sql` cuyo número ya apunta
 * a otra cosa, que es exactamente el modo de falla que esta cerca ataja.
 * Esta cerca vigila
 * `src/` y valida FORMA (¿existe siquiera una cita por línea a estos 2
 * archivos?), no resolubilidad. No hay fuente de verdad duplicada.
 *
 * ## SI ESTO ROMPE
 * La corrección es citar por NOMBRE (tabla, constraint, bloque, sección),
 * nunca arreglar el número de línea -- el número vuelve a pudrirse en la
 * próxima edición del schema. Ver la doctrina completa en
 * `docs/pendientes-2026-09-10.md`, hallazgo `SCHEMA-ANCHOR-DRIFT-001`.
 *
 * ## FALSOS NEGATIVOS DECLARADOS
 *  1. Solo matchea la forma `schema.sql:N` (con o sin rango `:N-M`, ya que
 *     el rango entra por el prefijo `:N`). Una continuación de rango sin
 *     repetir el nombre del archivo (ej. `, también \`:30\``) es invisible.
 *  2. No cubre otros `.sql` del repo ni `docs/` (ver ALCANCE).
 *  3. Deliberadamente SIN `stripComments()` -- a diferencia de
 *     `reversed-invoice-id-convention.test.ts` (el exemplar de este
 *     patrón en el repo), que saca comentarios antes de matchear. Acá es
 *     al revés A PROPÓSITO: casi todas las anclas de línea que este
 *     hallazgo corrigió vivían en docblocks. Si esta cerca sacara
 *     comentarios, quedaría verde para siempre -- nunca vería el lugar
 *     real donde el patrón reaparece.
 *  4. Deliberadamente SIN excluir `*.test.ts` -- por el mismo motivo:
 *     un test nuevo puede citar una línea de schema en su propio
 *     docblock tan fácil como un archivo de producción.
 *  5. Deliberadamente SIN allowlist. Un allowlist vacío invita a que la
 *     primera excepción entre en silencio -- si algún día aparece una
 *     necesidad legítima de citar una línea de schema, vuelve por gate,
 *     no se agrega una entrada acá sin revisión.
 */

/** Cita a una línea de cualquiera de los 2 schemas -- el nombre del
 *  archivo (con o sin separador de directorio, `/` o `\`) seguido de
 *  dos puntos y un número, sea una línea suelta o el inicio de un rango
 *  (el rango entra por el mismo prefijo "nombre + dos puntos + dígitos").
 *  NO matchea una cita por nombre ("ver schema.sql, bloque ROLES",
 *  "platform.schema.sql BLOQUE PLAN_LIMITS"). */
const SCHEMA_LINE_ANCHOR_RE = /schema\.sql:\d+/;

function findAllFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findAllFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

describe('SCHEMA-ANCHOR-DRIFT-001 -- ninguna cita por línea a schema.sql/platform.schema.sql en src/', () => {
  it('ningún archivo de src/ cita una línea de los schemas -- las referencias son siempre por nombre', () => {
    const files = findAllFiles(SRC_DIR);
    const hits: string[] = [];

    for (const file of files) {
      const rel = relative(SRC_DIR, file).replace(/\\/g, '/');
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');
      for (const [i, line] of lines.entries()) {
        if (SCHEMA_LINE_ANCHOR_RE.test(line)) {
          hits.push(`${rel}:${i + 1}`);
        }
      }
    }

    expect(
      hits,
      'Se encontró una cita por LÍNEA a schema.sql/platform.schema.sql en src/ -- citá por NOMBRE (tabla, constraint, bloque) en vez de por número. Ver "SI ESTO ROMPE" en el docblock de este archivo.',
    ).toEqual([]);
  });

  // Anti-vacuidad -- una cerca con baseline 0 que nunca se vio fallar no es
  // evidencia de nada por sí sola. Las 3 de abajo prueban que el mecanismo
  // sigue vivo sin necesitar un ancla real en el repo (que sería, en sí
  // misma, la deuda que esta cerca existe para prevenir).
  it('anti-vacuidad -- la regex matchea la forma real (construida, no escrita literal para no auto-matchear)', () => {
    const synthetic = ['platform', '.', 'schema', '.', 'sql', ':', '285'].join('');
    expect(SCHEMA_LINE_ANCHOR_RE.test(synthetic)).toBe(true);
    const byName = 'ver platform.schema.sql, bloque PLAN_LIMITS';
    expect(SCHEMA_LINE_ANCHOR_RE.test(byName)).toBe(false);
  });

  it('anti-vacuidad -- el walker cubre los 2 schemas y al menos un *.test.ts, no solo .ts de producción', () => {
    const files = findAllFiles(SRC_DIR).map((f) => relative(SRC_DIR, f).replace(/\\/g, '/'));
    expect(files).toContain('db/schema.sql');
    expect(files).toContain('db/platform.schema.sql');
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(true);
  });

  it('anti-vacuidad -- los 2 schemas vigilados siguen existiendo con ese nombre', () => {
    expect(() => readFileSync(join(SRC_DIR, 'db/schema.sql'), 'utf-8')).not.toThrow();
    expect(() => readFileSync(join(SRC_DIR, 'db/platform.schema.sql'), 'utf-8')).not.toThrow();
  });
});
