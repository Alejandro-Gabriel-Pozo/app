# Diseño — carve-out de `inventario/` como agregado propio

**Estado: Fases 1, 2 y 3 completamente cerradas (17/08/2026)** —
implementadas y verificadas contra Postgres real. El carve-out de
inventario está completo según este diseño (Compras/Proveedores y
Empresas multipropiedad quedan fuera, ver sección al final). Ver
`pendientes-2026-08-16.md` sección B y `pendientes-2026-08-17.md` para el
resumen de cada fase, y `docs/manual-inventario.md` para el marco
conceptual que lo sustenta.

Cierra el paso 5 de `docs/arquitectura-monolito-modular.md` sección 4
(único paso de la reorganización de `src/` por dominio que seguía sin
ejecutar — era diseño nuevo, no un simple `git mv`).

Regla de trabajo aplicada en todo este diseño (ver memoria
`feedback_technical_vs_organizational_decisions`): lo técnico (cómo se
garantiza atomicidad, aislamiento, idempotencia) lo decide la
ingeniería; lo organizacional (motivos de merma, quién aprueba una
transferencia, qué se comparte entre sucursales) lo define cada negocio,
nunca un default hardcodeado en el código.

---

## Fase 1 — multi-ubicación intra-tenant — ✅ HECHA Y VERIFICADA (16/08/2026)

Confirmado real y separado de "sucursales como tenants" (ver sección
"Deliberadamente fuera de este diseño" más abajo) — un mismo negocio
puede tener cocina/barra/depósito propios, con transferencias entre
ellos.

**Implementado:**
- `inventory_levels` (nueva, schema v11) + backfill desde `products`/
  `product_variants` + drop de las columnas viejas, todo en la misma
  migración (`schema.sql` BLOQUE 3/16).
- `orders.location_id` (mismo patrón que `resources.location_id`).
- `stock_movements` gana `location_id`/`from_location_id`/`to_location_id`
  + `TRANSFER` como par atómico (un solo movimiento, no dos).
- `InventoryLevelRepository` nueva (interfaz + SQL + in-memory) —
  `src/repositories/inventory-level.repository.ts`. Patrón "ensure row en
  0/0 + UPDATE atómica condicionada" para reserve/commit/release/
  increment/decrement/transfer — nunca lectura-y-decisión en memoria (A8.2).
- `ProductService` reescrito: `stockQuantity`/`reservedQuantity` salieron
  de `Product`/`ProductVariant` — todo método de stock recibe `locationId`
  explícito. `createProduct`/`createVariant` siembran el nivel inicial.
- `OrderService.confirmOrder()`/`cancelOrder()` propagan `order.locationId`
  al payload de `order.confirmed`/`order.cancelled`; `inventory.handlers.ts`
  lo lee de ahí (con fallback a `loc-default` para eventos encolados antes
  del deploy, sin `locationId` en su payload viejo).
- `POST /api/products/stock/transfer` (`Roles.MANAGEMENT`, sin flujo de
  aprobación propio — ver nota de decisión técnica-vs-organizacional).
  Idempotente vía `movementId` opcional (mismo mecanismo insert-then-act
  que el resto de `stock_movements`).
- `GET/POST /api/products` (y variantes) enriquecen la respuesta con
  `stockQuantity`/`reservedQuantity`/`stockMinAlert` calculados contra
  `inventory_levels` en la ubicación resuelta — mismo contrato JSON que
  antes, para no romper el frontend actual sin selector de ubicación.

**Verificado contra Postgres real** (proyecto Neon `DB-APP-PPMS`, branch
temporal `verify-schema-v11-inventory-levels` ramificado de `production`,
borrado después de usarlo): tabla `inventory_levels` creada, backfill real
con un producto de prueba (confirma que copia `stock_quantity`/
`reserved_quantity`/`stock_min_alert` correctamente y sale del camino sin
romper en un re-run tras dropear las columnas), `CHECK
reserved_quantity <= stock_quantity` rechaza un intento directo de
romperlo, reserva/consolidación con UPDATE condicionada confirmadas (reservar
de más devuelve 0 filas), transferencia completa entre dos ubicaciones
(origen baja disponible, destino sube), `CHECK chk_stock_movements_location`
rechaza un `OUT` con `from_location_id` seteado y un `TRANSFER` con
origen=destino, y el `movementId` repetido en un `TRANSFER` confirma
idempotencia (0 filas en el reintento).

