import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_TS = join(__dirname, '../../app.ts');

/**
 * RBAC-MOUNT-001 (registrado en pendientes-2026-08-30.md; triage 07/09/2026
 * en pendientes-2026-09-06.md) -- `src/app.ts` monta
 * `app.use('/api', authenticate(...))` (hoy ~L317) y confía en que TODOS los
 * routers de tenant/empleado se monten DESPUÉS de esa línea. Nada lo
 * sostiene: `rbac-route-coverage.test.ts` declara explícito (su límite #2)
 * que NO valida el orden de montaje, y varias entradas de su `PUBLIC_ROUTES`
 * son seguras únicamente porque su `app.use(...)` va después del gate. Subir
 * un mount protegido por encima de esa línea lo deja abierto a cualquier
 * request sin token, y las tres cercas de RBAC siguen en verde.
 *
 * Esta cerca cierra ese hueco para el gate de `authenticate()` de tenant:
 * parte `src/app.ts` en dos por la línea del gate y exige que todo
 * `app.use('/api/<algo>', ...)` que aparezca ANTES esté en la allowlist
 * `PRE_AUTH_API_MOUNTS` con su motivo (público por token, portal con su
 * propia auth, token de plataforma). Todo lo que va después queda protegido
 * por el gate y no necesita declararse.
 *
 * SI ESTO ROMPE:
 *   - Moviste un `app.use('/api/...')` por encima del `authenticate()`. Si
 *     es una ruta protegida, es un agujero: volvela a bajar.
 *   - Agregaste un mount `/api/...` nuevo que es público a propósito (flujo
 *     por token, sin JWT todavía): sumalo a `PRE_AUTH_API_MOUNTS` con el
 *     motivo, igual que `PUBLIC_ROUTES` en `rbac-route-coverage.test.ts`.
 *   - Renombraste el gate o el patrón de mount: actualizá los regex de abajo.
 *
 * LO QUE ESTA CERCA **NO** GARANTIZA:
 *   1. No es un parser: matchea `app.use('/api/...', ...)` por texto sobre el
 *      archivo sin comentarios. Un mount armado de forma indirecta (un helper
 *      que llama `app.use` por dentro, un path construido por concatenación)
 *      es invisible.
 *   2. No valida el orden de `apiLimiter` (~L352) respecto de los routers que
 *      necesitan `req.db`. El orden de `tenantMiddleware` (~L347) SÍ está
 *      cubierto -- ver RBAC-MOUNT-002 más abajo, agregado el 16/09/2026
 *      (Wave 2 / P-01/D-03, capa 2 de la decisión del dueño) precisamente
 *      para cerrar este punto, que hasta esa fecha decía "no esta".
 *   3. Solo mira el gate de TENANT (`app.use('/api', authenticate(...))`). El
 *      portal de cliente (`/api/customer`) monta su propia `authenticate()`
 *      dentro de `customer.routes.ts` -- que esa siga ahí no lo cubre esta
 *      cerca (lo cubre `customer.routes.test.ts`).
 */

/** Cada entrada: un mount `/api/...` que va ANTES del `authenticate()` de
 *  tenant A PROPÓSITO, con el porqué. Mantener en sync con los bloques 10-14
 *  de `src/app.ts` y con `PUBLIC_ROUTES` de `rbac-route-coverage.test.ts`. */
const PRE_AUTH_API_MOUNTS: Record<string, string> = {
  '/api/login':
    'login: emite el JWT, no puede exigirlo. helmetApi + authLimiter. app.ts bloque 10-11.',
  '/api/customer':
    'portal de cliente: flujo de auth separado, monta su propia authenticate() + authorize(Roles.CUSTOMER_ONLY) dentro de customer.routes.ts. app.ts bloque 12.',
  '/api/admin':
    'superadmin: exige token de PLATAFORMA (authenticatePlatform(), PLATFORM_JWT_SECRET). Tiene que resolver ANTES de que el authenticate() de tenant lo rechace con 401. app.ts, nota del 19/08/2026.',
  '/api/invitations':
    'aceptar invitación de usuario: quien acepta todavía no tiene ningún JWT, el token de la invitación es la única credencial. app.ts bloque 14 (D2).',
  '/api/password-resets':
    'reseteo de contraseña: quien no puso su contraseña nueva no tiene JWT. authLimiter. app.ts (K1/L, 23/08/2026).',
};

