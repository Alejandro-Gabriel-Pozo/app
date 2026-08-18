# Pendientes — Martes 18 de Agosto 2026

Arranca a partir de lo que quedó abierto en `pendientes-2026-08-17.md`.
Mismo criterio de agrupación: deuda estructural primero, seguridad
después, calidad de código, backlog, observaciones sin implementar.
Marcar `✅ RESUELTO` in-place al cerrar un ítem.

---

## A. Resuelto hoy (18/08) — bugs de backend encontrados durante la migración a Refine/Bastión del dashboard (`appfrontend-main`)

Ningún de los tres estaba anotado como pendiente — se encontraron
probando el dashboard migrado contra el backend real, no en un review de
código. Los tres tienen test manual contra Postgres real (Neon) antes de
darlos por cerrados.

- ✅ **Housekeeping — fecha de `GET /housekeeping?date=` corría un día**
  (commit `a84f6a0`). `new Date(dateParam)` se pasaba directo al driver de
  `pg`, que serializa objetos `Date` con la zona horaria LOCAL del
  proceso — `scheduled_for::date = $2::date` terminaba comparando contra
  el día anterior/siguiente según el huso del server. `date` pasa ahora
  como string `'YYYY-MM-DD'` de punta a punta (routes/service/repository,
  incluida la versión in-memory de tests), sin pasar nunca por un objeto
  `Date`. 400 explícito si el query param no matchea el formato.
- ✅ **Reservas — confirmar devolvía 500 pese a quedar `CONFIRMED`**
  (commit `e31ba85`, schema v16). `occupancy_records` nunca tuvo
  `category_id`/`category_name`, aunque el repositorio ya las escribía
  desde el fix de agrupación por categoría en reportes — Postgres 42703
  (columna inexistente). `recordOccupancy()` corre DESPUÉS de la
  transacción que confirma la reserva, así que el cliente recibía 500 pese
  a que el estado ya había quedado `CONFIRMED` en la base. `ALTER TABLE
  ... ADD COLUMN IF NOT EXISTS` con `DEFAULT ''` — solo afecta filas ya
  existentes.
- ✅ **Clientes-finanzas — el CHARGE de toda reserva/orden confirmada
  fallaba al despacharse** (commit `a53b158`, dos bugs SQL apilados en
  `SqlFinancialTransactionRepository.insert()`): (1) `$2`/`$13` reusados
  en dos posiciones sintácticas distintas (VALUES vs. CASE/subquery de
  `shift_id`) causaban "inconsistent types deduced for parameter" (PG
  42P08) — cast explícito en la segunda aparición. (2) Una vez arreglado
  eso, `ON CONFLICT (idempotency_key) DO NOTHING` no matcheaba el índice
  único parcial real (`WHERE idempotency_key IS NOT NULL`) — PG 42P10 —
  arreglado agregando el mismo `WHERE` al `ON CONFLICT`. Verificado
  end-to-end: dos reservas nuevas generaron su CHARGE, y el evento
  original que había quedado dead-lettered (60 reintentos) se reprocesó a
  mano y cerró bien; cola de dead-letter en 0 al terminar.

## B. Resuelto hoy (18/08) — proceso: `DEFENSIVE_DEVELOPING.md` sin uso real

- ✅ **`docs/DEFENSIVE_DEVELOPING.md` existía pero su único disparador (el
  checklist del PR template) no se ejercitaba** (commit `0c8af7f`) — el
  trabajo reciente se commitea directo a `main` sin pasar por PR, y el
  archivo no estaba referenciado en `CLAUDE.md` (el único que se carga
  solo en cada sesión). Detectado porque el propio dueño preguntó si se
  estaba usando. Ahora `CLAUDE.md` lo hace obligatorio también en el
  mensaje de commit cuando no hay PR de por medio, en paralelo a
  `criterios-negocio`.

---

## C. Heredado de `pendientes-2026-08-17.md`, sigue abierto

Sin cambios desde ayer — ver `pendientes-2026-08-15.md`/`-16.md`/`-17.md`
para el detalle completo de cada uno:

