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
- ✅ **DECIDIDO (19/08/2026)** — F2(c): edición fina de permisos por rol
  pasa a ser feature paga, disponible desde el plan **PRO** en adelante
  (no exclusivo de Enterprise). **Decisión de implementación tomada junto
  con esto:** no un middleware aislado tipo `requirePlan` — se agrega
  como una dimensión más (`allowsCustomRolePermissions` o similar) del
  sistema genérico de `PLAN_LIMITS` que ya está pendiente de diseñar
  (ver nota de panel de superadmin más abajo, y la decisión de proceso
  sobre cómo se van a cargar esos valores). Así se diseña una sola vez
  como parte de ese sistema más grande, en vez de construir un gate
  puntual que después haya que migrar. **No implementado todavía** —
  queda para cuando se aborde `PLAN_LIMITS` como sistema genérico.
- ✅ **DECIDIDO (19/08/2026)** — Portal de clientes migra a cookie
  httpOnly, mismo patrón que ya se aplicó al panel de staff (B2,
  13/08/2026 — ver `pendientes-2026-08-13.md`). Justificación: el token
  sigue en `localStorage` (`CustomerAuthContext.tsx`), mismo hueco de XSS
  que motivó el cambio original. **No implementado todavía** — es la
  próxima tarea a encarar.
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
  que nadie volviera a marcarlo acá. ✅ **DECIDIDO (19/08/2026)** — del
  resto de E7a, se prioriza construir pantalla para: **horarios de
  servicios reservables**, **vistas de housekeeping por usuario/estado**
  (`/me` y `/status/:status`), y **alta pública de negocio nuevo**
  (`POST /register`). **`locations` queda sin priorizar** — sigue siendo
  scaffolding sin uso real, no entra en este lote. Ninguno de los tres
  priorizados está implementado todavía — falta definir orden/estimar
  antes de arrancar.
- ✅ **DECIDIDO (19/08/2026)** — panel de superadmin para editar presets
  de roles/`PLAN_LIMITS`: **no por ahora.** En su lugar, los cambios a
  esos valores (incluida la dimensión nueva de F2(c) de arriba cuando se
  implemente) se hacen siempre vía **script/migración versionada**
  (mismo patrón que ya rige `schema.sql`/`CURRENT_SCHEMA_VERSION`), nunca
  con un `UPDATE` suelto tipeado a mano en el momento contra la base
  real. Motivo: mantiene el historial ordenado de qué cambió y cuándo, y
  evita repetir el patrón de riesgo que casi lleva a un `UPDATE` directo
  sin ese resguardo esta misma sesión (ver corrección de la falsa alarma
  de `biz-demo-01` más abajo en este documento). El día que sí haga falta
  un panel real, ya queda el historial versionado como base.

### Backlog / integraciones externas
- Facturación electrónica AFIP — ✅ **Fase 1 resuelta (19/08/2026, punto
  P)**: perfil fiscal del negocio emisor (`business_profile`), cargado
  desde Mi Negocio. ✅ **Fase 2 resuelta (19/08/2026, punto T)**: conexión
  real WSAA/WSFEv1 (`@arcasdk/core`), tabla `invoices`, UI de carga de
  certificado. Sigue faltando: botón "Facturar" en el flujo de cobro y
  prueba real contra AFIP homologación (el dueño todavía no presentó el
  CSR) — eso es lo que queda de este ítem.
- Mails de reserva confirmada — falta cuenta de Resend + dominio
  verificado (`NoopEmailSender` hasta entonces).
