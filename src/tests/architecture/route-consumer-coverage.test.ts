import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../../..');
const INVENTORY_MD = join(REPO_ROOT, 'docs/inventario-rutas.md');

/**
 * D-23(1) (16/09/2026, Wave 3 del plan de ejecución integral,
 * docs/auditoria-integral-fase14-2026-09-16.md F14-01 -- "35 de 262
 * endpoints (13%) no tienen ningún consumidor, y nada en el repo puede
 * detectarlo", cita textual de F14-01 -- inventario al escribirse esta
 * cerca: 264; corrección Wave 7/D-06 (16/09/2026, retiro de
 * repair-tenant-db): 263, ver docs/inventario-rutas.md -- esta cita no se
 * había actualizado hasta la retrospectiva de Waves 1-7 (17/09/2026,
 * auditor-estructura). No afecta la mecánica de la cerca (parsea el
 * archivo, no el número). `docs/inventario-rutas.md` dice QUÉ RUTAS EXISTEN
 * (`CONTRACT-COVERAGE-001`); `docs/rbac-matriz-endpoints.md` + 7 cercas
 * dicen QUIÉN PUEDE PEGARLES; nada decía QUIÉN LAS USA -- esta cerca es
 * ese tercer artefacto. Mismo patrón que `CLOSURE_MOUNTS`/
 * `PUBLIC_ROUTES`/`EXCLUDED_FILES`: allowlist chico con motivo,
 * verificado en las dos direcciones.
 *
 * ## Por qué NO corre en CI real, y por qué eso está bien
 *
 * `appfrontend-main` es un repo DISTINTO -- `.github/workflows/ci.yml` de
 * ESTE repo solo hace `actions/checkout` de sí mismo, nunca clona el
 * frontend. Un cruce inventario×consumidores necesita el código del
 * frontend disponible en disco: no es un hueco de esta cerca, es una
 * restricción real de CI de un repo, no del otro. Por eso `findFrontendSrc()`
 * busca el sibling repo por convención de path (mismo criterio que
 * `skipIfNoDb` de `src/tests/integration/helpers/db.ts` para
 * `TEST_DATABASE_URL`) y, si no lo encuentra, la suite entera se saltea
 * limpio -- no falla, no miente con un verde vacío disfrazado de cruce
 * real. Corre de verdad en cualquier sesión que tenga los dos repos
 * clonados lado a lado (el layout que `CLAUDE.md` raíz de "App -
 * frontend/" describe), y ahí SÍ hace el cruce mecánico real, no una
 * aproximación.
 *
 * ## Qué NO garantiza
 *   1. Cruza por PATH normalizado, no por método HTTP -- si `/api/foo`
 *      tiene GET+POST y el frontend solo llama GET, esta cerca ve el path
 *      como "con consumidor" igual. La tabla original de F14-01 (35
 *      métodos) tiene ese detalle más fino; acá alcanza con "¿alguien le
 *      pega a este path, aunque sea con un método?" para la pregunta que
 *      importa (¿se puede borrar?).
 *   2. No mira clientes fuera de `appfrontend-main` (otro cliente HTTP,
 *      un script externo, un consumidor de terceros) -- F14-01 ya declaró
 *      esa misma limitación ("Media-baja" de certeza para "sin consumidor
 *      en absoluto"), no la resuelve esta cerca tampoco.
 *   3. Un literal de path armado por concatenación dinámica no trivial
 *      (no `${expr}` simple) es invisible -- mismo criterio que
 *      `api-auth-gate-order.test.ts` declara para sus propios mounts.
 *
 * SI ESTO ROMPE:
 *   - Un path de `NO_CONSUMER_ROUTES` apareció con consumidor nuevo en el
 *     frontend: sacalo del allowlist -- ya no es huérfano, no hace falta
 *     tocar nada más.
 *   - Un path SIN consumidor no está en `NO_CONSUMER_ROUTES`: o es una
 *     ruta nueva sin UI todavía (agregala al allowlist con motivo, mismo
 *     criterio que las 6 exclusiones ya declaradas en F14-01 para
 *     features de UI pendiente) o es una regresión real (alguien dejó de
 *     usar una ruta que antes se usaba) -- reportalo, no lo silencies
 *     agregándolo sin mirar por qué.
 *   - Una entrada de `NO_CONSUMER_ROUTES` ya no existe en el inventario
 *     (la ruta se borró o se renombró en el backend): sacala del
 *     allowlist -- si no, queda pudriéndose ahí para siempre, sin que
 *     ninguna de las otras dos aserciones se entere (mismo hueco que
 *     `EXCLUDED_FILES` de RBAC-MATRIX-SECTION2-001 declara para su propio
 *     caso -- acá sí se cierra, con la tercera aserción de abajo).
 */

