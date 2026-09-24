# Auditoría — sobreconsulta a la base de datos (24/09/2026)

> Diagnóstico puro, sin cambios de código todavía. Disparado por una
> comparación informal del dueño: "la otra app, respecto a esta, no
> consulta tanto a la DB". Se armó con 4 auditorías de código en paralelo
> (inventario/POS, reservas, infraestructura transversal,
> clientes-finanzas/platform/reporting) — cada hallazgo está anclado a
> archivo:línea del código real, no estimado. Próximo paso (no hecho
> acá): decidir por cuál frente arrancar la implementación — ver
> "Próximos pasos" al final.

## Resumen — ranking por impacto

| # | Área | Problema | Costo medido |
|---|------|----------|--------------|
| 1 | Reservas — `available-slots` | Por cada slot candidato del día se re-consulta todo desde cero, sin memoización entre slots del mismo recurso/día | **~100-150 queries por request** — endpoint de alta frecuencia (grilla de turnos en tiempo real) |
| 2 | Facturación — `requestConsolidatedInvoice()` | Loops de `getById` por transacción/orden/ítem/reserva sin JOIN, más 3 loops de lock/mark separados | **4N-6N queries** según cargos involucrados |
| 3 | POS — crear/confirmar orden | Loop secuencial (sin `Promise.all`) de 3-4 queries por ítem al crear, 2 por ítem al confirmar/reservar stock | **~25-30 queries por orden de 5 ítems** |
| 4 | Infraestructura — todo request autenticado | `getMembershipContext`, `requireModule`→`findById`, `resolvePlanLimits` sin cache, contra el pool de plataforma compartido por todos los tenants | **2-4 queries fijas, en el 100% del tráfico** |
| 5 | Reservas — `createReservation()` | `categoryRepository.findById` y `businessProfileRepository.get()` llamados 2-3 veces cada uno con el mismo id, dentro del mismo request | ~20 queries totales, varias redundantes |
| 6 | Reservas — `getFiltered()` (listados) | N+1 admitido explícitamente en un comentario del propio código | 2N queries por listado de N reservas |
| 7 | Clientes-finanzas | Loops de `getById`/`resolveInvoiceLinkage` por cargo/asignación | 1-2 queries por ítem, volumen menor que 1-3 |

**Lectura clave:** el hallazgo #4 no es el más caro por request, pero es
el que más se nota "comparado con la otra app" — se paga en el 100% del
tráfico, contra un pool de solo 5 conexiones compartido entre todos los
tenants (`container.ts:48-50`), y satura antes que cualquier N+1 puntual
de un módulo específico.

**Lo que está bien (evidencia negativa, no se toca):**
`report.service.ts` (agregación con `Promise.all` de 2 llamadas fijas +
merge en memoria), `sql.domain-event.repository.ts` (query única por
método, sin fan-out), los loops de `platform.repository.ts` /
`company.repository.ts` (DELETE+INSERT sobre listas chicas, documentados
en el propio código como "volumen chico"/"baja frecuencia"), y
`GET /api/products` (una sola query de catálogo + un solo
`getAllByLocation()` para stock, matcheo en memoria).

---

## 1. Reservas — `available-slots` (peor caso medido)

**Archivos:** `src/reservas/reservation-schedule.service.ts:68-74`,
`src/reservas/reservation-availability.service.ts:157-209`.

`ReservationScheduleService.getAvailableSlots()` genera N slots
candidatos del día y llama `checkAvailability()` una vez por slot vía
`Promise.all` — paralelo, pero sin reusar nada entre slots. Cada
`checkAvailability()` dispara por recurso:

- `resourceRepository.getById`
- `resolveLockedResourceIds` (si hay `serviceId`)
- `evaluateMaintenanceWindows` → `businessProfileRepository.get()` +
  `maintenanceWindowRepository.findActiveByResourceId` (2 queries)
- `resolveOccupyingReservations` → `getActiveForResourceInRange` +
  `resourceLockRepository.getByResourceId` (2+ queries)
- `isExclusiveResource` → `categoryRepository.findById`

≈ 6-8 queries por slot. Con ~16-20 slots/día (turnos de 30 min en 8hs),
un solo request dispara **~100-150 queries**, repitiendo datos idénticos
entre slots: `businessProfileRepository.get()` y
`maintenanceWindowRepository.findActiveByResourceId` no cambian dentro
del mismo request (mismo recurso, mismo día) y no hay cache ni
memoización a ese nivel.

## 2. Facturación — `requestConsolidatedInvoice()`

**Archivo:** `src/facturacion/invoice.service.ts`.

- Línea 755-760: loop `for (const financialTransactionId of
  financialTransactionIds)` con `await financialTransactionRepo.getById(...)`
  por cada id.
- `resolveInvoiceItems()` (338-360): por cada tx con `orderId`,
  `orderRepo.getById(tx.orderId)` (otra query), y línea 346-378+,
  `Promise.all(order.items.map(item => resolveOrderItemLine(item, profile)))`
  — 1 query más por ítem de la orden (`reservationRepo.getById`,
  `productRepo.getById`, `productVariantRepo.getById` o
  `serviceItemRepo.findById` según `itemType`). Paralelizado con
  `Promise.all` (no secuencial), pero sigue siendo N+1 real: nada de
  esto usa JOIN.