**Backend únicamente** — sin selector de ubicación en `appfrontend-main`
todavía (fuera de alcance de esta fase, ver `pendientes-2026-08-16.md`).
Todo sigue funcionando igual que antes para un negocio de una sola
ubicación: `resolveDefaultLocationId()` cae a la primera activa
(`loc-default`) si nadie especifica una.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 442/443 (mismo resultado que antes de empezar — ningún test
preexistente cambió de comportamiento salvo los reescritos a propósito
para reflejar el modelo nuevo), `npm run build` limpio.

### `inventory_levels` (tabla nueva)

Reemplaza `products.stock_quantity`/`reserved_quantity` y
`product_variants.stock_quantity`/`reserved_quantity` como fuente de
verdad — el stock deja de ser una columna del producto y pasa a ser
"cuánto hay de este producto/variante, en esta ubicación":

```
(product_id | product_variant_id, location_id) → stock_quantity, reserved_quantity
```

- Mismo patrón polimórfico que `stock_movements` (uno de los dos FK,
  nunca los dos).
- Mismo `CHECK (reserved_quantity <= stock_quantity)` que ya existe hoy
  en `products`/`product_variants`.
- Migración: backfill una fila por producto/variante existente en
  `loc-default` con los valores actuales, después la app pasa a leer/
  escribir `inventory_levels`, recién ahí (paso separado, verificado
  aparte) se dropean las columnas viejas de `products`/`product_variants`.

### `orders.location_id`

De qué depósito/sucursal sale la venta. Mismo patrón que
`resources.location_id` (nullable + backfill a `loc-default`, no rompe
órdenes viejas).

### `stock_movements`

- Gana `location_id`.
- **`TRANSFER`** (tipo nuevo) — modelado como **un solo movimiento** con
  `from_location_id`/`to_location_id`, no dos filas independientes.
  Manual sección 8: "es un par simétrico que debería registrarse como
  una sola operación atómica, no como dos movimientos independientes
  que podrían quedar inconsistentes si uno falla."
- **Sin aprobación especial en el código** — el endpoint de transferencia
  se gatea con el sistema de roles que ya existe (`authorize()`), igual
  que cualquier otra escritura. Cada negocio decide quién puede
  transferir asignando roles — no se construye un flujo de aprobación
  propio (regla de trabajo de arriba).

### Reescritura de servicios

`ProductService.reserveStock/commitReservedStock/releaseReservedStock` e
`workers/inventory.handlers.ts` pasan a operar sobre `inventory_levels`
(con `locationId` como parámetro nuevo) en vez de columnas de `products`.
Es la parte de mayor riesgo — toca `confirmOrder()` directo, el mismo
camino crítico donde se cerró la carrera de stock el 15/08 (A8.7/A8.8).

---

## Fase 2 — mermas — ✅ HECHA Y VERIFICADA (17/08/2026)

- **`WASTE`** como `movement_type` propio (no una categoría de
  `ADJUSTMENT`).
- **Motivo de merma: catálogo propio por negocio**, no un `CHECK` fijo
  en el código. Confirmado explícitamente el 16/08/2026 — el manual daba
  `expired`/`waste_prep`/`count_adjustment` como ejemplos típicos, no
  como lista cerrada; imponerla en código sería exactamente el tipo de
  decisión organizacional que no nos toca fijar. Mismo patrón que
  `resource_categories`: tabla nueva `waste_reasons` (`business_id`,
  `name`, `active`), cada negocio arma la suya. `stock_movements.
  waste_reason_id` (FK, requerido cuando `movement_type = 'WASTE'`,
  mismo criterio que `chk_adjustment_requires_notes` hoy).

**Implementado:**
- `waste_reasons` nueva (schema v12, BLOQUE 17) — MAESTRO por negocio,
  mismo patrón que `products` (con `business_id`, sin `deleted_at`: ese
  gap de R3 solo se cerró en las 3 tablas del incidente del 13/08/2026,
  no es mandato para todo maestro nuevo). R1/R6 (código de negocio,
  unicidad normalizada) siguen sin implementar en NINGÚN maestro del
  proyecto — backlog "esta semana" de `criterios-datos.md`, no se resuelve
  en soledad acá.
- `stock_movements` gana `movement_type = 'WASTE'` + `waste_reason_id`
  (FK `ON DELETE RESTRICT`) + `chk_waste_requires_reason`.
- `WasteReasonRepository`/`SqlWasteReasonRepository`/
  `InMemoryWasteReasonRepository` (`src/repositories/`) + `WasteReasonService`
  (`src/pos-menu/waste-reason.service.ts`, CRUD + auditoría R8/A9.4, mismo
  patrón que `CategoryService`, sin límites de plan).
