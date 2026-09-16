import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * CONFIG-ENV-BASELINE-001 (16/09/2026, Wave 7 del plan de ejecución
 * integral, Etapa 8 / D-15, docs/auditoria-integral-fase16-2026-09-16.md:539:
 * "congelar el 30 actual con una cerca de conteo, antes de mover nada").
 *
 * Mismo criterio que `src/tests/security/rbac-matrix-sync.test.ts`: cuenta
 * accesos reales a `process.env` fuera de las zonas exentas y los compara
 * contra un número fijo -- no interpreta código, es una cerca eléctrica,
 * no un sistema que entiende configuración.
 *
 * Cubre `process.env.NOMBRE` y `process.env['NOMBRE']` con clave LITERAL --
 * NO los dos únicos estilos del árbol real (hallazgo del gate
 * `architecture-governor`, 16/09/2026, condición C7 de este mismo bloque,
 * "opción mínima"): hay dos formas más, sin cubrir, que este archivo deja
 * declaradas para que el bloque 3 (`config/env.ts`) no pueda leer "0 fuera
 * de config/env.ts" como completo mientras las ignore:
 * - `process.env[name]` con clave DINÁMICA (variable, no string literal) --
 *   `src/platform/neon-provisioning.ts:56`, resuelve `NEON_API_KEY`,
 *   `NEON_PROJECT_ID`, `NEON_TEMPLATE_BRANCH_ID` (líneas 78/108/109 de ese
 *   archivo) sin que esta cerca los vea.
 * - `process.env` como OBJETO completo (no una clave puntual) --
 *   `src/api/docs-exposure.ts:52`, `env: NodeJS.ProcessEnv = process.env`
 *   (default param).
 * Ninguno de los dos entra en `EXPECTED_FILE_COUNTS` de abajo -- el total
 * de esta cerca NO es "todo `process.env` del repo", es "todo acceso con
 * clave literal fuera de las zonas exentas". Cerrar este blindspot (opción
 * preferida del gate: extender `PROCESS_ENV_RE`) queda para el bloque 3.
 *
 * Falso negativo latente adicional, no activo hoy: `stripComments` corta
 * en el primer `//` de cada línea (mismo método que
 * `rbac-matrix-sync::stripComments`) -- un `process.env.X` que conviviera
 * con un `//` real en la misma línea (dentro de un string, una URL) no se
 * contaría. Verificado el 16/09/2026: ninguna línea no exenta hoy combina
 * las dos cosas.
 *
 * ZONAS EXENTAS, con motivo (ninguna es "no importa", cada una es un caso
 * real que no puede pasar por un `config/env.ts` centralizado):
 * - `*.test.ts` / `src/tests/**` -- infraestructura de test
 *   (`TEST_DATABASE_URL`, `CI`), no es superficie de configuración de
 *   producción.
 * - `src/instrument.ts` -- lee `SENTRY_DSN`/`NODE_ENV` ANTES de inicializar
 *   Sentry, que a su vez tiene que correr antes que cualquier otro módulo
 *   para poder capturar errores de carga de los demás -- no puede depender
 *   de un `config/env.ts` que todavía no se importó.
 * - `src/scripts/**` -- scripts de CLI standalone que corren fuera del
 *   proceso del server (mismo criterio ya declarado en
 *   `docs/auditoria-integral-fase16-2026-09-16.md:541`).
 *
 * MEDIDO el 16/09/2026 contra el árbol real, no heredado de la auditoría
 * previa (que citaba "30 vars en 26 archivos" -- ese número no sobrevivió
 * la re-verificación). Un primer conteo a mano, sin sacar
 * comentarios, había dado 41/19/23 -- incluía un falso positivo real:
 * `reservas/reservation.service.ts:33`, un docblock que dice textualmente
 * "el servicio NO lee process.env.BUSINESS_ID" (nota histórica), no un
 * acceso real. Mismo tipo de falso positivo que
 * `rbac-matrix-sync.test.ts` ya documenta para `reports.routes.ts` --
 * corregido a 40/18/22 antes de commitear esta cerca.
 *
 * Bajó a 38/18/21 en el mismo bloque (D-06/P-04, Wave 7, 16/09/2026): el
 * retiro de `repair-tenant-db` (`platform/admin.routes.ts`) se llevó 2 de
 * los 3 accesos de ese archivo (`DATABASE_URL`, un `DB_ENCRYPTION_KEY`) --
 * queda 1 (`DB_ENCRYPTION_KEY` de `set-tenant-url`).
 *
 * SI ESTO ROMPE: agregaste, sacaste o moviste un acceso a `process.env`
 * fuera de las zonas exentas. Actualizá `EXPECTED_FILE_COUNTS` (el archivo
 * que tocaste) en el mismo cambio -- el total se deriva solo, no lo edites
 * aparte. Si es parte de centralizar en `src/config/env.ts` (Wave 7,
 * bloques 3 en adelante), el objetivo final de ese bloque es dejar esta
 * cerca en 0 fuera de `config/env.ts` + las zonas exentas de arriba.
 */
const EXPECTED_FILE_COUNTS: Record<string, number> = {
  'api/routes/customer.routes.ts': 1,
  'app.ts': 7,
  'container.ts': 2,
  'db/pg.client.ts': 4,
  'email/email.sender.ts': 2,
  'logger.ts': 2,
  'platform/admin.routes.ts': 1,
  'platform/business.routes.ts': 1,
  'platform/platform.auth.middleware.ts': 1,
  'platform/platform.auth.service.ts': 2,
  'platform/tenant-db.setup.ts': 2,
  'platform/tenant.middleware.ts': 1,
  'security/auth.middleware.ts': 2,
  'security/auth.service.ts': 2,
  'security/customer.auth.service.ts': 2,
  'security/google-oauth.ts': 1,
  'server.ts': 2,
  'workers/outbox.registry.ts': 3,
};

const EXPECTED_PROCESS_ENV_COUNT = Object.values(EXPECTED_FILE_COUNTS).reduce((a, b) => a + b, 0);

const PROCESS_ENV_RE = /process\.env(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][A-Za-z_][A-Za-z0-9_]*['"]\])/g;

function toPosix(p: string): string {
  return p.split('\\').join('/');
}

function isExempt(relPath: string): boolean {
  if (relPath === 'instrument.ts') return true;
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
 * sume al conteo real. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

describe('Superficie de configuración -- process.env fuera de config/env.ts, congelada (D-15)', () => {
  it(`hay ${EXPECTED_PROCESS_ENV_COUNT} accesos a process.env fuera de las zonas exentas`, () => {
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
      'El desglose por archivo cambió -- un total igual con un desglose distinto ' +
        '(una var que se movió de un archivo a otro sin cambiar el total) no lo ' +
        'detecta un conteo global solo. Actualizá EXPECTED_FILE_COUNTS.',
    ).toEqual(EXPECTED_FILE_COUNTS);

    expect(total).toBe(EXPECTED_PROCESS_ENV_COUNT);
  });
});