- Login con Google — falta crear el OAuth Client ID en Google Cloud
  Console y cargar `GOOGLE_CLIENT_ID`/`NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
- Portal de clientes: alta pública de negocio nuevo — ✅ **resuelta
  (19/08/2026, punto R, `/registro`)**. Sigue faltando: landing propia
  del portal, y el mecanismo de "reclamo" (`claim`/`merge`) completo (el
  login con Google ya resuelve el caso más común, no el fusionar
  historial).
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

✅ **DECIDIDO (19/08/2026)** — ajuste financiero explícito para recotizar
una reserva `CONFIRMED`: al editar fechas/recurso de una reserva ya
confirmada (y ya cobrada), el sistema recalcula el precio nuevo y
**muestra la diferencia**, pero el ajuste real del cobro (cargo extra o
nota de crédito en `clientes-finanzas`) lo confirma un empleado a mano —
no se dispara automático. Elegido por sobre el auto-cobro para evitar el
riesgo de un ajuste financiero mal disparado sin revisión humana.
**No implementado todavía** — requiere: mostrar el precio recalculado
como preview antes de confirmar el cambio (no solo congelar como hoy),
un flujo de aprobación/confirmación del ajuste en la UI, y el
cargo/nota de crédito correspondiente en `clientes-finanzas` una vez
confirmado.

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
resto del proyecto. ✅ **DECIDIDO (19/08/2026):** solo tablas y números
por ahora — `recharts` NO entra en el alcance del ticket de exportación
cuando se aborde; se suma después si hace falta de verdad.

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

---

## K. Ticket #2 del spec de mejoras PMS — adultos/niños estructurados (18/08/2026, noche)

A pedido explícito del dueño ("abordar lo de PMS" → eligió empezar por
este ticket de los 6 del spec, ver punto J). Alcance confirmado antes de
tocar código (dos preguntas):

- **Adultos/niños solo en alojamiento por ahora** (categorías
  `isLodging=true`, pantalla Reservas/Estadías) — Turnos no lo pide.
  El dueño aclaró que la idea es habilitarlo después también para otros
  rubros con concepto de "grupo + guía" (tours) — por eso vive como
  columna general en `reservations` (no atada a una tabla/flag de
  alojamiento), nullable, y solo la UI de hoy lo restringe a Reservas.
- **`adultos` obligatorio (mínimo 1) cuando se informa, `ninos` opcional
  (default 0)** — tal cual pide el anexo del spec.

### Backend

- `reservations` gana `adultos`/`ninos` INTEGER nullable (schema v18,
  `CURRENT_SCHEMA_VERSION` en `tenant-db.setup.ts`). `NULL` = "no aplica
  a este tipo de reserva" (Turnos), no "cero". CHECK: `adultos IS NULL OR
  adultos >= 1`, `ninos IS NULL OR ninos >= 0`. Distinto de `party_size`
  (ya existía, valida contra la capacidad del recurso, aplica a TODO
  rubro) — son conceptos separados, no se tocó `party_size`.
- `Reservation.ts`: valida `adultos >= 1` si se informa, `ninos >= 0`,
  y `ninos` requiere `adultos` informado (no puede haber niños sin saber
  cuántos adultos). `createReservation()`/`updateReservation()` los
  aceptan como parámetros opcionales — editable en `updateReservation()`
  para el caso "cambio de última hora" del check-in (mismo guard de
  estado PENDING/CONFIRMED que ya regía el resto de los campos editables).
- Zod (`request.schemas.ts`): `adultos`/`ninos` opcionales en create,
  `nullable().optional()` en update (`null` explícito borra el dato).
- DTO de respuesta (`reservation.mapper.ts`) expone ambos campos.

**Bug real encontrado de paso, no relacionado con adultos/niños en sí
pero en el mismo archivo/método:** `sql.reservation.repository.ts` —
`service_id`/`party_size`/`notes`/`order_item_id` faltaban COMPLETOS del
`UPSERT_SQL` (ni en el INSERT ni en el `ON CONFLICT DO UPDATE`), no
solo desincronizados entre sí como el bug de `resource_id`/`start_time`/
`end_time` resuelto más temprano hoy (punto H). `baseSelect()` sí los
lee — significa que **toda reserva en producción tiene `service_id`
NULL, `notes` NULL, `order_item_id` NULL, y `party_size` siempre en su
DEFAULT (1)**, sin importar qué se haya pasado en memoria al crearla,
desde que existe este repositorio. Efecto más grave:
`getActiveForServiceInRange()`/`WithLock()` (chequeo de disponibilidad
de recursos bloqueados por SERVICIO) nunca podían matchear nada porque
`r.service_id` era NULL en toda fila — ese chequeo de disponibilidad
está roto en silencio desde siempre. Corregido en el mismo commit que
agrega `adultos`/`ninos` (mismas líneas). Test de regresión nuevo
(mismo criterio que el de H: inspecciona el SQL literal del INSERT y
del `DO UPDATE SET`, no solo que se haya llamado `query()`).
**Pendiente evaluar aparte:** auditar si `getActiveForServiceInRange()`
tenía algún consumidor real en producción que dependiera de este
chequeo — no investigado en esta sesión, el fix soluciona la causa raíz
pero no se midió el impacto histórico.

### Frontend (`appfrontend-main`)

- `lib/types.ts`: `Reservation.adultos`/`ninos`.
- Reservas (`dashboard/reservas/page.tsx`): campos "Adultos"/"Niños" en
  el alta (default 1/0) y en la edición del detalle; se muestran en la
  vista de solo lectura ("Adultos: 2 · Niños: 1").
- Estadías (`dashboard/estadias/page.tsx`), modal de check-in: al elegir
  una reserva confirmada, hereda su adultos/niños (editable — "cambio de
  última hora" que pide el anexo). Si difieren de lo que ya tenía la
  reserva, `handleCheckIn()` corrige con un `PUT /api/reservations/:id`
  antes de armar la estadía; si no cambiaron, no manda ese PUT de más.

**Fuera de alcance de este ticket** (son los tickets #3/#4/#5 del spec,
no pedidos todavía): tooltip enriquecido del calendario, columnas
adultos/niños en los reportes de ocupación existentes, exportación
PDF/Excel, dashboard de métricas. Anotado en `roadmap-pms-multirubro.md`.

**Verificado (backend) contra Postgres real** (tenant `refine-test-
business`, schema aplicado a v18): columnas `adultos`/`ninos`
confirmadas nullable; una reserva creada con `partySize`/`notes`/
`adultos`/`ninos` releída con una instancia de repositorio NUEVA (no el
objeto en memoria) confirmó que los cinco campos persisten; una segunda
escritura sobre el mismo id (rama `ON CONFLICT DO UPDATE`) confirmó que
`notes`/`adultos`/`ninos` se actualizan de verdad, no solo en el INSERT
inicial. Datos de prueba limpiados al terminar. `tsc --noEmit` limpio,
`npm run lint` limpio, `npm test` 574/574 (+9 tests nuevos: 8 de
adultos/ninos en `reservation.service.test.ts` + 1 de regresión del
UPSERT en `sql.reservation.repository.test.ts`).

**Verificado (frontend):** `tsc --noEmit` limpio, `npm run lint` limpio
(0 errores, mismos 2 warnings preexistentes), `npm run build` limpio (25
rutas). No verificado visualmente en navegador (mismo motivo que el
punto anterior — sin credenciales a mano).

---

## L. Ticket #3 del spec de mejoras PMS — tooltip enriquecido del calendario (18/08/2026, noche)

A pedido explícito del dueño ("dale el tooltip enriquecido del
calendario"). Solo `appfrontend-main` — sin cambios de backend, todos los
campos que necesitaba ya estaban expuestos (incluido `adultos`/`ninos`
del punto K, recién agregado).

`RoomCalendar.tsx` (tape chart construido hoy, punto G): antes cada barra
solo tenía el `title` nativo del navegador (una línea, con delay, sin
estilo) mostrando el nombre del huésped. Ahora, al pasar el mouse sobre
una barra, aparece un tooltip real con: huésped, check-in, check-out,
adultos/niños (si la reserva los tiene cargados), servicio (si tiene
uno), tarifa, y notas internas (si hay).

**Portal a `document.body`** (`createPortal`, no un `div` anidado con
`top: 100%`) — el contenedor del calendario tiene `overflow: hidden`/
`overflow-x: auto` en varios niveles; un tooltip anidado se recortaría
en las filas de arriba o abajo de la grilla. `position: fixed` +
coordenadas del `getBoundingClientRect()` de la barra evita el recorte
sin importar dónde esté la reserva.

**"Origen de la reserva" quedó deliberadamente afuera** — el propio
anexo del spec lo marca "A confirmar", no es un campo ya decidido ni
existe en el modelo de datos hoy. Mostrar algo inventado ahí sería peor
que no mostrar nada; si se define qué "orígenes" tiene sentido trackear
(portal, mostrador, teléfono, OTA), es una decisión de producto aparte,
no algo para resolver de paso en este ticket.

**Verificado:** `tsc --noEmit` limpio, `npm run lint` limpio (0 errores,
mismos 2 warnings preexistentes), `npm run build` limpio (25 rutas). **No
verificado visualmente en navegador** — mismo motivo que los dos puntos
anteriores (sin credenciales de un usuario de prueba a mano). Un tooltip
con posicionamiento vía portal es más propenso a bugs sutiles (recorte,
z-index, offset) que un cambio de input — recomendado confirmarlo a
simple vista en Reservas → pestaña Calendario antes de darlo por cerrado
del todo.

---

## M. Precio por tipo de habitación — `rate_plans` (18/08/2026, noche)

A pedido explícito del dueño, surgido de una conversación sobre check-in/
check-out y precio de recursos que trajo análisis externo (citado en el
chat, no un documento formal). Dos decisiones grandes, ambas dadas vuelta
al menos una vez en la conversación antes de asentarse — quedan
documentadas con el razonamiento final, no solo la conclusión:

**Decisión 1 — confirmado que hoy el precio vive en el lugar equivocado.**
`resources.base_price` (la habitación física) tenía el precio; `resource_
categories` (el tipo, "Doble Estándar") no tenía nada. Coincide con cómo
lo modela la industria (Booking.com: room type × rate plan).

**Decisión 2 — tabla `rate_plans` separada, NO extender `bookable_services`.**
Se evaluó dos veces: primero se propuso extender `bookable_services`
(ya tiene `category_id`+`price`+`active`, casi cumple el rol de rate
plan). El dueño lo aceptó, después trajo un segundo análisis externo
cuestionando si hacía falta la tabla nueva ("¿puede haber N servicios
activos por categoría hoy? si sí, no hace falta tocar la estructura").
Se verificó: sí puede (no hay constraint que lo bloquee) — pero eso no
alcanza. El argumento que cerró la discusión: `bookable_services` carga
config OPERATIVA por fila (`resource_locks`, `service_schedules`,
`bookingMode`, `durationMinutes`), no solo precio. Si "Doble Estándar —
Rack" y "Doble Estándar — Corporativa" fueran DOS filas de
`bookable_services`, cada una necesitaría su propia configuración de
`resource_locks`/horarios repetida — exactamente la duplicación que el
proyecto viene evitando toda la sesión. `rate_plans` separada resuelve
esto: la config operativa vive UNA vez en el servicio, N tarifas cuelgan
de él solo con precio/vigencia/política de cancelación.

### Backend

- `rate_plans` (schema v19) — MAESTRO (R2/R3: nunca hard-delete, se
  desactiva), código de negocio `(service_id, name)` UNIQUE (R1/R6).
  Columnas: `price`, `includes_breakfast`, `cancellation_policy`,
  `valid_from`/`valid_to` (fechas de calendario, vigencia por temporada).
  `reservations.rate_plan_id` (nullable, `ON DELETE RESTRICT`) — **solo
  trazabilidad** (R9): el precio real cobrado sigue viviendo en
  `total_price`/`reservation_lines`, congelado al calcularse: un cambio
  futuro de tarifa NUNCA reescribe una reserva ya creada.
- CRUD completo (`BookableServiceService`): `listRatePlans`/`addRatePlan`
  (rechaza nombre duplicado por servicio y `validTo < validFrom`)/
  `updateRatePlan`/`removeRatePlan` (desactiva, no borra). Rutas anidadas
  bajo el servicio: `GET/POST /api/bookable-services/:id/rate-plans`,
  `PUT/DELETE /api/bookable-services/:id/rate-plans/:ratePlanId` — mismo
  patrón que `service_schedules`, la entidad nested ya existente más
  parecida.
- Cascada de precio (`ReservationService.resolveUnitPrice()`) gana un
  escalón: tarifa especial cliente+servicio (gana primero, es un
  descuento ya negociado) → **`ratePlanId` elegido** (valida existe +
  activa + `startTime` dentro de `validFrom`/`validTo`, si no,
  `RatePlanNotAvailableError` 400) → precio de catálogo del servicio →
  tarifa especial cliente+recurso → `basePrice` del recurso (fallback
  que queda, sin tocar, para reservas sin tarifa elegida).
- `createReservation()`/`updateReservation()` aceptan `ratePlanId`
  opcional; editable en `updateReservation()` con el mismo criterio de
  recotización de PENDING que ya regía `adultos`/`ninos` (punto K).

### Frontend

Pendiente en este mismo bloque de trabajo — selector de dos pasos
(elegir servicio → elegir tarifa disponible) en el alta de Reservas, y
gestión de tarifas integrada en la pantalla de Servicios existente (no
una pantalla nueva — el dueño pidió explícitamente no duplicar UI por
estética, la tabla es distinta pero la interfaz no).

**Verificado (backend) contra Postgres real** (tenant `refine-test-
business`, schema aplicado a v19): columnas/tabla nuevas confirmadas;
un servicio con DOS tarifas simultáneas creado y listado correctamente;
una reserva con `ratePlanId` guardada y releída con una instancia de
repositorio nueva confirmó que `ratePlanId`/`totalPrice` (tomado de la
tarifa, no del servicio) persisten de verdad. Datos de prueba limpiados.
`tsc --noEmit` limpio, `npm run lint` limpio, `npm test` 588/588 (+14
tests nuevos: 8 de CRUD de tarifas, 6 de la cascada de precio incluida
la prioridad sobre tarifa negociada y los bordes de vigencia).

### Frontend (`appfrontend-main`, mismo bloque de trabajo, completado)

- `RatePlanManager.tsx` (componente nuevo) — CRUD de tarifas de un
  servicio, integrado como modal en la pantalla de Servicios existente
  (botón "Tarifas" por fila, mismo patrón que "Recursos" ya usaba con
  `ResourceLockPicker`) — **no una pantalla nueva**, a pedido explícito
  del dueño ("no duplicar la interfaz por estética, la tabla es distinta
  pero la UI no tiene por qué serlo"). Lista tarifas existentes, permite
  crear/editar/desactivar, con el mismo patrón de precio sin forzar "0"
  mientras se tipea que ya rige el resto de los campos de precio del
  sistema (punto J).
- Reservas (`dashboard/reservas/page.tsx`) — selector de dos pasos en el
  alta: elegir servicio primero, y si tiene tarifas cargadas, aparece un
  segundo `<select>` para elegir cuál (opcional — sin elegir ninguna,
  sigue usando el precio de catálogo del servicio como siempre). Se
  resetea al cambiar de servicio.
- `lib/types.ts`/`lib/api.ts` — `RatePlan`/`CreateRatePlanInput`/
  `UpdateRatePlanInput`, `ratePlansApi`, `Reservation.ratePlanId`,
  `reservationsApi.create`/`update` aceptan `ratePlanId`.

**Verificado:** `tsc --noEmit` limpio, `npm run lint` limpio (0 errores,
mismos 2 warnings preexistentes), `npm run build` limpio (25 rutas). No
verificado visualmente en navegador — mismo motivo que el resto de la
sesión (sin credenciales de un usuario de prueba a mano). Dado que este
es el cambio de frontend más grande del día (componente nuevo + selector
de dos pasos con fetch condicional), es el que más se beneficiaría de
una revisión visual antes de darlo por cerrado del todo.

---

## N. Flujo de horario de check-in/check-out (early check-in / late check-out) — 18/08/2026, noche

Backend commiteado (`e14e728`, schema v20) en la sesión anterior a esta,
que cortó por límite de uso antes de documentarlo acá y de construir el
frontend. Este punto cubre ambas mitades.

### Backend (ya commiteado, resumen)

Modela un pedido de horario distinto al estándar del negocio:

- `business_profile.default_check_in_time`/`default_check_out_time` (hora
  de pared, A4.3) — editable vía `PUT /api/business-profile`.
- `reservations.requested_check_in_time`/`requested_check_out_time` +
  `schedule_approval_status` (`NULL`/`PENDING`/`APPROVED`/`REJECTED`) +
  `schedule_approved_by`/`schedule_charge_amount`.
- `housekeeping_tasks.not_before` — para no limpiar antes de que el
  huésped se haya ido de verdad si se aprobó un late check-out.
- `StayService.requestScheduleChange()`/`approveScheduleChange()`/
  `rejectScheduleChange()`. La aprobación rechaza con
  `NextArrivalConflictError` (409, `NEXT_ARRIVAL_CONFLICT`) si la próxima
  reserva de la misma habitación llega antes del checkout pedido — sin
  override, el staff tiene que resolver el conflicto primero. Si aprueba,
  crea un cargo opcional en el folio y actualiza (o deja lista para
  `checkOut()`) la tarea de housekeeping con `not_before`.
- Endpoints nuevos: `POST /api/reservations/:id/schedule-request`
  (Roles.BOOKING — lo puede iniciar el huésped), `.../approve` y
  `.../reject` (Roles.FRONT_DESK) — los tres gateados por
  `requireModule(ModuleKey.ALOJAMIENTO)`. Badge de solo lectura en
  `GET /api/housekeeping/late-checkouts?date=` (Roles.STAFF) — reservas
  con late check-out aprobado que hacen checkout ese día, calculado al
  vuelo, sin tabla ni tarea nueva.
- **Verificado contra Postgres real** (tenant de prueba, sesión anterior):
  conflicto rechazado correctamente, aprobación sin conflicto, cargo
  creado en `financial_transactions`, `not_before` seteado tanto al crear
  la tarea en `checkOut()` como al actualizar una ya existente, badge
  devolviendo las reservas esperadas. `tsc --noEmit`/`npm run lint`
  limpios (conteo de tests no confirmado en esta sesión — no se corrió de
  nuevo, sin cambios de backend hoy).

### Frontend (`appfrontend-main`, completado en esta sesión)

- **Mi Negocio** (`dashboard/mi-negocio/page.tsx`) — dos campos
  `<input type="time">` (Check-in estándar / Check-out estándar) en la
  sección de identidad del negocio, junto a nombre/email de contacto.
  `businessProfileApi`/`BusinessProfile` (lib/api.ts) ganan
  `defaultCheckInTime`/`defaultCheckOutTime` — de paso se completó el
  tipo con `currency`/`timezone` (ya existían en el backend desde el
  17/08 pero el tipo del frontend no los declaraba; siguen sin UI de
  edición propia, eso es un gap aparte no resuelto acá).
- **Reservas** (`dashboard/reservas/page.tsx`), detalle de una reserva de
  alojamiento — sección nueva "Horario especial pedido" (badge de estado
  + horas pedidas + cargo si lo hubo) y tres acciones: "Pedir horario
  especial" (PENDING/CONFIRMED, formulario inline con dos `<input
  type="time">`, cualquiera de los dos opcional), y para el staff con un
  pedido `PENDING`: "Aprobar horario" (formulario inline con cargo
  opcional) / "Rechazar horario". Un 409 `NEXT_ARRIVAL_CONFLICT` al
  aprobar se muestra tal cual en el toast — el mensaje del backend ya
  viene en castellano ("Conflicto: próxima llegada a las HH:MM"), no
  hacía falta traducirlo de nuevo.
- **Housekeeping** (`dashboard/housekeeping/page.tsx`) — badge "⏰ hasta
  HH:MM" en la esquina de la ficha del rack para cualquier recurso con un
  late check-out aprobado ese día (`GET /api/housekeeping/late-checkouts`,
  refetch por fecha igual que el tablero de tareas), más una nota
  destacada al abrir el detalle de esa ficha ("no limpiar antes de las
  HH:MM"). Es un badge de solo lectura, a propósito — no crea ni bloquea
  ninguna tarea, el backend ya resuelve `not_before` solo.
- `Reservation`/`HousekeepingTask` (lib/types.ts) ganan los campos nuevos
  (`requestedCheckInTime`/`requestedCheckOutTime`/`scheduleApprovalStatus`/
  `scheduleApprovedBy`/`scheduleChargeAmount`) y un tipo nuevo
  `LateCheckout`. `reservationsApi` gana `requestScheduleChange`/
  `approveScheduleChange`/`rejectScheduleChange`; `housekeepingApi` gana
  `lateCheckouts`.

**Verificado:** `tsc --noEmit` limpio, `npm run lint` limpio (0 errores,
mismos 2 warnings preexistentes de siempre), `npm run build` limpio (25
rutas, sin rutas nuevas — todo vive dentro de pantallas existentes). **No
verificado visualmente en navegador** — sin credenciales de un usuario de
prueba a mano, mismo motivo que el resto de los cambios de frontend de
esta sesión. Tres flujos nuevos con estado que se pisa entre sí (pedir →
aprobar/rechazar, con un formulario inline condicionado a
`scheduleApprovalStatus`) — recomendado confirmarlo a simple vista en
Reservas → detalle de una estadía antes de darlo por cerrado del todo.

---

## O. Documento de diseño recibido — POS-Menu: mesas, booking mode, canal de venta, límites de plan (18/08/2026, noche)

Documento de trabajo del dueño, copiado íntegro a
`docs/diseno-pos-menu-mesas-2026-08-18.md` y enlazado desde
`roadmap-pms-multirubro.md` (sección "Complemento F&B"). **Nada
implementado todavía** — es la base para seguir charlando cada punto, no
una decisión cerrada. Resumen de lo ya decidido en concepto y lo que
sigue abierto:

**Ya decidido en concepto (falta traducir a schema/código cuando se
aborde):**
- Modelo de mesas: categoría = rubro gastronómico, recursos = mesas.
  1 apertura de mesa = 1 orden viva (`DRAFT`/`CONFIRMED`); el estado
  abierta/cerrada se deriva, no se persiste. Gap técnico ya identificado:
  `Order` no tiene `resourceId` todavía, hay que agregarlo (nullable, FK
  a `resources`).
- Solapamiento walk-in vs. reserva de mesa: buffer de seguridad antes de
  la reserva (reusa `resource_locks`/`duration_minutes` del motor de
  turnos, aplicado a mesas) + alerta visual al staff cuando se acerca el
  horario de una reserva sobre mesa ocupada.
- Analítica de mesa: timestamps de apertura/cierre + `resourceId` en
  `Order`, cruzado con `order_items`, alimentan reportería propia (sin
  IA, ya decidido en sesiones previas) — dato complementario a
  `occupancy_records` (que es diario, no sirve para esto), no reemplazo.
- Límites de plan: "negocio" = propiedad física (Enterprise habilita
  multi-propiedad); dentro de un negocio, el plan también debería limitar
  cantidad de categorías por tipo — para que separar rubros en categorías
  no sea un sustituto gratis de pagar multi-negocio. Mismo patrón que la
  idea ya conversada de vender asientos de rol por cantidad: diseñar la
  tabla de límites de forma genérica (`max_negocios`,
  `max_categorias_por_negocio`, etc.) en vez de un campo hardcodeado por
  límite nuevo que aparezca — mismo espíritu que `plan_limits` (sección C
  de este documento, ya migrado a tabla), pero ese solo cubre los límites
  que existían al 18/08, no esta dimensión nueva de categorías.

**Preguntas abiertas, sin resolver (a definir antes de tocar código):**
1. `booking_mode`: ¿un valor único por categoría, o capacidades
   independientes combinables (reservable sí/no + admite orden en vivo
   sí/no)? Se sabe que tiene que ser un catálogo extensible a nivel
   plataforma (mismo patrón que `role_presets`/`plan_limits`, no un enum
   fijo en TS), pero no la forma exacta.
2. Números concretos de tolerancia (llegada temprana / grace period de
   llegada tardía en mesas) — aceptados en concepto, faltan como default
   configurable.
3. Cómo se modela `salesChannel` (canal de venta: mesa/mostrador/
   habitación/...) y si se catalogiza fijo o extensible a nivel
   plataforma — gap recién identificado, `resourceId = null` en `Order`
   hoy sería ambiguo entre "venta de mostrador a propósito" y "se
   olvidaron de cargar la mesa".
4. Estructura genérica completa de límites de plan — el catálogo de qué
   dimensiones limitar (no solo negocios/categorías) todavía no está
   definido.

No se toca código de esto hasta que el dueño confirme cada punto — el
propio documento lo aclara ("no es una decisión final").

---

## Q. Portal de clientes migrado a cookie httpOnly (19/08/2026) — decisión del punto C, resuelta

A pedido explícito del dueño ("SEGUIMOS CON ESO"), cierra la decisión
"cookie httpOnly portal de clientes" de la sección de decisiones de este
mismo documento. Mismo patrón que B2 aplicó al panel de staff
(`pendientes-2026-08-13.md`), pero con cookie de nombre DISTINTO
(`rh_customer_token` vs. `rh_token` de staff) — viven en el mismo dominio/
path, así que un mismo navegador con las dos sesiones abiertas (ej. el
dueño probando su propio portal) no se pisa una cookie con la otra.

### Backend

- `auth.middleware.ts`: `AUTH_COOKIE_NAME_CUSTOMER` nueva, `setCustomerAuthCookie`/
  `clearCustomerAuthCookie` (mismas opciones que las de staff, factorizadas
  en un solo `cookieOptions()` para no desincronizar las dos). `authenticate()`
  ahora prueba, en orden: header `Authorization` → cookie de staff → cookie
  de cliente.
- `CustomerAuthService`: ganó `tokenTtlSeconds` (antes el TTL real del
  token quedaba en el default hardcodeado de `signToken()`, 24h, sin leer
  `JWT_EXPIRES_IN` como sí hace el staff — necesario ahora porque
  `setCustomerAuthCookie` necesita ese número para el `maxAge`).
  `parseExpiresIn()` (antes privada de `auth.service.ts`) pasa a exportada
  y reusada acá.
- `customer.routes.ts`: register/login/login-google setean la cookie
  (además de seguir devolviendo el token en el body — coexistencia, no
  reemplazo). `POST /api/customer/logout` nueva (pública, sin auth, mismo
  criterio que `/api/auth/logout` de staff). `POST /api/customer/refresh`
  nueva (autenticada, re-firma con `exp` nuevo, no toca la tenant DB —
  mismo criterio que `POST /api/auth/refresh` de staff). `GET /api/customer/me`
  gana `?businessSlug=` opcional: la cookie es del dominio entero
  (`path: '/'`), así que sin este chequeo un cliente logueado en el
  negocio A que visita el portal del negocio B se vería como "logueado"
  ahí con los datos de A — ahora responde 401 si el slug pedido no
  corresponde al `business_id` del token.
- Tests nuevos: `auth.middleware.test.ts` (prioridad header > cookie
  staff > cookie cliente, nombres de cookie distintos) y
  `customer.routes.test.ts` (nuevo archivo — `/refresh`, `/logout`, y el
  chequeo de `businessSlug` en `/me`, corriendo la cadena real de
  handlers).

### Bug real encontrado y arreglado de paso — `DELETE /api/customer/me` tiraba 500 siempre

No tiene relación con la cookie — se encontró verificando el flujo
completo end-to-end contra un server local. `SqlCustomerRepository.anonymize()`
(`sql.customer.repository.ts`) usaba `withTransaction()`/`getPool()` de
`db/pg.client.js`, que resuelve el pool desde `DATABASE_URL` — variable de
la era single-tenant, ya no existe en producción (`refactor: eliminar
soporte single-tenant`, commit `31854e8`). Cualquier cliente que pidiera
eliminar su cuenta (`Mi cuenta` → `Eliminar mi cuenta`) recibía 500 sin
importar el request — bug preexistente, presente desde ese refactor.
Corregido usando `this.sqlClient` (el pool del TENANT, ya inyectado por
el constructor), igual que el resto de los métodos de esta clase — ninguno
de ellos envuelve sus escrituras multi-statement en una transacción
explícita tampoco, mismo criterio, se mantuvo así. Test de regresión
nuevo en `sql.customer.repository.test.ts`.

### Frontend (`appfrontend-main`)

- `CustomerAuthContext.tsx` reescrito: ya no guarda nada en `localStorage`
  ni expone un token — `customer`/`isLoading` se resuelven con
  `GET /api/customer/me?businessSlug=`, disparado una vez al montar
  `CustomerAuthProvider` (que ahora lee el slug con `useParams()`, ya que
  vive dentro de `/portal/[businessSlug]/layout.tsx`). `refreshCustomer(slug)`
  se llama a mano después de login/register (para actualizar el estado
  con la respuesta fresca); `logout()` pega a `/api/customer/logout` y
  limpia el estado local. Refresh en segundo plano cada 20 min mientras
  haya sesión, mismo patrón que `AuthContext.tsx`.
- `customerApi.ts`: `customerApiFetch`/`publicFetch` ganan
  `credentials: 'include'`, sacan el header `Authorization` armado a
  mano. El interceptor de 401/`TOKEN_EXPIRED` ya no lee `session.businessSlug`
  (no existe más) — extrae el slug de `window.location.pathname` en su
  lugar (funciona igual pero además es más correcto: siempre redirige al
  login del portal que el usuario está mirando, no al de la sesión vieja).
- Páginas actualizadas: `login`/`register` (llaman `refreshCustomer` en
  vez de `setSession`), `cuenta/layout.tsx` y `disponibilidad/page.tsx`
  (leen `customer` en vez de `session`, ya no comparan `businessSlug` a
  mano — el backend lo valida), `cuenta/perfil/page.tsx` (`logout()` en
  vez de `clearSession()`, ahora async), portal home `page.tsx`
  (simplificada: el chequeo de sesión ya lo dispara el provider).
- Tipo `CustomerSession` eliminado (`lib/portal/types.ts`, re-export en
  `lib/types.ts`) — ya no hay una "sesión" persistible del lado cliente.

**Verificado end-to-end contra Postgres** (tenant `refine-test-business`,
branch de prueba de Neon — mismo criterio de precisión que la corrección
del punto P: no es la branch `production` real, es la copia bifurcada
para pruebas): server local levantado, cliente de prueba registrado vía
`curl` con cookie jar real — confirmado con las cuatro rutas nuevas/
tocadas: `GET /me?businessSlug=` correcto → 200; mismo cookie contra el
slug de OTRO negocio (`demo`) → 401 "Sesión de otro negocio" (el chequeo
funciona de verdad, no solo en el test); `POST /refresh` → token nuevo
con `exp` distinto, cookie actualizada; `POST /logout` → cookie limpiada,
`GET /me` después → 401. `DELETE /me` (con el fix del bug de arriba) →
204, y confirmado que la anonimización se grabó de verdad (un segundo
login con las mismas credenciales ya rechaza). Cliente de prueba quedó
anonimizado al terminar (mismo estado que dejaría un usuario real
eliminando su cuenta — no hizo falta limpieza adicional).

Verificado (backend): `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 621/621 (+9 tests nuevos: 4 de cookie de cliente en
`auth.middleware.test.ts`, 5 de `customer.routes.ts`/`sql.customer.repository.ts`
nuevos). Verificado (frontend): `tsc --noEmit` limpio, `npm run lint`
limpio (mismo warning preexistente sin relación), `npm run build` limpio
(25 rutas, sin rutas nuevas).

