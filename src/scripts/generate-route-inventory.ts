#!/usr/bin/env node
/**
 * @file generate-route-inventory.ts
 * @description Genera `docs/inventario-rutas.md` -- inventario de QUÉ RUTAS
 * EXISTEN en la API real, no a mano y no por regex sobre texto: booteando
 * `createApp()` de verdad y caminando `app._router.stack`, el árbol vivo de
 * Express. `CONTRACT-COVERAGE-001` (docs/pendientes-2026-09-08.md):
 * `src/openapi/spec.ts` documenta 18 de 251 endpoints reales -- opción (A)
 * elegida por el dueño el 09/09/2026: un inventario navegable de existencia,
 * sin schemas de request/response y **sin autorización** (ver "Lo que este
 * inventario NO dice" más abajo).
 *
 * ## Por qué caminar el árbol vivo y no parsear `app.ts` con regex
 * Ya hubo dos intentos fallidos de esto en la sesión de CONTRACT-001: un
 * mount como `app.use(prefix, requireModule(...), routerFn(...))` rompe un
 * regex ingenuo, y `/api/reports` va más allá -- arma el router DENTRO de un
 * closure de middleware por request (`app.ts:393-419`), así que ni siquiera
 * existe al momento de bootear. El árbol vivo de Express resuelve todos los
 * prefijos de montaje normales automáticamente (gate `architecture-governor`,
 * 09/09/2026, spike verificado: `createApp()` completa en ~8ms con una
 * `PLATFORM_DATABASE_URL` dummy -- los pools de `pg` son perezosos, no
 * conectan hasta la primera query real).
 *
 * ## Lo que el árbol vivo NO puede ver -- CLOSURE_MOUNTS
 * Seis mounts arman su router recién adentro de un middleware por-request
 * (construido desde `req.db`, no al boot): `/api/reports`, `/api/system`,
 * `/api/housekeeping`, `/api/maintenance-windows`, `/api/stays`,
 * `/api/accounts-receivable`. Al caminar el árbol al boot, esos 6 aparecen
 * como una función anónima sin `.stack` -- 0 rutas debajo, confirmado por
 * spike. Sus 40 endpoints (verificado: 11+2+11+4+9+3) se extraen por regex
 * de su `*.routes.ts`, EXACTAMENTE como ya hace `MOUNT_TO_ROUTES_FILE` de
 * `src/tests/architecture/openapi-spec-route-sync.test.ts` -- mismo criterio
 * de allowlist chico con motivo por entrada, no una excepción muda. Es el
 * **octavo** artefacto manual de este repo (ver `app-main/CLAUDE.md`,
 * sección "Contratos").
 *
 * `CLOSURE_MOUNTS` se verifica en las DOS direcciones, mismo criterio que
 * `PUBLIC_ROUTES`/`EXCLUDED_ROWS`: (i) si el árbol vivo encuentra un mount
 * `/api/...` con 0 rutas que NO está en `CLOSURE_MOUNTS`, este script
 * FALLA -- no emite un inventario incompleto en silencio; (ii) si una
 * entrada de `CLOSURE_MOUNTS` YA tiene rutas observadas en el árbol vivo
 * (alguien refactorizó ese mount para que arme el router al boot), también
 * FALLA -- la entrada quedó obsoleta y hay que sacarla.
 *
 * ## Lo que este inventario NO dice
 * - **NO dice quién puede pegarle a cada ruta.** `authorize(Roles.X)` /
 *   `requireModule(...)` / `authorizePlatform(...)` capturan el permiso
 *   adentro de un closure (`src/security/auth.middleware.ts:367`): la
 *   función que llega al árbol de Express es una arrow anónima sin ninguna
 *   propiedad que exponga qué rol exige. Esa pregunta ya tiene dueño --
 *   `docs/rbac-matriz-endpoints.md` + 7 cercas en `src/tests/` -- y
 *   cruzarla contra este inventario es un bloque aparte, no este.
 * - **NO dice la forma del request/response** (`spec.ts` sigue siendo el
 *   único artefacto con eso, aunque solo para 18 de 251).
 * - **Depende de `NODE_ENV`.** Generado con `NODE_ENV=development` a
 *   propósito (da el inventario más completo) -- `/` y `/openapi.json`
 *   (`src/app.ts:246-247`) NO existen en producción
 *   (`shouldExposeApiDocs()`, `src/api/docs-exposure.ts`). Marcadas
 *   explícitamente en el artefacto generado.
 *
 * ## Uso
 *   npx tsx src/scripts/generate-route-inventory.ts
 * O vía npm script: `npm run docs:routes`
 *
 * Corre en CI (`.github/workflows/ci.yml`, job `route-inventory-check`) y
 * falla el build si el artefacto commiteado quedó desincronizado -- mismo
 * molde que `schema-version-check` (un artefacto derivado se versiona junto
 * al código, y un job de CI lo re-genera y compara, no lo confía a que
 * alguien se acuerde).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Fijado explícito, no heredado del shell -- el inventario tiene que ser
// reproducible sin importar en qué NODE_ENV corra quien lo invoque.
process.env['NODE_ENV'] = 'development';
process.env['PLATFORM_DATABASE_URL'] ??= 'postgres://dummy:dummy@localhost:5432/dummy';
process.env['JWT_SECRET'] ??= 'dummy-jwt-secret-route-inventory-only';
process.env['DB_ENCRYPTION_KEY'] ??= '0'.repeat(64);

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '..');
const REPO_ROOT = join(SRC_DIR, '..');
const OUT_PATH = join(REPO_ROOT, 'docs', 'inventario-rutas.md');

type Route = { method: string; path: string; source: 'live' | 'closure' };

/** Prefijo de montaje -> archivo *.routes.ts, relativo a src/, SOLO para los
 *  6 mounts que arman su router en un closure por-request y por eso el árbol
 *  vivo no los ve. Motivo repetido a propósito en cada entrada -- no un
 *  párrafo compartido -- mismo criterio que las otras 7 allowlists del repo. */