- Dentro de la transacción: línea 780-785 loop `getByIdForUpdate` por
  cada `orderId` único; línea 786-793 loop `getByIdWithLock`/`getById`
  por cada `reservationId` único; línea 832-841 loop `markInvoiced` por
  cada `ar` en `pending`.

Para una consolidada de N cargos con M órdenes/ítems involucrados:
aproximadamente N (getById tx) + N (getById order) + Σítems
(resolveOrderItemLine) + órdenes únicas (lock) + reservas únicas (lock)
+ N (markInvoiced) — fácilmente **4N-6N** en vez de un batch/JOIN.

## 3. POS — crear/confirmar orden

**Archivos:** `src/pos-menu/order.service.ts`,
`src/pos-menu/order-pricing.service.ts`,
`src/repositories/sql.inventory-level.repository.ts`,
`src/platform/location.repository.ts`.

- `createOrder()` (línea ~595): `for (const item of input.items ?? [])`
  llama `resolveOrderItemInput()` → `resolveUnitPrice()` de forma
  **secuencial** (`await` uno por uno, sin `Promise.all`). Por ítem
  PRODUCT/PRODUCT_VARIANT: `productService.resolveTarget()` (query a
  `products` +1 a `product_variants` si tiene variante +1 a
  `inventory_levels`) y `customerRateRepository.findActiveForCustomerAndProduct()`
  (+1) → **3-4 queries por ítem, secuenciales**, sin JOIN.
- `confirmOrder()` (línea 738): `for (const item of
  canonicalStockItemOrder(stockItems))` llamando
  `productService.reserveStock()` uno por uno. Cada llamada hace
  `ensureRow()` (INSERT ON CONFLICT) + `UPDATE ... RETURNING` =
  **2 queries por ítem**.
- Total estimado para una orden de 5 productos: creación (~15-20) +
  confirmación (~10) = **~25-30 queries para una sola orden**.
- `resolveDefaultLocationId()` (`location.repository.ts:56`) hace un
  `SELECT` a `locations` cada vez que no viene `locationId` explícito —
  se invoca en casi todos los endpoints de `products.routes.ts`
  (`/stock/decrement`, `/stock/waste`, `/stock/consumption`,
  `/stock/production`, etc.) para un dato que casi nunca cambia.
- Patrón de cache que **ya existe en el repo pero no se usa acá**:
  `src/db/health-cache.ts` (`CachedDbHealth`, TTL + single-flight),
  aplicado solo al health-check.

## 4. Infraestructura transversal — costo fijo por request

**Archivos:** `src/security/auth.middleware.ts:312`,
`src/security/module.middleware.ts:37`,
`src/security/resolve-plan-limits.ts:22`,
`src/platform/platform.repository.ts:645,714,1122`,
`src/container.ts:150-222`, `src/workers/outbox.registry.ts:11-16`,
`src/domain/audit.ts:131-147`.

- `authenticate()` → `resolveMembershipContext` →
  `PlatformRepository.getMembershipContext()`: 1 SELECT con JOIN+GROUP
  BY contra la BD de plataforma, **en todo request autenticado**, sin
  cache — el permission check se resuelve de cero cada vez.
- `tenantMiddleware`: pool cacheado en `Map` en memoria — en cache-hit
  (caso normal) no agrega query. **No** es el problema.
- `requireModule()` → `container.ts:190-201` →
  `platform.repository.ts:645` (`findById`, `SELECT * FROM businesses
  WHERE id=$1`): 1 SELECT extra por request, sin cache, en cada ruta
  gateada por módulo (`/products`, `/service-items`, `/orders`,
  `/waste-reasons`, `/consumption-destinations`, `/cash-register`,
  `/reports`, `/housekeeping`, `/maintenance-windows`, `/stays`,
  `/accounts-receivable`).
- `resolvePlanLimits()` (usado en `categories.routes.ts` y
  `users.routes.ts` POST/PUT): `getBusinessPlan` (otro `findById`) +
  `getPlanLimits` (2 queries: `plan_limits` +
  `plan_limit_allowed_roles`) = 3 queries extra sin cache.
- Total estimado por request: **2 queries mínimo** (auth +
  requireModule) en rutas de módulo; **hasta 4** en categories/users
  POST/PUT. Todas contra el mismo pool de plataforma
  (`container.ts:48-50`, `max: 5`), compitiendo con el tráfico de TODOS
  los tenants.
- Pools: correcto — no se crea pool nuevo por request (singleton
  `_platformPool`; `tenant.middleware.ts` con Map + LRU,
  `MAX_TENANT_POOLS`). No hay reconexión costosa por request.
