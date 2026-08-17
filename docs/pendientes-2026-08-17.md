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
Compras/Proveedores, Empresas multipropiedad, COGS teórico-vs-real.

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
  el catálogo de motivos de merma y para registrar una merma (ver B), y
  para marcar un producto COMPOSITE, armar su receta y registrar una
  Producción (ver C).
- E1-E7 de `pendientes-2026-08-13.md` — necesitan que el dueño defina
  alcance (salvo E7c/d/e, ya resueltos).
- Empresas multipropiedad + `businesses.company_id`/BD central de
  "empresa" — caso de uso concreto (`pendientes-2026-08-15.md` sección B6,
  `pendientes-2026-08-16.md` sección C), sin diseñar en detalle todavía.
