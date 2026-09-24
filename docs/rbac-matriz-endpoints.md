# Matriz RBAC — endpoint × grupo de permisos

**Última actualización:** 24/09/2026 (D-05/P-03, Wave 15 -- `companies.routes.ts` suma 3 rutas nuevas: `POST /link-requests` (`MANAGEMENT` + `requirePlan(ENTERPRISE)`), `POST /link-requests/:id/approve` y `POST /link-requests/:id/reject` (las dos, `MANAGEMENT` + guard de pertenencia) -- 218 → 221 call-sites de `authorize()`). Actualización anterior: 23/09/2026 (ADR `ISSUE-BEFORE-REVERSE-WINDOW-001`, Bloque 6, §3.10 -- `invoices.routes.ts`, `GET /unreconciled` reclasificada de `FRONT_DESK` a `MANAGEMENT`; sin call-sites nuevos, 218 sigue igual -- se reclasifica un `authorize()` existente, no se agrega uno. Actualización anterior: mismo ADR, Bloque 3, §3.9/§3.14 -- `invoices.routes.ts` sumó 3 rutas nuevas: `GET /uncertain` (`MANAGEMENT`), `POST /:id/mark-not-issued` y `POST /:id/reconcile-with-afip` (las dos, `EMISOR_NOTA_CREDITO`) -- 215 → 218 call-sites de `authorize()`).

Este documento es la fuente de verdad de qué grupo de permisos exige cada
endpoint del backend hoy. Es un documento **vivo** — como
`criterios-negocio.md`/`criterios-datos.md`, se actualiza en el mismo
cambio que agrega o modifica una ruta, no después. El mecanismo que lo
mantiene honesto está en `src/tests/security/rbac-matrix-sync.test.ts`:
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
subconjunto de estos 9 grupos (sección 3).

| Grupo | Qué significa |
|---|---|
| `OWNER_ONLY` | Propietario solamente — configuración de plan, facturación |
| `MANAGEMENT` | Gestión operativa completa |
| `STAFF` | Todo el personal interno del negocio (excluye CUSTOMER) |
| `FRONT_DESK` | Personal de mostrador: gestiona reservas y clientes |
| `HOUSEKEEPING_AND_MANAGEMENT` | Housekeeping + management: ven y actualizan estado de habitaciones |
| `ORDERS` | Acceso a órdenes de consumo (POS) |
| `EMISOR_NOTA_CREDITO` | Emite la Nota de Crédito de cancelación (escape de la guarda fiscal de `cancelOrder()`/`cancelReservation()`) y resuelve la bandeja de reconciliación manual de esas NC. Dedicado — recepción lo tiene sin ser `MANAGEMENT` (ADR cancelar-con-NC §10 q7). Rutas: `POST /api/orders/:id/cancel-with-credit-note` (sub-bloque 4, 07/09/2026), `POST /api/reservations/:id/cancel-with-credit-note` (bloque 3.3-b2, 09/09/2026) y `POST /api/credit-note-requests/:id/resolve` (Bloque 5, 15/09/2026, §6.5 bis — las 2 rutas GET de la misma bandeja además aceptan `MANAGEMENT` vía `authorizeAny()`, solo lectura). |
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

## 2. Matriz de endpoints por archivo (221 call-sites, 39 archivos)

