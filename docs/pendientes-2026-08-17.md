# Pendientes — Lunes 17 de Agosto 2026

Arranca a partir de lo que quedó abierto en `pendientes-2026-08-16.md`.
Mismo criterio de agrupación: deuda estructural primero, seguridad
después, calidad de código, backlog, observaciones sin implementar.
Marcar `✅ RESUELTO` in-place al cerrar un ítem.

---

## A. Resuelto hoy (17/08), carve-out de inventario — Fase 1 cerrada del todo

- ✅ **Hallazgo de revisión del 16/08 aplicado** — `POST
  /api/products/stock/transfer` ahora valida que, cuando se pasa
  `productId`, ese producto tenga `hasVariants=false` (404 si no existe,
  400 `PRODUCT_HAS_VARIANTS` si maneja stock por variante). Mismo chequeo
  que ya tenía `ProductService.createVariant()`.
- ✅ **Revisión de diff completada** — los archivos que habían quedado sin
  revisar el 16/08 (`product.repository.ts`, `sql.product.repository.ts`,
  `product.entities.ts`, y los 3 de `InventoryLevelRepository`) están
  limpios: R2 (`getById` sin filtro de estado) y A8.2 (insert-then-act
  atómico) se cumplen. La falta de filtro `business_id` en los `UPDATE` de
  `InventoryLevelRepository` no es un gap nuevo — mismo patrón que
  `sql.stock-movement.repository.ts`, consistente con A2.8 (aislamiento
  real por pool de conexión por tenant).

Detalle completo en `pendientes-2026-08-16.md` sección B (actualizada
in-place) y `docs/diseno-inventario-carve-out.md`.

## B. Carve-out de `inventario/` — Fase 2 (mermas) hecha y verificada (17/08/2026)

Diseño ya acordado el 16/08 (`docs/diseno-inventario-carve-out.md`), sin
cambios de alcance. Resumen — detalle completo en ese documento:

- `waste_reasons` nueva (schema v12) — MAESTRO por negocio, catálogo de
  motivos propio (no hardcodeado en código — decisión organizacional del
  dueño, memoria `feedback_technical_vs_organizational_decisions`).
- `stock_movements` gana `movement_type = 'WASTE'` + `waste_reason_id`
  (obligatorio para ese tipo).
- `WasteReasonRepository`/`WasteReasonService` (CRUD + auditoría, mismo
  patrón que categorías) + `GET/POST/PUT/DELETE /api/waste-reasons`.
- `InventoryLevelRepository.decrementAvailableStock()` (nuevo) — da de
  baja stock condicionado a lo DISPONIBLE (stock - reservado), no solo al
  físico, mismo criterio que ya usaba `transferStock()`.
- `POST /api/products/stock/waste` — registra una merma real como
  operación atómica (mismo mecanismo insert-then-act que `/stock/transfer`,
  `movementId` opcional).
- De paso: `INSUFFICIENT_STOCK` (existía en `product.service.ts` sin case
  en `error.middleware.ts`, caía al 500 genérico) suma mapeo a 400 — cierra
  el mismo hueco latente que tenía `/:id/stock/decrement`.

**Verificado contra Postgres real** (proyecto Neon `DB-APP-PPMS`, branch
temporal `verify-schema-v12-waste-reasons`, borrado después): `WASTE` sin
motivo rechazado por CHECK, con motivo válido insertado, con motivo
inexistente rechazado por FK, `ADJUSTMENT` sigue exigiendo `notes`
(constraint vieja intacta), desactivar un motivo en uso no rompe nada, y
`decrementAvailableStock()` probado con datos reales (pedir más de lo
disponible = 0 filas afectadas, pedir exacto sí se aplica).

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 453/454 (+11 tests nuevos), `npm run build` limpio.

**Backend únicamente** — sin UI en `appfrontend-main` todavía (catálogo de
motivos ni pantalla para registrar una merma).

**Fases 1 y 2 del carve-out de inventario: completamente cerradas.**

## C. Carve-out de `inventario/` — Fase 3 (recetas/BOM + Producción) hecha y verificada (17/08/2026)

