# M07 · Productos e inventario

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

> Es el módulo con más endpoints del sistema (30) y el que **mejor resuelve el
> motivo obligatorio y la atribución** — dos cosas que a los módulos de dinero
> les faltan. El patrón ya está inventado acá adentro.

## 1. Flujo auditado

producto → stock por ubicación → movimiento → reserva/consumo → ajuste →
inventario físico → compra

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "catálogo y receta":** ✅ Completo
- **Flujo "movimiento de stock":** ✅ Completo en el backend, ◇ Parcial en el
  producto (tres endpoints sin pantalla)
- **Flujo "reponer stock":** ◌ No existe — no hay compras

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** el ajuste con motivo. El schema **obliga** a que un
  `ADJUSTMENT` traiga notas: `CHECK (movement_type != 'ADJUSTMENT' OR (notes IS
  NOT NULL AND notes != ''))` `[V]` (`src/db/schema.sql:1593`).
- **Primer paso incompleto:** **la entrada de mercadería con documento**. El
  stock sube por un movimiento `IN` suelto; no hay orden de compra, ni
  proveedor, ni remito, ni costo de reposición.

## 4. Severidad máxima

**S1** — un ERP sin compras no puede responder "cuánto me costó lo que tengo".

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tablas | `products`, `product_variants`, `inventory_levels` (`src/db/schema.sql:1187`), `stock_movements` (`:1576`), `recipe_items` |
| Servicios | `src/pos-menu/product.service.ts:113`, `src/pos-menu/recipe.service.ts` |
| Rutas | `src/pos-menu/products.routes.ts:1` — 30 endpoints |
| Pantallas | `dashboard/productos`, `/[id]`, `/[id]/receta`, `/[id]/variantes` |
| Gate | `requireModule(POS_RESTAURANTE)` (`src/app.ts:367`) |

## 6. Identidad

`[V]` UUID sin identidad operativa; para un maestro es defendible (el producto se
identifica por nombre y SKU). ⊃ `A2-T01-002` con menor severidad.

`[V]` **`stock_movements.created_by` es `NOT NULL`** (`src/db/schema.sql:1585`).
Todo movimiento de stock sabe quién lo hizo. Comparar con
`financial_transactions.confirmed_by`, que es nullable y nadie llena en el cobro
manual (`A2-M04-002`): la misma decisión, tomada bien de un lado y mal del otro.

`[V]` `chk_stock_movement_target` obliga a que el movimiento apunte a producto
**o** a variante, nunca a los dos (`src/db/schema.sql:1589`). Es el patrón
"exactamente uno de N" que el `CLAUDE.md` del repo declara como convención.

## 7. Estados

`[V]` El movimiento no tiene estados: es un hecho inmutable. Correcto para un
ledger de inventario.

`[V]` `movement_type` está definido **dos veces con distinto alcance**: el
`CREATE TABLE` admite 4 valores (`src/db/schema.sql:1582`) y un `ALTER` posterior
lo extiende a 9 — `RESERVATION_RELEASED`, `TRANSFER`, `WASTE`, `PRODUCTION`,
`CONSUMPTION` (`src/db/schema.sql:1800`). Una base creada de cero y una migrada
terminan iguales, pero leer el schema no lo dice de una: hay que leerlo entero.

`[V]` `product_type IN ('RAW_MATERIAL','COMPOSITE','RETAIL')`
(`src/db/schema.sql:1150`) — el modelo distingue insumo de producto terminado,
que es lo que hace posible la receta.

`[V]` `price_override_status` y `recipe_override_status`, ambos
`IN ('INACTIVO','ACTIVO','PENDIENTE_DE_REVISION')`
(`src/db/schema.sql:1363`, `:1370`): el catálogo de empresa multipropiedad tiene
su propio flujo de aprobación, con `accept`/`reject` explícitos.

## 8. Documentos y movimientos

`[V]` El movimiento tiene entidad propia, con motivo obligatorio en el ajuste y
actor siempre presente. **Es el mejor ledger del sistema.**

`[V]` Sin documento: no hay remito, no hay comprobante de transferencia entre
ubicaciones, no hay acta de inventario físico.

## 9. Saldos y reportes

`[V]` El stock se deriva de `inventory_levels` por ubicación, separado del
producto desde el carve-out de inventario
(`src/pos-menu/products.routes.ts:54`). Decisión correcta y bien argumentada: el
endpoint sigue enriqueciendo la respuesta para no romper el contrato del
frontend, aunque el dato ya no sea parte del dominio `Product`.

`[V]` `GET /api/reports/pos/waste` existe y no tiene panel
(`datos/cobertura.csv`). ↔ `D7`.

`[H]` No verificado: si `inventory_levels` es un saldo derivado de
`stock_movements` o un contador actualizado en paralelo. Si es lo segundo, puede
divergir. Se confirmaría leyendo `sql.stock-movement.repository.ts` y buscando si
hay una consulta que reconcilie los dos.