const FRONTEND_DIR_NAMES = ['appfrontend', 'appfrontend-main'];

function findFrontendSrc(): string | null {
  const override = process.env.FRONTEND_REPO_DIR;
  if (override && existsSync(override)) return override;

  const parent = join(REPO_ROOT, '..');
  for (const name of FRONTEND_DIR_NAMES) {
    const candidate = join(parent, name, 'src');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const frontendSrc = findFrontendSrc();

/** Camina recursivamente un directorio y devuelve los .ts/.tsx (ignora node_modules/.next). */
function walkSourceFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...walkSourceFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Mismo patrón que el grep de F14-01: literales /api/..., /platform/... y
 * los 3 paths sueltos que el inventario tiene fuera de esos dos prefijos
 * (/register, /health, /health/db -- ninguno bajo /api ni /platform).
 */
const PATH_LITERAL_RE = /\/(?:api|platform)\/[A-Za-z0-9_\-/.:${}]*|\/register\b|\/health(?:\/db)?\b/g;

function normalizePath(path: string): string {
  return path
    // Un ${} pegado SIN '/' antes (ya colapsado por collapseTemplateExpressions,
    // que reduce cualquier ${expr} -- incluso uno con template anidado adentro --
    // a este mismo token) es querystring/sufijo (`businesses${}` de
    // `businesses${suffix}`, `late-checkouts${}` de
    // `late-checkouts${date ? ... : ''}`), no un segmento de path nuevo -- se
    // corta, no se convierte en comodín. Encontrado al correr esta cerca por
    // primera vez (16/09/2026): sin este paso, `/platform/businesses` y
    // `/api/housekeeping/late-checkouts` -- las dos CON consumidor real -- se
    // veían como huérfanas.
    .replace(/([^/])\$\{[^}]*\}.*$/, '$1')
    .replace(/\$\{[^}]*\}/g, ':p')
    .replace(/:[A-Za-z0-9_]+/g, ':p')
    .replace(/\/+$/, ''); // sin barra final
}

/**
 * Quita comentarios de línea y de bloque antes de buscar paths -- sin esto,
 * un comentario que DOCUMENTA la ausencia de un consumidor (ej.
 * `// Sin GET /api/stays/:id`, presente por duplicado en
 * `estadias/[id]/page.tsx:78` y `refine/dataProvider.ts:209`) se contaba
 * como si fuera el consumidor real, encubriendo exactamente el hueco que
 * esta cerca existe para detectar.
 *
 * Un solo pasada, carácter por carácter -- no dos regex globales
 * independientes (una para bloque, otra para línea, corridas en secuencia
 * sobre el archivo entero). Encontrado al correr esta cerca:
 * `lib/customerApi.ts` tiene un comentario de línea real
 * (`// ... todos los endpoints bajo /api/customer/* -- /me*, y desde`) cuyo
 * TEXTO contiene los dos caracteres de apertura de comentario de bloque,
 * seguidos, pegados a "customer/". Con dos regex separadas, la de bloque
 * corre primero sobre el archivo entero y no sabe que esa secuencia está
 * adentro de un comentario de línea -- la toma como apertura real y busca
 * el cierre de bloque no relacionado más cercano DESPUÉS de ese punto (un
 * JSDoc a ~4800 caracteres de distancia), tragándose casi 60% del archivo,
 * código real incluido. Procesando en orden real -- si se ve el comentario
 * de línea primero, se saltea hasta el fin de línea ANTES de poder
 * interpretar cualquier apertura de bloque que esa misma línea contenga --
 * esto no pasa.
 *
 * Best-effort, no un parser real de JS/TS: no distingue comentario de
 * string/template literal, así que esas mismas dos secuencias dentro de un
 * string (ej. una URL `http` con doble slash) se tratan igual que un
 * comentario real -- mismo tipo de límite ya declarado en el docblock de
 * arriba (punto 3). El modo de falla es seguro: en el peor caso un path
 * real queda sin detectar y la primera prueba lo reporta como no
 * declarado (falla ruidosa, no un verde falso), nunca al revés.
 */
