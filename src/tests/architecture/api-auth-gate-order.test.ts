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
 *   2. No valida el orden de `tenantMiddleware` (~L345) ni de `apiLimiter`
 *      (~L350) respecto de los routers que necesitan `req.db` -- eso es otra
 *      invariante (DEFENSIVE_DEVELOPING.md, multi-tenant), no esta.
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