Diseño acordado el 16/08 (`docs/diseno-inventario-carve-out.md`, sección
Fase 3). Resumen — detalle completo, incluidas las 3 decisiones técnicas
que el diseño original no dejaba pinneadas, en ese documento:

- `products.product_type`/`assemble_on_demand` (schema v13) + `recipe_items`
  nueva (BOM multinivel, prevención de ciclos vía CTE recursiva).
- `RecipeService.explodeRecipe()` (venta/armado en vivo) vs.
  `explodeRecipeForProduction()` (Producción manual, explota siempre que
  sea COMPOSITE) — misma regla de recursión en los dos (para en un
  componente COMPOSITE con `assemble_on_demand=false`, sigue de largo en
  uno con `true`).
- `order_items.stock_snapshot` (columna nueva) — persiste qué componentes
  se reservaron de verdad al confirmar, para que `cancelOrder()` revierta
  exacto eso aunque la receta cambie después.
- Índices únicos de idempotencia de `stock_movements` (BLOQUE 13/D1)
  ampliados a (order_item, producto/variante, tipo) — un ítem compuesto
  puede generar varios componentes bajo el mismo `order_item_id`.
- `OrderService.confirmOrder()`/`cancelOrder()` integran la explosión —
  un ítem simple sigue exactamente igual que antes.
- `POST /api/products/stock/production` + `GET/POST/PUT/DELETE
  /api/products/:id/recipe-items`.

**Hallazgo real encontrado y corregido durante la implementación** (no
llegó a quedar mal escrito): el índice único ampliado de arriba,
combinando `product_id`/`product_variant_id` con otras columnas en UN
solo índice, no bloqueaba duplicados — Postgres trata cada NULL como
distinto de cualquier otro NULL. Corregido separando en dos índices
parciales (mismo patrón que `inventory_levels` ya usaba). Logueado en
`patrones-recurrentes.md` de la skill `revision-pr-pms-erp`.

**Verificado contra Postgres real** (proyecto Neon `DB-APP-PPMS`, tres
branches temporales sucesivos, borrados después): CHECKs y unicidad
rechazados correctamente, y una simulación end-to-end completa de un
pedido con producto compuesto de dos componentes (reserva, consolidación
con dos filas OUT bajo el mismo order_item, reintento idempotente sin
duplicar, cancelación que restaura exacto vía stock_snapshot) — vuelve al
estado inicial exacto.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 481/482 (+27 tests nuevos), `npm run build` limpio.

**Backend únicamente** — sin UI en `appfrontend-main` todavía (marcar
producto COMPOSITE, armar receta, pantalla de Producción).

**Fases 1, 2 y 3 del carve-out de inventario: completamente cerradas.**
Quedan fuera de este diseño (conversación futura propia cada una):
Compras/Proveedores (ver sección E, más abajo, para Empresas
multipropiedad — se retomó y cerró hoy mismo), COGS teórico-vs-real.

---

## E. Empresas multipropiedad — diseñado, implementado y CORREGIDO hoy (17/08/2026)

Retomada la conversación dedicada que `pendientes-2026-08-15.md` sección
B6 dejaba pendiente. Diseño completo en
`docs/diseno-empresas-multipropiedad.md` — resumen:

- `companies`/`businesses.company_id` (BD central) + catálogo canónico
  (`company_products`/`company_recipe_items`) + cola de propagación
  (`company_catalog_propagation_queue`).
- `products.company_product_id` + override de PRECIO **y de RECETA**, cada
  uno de tres estados (INACTIVO/ACTIVO/PENDIENTE_DE_REVISION, no booleano
  — un cambio del maestro mientras hay override local activo genera una
  revisión pendiente, nunca se aplica en silencio ni se ignora).
- `CompanyCatalogService`: `listCompanyCatalog()`, `createLinkedProduct()`,
  `autoShareIfLinked()`, `shareProduct()` (retroactivo), `publishUpdate()`,
  y los 8 métodos de override (precio + receta) + `CompanyCatalogPropagationWorker`
  (único worker del proceso, conecta a cada sucursal hermana con una
  conexión de vida corta, decriptando su connection string; propaga precio
  Y receta).