function stripComments(content: string): string {
  let result = '';
  let i = 0;
  let inBlock = false;
  while (i < content.length) {
    if (inBlock) {
      if (content[i] === '*' && content[i + 1] === '/') {
        inBlock = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (content[i] === '/' && content[i + 1] === '*') {
      inBlock = true;
      i += 2;
      continue;
    }
    if (content[i] === '/' && content[i + 1] === '/') {
      while (i < content.length && content[i] !== '\n') i++;
      continue;
    }
    result += content[i];
    i++;
  }
  return result;
}

/**
 * Colapsa cada `${...}` -- incluso con un template literal anidado adentro
 * con su propio `${...}`, como
 * `` `/api/housekeeping/late-checkouts${date ? `?date=${date}` : ''}` `` --
 * a `${}` antes de correr `PATH_LITERAL_RE`. Sin esto, el regex principal
 * (que ya admite `$`/`{`/`}` en su character class) se cortaba en el primer
 * carácter fuera de esa clase (un espacio, un backtick) DENTRO de la
 * expresión, dejando un match roto (`.../late-checkouts${date`, sin
 * cerrar) que `normalizePath()` no podía limpiar -- la ruta parecía
 * huérfana aunque tenía consumidor real. Cuenta profundidad de llaves a
 * secas, sin parsear strings: alcanza porque las llaves de una expresión
 * JS válida están balanceadas: un `{`/`}` suelto dentro de un string
 * literal de la expresión rompería esto -- mismo tipo de límite que el
 * punto 3 del docblock.
 */
function collapseTemplateExpressions(content: string): string {
  let result = '';
  let i = 0;
  while (i < content.length) {
    if (content[i] === '$' && content[i + 1] === '{') {
      let depth = 1;
      let j = i + 2;
      while (j < content.length && depth > 0) {
        if (content[j] === '{') depth++;
        else if (content[j] === '}') depth--;
        j++;
      }
      result += '${}';
      i = j;
    } else {
      result += content[i];
      i++;
    }
  }
  return result;
}

function collectFrontendPaths(srcDir: string): Set<string> {
  const paths = new Set<string>();
  for (const file of walkSourceFiles(srcDir)) {
    const raw = readFileSync(file, 'utf-8');
    const content = collapseTemplateExpressions(stripComments(raw));
    for (const match of content.matchAll(PATH_LITERAL_RE)) {
      paths.add(normalizePath(match[0]));
    }
  }
  return paths;
}

interface InventoryRoute { method: string; path: string }

function parseInventory(): InventoryRoute[] {
  const content = readFileSync(INVENTORY_MD, 'utf-8');
  const routes: InventoryRoute[] = [];
  const rowRe = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`\s*\|/;
  for (const line of content.split('\n')) {
    const m = line.match(rowRe);
    if (m) routes.push({ method: m[1]!, path: m[2]! });
  }
  return routes;
}

/**
 * Los 29 paths de F14-01 sin consumidor conocido en appfrontend-main,
 * verificados un día antes del HEAD de esta cerca (15/09/2026, ver la
 * tabla completa en docs/auditoria-integral-fase14-2026-09-16.md F14-01).
 * Motivo por familia, no "no se usa" a secas -- D-23 pide no borrar
 * ninguno todavía, así que el motivo es siempre "sin consumidor conocido
 * en estos 2 repos, ver F14-01 antes de tocar" salvo que se indique otra
 * cosa.
 */
const NO_CONSUMER_ROUTES: Record<string, string> = {
  '/api/cash-register': 'D-24 (Wave 3): circuito de Caja completo, cero UI -- fila de roadmap ya agregada, completar la UI es Wave 14.',
  '/api/cash-register/:p': 'D-24, ídem.',
  '/api/cash-register/current': 'D-24, ídem.',
  '/api/cash-register/open': 'D-24, ídem.',
  '/api/cash-register/close': 'D-24, ídem.',
  '/api/cancellation-policies': 'F14-01: sin consumidor conocido, no decidido todavía.',
  '/api/cancellation-policies/:p': 'F14-01, ídem.',
  '/api/rate-catalog': 'F14-01, ídem.',
  '/api/rate-catalog/:p': 'F14-01, ídem.',
  '/api/reports/pos/sales-by-product': 'F14-01, ídem.',
  '/api/reports/pos/ticket-summary': 'F14-01, ídem.',
  '/api/reports/pos/waste': 'F14-01, ídem.',
  '/api/reports/crm/applied-rates': 'F14-01, ídem.',
  '/api/reports/crm/new-vs-recurring': 'F14-01, ídem.',
  '/api/reports/occupancy/purge': 'F14-01, ídem.',
  '/api/products/:p/stock/decrement': 'F14-01, ídem.',
  '/api/products/:p/variants/:p/stock/decrement': 'F14-01, ídem.',
  '/api/products/stock/transfer': 'F14-01, ídem.',
  '/api/stays/:p': 'F14-01 -- OJO: el frontend documenta POR DUPLICADO que cree que esta ruta no existe (estadias/[id]/page.tsx:78, refine/dataProvider.ts:209), ver F14-18. Existe.',
  '/api/stays/reservation/:p': 'F14-01, ídem.',
  '/api/stays/resource/:p': 'F14-01, ídem.',
  '/api/housekeeping/:p': 'F14-01, ídem.',
  '/api/housekeeping/resource/:p': 'F14-01, ídem.',
  '/api/locations': 'F14-01, ídem.',
  '/api/audit-log': 'F14-01, ídem.',
  '/api/business/modules': 'F14-01, confirmado también por el gate de Wave 2 capa 2 (CUSTOMER-STAFF-MOUNT-PRE-TENANT-001): el gating de módulos del dashboard pasa por /api/business/context, no por acá.',
  '/api/invoices/unreconciled': 'F14-01, ídem.',
  '/api/customers/padron/iva-receptor-types': 'F14-01, ídem.',
  '/api/users/:p/reactivate': 'F14-01, ídem.',

  // Las 8 familias de abajo (12 paths -- credit-note-requests suma 3,
  // service-items suma 2, cancellation-refund suma 2) NO son parte de los
  // 29 huérfanos de F14-01 -- esa lista ya las excluía (con el mismo
  // motivo) porque tienen razón legítima de no aparecer en un cruce
  // inventario×consumidores: no son huérfanas por descuido, son huérfanas
  // por diseño (infra, gemelo CLI, built ayer con UI pendiente, o backlog
  // ya declarado).
  '/health': 'Probe de infraestructura (Render), no una ruta de negocio. F14-01.',
  '/health/db': 'Ídem -- probe de readiness, agregado 01/09/2026. F14-01.',
  '/platform/outbox/purge': 'Endpoint de operador con gemelo CLI (npm run purge:outbox) -- no se espera consumidor de UI. F14-01.',
  '/api/accounts-receivable/:p/reverse': 'Construido 14/09/2026 (Bloque 3c-iii), UI pendiente -- no abandonado. F14-01.',
  '/api/admin/set-tenant-url': 'Endpoint de superadmin, F7/F11 (SSRF acotado a SUPERADMIN) -- no se espera consumidor de dashboard/portal. F14-01.',
  '/api/credit-note-requests': 'Construido 15/09/2026 (commits 0c58a7a/321ab55), UI pendiente -- no abandonado. Track en curso, tarea #28. F14-01.',
  '/api/credit-note-requests/:p': 'Ídem.',
  '/api/credit-note-requests/:p/resolve': 'Ídem.',
  '/api/service-items': 'Construido 15/09/2026 (Bloque B), UI pendiente -- no abandonado. F14-01.',
  '/api/service-items/:p': 'Ídem.',
  '/api/reservations/:p/cancellation-refund/preview': 'Backlog ya declarado en app-main/CLAUDE.md, sección irreversible-action-gate (cancelación C2 sin preview/confirm de reembolso todavía en UI). F14-01.',
  '/api/reservations/:p/cancellation-refund/confirm': 'Ídem.',

  // ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.9/§3.14 --
  // las 3 rutas nuevas de la bandeja de reconciliación manual/AFIP, mismo
  // criterio que las 3 de /api/credit-note-requests de arriba: construidas
  // en este bloque, sin pantalla en appfrontend-main todavía -- no abandonadas.
  '/api/invoices/uncertain': 'Construido 23/09/2026 (ADR ISSUE-BEFORE-REVERSE-WINDOW-001 Bloque 3, §3.9), UI pendiente -- no abandonado.',
  '/api/invoices/:p/mark-not-issued': 'Ídem.',
  '/api/invoices/:p/reconcile-with-afip': 'Ídem, §3.14 (P-1).',

  // D-05/P-03 (24/09/2026, Wave 15) -- las 3 rutas nuevas de solicitud +
  // aprobación en dos pasos, mismo criterio que las familias de arriba
  // recién construidas: sin pantalla en appfrontend-main todavía (esta
  // implementación es solo el backend), no abandonadas.
  '/api/companies/link-requests': 'Construido 24/09/2026 (D-05/P-03, Wave 15), UI pendiente -- no abandonado.',
  '/api/companies/link-requests/:p/approve': 'Ídem.',
  '/api/companies/link-requests/:p/reject': 'Ídem.',

  // Fase 0 de "reserva por tipo de unidad con asignación diferida" (25/09/2026,
  // Wave 14 item 4.3, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6) --
  // endpoint de instrumentación construido para que el frontend, en Fase 2
  // (todavía no implementada), pueda mostrar "quedan N libres" antes del
  // alta por categoría. Backend-only por diseño en esta fase -- no abandonado.
  '/api/reservations/availability-by-category': 'Construido 25/09/2026 (Fase 0 de reserva por tipo de unidad, Wave 14 item 4.3), UI pendiente -- Fase 2 (consumo real desde el frontend) todavía no implementada.',

  // Hallazgo nuevo de esta cerca (16/09/2026, D-23(1)), no estaba en la lista
  // de 35 de F14-01 -- ese grep no distinguía /platform/businesses/:id (GET
  // de un negocio puntual) de sus 3 hermanos con sufijo (status/provision/
  // plan), todos con consumidor real en lib/platformApi.ts. El panel
  // superadmin lista (GET /platform/businesses) y muta por id, pero nunca
  // pide el detalle de un negocio puntual -- no hay pantalla de detalle.
  '/platform/businesses/:p': 'Sin consumidor: el panel superadmin lista y muta por id, pero no tiene pantalla de detalle que pida un negocio puntual. Hallazgo de esta cerca, no de F14-01.',
};

describe.skipIf(!frontendSrc)('D-23(1) -- inventario de rutas × consumidores reales de appfrontend-main', () => {
  it('todo path del inventario sin consumidor real está declarado en NO_CONSUMER_ROUTES con motivo', () => {
    const frontendPaths = collectFrontendPaths(frontendSrc!);
    const inventoryRoutes = parseInventory();
    expect(inventoryRoutes.length).toBeGreaterThan(0);

    const seen = new Set<string>();
    const undeclared: string[] = [];
    for (const route of inventoryRoutes) {
      const normalized = normalizePath(route.path);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      if (normalized === '' || normalized === '/openapi.json') continue; // '/' normaliza a '' (sin barra final) -- dev-only, ver docblock del generador

      const hasConsumer = frontendPaths.has(normalized);
      if (!hasConsumer && !(normalized in NO_CONSUMER_ROUTES)) {
        undeclared.push(normalized);
      }
    }

    expect(
      undeclared,
      'Estos paths del inventario NO tienen consumidor detectado en appfrontend-main y no están en ' +
        'NO_CONSUMER_ROUTES. Si es una ruta nueva sin UI todavía, declarala con el motivo (mismo criterio ' +
        'que F14-01). Si dejó de usarse, es una regresión real -- no la silencies sin mirar por qué.',
    ).toEqual([]);
  });

  it('no hay entradas stale en NO_CONSUMER_ROUTES (cada una sigue sin consumidor real)', () => {
    const frontendPaths = collectFrontendPaths(frontendSrc!);
    const stale = Object.keys(NO_CONSUMER_ROUTES).filter((p) => frontendPaths.has(p));

    expect(
      stale,
      'Estos paths de NO_CONSUMER_ROUTES YA tienen consumidor real en appfrontend-main -- sacalos del ' +
        'allowlist, no son huérfanos.',
    ).toEqual([]);
  });

  it('no hay entradas de NO_CONSUMER_ROUTES que ya no existan en el inventario', () => {
    const inventoryRoutes = parseInventory();
    const inventoryPaths = new Set(inventoryRoutes.map((route) => normalizePath(route.path)));
    const orphanedAllowlistEntries = Object.keys(NO_CONSUMER_ROUTES).filter((p) => !inventoryPaths.has(p));

    expect(
      orphanedAllowlistEntries,
      'Estos paths de NO_CONSUMER_ROUTES ya no existen en docs/inventario-rutas.md (la ruta se borró o se ' +
        'renombró en el backend) -- sacalos del allowlist, si no quedan pudriéndose ahí para siempre.',
    ).toEqual([]);
  });
});
