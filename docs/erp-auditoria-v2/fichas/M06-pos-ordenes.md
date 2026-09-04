# M06 · POS / Órdenes

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

> El módulo mejor construido del sistema en materia de trazabilidad. Sirve de
> referencia: lo que le falta al resto está resuelto acá.

## 1. Flujo auditado

orden → ítems → confirmación → preparación/entrega → cobro → cierre → anulación

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "tomar y cobrar una orden":** ◇ Parcial — cierra todo salvo el
  comprobante
- **Flujo "anular una orden ya cobrada":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** el cobro con auditoría. `completeOrder()` recibe
  `changedBy`, graba la transición en `audit_log` dentro de la misma transacción
  y crea el movimiento financiero con medio de pago `[V]`
  (`src/pos-menu/order.service.ts:517`, `:544`, `:320`).
- **Primer paso incompleto:** **el ticket**. Una orden cobrada no emite nada
  imprimible: ni comanda para la cocina, ni ticket para el cliente.

## 4. Severidad máxima

**S1** — no por lo que hace mal, sino por lo que no cierra: sin ticket y sin
anulación posterior al cobro.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tablas | `orders`, `order_items` (`src/db/schema.sql:1384`) |
| Servicio | `src/pos-menu/order.service.ts:169` |
| Precios server-side | `src/pos-menu/order-pricing.service.ts` |
| Rutas | `src/pos-menu/orders.routes.ts:1` — 10 endpoints |
| Pantallas | `dashboard/ordenes`, `dashboard/ordenes/[id]` |
| Gate de módulo | `requireModule(POS_RESTAURANTE)` (`src/app.ts:368`) |

## 6. Identidad

`[V]` `orders.id` UUID; **sin número de orden** — ⊃ `A2-T01-002`. En un
restaurante, "la orden 47" es el vocabulario del salón. Es la ausencia de
identidad operativa con más impacto diario del sistema.

`[V]` La orden vincula al ledger por `financial_transactions.order_id`, columna
agregada explícitamente para cerrar el gap "Order nunca toca el ledger"
(`src/db/schema.sql:2094`). El consumo de POS aparece en el estado de cuenta del
cliente sin tocar `CustomerAccountService`.

## 7. Estados

`[V]` `status IN ('DRAFT','CONFIRMED','CANCELLED','COMPLETED')`
(`src/db/schema.sql:1389`), con `confirmed_at`, `cancelled_at`, `completed_at`.

`[V]` **`served_at` está fuera del enum a propósito**, con el argumento escrito:
"se sirvió" es independiente del cobro, y sirve para decidir si al cancelar
corresponde restaurar stock — sólo si `served_at` sigue `NULL`
(`src/db/schema.sql:1405`). Es una decisión de modelado madura: no se le agregó
una rama al enum para representar algo que no es un estado del ciclo.

## 8. Documentos y movimientos

`[V]` El cobro crea el movimiento con `paymentMethod` real
(`src/pos-menu/order.service.ts:544`), lo que lo hace elegible para el arqueo de
caja… si hubiera un turno abierto (↔ `A2-M05-002`).

`[V]` **Sin documento.** Ni comanda ni ticket. ↔ `A2-T04-006`.

## 9. Saldos y reportes

`[V]` Hay tres reportes de POS —`sales-by-product`, `waste`,
`ticket-summary`— y **ninguno tiene panel** (`datos/cobertura.csv`).
↔ `D7` de `pendientes-2026-09-01.md`.

## 10. Permisos y segregación

`[V]` Reparto deliberado y bien pensado: `POST /api/orders` y `POST
/:id/items` piden `BOOKING` (para que el cliente del portal pueda armar su
pedido) y todo lo demás pide `ORDERS`
(`src/pos-menu/orders.routes.ts:5`). Es el único módulo donde el guard varía
dentro del mismo recurso según quién ejecuta.

Sin segregación en el cobro: quien confirma es quien cobra. ⊃ `A2-T02-002`.

## 11. Auditoría y trazabilidad

`[V]` **Este módulo audita sus transiciones**, y lo hace bien: dentro de la
misma transacción, y **fail-loud** si no se inyectó el repositorio — "preferible
un error claro a una transición sin rastro"
(`src/pos-menu/order.service.ts:314`, `:320`).

`[V]` Lo que se audita es la transición de `status`. No se audita quién agregó o
quitó un ítem, ni quién cambió el precio de una línea.

## 12. Errores, idempotencia y fallo parcial

`[V]` `createOrder` envuelve `INSERT orders` + `INSERT order_items` en un solo
`BEGIN/COMMIT` (`src/pos-menu/orders.routes.ts:20`).

`[V]` `SELECT ... FOR UPDATE` sobre `orders` para serializar transiciones
concurrentes (`src/pos-menu/sql.order.repository.ts`, citado en el `CLAUDE.md`
del repo).

`[V]` El precio unitario de `PRODUCT`/`PRODUCT_VARIANT` se resuelve **server-side**
y el schema prohíbe que venga del cliente
(`src/pos-menu/order.service.ts:335`). Para `RESERVATION` sigue dependiendo del
`unitPrice` del caller, con `MissingUnitPriceError` como red
(`src/pos-menu/order.service.ts:337`). Límite declarado.

`[V]` Emite tres eventos de dominio: `order.confirmed`, `.cancelled`,
`.completed` (`grep -rn "eventType:"`).

## 13. Capacidad ausente

1. **Ticket y comanda.**
2. **Número de orden.**
3. **Anulación después del cobro.** `CANCELLED` sólo llega desde `DRAFT`/
   `CONFIRMED`; una orden `COMPLETED` mal cobrada no tiene salida — misma
   ausencia que `A2-M04-001`, en otro módulo.
4. **Mesas, salones, división de cuenta.** `docs/diseno-pos-menu-mesas-2026-08-18.md`
   existe como diseño; no hay tabla de mesas en el schema `[V]`
   (`src/db/schema.sql` sin `tables`/`mesas`).
5. **Propinas y descuentos de línea.**
6. **Auditoría de cambios de ítems y precios.**

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M06-001` | S1 | Una orden `COMPLETED` mal cobrada no se puede anular. | `src/db/schema.sql:1389`; ninguna ruta de anulación post-cobro | ⊃ `A2-M04-001` |
| `A2-M06-002` | S1 | Sin ticket ni comanda. | ausencia de endpoint | ↔ `A2-T04-006` |
| `A2-M06-003` | S2 | Sin número de orden. | `src/db/schema.sql:1386` | ⊃ `A2-T01-002` |
| `A2-M06-004` | S2 | Los tres reportes de POS no tienen panel. | `datos/cobertura.csv` | ↔ `D7` |
| `A2-M06-005` | S2 | No hay mesas: el diseño existe, la tabla no. | `docs/diseno-pos-menu-mesas-2026-08-18.md` vs `src/db/schema.sql` | **nuevo** |
| `A2-M06-006` | S3 | No se audita quién agregó, quitó o repreció un ítem. | `src/pos-menu/order.service.ts:320` (sólo `status`) | **nuevo** |
| `A2-M06-007` | S3 | Sin propinas ni descuentos de línea. | `order_items` sin columnas | **nuevo** |
| `A2-M06-008` | S4 | `unitPrice` de ítems `RESERVATION` sigue viniendo del caller. | `src/pos-menu/order.service.ts:337` (declarado) | **nuevo** |

## 15. Criterios de cierre

- Una orden cobrada emite un ticket consultable y reimprimible.
- Existe camino de anulación post-cobro, con movimiento inverso y motivo.
- La orden tiene número.
- Los tres reportes de POS tienen panel, o está escrito que se descartan.