- `POST /api/companies`(`/link`) + `GET /api/products/company-catalog` +
  `POST /api/products` (con `companyProductId` opcional) +
  `POST /api/products/:id/company/*` — todo `Roles.MANAGEMENT`,
  restringido siempre al negocio propio del caller (nunca un businessId
  arbitrario del body).
- Además, de la misma conversación: **bloqueo de desactivar un producto
  con stock físico > 0** (regla general, no exclusiva de empresas
  multipropiedad) — reusa el flujo de merma ya existente para resolver la
  diferencia, sin mecanismo nuevo.

**Corrección de modelo a mitad de sesión:** la primera versión trataba
"compartir" como paso manual y opcional (`POST /:id/company/share` como
única puerta de entrada), con `products.active` decidiendo si algo se
compartía. El dueño corrigió: compartir es SIEMPRE automático — es lo que
evita que dos sucursales terminen con "Jamón" bajo dos IDs distintos
(ID:51 y ID:57). `active` es para que una sucursal deje de USAR un
producto compartido (lo desactiva localmente), no para decidir si se
comparte. Reescrito `CompanyCatalogService` completo (alta con
`companyProductId` = vincular a un canónico existente elegido a mano por
el usuario en un picker; alta sin él = auto-comparte), `products.routes.ts`,
y `company-sync.worker.ts` (ahora propaga receta, no solo precio). Con
esto también se destrabó la receta compartida: como todo producto de una
empresa está SIEMPRE compartido, un componente de receta siempre tiene id
canónico, no hay encadenamiento roto posible.

**Detección de duplicados:** se evaluó y descartó matching automático por
nombre — el dueño eligió el camino manual explícito: mostrar el catálogo
de la empresa al crear (`GET /api/products/company-catalog`) y elegir a
mano.

**Simplificado a propósito (sigue igual):** publicar un cambio de EDICIÓN
es una acción explícita (`POST /:id/company/publish`), no automática en
cada PUT — evita enganchar esto dentro de
`ProductService.updateProduct()`, el camino crítico ya verificado a fondo
en las Fases 1-3. El ALTA sí es automática, porque de eso depende evitar
IDs duplicados.

**Verificado contra Postgres real** (proyectos Neon `DB-APP-PPMS` y
`pdb-ppms`, branches temporales, borrados después): constraints, dedup de
la cola de propagación, y las ramas del worker (producto nuevo para el
tenant + materializa receta canónica, override INACTIVO, override ACTIVO
→ pasa a revisión pendiente) probadas con datos reales tanto para precio
como para receta.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 526/527 (36 tests de `CompanyCatalogService`), `npm run build`
limpio.

**Backend únicamente** — sin UI en `appfrontend-main` todavía.

---

## D. Heredado de `pendientes-2026-08-16.md`, sigue abierto

Sin cambios desde ayer — ver `pendientes-2026-08-15.md`/`-16.md` para el
detalle completo de cada uno:

- Decidir si portal de clientes/plataforma migran a cookie httpOnly o
  quedan como están.
- FACTURACION electrónica (AFIP) — investigado, nada implementado.
  Bloquea con ABM de Empresa (perfil fiscal) y ABM de Producto (IVA).
- Mails de reserva confirmada — falta cuenta de Resend + dominio
  verificado (`NoopEmailSender` hasta entonces).
- Login con Google — falta crear el OAuth Client ID en Google Cloud
  Console y cargar `GOOGLE_CLIENT_ID`/`NEXT_PUBLIC_GOOGLE_CLIENT_ID`.
- Portal de clientes: falta landing + alta pública de negocio, y
  mecanismo de "reclamo" (`claim`/`merge`) completo (el login con Google
  ya resuelve el caso más común, no el fusionar historial).
- Sitios corporativos (dominio propio) + guest checkout + magic link —
  solo documentado.