const CLOSURE_MOUNTS: Record<string, { file: string; motivo: string }> = {
  '/api/reports': {
    file: 'api/routes/reports.routes.ts',
    motivo: 'app.ts:393-419 arma el router dentro de un middleware por request (usa req.db), no al boot.',
  },
  '/api/system': {
    file: 'api/routes/system.routes.ts',
    motivo: 'app.ts arma el router dentro de un middleware por request (usa req.db), no al boot.',
  },
  '/api/housekeeping': {
    file: 'pms-estadias/housekeeping.routes.ts',
    motivo: 'app.ts arma el router dentro de un middleware por request (usa req.db), no al boot.',
  },
  '/api/maintenance-windows': {
    file: 'pms-estadias/maintenance-windows.routes.ts',
    motivo: 'app.ts arma el router dentro de un middleware por request (usa req.db), no al boot.',
  },
  '/api/stays': {
    file: 'pms-estadias/stays.routes.ts',
    motivo: 'app.ts arma el router dentro de un middleware por request (usa req.db), no al boot.',
  },
  '/api/accounts-receivable': {
    file: 'clientes-finanzas/accounts-receivable.routes.ts',
    motivo: 'app.ts arma el router dentro de un middleware por request (usa req.db), no al boot.',
  },
};

/** Mounts que existen en el árbol pero no son un router de rutas de negocio
 *  -- Swagger UI sirviendo archivos estáticos. Fuera de alcance de este
 *  inventario (no es "una ruta de la API", es un visor). */
const EXCLUDED_PREFIXES = new Set(['/docs']);

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks.split('\n').map((line) => line.split('//')[0]).join('\n');
}

/** Extrae router.<método>('<path>', ...) de un *.routes.ts -- mismo patrón
 *  que MOUNT_TO_ROUTES_FILE en openapi-spec-route-sync.test.ts. */
