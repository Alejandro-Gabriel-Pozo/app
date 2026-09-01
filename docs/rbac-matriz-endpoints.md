# Matriz RBAC — endpoint × grupo de permisos

**Última actualización:** 23/08/2026 (sección L, `pendientes-2026-08-23.md`).

Este documento es la fuente de verdad de qué grupo de permisos exige cada
endpoint del backend hoy. Es un documento **vivo** — como
`criterios-negocio.md`/`criterios-datos.md`, se actualiza en el mismo
cambio que agrega o modifica una ruta, no después. El mecanismo que lo
mantiene honesto está en `src/tests/governance/rbac-matrix-sync.test.ts`:
cuenta los `authorize(Roles.X)` reales del código y compara contra un
número fijo — si no coinciden, algo cambió sin actualizar este documento.

**Al agregar o cambiar un `authorize(Roles.X)` en cualquier ruta: actualizá
este documento Y el número en `rbac-matrix-sync.test.ts` en el mismo
cambio.** Ver también `app-main/CLAUDE.md`.

---

## 1. Catálogo de grupos de permisos

Fijo en código (`src/security/roles.ts`) — agregar un grupo nuevo siempre
es un cambio de código, nunca configuración. Lo que SÍ es configurable
por negocio es qué ROL nombrado (ej. "Recepcionista") tiene qué
subconjunto de estos 8 grupos (sección 3).

| Grupo | Qué significa |
|---|---|
| `OWNER_ONLY` | Propietario solamente — configuración de plan, facturación |
| `MANAGEMENT` | Gestión operativa completa |
| `STAFF` | Todo el personal interno del negocio (excluye CUSTOMER) |
| `FRONT_DESK` | Personal de mostrador: gestiona reservas y clientes |
| `HOUSEKEEPING_AND_MANAGEMENT` | Housekeeping + management: ven y actualizan estado de habitaciones |
| `ORDERS` | Acceso a órdenes de consumo (POS) |
| `CUSTOMER_ONLY` | Solo clientes externos — resuelto en código, no contra la BD (los clientes no tienen `role_id`) |
| `BOOKING` | Clientes + recepción (reservas desde portal o mostrador) |

**Dos sistemas de autorización totalmente separados, sin catálogo ni
middleware compartido:**
- **Tenant** — `Roles.*` de arriba + `authorize()`, JWT firmado con
  `JWT_SECRET`. Es el que cubre el resto de este documento.
- **Plataforma** — `PlatformRole` (un solo valor hoy: `SUPERADMIN`) +
  `authorizePlatform()`, JWT firmado con `PLATFORM_JWT_SECRET`. Cubre
  `platform.routes.ts` y `admin.routes.ts` — gestión de negocios de TODA
  la plataforma, no de un tenant. El actor es un único usuario
  hardcodeado por variables de entorno (`PLATFORM_ADMIN_EMAIL`/
  `PLATFORM_ADMIN_PASSWORD`, `platform.auth.service.ts`), sin tabla, sin
  soporte para más de una cuenta — ver "Fuera de alcance" en
  `pendientes-2026-08-23.md` sección L para el panel de superadmin real
  (sesión aparte, sin diseñar todavía).

---

## 2. Matriz de endpoints por archivo (198 call-sites, 35 archivos)