> **Corregido el 01/09/2026.** Este encabezado decía `(198 call-sites, 35
> archivos)` mientras `src/tests/security/rbac-matrix-sync.test.ts` (constantes
> `EXPECTED_AUTHORIZE_CALL_SITES`/`EXPECTED_ROUTES_FILE_COUNT`) exigía **204**
> y **37** — y la cerca pasaba. O sea que el documento mentía por 6 call-sites
> y 2 archivos, sin que nada lo detectara: la cerca valida el código contra
> sus constantes, **no** contra esta prosa.
>
> **No forma parte de D6.** Es la mitad visible de RBAC-SYNC-001 y se corrigió
> en su propio commit, aparte, para no atribuirle a D6 una deuda ajena. La
> otra mitad del ítem — ✅ **resuelta el 09/09/2026** — cruzaba a ojo la
> sección 4 de este documento contra `PUBLIC_ROUTES`; ahora lo hace
> `rbac-matrix-public-routes-sync.test.ts` (ver la nota en la sección 4).
>
> **Segunda recaída, `RBAC-MATRIX-HEADER-STALE-001` — ✅ resuelta el
> 09/09/2026.** El 09/09/2026 (bloque 3.3-b2, gate `architecture-governor`)
> `reservations.routes.ts` sumó la ruta de escape con Nota de Crédito y
> `EXPECTED_AUTHORIZE_CALL_SITES` subió de 205 a 206 en
> `rbac-matrix-sync.test.ts` — el encabezado de esta sección no se actualizó
> en ese momento y quedó diciendo "205 call-sites" por el resto del día. Se
> corrigió más tarde el mismo 09/09/2026 (`a8f9e67`; su nota inicial afirmó
> en pasado una cerca que todavía no existía, corregido en `80805f2`), y un
> tercer `it()` en `rbac-matrix-sync.test.ts` (`d39b8b7`) ahora cruza este encabezado contra
> `EXPECTED_AUTHORIZE_CALL_SITES`/`EXPECTED_ROUTES_FILE_COUNT` directamente
> — la misma enfermedad no debería poder pudrir este número una tercera vez
> sin que la suite se ponga roja. Ítem cerrado en `pendientes-2026-09-08.md`.

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
una sola vez 9 rutas: las 7 de `/me/*` (GET `/me`, POST `/refresh`,
DELETE `/me`, GET `/me/reservations`, POST `/me/reservations`,
PATCH `/me/reservations/:id`, POST `/me/reservations/:id/cancel`) más
GET `/categories` y GET `/bookable-services` (Wave 2, P-01/D-03,
16/09/2026 — catálogo de solo lectura para el wizard "Nueva reserva" del
portal; reemplaza el camino roto de leer las rutas de STAFF
`GET /api/categories`/`GET /api/bookable-services` vía `Roles.BOOKING`,
ver fila de `categories.routes.ts` en sección 4). 6 de las 7 rutas de
`/me/*` además chequean `requireCustomerId()` a mano y ownership del
recurso (`existing.customer.id !== customerId`) — ver sección 5; las 2
rutas de catálogo nuevas NO tienen `:id` de recurso ni ownership que
chequear (son lectura de catálogo del negocio, no datos personales). El
resto del archivo (registro/login/disponibilidad del portal) es público,
ver sección 4.

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
- POST `/:id/reverse` — `MANAGEMENT` **Y** `EMISOR_NOTA_CREDITO` (Bloque 3c-iii, 14/09/2026, §3.7/§4.4 del ADR de City Ledger — dos `authorize()` en cadena, primer endpoint del repo que lo hace)

### `src/facturacion/`