---

## P. Facturación Electrónica AFIP — Fase 1 (perfil fiscal del negocio), backend comiteado (19/08/2026)

Arranca la implementación de la Fase 1 anotada como backlog en la sección
C de este mismo documento (`docs/referencia-afip-wsfev1.md`, SDK
`arcasdk-main`). Esta fase es solo el perfil fiscal del negocio EMISOR —
todavía no hay conexión real a AFIP ni emisión de comprobantes.

### Backend — comiteado y pusheado (`250bfbd`)

- `business_profile` (schema v21) gana `legal_name`, `tax_id`/
  `tax_id_type`/`tax_condition`, domicilio fiscal en columnas planas
  (`fiscal_address_line1`/`city`/`state`/`postal_code`/`country`),
  `afip_sales_point`. Mismos nombres de columna que `customer_tax_profiles`
  (A5.1, un término en todo el stack) — esa tabla ya resuelve el lado
  comprador de una factura, esta resuelve el emisor. Todo nullable sin
  default: ningún negocio existente tenía datos fiscales, no hay
  comportamiento previo que preservar.
- `cuitSchema` nuevo en `common.schemas.ts` — valida formato (11 dígitos,
  con o sin guiones) Y el dígito verificador (módulo 11), con tests
  dedicados (`common.schemas.test.ts`, 6 casos). Genuinamente transversal
  desde el arranque (lo va a usar tanto el perfil del emisor como, más
  adelante, `customer_tax_profiles`), a diferencia del regex de hora que
  esperó a la segunda copia para mudarse a `common.schemas.ts`.
