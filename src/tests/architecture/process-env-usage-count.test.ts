import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * CONFIG-ENV-BASELINE-001 (16-17/09/2026, Wave 7 del plan de ejecución
 * integral, Etapa 8 / D-15, `docs/auditoria-integral-fase16-2026-09-16.md:539`).
 *
 * Mismo criterio que `src/tests/security/rbac-matrix-sync.test.ts`: cuenta
 * accesos reales a `process.env` fuera de las zonas exentas -- no interpreta
 * código, es una cerca eléctrica.
 *
 * ## Historia -- por qué el número bajó a 0
 * Nació el 16/09/2026 CONGELANDO el estado de ANTES de mover nada (38
 * accesos / 18 archivos / 21 vars, con clave literal solamente -- ver
 * `git log -L` de este archivo para el detalle completo de esa medición,
 * incluidos 2 falsos positivos reales encontrados y descartados). El
 * bloque 3 de la misma Wave (`src/config/env.ts`, 17/09/2026) migró los 38
 * a un único punto de lectura + cerró los 2 blind spots que la primera
 * versión de esta cerca dejó documentados a propósito (gate
 * `architecture-governor`, 16/09/2026, condición C7): `process.env[name]`
 * con clave DINÁMICA (`neon-provisioning.ts`, migrado a recibir el valor ya
 * resuelto) y `process.env` como OBJETO completo
 * (`api/docs-exposure.ts` -- éste no se migra, ver exención permanente
 * abajo). El regex de esta cerca ahora cubre las 3 formas -- literal,
 * dinámica y objeto completo -- para que ninguna reaparezca sin que esta
 * cerca se entere.
 *
 * ZONAS EXENTAS, con motivo (ninguna es "no importa"):
 * - `*.test.ts` / `src/tests/**` -- infraestructura de test
 *   (`TEST_DATABASE_URL`, `CI`), no es superficie de configuración de
 *   producción.
 * - `src/instrument.ts` -- lee `SENTRY_DSN`/`NODE_ENV` ANTES de inicializar
 *   Sentry, que a su vez tiene que correr antes que cualquier otro módulo
 *   para poder capturar errores de carga de los demás -- no puede depender
 *   de `config/env.ts`, que todavía no se importó.
 * - `src/scripts/**` -- scripts de CLI standalone que corren fuera del
 *   proceso del server (`docs/auditoria-integral-fase16-2026-09-16.md:541`).
 * - `src/config/env.ts` -- ES el punto único de lectura. Que lea
 *   `process.env` es su trabajo, no una fuga.
 * - `src/api/docs-exposure.ts` -- EXENCIÓN PERMANENTE, no pendiente de
 *   cerrar (decisión explícita del gate `architecture-governor`,
 *   16/09/2026, condición C7). `shouldExposeApiDocs(env: NodeJS.ProcessEnv
 *   = process.env)` recibe el entorno como parámetro inyectable -- ya
 *   verificable en tests sin mutar estado global, un patrón MEJOR que el
 *   de este archivo para su caso puntual. Forzarlo a pasar por una función
 *   de acá sería downgrade.
 *
 * SI ESTO ROMPE: agregaste un acceso a `process.env` fuera de
 * `src/config/env.ts` y las zonas exentas de arriba. Agregalo a
 * `config/env.ts` en vez de al call site -- ese es el punto de este
 * archivo.
 */
const EXPECTED_FILE_COUNTS: Record<string, number> = {};

const EXPECTED_PROCESS_ENV_COUNT = Object.values(EXPECTED_FILE_COUNTS).reduce((a, b) => a + b, 0);

/**
 * 3 formas: `process.env.NOMBRE` (dot), `process.env[...]` (bracket, clave
 * literal o dinámica -- no importa cuál para esta cerca, cualquiera de las
 * dos fuera de `config/env.ts` es una fuga) y `process.env` bare (usado
 * como valor u objeto completo, no seguido de `.` ni `[`).
 */
const PROCESS_ENV_RE = /process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]*\]|(?![.[]))/g;

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function isExempt(relPath: string): boolean {
  if (relPath === 'instrument.ts') return true;
  if (relPath === 'config/env.ts') return true;
  if (relPath === 'api/docs-exposure.ts') return true;
  if (relPath.startsWith('tests/')) return true;
  if (relPath.startsWith('scripts/')) return true;
  if (relPath.endsWith('.test.ts')) return true;
  return false;
}

function findScopedFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...findScopedFiles(full));
    } else if (entry.endsWith('.ts')) {
      const rel = toPosix(relative(SRC_DIR, full));
      if (!isExempt(rel)) results.push(full);
    }
  }
  return results;
}

/** Saca comentarios de bloque `/* *\/` y de línea `//` antes de contar --
 * mismo criterio que `rbac-matrix-sync.test.ts::stripComments`, mismo
 * motivo: evitar que un docblock que MENCIONA `process.env.X` como ejemplo
 * sume al conteo real (caso real: `reservas/reservation.service.ts:33` y
 * los docblocks de migración de `business.routes.ts`/`neon-provisioning.ts`
 * que citan la forma vieja a propósito, como historial).
 *
 * Falso negativo latente, no cerrado (gate `architecture-governor`,
 * 17/09/2026, condición C1): corta en el PRIMER `//` de cada línea -- un
 * `process.env.X` real que compartiera línea con un `//` genuino (dentro de
 * un string, una URL) no se contaría. Con `EXPECTED_FILE_COUNTS = {}`, este
 * es hoy el ÚNICO camino por el que una fuga nueva podría quedar verde.
 * Verificado el 17/09/2026: ninguna línea no exenta combina las dos cosas
 * -- pero la propiedad no está garantizada para código futuro, solo
 * medida para el árbol de hoy. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

describe('Superficie de configuración -- process.env fuera de config/env.ts (D-15)', () => {
  it(`hay ${EXPECTED_PROCESS_ENV_COUNT} accesos a process.env fuera de config/env.ts y las zonas exentas`, () => {
    const files = findScopedFiles(SRC_DIR);
    let total = 0;
    const actualByFile: Record<string, number> = {};

    for (const file of files) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      const count = (code.match(PROCESS_ENV_RE) ?? []).length;
      if (count > 0) {
        actualByFile[toPosix(relative(SRC_DIR, file))] = count;
      }
      total += count;
    }

    expect(
      actualByFile,
      'Encontré acceso(s) a process.env fuera de config/env.ts. Movelos ahí, ' +
        'o si son legítimamente una excepción nueva, agregala a isExempt() con motivo.',
    ).toEqual(EXPECTED_FILE_COUNTS);

    expect(total).toBe(EXPECTED_PROCESS_ENV_COUNT);
  });
});