**`credit-note-requests.routes.ts`** (15/09/2026, Bloque 5 del ADR común cancelar-con-NC, `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5 bis — bandeja de reconciliación manual de `credit_note_request`)
- GET `/` — `authorizeAny([EMISOR_NOTA_CREDITO, MANAGEMENT])` (formato de grupo compuesto para OR real vía `authorizeAny()` — no confundir con `` `GRUPO_A` **O** `GRUPO_B` `` de dos `authorize()` encadenados, que es AND; §6.5 bis pregunta de negocio 3)
- GET `/:id` — `authorizeAny([EMISOR_NOTA_CREDITO, MANAGEMENT])`
- POST `/:id/resolve` — `EMISOR_NOTA_CREDITO` (simple, NO `authorizeAny` — la transición de estado no se amplía a MANAGEMENT, solo la lectura)

**`invoices.routes.ts`** — `requireModule(FACTURACION)` en las MUTACIONES y en `createAfipCredentialsRouter`. Los GET de `/api/invoices` van **sin** gate de módulo: leer un comprobante fiscal ya emitido es obligación legal de exhibición (`criterios-datos.md` línea 24; ver `diseno-cascada-enforcement-2026-08-30.md` §3d — 30/08/2026). Dos routers:
- `createInvoicesRouter`: POST `/` — `FRONT_DESK` (+ `requireModule(FACTURACION)`; si el cargo pertenece a un cliente `kind='COMPANY'` exige **además** `MANAGEMENT`, chequeo inline en el handler, no un `authorize()` de más — 13/09/2026, `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` hallazgo 3, ver `requireManagementForCompanyCharge()` en `invoices.routes.ts`; NO aplica si el cargo es `REFUND`/`ADJUSTMENT` — la Nota de Crédito del escape de cancelación sigue alcanzando con `EMISOR_NOTA_CREDITO`, decisión separada del dueño); POST `/consolidated` — `MANAGEMENT` (+ `requireModule(FACTURACION)`, C1-Fase C, "Facturar ahora"); GET `/unreconciled` — `MANAGEMENT` (sin gate de módulo, 10/09/2026 — bandeja "factura viva no conciliada", registrada ANTES de `/:id` para no quedar sombreada por ese patrón; RBAC subido de `FRONT_DESK` a `MANAGEMENT` el 23/09/2026, ADR `ISSUE-BEFORE-REVERSE-WINDOW-001` Bloque 6, §3.10 — mismo criterio que `/uncertain`, endpoint completo sin partir, sin consumidor conocido hoy en `appfrontend-main`); GET `/uncertain` — `MANAGEMENT` (sin gate de módulo, 23/09/2026, ADR `ISSUE-BEFORE-REVERSE-WINDOW-001` Bloque 3, §3.9 — bandeja de facturas `FAILED_UNCERTAIN` sin resolver, registrada ANTES de `/:id`, mismo motivo que `/unreconciled`); GET `/:id` — `FRONT_DESK` (sin gate de módulo); GET `/:id/pdf` — `FRONT_DESK` (sin gate de módulo); GET `/` — `FRONT_DESK` (sin gate de módulo); POST `/:id/mark-not-issued` — `EMISOR_NOTA_CREDITO` (sin gate de módulo, mismo criterio que `POST /api/credit-note-requests/:id/resolve` — resolver el estado ambiguo de una factura ya existente no puede quedar detrás de un entitlement revocable — 23/09/2026, ADR Bloque 3, §3.9); POST `/:id/reconcile-with-afip` — `EMISOR_NOTA_CREDITO` (ídem, sin gate de módulo — 23/09/2026, ADR Bloque 3, §3.14, P-1)
- `createAfipCredentialsRouter` (todo `requireModule(FACTURACION)`): GET `/status` — `MANAGEMENT` (solo devuelve `{configured, environment}`, nunca el secreto -- no escaló); PUT `/` — `OWNER_ONLY` (15/09/2026, F2-06, antes `MANAGEMENT` -- mismo nivel que el candado de campo fiscal de `business-profile.routes.ts`, ver punto 6 de la sección 5); DELETE `/` — `OWNER_ONLY` (ídem PUT)

### `src/platform/`

**`admin.routes.ts`** — sistema de PLATAFORMA, no de tenant. `authenticatePlatform() + authorizePlatform([SUPERADMIN])` en todo el router: POST `/set-tenant-url` (`repair-tenant-db` retirado 16/09/2026, D-06/P-04, Wave 7 del plan de ejecución integral — trampa armada, ver `docs/decisiones-plan-integral-2026-09-16.md:63-68`).

**`platform.routes.ts`** — sistema de PLATAFORMA. **23/08/2026: se agregó `authorizePlatform([SUPERADMIN])`** (antes solo `authenticatePlatform()`, ver sección 5 — era el único router de plataforma sin ese segundo gate). POST `/login` es público (antes del `router.use`). El resto: GET `/stats`, GET `/businesses`, POST `/businesses`, GET `/businesses/:id`, PATCH `/businesses/:id/status`, POST `/businesses/:id/provision`, **PATCH `/businesses/:id/plan`** (nuevo, L), **GET/PUT `/plan-limits[/:plan]`** (nuevo, L — editar `plan_limits`/`plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`), **GET/PUT `/role-presets[/:name]`** (nuevo, L — editar el catálogo global de los 5 roles de fábrica; corrección 09-10/09/2026: SÍ afecta negocios ya provisionados, vía el backfill que corre en cada arranque del proceso — ver `platform.routes.ts:444-459` y `docs/pendientes-2026-09-10.md`, `PRESET-REVOKE-001`, para el mecanismo completo y sus límites), **POST `/outbox/purge`** (nuevo, 12/09/2026, Caso 1 — purga `domain_events` resueltos con más de 90 días en TODOS los tenants, misma función que `npm run purge:outbox`, ver `platform/outbox-purge.ts`).

**`business-hours.routes.ts`**
- GET `/` — `BOOKING`
- POST `/` — `MANAGEMENT`
- DELETE `/:id` — `MANAGEMENT`

**`companies.routes.ts`**
- GET `/me` — `MANAGEMENT`
- POST `/` — `MANAGEMENT` (+ `requirePlan(ENTERPRISE)` — gate de PLAN, no de módulo)
- POST `/link` — `MANAGEMENT` (+ `requirePlan(ENTERPRISE)`)
- POST `/link-requests` — `MANAGEMENT` (+ `requirePlan(ENTERPRISE)`) — D-05/P-03 (24/09/2026, Wave 15): pide vincular el negocio propio a una company existente, crea `company_link_requests` PENDING, no vincula nada todavía.
- POST `/link-requests/:id/approve` — `MANAGEMENT` + guard de pertenencia (`assertEligibleApprover()`, no solo el rol — el aprobador tiene que ser MANAGEMENT de un negocio YA vinculado a la company destino de la solicitud, ver companies.routes.ts).
- POST `/link-requests/:id/reject` — `MANAGEMENT` + mismo guard de pertenencia que approve.

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
- POST `/:id/check-out` — `FRONT_DESK` (`overridePendingBalance: true` exige además `MANAGEMENT`, chequeo inline en el handler — 12/09/2026, caso 3 de `docs/investigacion-decisiones-bloqueado-2026-09-12.md`)
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
- POST `/:id/cancel-with-credit-note` — `EMISOR_NOTA_CREDITO` (ADR común cancelar-con-NC sub-bloque 4, 07/09/2026 — escape administrativo: cancela con Factura B viva emitiendo una Nota de Crédito)
- PATCH `/:id/notes` — `ORDERS`
- POST `/:id/items` — `BOOKING`
- DELETE `/:id/items/:itemId` — `ORDERS`

**`products.routes.ts`** — todo `MANAGEMENT` salvo:
GET `/`, POST `/`, GET `/company-catalog`, GET `/:id`, PUT `/:id`, DELETE `/:id`, GET/POST/PUT/DELETE `/:id/variants*`, GET/POST/PUT/DELETE `/:id/recipe-items*`, POST `/stock/transfer`, POST `/stock/waste`, POST `/stock/consumption`, POST `/stock/production`, POST `/:id/company/share`, `/publish`, `/price-override/*`, `/recipe-override/*`
→ excepciones **`ORDERS`**: POST `/:id/stock/decrement`, POST `/:id/variants/:variantId/stock/decrement`.

**`service-items.routes.ts`** (15/09/2026, Bloque B, `docs/diseno-factura-borrador-2026-08-31.md` §29.7 — catálogo de service_items, item_type SERVICE de `order_items`; el wiring de precio/descripción en `OrderPricingService`/`InvoiceService` queda para los Bloques C/D)
- GET `/` — `ORDERS`
- GET `/:id` — `ORDERS`
- POST `/` — `MANAGEMENT`
- PUT `/:id` — `MANAGEMENT`
- DELETE `/:id` — `MANAGEMENT`

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
- POST `/:id/cancel-with-credit-note` — `EMISOR_NOTA_CREDITO` (bloque 3.3-b2, 09/09/2026 — escape administrativo: cancela con Factura B viva emitiendo una Nota de Crédito, mismo criterio que el escape de órdenes)
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
| `OWNER` | `OWNER_ONLY`, `MANAGEMENT`, `STAFF`, `FRONT_DESK`, `HOUSEKEEPING_AND_MANAGEMENT`, `ORDERS`, `BOOKING`, `EMISOR_NOTA_CREDITO` |
| `ADMIN` | `MANAGEMENT`, `STAFF`, `FRONT_DESK`, `HOUSEKEEPING_AND_MANAGEMENT`, `ORDERS`, `BOOKING`, `EMISOR_NOTA_CREDITO` |
| `RECEPTIONIST` | `STAFF`, `FRONT_DESK`, `BOOKING`, `EMISOR_NOTA_CREDITO` |
| `HOUSEKEEPING` | `STAFF`, `HOUSEKEEPING_AND_MANAGEMENT` |
| `WAITER` | `STAFF`, `ORDERS` |

`EMISOR_NOTA_CREDITO` (07/09/2026): grupo dedicado al escape de cancelación
con Nota de Crédito. Se suma a `RECEPTIONIST` además de a los presets que ya
tienen `MANAGEMENT` (`OWNER`, `ADMIN`) — decisión del dueño (ADR §10 q7): la
recepción tiene que poder emitir la NC sin escalar a OWNER/ADMIN. **No** entra
en `plan_limit_allowed_permission_groups` (FREE/STARTER) — un rol CUSTOM de
esos planes no puede incluirlo, mismo criterio que `OWNER_ONLY`/`MANAGEMENT`;
la recepción lo recibe vía el preset en todos los planes.

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
> **✅ Cruce automatizado (09/09/2026, RBAC-SYNC-001 §4 resuelto, gate
> `architecture-governor`):** `src/tests/architecture/rbac-matrix-public-routes-sync.test.ts`
> parsea esta tabla y la cruza contra `PUBLIC_ROUTES` en las dos
> direcciones — falla si una fila de acá no tiene contraparte en el
> código, o al revés. Sigue siendo una cerca de texto (parsea la PRIMERA
> celda de cada fila con backticks + palabra en mayúsculas = método,
> fail-loud si no reconoce el formato), no valida montaje de `app.ts` —
> eso sigue siendo `api-auth-gate-order.test.ts`/`rbac-route-coverage.test.ts`
> (ver sus propios límites declarados).
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
| `business.routes.ts` POST `/` (montado en `/register`) | Pública — alta de negocio nuevo, nadie tiene JWT todavía |
| `auth.routes.ts` POST `/`, `/select-business`, `/google` | Pública — emite el JWT |
| `customer.routes.ts` POST `/:businessSlug/register`, `/:businessSlug/login`, `/:businessSlug/login/google`, GET `/:businessSlug/availability`, POST `/logout` | Públicas — portal de clientes sin sesión todavía |
| `user-invitation.routes.ts` (`createInvitationAcceptanceRouter`) POST `/lookup`, `/accept` | Pública, montada ANTES de `authenticate()` — quien acepta la invitación no tiene JWT |
| `password-reset.routes.ts` (`createPasswordResetRouter`) POST `/request`, `/lookup`, `/accept` | Pública. `/request` (L, 23/08/2026) es el self-service "olvidé mi contraseña" — anti-enumeración, misma respuesta exista o no la cuenta (A7.1/A7.2). Todo el mount lleva `authLimiter` desde esta sesión (antes solo `globalLimiter`). |
| `platform.routes.ts` POST `/login` | Pública — login de plataforma |
| `me.routes.ts` GET `/me`, POST `/logout`, POST `/refresh` | Solo `authenticate()` — sobre uno mismo, no aplica chequeo de rol |
| `business-modules.routes.ts` GET `/` | Solo `authenticate()` — cualquier usuario ve los módulos de SU PROPIO negocio |
| `business-plan-limits.routes.ts` GET `/` (nuevo, L 23/08/2026) | Solo `authenticate()`, mismo criterio — cualquier usuario ve los límites de plan de SU PROPIO negocio (lo necesita el gating visual del CRUD de roles propios) |
| **`categories.routes.ts` GET `/`, GET `/:id`** | **Actualizado (Wave 2, P-01/D-03, 16/09/2026) — el motivo original del 23/08/2026 ya no aplica.** Decía intencional porque el portal de clientes leía este endpoint logueado (mismo mecanismo que `authorize(Roles.BOOKING)`, que CUSTOMER satisface). Dos cosas cambiaron: (1) esa ruta estaba rota (500) para el portal desde el 03/07/2026, sin que nadie lo notara — `tenantMiddleware` nunca fijaba `req.db` para tokens CUSTOMER en rutas de staff; (2) el fix de D-03 (rechazo por ACTOR en `tenantMiddleware`, `src/platform/tenant.middleware.ts`) ahora responde 403 deliberado para CUALQUIER token CUSTOMER en cualquier ruta de staff, con o sin `authorize()`. El portal ya NO llama a esta ruta — usa el endpoint dedicado `GET /api/customer/categories` (ver sección 2, prosa de `customer.routes.ts`). Sigue sin `authorize()` porque el resto de STAFF (FRONT_DESK/RECEPTIONIST/etc.) todavía la necesita sin restricción de grupo — eso no cambió. |
| `platform.routes.ts` (resto) | **Resuelto 23/08/2026** — ver sección 2, ahora exige `authorizePlatform([SUPERADMIN])` |
| `app.ts` GET `/health`, `/health/db` | Infraestructura, públicos a propósito. `/health/db` agregado el 01/09/2026 al separar liveness de readiness |
| `app.ts` GET `/`, `/openapi.json`, `/docs` | **Ya NO se montan en producción** (01/09/2026, `api/docs-exposure.ts`). Eran públicos por default de armado, no por decisión: exponían la superficie completa de la API y, hasta ese día, credenciales en texto plano dentro del propio spec — en la descripción, en los `examples` del login que Swagger precarga, y en el `example` del campo `password`. Con `NODE_ENV=production` no se montan y Express responde 404. En desarrollo siguen igual |

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
6. **Candado de secreto fiscal — `invoices.routes.ts` `createAfipCredentialsRouter`
   PUT/DELETE `/`**: no es un chequeo a mano como los puntos 1/2 de arriba —
   directo `authorize(Roles.OWNER_ONLY)` — pero se documenta acá porque es
   el mismo criterio que el punto 2 (candado de campo fiscal) aplicado al
   certificado/clave AFIP en vez de al resto del perfil fiscal: ambos
   viven en `business_profile`, ambos exigen `OWNER_ONLY` para escribir.
   GET `/status` se queda en `MANAGEMENT` porque no expone el secreto
   (F2-06, 15/09/2026).

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