- `UpdateBusinessProfileSchema` (Zod) — los 10 campos fiscales opcionales,
  `fiscalAddressCountry` normalizado a ISO 3166-1 alfa-2 en mayúsculas.
  `GET`/`PUT /api/business-profile` (`business-profile.routes.ts`, ya
  existente, sin cambios de código — serializa la entidad completa) ya
  exponen los campos nuevos de punta a punta.
- **Verificado contra Postgres** (tenant de prueba
  `77c106bb-2e3a-4219-aa30-5dbb88ef9c35`, vía `npm run migrate:tenants`
  a v21). **Corrección importante (19/08/2026, más tarde el mismo día):**
  esta verificación corrió contra `refine-local-dev-platform`
  (`br-odd-sun-ayyir5lm`, proyecto Neon `pdb-ppms`) — una branch temporal
  bifurcada de `production` el 18/08, con TTL propio (expiró sola el
  19/08 ~12:00 UTC), **no contra la branch `production` real**
  (`br-royal-mouse-aybe2ai3`). El `PLATFORM_DATABASE_URL` del `.env`
  local apunta a esa branch de prueba, no a la real — bueno para no
  arriesgar producción sin querer en scripts ad-hoc, pero hay que tenerlo
  presente al leer "verificado contra Postgres real" en este documento:
  significa "contra una copia bifurcada de producción", no la base viva.
  Un `PUT` armado pasando por el mismo `UpdateBusinessProfileSchema` que
  usa la ruta real (no llamando al repositorio directo — la primera
  pasada de esta verificación sí lo hizo, dio un falso positivo de bug
  porque la normalización de CUIT/país vive en el schema, no en el
  repositorio), releído con una instancia nueva de
  `SqlBusinessProfileRepository`, confirmó que los 10 campos persisten y
  las dos normalizaciones (CUIT sin guiones, país a mayúsculas) se
  aplican. Datos de prueba restaurados a `null` al terminar.
  **Sobre `biz-demo-01`:** en esa misma corrida, migrar ESE negocio en la
  branch de prueba falló al desencriptar su connection string — generó
  una falsa alarma de que producción real llevaba días sin desplegar
  (ver corrección abajo). Consultando la branch `production` real
  directo (MCP de Neon): `biz-demo-01` está sano — `schema_version = 21`,
  connection string presente, actualizado el mismo 19/08 a las 10:57 UTC
  (confirma que el deploy de Render de esta sesión, con el schema v21 de
  este mismo punto P, salió bien). **No hace falta ninguna acción sobre
  `biz-demo-01` en producción** — la alarma anterior quedó descartada, no
  se tocó nada de la base real.
