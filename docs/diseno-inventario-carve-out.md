# Diseño — carve-out de `inventario/` como agregado propio

**Estado: Fase 1 implementada y verificada (16/08/2026).** Fases 2/3
siguen en diseño, sin implementar. Ver `pendientes-2026-08-16.md` sección B
para el resumen y `docs/manual-inventario.md` para el marco conceptual que
lo sustenta.

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

## Fase 2 — mermas

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

---

## Fase 3 — recetas/BOM (multinivel + Producción)

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

Sin arrancar implementación todavía — a la espera de confirmación para
empezar por la Fase 1.
