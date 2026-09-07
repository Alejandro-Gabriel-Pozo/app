# Diseño — Modelo RBAC de app-main y alcance de `authorization-surface-mapping`

**Fecha:** 30/08/2026
**Estado:** aceptado
**Reversibilidad:** one-way-ish — cambiar el modelo (a RLS o a un router
deny-by-default) es una migración transversal sobre todos los call-sites de
`authorize(Roles.X)` de las rutas (el conteo exacto vive en
`EXPECTED_AUTHORIZE_CALL_SITES` / `EXPECTED_ROUTES_FILE_COUNT` de
`src/tests/security/rbac-matrix-sync.test.ts`).

Este documento existe porque se incorporó la skill de capa técnica
`authorization-surface-mapping` (`.claude/skills/`), cuya recomendación
estructural genérica ("enforcá en la capa de datos > middleware
deny-by-default > check por handler") contradice a primera vista el diseño
RBAC ya implementado. Sin este registro, esa tensión se re-discute en cada
activación de la skill.

---

## Contexto / fuerzas al momento

- **Multi-tenant con una base de datos por negocio** (Neon).
  `tenantMiddleware` resuelve `req.db` al pool del tenant a partir del
  `businessId` del JWT (`src/platform/tenant.middleware.ts`). El
  aislamiento entre tenants es **físico**: un handler no puede alcanzar
  datos de otro negocio porque es otra conexión. No hay `WHERE
  business_id` que olvidar.
- La **BD de plataforma** (businesses, memberships, roles,
  `platform_audit_log`, superadmin) es compartida y tiene un sistema de
  autorización **separado** — `authorizePlatform()`, JWT firmado con
  `PLATFORM_JWT_SECRET`, un único superadmin por variables de entorno.
  Cubre `platform.routes.ts` y `admin.routes.ts`.
- **Autorización por función:** 8 grupos fijos en `src/security/roles.ts`,
  aplicados con `authorize(Roles.X)` por call-site (204 al 30/08/2026).
  `authorize()` chequea si el grupo pedido está en
  `req.user.permissionGroups` (resuelto contra `role_permission_groups` en
  el mismo request) o, para tokens CUSTOMER, contra la lista fija
  `CUSTOMER_PERMISSION_GROUPS`. Qué rol nombrado pertenece a qué grupo es
  configurable por negocio; el catálogo de grupos no (cambio de código).
- **Honestidad del maestro:** `docs/rbac-matriz-endpoints.md` +
  `src/tests/security/rbac-matrix-sync.test.ts` — una cerca eléctrica que
  cuenta los `authorize(Roles.X)` reales y los compara contra un número
  fijo. Un parser de rutas real se descartó explícitamente (frágil con
  `router.use()` encadenado, `requireModule()` envolviendo, y ejemplos del
  patrón en comentarios — ya hubo un falso positivo real).

## Decisión

1. **Se mantiene** el modelo actual: `authorize(Roles.X)` por call-site +
   matriz documentada + cerca eléctrica. No se migra a RLS ni a un router
   deny-by-default.
2. **Se incorpora** `authorization-surface-mapping` acotada a los dos
   huecos que el modelo actual no cubre estructuralmente (abajo). No se la
   usa como mandato para reescribir `authorize()`.
3. Ante conflicto entre la skill y `criterios-negocio`, gana
   `criterios-negocio` (regla general de las skills de capa técnica).

## Alternativas rechazadas

- **Row-level security / repositorio tenant-scoped que no pueda expresar
  un read sin scope.** Rechazada: el aislamiento entre tenants ya es **más
  fuerte que eso** (BD física separada); aplicarlo encima es complejidad
  sin ganancia en el eje que importa. Mejor argumento a favor: unificaría
  el modelo con la BD de plataforma, que hoy sí necesita scoping por
  `business_id` a mano.
- **Middleware deny-by-default a nivel router** (cada ruta declara su
  regla o falla cerrada). Rechazada por ahora: los ~204 call-sites y 37
  archivos ya existen y funcionan; migrarlos es un cambio transversal de
  alto riesgo sin incidente que lo motive. Mejor argumento a favor:
  cerraría el Hueco 2 sin depender de disciplina + revisión.
- **Parser de rutas real para validar la matriz.** Rechazada en el propio
  test por frágil; la cerca de conteo es el reemplazo deliberado.

## Supuesto sobre el que se apoya

Que el aislamiento entre tenants sigue siendo **una BD por negocio**. Si
en algún momento se consolida a una sola BD con `business_id` por fila
(por costo de Neon, por ejemplo), esta decisión se cae: la familia de bugs
IDOR cross-tenant de la skill pasa a aplicar de lleno y RLS / repositorio
tenant-scoped vuelve a la mesa.

## Consecuencias aceptadas

- La autorización por función es **opt-in por ruta**, no deny-by-default:
  una ruta agregada sin `authorize()` no queda denegada sola.
- La cerca eléctrica prueba que el **conteo** no driftó, no que ningún
  check **se dispare**. No es control de acceso, es un chequeo de
  honestidad del maestro.

## Huecos abiertos — alcance de `authorization-surface-mapping`

La skill se activa para trabajar sobre estos dos, no sobre el eje tenant:

**Hueco 1 — Ownership dentro de un tenant, portal de cliente.** "El
cliente A no puede ver la reserva del cliente B del mismo negocio" depende
de que `req.user.customerId` se enhebre en cada query del portal. Las
rutas del portal viven en `src/api/routes/customer.routes.ts` (montadas
bajo `/api/customer`, `authorize(Roles.CUSTOMER_ONLY)`), **no** en
`me.routes.ts` — ese archivo es el `/api/auth/me` de staff, 3 rutas que
solo leen `req.user`, sin `:id` ni superficie de ownership. La confusión
venía del prefijo de path `/me/...`.

> **Parcialmente resuelto (07/09/2026, commit `8d379ab`).** Guard central
> `requireOwnReservation()` en `customer.routes.ts` + prueba negativa de
> integración (`customer-portal-ownership.integration.test.ts`: capturar
> como dueño → repetir como otro cliente → 403; id inexistente → 404).
> **Alcance:** las 2 únicas rutas del portal con `:id` arbitrario
> (`PATCH /me/reservations/:id`, `POST /me/reservations/:id/cancel`). Lo
> que NO cierra: una ruta `:id` futura que se olvide el guard — misma
> clase que RBAC-MOUNT-001, se cierra con una cerca (pendiente, ver
> `pendientes-2026-09-06.md`).

**Hueco 2 (mitigado el 30/08/2026) — Ruta nueva sin `authorize()` en un
archivo `*.routes.ts` existente.** La cerca de conteo no la ve (no suma un `authorize(Roles.X)`)
y `EXPECTED_ROUTES_FILE_COUNT` tampoco (no es archivo nuevo). Mitigación
que empuja la skill: un test que falle si un `router.get/post/patch/...`
no tiene `authenticate` / `authorize` en su cadena.

> **Mitigado** por `src/tests/security/rbac-route-coverage.test.ts` (commit
> `a17fdd2`, 30/08/2026). **Desviación deliberada respecto del párrafo de
> arriba:** el test exige `authorize(Roles.X)` / `authorizePlatform(...)`, y
> **no** `authenticate` — `authenticate()` se aplica a nivel de montaje en
> `src/app.ts`, no por ruta — y resuelve ese eje con un allowlist
> (`PUBLIC_ROUTES`, 22 entradas, 1:1 con la sección 4 de la matriz).
>
> Quedan tres huecos residuales, anotados en el docblock del test:
> `guardLines` es por archivo y por número de línea, no por instancia de
> `Router()`; `src/app.ts` no se escanea (registra 3 rutas a mano); y no se
> valida el orden de montaje, del que depende la seguridad de 7 de las 22
> entradas del allowlist.
>
> **Hueco 1: parcialmente resuelto el 07/09/2026** (`8d379ab`) — ver el
> recuadro en "Hueco 1" más arriba. Falta la cerca sobre las rutas `:id`
> del portal para cerrar la clase, no solo la instancia.

## Gatillo de revisión

- Si el aislamiento entre tenants deja de ser BD-por-tenant → reabrir la
  decisión completa.
- Si aparece un incidente de IDOR en el portal de cliente → priorizar
  Hueco 1 sobre el resto del backlog.
- Si se agrega un tercer sistema de autorización (más allá de tenant +
  plataforma) → mapear su superficie con la skill antes de mergear.

## Anclado en

- `src/security/roles.ts`, `src/security/auth.middleware.ts`
  (`authorize`, `authenticate`)
- `src/platform/tenant.middleware.ts` (`tenantMiddleware`, `req.db`)
- `docs/rbac-matriz-endpoints.md`,
  `src/tests/security/rbac-matrix-sync.test.ts`
- `.claude/skills/authorization-surface-mapping/SKILL.md`
