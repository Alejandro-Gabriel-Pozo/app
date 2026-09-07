import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CUSTOMER_ROUTES = join(__dirname, '../../api/routes/customer.routes.ts');

/**
 * RBAC-OWN-001 — cierre de la CLASE (08/09/2026; triage en
 * pendientes-2026-09-06.md; ADR diseno-rbac-modelo-y-alcance-2026-08-30.md
 * "Hueco 1"). El commit `8d379ab` cerró la *instancia*: `requireOwnReservation()`
 * centraliza el chequeo de pertenencia y las 2 rutas `:id` del portal lo llaman.
 * Pero nada impide que una ruta `:id` NUEVA del portal se olvide el guard —
 * mismo modo de falla silenciosa que RBAC-MOUNT-001.
 *
 * Esta cerca cierra eso: toda ruta de `customer.routes.ts` cuyo path lleve un
 * parámetro que identifica un RECURSO de un cliente (`:id`, `:reservationId`,
 * etc. — cualquier `:param` que NO sea `:businessSlug`) tiene que llamar a
 * `requireOwnReservation()` en su handler, o figurar en `OWNERSHIP_EXEMPT` con
 * el motivo.
 *
 * Por qué `:businessSlug` no cuenta: es el selector público de tenant de las
 * 4 rutas pre-login (`/:businessSlug/register|login|login/google|availability`),
 * que corren ANTES del `router.use(authenticate(), authorize(Roles.CUSTOMER_ONLY))`
 * (customer.routes.ts ~L540). No hay `req.user.customerId` todavía y no tocan
 * ningún recurso de un cliente — su aislamiento es por slug de negocio, no por
 * dueño. Si alguna vez una `/:businessSlug/...` tocara datos de un cliente
 * autenticado, sería otro bug (y otra cerca), no este.
 *
 * SI ESTO ROMPE:
 *   - Agregaste una ruta `:id` al portal sin el guard de pertenencia. Si opera
 *     sobre un recurso de un cliente concreto: llamá a `requireOwnReservation()`
 *     (o al helper equivalente para ese recurso) ANTES de leer/mutar.
 *   - Si el `:param` NO identifica un recurso con dueño (un enum, una fecha,
 *     un sub-path sin lookup): sumalo a `OWNERSHIP_EXEMPT` con el porqué.
 *   - Renombraste `requireOwnReservation` o el patrón de `router.<método>(`:
 *     actualizá los regex.
 *
 * LO QUE ESTA CERCA **NO** GARANTIZA:
 *   1. No es un parser. Verifica que el nombre `requireOwnReservation(` APAREZCA
 *      en el cuerpo del handler entre esta `router.<método>(` y la siguiente —
 *      no que se llame ANTES del lookup, ni con los argumentos correctos, ni que
 *      el caller respete el `null` de retorno. Eso lo cubren los tests de
 *      `customer.routes` + `customer-portal-ownership.integration.test.ts`.
 *   2. Solo mira `customer.routes.ts`. Otro `*.routes.ts` con rutas de portal
 *      (no existe hoy) quedaría fuera.
 *   3. Asume un helper único (`requireOwnReservation`, hoy solo reservas). Si el
 *      portal gana otro recurso con `:id` (una estadía, una factura) y su propio
 *      guard, hay que sumar ese nombre a `GUARD_NAMES`.
 */

/** Nombres de guard de pertenencia aceptados en el cuerpo de un handler `:id`. */
const GUARD_NAMES = ['requireOwnReservation'];

/** Rutas `:param` que NO necesitan guard de pertenencia, con el motivo.
 *  Clave: "MÉTODO path". Mantener en sync con `customer.routes.ts`. */
const OWNERSHIP_EXEMPT: Record<string, string> = {
  // vacío a propósito: hoy las 2 únicas rutas :id del portal
  // (PATCH /me/reservations/:id, POST /me/reservations/:id/cancel) usan el guard.
};

const ROUTE_RE = /router\.(get|post|put|patch|delete)\(\s*(['"])([^'"]+)\2/g;

/** Igual criterio que `api-auth-gate-order.test.ts` / `lock-order.test.ts`:
 *  saca comentarios antes de matchear, para que un comentario que mencione
 *  `router.get('/...')` o `requireOwnReservation` no cuente. */
function stripComments(content: string): string {
  const withoutBlocks = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlocks
    .split('\n')
    .map((line) => line.split('//')[0])
    .join('\n');
}

/** `:foo` presentes en el path, sin el `:`. */
function pathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
}

interface Route {
  method: string;
  path: string;
  key: string;
  /** Cuerpo desde esta registración hasta la siguiente `router.<método>(` (o EOF). */
  body: string;
}

describe('RBAC-OWN-001 (clase) -- toda ruta :id del portal de cliente pasa por el guard de pertenencia', () => {
  const src = stripComments(readFileSync(CUSTOMER_ROUTES, 'utf-8'));

  const matches = [...src.matchAll(ROUTE_RE)];
  const routes: Route[] = matches.map((m, i) => {
    const start = m.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : src.length;
    return {
      method: m[1]!.toUpperCase(),
      path: m[3]!,
      key: `${m[1]!.toUpperCase()} ${m[3]!}`,
      body: src.slice(start, end),
    };
  });

  /** Rutas cuyo path lleva un `:param` que NO es `businessSlug`. */
  const ownershipRoutes = routes.filter((r) =>
    pathParams(r.path).some((p) => p !== 'businessSlug'),
  );

  it('la cerca ve rutas del portal, y ve al menos las 2 rutas :id conocidas (anti-vacuidad)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(10);
    // Sin esto, si el detector de `:param` se rompe (edit del regex, refactor
    // del path), `ownershipRoutes` cae a [] y el `it` de abajo pasa VERDE
    // asertando NADA -- el mismo modo de falla que esta cerca existe para
    // atrapar. Hoy son 2: PATCH /me/reservations/:id y .../:id/cancel. El
    // número sube, nunca baja, sin una decisión explícita.
    expect(
      ownershipRoutes.length,
      'el detector de rutas :param de recurso dejó de ver las rutas :id del portal -- la cerca quedó vacía',
    ).toBeGreaterThanOrEqual(2);
  });

  it('toda ruta :id llama a un guard de pertenencia o está exenta con motivo', () => {
    const offending = ownershipRoutes.filter(
      (r) =>
        !GUARD_NAMES.some((g) => r.body.includes(`${g}(`)) &&
        !(r.key in OWNERSHIP_EXEMPT),
    );
    expect(
      offending.map((r) => r.key),
      `Estas rutas del portal reciben un :param de recurso y NO llaman a ${GUARD_NAMES.join('/')} ` +
        `ni están en OWNERSHIP_EXEMPT. Si operan sobre un recurso de un cliente concreto, es un IDOR: ` +
        `poné el guard antes del lookup. Si el :param no identifica un recurso con dueño, declaralo con el motivo.`,
    ).toEqual([]);
  });

  it('no hay entradas stale en OWNERSHIP_EXEMPT', () => {
    const realKeys = new Set(ownershipRoutes.map((r) => r.key));
    for (const key of Object.keys(OWNERSHIP_EXEMPT)) {
      expect(
        realKeys.has(key),
        `OWNERSHIP_EXEMPT tiene "${key}" pero no hay ninguna ruta :id así en customer.routes.ts -- sacá la entrada`,
      ).toBe(true);
    }
  });
});
