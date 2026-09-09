import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openApiSpec } from '../../openapi/spec.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../..');

/**
 * CONTRACT-001 (09/09/2026, gate `architecture-governor`) -- `spec.ts` es un
 * OpenAPI escrito a mano, NO generado desde las rutas reales. 3 de los 19
 * paths documentados daban 404 real hasta `a96aa90` (2 de `/api/reports` mal
 * escritos, 1 fantasma en `/api/resources`) -- ninguno se detectó por meses
 * porque nada cruzaba el spec contra el código.
 *
 * Esta cerca cierra esa falta de cruce, pero SOLO para lo que `spec.ts` YA
 * documenta: existencia de path+método en el `*.routes.ts` real
 * correspondiente. NO valida request/response schemas. NO exige que un
 * endpoint real esté documentado -- `spec.ts` cubre ~18 paths de **251**
 * reales (33 routers montados en `app.ts` sin ninguna entrada acá; el 251
 * es medido, no estimado -- ver `docs/inventario-rutas.md`). Cerrar esa
 * brecha es `CONTRACT-COVERAGE-001` (decisión de producto: mantener el spec
 * a mano vs. generarlo desde las rutas), no algo que esta cerca deba forzar.
 *
 * A propósito NO hay un `EXPECTED_*` de conteo tipo `rbac-matrix-sync.test.ts`:
 * el número de paths documentados puede, y debe poder, crecer sin romper esto.
 *
 * LO QUE ESTA CERCA NO VERIFICA (gate `architecture-governor`, 09/09/2026):
 * no verifica que `MOUNT_TO_ROUTES_FILE` siga apuntando al archivo que
 * `app.ts` monta realmente en cada prefijo -- el mapa es manual y se
 * verificó a mano contra `app.ts` (imports 46/48/49/51/64/70, mounts
 * 270/291/355/357/372/394) el 09/09/2026. Si un prefijo se re-monta a otro
 * router, esta cerca sigue verde validando contra el archivo viejo.
 * Re-verificar a mano al tocar los mounts de `app.ts` que aparecen acá.
 */

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Method = (typeof METHODS)[number];

/**
 * Prefijo de montaje real (`src/app.ts`) -> archivo `*.routes.ts`, relativo
 * a `src/`. Mapeo chico y verificado a mano contra `app.ts`, no un parser
 * genérico de mounts: al menos uno de los reales (`/api/reports`, ver
 * `app.ts:393-419`) arma el router DENTRO de un closure de middleware en vez
 * de `app.use(prefix, routerFn(...))` -- un regex genérico sobre `app.ts` no
 * lo matchea (mismo problema ya señalado en el gate de RBAC-SYNC-001).
 * Extender esta lista cuando `spec.ts` documente un prefijo nuevo.
 */
const MOUNT_TO_ROUTES_FILE: Record<string, string> = {
  '/api/login':            'api/routes/auth.routes.ts',
  '/api/admin':             'platform/admin.routes.ts',
  '/api/resources':         'reservas/resources.routes.ts',
  '/api/reservations':      'reservas/reservations.routes.ts',
  '/api/reports':           'api/routes/reports.routes.ts',
  '/api/bookable-services': 'reservas/bookable-services.routes.ts',
};

/**
 * Paths documentados que NO viven en ningún `*.routes.ts` -- son
 * `app.get()` directos en `src/app.ts`, con motivo. Regla: todo path de
 * `spec.ts` está en `MOUNT_TO_ROUTES_FILE` (via prefijo) o en esta lista.
 * No hay un tercer estado ("se ignora en silencio").
 */
const EXCLUDED_PATHS: Record<string, string> = {
  '/health':    'app.get() directo en src/app.ts:223, no es un router montado',
  '/health/db': 'app.get() directo en src/app.ts:231, no es un router montado',
};