- Verificado: `tsc --noEmit` limpio, `npm run lint` limpio, `npm test`
  610/610 (+7 tests nuevos: 6 de `cuitSchema` + el ajuste de 8 fixtures
  de `BusinessProfile` en tests ya existentes para que sigan compilando).

### Frontend — ✅ RESUELTO (19/08/2026), comiteado y pusheado (`ef05420`)

`FiscalProfileSection` nueva en `dashboard/mi-negocio/page.tsx`
(`appfrontend-main`) — mismo patrón que `BusinessIdentitySection` ya
existente (carga con `businessProfileApi.get()`, guarda con `.update()`,
skeleton mientras carga): razón social, CUIT, tipo de documento,
condición frente al IVA, domicilio fiscal (línea/localidad/provincia/CP/
país), punto de venta AFIP. `BusinessProfile` (`lib/negocio/types.ts`) y
`businessProfileApi.update()` (`lib/negocio/api.ts`) ganan los 10 campos
nuevos — los barrels `lib/types.ts`/`lib/api.ts` no necesitaron cambios
(ya re-exportan todo desde `negocio/`). Texto libre para `taxIdType`/
`taxCondition`, sin catálogo cerrado — mismo criterio que el backend
(AFIP expone sus propios catálogos de referencia, se valida en serio
recién cuando se conecte de verdad, no antes).

Verificado: `tsc --noEmit` limpio, `npm run lint` limpio (0 errores,
mismo warning preexistente sin relación), `npm run build` limpio (25
rutas, sin rutas nuevas). **No verificado visualmente en navegador** —
sin credenciales de un usuario de prueba a mano, mismo gap recurrente de
toda esta sesión (ver puntos J/K/L/M/N más arriba). Recomendado
confirmar a simple vista en Mi Negocio antes de darlo por cerrado del
todo.

### Qué sigue (fuera de alcance de la Fase 1)

Sin conexión real a AFIP (WSFEv1 / `arcasdk-main`), sin emisión de
comprobantes, sin homologación. Fase 1 solo deja cargados los datos que
esa conexión va a necesitar. Backlog, no arrancado.

---

## R. E7a — las 3 pantallas priorizadas, construidas (19/08/2026)

A pedido explícito del dueño ("SEGUIMOS CON ESO" tras cerrar las
decisiones pendientes). Backend ya existía para las tres desde antes —
puro trabajo de frontend (`appfrontend-main`), ningún endpoint nuevo.

### 1. Horarios de servicios reservables

`ScheduleManager.tsx` (componente nuevo) — CRUD de horarios semanales de
un servicio `bookingMode='slot'` (día + hora de inicio + capacidad
simultánea), integrado en Servicios como botón "Horarios" por fila
(solo visible para servicios modo slot) — mismo patrón de modal que
`RatePlanManager.tsx` (punto M). A diferencia de tarifas, acá `DELETE`
es hard-delete real (`removeSchedule()` en el backend borra la fila, no
desactiva) — no hay reservas que referencien un `scheduleId`, la
disponibilidad se calcula al vuelo combinando schedules + resource_locks
+ reservas existentes.

### 2. Housekeeping — vistas por usuario/estado

Pestañas nuevas en `dashboard/housekeeping/page.tsx`: "Tablero" (el rack
por fecha de siempre, sin cambios) y "Mis tareas" (lista nueva, sin
filtro de fecha, vía `GET /housekeeping/me`). Un `<select>` de estado
dentro de "Mis tareas" — en "todas" trae la lista propia; en cualquier
estado puntual, cambia a `GET /housekeeping/status/:status` (tablero
COMPLETO filtrado por ese estado, todas las fechas/asignados, no solo
lo propio) — útil tanto para un housekeeper viendo su propio trabajo
como para management viendo "todo lo que está EN CURSO ahora mismo" sin
tener que pasear por fechas. Mismos botones de acción (Iniciar/Completar/
Inspeccionar/Asignar) que ya existían en el rack, reutilizados tal cual
sobre los objetos `HousekeepingTask` de la lista.

### 3. Alta pública de negocio nuevo

Pantalla nueva `/registro` (nombre del negocio + email + contraseña del
dueño), con link desde `/login` ("¿Todavía no tenés negocio? Registrate").
**Gap real encontrado y arreglado de paso:** `POST /register`
(`business.routes.ts`) devolvía el token en el body pero nunca seteaba
la cookie httpOnly (`setAuthCookie`) — a diferencia de `/api/login`/
`/select-business`/`/google`, que sí la setean desde B2. Como
`AuthContext.tsx` ya no lee el token del body (solo la cookie, ver punto
Q), un dueño registrándose desde esta pantalla nueva hubiera quedado
"deslogueado" pese a la respuesta 201 exitosa — nadie lo había notado
antes porque no existía ningún consumidor de este endpoint hasta ahora.
Corregido agregando `setAuthCookie(res, token, expiresIn)`, mismo
criterio que el resto del login de staff.

`next.config.js` (`appfrontend-main`) gana un rewrite nuevo para
`/register` — el backend lo monta sin prefijo `/api` (como `/platform`),
así que sin el rewrite el fetch nunca hubiera llegado al backend real
(se hubiera quedado pegando contra el propio Next.js).

**No verificado end-to-end en vivo, a propósito:** `POST /register`
dispara aprovisionamiento REAL de una tenant DB en Neon
(`provisionTenantDatabase()`) — no hay endpoint para dar de baja un
negocio (ver sección de backlog más arriba), así que un registro de
prueba real dejaría infraestructura huérfana sin forma de limpiarla por
API. Se verificó en cambio: `tsc --noEmit`/`npm run lint`/`npm test`
(backend, 621/621) y `tsc --noEmit`/`npm run lint`/`npm run build`
(frontend, 26 rutas — `/registro` nueva) limpios, más lectura del código
real de `business.routes.ts` confirmando que el flujo (Zod → slug →
identity → business → membership OWNER → aprovisionamiento →
`setAuthCookie` → response) es el mismo que ya corre en producción para
cada negocio existente, con el único cambio real siendo la línea de la
cookie. **Nota aparte:** la branch de Neon temporal usada para verificar
contra Postgres real en esta sesión (`refine-local-dev-platform`, ver
corrección en el punto P) venció durante esta misma sesión (TTL, no
por algo que se rompió) — si se quiere probar `/registro` de punta a
punta con una base real, hace falta crear una branch de prueba nueva
primero.

Verificado (frontend, las 3 pantallas): `tsc --noEmit` limpio, `npm run
lint` limpio (mismo warning preexistente sin relación), `npm run build`
limpio (26 rutas). **No verificado visualmente en navegador** — mismo
gap recurrente de toda la sesión (sin credenciales de prueba a mano).

---

## S. Ajuste de precio al recotizar una reserva CONFIRMED — decisión del punto I, resuelta (19/08/2026)

A pedido explícito del dueño ("SEGUIMOS CON ESO"), cierra la última
decisión pendiente de hoy: al editar fechas/recurso de una reserva ya
confirmada y cobrada, mostrar el precio recalculado como preview y dejar
que un empleado confirme el ajuste a mano (cargo extra o nota de
crédito), nunca automático.

### Backend

- `ReservationService.previewPriceAdjustment(id)` — solo lectura, compara
  `totalPrice` (congelado desde que se confirmó) contra lo que costaría
  HOY con las fechas/recurso actuales de la reserva (ya editados por
  `updateReservation()`, que sigue sin tocar el precio para CONFIRMED).
  `null` si no aplica o no hay diferencia real.
- `ReservationService.confirmPriceAdjustment(id, businessId, confirmedByUserId)`
  — aplica el nuevo `totalPrice`/`lines` y emite `reservation.price_adjusted`
  (mismo camino async por outbox que `reservation.confirmed`→CHARGE, A10:
  un solo mecanismo para crear movimientos financieros). `handleReservationPriceAdjusted`
  (`outbox.handlers.ts`) crea un `ADJUSTMENT` en `financial_transactions`
  con `amount` CON SIGNO (positivo = cargo extra, negativo = nota de
  crédito) — `ADJUSTMENT` ya estaba excluido de la conciliación de caja
  (`getCashMovementsTotal`), es el tipo correcto para una corrección de
  libro que no es un cobro/pago real de efectivo. `idempotencyKey`
  `${eventId}:ADJUSTMENT`, mismo criterio que `:CHARGE`.
- Rutas nuevas: `GET /api/reservations/:id/price-preview` (`Roles.FRONT_DESK`,
  solo lectura) y `POST /api/reservations/:id/confirm-price-adjustment`.
- Schema (v22): `financial_transactions.amount` admite negativo cuando
  `type='ADJUSTMENT'` (`CHECK (amount >= 0 OR type = 'ADJUSTMENT')`,
  reemplaza el CHECK sin nombre que Postgres autogeneraba) — CHARGE/
  PAYMENT/REFUND siguen exigiendo `>= 0`. `getNetBalanceByCustomerId`/
  `ByStayId` no necesitaron ningún cambio: ya sumaban `amount` de
  ADJUSTMENT tal cual (con signo), sin `ABS()`.