function extractClosureRoutes(prefix: string, relFile: string): Route[] {
  const fullPath = join(SRC_DIR, relFile);
  let content: string;
  try {
    content = readFileSync(fullPath, 'utf-8');
  } catch {
    throw new Error(
      `CLOSURE_MOUNTS['${prefix}'] apunta a '${relFile}', que no existe. ¿Se movió o renombró el archivo?`,
    );
  }
  const code = stripComments(content);
  const routes: Route[] = [];
  for (const method of METHODS) {
    const re = new RegExp(String.raw`\brouter\.${method}\s*\(\s*['"\`]([^'"\`]*)['"\`]`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const suffix = m[1] === '/' ? '' : m[1];
      routes.push({ method: method.toUpperCase(), path: prefix + suffix, source: 'closure' });
    }
  }
  if (routes.length === 0) {
    throw new Error(
      `CLOSURE_MOUNTS['${prefix}'] (${relFile}) no tiene ningún router.<método>() -- ¿el archivo cambió de forma? El allowlist quedó obsoleto.`,
    );
  }
  return routes;
}

/** Forma interna (no pública, no tipada por @types/express) de un Layer de
 *  Express 4 dentro de `app._router.stack`. Estable en la práctica -- es la
 *  misma forma que usa el propio Express internamente desde hace años -- pero
 *  no es API pública, por eso se declara acá en vez de importarla. */
interface ExpressLayer {
  route?: { path: string; methods: Record<string, boolean> };
  regexp?: { source: string };
  name?: string;
  handle?: { stack?: ExpressLayer[] };
}

/** Resuelve el prefijo de montaje de un Layer de Express 4 a partir de su
 *  regexp (formato estándar: ^\/api\/products\/?(?=\/|$)). `undefined` si
 *  el regexp no tiene esa forma (middlewares globales tipo helmet en '/'). */
function mountPrefixOf(layer: ExpressLayer): string | undefined {
  const src: string | undefined = layer.regexp?.source;
  if (!src) return undefined;
  const m = src.match(/^\^((?:\\\/[^\\]+)*)\\\/\?/);
  const captured = m?.[1];
  if (!captured) return undefined;
  const prefix = captured.replace(/\\\//g, '/');
  return prefix === '' ? undefined : prefix;
}

function walkLive(stack: ExpressLayer[], prefix: string, routes: Route[], mountsSeen: Set<string>): void {
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const routePath = prefix + route.path;
      const methods = Object.keys(route.methods).filter((m) => route.methods[m]);
      for (const m of methods) routes.push({ method: m.toUpperCase(), path: routePath, source: 'live' });
    } else if (layer.name === 'router' && layer.handle?.stack) {
      const seg = mountPrefixOf(layer) ?? '';
      const fullPrefix = prefix + seg;
      if (seg) mountsSeen.add(fullPrefix);
      walkLive(layer.handle.stack, fullPrefix, routes, mountsSeen);
    } else {
      const seg = mountPrefixOf(layer);
      if (seg) mountsSeen.add(prefix + seg);
    }
  }
}

