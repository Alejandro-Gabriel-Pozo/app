# Plan de resolución — bugs no corregidos + deuda promovida + decisiones C1-A

**Fecha:** 27/08/2026. **Fuente:** los tres grupos de `pendientes-2026-08-27.md`
(bugs encontrados de paso, deuda nueva promovida, decisiones de C1-A). Ordenado
por **riesgo/costo/dependencia**, no por el orden de la lista. Los 5 bugs se
verificaron contra el código real antes de planear (líneas confirmadas abajo).

> Este documento se deja para poder retomar si no se termina en una sola sesión.
> Al cerrar un ítem, marcarlo `✅ RESUELTO` acá y en `pendientes-2026-08-27.md`.

---

## FASE 1 — Datos que se pierden en silencio (baratos, sin schema, alto valor)

### 1. Bugs #1 + #2 — seña y `needsMaintenanceReview` que se borran — ✅ RESUELTO (27/08/2026)

Misma familia (props no reenviados a `Reservation.restore()`, que los defaultea;
el UPSERT los escribe sin condicional, `sql.reservation.repository.ts` $23/$24/$27):

- `updateReservation()` — `reservation.service.ts:507-539`: faltaban
  `depositAmount`, `depositDueBy`, `needsMaintenanceReview`.
- `confirmPriceAdjustment()` — `reservation.service.ts:665-699`: mandaba
  `depositAmount` pero **no** `needsMaintenanceReview` (ya anotado en el
  comentario previo como "sin corregir").

**Criterios:** `Reservation` = TRANSACCIÓN. R9 (snapshot: se preservan, no se
recalculan — recalcular la seña es `resolveDepositAmount()`/C1-A, fuera de
alcance), A3.9 (dinero: la seña ya cobrada no se pone en $0), A6.x (el snapshot
de mantenimiento protege el EXCLUDE constraint).

**Implementado:** los tres campos se reenvían desde `existing`/`locked` en ambos
`restore()`. Comentario previo de "sin corregir" actualizado.
**Verificado:** 2 tests de regresión nuevos (`reservation.service.test.ts`),
suite 1555/1555 verde, sin regresiones. `eslint` limpio en los archivos tocados.

### 2. Bug #3 — `recordInvoiceAudit()` fuera de la transacción — ✅ RESUELTO (27/08/2026)

3 sitios (`invoice.service.ts` — nota de crédito vía `buildCreditNote`,
per-reservation, consolidada) llamaban `.record()` **después** de cerrar
`transactionManager.run()`: la factura ya existía cuando la auditoría podía
fallar (A6.5/A8.2).

**Implementado:** `recordInvoiceAudit()` ahora recibe el `client` y usa
`recordWithClient()` (mismo idiom que `domain/audit.ts:102`); las tres llamadas
se movieron adentro del `run()` que crea la factura. Para la nota de crédito,
`buildCreditNote()` recibe `changedBy` y graba la auditoría dentro de su propia
transacción. Es el patrón que RBAC paso 1 aplicó en los otros 12 call sites.
**Verificado:** `tsc` limpio, tests de facturación 45/45, suite completa
1555/1555.
**Pendiente de esta tanda (heredado):** el rollback forzado real solo se prueba
contra Postgres (`TEST_DATABASE_URL`) — el `FakeTransactionManager` de los tests
no revierte writes in-memory. Rueda junto con Fase 2.4 (ver abajo).

---

## FASE 2 — Auditoría y transacciones con wiring nuevo (más grande)

### 3. Bug #4 — `order.service.ts` sin auditoría — ✅ RESUELTO (27/08/2026)

Constructor no recibía `auditLogRepo`; las transiciones de orden no dejaban
rastro de QUIÉN las hizo (A6.5).

**Implementado (alcance: solo transiciones de status, lo recomendado):**
- `OrderService` recibe `auditLogRepo?` (opcional, para no romper call sites que
  no auditan) + helper `recordStatusTransition()` con **guard fail-loud**.
- Las 3 transiciones — `confirmOrder` (DRAFT→CONFIRMED), `completeOrder`
  (CONFIRMED→COMPLETED), `cancelOrder` (previousStatus→CANCELLED) — reciben un
  `changedBy: string` (precedente de `confirmPriceAdjustment`) y graban la fila
  `{ entity:'orders', field:'status', oldValue, newValue, changedBy }` con
  `recordWithClient()` **dentro de la misma transacción** que la transición
  (atómica: rollback de la transición ⇒ no queda auditoría fantasma).
- Rutas: `confirm`/`complete`/`cancel` pasan `req.user!.id` (actor estándar del
  repo); `buildOrderService` inyecta `SqlAuditLogRepository(req.db!)` — mismo
  pool de tenant que el resto, comparte la transacción (DEFENSIVE_DEVELOPING §3).

**Fuera de alcance (deliberado):** `markServed` (no es transición de status y no
corre en tx hoy), `addItem`/`removeItem`/`updateNotes` (ediciones de DRAFT, no
transiciones). Quedan como candidatos si se quiere ampliar la auditoría.

**RBAC:** sin cambios de `authorize()` (las rutas ya tenían `Roles.ORDERS`) →
matriz y `EXPECTED_AUTHORIZE_CALL_SITES` intactos.