- Frontend: falta botón "marcar como servido" en POS/cocina
  (`POST /:id/serve` ya existe en backend). Ahora también falta UI para
  el catálogo de motivos de merma y para registrar una merma (ver B), para
  marcar un producto COMPOSITE, armar su receta y registrar una Producción
  (ver C), y para todo el flujo de empresas multipropiedad — compartir un
  producto, resolver revisiones pendientes, alta de `companies` (ver E).
- E1-E7 de `pendientes-2026-08-13.md` — necesitan que el dueño defina
  alcance (salvo E7c/d/e, ya resueltos).
- ✅ RESUELTO — Empresas multipropiedad: sincronización de RECETA
  compartida. Se resolvió y verificó hoy mismo, más tarde en esta sesión
  — ver sección E (reescrita, "PRECIO **y de RECETA**"). El encadenamiento
  de componentes compartidos dejó de ser un problema con el modelo
  corregido (todo producto de una empresa está SIEMPRE compartido).

---

## F. Agregados por el dueño (17/08/2026, tarde) — organización + monetización + auditoría de hardcodes

### F1. Reorganizar `security/` — separar auth genérica de gestión de usuarios/roles

Evaluado, **sin tocar código todavía** (pedido explícito: solo organizar
archivos, no tocar lógica de negocio). Hallazgo: la gestión de
usuarios/roles hoy está más dispersa de lo que parecía a primera vista —
no es solo `security/`, son TRES ubicaciones:

- `src/security/roles.ts` (catálogo `Roles`/`PermissionGroup`, usado por
  `authorize()`) y `src/security/user.types.ts` (`AuthenticatedUser`, forma
  del JWT) — esto sí es auth genérica de verdad: infraestructura de
  autenticación pura, sin reglas de negocio del dominio. Usado por **26
  archivos** en TODOS los bounded contexts (cada `*.routes.ts` importa
  `Roles` para `authorize()`) — mover esto tiene alto radio de impacto en
  imports.
- `src/security/user.store.ts` — primitivas de hashing PBKDF2, tampoco es
  "gestión de usuarios", es criptografía genérica reusada por
  `identities` (BD de plataforma) y por `users.routes.ts` al crear un
  membership.
- **La lógica de negocio real de roles/usuarios ya vive AFUERA de
  `security/`**, pero dispersa en dos carpetas más: `src/services/
  role.service.ts` (CRUD de roles + auditoría) y `src/api/routes/
  roles.routes.ts` + `src/api/routes/users.routes.ts` (endpoints). Los
  datos en sí (`Role`, `Membership`, `Identity`) viven dentro del
  `PlatformRepository` gigante (`src/platform/platform.repository.ts`),
  sin repositorio propio.

**Recomendación** (para cuando se ejecute, no ahora): crear
`usuarios-roles/` (mismo patrón que `reservas/`, `pms-estadias/`,
`clientes-finanzas/`) y mover ahí `role.service.ts`, `roles.routes.ts`,
`users.routes.ts`, y extraer de `PlatformRepository` un
`RoleRepository`/`MembershipRepository` propio (mismo criterio que ya se
usó al separar `pos-menu/`/`clientes-finanzas/` de un repositorio
monolítico anterior). Dejar en `security/` solo lo genuinamente
transversal: `auth.middleware.ts`, `auth.service.ts` (JWT), `roles.ts`
(catálogo de grupos, no las asignaciones), `user.types.ts`,
`user.store.ts` (hashing), `google-oauth.ts`, `customer.auth.service.ts`.
Es un move de alto radio de impacto (26 imports de `roles.ts` solo) —
conviene hacerlo en su propia sesión dedicada, con `tsc`/tests como red
de seguridad en cada paso, no mezclado con otro trabajo.

### F2. Tres ejes de monetización separados (feature flags / límites de plan / edición fina de permisos)

Pedido: modelar la monetización como tres reglas de negocio separadas en
vez de una tabla monolítica de "planes". Estado actual de cada eje:

