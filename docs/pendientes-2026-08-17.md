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
- Empresas multipropiedad: sincronización de RECETA compartida (el
  precio ya está resuelto, ver sección E) — pendiente resolver primero el
  encadenamiento de componentes compartidos.