const GATE_RE = /app\.use\(\s*(['"])\/api\1\s*,\s*authenticate\s*\(/;
const MOUNT_RE = /app\.use\(\s*(['"])(\/api\/[^'"]+)\1/;

/** Igual criterio que `lock-order.test.ts` / `rbac-matrix-sync.test.ts`:
 *  saca comentarios `/* *\/` y `//` antes de matchear, para que un comentario
 *  que MENCIONE `app.use('/api/...')` (los hay, documentando el orden) no
 *  cuente como un mount real. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

describe('RBAC-MOUNT-001 -- authenticate() de tenant precede a todo router protegido de /api', () => {
  const lines = stripComments(readFileSync(APP_TS, 'utf-8')).split('\n');
  const gateIdx = lines.findIndex((l) => GATE_RE.test(l));

  it('el gate app.use("/api", authenticate(...)) existe exactamente una vez', () => {
    const hits = lines.filter((l) => GATE_RE.test(l)).length;
    expect(
      hits,
      'se esperaba exactamente un app.use("/api", authenticate(...)) en src/app.ts',
    ).toBe(1);
  });

  it('todo mount /api/... anterior al gate está declarado como pre-auth a propósito', () => {
    expect(gateIdx, 'no se encontró el gate app.use("/api", authenticate(...))').toBeGreaterThan(-1);

    const before: string[] = [];
    for (let i = 0; i < gateIdx; i++) {
      const m = lines[i]!.match(MOUNT_RE);
      if (m) before.push(m[2]!);
    }

    const undeclared = before.filter((p) => !(p in PRE_AUTH_API_MOUNTS));
    expect(
      undeclared,
      'Estos mounts /api/... van ANTES del authenticate() de tenant y no están en PRE_AUTH_API_MOUNTS. ' +
        'Si son rutas protegidas, es un agujero: bajalas debajo del gate. Si son públicas a propósito, declaralas con el motivo.',
    ).toEqual([]);
  });

  it('no hay entradas stale en PRE_AUTH_API_MOUNTS (cada una existe y va antes del gate)', () => {
    for (const path of Object.keys(PRE_AUTH_API_MOUNTS)) {
      const idx = lines.findIndex((l) => l.match(MOUNT_RE)?.[2] === path);
      expect(
        idx,
        `PRE_AUTH_API_MOUNTS tiene "${path}" pero no hay ningún app.use("${path}", ...) en src/app.ts`,
      ).toBeGreaterThan(-1);
      expect(
        idx,
        `PRE_AUTH_API_MOUNTS tiene "${path}" pero su mount va DESPUÉS del gate -- ya está protegido, sacá la entrada`,
      ).toBeLessThan(gateIdx);
    }
  });
});

/**
 * RBAC-MOUNT-002 -- capa 2 de la decisión del dueño para P-01/D-03
 * (`docs/decisiones-plan-integral-2026-09-16.md:51`, textual: *"rechazar
 * tokens CUSTOMER en rutas de staff … **y** extender la cerca por actor …
 * las dos capas, no una sola"*). Agregada 16/09/2026, gate
 * `architecture-governor` (Wave 2, ronda 2) -- cierra el punto 2 de "LO QUE
 * ESTA CERCA NO GARANTIZA" de RBAC-MOUNT-001, de arriba.
 *
 * El mecanismo real de D-03 no es "cada ruta de staff valida su rol": es
 * `tenantMiddleware()` (`src/platform/tenant.middleware.ts`) rechazando con
 * 403 CUALQUIER `req.user.role === UserRole.CUSTOMER` ANTES de que el
 * request llegue a cualquier router de staff -- por ACTOR, no por archivo.
 * Esa protección depende enteramente de que NINGÚN router que necesite
 * contexto de staff se monte ANTES de `tenantMiddleware` (~L347) sin que
 * alguien lo haya evaluado a propósito -- exactamente el hueco que el gate
 * encontró al auditar el impacto de D-03: 4 mounts `/api/*` viven hoy entre
 * el `authenticate()` de tenant (~L319) y `tenantMiddleware` (~L347), y 2 de
 * ellos (`/api/business/modules`, `/api/business/plan-limits`) no tienen
 * ningún `authorize()` -- son alcanzables por un token CUSTOMER hoy
 * (`CUSTOMER-STAFF-MOUNT-PRE-TENANT-001`, `docs/pendientes-2026-09-12.md`).
 *
 * Assertion (i) de la decisión del dueño ("`tenantMiddleware` sigue
 * rechazando CUSTOMER") NO se duplica acá -- ya la cubre, en comportamiento
 * real (no solo por texto), `src/platform/tenant-isolation.test.ts`
 * ("un token CUSTOMER se rechaza con 403"). Esta cerca cubre la assertion
 * (ii): ningún mount `/api/*` que dependa de contexto de staff se registra
 * antes de `tenantMiddleware` sin declararlo con motivo.
 *
 * SI ESTO ROMPE: mismo criterio que RBAC-MOUNT-001 -- un mount nuevo o
 * reordenado antes de `tenantMiddleware` sin entrada en
 * `PRE_TENANT_API_MOUNTS` es indistinguible, para esta cerca, de un agujero
 * real: bajalo debajo de `tenantMiddleware` si necesita `req.db`/contexto de
 * tenant, o declaralo acá con el motivo si de verdad no lo necesita (mismo
 * criterio que ya usan `/api/companies`/`/api/auth`/`/api/business/*`: solo
 * tocan `req.user`/la BD de plataforma, nunca `req.db`).
 *
 * LO QUE ESTA CERCA **NO** GARANTIZA: exactamente las mismas 3 limitaciones
 * de RBAC-MOUNT-001 (no es un parser real, no valida `apiLimiter`, no mira
 * el `authenticate()` interno de `/api/customer`) -- comparte `stripComments`/
 * `MOUNT_RE`. Tampoco decide si `/api/business/modules`/`/api/business/plan-limits`
 * DEBERÍAN cerrarse con `authorize()` -- eso es `CUSTOMER-STAFF-MOUNT-PRE-TENANT-001`,
 * una decisión de RBAC aparte (cambiaría `EXPECTED_AUTHORIZE_CALL_SITES` y la
 * matriz), no algo que esta cerca fuerce. Esta cerca solo exige que el
 * estado, cualquiera sea, esté declarado a propósito.
 *
 * DOS HUECOS MÁS, ENCONTRADOS POR EL GATE (ronda de esta cerca,
 * 16/09/2026), DECLARADOS ACÁ Y NO CERRADOS EN ESTE BLOQUE:
 *   4. `PRE_TENANT_API_MOUNTS` empieza con `...PRE_AUTH_API_MOUNTS` (spread) --
 *      cualquier entrada nueva que se agregue a ESE allowlist (RBAC-MOUNT-001,
 *      arriba) queda automáticamente pre-aprobada acá también, sin una
 *      revisión aparte para el gate de `tenantMiddleware`. Es correcto hoy
 *      porque un mount pre-`authenticate()` nunca puede tener `req.db`
 *      (`tenantMiddleware` lo resuelve más abajo) -- pero es una propiedad
 *      del sistema, no algo que este archivo verifique.
 *   5. Esta cerca protege que el MOUNT esté declarado -- NO protege que el
 *      GRUPO que blinda cada mount de la zona pre-tenant siga excluyendo a
 *      CUSTOMER. `/api/companies` (crear/vincular empresa -- mutante,
 *      dispara propagación de catálogo, D-05) depende de que
 *      `CUSTOMER_PERMISSION_GROUPS` (`security/roles.ts:81-84`) NO incluya
 *      `Roles.MANAGEMENT` -- y ese array está explícitamente fuera de
 *      cobertura de `roles-catalog-sync.test.ts` (su limitación #3). Si
 *      algún día se le agrega `MANAGEMENT`, un token CUSTOMER abre
 *      `/api/companies` de punta a punta y NINGUNA de las 8 cercas RBAC de
 *      este repo lo nota -- `tenantMiddleware` no corre en esta zona
 *      (`RBAC-MOUNT-002` así lo declara), y nada más congela ese conjunto.
 *      Cerrarlo es un bloque propio -- molde `ESCAPE_ROUTES`, pero para
 *      `CUSTOMER_PERMISSION_GROUPS` en vez de para una ruta puntual --, no
 *      decidido todavía.
 */
const TENANT_GATE_RE = /app\.use\(\s*(['"])\/api\1\s*,\s*tenantMiddleware\s*\(/;

/** Cada entrada: un mount `/api/...` que va ANTES de `tenantMiddleware` A
 *  PROPÓSITO, con el porqué. Superconjunto de `PRE_AUTH_API_MOUNTS` (todo lo
 *  que va antes del `authenticate()` de tenant también va antes de
 *  `tenantMiddleware`, que está más abajo) más los mounts que sí pasan el
 *  `authenticate()` de tenant pero no necesitan `req.db`. Mantener en sync
 *  con los bloques 10-15 de `src/app.ts`. */
const PRE_TENANT_API_MOUNTS: Record<string, string> = {
  ...PRE_AUTH_API_MOUNTS,
  '/api/companies':
    'empresas multipropiedad: solo toca la BD de plataforma (req.user, no req.db). app.ts bloque tras el authenticate() de tenant, 17/08/2026. Protegido: authorize(Roles.MANAGEMENT) en sus 3 rutas.',
  '/api/auth':
    'me.routes.ts (GET /me, POST /logout, POST /refresh): solo lee req.user, tampoco necesita req.db. Deliberado para CUSTOMER: me.routes.ts ramifica explícito sobre role !== UserRole.CUSTOMER.',
  '/api/business/modules':
    'módulos contratados del negocio: consulta la BD de plataforma vía container, no req.db. SIN authorize() -- alcanzable hoy por un token CUSTOMER. Riesgo bajo (aislamiento entre tenants intacto, es del propio negocio del cliente), pero SIN consumidor conocido en appfrontend hoy (verificado por grep, 16/09/2026) -- el gating de módulos del dashboard pasa por /api/business/context, montado DESPUÉS de tenantMiddleware. Hallazgo abierto, no cerrado en este bloque: CUSTOMER-STAFF-MOUNT-PRE-TENANT-001 (docs/pendientes-2026-09-12.md).',
  '/api/business/plan-limits':
    'límites de plan del negocio (plan/maxCustomRoles/allowedPermissionGroups -- configuración comercial del propio negocio, no un dato neutro): consulta la BD de plataforma vía container, no req.db. SIN authorize() -- alcanzable hoy por un token CUSTOMER. Consumidor real confirmado: dashboard/roles/page.tsx (gating visual del CRUD de roles del dashboard STAFF). Mismo hallazgo abierto que /api/business/modules -- CUSTOMER-STAFF-MOUNT-PRE-TENANT-001.',
};

describe('RBAC-MOUNT-002 -- tenantMiddleware precede a todo router que dependa de contexto de staff', () => {
  const lines = stripComments(readFileSync(APP_TS, 'utf-8')).split('\n');
  const tenantGateIdx = lines.findIndex((l) => TENANT_GATE_RE.test(l));

  it('el gate app.use("/api", tenantMiddleware(...)) existe exactamente una vez', () => {
    const hits = lines.filter((l) => TENANT_GATE_RE.test(l)).length;
    expect(
      hits,
      'se esperaba exactamente un app.use("/api", tenantMiddleware(...)) en src/app.ts',
    ).toBe(1);
  });

  it('todo mount /api/... anterior a tenantMiddleware está declarado en PRE_TENANT_API_MOUNTS', () => {
    expect(tenantGateIdx, 'no se encontró el gate app.use("/api", tenantMiddleware(...))').toBeGreaterThan(-1);

    const before: string[] = [];
    for (let i = 0; i < tenantGateIdx; i++) {
      const m = lines[i]!.match(MOUNT_RE);
      if (m) before.push(m[2]!);
    }

    const undeclared = before.filter((p) => !(p in PRE_TENANT_API_MOUNTS));
    expect(
      undeclared,
      'Estos mounts /api/... van ANTES de tenantMiddleware y no están en PRE_TENANT_API_MOUNTS -- ' +
        'D-03 (rechazo de CUSTOMER por actor) NO los cubre. Si necesitan contexto de staff/req.db, ' +
        'bajalos debajo de tenantMiddleware. Si de verdad no lo necesitan, declaralos acá con el motivo.',
    ).toEqual([]);
  });

  it('no hay entradas stale en PRE_TENANT_API_MOUNTS (cada una existe y va antes de tenantMiddleware)', () => {
    for (const path of Object.keys(PRE_TENANT_API_MOUNTS)) {
      const idx = lines.findIndex((l) => l.match(MOUNT_RE)?.[2] === path);
      expect(
        idx,
        `PRE_TENANT_API_MOUNTS tiene "${path}" pero no hay ningún app.use("${path}", ...) en src/app.ts`,
      ).toBeGreaterThan(-1);
      expect(
        idx,
        `PRE_TENANT_API_MOUNTS tiene "${path}" pero su mount va DESPUÉS de tenantMiddleware -- ya está cubierto por D-03, sacá la entrada`,
      ).toBeLessThan(tenantGateIdx);
    }
  });
});