- **(a) Feature on/off — ya existe, sin cambios.** `ModuleKey`/
  `business_modules` (`platform.schema.sql`, bloque ENTITLEMENTS) +
  `PlatformRepository.getBusinessModules()`/`provisionDefaultModules()`.
  Fail-closed (un módulo sin fila = deshabilitado). Confirmado que se deja
  como está.
- **(b) Límite de asientos y roles por plan — hoy NO existe, hay que
  construirlo.** Existe `src/config/plan-limits.ts` (`PLAN_LIMITS`), pero
  solo cubre `maxCategories`/`maxResources` (usado por
  `CategoryService`/`ResourceService`, error `PlanLimitError` → 402
  `PLAN_LIMIT_REACHED`). No hay ningún límite de `memberships` activos ni
  de qué `role_permission_groups` puede tener un negocio según su plan —
  hoy cualquier plan puede crear memberships y roles sin tope. Extender
  este mismo mecanismo (mismo patrón `PlanLimitError`/402) con
  `maxActiveMemberships` y algo como `allowedPermissionGroups` por plan.
- **(c) Edición fina de permisos por rol como feature del plan — hoy NO
  existe.** `role.service.ts`/`roles.routes.ts` ya permiten editar
  `permissionGroups` de un rol (`PUT /api/roles/:id`) **sin ninguna
  restricción de plan** — cualquier negocio, sea cual sea su plan, ya
  puede editar los roles de fábrica hoy. Falta la regla: en el plan
  básico, los roles de sistema (`is_system = TRUE`, ver BLOQUE ROLES)
  quedan fijos con el preset de fábrica; un plan superior desbloquea poder
  editarlos. Point de enganche natural:
  `RoleService.update()`/`CannotModifySystemRoleError` ya existe para
  "no se puede desactivar un rol de sistema" — habría que sumar un
  chequeo de plan análogo antes de aceptar un cambio de
  `permissionGroups` sobre un rol `is_system`.

**No implementado todavía** — el dueño pidió que quede modelado como
diseño/backlog primero.

### F3. Origen de los defaults de fábrica (plataforma, no hardcode) + auditoría de hardcodes

**Hallazgo principal — exactamente el caso que sospechaba el dueño, y no
solo con `currency`:** los presets "de fábrica" de roles NO salen de
ninguna configuración de plataforma editable — están escritos dos veces,
literalmente como arrays en código/SQL, idénticos para cualquier negocio
sin importar su plan:

1. `PlatformRepository.provisionSystemRoles()`
   (`src/platform/platform.repository.ts:151-177`) — array `systemRoles`
   hardcodeado en TypeScript (OWNER/ADMIN/RECEPTIONIST/HOUSEKEEPING/WAITER
   + sus `permissionGroups`), corre en cada alta de negocio nueva.
2. El mismo catálogo, duplicado en SQL (`platform.schema.sql` BLOQUE
   ROLES, líneas 233-260) como backfill para negocios que ya existían
   antes de este bloque.

Dos problemas en uno: (i) están hardcodeados en vez de salir de una
config de plataforma que el superadmin pueda editar, y (ii) están
**duplicados en dos lugares** que hay que mantener manualmente
sincronizados (ya lo dice el comentario de la línea 224 del schema: "los
mismos permission_groups que hoy hardcodea security/roles.ts" — tres
copias del mismo dato, contando `security/roles.ts` como el catálogo de
grupos válidos).

**Auditoría general de hardcodes — barrido completo, nada tocado:**

