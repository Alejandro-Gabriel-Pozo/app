# Pendientes — Domingo 16 de Agosto 2026

Arranca a partir de lo que quedó abierto en `pendientes-2026-08-15.md`.
Mismo criterio de agrupación: deuda estructural primero, seguridad
después, calidad de código, backlog, observaciones sin implementar.
Marcar `✅ RESUELTO` in-place al cerrar un ítem.

---

## A. Resuelto hoy (16/08), deuda estructural

- ✅ **`businesses.schema_version` desincronizado en la PLATFORM DB** —
  confirmado real contra producción (proyecto Neon `pdb-ppms`, no
  `DB-APP-PPMS`) y corregido. Detalle completo en `pendientes-2026-08-15.md`
  sección G (donde vivía el hallazgo original, marcado ✅ ahí mismo).
- ✅ **A8.7 completo** — TTL/límite de reintentos que libera sola una
  reserva de stock colgada si `order.confirmed` cae en dead-letter.
  `OutboxWorker.onDeadLetter()` (hook nuevo) + `handleOrderConfirmedDeadLetterRelease`
  (`workers/inventory.handlers.ts`), reusa el mecanismo insert-then-act
  existente. +9 tests. Detalle completo en `criterios-negocio.md` A8.7 y
  `pendientes-2026-08-15.md` D1/F (marcado ✅ ahí mismo).
- ✅ **Manual de reglas de negocio de inventario persistido** —
  `docs/manual-inventario.md` (nuevo). Se había pegado en el chat el
  15/08 sin guardar (`pendientes-2026-08-15.md` D2 lo dejaba como
  pendiente "pedir que lo repita si se retoma"). Cierra ese gap.

## B. Carve-out de `inventario/` — Fase 1 hecha y verificada (16/08/2026)

Retomado el paso 5 de `arquitectura-monolito-modular.md` sección 4
(único paso de la reorganización de `src/` que seguía sin ejecutar).
Confirmado con el dueño que los tres disparadores de D2
(`pendientes-2026-08-15.md`) están encima, no son hipotéticos: multi-
ubicación con transferencias, recetas/BOM multinivel, mermas como tipo
propio. Diseño completo consolidado en **`docs/diseno-inventario-carve-out.md`**
(nuevo) — no repetido acá, incluye:

- Fase 1 (multi-ubicación intra-tenant: `inventory_levels`,
  `orders.location_id`, `TRANSFER` como par atómico).
- Fase 2 (mermas: `WASTE` + catálogo de motivos **propio por negocio**,
  no hardcodeado — decisión explícita del dueño, ver regla de trabajo
  técnico-vs-organizacional en memoria).
- Fase 3 (recetas/BOM multinivel + el concepto de **Producción** vs.
  **armado al momento** — un producto con receta puede necesitar
  producirse por adelantado en lote, como pan congelado, o armarse en
  vivo al vender, como un sándwich; `assemble_on_demand` por producto +
  `PRODUCTION` como movement_type nuevo).
- Compras/Proveedores y "empresa + catálogo compartido entre sucursales-
  tenant" quedan fuera, cada uno su propia conversación futura.

**✅ Fase 1 (multi-ubicación intra-tenant) hecha y verificada — detalle
completo en `docs/diseno-inventario-carve-out.md`.** Backend únicamente
(`app-main`): `inventory_levels` nueva (schema v11), `orders.location_id`,
`stock_movements` con `TRANSFER`, `ProductService`/`inventory.handlers.ts`
reescritos, endpoint `POST /api/products/stock/transfer`. Verificado
contra Postgres real (branch temporal de Neon, borrado después) — CHECKs,
reserva/consolidación/liberación y transferencia probados con datos
reales, no solo con fakes en memoria. `tsc`/lint/tests (442/443)/build
limpios. Revisado con la skill `revision-pr-pms-erp` antes de commitear.

**✅ RESUELTO (17/08/2026) — hallazgo de la revisión aplicado.**
`POST /api/products/stock/transfer` ahora valida, cuando se pasa
`productId`, que ese producto exista (404 si no) y tenga
`hasVariants=false` (400 `PRODUCT_HAS_VARIANTS` si no) — mismo chequeo que
ya existía en `ProductService.createVariant()`. Archivo:
`src/pos-menu/products.routes.ts`, endpoint de transferencia. `tsc`/lint/
tests (442/443) limpios tras el cambio.

**✅ RESUELTO (17/08/2026) — revisión de diff completada.** Los archivos
que habían quedado sin revisar (`product.repository.ts`,
`sql.product.repository.ts`, `product.entities.ts`,
`inventory-level.repository.ts`, `sql.inventory-level.repository.ts`,
`in-memory.inventory-level.repository.ts`) están limpios: `getById` nunca
filtra por `active` (R2), patrón insert-then-act atómico en todo
reserve/commit/release/decrement/transfer (A8.2). La falta de filtro
`business_id` en los `UPDATE` de `InventoryLevelRepository` no es un gap
nuevo — mismo patrón que `sql.stock-movement.repository.ts` ya tenía
(A2.8: aislamiento real por pool de conexión por tenant, no por columna).

**Fase 1 del carve-out de inventario: completamente cerrada.**

**✅ RESUELTO (17/08/2026) — Fase 2 (mermas) implementada y verificada.**
Detalle completo en `pendientes-2026-08-17.md`.

**Fase 3 (recetas/BOM + Producción) sigue sin implementar** — diseño
acordado, no ejecutado.

## C. Empresas multipropiedad + catálogo compartido entre sucursales — nuevo, deliberadamente separado (16/08/2026)

Durante el diseño de B surgió un caso de uso concreto que **no** es
multi-ubicación intra-tenant: sucursales que HOY son tenants separados
(ej. 5 spa, cada uno su propia base Neon) necesitan compartir identidad
de maestros (mismo producto = mismo ID/nombre en las 5 bases, mismo
proveedor = mismo ID/nombre) sin compartir NUNCA stock/reservas/pedidos.
Retoma y concreta la idea de "empresas multipropiedad" que
`pendientes-2026-08-15.md` sección B6 había dejado sin diseñar. Detalle
completo, incluida la decisión de mantenerlo separado del carve-out de
inventario, agregado en esa misma sección de `pendientes-2026-08-15.md`
(no duplicado acá). **Sin diseñar en detalle — próxima conversación
dedicada.**

---

## D. Heredado de `pendientes-2026-08-15.md`, sigue abierto

Sin cambios desde ayer — ver el archivo del 15/08 para el detalle
completo de cada uno:

- `POST /api/auth/refresh` para staff — ✅ ya estaba resuelto (sección H
  del 15/08); la nota que lo listaba como pendiente en la sección D de
  ese archivo era un error de esa sesión, ya corregido ahí.
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
  (`POST /:id/serve` ya existe en backend).
- E1-E7 de `pendientes-2026-08-13.md` — necesitan que el dueño defina
  alcance (salvo E7c/d/e, ya resueltos).
- `businesses.company_id`/BD central de "empresa" — ver sección C de
  hoy, ahora con caso de uso concreto pero sin diseñar.