- `InventoryLevelRepository.decrementAvailableStock()` (método nuevo) —
  decrementa stock físico condicionado a lo DISPONIBLE (stock - reservado),
  no solo a `stock_quantity` como `decrementStock()` — mismo criterio que
  ya usaba `transferStock()` para no dar de baja stock comprometido con una
  orden confirmada.
- `GET/POST/PUT/DELETE /api/waste-reasons` (`Roles.MANAGEMENT`, gateado
  por `ModuleKey.POS_RESTAURANTE` igual que `/api/products`).
- `POST /api/products/stock/waste` (`Roles.MANAGEMENT`, sin flujo de
  aprobación propio — misma decisión técnica-vs-organizacional que
  `/stock/transfer`). Idempotente vía `movementId` opcional (A8.5). Valida
  `hasVariants=false` cuando viene `productId` (mismo chequeo agregado a
  `/stock/transfer` el 17/08/2026) y que el `wasteReasonId` exista y esté
  activo.
- De paso, `INSUFFICIENT_STOCK` (ya existía en `product.service.ts`) suma
  case en `error.middleware.ts` (400) — no tenía mapeo y caía al 500
  genérico salvo que el router la capturara localmente; cierra el mismo
  hueco latente en `/:id/stock/decrement`.

**Verificado contra Postgres real** (proyecto Neon `DB-APP-PPMS`, branch
temporal `verify-schema-v12-waste-reasons` ramificado de `production`,
borrado después de usarlo): tabla `waste_reasons` creada, `WASTE` sin
`waste_reason_id` rechazado por `chk_waste_requires_reason`, `WASTE` con
motivo válido insertado, `WASTE` con motivo inexistente rechazado por FK,
`ADJUSTMENT` sigue exigiendo `notes` (constraint vieja intacta),
desactivar un motivo en uso no rompe la FK (soft-delete), y el UPDATE
atómico de `decrementAvailableStock()` probado con datos reales: pedir más
que lo disponible (stock=10, reservado=3 → disponible=7) afecta 0 filas,
pedir exactamente lo disponible sí se aplica.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 453/454 (+11 tests nuevos: `WasteReasonService` y
`decrementAvailableStock()`), `npm run build` limpio.

**Backend únicamente** — sin UI en `appfrontend-main` todavía (catálogo de
motivos ni pantalla para registrar una merma).

---

## Fase 3 — recetas/BOM (multinivel + Producción) — ✅ HECHA Y VERIFICADA (17/08/2026)

**Implementado** (backend únicamente, `app-main`), sobre el diseño de abajo
tal cual estaba acordado, con tres decisiones técnicas que el diseño
original no dejaba pinneadas y se resolvieron al implementar (lo técnico
es decisión de ingeniería, ver regla de trabajo arriba):

- `products.product_type`/`assemble_on_demand` (schema v13, con
  `chk_products_assemble_on_demand`: `assemble_on_demand=true` exige
  `product_type='COMPOSITE'` a nivel BD, no solo en el service).
- `recipe_items` nueva (BLOQUE 18) — `RecipeItemRepository`/
  `SqlRecipeItemRepository`/`InMemoryRecipeItemRepository` +
  `RecipeService` (`src/pos-menu/recipe.service.ts`): CRUD + prevención de
  ciclos vía CTE recursiva (`wouldCreateCycle`) + explosión recursiva
  (`explodeRecipe`/`explodeRecipeForProduction`).
- **Decisión técnica 1 — dos entry points de explosión, no uno.** El
  diseño original no distinguía "explotar para vender" de "explotar para
  producir". `explodeRecipe()` (venta/armado en vivo) mira el
  `assemble_on_demand` del propio producto antes de explotar;
  `explodeRecipeForProduction()` (Producción manual) explota siempre que
  sea `COMPOSITE`, sin mirar su propio flag — producir por adelantado ES
  exactamente lo que `assemble_on_demand=false` pide, y nada impide
  producir en lote algo normalmente `assemble_on_demand=true` también.
  Los componentes de adentro siguen la MISMA regla de recursión en los dos
  casos (para en un componente `COMPOSITE` con `assemble_on_demand=false`,
  sigue de largo en uno con `true`).
- **Decisión técnica 2 — `order_items.stock_snapshot` (columna nueva, no
  prevista en el diseño original).** Necesaria porque `cancelOrder()` es
  una llamada separada, potencialmente mucho después de `confirmOrder()`
  — si volviera a explotar la receta ACTUAL en vez de leer qué se reservó
  de verdad al confirmar, liberaría/restauraría componentes distintos a
  los reservados si la receta cambió en el medio (silenciosamente
  inconsistente). Se persiste el resultado de la explosión en la misma
  transacción que reserva, `cancelOrder()` nunca vuelve a consultar
  `recipe_items`.