- **Bug real encontrado y arreglado de paso, mientras se tocaba
  `updateReservation()` para este feature:** `Reservation.restore()` no
  recibía `requestedCheckInTime`/`requestedCheckOutTime`/
  `scheduleApprovalStatus`/`scheduleApprovedBy`/`scheduleChargeAmount` —
  se defaultean a `null` si no se pasan, y el UPSERT real los escribe sin
  condicional. Efecto: **cualquier** `updateReservation()` (incluido el
  drag-to-move/resize del calendario, punto G) borraba en silencio un
  pedido de horario especial pendiente/aprobado (punto N). Corregido
  pasando esos 5 campos desde `existing` en el `restore()` de
  `updateReservation()`; el `restore()` nuevo de `confirmPriceAdjustment()`
  ya nació con el fix incluido. Test de regresión nuevo.

### Correcciones de diseño a pedido explícito del dueño (mismo día, antes de comitear)

Dos observaciones sobre la primera versión de este feature, ambas
aplicadas antes de dar el trabajo por terminado:

1. **Separación de roles.** La primera versión gateaba
   `confirm-price-adjustment` con `Roles.FRONT_DESK` — el mismo rol que
   ya puede editar las fechas que generan el ajuste (`PUT /:id`). El
   dueño señaló que eso convierte la "revisión manual" en una
   autoaprobación de dos clicks por la misma persona, exactamente lo que
   la decisión original quería evitar. Cambiado a `Roles.MANAGEMENT` —
   el preview (`GET .../price-preview`) sigue siendo `FRONT_DESK` (solo
   lectura, no autoriza nada), pero confirmar el cargo/nota de crédito
   necesita un rol distinto al de quien pidió el cambio.
2. **Accountability — quién confirmó.** La primera versión no dejaba
   registro de qué usuario autorizó el ajuste, pese a que el propio
   codebase ya tiene el patrón exacto para esto
   (`reservations.schedule_approved_by`, punto N) — simplemente no se
   replicó acá. Agregado `financial_transactions.confirmed_by`
   (`VARCHAR(255)`, identity_id, SIN FK a `users` por el mismo motivo que
   `stays.assigned_by`: identity vive en la platform DB) — se completa
   solo en el `ADJUSTMENT` de un ajuste de precio confirmado a mano;
   CHARGE/PAYMENT/REFUND no tienen un paso de autorización humana
   explícito, queda `null`. `confirmPriceAdjustment()` ahora exige
   `confirmedByUserId` (la ruta lo resuelve de `req.user!.id`, ya
   verificado como MANAGEMENT por el punto 1).

### Verificado

- **Backend:** `tsc --noEmit` limpio, `npm run lint` limpio, `npm test`
  639/640 (+18 tests nuevos: preview/confirm en `reservation.service.test.ts`,
  incluida la regresión de horario especial y el chequeo de
  `confirmedByUserId` obligatorio; `handleReservationPriceAdjusted` en
  `outbox.handlers.test.ts`, incluido `confirmedBy`; `confirmed_by` en
  `sql.financial-transaction.repository.test.ts`).
- **Contra Postgres real** (branch temporal `test-adjustment-check-19-08`,
  bifurcada de `production` en el proyecto Neon `DB-APP-PPMS` — la branch
  correcta para tenant DBs, distinta de `pdb-ppms`/plataforma; borrada al
  terminar): el `DROP CONSTRAINT IF EXISTS financial_transactions_amount_check`
  confirmó que el nombre autogenerado por Postgres para el CHECK sin
  nombre era efectivamente ese (no una suposición sin verificar); un
  `ADJUSTMENT` con `amount = -300` se insertó sin problema con
  `confirmed_by` grabado; un `CHARGE` con `amount = -100` fue rechazado
  por el constraint nuevo, tal como se esperaba; el `SUM` de
  `getNetBalanceByStayId` con el `ADJUSTMENT` negativo ya `SETTLED` dio
  `-300` exacto, sin haber tocado esa query — confirma que la resta ya
  funcionaba sola con el signo, como se había diseñado.
- **Frontend:** `tsc --noEmit` limpio, `npm run lint` limpio (mismo
  warning preexistente), `npm run build` limpio (26 rutas, sin rutas
  nuevas). "Editar horario" ahora también aparece para CONFIRMED (antes
  solo PENDING); banner de "Ajuste de precio pendiente" en el detalle,
  con el botón "Confirmar ajuste" visible solo para `isManagement`
  (`useIsManagement()`) — mismo criterio que la ruta del backend, evita
  mostrar un botón que el backend igual rechazaría. **No verificado
  visualmente en navegador** — mismo gap recurrente de toda la sesión.

Con esto se cierran las 4 decisiones que quedaron pendientes de la
sesión de hoy (cookie httpOnly del portal, E7a, permisos por rol —
diseño definido, implementación queda para cuando se aborde `PLAN_LIMITS`
como sistema genérico — y este ajuste de precio).

---

## T. Facturación Electrónica AFIP — Fase 2 (conexión real WSFEv1), backend y UI de certificado comiteados (19/08/2026)

A pedido explícito del dueño ("VAMOS POR CONEXIÓN REAL"), tras cerrar la
Fase 1 (punto P, solo perfil fiscal). Esta fase agrega la conexión real
a AFIP: autenticación WSAA, pedido de CAE por WSFEv1, y la tabla que
guarda cada comprobante emitido.

**Decisiones del dueño (`AskUserQuestion`) antes de arrancar:**
- Todavía no presentó el CSR a AFIP — no hay certificado real para
  probar en esta sesión, todo queda listo pero sin prueba end-to-end.
- Ambiente: homologación primero.
- Tipo de comprobante: Factura B.
- Precios: incluyen IVA (más común de cara al cliente).
- Tasa de IVA: 21% general para arrancar.

**Clasificación (`criterios-negocio`):** comprobante AFIP = **DOCUMENTO**
(no transacción ni maestro) — inmutable una vez con CAE, numeración
correlativa por talonario, emitido por un tercero externo. Contrapartida
de un `financial_transaction` ya existente (A3.9), nunca lo reemplaza.

### Backend — comiteado y pusheado (`120e4a1`)

- Nuevo módulo `src/facturacion/`: `SqlAfipCredentialsRepository`
  (cert/clave/ambiente cifrados con AES-256-GCM, reutilizando
  `encryptConnectionString`; cachea el ticket WSAA 12hs), catálogo de
  códigos AFIP (`CbteTipo`/`DocTipo`/`CondicionIvaReceptorId`),
  `afip-client.factory.ts` (arma el cliente `@arcasdk/core`), e
  `InvoiceService` (solicitar/emitir/reconciliar un comprobante).
- Tabla `invoices` (schema v23): `business_id` (aislamiento por tenant —
  cada negocio tiene su propia BD, no hace falta columna de filtro
  adicional), `idempotency_key` único, unicidad de talonario
  (`business_id`, `pto_vta`, `cbte_tipo`, `cbte_nro`), FK a
  `financial_transaction_id` (R15: si esa transacción no existe, el
  INSERT falla en vez de guardar un comprobante huérfano).
- **A8.6 — nunca reintentar una mutación ambigua.** Si la llamada a AFIP
  se corta después de contactarlo (no se sabe si emitió o no), no se
  reintenta a ciegas: `reconcileAfterFailure()` compara
  `getLastVoucher()` antes/después del intento y consulta
  `getVoucherInfo()` para confirmar qué pasó realmente, en vez de
  arriesgar un comprobante salteado o duplicado.
- `business_profile` gana `defaultIvaRate`/`pricesIncludeIva` (decisión
  del dueño arriba).
- `financial-transaction.repository` gana `getById()` — no existía,
  hacía falta para resolver el cobro a facturar.
- Nuevos `DomainError`: `FINANCIAL_TRANSACTION_NOT_FOUND` (404),
  `AFIP_NOT_CONFIGURED` (503 — mismo criterio que `BUSINESS_NOT_READY`,
  depende de un recurso externo todavía no disponible),
  `AFIP_REQUEST_UNCERTAIN` (409, A8.6), `AFIP_REQUEST_REJECTED` (422 —
  AFIP rechazó el comprobante por una regla de negocio suya).
- Rutas nuevas, todas detrás de `requireModule(ModuleKey.FACTURACION)`
  (módulo ya definido y sembrado, sin ninguna ruta que lo usara hasta
  ahora): `GET/PUT/DELETE /api/business-profile/afip-credentials`
  (`Roles.MANAGEMENT` — carga un secreto, no lo puede hacer cualquiera)
  y `POST/GET /api/invoices` (`Roles.FRONT_DESK` — pedir el CAE de un
  cobro ya registrado).
- Verificado: `tsc --noEmit` limpio, `npm run lint` limpio, `npm test`
  664/665 (+25 tests nuevos: catálogo AFIP, repositorio de credenciales
  cifradas, `InvoiceService` incluida la reconciliación A8.6).
- **Contra Postgres real** (branch temporal `test-afip-schema-19-08`,
  bifurcada de `production` en el proyecto Neon `DB-APP-PPMS`, borrada al
  terminar): el constraint de talonario único rechazó un duplicado
  (`business_id` + `pto_vta` + `cbte_tipo` + `cbte_nro`), el
  `idempotency_key` único funcionó igual, la FK a
  `financial_transaction_id` inexistente falló tal como se esperaba
  (R15), y los campos nuevos de `business_profile` quedaron con los
  defaults reales (21.00, `true`).

### Frontend — comiteado y pusheado (`280f7b9`)

Nuevo dominio `lib/facturacion/` (`types.ts` + `api.ts`, mismo patrón que
el resto de `lib/<dominio>/`): `afipCredentialsApi` (status/save/clear,
nunca recibe el cert/clave de vuelta del backend) e `invoicesApi`
(request/get/listByFinancialTransaction, listo para cuando exista el
botón "Facturar"). En Mi Negocio: sección nueva "Certificado AFIP"
(textareas para `.crt`/`.key`, selector homologación/producción, botón
"Borrar certificado" con confirmación) — si el negocio no tiene el
módulo de Facturación habilitado, muestra un mensaje en vez de romper
(`MODULE_NOT_ENABLED`, 402). "Datos fiscales" gana los dos campos de IVA
(tasa general, si el precio ya la incluye).