- Workers (`outbox.registry.ts:11-16`): 2 timers por tenant activo —
  `OutboxWorker` cada 5s (1 `getPending(50)` por ciclo) +
  `ReservationHoldExpiryWorker` cada 60s. Con N tenants: 2N timers
  concurrentes, sin solapamiento por worker (`polling` flag), pero
  escala linealmente — el propio código admite "aceptable hasta ~200
  tenants".
- `domain/audit.ts::updateWithAudit`: **no** agrega un SELECT propio —
  el caller resuelve `before`/`diffFields` antes; dentro de la misma
  transacción va UPDATE + INSERT condicional. Bien diseñado, no es
  fuente de N+1.
- Candidatos directos al patrón de `health-cache.ts` (mismo shape:
  lookup de plataforma que tolera unos segundos de staleness), sin
  cache hoy: `getMembershipContext`, `getBusinessPlan`/`findById`,
  `getBusinessModuleGates`.

## 5. Reservas — `createReservation()`

**Archivo:** `src/reservas/reservation.service.ts:224-403`.

Para una reserva simple de 1 recurso sin locks, ≥20 queries. Redundancia
puntual:

- `categoryRepository.findById` se llama **3 veces** con el mismo
  `categoryId` (línea 248; dentro de `resolvePrice`→`resolveUnitPrice`
  en `reservation-pricing.service.ts:228`; y dentro de
  `isExclusiveResource` en `reservation-availability.service.ts:143`).
- `businessProfileRepository.get()` se llama **3 veces** (línea 308
  directo; y 2 veces más vía `evaluateMaintenanceWindows` — una desde
  `assertAllResourcesAvailable` línea 322, otra desde
  `needsMaintenanceReview` línea 361, ambas para el mismo
  `resourceId`/rango).
- `maintenanceWindowRepository.findActiveByResourceId` se llama **2
  veces** para el mismo recurso+fecha (mismas dos rutas de arriba).

`FOR UPDATE` está usado correctamente (una vez por operación en
`confirmReservation`/`cancelReservation`/`completeReservation`/
`confirmPriceAdjustment`, y `resourceRepository.lockByIds` una vez por
`assertAllResourcesAvailable`) — no es el problema; el problema son las
queries **no** lockeadas que se repiten alrededor.

## 6. Reservas — listados (`getFiltered()`)

**Archivo:** `src/reservas/sql.reservation.repository.ts:439-563`.

`rowToReservation` (498-556) hace `resourceRepository.getById()` +
`getLines()` (query separada a `reservation_lines`) **por cada fila**.
Usado por `getFiltered()` (backing de `GET /reservations` y
`POST /reservations/search`) → listar N reservas = `countFiltered` +
`getFiltered` + 2N queries (paralelizadas con `Promise.all`, pero 2N
round-trips igual). El propio comentario en línea 558-563 lo llama
"N+1 a propósito" — deuda ya reconocida en el código, no un hallazgo
nuevo.

`reservation-hold-expiry.worker.ts:81-91`: loop secuencial `for...of` +
`await expireOne()` por reserva vencida, cada una en su propia
transacción — correcto para aislamiento, sin batching entre reservas
del mismo poll (aceptable dado el intervalo de 60s, no es hallazgo
principal).

## 7. Clientes-finanzas

- `src/clientes-finanzas/accounts-receivable.service.ts:362-364`: loop
  `for (const charge of stayCharges) { await
  this.invoiceRepo.resolveInvoiceLinkage(charge.id) }` — 1 query por
  cargo de la estadía, más `classifyReservationLiveInvoice`/
  `classifyOrderLiveInvoice` condicional (372-376), otra query más por
  cargo con reserva/orden.
- `src/clientes-finanzas/customer-account.service.ts:263-272`: loop
  `getById(alloc.invoiceId)` por cada factura asignada (fuera de tx).
  Línea 299-349, dentro de la tx, por cada allocation:
  `getByIdempotencyKey` + `applyCappedPaymentToInvoice` (lock+update) +
  `createIdempotentPaymentWithClient` (insert) — esto último parece
  intencional por locking/concurrencia (A8.1/A8.2), no un simple
  missing-JOIN; no se propone tocarlo por esta auditoría.

---

## Próximos pasos (no decidido en este documento)

Este documento es diagnóstico puro — no incluye diseño de solución.
Antes de tocar código:

- Los hallazgos #1, #3 y #5 tocan lógica de disponibilidad/reserva de
  stock — corresponde pasar por la skill `criterios-negocio` y, por ser
  código que corre concurrentemente (múltiples requests/slots en
  paralelo), por `concurrency-reasoning` antes de rediseñar el
  repositorio o el flujo de locks.
- El hallazgo #4 es más mecánico (agregar cache tipo `health-cache.ts`
  a lookups que ya existen y casi no cambian) — menor riesgo, no
  requiere rediseño de reglas de negocio, pero igual es código de
  `src/security/` y `src/container.ts` — pasa por
  `docs/DEFENSIVE_DEVELOPING.md` sección 3 (multi-tenant) por tocar
  wiring compartido entre tenants.
- El hallazgo #2 (facturación) y #6/#7 quedan documentados pero sin
  priorizar todavía — decisión pendiente del dueño sobre por cuál
  frente arrancar.