| # | Qué | Dónde | Por qué es un hardcode de negocio, no técnico |
|---|---|---|---|
| 1 | Presets de roles de fábrica (OWNER/ADMIN/RECEPTIONIST/HOUSEKEEPING/WAITER + sus grupos de permisos) | `platform.repository.ts:151-177` (TS) + `platform.schema.sql:233-260` (SQL, duplicado) | Mismo preset para TODO negocio sin importar plan — el pedido explícito de F2c/F3 es que dependa del plan y salga de config de plataforma |
| 2 | ✅ RESUELTO (17/08/2026, tarde) — `currency VARCHAR(3) DEFAULT 'ARS'` | `schema.sql` — `financial_transactions`, `accounts_receivable`, `cash_register_shifts` | `business_profile` (tenant DB) ganó `currency`/`timezone` reales (schema v15); los 4 puntos de escritura que lo hardcodeaban (`AccountsReceivableService`, `CustomerAccountService`, `outbox.handlers.ts`, `CashRegisterService`) ahora lo leen de ahí. DEFAULT de columna queda como fallback, no como fuente real |
| 3 | ✅ RESUELTO (17/08/2026, tarde) — `Business.timezone` nunca modelado pese a A4.2 | Se agregó en `business_profile` (tenant DB), no en `businesses` (BD central) — el resto de esa tabla ya es identidad de ESE negocio, no hace falta que la plataforma central la conozca | Ver detalle en sección F3-bis más abajo |
| 4 | ✅ RESUELTO (17/08/2026, tarde) — zona horaria fija en mails | `src/email/templates.ts` | `email.handlers.ts` ahora pasa `profile.timezone` al template en vez de la constante fija. Locale `es-AR` sigue fijo a propósito (no se pidió resolver eso) |
| 5 | **Deliberadamente NO resuelto todavía** — huso Argentina hardcodeado en `combineDateAndTime()` | `src/reservas/reservation.service.ts:827-836` | Toca el camino crítico de disponibilidad/reservas ya verificado a fondo — convertir un IANA timezone a offset UTC para una fecha arbitraria (con DST-awareness) no es trivial y requiere tests propios. Se dejó fuera de esta ronda a propósito, ver F3-bis |
| 6 | `PLAN_LIMITS` (`maxCategories`/`maxResources` por plan) | `src/config/plan-limits.ts` | No es un hardcode "por tenant" (aplica igual a todos, correcto conceptualmente), pero SÍ es una constante de código que solo el superadmin debería poder tocar sin deploy — mismo argumento que roles: si F2b se construye como tabla en la BD de plataforma, este archivo debería migrar ahí también, no quedar como el único límite que sigue siendo código |
| 7 | Default de módulos habilitados al crear un negocio ("solo ALOJAMIENTO") | `PlatformRepository.provisionDefaultModules()` (`platform.repository.ts:186-206`) | Confirmado como correcto/deliberado por el dueño en F2a ("ya existe, sin cambios") — se incluye en la tabla solo para que quede registrado que también es un default fijo en código, no específicamente para cambiarlo |

**Sin hallazgos en:** validación de teléfono/CUIT (ya correctamente
modelado por-cliente vía `customer_tax_profiles`, no hardcodeado), tasas
de impuesto/IVA (no implementado todavía, nada que auditar), ventana de
cancelación/depósito/horario de check-in (no existen como constantes
fijas — `operating-hours` ya es 100% configurable por negocio).

**Nada de esto se tocó** — es el barrido pedido antes de decidir qué se
arregla y en qué orden.

### F3-bis. Implementado (17/08/2026, tarde) — `currency`/`timezone` en `business_profile`

