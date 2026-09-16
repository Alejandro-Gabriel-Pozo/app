/**
 * @file public-routes.fixture.ts
 * @description Fuente única de `PUBLIC_ROUTES` -- extraído de
 * `rbac-route-coverage.test.ts` el 09/09/2026 (gate `architecture-governor`,
 * bloque de seguimiento de RBAC-SYNC-001 §4).
 *
 * Vivía como `const` dentro de `rbac-route-coverage.test.ts`, exportado para
 * que `rbac-matrix-public-routes-sync.test.ts` lo importara (evitar una
 * tercera copia que también pudiera desalinearse contra
 * `docs/rbac-matriz-endpoints.md`). Ese import tenía un efecto colateral no
 * declarado: Vitest ejecuta el módulo completo de un `*.test.ts` importado,
 * incluidos sus `describe()` de nivel superior -- `RBAC-ROUTE-001` se
 * re-registraba y corría DOS VECES en una corrida de la suite completa (una
 * vez en su propio archivo, otra vez dentro de la cerca nueva). Un fixture
 * NO-test es el archivo correcto para algo que dos suites de test necesitan
 * compartir: se importa como módulo normal, sin re-ejecutar ningún `describe`.
 *
 * Mantener en sync con `docs/rbac-matriz-endpoints.md` sección 4 -- cruzado
 * automáticamente por `rbac-matrix-public-routes-sync.test.ts`
 * (RBAC-SYNC-001 §4). `rbac-route-coverage.test.ts` (RBAC-ROUTE-001) sigue
 * siendo el que cruza esto contra el código real (rutas sin `authorize()`).
 */

/** Clave: "<ruta rel. a src>|<METHOD> <path>". Cada entrada es una ruta que NO
 *  lleva `authorize()` a propósito, con el porqué. */
export const PUBLIC_ROUTES: Record<string, string> = {
  // --- Login / alta: montados antes del authenticate() global (app.ts). El
  //     login ES la credencial; no hay JWT todavía.
  'api/routes/auth.routes.ts|POST /':                'login de staff (/api/login)',
  'api/routes/auth.routes.ts|POST /select-business': 'elección de negocio post-login; valida el token temporal en el handler',
  'api/routes/auth.routes.ts|POST /google':          'login de staff con Google',
  'platform/business.routes.ts|POST /':              'alta de negocio (/register), pública',
  'platform/platform.routes.ts|POST /login':         'login de superadmin; va antes del router.use(authorizePlatform(...))',
  'api/routes/customer.routes.ts|POST /:businessSlug/register':     'alta de cliente en el portal, pública',
  'api/routes/customer.routes.ts|POST /:businessSlug/login':        'login de cliente en el portal',
  'api/routes/customer.routes.ts|POST /:businessSlug/login/google': 'login de cliente con Google',
  'api/routes/customer.routes.ts|GET /:businessSlug/availability':  'buscador de disponibilidad del portal, pre-login',
  'api/routes/customer.routes.ts|POST /logout':      'borra la cookie del portal, sin efecto de datos',

  // --- Self-scoped: solo leen/actúan sobre req.user; no hay objeto de otro dueño.
  'api/routes/me.routes.ts|GET /me':       'perfil propio del usuario autenticado',
  'api/routes/me.routes.ts|POST /logout':  'borra la cookie propia',
  'api/routes/me.routes.ts|POST /refresh': 'refresca el token propio',

  // --- Contexto del propio negocio: montados antes de tenantMiddleware, leen la
  //     BD de plataforma. Cualquier miembro autenticado ve los módulos/límites
  //     de SU negocio (gating visual del dashboard, L 23/08/2026).
  'platform/business-modules.routes.ts|GET /':     'módulos contratados del propio negocio',
  'platform/business-plan-limits.routes.ts|GET /': 'límites del plan del propio negocio',

  // --- STAFF-open, sin restricción de grupo (L, 23/08/2026, actualizado Wave 2
  //     P-01/D-03 16/09/2026). Ya NO es "portal incl." -- el portal usa el
  //     endpoint dedicado GET /api/customer/categories; tenantMiddleware
  //     rechaza con 403 cualquier token CUSTOMER antes de llegar acá de
  //     cualquier forma. Ver rbac-matriz-endpoints.md sección 4.
  'reservas/categories.routes.ts|GET /':    'listado de categorías, cualquier identidad de STAFF del tenant',
  'reservas/categories.routes.ts|GET /:id': 'detalle de categoría, ídem',

  // --- Flujos por token: quien acepta todavía no tiene JWT; el token es la
  //     credencial y lo valida el handler.
  'usuarios-roles/password-reset.routes.ts|POST /request': 'pedir reseteo de contraseña (email en el body)',
  'usuarios-roles/password-reset.routes.ts|POST /lookup':  'validar el token de reseteo',
  'usuarios-roles/password-reset.routes.ts|POST /accept':  'fijar la contraseña nueva con el token',
  'usuarios-roles/user-invitation.routes.ts|POST /lookup': 'validar el token de invitación',
  'usuarios-roles/user-invitation.routes.ts|POST /accept': 'aceptar la invitación con el token',
};