### Deuda estructural / arquitectura
- ✅ **RESUELTO (18/08/2026, noche)** — Presets de roles de fábrica
  hardcodeados y duplicados en TS (`platform.repository.ts:151-177`) y SQL
  (`platform.schema.sql:233-260`). A pedido explícito del dueño ("vamos
  con presets de roles a config editable"). Se creó el catálogo de
  plataforma `role_presets`/`role_preset_permission_groups`
  (`platform.schema.sql`, mismo patrón que `modules`/`business_modules`:
  tabla seedeada una vez con `ON CONFLICT DO NOTHING`), y tanto el
  backfill SQL para negocios existentes como
  `PlatformRepository.provisionSystemRoles()` (TS) ahora LEEN de esa
  tabla en vez de repetir los 5 roles × grupos de permisos en dos lugares
  a mano. El catálogo de grupos de permisos en sí (`Roles.X` de
  `security/roles.ts`) sigue hardcodeado a propósito — eso no cambió, ver
  el comentario ya existente en el schema (agregar un grupo nuevo siempre
  implica una ruta nueva en código). Panel de superadmin para editar esto
  sin tocar código sigue sin alcance definido (ver nota "quizá" del
  17/08, más abajo) — este cambio solo saca la duplicación, no agrega esa
  UI. Test de regresión nuevo (`platform.repository.test.ts`, fake
  `SqlClient` con presets "de mentira" que detectarían si alguien
  reintroduce un array hardcodeado). **Verificado contra Postgres real**
  (misma BD de los negocios de prueba `demo`/`refine-test-business`):
  `platform.schema.sql` aplicado, catálogo sembrado con los 5 presets
  esperados, roles de los dos negocios existentes sin cambios (mismos
  grupos que antes), y un negocio de prueba nuevo creado/borrado
  confirmó que `provisionSystemRoles()` deriva los roles correctos desde
  la tabla — cascade de borrado limpió todo sin huérfanos. Verificado:
  `tsc --noEmit` limpio, `npm run lint` limpio, `npm test` 545/545
  (+1 test nuevo).
- ✅ **RESUELTO (18/08/2026, noche)** — `PLAN_LIMITS` (`src/config/plan-limits.ts`)
  seguía siendo una constante de código. A pedido explícito del dueño
  ("PLAN_LIMITS a tabla en BD"). Se creó `plan_limits`/
  `plan_limit_allowed_roles` en `platform.schema.sql` (mismo patrón que
  `role_presets` de este mismo documento): `NULL` en las columnas
  numéricas = sin límite (mapeado a `Infinity` al leer, plan PRO); 0 filas
  en `plan_limit_allowed_roles` para un plan = sin restricción de roles
  (mapeado a `'ALL'`). Nuevo `PlatformRepository.getPlanLimits(plan)` +
  `AppContainer.getPlanLimits(plan)` (container.ts, mismo contrato de
  error que `getBusinessPlan`/`getBusinessModules`: lanza si el plan no
  tiene fila configurada, en vez de aplicar un límite por default en
  silencio). `plan-limits.ts` ahora solo declara el tipo `PlanLimits`, sin
  la constante. `CategoryService.createCategory()` pasa a recibir
  `limits: PlanLimits` ya resuelto por la capa HTTP (no consulta la BD de
  plataforma desde un service tenant-only — se mantiene la separación que
  ya regía `plan`); `categories.routes.ts` y `usuarios-roles/users.routes.ts`
  (los dos call sites, POST y PUT) resuelven `getBusinessPlan` +
  `getPlanLimits` en el mismo try/catch 503 PLATFORM_UNAVAILABLE. Tests
  nuevos: `PlatformRepository.getPlanLimits()` (mapeo NULL→Infinity y
  0-filas→'ALL' con fake `SqlClient`, sin base real) y
  `CategoryService.createCategory()` con límite de plan (antes sin
  cobertura, gap preexistente). **Verificado contra Postgres real**
  (misma BD de `demo`/`refine-test-business`): schema aplicado, los 3
  planes (FREE/STARTER/PRO) devuelven exactamente los mismos valores que
  la constante hardcodeada de antes, incluida la conversión NULL→Infinity
  de PRO. Verificado: `tsc --noEmit` limpio, `npm run lint` limpio,
  `npm test` 551/551 (+7 tests nuevos).
- ✅ **RESUELTO (18/08/2026, noche)** — Huso horario Argentina fijo
  (`-03:00`) en `reservation.service.ts::combineDateAndTime()`. A pedido
  explícito del dueño ("sigamos con el huso horario Argentina fijo"), con
  dos decisiones confirmadas antes de tocar código: (1) agregar `luxon`
  (primera dependencia de fechas del proyecto — manejar DST a mano con
  `Intl` es fácil de hacer sutilmente mal, y es un camino crítico ya
  verificado); (2) cerrar A4.7 ahora con una política explícita, no
  dejarla para cuando exista un negocio real en un huso con DST.
  `combineDateAndTime()` ahora recibe `timezone: string` (IANA) en vez de
  usar `-03:00` fijo, y usa `DateTime.fromObject(..., { zone: timezone })`
  de luxon. **Política A4.7** (verificada empíricamente contra
  transiciones reales de `America/Santiago` 2024, luxon 3.7 — resultó ser
  el comportamiento DEFAULT de la librería, sin código adicional): hora
  inexistente (hueco de primavera) → avanza por el tamaño del salto,
  aterriza en un instante válido; hora ambigua (vuelta de otoño) → toma
  el offset ESTÁNDAR (la ocurrencia más tardía), no el de verano.
  `getAvailableSlots()` gana un parámetro `timezone` obligatorio, resuelto
  en `bookable-services.routes.ts` desde `business_profile.timezone`
  (A4.2, ya existía desde el 17/08 — antes nadie lo leía para esto). Sin
  cambio de comportamiento para negocios existentes: el default de
  `business_profile.timezone` sigue siendo
  `America/Argentina/Buenos_Aires`. Tests nuevos: 2 golden-value contra
  las transiciones reales de Chile 2024 (no fechas relativas a "hoy") +
  los 6 tests existentes de `getAvailableSlots` actualizados con el
  parámetro `timezone` (siguen en verde, confirman cero regresión para
  Argentina). Verificado: `tsc --noEmit` limpio, `npm run lint` limpio,
  `npm test` 562/562 (+2 tests nuevos), `npm run build` limpio (smoke
  test de import del módulo compilado, confirma que la interop ESM de
  luxon resuelve bien en runtime).
- F2(c): edición fina de permisos por rol como feature de plan — no
  implementado. Cualquier plan, sin restricción, ya puede editar
  `permissionGroups` de un rol de sistema hoy vía `PUT /api/roles/:id`.
- Decidir si portal de clientes/plataforma migra a cookie httpOnly o
  queda como está.
- ✅ **RESUELTO (18/08/2026, noche)** — Empresas multipropiedad (`companies`)
  sin gate de plan. A pedido explícito del dueño ("gate de plan Enterprise
  para empresas multipropiedad"). Se agregó `BusinessPlan.ENTERPRISE`
  (`types/enums.ts`) — mismos límites numéricos que PRO en `plan_limits`
  (sin límite; confirmado con el dueño que Enterprise es superset de PRO,
  no un tier con topes propios — los números son solo una fila de tabla,
  ajustables sin deploy cuando se decida el pricing real). CHECK de
  `businesses.plan` ampliado en `platform.schema.sql`. Nuevo
  `security/plan.middleware.ts` (`requirePlan`), mismo contrato de
  errores que `requireModule` (401/402 `PLAN_UPGRADE_REQUIRED`/503),
  aplicado solo a `POST /api/companies` y `POST /api/companies/link`
  (`companies.routes.ts`) — a propósito NO en `GET /api/companies/me`, así
  un negocio que baja de plan sigue viendo a qué empresa pertenece. Tests
  nuevos: `plan.middleware.test.ts` (unit, las 4 ramas del middleware) +
  `companies.routes.test.ts` (corre la cadena completa de middlewares —
  `authorize` + `requirePlan` + handler real — para detectar si alguien
  borra el gate de la ruta sin que un test de `requirePlan` en
  aislamiento lo note, DEFENSIVE_DEVELOPING principio 3). **Verificado
  contra Postgres real**: negocio de prueba en plan PRO rechazado con 402
  al crear empresa; el mismo negocio pasado a ENTERPRISE temporalmente lo
  permitió (201, company creada y vinculada); revertido el plan y borrada
  la company de prueba al terminar, estado restaurado a como estaba antes
  del test. Verificado: `tsc --noEmit` limpio, `npm run lint` limpio,
  `npm test` 560/560 (+9 tests nuevos).

### Decisiones que necesitan al dueño
- E2–E7 de `pendientes-2026-08-13.md` (salvo E7c/d/e, ya resueltos) —
  falta que se defina alcance. **E1 se resolvió hoy completo, ver sección
  F.** Dentro de E7a, el gap de "descuento de stock en POS" resultó estar
  ✅ **ya resuelto** (verificado hoy, no es trabajo nuevo) — quedó
  arreglado de paso durante el carve-out de inventario del 16-17/08 sin
  que nadie volviera a marcarlo acá. El resto de E7a (horarios de
  servicios, housekeeping /me y /status, alta de negocio, locations)
  sigue abierto, sin cambios.
- Nota "quizá" del dueño (17/08, tarde): panel de superadmin para editar
  presets de roles/`PLAN_LIMITS` sin tocar código a mano — más grande que
  solo migrar a tabla (implica endpoint + UI de admin), sin alcance
  definido todavía.

### Backlog / integraciones externas
- Facturación electrónica AFIP — investigado (`referencia-afip-wsfev1.md`),
  nada implementado. Bloquea con ABM de Empresa (perfil fiscal) y de
  Producto (IVA). Plan: SDK `arcasdk-main` (Node/TS).
- Mails de reserva confirmada — falta cuenta de Resend + dominio
  verificado (`NoopEmailSender` hasta entonces).
- Login con Google — falta crear el OAuth Client ID en Google Cloud
  Console y cargar `GOOGLE_CLIENT_ID`/`NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
- Portal de clientes: falta landing + alta pública de negocio, y
  mecanismo de "reclamo" (`claim`/`merge`) completo (el login con Google
  ya resuelve el caso más común, no el fusionar historial).
- Sitios corporativos (dominio propio) + guest checkout + magic link —
  solo documentado.
- **Sin endpoint para que un negocio cambie su propio plan** (self-serve
  billing) — hoy el único camino es una `UPDATE businesses SET plan = ...`
  a mano en la BD central. No es una limitante hoy (sin cobro online
  todavía), pero significa que activar el plan ENTERPRISE nuevo (ver punto
  de "gate de plan Enterprise" más arriba) también depende de eso mismo:
  ningún negocio puede pasarse solo a ENTERPRISE, lo hace el dueño directo
  en la base. Anotado a pedido del dueño (18/08, noche) — no bloquea nada
  hoy, es contexto para cuando se diseñe upgrade/downgrade de plan.

### Frontend faltante — ✅ RESUELTO (18/08/2026, noche)

Los cuatro ítems de este bloque se implementaron y verificaron end-to-end
contra el backend real (Playwright + `owner@refinetest.local`), en el
orden pedido por el dueño. Detalle:

- ✅ **Botón "marcar como servido"** en Órdenes (`POST /:id/serve`, ya
  existía en backend). Se agregó `servedAt` a `Order` (faltaba en el tipo
  del frontend) y el botón condicionado a `status === 'CONFIRMED' &&
  !servedAt`. Verificado: confirmar → servir → badge "✓ Servida" → completar.
- ✅ **Catálogo de motivos de merma + registrar merma** — pantalla nueva
  `Motivos de Merma` (CRUD simple, acento clay) + botón "Merma" en
  Productos (solo productos sin variantes) que abre un modal y llama
  `POST /api/products/stock/waste`. Verificado: stock decrementado
  exactamente lo esperado (100→94 con cantidad 6, etc.), confirmado contra
  la API directa.
- ✅ **Producto COMPOSITE + receta + Producción** — el form de Productos
  ahora tiene selector de `productType` y checkbox `assembleOnDemand`
  (faltaban en el tipo `Product`/`CreateProductInput` del frontend); nueva
  subpágina `productos/[id]/receta` para el BOM (alta/edición/baja de
  ítems); botón "Producir" (solo COMPOSITE + `assembleOnDemand=false`) que
  llama `POST /api/products/stock/production`. Verificado end-to-end:
  producto compuesto con receta de 3 unidades de un componente, producir 2
  → componente se descuenta 6 exacto, compuesto sube a 2 — matemática de
  explosión de receta confirmada contra la API.
- ✅ **Empresas multipropiedad** — pantalla nueva `Empresa` (crear/vincular
  una empresa, ver catálogo compartido) + en Productos: botón "Compartir"
  para productos locales, botón "Vínculo" (con indicador de revisión
  pendiente) que abre un modal de gestión de override de precio Y receta
  (activar/desactivar/aceptar/rechazar) + publicar cambios como maestro.
  **Gap de backend encontrado y resuelto de paso:** no existía ningún
  endpoint que expusiera si el negocio ya pertenece a una empresa — sin
  eso, la UI no podía evitar que alguien creara una empresa nueva sin
  saber que ya estaba vinculado a otra (`linkBusinessToCompany` sobre-
  escribe `company_id` sin confirmación). Se agregó `GET /api/companies/me`
  (`platform/companies.routes.ts`, MANAGEMENT, solo lee la BD central).
  Verificado end-to-end: crear empresa → alta de producto se auto-comparte
  (`companyProductId` confirmado contra la API) → aparece en el catálogo
  → ciclo completo activar/desactivar override de precio → publicar.
  **No verificado en este pase** (necesitaría un segundo negocio/tenant
  real): el estado `PENDIENTE_DE_REVISION` que dispara cuando OTRA
  sucursal cambia el maestro — cubierto por los 36 tests de
  `CompanyCatalogService` que ya pasan (ver pendientes-2026-08-17.md
  sección E), no re-verificado por UI.
- **Deliberadamente fuera de alcance:** alta de un producto ya vinculado a
  un canónico existente vía picker (`companyProductId` en
  `CreateProductInput`) — el alta automática ya cubre el caso común
  (compartir SIEMPRE al crear); ese flujo es para el caso más raro de
  "quiero vincular esto a un producto que YA existe en el catálogo de la
  empresa", se deja para cuando se pida explícito.

Verificado (frontend): `tsc --noEmit` limpio, `npm run lint` limpio,
`npm run build` limpio (24 rutas, incluidas las 3 nuevas). Verificado
(backend): `tsc --noEmit` limpio, `npm run lint` limpio, `npm test`
538/539 (mismo conteo que antes — el endpoint nuevo no rompió nada).

---

## D. Nota de contexto — trabajo de `appfrontend-main` en paralelo (18/08)

No es "pendiente" en sí, pero da contexto a por qué aparecieron los tres
bugs de la sección A: se completó la integración de Refine.dev como capa
de datos del dashboard admin y la migración visual al sistema de diseño
"Bastión" en las 14 pantallas de gestión (+ subpágina de variantes).
Detalle en `appfrontend-main/docs/sistema-diseno-bastion.md` sección 7.
Sin pendientes nuevos de ese lado — quedó pusheado completo.

---

## F. E1 resuelto (18/08/2026, noche) — Reservas separado de Turnos

A pedido explícito del dueño ("vamos con E1"), alcance completo elegido
("Separación completa de paneles", confirmado por pregunta directa antes
de tocar código — la otra opción era un arreglo puntual sin pantalla
nueva). Resuelve el síntoma original: una reserva de servicio (ej. corte
de pelo) contaminaba el panel de Estadías (bug de referencia: "Barbero
Isahía en el dropdown de check-in").

**Backend:**
- `resource_categories` gana `is_lodging BOOLEAN NOT NULL DEFAULT FALSE`
  (schema v17) — `true` = categoría de alojamiento (Reservas/Estadías),
  `false` = servicio (Turnos). Default `FALSE`: no hay forma de inferir
  esto en categorías ya existentes, hay que marcarlas a mano desde
  Categorías después de este deploy.
- `ResourceCategory`/`CreateCategoryDTO`/`UpdateCategoryDTO`
  (`types/resource-category.types.ts`), `SqlCategoryRepository`,
  `category.schemas.ts` (Zod) y `categories.routes.ts` — `isLodging` de
  punta a punta en GET/POST/PUT.
- **Bug real encontrado de paso, no relacionado con E1 en sí:**
  `schema.sql` tenía 4 bloques sucesivos `DROP+ADD CONSTRAINT` para
  `chk_stock_movements_movement_type` (uno por cada `movement_type` que se
  fue agregando: base → TRANSFER → WASTE → PRODUCTION). Al reaplicar el
  archivo completo desde cero contra un tenant que YA tiene filas con
  `WASTE`/`PRODUCTION` (cualquier negocio activo con POS, incluido el de
  prueba de esta sesión), el primer bloque —el más angosto, ya
  superado— fallaba contra esas filas reales, rompiendo la idempotencia
  que `migrate:tenants` asume (¡corre en cada deploy de Render! — un
  negocio con esas filas hubiera tumbado el build). Consolidado en un
  único DROP+ADD con la lista completa. Encontrado porque intentar migrar
  el negocio de prueba a v17 falló con ese error antes de arreglarlo.

**Frontend:**
- Categorías: checkbox "Es alojamiento" en el form de crear/editar +
  indicador en cada card ("Alojamiento — Reservas/Estadías" /
  "Servicio — Turnos").
- Reservas: queda acotada a categorías `isLodging=true` (recursos,
  servicios del selector, y la tabla). Mensaje de empty-state si todavía
  no hay ninguna categoría marcada.
- **Turnos (pantalla nueva, nav propio, sin gate de módulo)** — clon
  deliberado de Reservas con el filtro invertido (categorías
  `isLodging=false`). Reusa el mismo recurso Refine `'reservas'` — no es
  un recurso de backend distinto, es la misma entidad `Reservation`
  filtrada distinto en cada pantalla. Se renombró la variable local
  preexistente `isLodging` (bookingMode del servicio elegido en el form,
  un concepto completamente distinto) a `isBlockBooking` en ambas
  pantallas para no confundirla con `category.isLodging`.
- Estadías: el dropdown de check-in (`reservationsApi.list({status:
  'CONFIRMED'})`) ahora filtra a solo reservas de alojamiento — red de
  seguridad para reservas de servicio creadas antes de este cambio.

**Verificado contra Postgres real y UI** (negocio de prueba,
`owner@refinetest.local`): migración a schema v17 aplicada tras el fix
del bug de constraint; categoría marcada `isLodging=true` vía API y UI;
creada una reserva de alojamiento y una de servicio — la de alojamiento
solo aparece en Reservas y en el dropdown de check-in, la de servicio
solo aparece en Turnos, confirmado con capturas y conteo de opciones del
`<select>`. Datos de prueba limpiados al terminar.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 538/539 (sin cambios de conteo). **Verificado (frontend):**
`tsc --noEmit` limpio, `npm run lint` limpio, `npm run build` limpio (26
rutas, incluida `/dashboard/turnos`), smoke test de consola en las 17
pantallas del dashboard sin errores.

---

## G. Calendario de PMS (tape chart) en Reservas — pedido explícito del dueño (18/08/2026, noche)

A pedido explícito ("ya quiero tener el 'calendario' que corresponde a un
PMS — revisa lo que ha hecho QloApps"). Investigación primero (fork
dedicado, código real de QloApps en `C:\Users\Usuario\Downloads\
QloApps-develop\QloApps-develop`, no solo la doc de referencia existente):
QloApps **no tiene** un tape chart (habitaciones × fechas) — solo un
mini-calendario mensual tipo mapa de calor para elegir fechas al buscar
disponibilidad, sin filas por habitación, sin click, sin drag, y su
booking depende de carrito/orden de PrestaShop (no aplica a nuestro
modelo, ya más limpio). Nada para adaptar de ahí — se diseñó de cero.

**Decisiones de alcance, confirmadas con el dueño antes de tocar código:**
- Construir a medida, sin librería — la opción estándar
  (`@fullcalendar/resource-timeline`) es la parte paga de FullCalendar,
  US$480/año para uso comercial; había alternativas gratis (DayPilot
  Lite) pero se descartaron también a favor de código propio.
- Drag-to-move Y resize desde el arranque (no una v1 solo-lectura) —
  nivel de interacción de un PMS real (Cloudbeds/Mews).

**Backend — `reservation.service.ts::updateReservation()`:**
- Ahora acepta `resourceId` además de `startTime`/`endTime`/`details`
  (reasignación de habitación vía drag). Resuelve el recurso nuevo,
  revalida `category.fields`/locks/disponibilidad contra ESE recurso.
- **Cambio de regla de negocio:** antes solo se podían editar reservas
  `PENDING`; ahora también `CONFIRMED` (sigue bloqueado para
  `CANCELLED`/`COMPLETED` — A6.4, estados terminales no se reabren). Es
  el caso de uso principal del tape chart: mover una reserva YA
  confirmada de habitación o de fecha. `totalPrice`/`lines` siguen
  congelados al editar (decisión ya tomada antes, no se tocó — resize no
  recotiza, igual que "Editar horario" ya no recotizaba).
- `UpdateReservationSchema` (Zod) y `PUT /api/reservations/:id` — nuevo
  campo `resourceId` opcional.
- 3 tests nuevos en `reservation.service.test.ts` (reasignar recurso,
  rechazar reasignación a uno ocupado, permitir editar CONFIRMED) +
  reescrito el que asumía "PENDING-only" para reflejar la regla nueva.

**Frontend — `components/RoomCalendar.tsx` (nuevo, ~380 líneas) +
tab "Calendario" en Reservas:**
- Grid a medida sin librería: filas = habitaciones (categorías
  `isLodging=true`, mismo filtro de E1), columnas = 7 días, navegación
  semana anterior/siguiente/hoy. Barras coloreadas por estado (mismo
  semáforo Bastión que el resto de la app), truncadas visualmente si la
  reserva empieza/termina fuera de la semana visible.
- Drag nativo con Pointer Events (sin librería de drag-and-drop) — mover
  (día + fila), y dos handles de resize (extender/acortar por cualquier
  borde). Ghost/preview en vivo durante el arrastre, sin mutar la lista
  real hasta soltar — si el PUT falla (ej. 409 por conflicto), no hace
  falta revertir nada a mano, el ghost ya desapareció.
- Click en una barra → mismo modal de detalle que la vista Lista. Click
  en una celda vacía → "Nueva reserva" con habitación y fecha
  precargadas.
- **Bug real encontrado y arreglado durante la implementación:**
  `preventDefault()` en `pointerdown` (necesario para que arrastrar no
  dispare selección de texto del navegador) suprime el evento `click`
  nativo derivado — la distinción "fue un click o fue un drag" se
  resolvió a mano dentro del propio `pointerup`, no con un `onClick` del
  lado de la barra.
- **Otro bug real:** llamar a un setState de OTRO componente (el modal
  de detalle del padre) desde adentro del *updater* de `setDragPreview`
  disparaba el warning de React "Cannot update a component while
  rendering a different component". Resuelto con un ref-espejo del
  preview (`dragPreviewRef`) en vez de leer el estado vía la forma
  funcional del setter.
- Convención de fechas: todo el math usa getters **UTC**, nunca locales
  — mismo motivo que el fix del bug de housekeeping del punto A de este
  mismo documento (un getter local depende del huso del proceso).

**Verificado end-to-end contra Postgres real** (negocio de prueba): las
tres interacciones (mover, redimensionar, reasignar de fila) confirmadas
con captura del request/response real — payload correcto en los tres
casos, aplicado correctamente por el backend. Reasignar a un recurso
genuinamente ocupado devuelve 400 con mensaje claro (confirma que el
chequeo de disponibilidad sigue funcionando igual que siempre). Nota de
entorno: el backend de este entorno de prueba tardó hasta ~3s en algunas
respuestas puntuales (probablemente latencia de cómputo de Neon bajo el
uso intensivo de esta sesión) — llevó varias rondas de test descartar
que fuera un bug real antes de confirmar que el código funciona
correctamente.

**Corrección a lo de arriba — la verificación "end-to-end contra
Postgres real" de este mismo punto G era un falso negativo.** Ver punto H:
el test de esa noche solo miraba el *response* del propio PUT (que
siempre devuelve el objeto armado en memoria, no una relectura real de la
fila), nunca un GET independiente después. Por eso el bug de H pasó
desapercibido en su momento.

---

## H. Bug real de fondo del arrastre en el calendario — `hay que arreglarlo` (18/08/2026, noche)

El dueño reportó, después de arrastrar una estadía del 21/08 al 25/08 en
el calendario: el "Detalle de reserva" mostraba `20/8/26, 21:00` →
`24/8/26, 21:00` — fecha corrida un día para atrás y con una hora que no
debería estar. Pidió explícitamente arreglarlo, y también revisar los
nombres usados en Reservas para que no generen confusión ("Inicio"/"Fin"
no comunican que son días completos de check-in/check-out, no horarios
puntuales).

**Dos bugs distintos, uno tapaba al otro:**

1. **Bug de visualización (frontend, `appfrontend-main/src/app/dashboard/reservas/page.tsx`).**
   `fmt()` formateaba con `toLocaleString()` sin fijar `timeZone: 'UTC'` —
   usaba el huso LOCAL del navegador. Una reserva que en la base arranca
   `2026-08-21T00:00:00.000Z` (medianoche UTC) se mostraba en Argentina
   (UTC-3) como `20/8/26, 21:00`. Mismo patrón de bug que el de
   housekeeping arreglado antes en este documento (punto A) y el mismo
   criterio ya establecido para el calendario (punto G): todo el manejo
   de fechas de esta pantalla tiene que ser UTC-only, nunca con getters
   locales.
   - Corregido: `fmt()` ahora usa `toLocaleDateString(..., { timeZone: 'UTC' })`,
     sin mostrar hora (no aplica — son días completos).
   - Como Reservas quedó 100% acotado a alojamiento (punto F, E1), se
     sacó la rama condicional `isBlockBooking` (que solo daba campos
     día-a-día si el servicio elegido era `bookingMode='block'`): ahora
     el formulario de alta, el de edición y la vista de detalle usan
     `Check-in`/`Check-out` (día completo, `<input type="date">`) como
     comportamiento por defecto de toda la pantalla — ya no depende de
     qué servicio se haya elegido. Los turnos con horario puntual
     (`bookingMode='slot'`, ej. reservar una franja horaria de un
     recurso) siguen usando el flujo de horario exacto sin cambios.
   - Rename pedido explícitamente por el dueño: las etiquetas "Inicio"/
     "Fin" pasaron a "Check-in"/"Check-out" en el formulario de alta, el
     de edición y el detalle de solo lectura. Se dejó "Inicio"/"Fin" tal
     cual en la única rama que sigue siendo genuinamente un horario
     puntual (selección manual de franja cuando el recurso no tiene
     horario configurado) — ahí sí son minutos exactos, no días.

2. **Bug real de fondo (backend, `app-main/src/reservas/sql.reservation.repository.ts`) — el que de verdad estaba rompiendo el arrastre.**
   El `UPSERT_SQL` de `save()`/`saveWithClient()` pasaba `resource_id`,
   `start_time` y `end_time` como parámetros del `INSERT`, pero el
   `ON CONFLICT (id) DO UPDATE SET` **nunca los incluía** — solo
   actualizaba `status`, `details`, `updated_at` y `total_price`. Como
   `updateReservation()` (el PUT que usa tanto "Editar horario" como el
   drag-to-move/resize del calendario) siempre pega contra una fila que
   YA existe, cada llamada caía en la rama `DO UPDATE`, y esa rama
   ignoraba en silencio los tres campos que el drag necesita cambiar.
   - La API igual devolvía `200` con el objeto "actualizado" porque
     `updateReservation()` arma y devuelve el objeto en memoria
     (`Reservation.restore(...)`) sin releer la fila de la base — así que
     la respuesta del PUT SIEMPRE parecía correcta, incluso cuando el
     `UPDATE` real no había tocado ninguna de las tres columnas.
   - Efecto visible: arrastrar/redimensionar en el calendario nunca
     persistía nada. La barra se movía en el estado local de React, pero
     al reabrir el detalle (que sí vuelve a pedir el dato al backend) se
     veían las fechas de ANTES del arrastre — que además tenían el bug 1
     encima, de ahí el desfase que reportó el dueño.
   - Esta es la causa real por la que la "verificación end-to-end" del
     punto G de esta misma noche dio falso positivo: el script de prueba
     de esa sesión solo miraba el response del propio PUT, nunca hacía un
     GET independiente después para confirmar que había quedado grabado.
   - **Reasignación de recurso (arrastre entre filas) tenía el mismo
     problema** — `resource_id` tampoco estaba en el `SET`.
   - Corregido: se agregó `resource_id = $5, start_time = $7,
     end_time = $8` al `ON CONFLICT ... DO UPDATE SET`.
   - Test de regresión nuevo en `sql.reservation.repository.test.ts`:
     verifica que el SQL del upsert incluya esas tres columnas en la
     cláusula `DO UPDATE SET` (no depende de una base real — hubiera
     detectado este bug específico si hubiera existido antes). Suite
     completa: 543/543 tests (antes 542/542 + 1 nuevo).
   - Verificado con PUT real + GET independiente en una sesión de browser
     nueva (sin caché compartida): mover fechas y reasignar recurso
     ahora persisten de verdad, confirmado contra la fila real en
     Postgres, no solo contra el response del PUT.

**Alcance que quedó afuera a propósito:** el huso horario hardcodeado
`-03:00` en `reservation.service.ts::combineDateAndTime()` (mencionado
como pendiente en sesiones anteriores) no se tocó — no es parte de este
bug, es una cuenta pendiente aparte.

**Auditoría del mismo patrón en el resto del repo (fork dedicado, mismo
18/08/2026):** se revisaron los otros ~10 archivos de `app-main/src` que
usan `ON CONFLICT ... DO UPDATE SET` para ver si el mismo error (columna
en la lista del INSERT pero ausente del SET) se repetía en otro lado.

- Limpios: `sql.financial-transaction.repository.ts`,
  `platform.repository.ts`, `platform/company.repository.ts`,
  `pos-menu/sql.product.repository.ts`,
  `repositories/sql.inventory-level.repository.ts`,
  `repositories/sql.stock-movement.repository.ts`,
  `clientes-finanzas/sql.customer.repository.ts`,
  `reservas/sql.resource.repository.ts` — o son `DO NOTHING` sin SET, o
  usan `SET col = EXCLUDED.col` (no puede desincronizarse de la lista del
  INSERT), o excluyen a propósito columnas inmutables con el motivo
  documentado en un comentario.
- **Segundo caso real encontrado:** `reservas/sql.occupancy.repository.ts::recordReservation()`.
  El upsert de `occupancy_records` pasaba `resource_name`, `category_id`,
  `category_name` como parámetros del INSERT pero el `ON CONFLICT
  (resource_id, date) DO UPDATE` solo tocaba `booked_minutes`. Efecto:
  renombrar un recurso o moverlo de categoría dejaba esos tres campos
  con el valor VIEJO para siempre en cualquier fecha que ya tuviera fila
  `(resource_id, date)` — silencioso, solo se notaba en reportes de
  ocupación por categoría (categoría equivocada en el agregado). Menor
  severidad que el bug de reservas (no rompe integridad de reservas,
  solo ensucia analítica), pero mismo patrón exacto. Corregido: se agregó
  `resource_name = $2, category_id = $3, category_name = $4` al SET.
  Test de regresión agregado en `sql.occupancy.repository.test.ts` (mismo
  criterio que el de `sql.reservation.repository.test.ts`: inspecciona el
  SQL literal, no solo que se haya llamado `query()`). Suite completa:
  544/544.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 541/542 (+3 tests nuevos). **Verificado (frontend):**
`tsc --noEmit` limpio, `npm run lint` limpio, `npm run build` limpio,
smoke test de consola en las 17 pantallas sin errores.

---

## I. Bug reportado por el dueño (18/08/2026, noche) — el precio no variaba al editar/redimensionar una reserva

Reportado en uso real: extender o achicar una reserva (drag-resize en el
calendario, o "Editar horario") no cambiaba `totalPrice` — quedaba el
precio inicial. Investigado: **no era un bug nuevo de hoy**, era una
decisión ya tomada antes de esta sesión y documentada en el propio código
(`reservation.service.ts::updateReservation()`: "No se recalcula el
precio al editar... fuera de alcance de esta fase"). El trabajo de hoy
(punto G, calendario de PMS) no la tocó, la heredó tal cual.

Al confirmarlo con el dueño, surgió una complicación real antes de
tocar código: una reserva `CONFIRMED` ya generó un `CHARGE` financiero
(`clientes-finanzas`) por el total viejo — pisar `totalPrice` sin más
desincroniza la reserva del cobro ya emitido (A3.9, criterios-negocio.md:
"todo movimiento tiene contrapartida"). Alcance acordado explícitamente:

- **PENDING** → recalcula automático al editar (sin cobro emitido
  todavía, sin riesgo de desincronizar nada).
- **CONFIRMED** → sigue con el precio congelado, igual que hasta ahora.
  Recalcular esta rama con un ajuste financiero explícito (cargo o nota
  de crédito) queda **pendiente aparte** — no se improvisó, requiere
  diseñar ese flujo (qué pasa si ya se cobró, aviso al cliente, etc.)
  antes de escribir código.

**Implementado:** `updateReservation()` llama a `resolvePrice()` (el
mismo método que usa `createReservation()`) con las fechas/recurso
nuevos cuando `existing.status === 'PENDING'`, y regenera
`lines`/`totalPrice`. Para `CONFIRMED`, sin cambios — sigue usando
`existing.totalPrice`/`existing.lines`.

Tests nuevos en `reservation.service.test.ts` (describe "recotización al
editar"): extender una reserva PENDING (2→4 noches) sube el precio de
200 a 400 y regenera las 4 líneas; achicarla (4→1 noche) baja el precio
a 100; confirmar y editar NO cambia el precio (sigue en 200 aunque el
cambio de fechas "debería" dar 400 si recotizara). Suite completa:
565/566 (+3 nuevos).

**Verificado:** `tsc --noEmit` limpio, `npm run lint` limpio, `npm test`
565/566. Sin cambios de schema — no hizo falta verificar contra Postgres
real (la lógica de precio ya se ejercita con los mismos repos en memoria
que usan los otros 48 tests de `ReservationService`, no hay SQL nuevo).

**Pendiente aparte (anotado, no resuelto hoy):** ajuste financiero
explícito para recotizar una reserva `CONFIRMED` — depende de diseñar el
flujo con el dueño antes de tocar código.

---

## J. Nueva información recibida del dueño (18/08/2026, noche) — spec de mejoras PMS y recomendación de dependencias frontend

**Especificación funcional completa** (housekeeping↔calendario↔
disponibilidad sincronizados, adultos/niños estructurados, tooltip
enriquecido, exportación PDF/Excel, dashboard ADR/RevPAR/GOPPAR) recibida
como dos documentos en `C:\Users\Usuario\Downloads\Anotaciones PMS\`.
Copiados al repo para que no se pierdan: `docs/referencia-mejoras-
pms-2026-08-18.md` + su anexo, enlazados desde `roadmap-pms-multirubro.md`
(secciones "Housekeeping y Mantenimiento" y "Reportes y estadísticas").
Nada implementado todavía — es backlog, no una tarea de hoy.

**Recomendación de dependencias frontend para exportación** (evaluada por
el dueño, no implementada): para PDF/Excel de reportes, el stack sugerido
es `jsPDF` + `jspdf-autotable` (tablas) + `qrcode` (QR obligatorio RG 4892
para las facturas AFIP del módulo FACTURACION, ya planeado) + `xlsx`/
SheetJS (Excel real, no CSV renombrado) + `Intl.NumberFormat` (nativo,
sin librería) + `luxon` (ya se sumó hoy en el backend para el fix de
huso horario — mismo criterio, evaluar si conviene tenerlo también en el
frontend cuando se llegue a esta tarea). `recharts` (gráficos),
`papaparse` (CSV liviano) y `react-to-print` (impresión directa) quedan
para cuando la funcionalidad puntual los pida, no sumarlos de antemano —
mismo criterio de "no asumir nada sin caso de uso real" que ya rige el
resto del proyecto. **Pregunta abierta sin responder todavía:** ¿los
reportes van a llevar gráficos, o por ahora alcanza con tablas/números?
Depende de esa respuesta si `recharts` entra en el alcance cuando se
aborde el ticket de exportación.

✅ **RESUELTO (18/08/2026, noche) — bug de UX de los campos de precio.**
Los campos de precio (Productos, Servicios, Recursos) eran `<input
type="number">` con dos problemas: (1) las flechas nativas de
incrementar/decrementar del navegador, sensación de "control continuo"
en vez de un campo numérico; (2) el estado local arrancaba en `0` y
`parseFloat(value) || 0` volvía a poner `0` cada vez que el campo quedaba
vacío mientras se tipeaba — el campo "peleaba" con quien lo llenaba,
nunca se podía dejar en blanco de verdad. Corregido en
`appfrontend-main`:
- CSS global (`globals.css`, regla `.input[type='number']`) saca las
  flechas nativas (`-webkit-appearance: none` en los spin buttons +
  `-moz-appearance: textfield`) — aplica a TODOS los inputs numéricos de
  la app, un solo lugar. `type="number"` se mantiene (teclado numérico en
  mobile, valida que no se tipeen letras), solo se le saca la UI de
  flechas.
- Estado local de los 3 formularios con precio (`productos/page.tsx`,
  `servicios/page.tsx`, `recursos/page.tsx`) admite `'' ` mientras se
  tipea (`number | ''`, en vez de forzar `0`) — se coerciona a `number`
  recién en `handleSubmit`, no en cada tecleo. `productos/[id]/
  variantes/page.tsx` ya tenía este patrón correcto de antes (no hizo
  falta tocarlo) — se usó como referencia para los otros tres.

**Verificado:** `tsc --noEmit` limpio, `npm run lint` limpio (0 errores,
2 warnings preexistentes sin relación), `npm run build` limpio (25
rutas). **No verificado visualmente en navegador en esta sesión** — sin
credenciales de un usuario de prueba a mano para loguearse. Recomendado
confirmar a simple vista en `/dashboard/productos` → "Nuevo producto"
antes de darlo por cerrado del todo.