Primer ítem del barrido resuelto, a pedido explícito del dueño ("arranca
con F3, currency + timezone en business_profile"). Alcance: fundación
completa (schema + entidad + repo + validación Zod) + wiring de los
consumidores de bajo riesgo. **NO** incluye `reservation.service.ts`
(ver abajo, deliberado).

- `business_profile` (tenant DB, schema v15) gana `currency VARCHAR(3)
  NOT NULL DEFAULT 'ARS'` y `timezone VARCHAR(64) NOT NULL DEFAULT
  'America/Argentina/Buenos_Aires'` — mismos valores que estaban
  hardcodeados, así que ningún negocio existente cambia de comportamiento
  hasta que alguien edite el perfil a propósito.
- `PUT /api/business-profile` acepta ambos campos — `currency` valida
  formato ISO 4217 (3 letras); `timezone` valida contra
  `Intl.supportedValuesOf('timeZone')` (Node 20 ya lo trae, no hace falta
  librería nueva ni una lista propia que mantener).
- Wireado a los 4 puntos que hardcodeaban `currency: 'ARS'`:
  `AccountsReceivableService`, `CustomerAccountService`,
  `outbox.handlers.ts` (`handleReservationConfirmed`/`handleOrderConfirmed`),
  y `CashRegisterService.openShift()` (este último ni siquiera lo
  seteaba — dependía 100% del DEFAULT de columna). Los cuatro ahora leen
  `businessProfileRepo.get().currency` en vez de un literal.
- `email/templates.ts` + `email.handlers.ts`: el mail de reserva
  confirmada ahora formatea fechas con `profile.timezone` en vez de
  `America/Argentina/Buenos_Aires` fijo. Locale `es-AR` queda fijo a
  propósito (no se pidió resolver idioma, solo huso).

**Deliberadamente fuera de esta ronda:** `reservation.service.ts` →
`combineDateAndTime()` sigue con `-03:00` hardcodeado al combinar fecha +
hora de un turno. Es el camino crítico de disponibilidad/reservas, ya
verificado a fondo en sesiones anteriores — convertir un nombre IANA a un
offset UTC correcto para una fecha arbitraria (con DST-awareness, ver
A4.7) necesita su propio diseño y batería de tests, no es un cambio de
una línea. Queda anotado para una sesión propia, no se tocó.

**Verificado contra Postgres real** (proyecto Neon `DB-APP-PPMS`, branch
temporal `verify-schema-v15-currency-timezone`, borrado después): la fila
`'default'` ya existente se backfillea con los defaults correctos al
aplicar el ALTER TABLE, re-aplicar el schema es idempotente, `UPDATE`
con valores nuevos funciona, e `INSERT` explícito de `cash_register_shifts`
con `currency` distinto al DEFAULT de columna inserta correctamente.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 530/531 (+4 tests nuevos que verifican explícitamente que la
moneda sale de `business_profile` y no de un literal), `npm run build`
limpio.

---

## G. Referencias externas agregadas hoy (17/08/2026, tarde) — documentación, sin tocar código

- ✅ `docs/referencia-qloapps.md` — análisis de QloApps (motor de reservas
  hotelero open-source, PrestaShop/PHP) como referencia de producto, no de
  código (licencia OSL v3, stack distinto). Tres hallazgos enlazados desde
  `roadmap-pms-multirubro.md`: Channel Manager vía agregador
  (myallocator) en vez de integraciones directas por OTA; checklist de
  features de un booking engine público para cuando se diseñe el Portal
  de clientes; patrón de PDF de comprobante con marca propia (TCPDF en
  QloApps) separado de la validación fiscal, para cuando ande
  TusFacturas.app.
- ✅ `docs/referencia-afip-wsfev1.md` — transcripción completa del manual
  oficial de AFIP para WSFEv1 (`manual_desarrollador_COMPG_v2_10.pdf`,
  Facturación Electrónica RG 2485 – Proyecto FE v2.10, revisión 09/08/2017,
  131 páginas), 1419 líneas: los 21 métodos (autorización CAE/CAEA,
  consultas, catálogos de tipos de comprobante/IVA/moneda/tributo/
  documento/país con sus códigos completos), distinción CAE (online,
  camino típico para POS) vs. CAEA (offline por lote), tablas de
  validación/error de los dos métodos grandes (`FECAESolicitar`/
  `FECAEARegInformativo`, ~250 códigos entre los dos). Revisado — buena
  cobertura, dos anexos históricos (crosswalk de códigos v1→v1.1 de 2011,
  notas de comprobante tipo C) quedaron resumidos en vez de transcritos
  línea por línea porque su contenido sustantivo ya está cubierto en las
  tablas de validación de cada método; el propio documento lo señala
  explícito con número de página del PDF original para reconstruir si
  hace falta. Enlazado desde `roadmap-pms-multirubro.md`, sección
  "Factura Electrónica A/B/T (AFIP)". El plan sigue siendo usar el SDK
  `arcasdk-main` (Node/TS) como vehículo de implementación, no un cliente
  SOAP propio.