Verificado: `tsc --noEmit` limpio, `next build` limpio (26 rutas, sin
rutas nuevas), `eslint` sin errores nuevos (mismo warning preexistente
sin relación en `lib/http.ts`). **No verificado visualmente en
navegador** — sin credenciales de un usuario de prueba ni herramienta de
browser disponibles en esta sesión, mismo gap recurrente de toda la
sesión (ver puntos J/K/L/M/N/P/S). Recomendado confirmar a simple vista
en Mi Negocio antes de darlo por completamente probado.

### Qué sigue (fuera de alcance de esta fase)

- Botón "Facturar" en el flujo de cobro real — todavía no se decidió
  dónde exactamente vive (¿detalle de reserva? ¿clientes-finanzas?
  ¿ambos?). `invoicesApi.request()` ya existe del lado del frontend,
  falta el punto de entrada en la UI.
- Prueba real contra AFIP homologación: bloqueada hasta que el dueño
  presente el CSR y tenga certificado válido — sin eso, ni el flujo feliz
  ni la reconciliación A8.6 se pueden ejercitar contra el servicio real,
  solo contra los tests unitarios con el cliente mockeado.

---

## U. Bug real encontrado tras el deploy de T — `npm start` reventaba Render por falta de memoria (19/08/2026)

Después de pushear el punto T, un deploy posterior (commit `7d17407`,
**solo docs**, sin tocar código de la app) se cayó en Render con
`FATAL ERROR: Ineffective mark-compacts near heap limit — JavaScript heap
out of memory` (exit 134). No fue un bug de la Fase 2 en sí — fue el
módulo nuevo (`facturacion/` + dependencia `@arcasdk/core`) el que hizo
que un problema latente cruzara el límite de memoria.

**Causa:** `package.json` tenía `"start": "npm run build && node
dist/server.js"` — heredado de un fix viejo (`df47067`, de cuando
`render.yaml` todavía no tenía `buildCommand` propio). Con
`buildCommand: npm install && npm run build && npm run migrate:tenants`
ya compilando y subiendo `dist/` en la etapa de build, `npm start`
volvía a correr `rm -rf dist && tsc` desde cero **en el contenedor de
runtime** (más chico de memoria que el de build) cada vez que arrancaba
el proceso. Con el codebase ya más grande, ese segundo `tsc` redundante
fue lo que hizo explotar la memoria.

**No hubo caída del sitio real** — Render sigue sirviendo el último
deploy sano mientras uno nuevo falla — pero cualquier deploy futuro
corría el mismo riesgo, con probabilidad creciente a medida que el
código crece.

**Fix (commit `b2b01ed`):** `start` pasa a ser directo `node
dist/server.js` — el `dist/` ya viene armado por `buildCommand`, no hace
falta rehacerlo. Verificado: `npm run build` local genera `dist/server.js`
correctamente.

**Confirmado por el dueño (19/08/2026):** el deploy siguiente salió bien,
y desde Mi Negocio ya guardó el certificado y la clave AFIP de
homologación sin errores — la sección "Certificado AFIP" (punto T)
funciona end-to-end contra producción real. El "Cannot GET
/api/business-profile/afip-credentials" reportado antes de este fix era
solo por probar esa URL directo en el navegador (esa ruta acepta
PUT/DELETE, no GET sin `/status`) — no era un bug.

---

## V. Botón "Facturar" + auditoría E7a/K + bug real de reintento de facturas AFIP (19/08/2026)

A pedido explícito del dueño, sesión de continuación. Tres pedidos en
paralelo, resueltos en orden.

### 1. Botón "Facturar" en el flujo de cobro — ✅ RESUELTO (`appfrontend-main`)

Quedaba pendiente del punto T ("qué sigue"): `invoicesApi.request()` ya
existía del lado del frontend, faltaba el punto de entrada en la UI.
Decisión del dueño: **ambos lugares** (Reservas y Cuentas Corrientes),
mismo componente reusado.

- `components/FacturarButton.tsx` (nuevo) — recibe `financialTransactionId`,
  llama `POST /api/invoices` (ya idempotente por transacción del lado del
  backend, así que un click sobre una factura ya emitida devuelve la misma,
  nunca duplica). Maneja `MODULE_NOT_ENABLED` mostrando un mensaje en vez
  de romper, mismo criterio que la sección de certificado AFIP.
- Cuentas Corrientes: botón por fila de cargo (`CHARGE`).
- Reservas (detalle): botón bajo "Comprobante AFIP" cuando existe un
  `CHARGE` para esa reserva — resuelto vía `customerAccountApi.getStatement()`
  (sin sumar endpoint nuevo).
- **Bug propio encontrado y corregido en el camino:** el gate inicial
  exigía `tx.status === 'SETTLED'`, pero el `CHARGE` queda `PENDING` hasta
  el checkout (`handleReservationCompleted`, `outbox.handlers.ts`) — eso
  escondía el botón para toda reserva `CONFIRMED` todavía no completada,
  el caso más común. Corregido a excluir solo `VOIDED`/`FAILED`.

Verificado (frontend): `tsc`/`lint`/`build` limpios. Verificado en
producción real (Playwright, `host.zuluhub.com.ar`): botón visible y
funcional en los dos lugares.

### 2. Auditoría de `getActiveForServiceInRange()` (punto K, "pendiente evaluar aparte") — ✅ CERRADO, sin impacto real

En producción real solo existe **una fila** en `resource_locks` (la del
bug de referencia original, "Barbero Isahia"/"Corte de pelo", hoy
`active=false`), y contra ese recurso hay **una sola reserva** en toda la
base. Con una sola reserva no pudo haber existido un doble-booking real
(hacen falta al menos dos superpuestas para que el gap se manifieste). El
fix del bug ya aplicado sigue siendo correcto — esto solo confirma que no
hay nada que reparar retroactivamente en los datos.

### 3. Bug real: comprobante AFIP fallido quedaba irrecuperable para siempre — ✅ RESUELTO (schema v24)

Encontrado en vivo: el dueño probó "Facturar" en homologación y WSAA
rechazó el certificado (`Computador no autorizado a acceder al servicio`)
antes de pedir el CAE. Como `idempotency_key` es determinística por
`financial_transaction_id` (una sola fila posible por cobro),
`requestInvoice()` iba a devolver ese mismo registro `FAILED_UNCERTAIN`
para siempre, incluso después de corregir el problema del lado de AFIP.

- `invoices.afip_contacted` (schema v24) — si `createNextVoucher()`
  (WSFEv1) llegó a invocarse antes de la falla. `FALSE` = sin ambigüedad
  posible (ej. ni siquiera se pudo autenticar), reintento automático
  seguro. `TRUE` = AFIP fue contactado y la falla es genuinamente ambigua
  (A8.6) — requiere revisión manual antes de reintentar, para no
  arriesgar un CAE duplicado real.
- `InvoiceService.requestInvoice()` gana `retryExisting()`: reusa la
  MISMA fila cuando es seguro (`PENDING`, `REJECTED`, o `FAILED_UNCERTAIN`
  sin contactar) y se abstiene cuando no. `ISSUED` nunca se retoca.
- Backfill del schema v24: el único caso identificable con certeza por su
  `error_message` (el chequeo previo al CAE) se corrigió a
  `afip_contacted=false` sobre las filas ya existentes en producción.
- 3 tests nuevos (reintenta / no reintenta / reintenta tras rechazo
  explícito). Suite completa: 670/670.
- **Verificado contra AFIP homologación real**: el reintento sí volvió a
  intentar contra el servicio real de AFIP (no devolvió el caché al
  toque), sin duplicar la fila. Siguió fallando por el mismo motivo de
  fondo (ver punto 4) — confirma que el mecanismo de reintento en sí
  funciona, el bloqueo real quedó del lado de AFIP.

### 4. CUIT de autenticación AFIP separado del CUIT legal — ✅ RESUELTO (schema v25)

Diagnóstico real del `Computador no autorizado`: el certificado cargado
salió del gestor de certificados de **producción** de AFIP, no del de
testing/homologación — ambientes con certificados independientes, nunca
se mezclan. El dueño decidió seguir probando con un **CUIT del pool de
testing de AFIP**, distinto de su CUIT real.

`business_profile.tax_id` se usaba para dos cosas a la vez: la identidad
fiscal legal real ("Datos fiscales") y el CUIT de autenticación contra
AFIP — pisarlo con el CUIT de testing hubiera ensuciado el dato legal.

- `business_profile.afip_cuit` (schema v25, nullable) — `NULL` = seguir
  usando `tax_id` (comportamiento de siempre, sin cambio para quien no lo
  cargue). `InvoiceService` resuelve `profile.afipCuit ?? profile.taxId`
  como CUIT de autenticación.
- Mi Negocio (`appfrontend-main`) — campo nuevo "CUIT de autenticación"
  en la sección Certificado AFIP (no en Datos Fiscales, a propósito).
- 4 tests nuevos (fallback a `taxId`, `afipCuit` gana, rechaza sin
  ninguno de los dos). Suite completa: 673/673.

**Verificado en producción real** (Playwright): campo visible y
funcional en Mi Negocio, sin errores de consola. No se probó un guardado
real con un CUIT inventado para no ensuciar el dato de producción.

**Qué falta para que la Fase 2 de AFIP funcione de punta a punta:** el
dueño tiene que (1) conseguir un CUIT del pool de testing de AFIP, (2)
generar el certificado en el gestor de **homologación** (no el de
producción), (3) cargar cert + "CUIT de autenticación" en Mi Negocio, y
(4) reintentar sobre los dos comprobantes que quedaron `FAILED_UNCERTAIN`.
Ninguno de estos cuatro pasos depende de código nuevo.