async function main() {
  const { createApp } = await import('../app.js');
  const { stopCompanySyncWorker } = await import('../platform/company-sync.registry.js');
  const { closePlatformPool } = await import('../container.js');

  const { app } = await createApp();

  const liveRoutes: Route[] = [];
  const mountsSeen = new Set<string>();
  const internals = app as unknown as { _router?: { stack?: ExpressLayer[] }; router?: { stack?: ExpressLayer[] } };
  const rootStack = internals._router?.stack ?? internals.router?.stack;
  if (!rootStack) {
    throw new Error(
      'No encontré app._router.stack ni app.router.stack -- ¿cambió la versión de Express o su estructura interna? Este script asume Express 4.',
    );
  }
  walkLive(rootStack, '', liveRoutes, mountsSeen);

  // Bidireccional (i): todo mount /api/... con 0 rutas vivas tiene que estar
  // en CLOSURE_MOUNTS -- si no, este script no sabe qué hay ahí y no puede
  // emitir un inventario completo en silencio.
  const liveApiPrefixes = new Set(liveRoutes.filter((r) => r.path.startsWith('/api/')).map((r) => r.path));
  const unexplainedMounts: string[] = [];
  for (const prefix of mountsSeen) {
    if (!prefix.startsWith('/api/') || prefix === '/api') continue;
    if (EXCLUDED_PREFIXES.has(prefix)) continue;
    const hasLiveRoutes = [...liveApiPrefixes].some((p) => p === prefix || p.startsWith(`${prefix}/`));
    if (!hasLiveRoutes && !(prefix in CLOSURE_MOUNTS)) {
      unexplainedMounts.push(prefix);
    }
  }
  if (unexplainedMounts.length > 0) {
    throw new Error(
      `Encontré mount(s) bajo /api sin ninguna ruta viva y sin entrada en CLOSURE_MOUNTS -- ¿un router nuevo se está armando en un closure por request?\n  ${unexplainedMounts.join('\n  ')}`,
    );
  }

  // Bidireccional (ii): toda entrada de CLOSURE_MOUNTS tiene que seguir
  // siendo un mount sin rutas vivas -- si alguien lo refactorizó para armar
  // el router al boot, la entrada quedó obsoleta.
  const staleClosureEntries = Object.keys(CLOSURE_MOUNTS).filter((prefix) => {
    const hasLiveRoutes = [...liveApiPrefixes].some((p) => p === prefix || p.startsWith(`${prefix}/`));
    return hasLiveRoutes;
  });
  if (staleClosureEntries.length > 0) {
    throw new Error(
      `CLOSURE_MOUNTS tiene entradas que ya no hacen falta -- el árbol vivo ya encuentra rutas ahí (¿se refactorizó el mount?). Sacalas de CLOSURE_MOUNTS y dejá que el árbol vivo las resuelva:\n  ${staleClosureEntries.join('\n  ')}`,
    );
  }

  const closureRoutes: Route[] = [];
  for (const [prefix, { file }] of Object.entries(CLOSURE_MOUNTS)) {
    closureRoutes.push(...extractClosureRoutes(prefix, file));
  }

  const allRoutes = [...liveRoutes, ...closureRoutes].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  writeInventory(allRoutes, liveRoutes.length, closureRoutes.length);

  await stopCompanySyncWorker();
  await closePlatformPool();
}

function writeInventory(routes: Route[], liveCount: number, closureCount: number): void {
  const conditionalNote =
    '`/` y `/openapi.json` (`src/app.ts:246-247`) solo existen cuando `NODE_ENV !== \'production\'` ' +
    "(`shouldExposeApiDocs()`, `src/api/docs-exposure.ts`) -- este inventario se generó con " +
    "`NODE_ENV=development` a propósito, así que las incluye. En producción, esas 2 rutas no existen.";

  const lines: string[] = [];
  lines.push('# Inventario de rutas — generado, no editar a mano');
  lines.push('');
  lines.push(`**GENERADO.** Regenerar con \`npm run docs:routes\`. No editar este archivo directamente -- el`);
  lines.push('job `route-inventory-check` de CI falla el build si queda desincronizado.');
  lines.push('');
  lines.push('- Cuándo se regeneró por última vez: ver `git log -1 -- docs/inventario-rutas.md` (sin timestamp acá adentro a propósito -- un timestamp en el contenido rompería el chequeo de CI, que compara el archivo generado contra el commiteado byte a byte para detectar drift, no para saber cuándo corrió).');
  lines.push('- `NODE_ENV` usado para generarlo: `development`');
  lines.push(`- Total: **${routes.length}** endpoints (${liveCount} observados en el árbol vivo de Express + ${closureCount} declarados vía \`CLOSURE_MOUNTS\`, ver el header de \`src/scripts/generate-route-inventory.ts\`)`);
  lines.push('- Este inventario dice QUÉ RUTAS EXISTEN. NO dice quién puede pegarles (ver `docs/rbac-matriz-endpoints.md`) ni la forma del request/response (ver `src/openapi/spec.ts`, parcial).');
  lines.push(`- ${conditionalNote}`);
  lines.push('');
  lines.push('| Método | Ruta | Origen |');
  lines.push('|---|---|---|');
  for (const r of routes) {
    const origen = r.source === 'live' ? 'árbol vivo' : '`CLOSURE_MOUNTS`';
    lines.push(`| ${r.method} | \`${r.path}\` | ${origen} |`);
  }
  lines.push('');

  writeFileSync(OUT_PATH, lines.join('\n'), 'utf-8');
  console.log(`Escribí ${routes.length} rutas en ${OUT_PATH}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
