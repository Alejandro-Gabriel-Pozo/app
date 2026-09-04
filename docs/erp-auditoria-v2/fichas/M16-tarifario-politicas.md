# M16 · Tarifario y políticas comerciales

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`
**Módulo nuevo en v2** — v1 no lo tenía; el precio y las políticas estaban
repartidos como detalle de otros módulos.

## 1. Flujo auditado

precio base → plan de tarifa → catálogo de descuentos → tarifa especial por
cliente → política de seña → política de cancelación → política de facturación →
aplicación al cobro

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "precio y descuento":** ✅ Completo en el backend, ◌ Huérfano en el
  producto
- **Flujo "política de cancelación":** ◌ Huérfano — 5 endpoints, 0 consumidores
- **Flujo "política de seña":** ◌ No existe el CRUD

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la aplicación del precio. `OrderPricingService`
  resuelve `unitPrice` server-side incluyendo la tarifa especial del cliente
  `[V]` (`src/pos-menu/order.service.ts:299`).
- **Primer paso incompleto:** **administrar las tarifas**. Los 4 endpoints de
  `rate-catalog` y los 5 de `cancellation-policies` no tienen consumidor `[V]`
  (`datos/cobertura.csv`). El motor de precios funciona y no hay pantalla para
  cargarle nada.

## 4. Severidad máxima

**S1** — nueve endpoints de reglas comerciales sin interfaz. Lo que decide
cuánto se cobra sólo se puede configurar por `curl` o por SQL.

## 5. Superficie

| Pieza | Ubicación | Consumido |
|---|---|---|
| `rate_catalog` | `src/db/schema.sql:677` | endpoints **no** |
| `customer_rates` | `src/db/schema.sql:727` | sí (desde ficha de cliente) |
| `rate_plans` | `src/db/schema.sql:273` | `[H]` no verificado |
| `deposit_policies` | `src/db/schema.sql:850` | **sin CRUD** ↔ `C1-Fase A` |
| `cancellation_policies` | `src/db/schema.sql:897` | **no** (5 endpoints) |
| `billing_policies` | `src/db/schema.sql:2992` | parcial |
| Servicios | `src/clientes-finanzas/rate-catalog.service.ts:38`, `src/reservas/reservation-pricing.service.ts`, `src/reservas/cancellation-policy.service.ts` | — |

## 6. Identidad

`[V]` `rate_catalog` tiene unicidad de negocio real:
`UNIQUE (business_id, name)` (`src/db/schema.sql:692`). No es un UUID suelto:
"Corporativo -10%" es único por negocio.

`[V]` El patrón "exactamente uno de N" está aplicado tres veces con `CHECK`
basado en `CASE`: `chk_rate_catalog_target` (`src/db/schema.sql:688`),
`chk_customer_rate_target` (`:739`) y el de `stock_movements`. Es la convención
que el `CLAUDE.md` del repo declara y acá se cumple.

## 7. Estados

`[V]` No hay máquina de estados: hay `active` en `rate_catalog`
(`src/db/schema.sql:684`) y en `customer_rates` (`:734`), con soft-delete.

`[V]` `discount_percentage CHECK (> 0 AND <= 100)` (`src/db/schema.sql:681`) —
el rango está defendido en la base, no sólo en el servicio.

`[V]` **Regla viva, no snapshot**: cambiar el `%` del catálogo **propaga de
inmediato** a todo cliente ya asignado, y está declarado en el docblock de la
ruta (`src/clientes-finanzas/rate-catalog.routes.ts:15`). Es una decisión de
negocio con dos respuestas válidas, tomada y escrita — exactamente lo que el
`CLAUDE.md` de `app-main` pide cuando una pregunta de alcance esconde una
decisión de comportamiento.

**Consecuencia que sí es una brecha:** si el `%` propaga, una reserva vieja
recalculada muestra otro precio que el día que se tomó. `[H]` — no verificado si
`reservations.total_price` congelado (`src/db/schema.sql:439`) protege ese caso;
se confirmaría probando un recálculo sobre una reserva confirmada.

## 8. Documentos y movimientos

No aplica: el tarifario no produce documentos. Alimenta el precio de M01, M03 y
M06.

## 9. Saldos y reportes

`[V]` `GET /api/reports/crm/applied-rates` existe y **no tiene panel**
(`datos/cobertura.csv`). Es el reporte que respondería "cuánto descuento
regalamos este mes", y no se puede ver. ↔ `D7`.

## 10. Permisos y segregación

`[V]` `FRONT_DESK` para leer el catálogo —hace falta para armar una tarifa, no
sólo gestión— y `MANAGEMENT` para escribir
(`src/clientes-finanzas/rate-catalog.routes.ts:10`).

`[V]` `DELETE` es **soft**: desactiva, no borra, porque las tarifas ya creadas la
siguen referenciando por trazabilidad
(`src/clientes-finanzas/rate-catalog.routes.ts:20`). Criterio correcto para un
maestro.

Sin segregación: quien puede crear un descuento del 100 % es el mismo que lo
aplica.

## 11. Auditoría y trazabilidad

`[V]` **`rate-catalog.service.ts` audita `PUT` y `DELETE`**
(`src/clientes-finanzas/rate-catalog.service.ts:38`, `:67`, `:97`), y la
auditoría distingue "cambió el % del catálogo" de "se tocó la tarifa de un
cliente puntual" — está declarado como convención en el `CLAUDE.md` del repo.

Es de los pocos lugares donde el rastro está pensado para responder una pregunta
de negocio, no sólo para registrar un cambio.

## 12. Errores, idempotencia y fallo parcial

`[V]` `ON DELETE CASCADE` en `resource_id` y `service_id` de `rate_catalog`
(`src/db/schema.sql:682`, `:683`) y de `customer_rates` (`:730`, `:731`): borrar
un recurso borra sus tarifas. Coherente dentro del módulo; ver `A2-M08-001` para
la inconsistencia de política de borrado a nivel sistema.

`[V]` `CustomerRateConflictError` como error de dominio para el override
duplicado (`src/clientes-finanzas/customers.routes.ts:45`).

## 13. Capacidad ausente

1. **Pantalla del catálogo de tarifas.**
2. **Pantalla de políticas de cancelación.**
3. **CRUD de `deposit_policies`.** ↔ `C1-Fase A`, con 3 decisiones del dueño
   abiertas.
4. **Vigencia temporal.** Ninguna de las tablas de precio tiene `valid_from` /
   `valid_to`: no se puede cargar la tarifa de temporada alta con anticipación,
   ni saber qué precio regía en una fecha pasada.
5. **Moneda por tarifa.** El precio es `DECIMAL` sin columna de moneda: la
   moneda es la del negocio (`business_profile.currency`). Para un hotel que
   cotiza en dólares es una ausencia estructural. `[H]` — a confirmar con el
   dueño si aplica.
6. **Reglas por temporada, por anticipación o por estadía mínima.**

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M16-001` | S1 | Los 4 endpoints de `rate-catalog` no tienen pantalla: el catálogo de descuentos se carga por API. | `datos/cobertura.csv` | **nuevo** |
| `A2-M16-002` | S1 | Los 5 endpoints de `cancellation-policies` no tienen pantalla. | `datos/cobertura.csv` | **nuevo** |
| `A2-M16-003` | S1 | Sin vigencia temporal en ninguna tabla de precio: no hay tarifa futura ni precio histórico. | `src/db/schema.sql:677`, `:727` (sin `valid_from`/`valid_to`) | **nuevo** |
| `A2-M16-004` | S1 | `deposit_policies` sin backend de CRUD. | — | ↔ `C1-Fase A` |
| `A2-M16-005` | S2 | `applied-rates` sin panel: no se puede medir el descuento otorgado. | `datos/cobertura.csv` | ↔ `D7` |
| `A2-M16-006` | S2 | Sin segregación: quien crea el descuento lo aplica. | `src/clientes-finanzas/rate-catalog.routes.ts:10` | ⊃ `A2-T02-002` |
| `A2-M16-007` | S2 | Sin moneda por tarifa. | `src/db/schema.sql:733` | **nuevo** `[H]` |
| `A2-M16-008` | S3 | No verificado si la propagación del `%` afecta el precio de una reserva ya confirmada. | `src/clientes-finanzas/rate-catalog.routes.ts:15` vs `src/db/schema.sql:439` | **nuevo** `[H]` |
| `A2-M16-009` | S3 | Sin reglas por temporada, anticipación o estadía mínima. | ausencia de columna | **nuevo** |
| `A2-M16-010` | S4 | `rate_plans` con `service_id NOT NULL`. | — | ↔ ítem "deuda activa" de `pendientes-2026-09-01.md` |

## 15. Criterios de cierre

- El catálogo de tarifas y las políticas de cancelación tienen pantalla.
- Toda tabla de precio tiene vigencia, y se puede responder "qué precio regía el
  15 de julio".
- `deposit_policies` tiene CRUD y sus 3 decisiones están tomadas.
- Está verificado y escrito qué pasa con una reserva confirmada cuando cambia el
  `%` del catálogo.