---

## W. PDF del comprobante AFIP — `@arcasdk/pdf` (19/08/2026, schema v26)

A pedido explícito del dueño ("Integrar ArcaSDK en app-main"). Aclarado
antes de tocar código: `@arcasdk/core` (WSAA/WSFEv1) ya estaba integrado
desde la Fase 2 — lo que faltaba era el paquete hermano `@arcasdk/pdf`
(repo fuente provisto por el dueño, `arcasdk-main (1)`), que genera el
PDF oficial con diseño ARCA/AFIP y QR de verificación. Sin esto, el
botón "Facturar" daba un CAE pero no había nada imprimible para el
cliente.

**Riesgo real, planteado y aceptado explícitamente antes de implementar:**
`@arcasdk/pdf` depende de Puppeteer — ~680MB de Chromium se descargan en
cada `npm install` (corre en cada build de Render, ya incluido en
`buildCommand`), y cada PDF generado lanza un proceso Chromium headless
completo en runtime. `npm audit` marca una vulnerabilidad alta sin fix
(`extract-zip`, path traversal) transitiva de Puppeteer — solo se
ejercita al descomprimir el Chromium descargado, no en cada request,
pero es real. Mismo tipo de riesgo que el incidente de memoria del punto
U de este documento (ahí un `tsc` redundante, acá Puppeteer). El dueño
confirmó explícitamente probarlo igual en el mismo backend en vez de
aislarlo en un servicio aparte o buscar un motor sin Chromium.

### Backend (`app-main`)

- `invoices.emisor_cuit` (schema v26, R9 — criterios-datos.md) — congela
  el CUIT de autenticación AFIP usado al CREAR el comprobante, para que
  el PDF siga mostrando el CUIT real con el que AFIP lo asoció aunque
  `business_profile.afip_cuit` cambie después.
- `InvoicePdfService` (nuevo) — arma el `InvoiceData` desde
  `invoices`/`business_profile`/`customers` y llama a
  `InvoicePdfGenerator`. Rechaza fuerte (`InvoiceNotIssuedError`, 409) si
  el comprobante no tiene CAE — `invoices` es DOCUMENTO, no se imprime
  nada "provisorio".
- `GET /api/invoices/:id/pdf` (`Roles.FRONT_DESK`, mismo gate de módulo
  que el resto de facturación) — devuelve el PDF binario.
- Simplificaciones deliberadas de este corte (documentadas en el
  docblock del servicio): un solo ítem por comprobante (el cobro es un
  monto único hoy, sin desglose de líneas a nivel `FinancialTransaction`);
  receptor asume Consumidor Final (único caso que la UI arma —
  `RequestInvoiceInput.buyer` nunca se manda desde el frontend todavía);
  `emisor.iibb`/`fechaInicioActividades` quedan vacíos (no cargados en
  el sistema).
- **Ajuste encontrado verificando con un fixture real:** pasar el código
  numérico crudo (`docTipo`, ej. `99`) como `documentoTipo` imprimía
  "99: 0" en el PDF en vez de una etiqueta legible — `@arcasdk/pdf`
  espera la etiqueta ("CUIT"/"DNI"/"Sin Identificar") tanto para mostrarla
  como para el QR. Agregado `docTipoLabel()` (inverso de
  `resolveDocTipo()` ya existente) en `afip-catalog.constants.ts`.
- 3 tests nuevos (los guards de `InvoicePdfService` — no encontrado,
  `PENDING`, `FAILED_UNCERTAIN` — sin invocar el generador real, eso se
  verificó a mano). Suite completa: 673/673.

### Frontend (`appfrontend-main`)

`FacturarButton.tsx` — botón "PDF" junto al CAE/Cbte cuando el
comprobante quedó `ISSUED`. Blob + objectURL + `<a>` temporal (patrón
estándar de descarga), sin pasar por `apiFetch` (esa función siempre
espera JSON).

### Verificado

- **Local, con un fixture real** (no un mock): PDF válido generado
  (~91KB, ~1s), firma `%PDF-` correcta, layout AFIP/ARCA correcto, QR
  presente, CAE/vencimiento visibles — confirmado leyendo el PDF
  generado, no solo que el buffer no esté vacío.
- **Contra producción real, tras el deploy**: servidor sano después del
  build con Puppeteer (`/health` 200); `GET /api/invoices/:id/pdf` sobre
  uno de los comprobantes `FAILED_UNCERTAIN` reales devolvió
  `409 INVOICE_NOT_ISSUED` correctamente, sin caerse el servidor.
- **No verificado todavía**: que Puppeteer lance Chromium exitosamente
  en el runtime real de Render (el guard de arriba corta ANTES de llegar
  a esa parte). Depende de tener un comprobante `ISSUED` de verdad — o
  sea, depende de que se resuelva el trámite de AFIP (punto V.4). Probar
  la descarga del PDF real apenas exista el primer comprobante `ISSUED`
  es el primer chequeo pendiente de esta sesión.
- `tsc`/`lint`/`build` limpios en los dos repos.

### Backlog anotado, no implementado (capacidades de ArcaSDK que el dueño repasó)

CAEA (autorización anticipada offline), FCE MiPyMEs, FEX (exportación),
motores SOAP intercambiables — sin caso de uso concreto todavía. La más
interesante para cuando se priorice: **Registro/Padrón**
(`getPersonaInfo`-style, consulta contra el padrón de AFIP por CUIT) —
autocompletar razón social/condición IVA/domicilio de un cliente nuevo
en vez de tipearlos a mano, en `customer_tax_profiles` (tabla que ya
existe en el schema pero sin repositorio propio ni consumidor real
todavía).

---

## X. Mail y PDF de factura reportados rotos en uso real — dos bugs de código + un dato mal cargado (19/08/2026)

El dueño reportó, ya en producción: confirmó una reserva y el mail de
confirmación no llegó, y al facturar el PDF no descargaba. Investigado en
paralelo — tres causas distintas, ninguna relacionada con la otra.

### 1. Mail — ✅ RESUELTO, era `RESEND_FROM_EMAIL` mal cargada en Render, no un bug de código

El log de Resend (resend.com/emails) mostró el request real:
`"from": "Hotel ZULU <tureserva.host.zuluhub.com.ar>"` → `422 Invalid
'from' field`. La variable se había cargado con el dominio pelado, sin
casilla de mail delante (tenía que ser `algo@dominio`, no solo
`dominio`). Corregida por el dueño directo en Render — sin cambio de
código. Confirmado por el dueño: **el mail ya funciona.**

### 2. PDF — ✅ RESUELTO, dos bugs de código apilados (uno tapaba al otro)

**Bug A — Chromium sin `--no-sandbox` en el contenedor de Render.**
Exactamente el riesgo que había quedado sin verificar en el punto W
("no verificado todavía: que Puppeteer lance Chromium exitosamente en
runtime real de Render"). `@arcasdk/pdf` llama
`puppeteer.launch({ headless: true })` sin exponer opciones de launch en
su API pública — parcheado con `patch-package` (`patches/@arcasdk+pdf+
0.2.0.patch`, se reaplica solo en cada `npm install` vía `postinstall`)
agregando `args: ['--no-sandbox', '--disable-setuid-sandbox',
'--disable-dev-shm-usage']`. Verificado generando un PDF real
localmente con el parche puesto (90KB, `%PDF-` válido). Commit `71d4683`.

**Bug secundario, mientras tanto — el botón "PDF" no mostraba el error.**
`FacturarButton.tsx`: la rama `invoice.status === 'ISSUED'` seteaba
`errorMessage` si fallaba la descarga pero nunca lo renderizaba (ese
`<span>` solo vivía en la rama de antes de facturar) — por eso el
dueño vio "no pasa nada" en vez de un mensaje. Corregido en
`appfrontend-main` (commit `f80f563`).

**Bug B — el real detrás del primer 500 que SÍ se vio gracias al fix
anterior:** `TypeError: invoice.caeVto.replace is not a function`
(`invoice-pdf.service.ts:106`, visible en logs de Render recién después
del fix de arriba). `invoices.cae_vto` es `DATE` en Postgres — el driver
`pg` lo devuelve como objeto `Date` en runtime, no como string, pese a
que `InvoiceRow` (`sql.invoice.repository.ts`) lo tipaba `string | null`
(mismo tipo de gap ya resuelto antes para `cbte_nro`/BIGINT, pero nunca
aplicado acá). Como el resto del código solo serializa `caeVto` a JSON
(que serializa un `Date` como ISO string sin que nadie lo note), nadie
había pisado el bug hasta que `InvoicePdfService` llamó `.replace()`
directo sobre el valor crudo del driver. Corregido en el mapeo de fila
(`rowToEntity`), mismo borde donde ya se normalizaba `cbte_nro` — el
resto del código sigue confiando en el tipo `string` que la entidad
declara. Test de regresión nuevo (`sql.invoice.repository.test.ts`,
mockea una fila con un `Date` real, no un string — los tests viejos de
esta clase de bug siempre mockeaban ya con string, por eso no lo
agarraban). Commit `5d912d7`.

**Verificado:** `tsc --noEmit`, `npm run lint`, `npm run build` y
`npm test` (675/676, +2 tests nuevos) limpios en `app-main`; `tsc
--noEmit` limpio en `appfrontend-main`. **No verificado todavía contra
un PDF real en producción tras el segundo fix** (el del `caeVto`) —
recomendado que el dueño reintente "Facturar" → "PDF" sobre el mismo
comprobante (`23170335-71ca-4cdc-9d46-a577308c980e`) una vez que termine
el redeploy de Render con el commit `5d912d7`.
