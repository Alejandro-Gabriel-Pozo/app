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

**❌ Hallazgo de la revisión, sin aplicar todavía** — `POST /api/products/stock/transfer`
no valida que, cuando se pasa `productId` (en vez de `productVariantId`),
ese producto tenga `hasVariants=false`. Si alguien transfiere stock de un
producto que en realidad maneja stock por variante, se crea una fila de
`inventory_levels` a nivel producto que ninguna venta real toca — el
stock queda invisible ahí, nunca se vende ni se cuenta bien. Fix acotado:
mismo chequeo que ya existe en `ProductService.createVariant()` (buscar
el producto, rechazar si `hasVariants !== false` cuando viene `productId`).
Archivo: `src/pos-menu/products.routes.ts`, endpoint de transferencia.
Decisión del dueño (16/08/2026): commitear igual, resolver después.

**⚠️ Revisión de diff incompleta** — la skill `revision-pr-pms-erp` cubrió
`schema.sql`, `product.service.ts`, `inventory.handlers.ts`,
`products.routes.ts` (incl. transferencia), `order.service.ts`/
`orders.routes.ts`/`order.entities.ts`/`sql.order.repository.ts`,
`location.repository.ts`, `stock-movement.repository.ts`. **Sin revisar
todavía:** `product.repository.ts`/`sql.product.repository.ts` (remoción
de métodos de stock), `product.entities.ts`, y los 3 archivos nuevos de
`InventoryLevelRepository` (`inventory-level.repository.ts`,
`sql.inventory-level.repository.ts`, `in-memory.inventory-level.repository.ts`)
— cortada por límite de uso de la sesión, no por decisión de saltarla.

**Fases 2 (mermas) y 3 (recetas/BOM + Producción) siguen sin implementar**
— diseño acordado, no ejecutado.

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