**Verificado:** `tsc` limpio, **suite 1561/1561** (4 tests nuevos: fila de
auditoría en confirm, ciclo confirm→complete con las 2 filas, cancel registra
previousStatus→CANCELLED, y el guard fail-loud sin repo). `eslint` limpio.
Ajustados los tests de `order.service.test.ts` (~30 call sites + el
constructor) y 2 asserts de args en `orders.routes.test.ts`.

**Nota menor (no corregida, fuera de alcance):** `InMemoryAuditLogRepository.findByEntity`
devuelve inserción-primero mientras el repo SQL documenta más-reciente-primero —
discrepancia de fidelidad del doble, preexistente. Mis tests quedaron agnósticos
al orden para no acoplarse a ninguno.

### 4. Bug #5 — `PlatformRepository` sin transacciones — ✅ RESUELTO (27/08/2026)

En todo el archivo no había un solo `connect()`/`BEGIN`. Las escrituras
multi-tabla hacían UPDATE + DELETE + loop INSERT sueltos vía `this.db.query()`
(cada uno en una conexión distinta del pool).

**Implementado:**
- `buildPlatformTransactionManager()` nuevo en `container.ts` (`PgTransactionManager`
  sobre `getPlatformRawPool()` — el pool de PLATAFORMA, nunca un pool de tenant,
  DEFENSIVE_DEVELOPING §3).
- `PlatformRepository` recibe un `TransactionManager` **opcional** (para no romper
  ~15 call sites de solo-lectura) + helper `txRun()` con **guard fail-loud**: los
  métodos que escriben en varias tablas lo EXIGEN o lanzan un error claro (idiom
  de `recordWithClient`), en vez de reintroducir el bug en silencio.
- **5 métodos** envueltos (uno más que los 3 nombrados en el pendiente): `createBusiness`
  (+ los helpers privados `provisionDefaultModules`/`provisionSystemRoles` reciben el
  `client`), `createRole`, `updateRolePermissionGroups`, `updatePlanLimits`, y
  `updateRolePresetPermissionGroups` — este último encontrado de paso, mismo defecto
  DELETE/INSERT no atómico en el catálogo de presets.
- TM inyectado en los 5 sitios de producción (`container.ts`, `app.ts`,
  `platform.container.ts`, `products.routes.ts`, `migrate-tenants.ts`).

**Verificado:** `tsc` limpio, **suite 1557/1557** (2 tests nuevos: el guard
fail-loud de `createRole`/`updatePlanLimits` sin TM; el test existente de
`createBusiness` ahora usa un fake TM que corre el work contra el mismo
FakeSqlClient). `eslint` limpio. Ajustado el mock de `container.js` en
`products.routes.test.ts` para stubear el nuevo export.

**Pendiente (heredado, no bloqueante):** el **rollback forzado real** contra
Postgres (`TEST_DATABASE_URL`) sigue sin correrse — los fakes de los tests no
revierten. Bug #3 lo hereda. Es la deuda de calidad que quedaba de RBAC paso 1;
ahora la infra (`buildPlatformTransactionManager`) ya está construida para poder
hacerlo. **Va antes que Bug #4** (deja el TransactionManager construido).

---

## FASE 3 — Deuda de cobro promovida (features reales; `respaldo` + skill `criterios-negocio`)

### 5. 🔴 Temporada que cruza el rango de la estadía — ⏳ PENDIENTE (bug de cobro vivo)

`rate_plans.valid_from`/`valid_to` se valida solo contra la fecha de **inicio** y
todas las líneas llevan el mismo precio unitario. Estadía 28/02→05/03 cobra las 6
noches a tarifa alta. **No es fix chico:** es el motor de tarifa por noche que
`buildLines()` anticipa como estructura pero no implementa.
**Fix:** resolver la tarifa por noche contra la fecha de cada línea en
`buildLines()`. **Verif.:** reserva que cruza el borde cobra cada noche a su tarifa.

### 6. 🟠 Rate plans no reutilizables entre servicios — ⏳ PENDIENTE

`rate_plans.service_id` NOT NULL + unique `(service_id, name)` → "Con desayuno"
se recrea por tipo de habitación (~2 docenas de filas a mano).
**Fix:** catálogo reutilizable estilo `rate_catalog` (molde existe; referencia
viva, no snapshot — ver incidente D5 del CLAUDE.md).

### 7. `resource_locks` "cualquiera de la categoría X" — 🔵 DEUDA FUTURA (no en esta tanda)

Solo bloquea por ID. Sin caso de uso activo (spa/tours). No entra ahora.

---

## FASE 4 — C1-A: decisiones del dueño, no son código todavía

### 8. R1/R3/R4/R8 que `deposit_policies` incumple — ⏳ DECIDIR con la CRUD

R3 (`active` vs `deleted_at`), R8 (no pasa por `recordFieldChanges()`), R1 (sin
`code` — declarar que no aplica), R4 (vigencia — backlog). Se deciden con la CRUD
(paso 10 del plan). Plantear con `AskUserQuestion` al llegar.

### 9. Lista real de tipos de habitación de la Hostería — ⏳ PEDIR DATO

Bloquea dimensionar cuántos servicios "Estadía X" y rate plans crear. Es un dato
a pedir, no a inferir.

---

## Cleanup menor detectado de paso (no en scope, no corregido)

- `invoice.service.ts:25` — `AccountReceivable` importado sin usar (import de
  tipo). Preexistente, no introducido por el fix de Bug #3. Un renglón; se deja
  por disciplina de alcance, igual que el eslint preexistente de
  `error.middleware.ts:143`.