- **Decisión técnica 3 — índices únicos de idempotencia ampliados
  (schema v13).** `ux_stock_movements_order_item_type`/`_resolution`
  (BLOQUE 13/D1) asumían 1:1 order_item↔movimiento; un ítem compuesto
  ahora puede generar VARIOS componentes bajo el mismo `order_item_id`.
  Ampliados a incluir producto/variante, partidos en DOS índices parciales
  cada uno (no uno combinado — ver hallazgo de `patrones-recurrentes.md`
  17/08/2026: Postgres no bloquea duplicados si se combina una columna
  polimórfica NULL con otras en un solo índice). `hasMovement()` gana los
  mismos parámetros para desambiguar por componente en
  `handleOrderCancelledStock`.
- `OrderService.confirmOrder()`/`cancelOrder()` integran la explosión
  (`resolveConfirmStockItems`/`expandStockItemsFromSnapshot`) — un ítem
  simple (la enorme mayoría) sigue exactamente igual que antes, cero
  cambio de comportamiento.
- `POST /api/products/stock/production` — mismo mecanismo insert-then-act
  que transfer/waste (`movementId` opcional), decrementa cada componente
  contra lo DISPONIBLE (`decrementAvailableStock`, reusado de Fase 2) e
  incrementa el producto producido, todo atómico. Registra UNA fila en
  `stock_movements` (el producto producido) — el consumo de cada
  componente se aplica directo a `inventory_levels` sin fila propia,
  mismo criterio que `cost_per_unit`/`yield_percentage`: la auditoría
  fila-por-componente es parte de COGS teórico-vs-real, pospuesto.
- `GET/POST/PUT/DELETE /api/products/:id/recipe-items` — CRUD del BOM,
  `MANAGEMENT`.

**Verificado contra Postgres real** (proyecto Neon `DB-APP-PPMS`, tres
branches temporales sucesivos, borrados después): CHECKs (`assemble_on_
demand` sin `COMPOSITE`, auto-referencia, unicidad de componente)
rechazados correctamente; el índice único combinado ORIGINAL no bloqueaba
duplicados (bug real encontrado y corregido, ver arriba); tras la
corrección, un duplicado directo SÍ se rechaza; simulación completa de un
pedido con un producto compuesto de dos componentes (sándwich = jamón +
queso) — reserva, consolidación con dos filas `OUT` independientes bajo el
mismo `order_item_id`, reintento idempotente sin duplicar ningún
componente, y cancelación que restaura exactamente lo reservado leyendo
`stock_snapshot` — probado end-to-end con datos reales, vuelve al estado
inicial exacto.

**Verificado (backend):** `tsc --noEmit` limpio, `npm run lint` limpio,
`npm test` 481/482 (+27 tests nuevos: `RecipeService` completo, integración
de explosión en `OrderService`, escenario multi-componente en
`inventory.handlers`), `npm run build` limpio. Revisión propia estilo
`revision-pr-pms-erp` — un hallazgo real (índice combinado) encontrado y
corregido antes de cerrar, logueado en `patrones-recurrentes.md`.

**Backend únicamente** — sin UI en `appfrontend-main` todavía (marcar
producto como COMPOSITE, armar receta, ni pantalla de Producción).

### Clasificación de producto

`products.product_type`: `RAW_MATERIAL` / `COMPOSITE` / `RETAIL`
(default `RETAIL` — el comportamiento de hoy).

### `recipe_items` (tabla nueva)

BOM multinivel confirmado — un componente puede ser otro `COMPOSITE`
(ej. "salsa base" es a la vez receta propia e ingrediente de "pizza").

```
recipe_items:
  parent_product_id      → products (debe ser product_type = COMPOSITE)
  component_product_id   → products        (uno de los dos, polimórfico)
  component_variant_id   → product_variants
  quantity_per_unit      DECIMAL
  cost_per_unit           DECIMAL NULL  -- capturado desde el día 1
  yield_percentage        DECIMAL NULL  -- capturado desde el día 1
```

`cost_per_unit`/`yield_percentage` se guardan desde el día uno aunque el
cálculo de COGS teórico-vs-real siga pospuesto — condición que el dueño
ya había puesto el 15/08 (`pendientes-2026-08-15.md` D2) para no tener
que remodelar la tabla cuando se retome esa métrica.