const HANDLER_RE = /async\s*\(\s*_?req\b|\(\s*_?req\b|asyncHandler\s*\(/;

/** Igual que en las otras cercas de rutas del repo: saca comentarios antes
 *  de mirar, para no matchear un `router.get(...)` de ejemplo en un docblock. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

/** `''` -> `'/'` (el path documentado es EXACTAMENTE el prefijo de montaje,
 *  ej. `/api/login` -> real es `router.post('/')`); `{id}` -> `:id`
 *  (sintaxis de parámetro OpenAPI -> Express). */
function normalizeRemainder(specPath: string, prefix: string): string {
  const stripped = specPath.slice(prefix.length);
  const withColonParams = stripped.replace(/\{([^}]+)\}/g, ':$1');
  return withColonParams === '' ? '/' : withColonParams;
}

/** ¿El archivo declara `router.<method>(<remainder>, ...)`? Existencia por
 *  string exacto del primer argumento -- cerca eléctrica, no un parser real,
 *  mismo criterio que las otras 7 de este repo. */
function routeExists(fileContent: string, method: Method, remainder: string): boolean {
  const code = stripComments(fileContent);
  const callRe = new RegExp(String.raw`\brouter\.${method}\s*\(`, 'g');
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(code)) !== null) {
    const callStart = m.index + m[0].length;
    const after = code.slice(callStart, callStart + 400);
    const handlerAt = after.match(HANDLER_RE)?.index ?? -1;
    const chain = handlerAt >= 0 ? after.slice(0, handlerAt) : after;
    const path = chain.match(/^\s*['"`]([^'"`]*)['"`]/)?.[1];
    if (path === remainder) return true;
  }
  return false;
}

function collectSpecEndpoints(): Array<{ path: string; method: Method }> {
  const endpoints: Array<{ path: string; method: Method }> = [];
  for (const [path, item] of Object.entries(openApiSpec.paths)) {
    for (const method of METHODS) {
      if (item && typeof item === 'object' && method in (item as Record<string, unknown>)) {
        endpoints.push({ path, method });
      }
    }
  }
  return endpoints;
}

/** Entrada más específica de `MOUNT_TO_ROUTES_FILE` que cubre `path`, o
 *  `undefined` si ninguna lo cubre. `sort` por longitud de prefijo evita que
 *  uno corto le gane a uno más específico si algún día se solapan. Devuelve
 *  el par [prefijo, archivo] junto (no un prefijo suelto) para no depender
 *  de un segundo acceso indexado -- con `noUncheckedIndexedAccess` ese
 *  segundo acceso tipa `string | undefined` aunque la clave sea la misma
 *  que se acaba de encontrar. */
function findMount(path: string): [prefix: string, relFile: string] | undefined {
  return Object.entries(MOUNT_TO_ROUTES_FILE)
    .filter(([p]) => path === p || path.startsWith(`${p}/`))
    .sort(([a], [b]) => b.length - a.length)[0];
}

describe('CONTRACT-001 -- spec.ts vs rutas reales (existencia de path+método)', () => {
  it('todo path+método documentado en spec.ts resuelve a una ruta real, o está en EXCLUDED_PATHS', () => {
    const endpoints = collectSpecEndpoints();
    const violations: string[] = [];
    const usedPrefixes = new Set<string>();

    for (const { path, method } of endpoints) {
      if (path in EXCLUDED_PATHS) continue;

      const mount = findMount(path);
      if (!mount) {
        violations.push(
          `${method.toUpperCase()} ${path} -- ningún prefijo de MOUNT_TO_ROUTES_FILE lo cubre ` +
            `(¿falta agregarlo al mapa, o falta en EXCLUDED_PATHS?)`,
        );
        continue;
      }
      const [prefix, relFile] = mount;
      usedPrefixes.add(prefix);

      let content: string;
      try {
        content = readFileSync(join(SRC_DIR, relFile), 'utf-8');
      } catch {
        violations.push(
          `${method.toUpperCase()} ${path} -- MOUNT_TO_ROUTES_FILE['${prefix}'] = '${relFile}' no existe`,
        );
        continue;
      }

      const remainder = normalizeRemainder(path, prefix);
      if (!routeExists(content, method, remainder)) {
        violations.push(
          `${method.toUpperCase()} ${path} -- no hay router.${method}('${remainder}', ...) en ${relFile}`,
        );
      }
    }

    expect(
      violations,
      `spec.ts documenta rutas que no existen en el código real:\n  ${violations.join('\n  ')}`,
    ).toEqual([]);

    const stalePrefixes = Object.keys(MOUNT_TO_ROUTES_FILE).filter((p) => !usedPrefixes.has(p));
    expect(
      stalePrefixes,
      `MOUNT_TO_ROUTES_FILE tiene prefijos que ningún path de spec.ts usa (sacalos):\n  ${stalePrefixes.join('\n  ')}`,
    ).toEqual([]);
  });

  it('todo path de EXCLUDED_PATHS sigue documentado en spec.ts', () => {
    const stale = Object.keys(EXCLUDED_PATHS).filter((p) => !(p in openApiSpec.paths));
    expect(
      stale,
      `EXCLUDED_PATHS tiene entradas que ya no están en spec.ts (sacalas):\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });

  describe('normalizeRemainder', () => {
    it.each([
      ['/api/login', '/api/login', '/'],
      ['/api/resources/{id}', '/api/resources', '/:id'],
      ['/api/reports/occupancy/summary', '/api/reports', '/occupancy/summary'],
      ['/api/bookable-services/{id}/schedules/{scheduleId}', '/api/bookable-services', '/:id/schedules/:scheduleId'],
    ])('%s bajo prefijo %s -> %s', (specPath, prefix, expected) => {
      expect(normalizeRemainder(specPath, prefix)).toBe(expected);
    });
  });
});