## 10. Permisos y segregación

`[V]` `MANAGEMENT` para el catálogo, `ORDERS` para decrementar stock al confirmar
una orden (`src/pos-menu/products.routes.ts:22`).

`[V]` Transferencia y merma quedan en `MANAGEMENT` **sin flujo de aprobación
propio**, con el motivo declarado: "cada negocio decide quién puede
transferir/registrar mermas asignando ese rol, no es una decisión técnica
nuestra" (`src/pos-menu/products.routes.ts:45`).

Es una decisión legítima y conviene registrarla como lo que es: **una
segregación delegada al cliente**. Si mañana el control interno la exige, el
argumento ya está escrito y se puede revisar sin re-discutirlo de cero.

## 11. Auditoría y trazabilidad

`[V]` `product.service.ts` audita cambios de producto y de variante
(`src/pos-menu/product.service.ts:44`, `:45`). Es uno de los pocos servicios con
constantes de entidad de auditoría propias.

`[V]` El movimiento de stock no pasa por `audit_log` — y no hace falta: la
propia tabla es el rastro, con actor y motivo. Es el diseño correcto y hay que
decirlo, para que una lectura apurada no lo cuente como brecha.

## 12. Errores, idempotencia y fallo parcial

`[V]` `InsufficientStockError` como error de dominio
(`src/pos-menu/products.routes.ts:67`).

`[V]` `ON DELETE RESTRICT` en `product_id` y `product_variant_id`
(`src/db/schema.sql:1579`, `:1580`): no se puede borrar un producto con
movimientos. Correcto para una entidad con historia.

`[H]` No verificado: idempotencia del decremento de stock. Un doble `POST
/:id/stock/decrement` descontaría dos veces. Se confirmaría buscando una clave
de idempotencia en ese endpoint; `stock_movements` no tiene columna equivalente
(`src/db/schema.sql:1576`).

## 13. Capacidad ausente

1. **Compras y proveedores.** Ninguna tabla `suppliers` ni `purchase_*` en el
   schema `[V]`. Sin esto no hay costo de reposición, ni cuenta corriente de
   proveedor, ni control de recepción.
2. **Costeo.** No hay costo promedio ponderado ni FIFO. La receta calcula
   composición, no costo histórico. `[H]` — a confirmar leyendo
   `recipe.service.ts`.
3. **Inventario físico / recuento.** No hay flujo de "contar y ajustar por
   diferencia": sólo ajustes de a uno.
4. **Punto de reposición y alertas de stock mínimo.**
5. **Lotes y vencimientos.** Para un rubro gastronómico es una ausencia con
   consecuencias sanitarias.
6. **Pantalla para tres endpoints de stock**: `decrement` (×2) y `transfer` no
   tienen consumidor (`datos/cobertura.csv`). El decremento por orden pasa por
   otro camino; la transferencia entre ubicaciones no tiene ninguno.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M07-001` | S1 | No existe compras/proveedores: el stock entra sin documento, sin costo y sin cuenta corriente de proveedor. | ausencia de tabla en `src/db/schema.sql` | **nuevo** (tampoco está en el roadmap como fila propia) |
| `A2-M07-002` | S1 | Sin inventario físico: no hay recuento ni ajuste por diferencia. | ausencia de endpoint | **nuevo** |
| `A2-M07-003` | S2 | Transferencia entre ubicaciones sin pantalla. | `datos/cobertura.csv` | **nuevo** |
| `A2-M07-004` | S2 | Sin costeo: no se puede valuar el inventario. | ausencia de columna de costo en `inventory_levels` | **nuevo** `[H]` |
| `A2-M07-005` | S2 | Sin lotes ni vencimientos. | ausencia de tabla | **nuevo** |
| `A2-M07-006` | S2 | Sin punto de reposición ni alerta de stock mínimo. | ausencia de columna | **nuevo** |
| `A2-M07-007` | S3 | El decremento de stock puede no ser idempotente. | `src/db/schema.sql:1576` (sin clave de idempotencia) | **nuevo** `[H]` |
| `A2-M07-008` | S3 | `movement_type` definido en dos lugares con distinto alcance. | `src/db/schema.sql:1582` vs `:1800` | **nuevo** |
| `A2-M07-009` | S3 | `waste` se reporta y no tiene panel. | `datos/cobertura.csv` | ↔ `D7` |
| `A2-M07-010` | S4 | No verificado si `inventory_levels` puede divergir de `stock_movements`. | — | **nuevo** `[H]` |

## 15. Criterios de cierre

- Existe alta de mercadería con proveedor, documento y costo — o está escrito por
  qué el negocio no lo necesita.
- Hay recuento de inventario con ajuste por diferencia.
- El inventario se puede valuar.
- La transferencia entre ubicaciones tiene pantalla.
- Está verificado si el decremento es idempotente.