Formato: `Método Path — GRUPO` (+ gate de módulo/plan si aplica, entre
paréntesis — eso es "qué módulo/plan hay que tener contratado", no "quién
puede", son dos preguntas distintas).

### `src/api/routes/`

**`audit-log.routes.ts`**
- GET `/` — `MANAGEMENT`

**`business-profile.routes.ts`**
- GET `/` — `MANAGEMENT`
- PUT `/` — `MANAGEMENT` (+ chequeo manual de `OWNER_ONLY` en el handler para el candado de campos fiscales una vez cargado el CUIT — ver sección 5)

**`locations.routes.ts`**
- GET `/` — `STAFF`
- POST `/` — `MANAGEMENT`

**`reports.routes.ts`** (todo `requireModule(REPORTES)`, aplicado en `app.ts` al montar)
- GET `/occupancy` — `MANAGEMENT`
- GET `/occupancy/summary` — `MANAGEMENT`
- GET `/occupancy/by-category` — `MANAGEMENT`
- GET `/occupancy/underutilized` — `MANAGEMENT`
- GET `/accounts-receivable` — `MANAGEMENT`
- GET `/pos/sales-by-product` — `MANAGEMENT`
- GET `/pos/waste` — `MANAGEMENT`
- GET `/pos/ticket-summary` — `MANAGEMENT`
- GET `/crm/new-vs-recurring` — `MANAGEMENT`
- GET `/crm/applied-rates` — `MANAGEMENT`
- DELETE `/occupancy/purge` — `MANAGEMENT`

**`system.routes.ts`**
- GET `/outbox/dead-letter` — `MANAGEMENT`
- POST `/outbox/:id/retry` — `MANAGEMENT`

**`customer.routes.ts`** — portal de clientes. Un solo call-site
(`router.use(authenticate(), authorize(Roles.CUSTOMER_ONLY))`) gatea de
una sola vez las 7 rutas de `/me/*`: GET `/me`, POST `/refresh`,
DELETE `/me`, GET `/me/reservations`, POST `/me/reservations`,
PATCH `/me/reservations/:id`, POST `/me/reservations/:id/cancel`. 6 de
esas 7 además chequean `requireCustomerId()` a mano y ownership del
recurso (`existing.customer.id !== customerId`) — ver sección 5. El resto
del archivo (registro/login/disponibilidad del portal) es público, ver
sección 4.

**`me.routes.ts`** — sin `authorize()`, ver sección 4.

**`business-modules.routes.ts`** — sin `authorize()`, ver sección 4.

**`business-plan-limits.routes.ts`** (nuevo, L 23/08/2026) — GET `/`, sin `authorize()`, ver sección 4 (mismo patrón que `business-modules.routes.ts`).

### `src/clientes-finanzas/`

**`cash-register.routes.ts`** (todo `requireModule(CUENTAS_CORRIENTES)`, aplicado en `app.ts`)
- GET `/current` — `FRONT_DESK`
- GET `/` — `FRONT_DESK`
- GET `/:id` — `FRONT_DESK`
- POST `/open` — `FRONT_DESK`
- POST `/close` — `FRONT_DESK`

**`rate-catalog.routes.ts`**
- GET `/` — `FRONT_DESK`
- POST `/` — `MANAGEMENT`
- PUT `/:id` — `MANAGEMENT`
- DELETE `/:id` — `MANAGEMENT`

**`customers.routes.ts`**
- GET `/:id` — `FRONT_DESK`
- PATCH `/:id` — `FRONT_DESK`
- GET `/:id/tax-profile` — `MANAGEMENT` (`requireModule(FACTURACION)`)
- PUT `/:id/tax-profile` — `MANAGEMENT` (`requireModule(FACTURACION)`)
- POST `/padron/lookup-by-cuit` — `MANAGEMENT` (`requireModule(FACTURACION)`)
- POST `/padron/lookup-by-dni` — `MANAGEMENT` (`requireModule(FACTURACION)`)
- GET `/padron/iva-receptor-types` — `MANAGEMENT` (`requireModule(FACTURACION)`)
- POST `/:id/tags` — `FRONT_DESK`
- DELETE `/:id/tags/:tagId` — `FRONT_DESK`
- GET `/` — `FRONT_DESK`
- POST `/search` — `FRONT_DESK` (A7.2, 23/08/2026 — reemplaza el `?search=` que tenía GET, PII nunca en query string)
- POST `/search-by-tax-id` — `FRONT_DESK` (body, mismo motivo A7.2)
- POST `/` — `FRONT_DESK`
- GET `/:id/rates` — `FRONT_DESK`
- POST `/:id/rates` — `MANAGEMENT`
- DELETE `/:id/rates/:rateId` — `MANAGEMENT`
- GET `/:id/billing-policy` — `MANAGEMENT` (`requireModule(FACTURACION)`, C1-Fase C)
- PUT `/:id/billing-policy` — `MANAGEMENT` (`requireModule(FACTURACION)`, C1-Fase C)
- GET `/:id/account` — `FRONT_DESK` (`requireModule(CUENTAS_CORRIENTES)`)
- GET `/:id/outstanding-invoices` — `FRONT_DESK` (`requireModule(CUENTAS_CORRIENTES)`)
- POST `/:id/payments` — `FRONT_DESK` (`requireModule(CUENTAS_CORRIENTES)`)

**`accounts-receivable.routes.ts`** (F1-Pieza 3, 23/08/2026 — todo `requireModule(CUENTAS_CORRIENTES)`, aplicado en `app.ts`; la creación de la fila vive en `stays.routes.ts` POST `/:id/transfer-to-receivable`, ya listado arriba)
- GET `/?companyCustomerId=` — `MANAGEMENT`
- POST `/:id/mark-invoiced` — `MANAGEMENT`
- POST `/:id/mark-collected` — `MANAGEMENT`

### `src/facturacion/`

**`invoices.routes.ts`** — `requireModule(FACTURACION)` en las MUTACIONES y en `createAfipCredentialsRouter`. Los GET de `/api/invoices` van **sin** gate de módulo: leer un comprobante fiscal ya emitido es obligación legal de exhibición (`criterios-datos.md` línea 24; ver `diseno-cascada-enforcement-2026-08-30.md` §3d — 30/08/2026). Dos routers:
- `createInvoicesRouter`: POST `/` — `FRONT_DESK` (+ `requireModule(FACTURACION)`); POST `/consolidated` — `MANAGEMENT` (+ `requireModule(FACTURACION)`, C1-Fase C, "Facturar ahora"); GET `/:id` — `FRONT_DESK` (sin gate de módulo); GET `/:id/pdf` — `FRONT_DESK` (sin gate de módulo); GET `/` — `FRONT_DESK` (sin gate de módulo)
- `createAfipCredentialsRouter` (todo `requireModule(FACTURACION)`): GET `/status` — `MANAGEMENT`; PUT `/` — `MANAGEMENT`; DELETE `/` — `MANAGEMENT`

### `src/platform/`

**`admin.routes.ts`** — sistema de PLATAFORMA, no de tenant. `authenticatePlatform() + authorizePlatform([SUPERADMIN])` en todo el router: POST `/repair-tenant-db`, POST `/set-tenant-url`.

**`platform.routes.ts`** — sistema de PLATAFORMA. **23/08/2026: se agregó `authorizePlatform([SUPERADMIN])`** (antes solo `authenticatePlatform()`, ver sección 5 — era el único router de plataforma sin ese segundo gate). POST `/login` es público (antes del `router.use`). El resto: GET `/stats`, GET `/businesses`, POST `/businesses`, GET `/businesses/:id`, PATCH `/businesses/:id/status`, POST `/businesses/:id/provision`, **PATCH `/businesses/:id/plan`** (nuevo, L), **GET/PUT `/plan-limits[/:plan]`** (nuevo, L — editar `plan_limits`/`plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`), **GET/PUT `/role-presets[/:name]`** (nuevo, L — editar el catálogo global de los 5 roles de fábrica, solo afecta negocios provisionados DESPUÉS del cambio).

**`business-hours.routes.ts`**
- GET `/` — `BOOKING`
- POST `/` — `MANAGEMENT`
- DELETE `/:id` — `MANAGEMENT`

**`companies.routes.ts`**
- GET `/me` — `MANAGEMENT`
- POST `/` — `MANAGEMENT` (+ `requirePlan(ENTERPRISE)` — gate de PLAN, no de módulo)
- POST `/link` — `MANAGEMENT` (+ `requirePlan(ENTERPRISE)`)

**`business.routes.ts`** — POST `/register` público, ver sección 4.

**`business-modules.routes.ts`** — ver sección 4 (`api/routes/`, listado ahí por el mount real).

**`business-context.routes.ts`** (Fase 4 Bloque 4B, 30/08/2026 — commit `9119a50`; montado en `/api/business/context` post-`tenantMiddleware`)
- GET `/` — `STAFF` (deja fuera a los tokens `CUSTOMER`; el contexto del portal de clientes es otro contrato)

### `src/pms-estadias/`

**`housekeeping.routes.ts`** (todo `requireModule(HOUSEKEEPING)`)
- GET `/` — `STAFF`
- GET `/me` — `STAFF`
- GET `/late-checkouts` — `STAFF`
- GET `/status/:status` — `HOUSEKEEPING_AND_MANAGEMENT`
- GET `/resource/:resourceId` — `STAFF`
- GET `/:id` — `STAFF`
- POST `/` — `MANAGEMENT`
- POST `/:id/assign` — `MANAGEMENT`
- POST `/:id/start` — `STAFF`
- POST `/:id/complete` — `STAFF`
- POST `/:id/inspect` — `HOUSEKEEPING_AND_MANAGEMENT`

(POST `/:id/out-of-service` y `/:id/reset` se borraron el 25/08/2026 —
huérfanas, cero callers reales desde que `maintenance_window` las
reemplazó el 24/08/2026.)

**`maintenance-windows.routes.ts`** (todo `requireModule(HOUSEKEEPING)`, 24/08/2026 —
reemplaza OUT_OF_SERVICE/reset de arriba como mecanismo de bloqueo de
disponibilidad, ver `docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md`)
- GET `/` — `STAFF`
- GET `/resource/:resourceId` — `STAFF`
- POST `/` — `MANAGEMENT`
- POST `/:id/close` — `MANAGEMENT`

**`stays.routes.ts`** (todo `requireModule(ALOJAMIENTO)`)
- GET `/` — `FRONT_DESK`
- GET `/reservation/:reservationId` — `FRONT_DESK`
- GET `/resource/:resourceId` — `STAFF`
- GET `/:id` — `FRONT_DESK`
- POST `/check-in` — `FRONT_DESK` (`overrideHousekeeping: true` exige además `MANAGEMENT`, chequeo inline en el handler — 25/08/2026, gating de check-in por limpieza)
- POST `/:id/check-out` — `FRONT_DESK`
- POST `/:id/no-show` — `FRONT_DESK`
- GET `/:id/folio` — `FRONT_DESK`
- POST `/:id/transfer-to-receivable` — `MANAGEMENT`

### `src/pos-menu/` (todo `requireModule(POS_RESTAURANTE)`, aplicado en `app.ts`)

**`waste-reasons.routes.ts`** — GET `/`, GET `/:id`, POST `/`, PUT `/:id`, DELETE `/:id` — todo `MANAGEMENT`.

**`consumption-destinations.routes.ts`** (27/08/2026, gemelo de `waste-reasons.routes.ts`) — GET `/`, GET `/:id`, POST `/`, PUT `/:id`, DELETE `/:id` — todo `MANAGEMENT`.

**`orders.routes.ts`**
- GET `/` — `ORDERS`
- POST `/` — `BOOKING`
- GET `/:id` — `ORDERS`
- POST `/:id/confirm` — `ORDERS`
- POST `/:id/serve` — `ORDERS`
- POST `/:id/complete` — `ORDERS`
- POST `/:id/cancel` — `ORDERS`
- PATCH `/:id/notes` — `ORDERS`
- POST `/:id/items` — `BOOKING`
- DELETE `/:id/items/:itemId` — `ORDERS`

**`products.routes.ts`** — todo `MANAGEMENT` salvo:
GET `/`, POST `/`, GET `/company-catalog`, GET `/:id`, PUT `/:id`, DELETE `/:id`, GET/POST/PUT/DELETE `/:id/variants*`, GET/POST/PUT/DELETE `/:id/recipe-items*`, POST `/stock/transfer`, POST `/stock/waste`, POST `/stock/consumption`, POST `/stock/production`, POST `/:id/company/share`, `/publish`, `/price-override/*`, `/recipe-override/*`
→ excepciones **`ORDERS`**: POST `/:id/stock/decrement`, POST `/:id/variants/:variantId/stock/decrement`.

### `src/reservas/`

**`cancellation-policies.routes.ts`** — GET `/`, GET `/:id`, POST `/`, PUT `/:id`, DELETE `/:id` — todo `MANAGEMENT`.

**`categories.routes.ts`**
- POST `/` — `MANAGEMENT`
- PUT `/:id` — `MANAGEMENT`
- DELETE `/:id` — `MANAGEMENT`
- **GET `/` y GET `/:id` — SIN `authorize()`.** Ver sección 4, flag abierto.

**`reservations.routes.ts`**
- GET `/` — `FRONT_DESK`
- POST `/search` — `FRONT_DESK` (A7.2 — reemplaza el `?search=` que tenía GET)
- GET `/:id` — `FRONT_DESK`
- POST `/` — `BOOKING`
- PUT `/:id` — `FRONT_DESK`
- GET `/:id/price-preview` — `FRONT_DESK`
- POST `/:id/confirm-price-adjustment` — `MANAGEMENT` (a propósito distinto de PUT `/:id` — separa "quién edita fechas" de "quién autoriza la plata")
- POST `/:id/confirm` — `FRONT_DESK`
- POST `/:id/cancel` — `FRONT_DESK`
- GET `/:id/cancellation-refund/preview` — `FRONT_DESK`
- POST `/:id/cancellation-refund/confirm` — `FRONT_DESK`
- POST `/:id/complete` — `FRONT_DESK`
- POST `/:id/schedule-request` — `BOOKING` (`requireModule(ALOJAMIENTO)`)
- POST `/:id/schedule-request/approve` — `FRONT_DESK` (`requireModule(ALOJAMIENTO)`)
- POST `/:id/schedule-request/reject` — `FRONT_DESK` (`requireModule(ALOJAMIENTO)`)

**`resources.routes.ts`**
- GET `/` — `STAFF`
- GET `/:id` — `STAFF`
- POST `/` — `MANAGEMENT`
- PUT `/:id` — `MANAGEMENT`
- DELETE `/:id` — `MANAGEMENT`
- GET `/:id/hours` — `BOOKING`
- POST `/:id/hours` — `MANAGEMENT`
- DELETE `/:id/hours/:hourId` — `MANAGEMENT`

**`bookable-services.routes.ts`**
- GET `/` — `BOOKING`
- POST `/` — `MANAGEMENT`
- GET `/:id` — `BOOKING`
- PUT `/:id` — `MANAGEMENT`
- DELETE `/:id` — `MANAGEMENT`
- GET `/:id/schedules` — `BOOKING`
- POST `/:id/schedules` — `MANAGEMENT`
- PUT `/:id/schedules/:scheduleId` — `MANAGEMENT`
- DELETE `/:id/schedules/:scheduleId` — `MANAGEMENT`
- GET `/:id/rate-plans` — `BOOKING`
- POST `/:id/rate-plans` — `MANAGEMENT`
- PUT `/:id/rate-plans/:ratePlanId` — `MANAGEMENT`
- DELETE `/:id/rate-plans/:ratePlanId` — `MANAGEMENT`
- GET `/:id/resource-locks` — `STAFF`
- PUT `/:id/resource-locks` — `MANAGEMENT`
- GET `/:id/available-slots` — `BOOKING`

### `src/usuarios-roles/`

**`roles.routes.ts`** — GET `/`, GET `/:id`, POST `/`, PUT `/:id`, DELETE `/:id` — todo `MANAGEMENT`. **L (23/08/2026)**: POST/PUT además pasan por gobernanza de plan (`resolvePlanLimits`) — 402 `PLAN_LIMIT_REACHED` si el negocio ya alcanzó `maxCustomRoles` (roles `isSystem` no cuentan), 402 `PERMISSION_GROUP_NOT_AVAILABLE_IN_PLAN` si `permissionGroups` incluye un grupo que el plan no habilita para roles custom. `createRolesRouter` pasó a recibir también `container: AppContainer`.

**`user-invitation.routes.ts`** — `createUserInvitationsRouter` (todo `MANAGEMENT`): GET `/`, POST `/`, POST `/:id/resend`, DELETE `/:id`. El otro router del mismo archivo (`createInvitationAcceptanceRouter`, montado en `/api/invitations`) es público — ver sección 4.

**`users.routes.ts`**
- GET `/` — `MANAGEMENT`
- GET `/:id` — `MANAGEMENT`
- POST `/` — `MANAGEMENT`
- PUT `/:id` — `MANAGEMENT` (+ chequeo manual de jerarquía de rol en el cambio de contraseña — ver sección 5)
- POST `/:id/password-reset-link` — `MANAGEMENT`
- DELETE `/:id` — `OWNER_ONLY` (único call-site de este grupo fuera de `password-reset.routes.ts`)
- POST `/:id/reactivate` — `MANAGEMENT` (25/08/2026, F2 — reincorpora una membership desactivada)

**`password-reset.routes.ts`** — público, ver sección 4.

---

## 3. Roles de fábrica (presets) → grupos de permisos

Cada negocio nuevo recibe estas 5 filas en `roles` (una por preset),
sembradas desde `platform.schema.sql` (`role_presets`/
`role_preset_permission_groups`) al crear el negocio. **No hay pantalla
para crear un rol custom ni editar los grupos de uno existente** — el
backend tiene CRUD completo (`roles.routes.ts`) pero ninguna pantalla del
dashboard lo usa (solo `rolesApi.list()`, para poblar un `<select>`).
Cualquier cambio hoy requiere pegarle directo a la API.

| Rol (preset) | Grupos asignados |
|---|---|
| `OWNER` | `OWNER_ONLY`, `MANAGEMENT`, `STAFF`, `FRONT_DESK`, `HOUSEKEEPING_AND_MANAGEMENT`, `ORDERS`, `BOOKING` |
| `ADMIN` | `MANAGEMENT`, `STAFF`, `FRONT_DESK`, `HOUSEKEEPING_AND_MANAGEMENT`, `ORDERS`, `BOOKING` |
| `RECEPTIONIST` | `STAFF`, `FRONT_DESK`, `BOOKING` |
| `HOUSEKEEPING` | `STAFF`, `HOUSEKEEPING_AND_MANAGEMENT` |
| `WAITER` | `STAFF`, `ORDERS` |

`OWNER` es el único rol que no se puede desactivar ni reasignar desde el
panel (`dashboard/usuarios`, filtrado explícito de `assignableRoles`).
`CUSTOMER` no es un preset ni tiene fila en `roles` — es un valor de
`UserRole` resuelto 100% en código vía `CUSTOMER_PERMISSION_GROUPS`
(`[CUSTOMER_ONLY, BOOKING]`).

---

## 4. Rutas sin `authorize()` — inventario completo

> **Enforced desde el 30/08/2026.** Este inventario dejó de ser solo
> documentación: `src/tests/security/rbac-route-coverage.test.ts` lo replica
> en su allowlist `PUBLIC_ROUTES` (22 entradas, 1:1 con las 22 filas **de
> ruta** de esta tabla) y falla si una ruta sin capa de autz no figura ahí — o
> si una entrada del allowlist dejó de matchear ninguna ruta. Las otras dos
> filas no tienen contraparte y no deben tenerla: la de `app.ts` son rutas que
> el test no escanea, y la de `platform.routes.ts (resto)` es historial de algo
> ya resuelto.
> Agregar una fila acá obliga a agregar la entrada allá, y al revés.
> **Ese cruce no lo verifica nada automático: es a ojo** (RBAC-SYNC-001).
>
> Verificado contra producción el 31/08/2026, sin token: `GET /api/auth/me`,
> `/api/business/modules`, `/api/business/plan-limits` y `/api/categories`
> devuelven `401 UNAUTHORIZED` con el JSON de la app, no un 401 de nginx. Eso
> prueba que **hoy** el mount de esas rutas está después del `authenticate()`
> de `src/app.ts:267`. Nada lo mantiene así: mover un `app.use` por encima de
> esa línea las deja públicas y las dos cercas siguen en verde (RBAC-MOUNT-001
> en `pendientes-2026-08-31.md`). Contra-chequeo:
> `GET /api/customer/foo/availability` devuelve `404 BUSINESS_NOT_FOUND`,
> llega al handler sin token, pública como dice esta tabla.

| Ruta | Por qué |
|---|---|
| `business.routes.ts` POST `/register` | Pública — alta de negocio nuevo, nadie tiene JWT todavía |
| `auth.routes.ts` POST `/`, `/select-business`, `/google` | Pública — emite el JWT |
| `customer.routes.ts` POST `/:businessSlug/register`, `/login`, `/login/google`, GET `/:businessSlug/availability`, POST `/logout` | Públicas — portal de clientes sin sesión todavía |
| `user-invitation.routes.ts` (`createInvitationAcceptanceRouter`) POST `/lookup`, `/accept` | Pública, montada ANTES de `authenticate()` — quien acepta la invitación no tiene JWT |
| `password-reset.routes.ts` (`createPasswordResetRouter`) POST `/request`, `/lookup`, `/accept` | Pública. `/request` (L, 23/08/2026) es el self-service "olvidé mi contraseña" — anti-enumeración, misma respuesta exista o no la cuenta (A7.1/A7.2). Todo el mount lleva `authLimiter` desde esta sesión (antes solo `globalLimiter`). |
| `platform.routes.ts` POST `/login` | Pública — login de plataforma |
| `me.routes.ts` GET `/me`, POST `/logout`, POST `/refresh` | Solo `authenticate()` — sobre uno mismo, no aplica chequeo de rol |
| `business-modules.routes.ts` GET `/` | Solo `authenticate()` — cualquier usuario ve los módulos de SU PROPIO negocio |
| `business-plan-limits.routes.ts` GET `/` (nuevo, L 23/08/2026) | Solo `authenticate()`, mismo criterio — cualquier usuario ve los límites de plan de SU PROPIO negocio (lo necesita el gating visual del CRUD de roles propios) |
| **`categories.routes.ts` GET `/`, GET `/:id`** | **✅ Confirmado intencional (sesión posterior, 23/08/2026) — no es un bug.** El portal de clientes (`appfrontend-main/.../portal/[businessSlug]/disponibilidad/page.tsx:37-41`) llama a este endpoint logueado, con su propio comentario explícito: *"El filtro de categoría solo está disponible logueado: GET /api/categories requiere autenticación aunque no exija un rol específico"* — un cliente necesita leer las categorías para filtrar el buscador de disponibilidad. `authorize(Roles.STAFF)` rompería esa pantalla real. Se agregó el comentario espejo del lado del backend (`categories.routes.ts`) para que no se "corrija" por error en el futuro. Sin cambio de código — se queda tal como está. |
| `platform.routes.ts` (resto) | **Resuelto 23/08/2026** — ver sección 2, ahora exige `authorizePlatform([SUPERADMIN])` |
| `app.ts` GET `/health`, `/health/db`, `/`, `/openapi.json`, `/docs` | Infraestructura, públicos a propósito. `/health/db` agregado el 01/09/2026 al separar liveness de readiness |

---

## 5. Patrones que se apartan del `authorize()` simple

1. **Jerarquía de rol a mano — `users.routes.ts` PUT `/:id`**: después de
   `authorize(Roles.MANAGEMENT)`, el handler calcula si el actor puede
   cambiarle la contraseña al objetivo (`ROLE_HIERARCHY_PROTECTED` si el
   objetivo tiene `OWNER_ONLY`/`MANAGEMENT` y el actor no es
   `OWNER_ONLY`) inspeccionando `req.user!.permissionGroups` directo, no
   vía `authorize()`. Es un segundo nivel de autorización (jerarquía),
   no un reemplazo del primero.
2. **Candado de campo fiscal — `business-profile.routes.ts` PUT `/`**:
   mismo patrón, calcula `isOwner` a mano después de `authorize(MANAGEMENT)`
   para que el service bloquee editar el CUIT una vez cargado, solo a
   `OWNER_ONLY`.
3. **Gate de router entero — `customer.routes.ts`**:
   `router.use(authenticate(), authorize(Roles.CUSTOMER_ONLY))` gatea las
   7 rutas de `/me/*` de una sola vez en vez de repetir `authorize()` en
   cada una. Además, 6 de esas 7 chequean `requireCustomerId()` (que el
   token tenga `customerId` seteado) y ownership del recurso
   (`existing.customer.id !== customerId`) a mano — ninguno de los dos es
   un chequeo de ROL, son de identidad/dato, `authorize()` no podría
   cubrirlos.
4. **`authorizePlatform()` con array de roles**: es el único lugar del
   repo donde una función de autorización recibe una LISTA de roles
   permitidos en vez de un solo grupo — pero es el sistema de PLATAFORMA
   (`PlatformRole`), no el catálogo `Roles.*` de tenant. No confundir los
   dos sistemas al leer código nuevo.
5. **Import de `authorize` por dos rutas distintas**: `rate-catalog.routes.ts`,
   `companies.routes.ts` y `customers.routes.ts` importan `authorize`
   desde `api/middleware/auth.middleware.wrapper.js` (re-export 1:1 de
   `security/auth.middleware.js`) en vez de directo — sin diferencia de
   comportamiento, cosmético, no urge homogeneizar.

---

## Fuera de alcance de esta auditoría (23/08/2026) — ver `pendientes-2026-08-23.md` sección L

- Panel de superadmin real para editar `plan_limits`/`role_presets` por
  plan y cambiar el plan de un negocio — sesión de diseño de producto
  aparte, con las preguntas de negocio ya relevadas.
- ~~`categories.routes.ts` GET sin gate de rol (sección 4) — pendiente de
  confirmar con el dueño~~ — ✅ confirmado intencional en la sesión posterior
  del 23/08/2026; la fila de la sección 4 es la buena. Desde el 30/08/2026
  queda fijado en código en `PUBLIC_ROUTES`.
- ~~Self-service de "olvidé mi contraseña" para staff~~ — ✅ resuelto
  (sesión posterior, 23/08/2026): `POST /api/password-resets/request`.