**Prevención de ciclos, obligatoria dado que es multinivel:** al
insertar/actualizar un `recipe_item`, validar con una CTE recursiva que
`component_product_id` no incluya (directa ni transitivamente) a
`parent_product_id` — si no, una receta puede terminar refiriéndose a sí
misma y la explosión recursiva entra en loop infinito.

**Unidad de medida (kg comprado vs. gramos consumidos): fuera de esta
fase.** Solo importa de verdad cuando entre Compras/Proveedores
(convertir lo que llega del proveedor a la unidad de consumo de la
receta) — esa fase está deliberadamente diferida (ver abajo). Por ahora
`quantity_per_unit` asume que ya está en la unidad de consumo.

### El concepto central: Producción vs. armado al momento

Confirmado el 16/08/2026 con un ejemplo real (pan congelado vs. sándwich
armado en el momento) — no es "un COMPOSITE tiene stock propio SÍ/NO",
es que un producto con receta puede jugar **dos roles distintos según el
momento**:

- **Producción** — evento propio, desacoplado de cualquier venta: se
  explota la receta AHORA (se consumen los componentes) y el resultado
  pasa a ser stock propio del producto producido. Ej.: hacer pan y
  congelarlo, en lote, antes de que llegue ningún pedido.
- **Armado al momento (`assemble_on_demand`)** — la receta se explota EN
  el momento de confirmar la orden, consumiendo directo los componentes
  (que pueden incluir productos que a su vez vinieron de una Producción
  previa, como el pan ya congelado). No pasa por el stock propio del
  producto armado — no necesita tenerlo.

Un mismo producto con receta puede necesitar Producción previa (el pan:
`assemble_on_demand = false` — no se puede hornear en el tiempo de un
servicio normal; si no hay stock producido de antemano, la venta falla
por falta de stock, sin intentar explotar la receta en vivo) o puede
armarse siempre al momento (el sándwich: `assemble_on_demand = true`).

**Modelo:**
- `products.assemble_on_demand` (boolean, solo aplica a `COMPOSITE`).
- **`assemble_on_demand = false`** → en `confirmOrder()`, el producto se
  trata EXACTAMENTE igual que un `RETAIL`/`RAW_MATERIAL` hoy: reserva/
  consolida contra su propia fila de `inventory_levels`. Cero cambios en
  `handleOrderConfirmedStock` para este caso — la única diferencia es
  CÓMO llegó ese stock ahí (por `PRODUCTION`, no por `IN` de compra).
- **`assemble_on_demand = true`** → `confirmOrder()`/`handleOrderConfirmedStock`
  explota la receta recursivamente, reservando/consolidando contra los
  componentes en vez del producto vendido.
- **`PRODUCTION`** (tipo de movimiento nuevo, además de
  `IN`/`OUT`/`ADJUSTMENT`/`RETURN`/`RESERVATION_RELEASED`/`WASTE`/
  `TRANSFER`) — evento manual/operativo: "producir N unidades de
  producto X", explota su receta una vez para N unidades, decrementa
  `inventory_levels` de cada componente e incrementa `inventory_levels`
  del producto producido, todo en una sola transacción atómica (mismo
  criterio de siempre: nunca dos escrituras independientes que puedan
  quedar a mitad de camino).

---

## Deliberadamente fuera de este diseño

- **Compras/Proveedores** (órdenes de compra, recepción que genera el
  movimiento `IN`) — fase separada, confirmado el 16/08/2026. Incluye
  la conversión de unidad de medida (kg comprado → g consumido).
- **Empresas multipropiedad + catálogo compartido entre sucursales-tenant**
  (mismo producto/proveedor con el mismo ID en varias bases Neon) —
  conversación de diseño propia, separada de esta. Detalle del caso de
  uso concreto en `pendientes-2026-08-15.md` sección B6.
- **COGS teórico vs. real** (el cálculo en sí, no la captura de datos) —
  pospuesto, ver nota de `cost_per_unit`/`yield_percentage` arriba.

---

## Orden de implementación

1. Fase 1 (multi-ubicación) — la de mayor riesgo, aislada primero.
2. Fase 2 (mermas) — chica, una vez que `location_id` existe en todos
   lados.
3. Fase 3 (recetas/BOM + Producción) — la lógica más compleja
   (recursión, prevención de ciclos), sobre una base de ubicaciones ya
   estable.

Fases 1, 2 y 3 hechas y verificadas (16 y 17/08/2026). Carve-out de
inventario completo según este diseño — quedan fuera, cada una su propia
conversación futura: Compras/Proveedores, Empresas multipropiedad, y COGS
teórico-vs-real (ver sección de arriba).
