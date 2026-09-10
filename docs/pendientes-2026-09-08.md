# Pendientes — Lunes 8 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-06.md` (no hubo archivo
para el 07/09 — la sesión que empujó los sub-bloques 4 y 5 del ADR trabajó
in-place en el de 09-06; el `architecture-governor` lo marcó como desvío menor).
Los ítems cerrados quedan marcados allá in-place, no se repite el detalle acá.

**Alcance de la sesión 07→08/09:**
1. Sub-bloque 4 del ADR común "cancelar con NC" (`ef27e42`): orquestador
   `CancelOrderWithCreditNoteService` + ruta `POST /api/orders/:id/cancel-with-credit-note`
   (`authorize(Roles.EMISOR_NOTA_CREDITO)`) + secuencia N1.a.
2. Sub-bloque 5: (a) F4 en `findBlockingInvoiceLinkage()` **cerrada sin cablear**
   (`af2b2b5`) — divergía de ERPNext/Odoo + estado inalcanzable; (b) reconciliación
   del residual #3 en `registrarDesenlace()` (`20366b1`); (c) cerca de convención
   `reversed_invoice_id` — **mitad de código** (`0baf2b6`).
3. Los 6 commits (`af2b2b5`..`cf47763`) **pusheados y deployados**, CI 5/5 verde
   (job `integration` contra `postgres:16-alpine` incluido — cierra el flake de
   `credit-note-compensation.integration.test.ts` con evidencia local).
4. **Plan total** de cierre del ADR restante + deuda estructural, armado con
   `erp-audit-orchestrator` (lifecycle + dependencias + secuencia) y
   `auditor-circuitos-erp` (grounding ERPNext / Odoo 19 / QloApps):
   `docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`.

**Disciplina de evidencia:** `[V]` verificado contra el árbol real / Postgres real;
`[P]` decisión propuesta, no final; `[H]` hipótesis sin verificar.

**Estado git al abrir:** `app-main` HEAD = `origin/main` = `cf47763` (verificado
`git ls-remote`), working tree limpio. `appfrontend-main` = `613c206`, sin tocar.
Push y deploy = autorización aparte del dueño.

---

## 🔴 Abierto — registrado por primera vez (08/09/2026)

Salen de la auditoría del `erp-audit-orchestrator` sobre el ADR + `pendientes-2026-09-06.md`.
Los tres **estaban registrados** en `pendientes-2026-09-06.md` (el #19 y el #21
como sub-filas del ítem 5, el #20 nunca escalado) y **ninguno llegó a la lista de
trabajo**. Dos son condiciones formales del re-gate del `architecture-governor`.
Modo de falla del incidente del 25/08 (`CLAUDE.md` raíz): lo que queda fuera de la
categoría que alguien relee cada sesión, desaparece del radar.

### #19 — Cerca de arquitectura capa (iv) del ADR · ✅ RESUELTO

`src/tests/architecture/` tiene 4 archivos (`api-auth-gate-order.test.ts`,
`customer-portal-ownership-guard.test.ts`, `lock-order.test.ts`,
`reversed-invoice-id-convention.test.ts`) y **ninguno** impide que
`src/pos-menu/order.service.ts` o `src/reservas/reservation.service.ts` importen
`src/facturacion/cancel-with-credit-note.ts` /
`src/facturacion/cancel-order-with-credit-note.service.ts`.

**La cerca es ESTRECHA, NO una regla de dependency-cruiser `facturacion↔pos-menu`.**
`tsPreCompilationDeps: true` (`.dependency-cruiser.cjs:139`) hace que los
`import type` sí se vean, y hoy hay ~16 imports legítimos
`pos-menu|reservas → facturacion`, incluido
`src/pos-menu/order-cancel-for-credit-note.ts:47`
(`import type { OrderCancelPort } from '../facturacion/cancel-order-with-credit-note.service.js'`
— es el adaptador de puerto del sub-bloque 4, `class OrderCancelForCreditNote implements OrderCancelPort`,
y **debe quedar exento**). Una regla amplia rompería `lint:arch` en esos 16.
La cerca correcta: **`order.service.ts` y `reservation.service.ts` específicamente
no importan el núcleo** (`cancel-with-credit-note.ts` /
`cancel-order-with-credit-note.service.ts`), + conteo de call-sites de
`authorizeCreditNoteCancellation()`, + ausencia de flag de bypass en
`cancelOrder`/`cancelReservation`/`findBlockingInvoiceLinkage`. Patrón
`lock-order.test.ts` (allowlist + `stripComments` + falsos negativos declarados +
prueba de mutación).

Es el sub-bloque 6/7 de B-núcleo+órdenes (`pendientes-2026-09-06.md:715-716`) y
una condición formal del re-gate (ADR §4: *"junto con (i) es lo que realmente
impide el code path"*). **Familia ADR, no deuda estructural.** → bloque 1.2 del plan.

**✅ RESUELTO (08/09/2026, commit `f62278f`, bloque 1.2 del
`plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`).**
`src/tests/architecture/credit-note-escape-containment.test.ts`
(`CN-ESCAPE-CONTAINMENT-001`). Cerró con **5** aserciones, no 3 — el
`architecture-governor` sumó dos condiciones sobre el diseño original:

- **(A)** pasó de "los dos services por nombre" a **deny-by-default**: barrido
  de `src/pos-menu/` + `src/reservas/` enteros, `NUCLEO_IMPORT_ALLOWLIST` con
  motivo (2 entradas hoy: `pos-menu/orders.routes.ts` —la ruta dedicada,
  capa i— y `pos-menu/order-cancel-for-credit-note.ts` —el adaptador de
  puerto—), chequea las dos direcciones (offender no listado / entrada
  stale). `order.service.ts` y `reservation.service.ts` no pueden entrar ni
  al allowlist.
- **(B)** pasó de contar sólo `authorizeCreditNoteCancellation()` a una
  **tabla `ESCAPE_CHOKEPOINTS` de dos filas**: el mint **y**
  `cancelOrderWithCreditNote()`, el ENTRYPOINT de la función de escape. El
  ADR §4 (iv) pide "el conteo de call-sites de **la función de escape**", no
  de la fábrica del token — y el propio ADR (capa iii) dice que el token se
  fabrica con `as unknown as Token` sin pasar por el mint. Contar sólo el
  mint dejaba ese agujero; contar el entrypoint lo tapa.
- **(C.1)** firmas congeladas de `cancelOrder`/`cancelReservation` y los dos
  `findBlockingInvoiceLinkage`. **(C.2)** lista negra de nombres de flag de
  bypass en los dos services (profundidad ante `if (bandera)` en el cuerpo).
- **(D)** NUEVA (no estaba en el diseño de #19): `ESCAPE_ROUTES` — cada ruta
  de escape exige su grupo de autz (`EMISOR_NOTA_CREDITO` para órdenes). Es
  la capa (i); degradarlo a `Roles.ORDERS` no lo ven `rbac-route-coverage`
  ni `rbac-matrix-sync`. Es un array de una fila hoy; B-reservas suma la
  suya.

7 falsos negativos declarados en el docblock, 6 mutaciones probadas (import
del núcleo → A roja; call-site del entrypoint agregado → B roja mientras el
mint sigue en 1; `authorize` degradado → D roja; 3er parámetro en
`cancelOrder` → C.1+C.2 rojas; `if (esEscape)` en el cuerpo → C.2 roja;
allowlist stale → A roja). Cero cambios de código de producción.

**Sub-ítem que salió de acá — ✅ RESUELTO (commit `f86dd66`):**
`app-main/CLAUDE.md` enumera las cercas de la familia RBAC ("segunda /
tercera / cuarta cerca") y qué tocar al cambiar un `authorize(Roles.X)`.
La aserción (D) es una quinta cerca de esa familia y agrega un sexto
artefacto acotado (`ESCAPE_ROUTES`) a sincronizar al tocar el `authorize`
de la ruta del escape — el índice de `CLAUDE.md` quedaba incompleto. Como
`CLAUDE.md` es configuración del proyecto, no entró en el commit de cierre
`c519d98`; se hizo aparte en `f86dd66` con el visto explícito del usuario,
con el contenido pre-especificado por el `architecture-governor`.

### #20 — Test del arqueo (condición 4 del re-gate) · ✅ RESUELTO

Grep `shift_id|CashMovements|arqueo` en
`src/tests/integration/cancel-order-with-credit-note.integration.test.ts`:
**0 hits.** La restricción (i) de N1.a ("el `UPDATE` dirigido sólo toca `status`,
nunca `shift_id`/`payment_method` — un movimiento de caja fantasma") está
implementada vía `settleByIdsWithClient` pero **sin cerca de test**. ADR §10
condición nueva 4: *"tras el escape, el turno `OPEN` no cambia — `getCashMovementsTotal()`
idéntico antes y después"*. → bloque 1.3 del plan.

**✅ RESUELTO (08/09/2026, commit `58edf91`, bloque 1.3).** Un `it()` nuevo en
`cancel-order-with-credit-note.integration.test.ts`: turno `cash_register_shifts`
OPEN + un `PAYMENT` de $500 `CASH` `SETTLED` atribuido → ancla no-vacua
(`expect(antes).toBe(500)`); corre el escape sobre una orden con `CHARGE`
PENDING $100 + Factura B ISSUED; **(a)** `getCashMovementsTotal(shiftId)` sigue
en 500 (el CHARGE revertido no entró al turno) y **(b)** el CHARGE queda
`SETTLED` con `shift_id`/`payment_method` intactos en NULL. `beforeEach` suma
`DELETE FROM cash_register_shifts` (el índice único parcial
`uq_cash_shift_one_open_per_business` rechazaría un 2do OPEN en el test
siguiente).

**Motor de verificación:** local, sin Docker/Postgres → se corrió contra la
rama Neon `test-integration-db` (`br-bold-cell-axuvmork`) vía
`createTestDatabase()` (BD `test_<uuid>` efímera). **CI corre esta suite
contra un service container `postgres:16-alpine`** (`.github/workflows/ci.yml:194`,
`TEST_DATABASE_URL: postgres://testuser:testpass@localhost:5432/postgres` en
`:224`) — no contra Neon. El invariante probado (índice único parcial, FK
`shift_id`, `UPDATE` simple) no depende de la versión de Postgres.

- Baseline: 7/7 verde (6 previos + el nuevo), ~122 s.
- Mutación 1: `settleByIdsWithClient` asigna `shift_id` **y** `payment_method`
  → **(a)** falla `expected 600 to be 500`.
- Mutación 2: asigna **sólo** `shift_id` → **(a)** pasa (el `WHERE` de
  `getCashMovementsTotal` exige `payment_method='CASH'`) pero **(b)** falla
  `expected '<uuid>' to be null`. Las dos mitades de la cerca son necesarias.
- Ambas revertidas con `git checkout --`; `tsc`/`eslint` limpios.

**Falsos negativos declarados:**
1. El camino del outbox **no se ejercita** — la suite no levanta un worker,
   los `domain_events` se persisten y se borran sin procesar. Que el
   `order.cancelled` del escape vaya a `handleOrderCancelled` y no a
   `handleOrderCompleted → settleChargesByOrderId` (`outbox.handlers.ts:397`,
   el que sí asigna turno), y que el `EXISTS (... o.status IN ('COMPLETED'))`
   de `settleChargesByOrderId` bloquee una orden ya `CANCELLED`, son **lectura
   de código**, no cobertura de este test.
2. La aserción **(a)** es conjuntiva (`getCashMovementsTotal` filtra
   `shift_id = $1` **AND** `payment_method = 'CASH'` **AND** `status='SETTLED'`):
   una mutación que inyecte sólo `shift_id` no rompe (a). Esa disyunción la
   cubre **(b)** (aserción separada sobre `shift_id` NULL) — verificado con la
   mutación 2.

**Drift menor detectado de paso (no tocado — anotado para después):**
`schema.sql:2450` cita `settleByOrderId()`, método que ya no existe (hoy
`settleChargesByOrderId`); y el ADR cita `:515-522` para el `CASE` del
`shift_id` de `settleChargesByOrderId`, que hoy está ~`:529-534`.

### #21 — Tope N5 (acumulado por factura revertida) · ✅ RESUELTO (08/09/2026, bloque 2.4)

**Recaracterizado — ya no es "fail-open fiscal" activo.** `buildCreditNote()`
(`src/facturacion/invoice.service.ts:703-878`) no consulta
`getIssuedCreditNoteCompensationTotal()` ni ningún tope antes de armar la NC —
eso sigue siendo cierto. Pero el gate verificó, código en mano, que **hoy no
existe ningún camino en el repo que cree dos filas `financial_transactions`
con el mismo `reversed_invoice_id`** — sin eso no hay dos NC contra la misma
factura, porque cada NC lleva su propia clave `invoice:<financialTransactionId>`.

**Lo contienen 4 propiedades, ninguna con cerca dedicada salvo la primera
(cerrada hoy):**
1. `confirmRefund()` empuja **a lo sumo un chunk por factura** por llamada —
   `cancellation-refund.service.ts:251-262` (`for (const invoice of issuedInvoices)`).
   **Cercado 08/09/2026:** `cancellation-refund.service.test.ts` — test
   `CERCA #21`.
2. `getByReservationId()` (`sql.invoice.repository.ts:473-482`) es un `INNER
   JOIN financial_transactions ... WHERE reservation_id = $1` — nunca ve una
   factura consolidada (`financial_transaction_id IS NULL` a propósito), así
   que una factura alcanzable desde la reserva R no es alcanzable desde R'.
   **No cercado** (requiere DB viva o refactor del repo para inyectar fake).
3. Una segunda `confirmRefund()` de la misma reserva colisiona por
   idempotencia (`refund:cancellation:<reservationId>:<invoiceId>`,
   `:114,:259`, bajo `acquireIdempotencyLock`). **No cercado acá** — ya
   cubierto indirectamente por los tests de reintento existentes en el mismo
   archivo.
4. Solo 2 escritores de `reversed_invoice_id` en todo `src/` (grep, no
   parser): `cancel-order-with-credit-note.service.ts:297` (1:1 por
   `cancel-order-with-cn:<orderId>`) y `cancellation-refund.service.ts:277`.

**Lo que SÍ es un gap real, distinto de "fail-open fiscal":** el cap que
existe hoy (`getRefundableForUpdate()`, `sql.invoice.repository.ts:169-203`)
está anclado al **ledger** (`REFUND` `SETTLED`), no al **comprobante ISSUED**
que exige la doctrina F4 (`invoice.repository.ts:180-184`, "anclado al
comprobante emitido, NUNCA al ledger"). Hoy los dos predicados coinciden
porque hay un escritor por factura (propiedad 1); pueden divergir — ej. una
NC `ISSUED` cuya fila revertidora nunca llegó a `SETTLED` cuenta 0 en el cap
de ledger. Sin escenario que lo explote hoy.

**Corrección (08/09/2026, gate del bloque 3.1): NO se vuelve alcanzable con
3.1 solo.** El bloque 3.1 (`getByReservationId()` → UNION con el camino
consolidado) por sí solo SÍ hubiera vuelto alcanzable el escenario descripto
abajo — pero 3.1 se implementó CON el fail-closed que el ADR §6.1 exigía
junto al UNION (`ReservationOnConsolidatedInvoiceError` en
`cancellation-refund.service.ts`), no el UNION solo. Ese guard corta
`confirmRefund()` ANTES de crear ningún `REFUND` contra una factura
consolidada — así que la propiedad 2 (una factura 1:1 con una sola reserva
para efectos de N5) **sigue conteniendo** después de 3.1. El escenario que
sí la rompería — dos reservas distintas apuntando a la misma consolidada,
`confirmRefund()` llamado una vez por reserva, dos `REFUND` con el mismo
`reversed_invoice_id` — se vuelve alcanzable recién con el **subcaso 2**
(reparto real por-reserva de una consolidada), bloque posterior de
B-reservas, no con 3.1. **2.4 (tope N5) ya aterrizó ANTES que 3.1** (commits
`836afe5`/`8dde715` antes que el bloque 3.1) — el forzado que este párrafo
pedía ya se cumplió por orden de trabajo, y además ya no era estrictamente
necesario para 3.1 en sí (sí lo sigue siendo para cuando aterrice el
subcaso 2).

- **RBAC, hallazgo aparte del gate, no de N5:** `POST /api/invoices` emite NC
  efectivamente (branch `tx.type === 'REFUND'|'ADJUSTMENT'`,
  `invoice.service.ts:357`) bajo `authorize(Roles.FRONT_DESK)`
  (`invoices.routes.ts:78-98`), mientras el escape dedicado de órdenes exige
  `Roles.EMISOR_NOTA_CREDITO`. **No** es un filtro de `type` a agregar —
  filtrar rompería el camino legítimo de facturar REFUND/ADJUSTMENT. Es una
  asimetría de grupo de autz. Ítem propio, cruzado contra
  `docs/rbac-matriz-endpoints.md`, gate propio.
- **NO tocado en este cierre** (fuera del alcance autorizado por el gate):
  el `authorize` de `invoices.routes.ts`.
- **Gate del bloque 2.2 (HOLD sobre `credit_note_request`)** dejó el tope N5
  sin depender de la tabla nueva — ver
  `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5/§10 fila 1.

**✅ RESUELTO (08/09/2026, bloque 2.4, gate `architecture-governor` — diseño
aprobado con 5 condiciones, C1-C5).** `InvoiceRepository.getInFlightCreditNoteTotalForUpdate()`
(`invoice.repository.ts`, `sql.invoice.repository.ts`) — mismo patrón de dos
sentencias que `getRefundableForUpdate()`/`getOutstandingForUpdate()` (lock
puro primero, cómputo después), reusa `NC_LINKAGE_UNION` (fragmento SQL
extraído y compartido con F4 — condición C5). Cuenta NC `ISSUED`+`PENDING`+
`FAILED_UNCERTAIN` (excluye `REJECTED`) contra la factura revertida —
pregunta distinta de F4 ("¿queda cupo?" vs. "¿puedo cancelar?"), **F4 sin
tocarse**. `buildCreditNote()` (`invoice.service.ts:846-861`) lockea la
factura original al principio de su transacción, suma lo en vuelo, y
**lanza** `CreditNoteCapExceededError` (nuevo, `domain/errors.ts`, 409 en
`error.middleware.ts`) si excede `imp_total + CREDIT_NOTE_COMPENSATION_TOLERANCE`
— nunca clamp (N5).

**Tests:** `src/tests/integration/credit-note-cap.integration.test.ts` (11,
mitad SQL: estados contados, rama consolidada, dedup, lock — contra Postgres
real) + `credit-note-cap-service.integration.test.ts` (6, guard completo vía
`requestInvoice()`: concurrencia real con `Promise.allSettled`, boundary de
tolerancia, `REJECTED` no bloquea, reintento no re-evalúa el cap). **5
mutaciones** verificadas a mano (revertir condición, sacar `PENDING`, incluir
`REJECTED`, sacar el lock, sacar la tolerancia) — cada una puso rojo
exactamente los tests esperados, ninguna quedó verde. tsc/lint:arch/eslint
limpios, 1976 tests unitarios sin regresión.

**Condiciones del gate, declaradas en el docblock del método
(`sql.invoice.repository.ts`), NO cerradas en este bloque:**
- **C1 — bypass fail-open de `retryExisting()`:** una NC `REJECTED` se
  excluye del cap a propósito, pero `retryExisting()` (`invoice.service.ts:897-915`)
  puede re-emitir una fila `REJECTED` **sin volver a pasar por
  `buildCreditNote()`** — sin chequeo de cap en ese camino. **Hoy
  inalcanzable** (mismas 4 propiedades que contenían a #21 originalmente).
  **Corrección (08/09/2026, gate del bloque 3.1): NO se vuelve alcanzable con
  3.1** — el bloque se implementó con el fail-closed que el ADR exigía junto
  al UNION (`ReservationOnConsolidatedInvoiceError`), que corta ANTES de
  crear un segundo escritor de `reversed_invoice_id` por factura. Se vuelve
  alcanzable con el **subcaso 2** (reparto real por-reserva de una
  consolidada), bloque posterior de B-reservas. Cerrarlo (¿el reintento
  excluye su propia fila del re-chequeo, o hace falta otro mecanismo?) sigue
  siendo una decisión de diseño aparte — gate propio, ahora con el subcaso 2
  como gatillo en vez de 3.1.
- **C3 — mensaje impreciso en un duplicado de idempotencia concurrente:**
  `getByIdempotencyKey()` en `requestInvoice()` no toma lock; dos llamadas
  concurrentes con el MISMO `financialTransactionId` en una reversión total
  pueden hacer que la perdedora vea `CreditNoteCapExceededError` cuando en
  realidad es un duplicado (choca aparte contra `idx_invoices_idempotency_key`).
  Declarado en el docblock, cubierto por un test que afirma el comportamiento
  observado — no corregido (mover el chequeo de idempotencia adentro de la
  transacción es otro bloque).
- **Query read-only de producción (evidencia #4 del gate) — NO corrida.**
  Requiere credenciales de Neon (OAuth o desencriptar `db_url_encrypted`) no
  configuradas en esta sesión de trabajo. Pendiente antes del gate final de
  cierre del ADR completo — no bloquea el uso del cap (probado exhaustivamente
  contra Postgres real de test), pero el gate lo pidió como evidencia
  explícita y no se lo doy por hecho.

### #22 — Bloque 3.1: `getByReservationId()` UNION + fail-closed en `confirmRefund()` · ✅ RESUELTO Y PUSHEADO (08/09/2026, `3525bde`)

**Resuelto (código, sin push).** `getByReservationId()` (`sql.invoice.repository.ts`)
pasó de INNER JOIN (ciego a facturas consolidadas) a `UNION` de los dos
caminos (individual + `invoice_charges`), espejo de `resolveInvoiceLinkage()`
pero no literal (filtra por `reservation_id`, no por un `financial_transaction_id`
puntual). `confirmRefund()` (`cancellation-refund.service.ts`) gana un guard
fail-closed inmediatamente después de armar `issuedInvoices`: si CUALQUIERA
es consolidada, rechaza TODO con `ReservationOnConsolidatedInvoiceError`
(409) — todo-o-nada, aunque haya también una factura directa reembolsable
(`confirmRefund()` es de un solo tiro por reserva, un reparto parcial
quemaría la idempotencia para siempre).

**5 tests de caracterización de `cancellation-refund.integration.test.ts`
reescritos** (hallazgo #1, W1, W2, W3, W4 — eran 5, no 4 como yo había
asumido inicialmente; el gate corrigió mi lectura de W4: el guard corre
ANTES del chequeo `collected`/`NothingToRefundError`, así que W4 SÍ cambia
de síntoma, de `NothingToRefundError` a `ReservationOnConsolidatedInvoiceError`).
+ 2 tests de dedup (`UNION` vs `UNION ALL`, condición C2 del gate — una
reserva con 2 `CHARGE` distintos facturados en la misma consolidada debe
devolver 1 fila, no 2) + 3 unitarios nuevos en `cancellation-refund.service.test.ts`
(consolidada sola / directa+consolidada mezcladas / regresión negativa solo-directas).
**4 mutaciones verificadas** (`UNION`→`UNION ALL`, sacar el guard, invertir
`=== null`, mover el guard después de `NothingToRefundError`) — cada una
rompió exactamente los tests esperados. tsc/eslint/lint:arch limpios, 1979
tests unitarios + 17 de integración sin regresión (incluido el describe N2
de contaminación, sin tocar).

**Dos huecos fail-open del guard, declarados en el código (`cancellation-refund.service.ts`),
no cerrados:**
1. `financialTransactionId === null` es un **proxy** de "es consolidada", no
   un invariante de base — no hay ningún CHECK que lo ate. Vale hoy porque
   `requestConsolidatedInvoice()` siempre inserta `financialTransactionId: null`
   (verificado, `invoice.service.ts:566`). **Gatillo de revisión:** si algún
   día una consolidada naciera con FT no-nulo, entraría al pool LIFO y se
   repartiría contra el tope GLOBAL de `getRefundableForUpdate()` (el
   defecto N2, ya caracterizado aparte, sin camino de producción).
2. El guard solo ve Factura B (`cbteTipo === CBTE_TIPO_FACTURA_B`, filtro
   previo) — una consolidada de otro tipo sería invisible y volvería al
   `:sin-asignar` de hallazgo #1. **Hoy inalcanzable** (el repo solo emite
   cbte_tipo 6/8). **Gatillo de revisión:** el día que se emita Factura A o C.

**TOCTOU residual, no cerrado:** `acquireIdempotencyLock` serializa contra
otros `confirmRefund()` de la MISMA reserva, no contra
`requestConsolidatedInvoice()` — una consolidada emitida justo después de la
lectura de `issuedInvoices` sigue escapando al guard (FACT-CONSOL-TOCTOU-01,
preexistente, no lo agrava ni lo cierra este bloque).

**Asimetría preview/confirm — declarada, no tocada.** `previewRefund()`
(`cancellation-refund.service.ts:70-82`) no consulta `invoiceRepo` en
absoluto — sobre una reserva con factura consolidada, la pantalla de
preview va a seguir mostrando un monto reembolsable normal y el confirm va a
responder 409. Arreglarlo es una decisión de producto (¿el preview también
debe fail-closed, con qué mensaje?), no alcance del ADR §6.1. Ítem propio,
sin bloquear nada.

**Corrección de 3 documentos que quedaban afirmando lo contrario (gate del
bloque 3.1, 08/09/2026):** `sql.invoice.repository.ts` (docblock de
`getInFlightCreditNoteTotalForUpdate()`), este archivo (arriba, #21 ítem C1
y el bloque de "monto congelado") y `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`
decían que el bloque 3.1 iba a volver alcanzable el bypass C1 del gate 2.4 /
el escenario de N5 — **es al revés**: el fail-closed que 3.1 trae junto con
el UNION reduce, no amplía, el conjunto de escrituras de `reversed_invoice_id`.
Ambos (C1 y el escenario de N5) siguen dependiendo del **subcaso 2** (reparto
real por-reserva de una consolidada), no de 3.1. Corregido en los 3 lugares,
mismo commit que este ítem.

**✅ C7 cumplida (08/09/2026) — push desbloqueado.** Neon conectado vía MCP
(`ancient-king-17098519` / DB-APP-PPMS, org `org-bold-unit-53932069`). Query
read-only corrida contra las dos tenants:

```sql
SELECT COUNT(*) AS filas_alcanzables
FROM invoice_charges ic
JOIN invoices i ON i.id = ic.invoice_id
JOIN financial_transactions ft ON ft.id = ic.financial_transaction_id
JOIN reservations r ON r.id = ft.reservation_id
WHERE i.status = 'ISSUED'
  AND i.financial_transaction_id IS NULL
  AND r.status = 'CANCELLED';
```

| Tenant | Branch | `filas_alcanzables` |
|---|---|---|
| Demo | `production` (`br-snowy-tree-ax5wmq70`) | **0** |
| Hotel los Alamos | `tenant-hotel-los-alamos` (`br-square-leaf-axzvu903`) | **0** |

**Anti-vacuidad** (para que el 0 no sea porque el JOIN no matchea nada, per
la disciplina del `expect(antes).toBe(500)` del bloque 1.3): Demo tiene 28
reservas `CANCELLED` reales y 15 `financial_transactions` con
`reservation_id` — el lado "reserva cancelada" del JOIN tiene datos de
verdad. Lo que da 0 es específicamente `invoices ISSUED` con
`financial_transaction_id IS NULL` (`consolidadas_issued = 0`,
`invoice_charges_total = 0`) — el circuito de facturación consolidada
todavía no se usó en producción, en ninguna de las dos tenants. Alamos está
vacía en las 4 métricas (tenant sin actividad real).

**Conclusión:** el guard nuevo (`ReservationOnConsolidatedInvoiceError`) no
cambia comportamiento sobre ningún dato vivo hoy — cero reservas reales
pasan de reembolsarse a rechazar. Push autorizado.

### #23 — Dos decisiones del dueño para B-reservas (§10 filas 2/3 del ADR) · ✅ TOMADAS (08/09/2026), commit `444b9c7`

Adelantadas fuera de orden a propósito — no bloquean trabajo técnico hoy
(3.4/3.5 siguen esperando otra cosa), pero sacarlas del camino ahora evita
que el próximo bloque de riesgo alto (3.2/3.3) tenga que parar a preguntar.

1. **Pool mixto (§10 fila 2, bloque 3.5): manual, factura por factura.** No
   fan-out automático. Mismo criterio que ERPNext/QloApps (Odoo tiene el
   patrón pero lo tiene apagado para documentos fiscales). Registrado en el
   ADR §10 fila 2 + nueva sección "Decisiones del dueño (08/09/2026)".
2. **`EXPIRED-FACT-01` (§10 fila 3, bloque 3.4): expira + queda registrada
   para revisión.** Ni "nunca expira" ni "el sistema resuelve solo"
   (contradiría §0). **El mecanismo concreto sigue sin definir** — ¿reusa
   `?status=` del bloque 2.1, o necesita algo propio? — eso es alcance del
   gate del bloque 3.4, no de esta decisión.

Ninguna de las dos habilita implementar 3.4/3.5 todavía: 3.4 falta el
mecanismo, 3.5 falta que exista el orquestador de 3.3.

### #24 — `REFUND-ISSUED-RACE-01` (encontrado buscando la carrera de 3.2, no cerrable por ningún lock de fila)

`InvoiceService.finalizeIssued()` (`invoice.service.ts:945`) → `markIssued()`
(`sql.invoice.repository.ts:718-728`, `UPDATE invoices SET status='ISSUED',
issued_at=NOW() WHERE id=$1`) es el **único** escritor de
`invoices.status='ISSUED'` en todo el repo (verificado por grep de
`status\s*=\s*'ISSUED'`/`status:\s*'ISSUED'` en `src/**/*.ts` no-test — un
solo hit de producción). Corre **por el pool (`this.db`), sin `client`,
fuera de toda transacción**, después de la llamada de red a AFIP (mismo
patrón temporal que N10 ya declaraba para el orquestador de órdenes: "la
ventana [TX-A]→[TX-B] dura la llamada de red a AFIP").

**Mecanismo:** `confirmRefund()` lee `issuedInvoices` dentro de su
transacción (`cancellation-refund.service.ts:189`, filtro `status ===
'ISSUED'`) y arma el reparto LIFO + el guard fail-closed de consolidadas
(bloque 3.1) contra esa foto. Si una factura `PENDING` de la misma reserva
pasa a `ISSUED` (AFIP responde) en la ventana entre esa lectura y el COMMIT
de `confirmRefund()`, **no entra a ninguno de los dos**: el monto que le
correspondía cae al chunk `:sin-asignar` (ledger-only, sin Nota de Crédito)
en vez de atarse a la factura real, y si esa factura resulta ser
consolidada, evade el fail-closed de 3.1 sin que nada avise.

**Por qué no lo detecta nada que ya exista:** `RefundBaseChangedError`
(BRECHA-REFUND-01-B) compara `collected` — `markIssued()` no toca
`financial_transactions`, así que `collected` no se mueve y el guard no
dispara.

**Por qué NO es cerrable con un lock de fila:** no hay ninguna fila que
lockear del lado de la escritura — `markIssued()` es un `UPDATE` suelto por
el pool, no una transacción con la que otra pueda serializar vía `FOR
UPDATE`. Cerrarlo de verdad exigiría mover `markIssued()` a una transacción
propia con algún mecanismo de coordinación (lock avisorio por
`financialTransactionId`/reserva, o releer el estado de la factura dentro
del COMMIT final de `confirmRefund()` en vez de antes) — bloque de diseño
propio, no autorizado en esta sesión.

**Alcanzabilidad:** exige que `requestInvoice()` haya arrancado *antes* de
la cancelación de la reserva (después, `invoice.service.ts:407-412`
rechaza) con AFIP todavía en vuelo cuando `confirmRefund()` corre — segundos
contra segundos, misma familia de ventana que RESERVA-10/`EXPIRED-FACT-01`.
No medido en producción (requeriría instrumentar la latencia real de AFIP
vs. la de cancelación+reembolso, no una query).

**Gatillo de reapertura:** si aparece un segundo escritor de
`status='ISSUED'` (hoy no hay ninguno, verificado), o si se prioriza antes
de 3.3 por decisión del dueño.

### #25 — Residual B-1: alcance final confirmado, `recordPayment()` es el lado que falta

Corrección de dos gates `architecture-governor` (08/09/2026, intento de
bloque 3.2, ver `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`
fila 3.2 y `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §N10):
**no se cierra agregando un lock del lado `confirmRefund()`** — ese lado ya
lee `reservations` de forma consistente y `CANCELLED` es terminal; el
interferente que residual B-1 nombra (`pendientes-2026-09-06.md:79-88`) es
`CustomerAccountService.recordPayment()`, que:

1. **No toma ningún lock sobre `reservations`** hoy (acepta `reservationId`
   y lo estampa en la fila que crea, nunca la lee/lockea).
2. **Su camino sin `allocations` es autocommit, sin transacción**
   (`customer-account.service.ts:139`, `this.financialRepo.create({...})`
   directo por el pool) — ni un row lock ni un advisory lock sirven ahí:
   los dos se liberan al terminar la sentencia. Cerrar B-1 de verdad exige
   **transaccionalizar ese camino primero**, no sólo agregarle un lock.
3. **Interferente latente, no registrado hasta ahora en ningún doc**:
   `settleByReservationId()` (`sql.financial-transaction.repository.ts:280-289`,
   `outbox.handlers.ts`, `handleReservationCompleted`) hace `UPDATE ... SET
   status='SETTLED' WHERE reservation_id=$1 AND status='PENDING'`, sin
   filtro de `type`, corriendo en el worker de outbox por el pool, sin lock.
   Hoy es inofensivo **sólo porque ningún camino del repo crea un `PAYMENT`
   en `PENDING`** — el día que exista uno, este worker se vuelve un
   interferente de B-1 que ningún lock del lado request puede frenar, y
   nada avisa. Verificado: 14 sitios de creación de `financial_transactions`
   en `src/` (sin tests); único escritor de `PAYMENT` con `reservation_id` es
   `recordPayment()` (3 sitios: `:144`, `:268`, `:296`), alcanzable por una
   sola ruta HTTP (`customers.routes.ts:852`).
4. **Mecanismo elegido para cuando se encare (3.2-b, NO autorizado ahora)**:
   primitiva nueva `lockById(client, id)` en el puerto `ReservationRepository`
   — sólo `SELECT id FROM reservations WHERE id=$1 FOR UPDATE`, sin hidratar
   el agregado completo (a diferencia de `getByIdWithLock`, que además paga
   2 lecturas por el pool vía `resourceRepository.getById()`/`getLines()` —
   costo innecesario si lo único que hace falta es el lock). Mismo espacio
   de locks que ya usan `invoice.service.ts`/`reservation.service.ts`/el
   worker de expiración — nunca un advisory lock nuevo para este recurso
   (crearía dos mecanismos no interoperables sobre el mismo dato lógico,
   el modo de falla que este ADR viene repitiendo).
5. **Costo declarado**: transaccionalizar el camino sin `allocations` de
   `recordPayment()` es tocar el cobro más frecuente de la app — bloque
   propio, con su propia medición de presión sobre el pool `max: 5` (mismo
   criterio que `POOL-STARV-001`), no un renglón dentro de otro bloque.

**Estado: sigue abierto, redefinido como 3.2-b, sin fecha, no autorizado
en esta sesión.**

### #26 — Grounding `auditor-circuitos-erp` para 3.3 (subcasos 1-2) · ✅ CONSUMIDO por el gate de diseño de 3.3 (08/09/2026)

Detalle completo en `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
§6.3. El gate de `architecture-governor` sobre el diseño de 3.3 tomó los dos
huecos que este ítem señalaba y les dio mecanismo cerrado
(`getInFlightCreditNoteTotalForPairForUpdate()` + tercera rama de
`buildCreditNote()`) — ver plan, fila **3.3-a**. La corrección de lock
ordering también quedó resuelta: bajo el diseño elegido (orquestador nuevo
tipo N1.a) ninguna transacción sostiene lock de `reservations` y de
`invoices` a la vez, así que el cruce que este ítem anticipaba no se
materializa.

### #27 — Tres hallazgos nuevos del gate de diseño de 3.3, sin bloque previo

1. **`handleReservationCancelled` sin reconciliación — costo conocido de `3.3-b`.**
   Órdenes recibió `classifyOrderLiveInvoice` (sub-bloque 5 del ADR,
   `outbox.handlers.ts:61,433,453`) para el residual #3 (un cargo con
   comprobante vivo que el `UPDATE` de anulación no toca). Reservas no tiene
   el equivalente: `handleReservationCancelled(financialRepo)` llama
   `voidByReservationId()` a secas (`outbox.handlers.ts:72,160-168`), y ese
   `UPDATE` excluye filas con comprobante vivo
   (`sql.financial-transaction.repository.ts:390-402`). **Consecuencia:**
   una vez que exista el escape de reservas (`3.3-b`), CADA cancelación con
   NC va a producir `CARGO_CON_COMPROBANTE_VIVO` → `grave` en
   `registrarDesenlace()`, permanentemente — no es un bug de `3.3-b`, es un
   gap preexistente que `3.3-b` vuelve alcanzable por primera vez.
   Bloque **3.3-d**: `classifyReservationLiveInvoice()` + wiring, mismo
   patrón que el de órdenes.

   **Actualización 09/09/2026 (bloque 3.3-b2, gate `architecture-governor`,
   condición C7): esto DEJÓ DE SER HIPOTÉTICO.** 3.3-b1 (orquestador +
   puerto, commit `5a64ae2`, docs de la precondición en `9b8209a`) y 3.3-b2
   (ruta `POST /api/reservations/:id/cancel-with-credit-note`
   + `authorize(Roles.EMISOR_NOTA_CREDITO)` + RBAC completo, commit `b0f9d93`)
   están commiteados localmente. Mientras nada de eso se pushee, el ruido
   sigue sin materializarse en producción — pero **el gate recomienda
   explícitamente NO deployar 3.3-b2 antes de que exista 3.3-d**: desde el
   primer deploy, CADA escape de reserva exitoso va a emitir un
   `logger.error('[outbox] efecto rechazado por anomalía de integridad')` en
   el camino feliz (`outbox.handlers.ts:162-170` vs. `:432-466` del lado
   órdenes) — el mismo mensaje que hoy es la señal real de una "tercera
   puerta" desconocida del lado órdenes; deployar sin 3.3-d le hace perder
   esa señal. Decisión de despliegue del dueño: agendar 3.3-d antes del
   push, o pushear igual asumiendo el ruido operativo declarado acá.

   **Deuda declarada de paso (gate de cierre de 3.3-b2, no bloqueante) —
   ✅ RESUELTO (09/09/2026, gate `architecture-governor`, "la primera"
   recomendación transversal del día).** El catch inline de las dos rutas
   de escape ya NO termina en `else if (err instanceof DomainError)
   res.status(409)` — ambas rutas delegan TODO a `next(err)`/
   `domainErrorStatus()` salvo una única excepción declarada
   (`InvalidReservationError` → 409 en `reservations.routes.ts`, motivo en
   el propio código). Reconcilia 6 códigos alcanzables, no solo los 2 que
   se habían identificado al principio (el research encontró
   `FINANCIAL_TRANSACTION_NOT_FOUND`/`INVOICE_NOT_FOUND` → 404,
   `UNSUPPORTED_IVA_RATE` → 422, `AFIP_PADRON_UNAVAILABLE` → 503, además de
   `AFIP_REQUEST_REJECTED` 409→422 y `AFIP_NOT_CONFIGURED` 422→503).
   **`AFIP_NOT_CONFIGURED` revierte explícitamente la divergencia
   "deliberada" que el gate de cierre de 3.3-b2 había declarado el mismo
   día** — el motivo original ("mantiene los dos escapes simétricos entre
   sí") sobrevive intacto, nunca fue un argumento semántico contra el 503.
   **Reversión declarada de MID-LOG-001:** las dos rutas dejan de loguear
   TODO `DomainError` (incluidos 404) — el middleware solo loguea `>=409`,
   así que un `ORDER_NOT_FOUND`/`RESERVATION_NOT_FOUND` deja de generar
   log. Aceptado (endpoint de bajo volumen, un 404 no es la señal que
   importa perder). Sin consumidor de frontend para ninguno de los 2
   códigos AFIP (0 referencias en `appfrontend-main`, verificado). Ninguna
   otra ruta del repo tenía este patrón — el research sobre los 13
   archivos `*.routes.ts` confirmó que está aislado a estas 2. **Sin
   cobertura de test del mapeo HTTP** (ni antes ni después de este
   commit) — declarado, no una omisión nueva.

   **✅ RESUELTO (09/09/2026, commit `6d55876`, gates de alcance + cierre
   `architecture-governor`).** `InvoiceRepository.classifyReservationLiveInvoice()`
   (espejo de `classifyOrderLiveInvoice()`) + `handleReservationCancelled()`
   ahora recibe `invoiceRepo`/`db` y reconcilia `CARGO_CON_COMPROBANTE_VIVO`
   con el mismo criterio que `handleOrderCancelled()`. **El pasivo queda
   retirado SOLO para el subconjunto "factura DIRECTA (no consolidada) +
   reserva SIN `PAYMENT` propio ni filas anuladas/desconocidas previas en
   `financial_transactions`"** — dos residuales medidos contra Postgres
   real, no cerrados en este bloque:
   1. **Consolidada-parcial** (F4 pregunta por la factura ENTERA, la NC del
      escape es parcial por reserva) → `classifyReservationLiveInvoice` da
      `NOT_RECONCILED` en el camino feliz, medido con test dedicado
      (`C1(i)`, integración real). Cierre: clasificador por PAR
      `(invoiceId, reservationId)`, mismo primitivo que el tope por par de
      3.3-a — bloque de diseño aparte, denominador (neto vs. `imp_total`
      con IVA) a decidir.
   2. **Reserva con un `PAYMENT` propio** (la seña, alcanzable vía
      `CustomerAccountService.recordPayment()` — algo que NO puede pasarle
      a una orden) → `voidByReservationId()` da 2 rechazos
      (`['TIPO_NO_LIQUIDABLE', 'CARGO_CON_COMPROBANTE_VIVO']`, orden fijo
      verificado contra `rechazosDeReserva()`), la guarda ESTRECHA del
      handler (`length === 1`) no dispara, medido con test dedicado
      (`C1(ii)`). Cierre: ensanchar la guarda — bloque propio, cambia
      semántica compartida con `registrarDesenlace()`.

   **Firma de triage para el runbook** (`logger.error`, proceso
   `financial:reservation.cancelled`): `causa: ['CARGO_CON_COMPROBANTE_VIVO']`
   solo → falso positivo conocido (consolidada-parcial, residual 1);
   `causa` incluye `'TIPO_NO_LIQUIDABLE'` → falso positivo conocido (`PAYMENT`
   propio, residual 2); cualquier OTRA combinación con
   `CARGO_CON_COMPROBANTE_VIVO` → señal real de una puerta desconocida,
   igual que del lado órdenes.

   **Mediciones read-only de producción, las 2 tenants (Neon, proyecto
   `ancient-king-17098519`), condición C6 + paso 1 del gate de cierre:**

   | Métrica | Demo (`production`) | Hotel los Alamos |
   |---|---|---|
   | Reservas `CANCELLED` con comprobante fiscal vivo hoy | **0** de 28 (anti-vacuidad real) | 0 de 0 (**vacuo** — tenant sin actividad, no confirma nada) |
   | Reservas con `PAYMENT` propio (`reservation_id`) | **0** | 0 (vacuo) |
   | Reservas con `CHARGE` en factura consolidada (`invoice_charges`) | **0** | 0 (vacuo) |
   | Denominador — reservas con algún `CHARGE` | 15 | 0 (vacuo) |

   **Lectura:** hoy, en datos reales, el subconjunto que queda FUERA del
   pasivo retirado (seña propia o consolidada) está en **0 de 15** en la
   única tenant con actividad — el flujo de seña vía `recordPayment()` con
   `reservationId` existe en el código pero todavía no se usó en
   producción, y tampoco hay facturación consolidada de reservas en curso.
   El residual es real como MECANISMO (los dos tests lo prueban contra
   código, no contra estos datos) pero su TAMAÑO en producción hoy es cero
   — no hay evidencia de que vaya a disparar ruido significativo si se
   deploya ahora. Verificado, no supuesto: si el uso de seña por reserva
   crece, este número hay que remedirlo antes de asumir que el residual
   sigue siendo marginal.

   **Deuda de comentario introducida por 3.3-d, no bloqueante, bloque
   aparte (comment-only, no mezclar con docs):** en `outbox.handlers.ts`,
   el docblock del parámetro `opts` de `registrarDesenlace()` sigue
   diciendo "SOLO lo pasa `handleOrderCancelled`" / "los otros 3 callers no
   lo pasan" — desde `6d55876` son dos callers que lo pasan. El bloque de
   comentario sobre el cálculo de `grave` también razona solo sobre
   órdenes, sin mencionar los dos falsos positivos conocidos del lado
   reservas.

   **Hallazgo de harness, no del bloque:** `describe.skipIf(skipIfNoDb)`
   saltea TODA la suite de integración en silencio si `TEST_DATABASE_URL`
   no está en el entorno del proceso — `vitest.integration.config.ts` no
   carga `.env`. Un pipeline sin esa variable reporta `exit 0` sin haber
   ejecutado nada. No es un bug de 3.3-d, pero hay que tenerlo escrito en
   el runbook antes de confiar en un "CI verde" como evidencia de que esta
   suite corrió.
2. **Punto ciego preexistente en `lock-order.test.ts`, declarado sin arreglar.**
   `LOCK_CALL_RE` (la cerca `LOCK-ORDER-001`) matchea `applyCapped*`,
   `getOutstandingForUpdate(client`, `getRefundableForUpdate(client` — **no**
   matchea `getInFlightCreditNoteTotalForUpdate`/`ForPair`.
   `invoice.service.ts` lockea una fila de `invoices` con ese método y la
   cerca no lo ve. Hoy es lock de una sola factura (sin ABBA posible), así
   que no es explotable — pero el inventario de la cerca queda incompleto.
   No se toca en `3.3-a` (ninguna cerca se edita en ese bloque, es condición
   de aceptación). Anotado para cuando alguien extienda `lock-order.test.ts`
   por otro motivo.
3. **W2 sobre `cancellation-refund.service.ts:271` — bloqueado por falta de
   evidencia de producción, no por decisión pendiente.** El gate confirmó
   que el orquestador de `3.3-b` nace W2-correcto (`ADJUSTMENT.customerId =
   original.customerId`, `buildCreditNote()` ya propaga `tx.customerId` a
   la NC) — lo que NO se toca es el código YA en producción de
   `confirmRefund()`, que asienta el REFUND contra `reservation.customer.id`
   (el huésped) en vez del titular de la factura. Cambiarlo mueve saldo
   entre dos cuentas corrientes en un circuito vivo (C2/D2, plata real) y,
   después del fail-closed de 3.1, `confirmRefund()` solo alcanza facturas
   DIRECTAS — donde no está establecido si `invoice.customerId` diverge de
   `reservation.customer.id` en datos reales. **Antes de decidir, hace falta
   una query read-only de producción** (las 2 tenants) que mida esa
   divergencia. Bloque propio, sin fecha, no depende de 3.3.

### #28 — Bloque 3.3-a: mecanismo de atribución por reserva + tope por par · ✅ RESUELTO (08/09/2026)

`getInFlightCreditNoteTotalForPairForUpdate()` (`sql.invoice.repository.ts`)
+ tercera rama de `buildCreditNote()` (`invoice.service.ts`) + 3 errores
tipados nuevos (`CreditNoteAttributionBlockedError`,
`CreditNoteAttributionMismatchError`, `CreditNotePairCapExceededError`).
Detalle del mecanismo en `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
§6.3, fila del plan actualizada. Gate `architecture-governor` con una
corrección obligatoria aplicada antes de cerrar: el método del tope por par
no tomaba su propio `FOR UPDATE` (dependía de que el caller ya hubiera
lockeado la fila) — corregido para que sea autocontenido, coherente con su
propio nombre.

**Evidencia:** unit (`invoice.service.test.ts`, 6 tests nuevos, 1985/1985
sin regresión) + integración real contra Neon `test-integration-db`
(`credit-note-pair-cap.integration.test.ts` nuevo, 3 tests, + 57/57 en las 7
suites hermanas de la misma familia) + 4 mutaciones verificadas y
revertidas + query read-only de producción (las 2 tenants, `count=0`).

**Declaraciones del gate, registradas:**
1. **Anti-vacuidad sólo corrida en Demo**, no en Alamos (ahí sólo se corrió
   el `count=0` simple). El motivo real del 0 en Demo es más fuerte de lo
   que "el JOIN no matchea" sugeriría: la tenant **no tiene ningún
   `ADJUSTMENT`** todavía (`adjustments_total=0`), no sólo ninguno con
   `reservation_id`+`reversed_invoice_id` juntos.
2. **Asimetría de observabilidad.** La rama N3 (reversión total) tiene un
   `logger.warn` si `Σ subtotal` no cierra con `impNeto`/`impTotal` de la
   factura original. La rama nueva (parcial por reserva) no tiene
   equivalente — no es incorrecto (la invariante se sostiene por
   construcción del reparto de `resolveRefundableForPair()`), pero es una
   asimetría a tener presente si se audita esa rama más adelante.
3. **`NO_ITEMS` de `resolveRefundableForPair()` es inalcanzable** desde este
   call-site (el branch ya exige `originalItems.length > 0` antes de
   llamarla) — sin test dedicado en `invoice.service.ts`, sólo cubierto en
   `refund-attribution.test.ts` (unit puro de la función).
4. **C1** (bypass de `retryExisting()` sobre una NC `REJECTED`, ver #21)
   **sigue inalcanzable.** 3.3-a no introduce un segundo escritor por
   factura — eso recién pasa con el orquestador de `3.3-b`, y aun ahí queda
   un solo escritor por PAR, no por factura.
5. Los tests de integración de este bloque no corren en CI —
   `TEST_DATABASE_URL` a mano, "verificado una vez, localmente, hoy", mismo
   criterio que el resto de esta familia (`FOR-KEY-SHARE-001`,
   `REFUND-INT-GUARD-001`).

### #29 — Gate de diseño de 3.3-b (orquestador de reservas) — 🟢 PRECONDICIÓN RESUELTA (09/09/2026)

Gate `architecture-governor` sobre el diseño del orquestador
`cancelReservationWithCreditNote()`. **APROBADO CON CONDICIONES, partido en
3.3-b1/3.3-b2, y con una PRECONDICIÓN BLOQUEANTE que nadie corrió todavía**
(este subagente no tiene acceso a Neon). Detalle completo del diseño en
`diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.6; fila del plan
partida (`plan-cierre-...md`, filas 3.3-b/3.3-b1/3.3-b2).

**Lo primero que hay que hacer, antes de escribir una línea de 3.3-b1** — dos
queries read-only vía Neon MCP, las 2 tenants:
1. `SELECT prices_include_iva FROM business_profile;` — si alguna tenant da
   `FALSE`, **PARAR y volver al gate**: `splitAmount()` con esa config da
   `impTotal = amount*(1+tasa)`, así que `Σcargos` (neto) ≠ `impTotal`/
   `attributedTotal` (bruto) y el escape de reservas quedaría inutilizable
   ahí — y esto **también aplicaría al escape de ÓRDENES ya deployado**
   (`cancel-order-with-credit-note.service.ts:291`+`:737`), que sería su
   propio bloque, no se resuelve dentro de 3.3-b.
2. Distribución de reservas por cantidad de facturas vivas `ISSUED` sobre
   sus cargos, y por cantidad de cargos — CON anti-vacuidad explícita
3. **Grounding `auditor-circuitos-erp` pendiente** (09/09/2026, pedido
   explícito del dueño) — el gate de 3.3-b resolvió esto SOLO por
   razonamiento contra el código de `app-main` y el precedente de órdenes,
   sin cruzarlo contra ERPNext/Odoo/QloApps. Punto concreto a llevarle:
   ¿qué hace cada referencia cuando el escape de cancelar-con-NC se topa
   con **más de una factura viva** para la misma unidad, sin que el
   operador haya pedido pool mixto? El gate de 3.3-b decidió "rechazar sin
   llamar a AFIP" (fail-closed) — es distinto de la pregunta YA groundeada
   ("cómo repartís entre varias facturas", resuelta en el gate de subcaso 3
   con manual/factura-por-factura). **Hacer esto al ARRANCAR 3.3-b1**, antes
   de las dos queries de arriba o en paralelo — decisión del dueño
   (09/09/2026): parte de lo que se revisa en esa sesión, no ahora.
   (denominadores, no solo el resultado; mismo criterio que ya se aplicó en
   3.1/3.3-a: si da 0, probar que es porque no hay actividad de ese tipo,
   no porque el JOIN esté mal armado).

**✅ PRECONDICIÓN CUMPLIDA (09/09/2026) — las 3 partes, evidencia real:**

1. **`prices_include_iva`, las 2 tenants vía Neon MCP (proyecto `ancient-king-17098519`):**
   Demo (`br-snowy-tree-ax5wmq70`) = **TRUE**; Hotel los Alamos
   (`br-square-leaf-axzvu903`) = **TRUE**. Ninguna da `FALSE` → **no** se activó
   el PARAR del gate; el problema de `splitAmount()` neto≠bruto que hubiera
   invalidado también el escape de órdenes ya deployado no aplica hoy.
2. **Distribución de reservas por facturas vivas ISSUED y por cargos, con
   anti-vacuidad (mismo criterio que 3.1/3.3-a — denominadores, no solo el
   resultado):**
   - Demo: 42 reservas totales (28 `CANCELLED`), 15 con al menos un cargo
     `CHARGE` (**las 15 con exactamente 1 cargo, ninguna con más**), 12 con al
     menos una factura `ISSUED` vinculada (**las 12 con exactamente 1 factura
     viva**, `reservations_with_multiple_live_invoices = 0`). Denominadores no
     triviales (42/15/12) — el 0 de "múltiples facturas vivas" es real, no un
     JOIN mal armado.
   - Hotel los Alamos: las 4 métricas en 0 — tenant sin actividad real, mismo
     patrón ya declarado en sesiones previas (no es hallazgo nuevo).
   - **Conclusión:** hoy no existe en ninguna tenant una reserva con más de
     una factura viva — el escenario "pool mixto" que el gate fail-closea es
     inalcanzable en datos reales de producción, igual que en 3.1/3.3-a.
3. **Grounding `auditor-circuitos-erp`** (pedido explícito del dueño,
   09/09/2026) — pregunta: qué hace cada referencia cuando el escape de
   cancelar-con-NC se topa con >1 factura viva sin pool mixto pedido.
   - **ERPNext:** `make_return_doc()` (`sales_and_purchase_return.py:450`)
     toma un `source_name` singular (`return_against` de un solo valor,
     `:473`); no hay acción a nivel Sales Order sobre "todas las facturas
     vivas". `sales_order.py::on_cancel` → `check_nextdoc_docstatus()` (`:494`)
     **rechaza toda la cancelación** si CUALQUIER documento vinculado sigue
     `docstatus=1` (vivo), sea uno o varios — sin elegir, sin heurística.
     Validación 100% local, sin llamada fiscal externa antes del bloqueo.
   - **Odoo 19.0:** `sale.order._action_cancel()` (`sale_order.py:1332`) solo
     cancela facturas `draft`; una o varias facturas `posted` (vivas) quedan
     **ignoradas en silencio** — no bloquea, tampoco genera NC ni pregunta. Es
     el mismo hueco ya conocido como ORDER-10. El wizard `account.move.reversal`
     sí acepta selección múltiple (`move_ids` Many2many) y hace fan-out en
     batch — pero sólo si el usuario ya seleccionó explícitamente varias
     facturas en la UI, nunca por heurística implícita del sistema.
   - **QloApps:** mismo patrón manual que ERPNext (una factura concreta a la
     vez desde la pestaña Invoices) — sin cita de código, no está en las
     rutas locales de referencia.
   - **Conclusión del grounding:** las 3 referencias coinciden en que "sobre
     qué factura actuar" es siempre decisión explícita del operador, nunca
     una heurística implícita — ninguna hace la llamada fiscal antes del
     bloqueo/selección. La diferencia real es ERPNext (bloquea toda la
     operación, ruidoso) vs. Odoo (ignora en silencio, el patrón que generó
     ORDER-10). **El fail-closed del gate del 08/09 adopta el extremo
     ERPNext** — el más maduro/estricto de las tres, no "más estricto que la
     industria en general".

Con esto **3.3-b1 queda desbloqueado para empezar** — ninguna de las 3
respuestas fuerza volver al gate de diseño.

**✅ #29 CERRADO (09/09/2026).** 3.3-b1 (commit `5a64ae2`: orquestador
`CancelReservationWithCreditNoteService` + puerto `ReservationCancelForCreditNote`,
21 unitarios + 4 integración contra Neon real + 4 mutaciones, suite
2006/2006) y 3.3-b2 (commit `b0f9d93`: ruta `POST /api/reservations/:id/cancel-with-credit-note`
+ RBAC completo, 2 mutaciones, suite 2013/2013) los dos resueltos y
commiteados localmente, cada uno con gate de diseño + gate de alcance +
gate de cierre del `architecture-governor`. **Actualización 09/09/2026:
3.3-d también resuelto** (commit `6d55876` — ver #27 ítem 1, arriba, con
las mediciones de producción). **Sin push, sin deploy** — `origin/main`
sigue en `e1b70bb`, ahead 6 (`d6f35a9`/`5a64ae2`/`9b8209a`/`b0f9d93`/
`766eb84`/`6d55876`). Decisión de push/deploy: del dueño, con la
recomendación del gate de cierre de 3.3-d en el ítem 1 de #27 (el residual
ya no es "desconocido", pero su tamaño en producción está medido en 0 —
igual conviene tener escrita la firma de triage del runbook antes de
pushear).

---

**Texto original de la precondición, dejado como referencia (ya cumplida):**

**Recién con las dos respuestas conformes**, criterio de cierre de 3.3-b1
(orquestador + puerto, SIN ruta, SIN `authorize`, inalcanzable en
producción por construcción — mismo criterio que 3.3-a):
- **12 casos unitarios**: directa→total; consolidada 2 reservas→parcial (el
  cargo de la reserva AJENA queda `PENDING` — éste es *el* test del
  bloque); 0 facturas vivas→error tipado; **>1 factura viva→error tipado
  fail-closed SIN llamar a AFIP** (es pool mixto, 3.5); `AfipRequestUncertainError`
  →reserva NO cancelada; rechazo AFIP→error tipado; NC no `ISSUED`→pending;
  fast-path idempotente (`emitted:false`); camino `ON CONFLICT`+re-read;
  assert "el ADJUSTMENT idempotente revierte la misma factura"; re-verificación
  de tx2→error tipado si la ventana tx1→tx2 dejó una factura nueva sin
  cubrir; subcaso directa con REFUND parcial previo→`CreditNoteCapExceededError`.
- **1 integración** contra Postgres real: consolidada 2 reservas, AFIP
  stubeado, aserciones SQL crudas (cargos ajenos `PENDING`, cargos propios
  `SETTLED`, `ADJUSTMENT` `SETTLED`, `invoice_items`/`Iva[]` de la NC solo
  de la reserva cancelada, y `voidByReservationId()` corrido DESPUÉS no
  anula ninguna fila ya settleada).
- **4 mutaciones obligatorias, cada una con su test rojo identificado**: (i)
  sacar la intersección del settlement; (ii) calcular el monto desde
  `attributedTotal` en vez del ledger congelado — **si esta mutación no
  pone nada en rojo, el bloque NO cierra** (significa que el cross-check de
  3.3-a quedó vacuo); (iii) sacar el `NonNullable` de `getByIdWithLock`;
  (iv) sacar la re-verificación de tx2.
- `tsc`, `lint:arch`, `credit-note-escape-containment.test.ts` (asegurando
  que `NUCLEO_MODULES` incluya el archivo nuevo — si no, la cerca deny-by-default
  queda ciega a este orquestador sin que ningún test se ponga rojo),
  `lock-order.test.ts`, suite unitaria completa sin regresión (baseline:
  1985).
- Declaraciones con ancla a registrar: el `grave` operativo por
  `CARGO_CON_COMPROBANTE_VIVO` hasta que exista `3.3-d`
  (`outbox.handlers.ts:326-329`); la ventana tx1→tx2 y su guard; el
  resultado de `prices_include_iva`; la decisión de `stay_id`; el borde de
  la consolidada al 100%.

**3.3-b2** (ruta + `authorize(Roles.EMISOR_NOTA_CREDITO)` + RBAC completo —
`ESCAPE_ROUTES`+1, `ESCAPE_CHOKEPOINTS` fila nueva, `NUCLEO_IMPORT_ALLOWLIST`+2,
`EXPECTED_AUTHORIZE_CALL_SITES` 205→206, `rbac-matriz-endpoints.md`) —
**gate propio, no lo empieces hasta que 3.3-b1 esté cerrado y commiteado.**

---

## ✅ B-núcleo+órdenes — CERRADO (gate final `architecture-governor`, 08/09/2026)

El escape para cancelar una **orden** con Factura B viva emitiendo una Nota de
Crédito (ADR `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`). Gate
final aprobado con `HEAD` = `origin/main` = **`2839beb`**, CI 5/5 sobre ese
commit (incl. `integration` contra `postgres:16-alpine`) — esto último
verificado por el `architecture-governor` con `git ls-remote` y `gh run view`.
**La identidad del deploy de producción (Render `dep-dag164e7bikc73epihq0`,
commit `2839beb`, live) la estableció el reporte de sesión, NO el governor**
(no tuvo tooling de Render en el gate). `/health` es sólo liveness
(`src/app.ts:215`, nunca 503 por BD) y el chequeo de versión de schema por
tenant es fail-soft (`tenant.middleware.ts:83-97`, sólo `logger.warn`), así que
un prod sano no prueba por sí solo que las tenants estén en v47 — eso lo
sostiene el registro detallado del bloque 1.1 (ver bullet #1) + `render.yaml`
terminando en `migrate:tenants` bajo R15 (un deploy live implica que la
migración corrió).

**Estado real de las 7 condiciones del re-gate (ADR §10, líneas 578-584) — el
mapeo corregido en el gate final; el de `pendientes-2026-09-06.md:721-735` era
el bueno, el bullet de más abajo de este archivo lo tenía mal):**

| # | Sujeto (ADR §10) | Estado | Ancla |
|---|---|---|---|
| **1** | no-regresión del camino `REFUND`, fijando `getOutstandingForUpdate`/`getRefundableForUpdate`/`getOutstandingByCustomerId` antes/después con un `REFUND` positivo | **Satisfecha por corrida de regresión, NO por un test dedicado.** `ad4d236` declara 32/32 integración contra Postgres real. Las tres funciones quedan cubiertas de forma incidental y en archivos distintos — limitación a tener presente cuando 1.4 toque el `UNION ALL` vecino. | `ad4d236` (mensaje) |
| **2** | query read-only por tenant (0 filas no conformes) | HECHA (`ad4d236`) y **superada** por la verificación de producción del bloque 1.1 (0 filas no conformes en las 2 tenants). | bullet **"#1 — CHECK `chk_financial_transactions_reversed_invoice_type`"** en la sección de deuda de este archivo (`3bcf5ab` + deploy `dep-daftmg15efls73b7jon0`) |
| **3** | cerca de la convención `reversed_invoice_id` (mitad datos + mitad código) | **HECHA, las dos mitades.** Datos: CHECK `chk_financial_transactions_reversed_invoice_type` (`schema.sql:3023`, schema v47, bloque 1.1, verificado en prod). Código: `reversed-invoice-id-convention.test.ts` (docblock a v47, FN declarados). | `3bcf5ab`, `0baf2b6` |
| **4** | test del arqueo | **HECHA.** Bloque 1.3, `58edf91`. `cancel-order-with-credit-note.integration.test.ts:344-390` — ancla no-vacua `expect(antes).toBe(500)`, aserciones (a) `getCashMovementsTotal` idéntico y (b) CHARGE `SETTLED` con `shift_id`/`payment_method` NULL. 2 mutaciones probadas, 2 FN declarados, verde en CI real. | `58edf91` |
| **5** | ventana del Defecto A — el guard sigue bloqueando | **VACUA del lado órdenes → REASIGNADA a B-reservas.** `order.service.ts:416-427` (`findBlockingInvoiceLinkage`) **no cablea F4** (`af2b2b5`), así que "sigue bloqueando" es verdad por construcción. F4 sí se cablea en `reservation.service.ts` (B-reservas) — ahí la condición tiene contenido. | — |
| **6** | test de `getOutstandingByCustomerId` tras compensación total | **HECHA.** `cancel-order-with-credit-note.integration.test.ts:308-318` (comentario `re-gate condición 6`), `expect(outstandingInvoices.find(i => i.id === invoiceId)).toBeUndefined()`. **NO confundir con el "sub-bloque 6" de §4** (la cerca de arquitectura capa iv) — son cosas distintas, las dos hechas. | `cancel-order-with-credit-note.integration.test.ts:308` |
| **7** | un `REFUND SETTLED` sin NC no destraba el guard | **MITAD REPOSITORIO hecha; MITAD GUARD vacua → mismo estado que la 5.** Traza de callers: `getIssuedCreditNoteCompensationTotal` (F4) tiene **un solo** consumidor de producción (`sql.invoice.repository.ts:382`) y **ningún** `findBlockingInvoiceLinkage` lo llama — así que hoy ningún estado de ledger puede destrabar el guard, por construcción. Los tests `credit-note-compensation.integration.test.ts:148,157` prueban que **el predicado del repositorio** devuelve 0 (su propio docblock `:17-19` lo dice: "a nivel repositorio"). El cierre a nivel guard se reasigna a B-reservas. | `credit-note-compensation.integration.test.ts:148,157` |

**Sub-bloque 6 de §4 (la cerca de arquitectura capa iv)** — HECHA: bloque 1.2,
`f62278f`, `credit-note-escape-containment.test.ts` (`CN-ESCAPE-CONTAINMENT-001`),
5 aserciones. Es un ítem DISTINTO de la condición 6 del re-gate (ver fila 6).

**Los 10 puntos del primer gate**: consumidos como correcciones de ADR ya
aplicadas (F1..F6, redacción de la capa (iii), la limitación aceptada de §7, la
justificación del `Math.abs`) — ADR línea 573. Ninguno abierto.

**Deuda que sale de este gate (bloques propios, no bloquean el cierre):**
- **Contradicción de doctrina en el predicado que este gate certificó**:
  `sql.invoice.repository.ts:317-318` todavía dice que el hueco cruzado está
  "registrado como bloqueante de B-reservas" — el ADR N2.a lo resolvió como
  doctrina (NC↔factura 1:1). Un comentario adentro del predicado de F4
  contradice el ADR. → lo saca el bloque **1.4** (mismo predicado).
- **`EMISOR_NOTA_CREDITO` invisible en el panel** — ver fila nueva abajo.
- **`reservation.cancel-confirmed.test.ts`** — falla determinística en bordes
  exactos, ver fila nueva abajo.

---

## ✅ Correcciones de estado aplicadas a `pendientes-2026-09-06.md` (in-place, 08/09)

- Gate final de B-núcleo+órdenes: **ver la sección "B-núcleo+órdenes — CERRADO"
  de arriba** para el estado corregido. Lo que este bullet decía antes —
  "condiciones 6 y 7 marcadas HECHAS, faltan 3, 4, 5" — quedó **mal en dos
  puntos**: (a) mezclaba la condición 6 del re-gate (test de
  `getOutstandingByCustomerId`, sí hecha) con el sub-bloque 6 de §4 (cerca de
  arquitectura); (b) la condición **7 es mitad-repositorio**, su mitad-guard es
  vacua igual que la 5 y se reasigna a B-reservas. Con 1.1/1.2/1.3 cerrados,
  **3 y 4 pasaron a HECHAS**; quedan reasignadas 5 y 7 (mitad guard).
- Verificaciones que quedaron abiertas y ahora cerradas por lectura de código:
  (1) el residuo "crash entre AFIP-OK y tx2" **autosana** re-invocando el escape
  (fast-path exige `CANCELLED`, `cancel-order-with-credit-note.service.ts:156-157`
  → cae a tx1 → reusa `existing` `:248` → `retryExisting()` devuelve la NC ya
  ISSUED sin re-emitir, `invoice.service.ts:897-899`); (2) el frontend gatea
  `POST /api/invoices` a `type === 'CHARGE'` en los dos call-sites.

---

## 🟠 Deuda menor detectada (08/09)

- **CI: techo "19 suites" stale → son 24.** ✅ RESUELTO (bloque 0.1 del plan,
  08/09): `.github/workflows/ci.yml` — comentario del job `integration`
  actualizado 19→24, contando con el **mismo glob recursivo que corre CI**
  (`vitest.integration.config.ts:25`,
  `find src/tests/integration -name '*.test.ts' | wc -l`), declarado que el
  número es a mano y qué lo desactualiza (suite nueva bajo
  `src/tests/integration/`, subcarpetas incluidas). `timeout-minutes: 20` sin
  cambio (~10x margen: única corrida medida = 22 suites / 104 s contra
  `postgres:16-alpine` local, `zulu-hub-continuidad-2026-09-07.md`). Continuidad
  09-07 reconciliada in-place. Pendiente opcional: cerca que cuente los archivos
  con ese glob + `stripComments` y falle si el comentario diverge (patrón
  `EXPECTED_AUTHORIZE_CALL_SITES`) — bloque aparte.
- **Comentario stale en `src/facturacion/sql.invoice.repository.ts` ~`:314-318`:**
  dice que el hueco cruzado de F4 está *"registrado como bloqueante de B-reservas"*.
  El ADR N2.a lo resolvió como doctrina. Corregir junto con el bloque 1.4 (3-ter).
  — ✅ RESUELTO con el bloque 1.4 (`94ac18e`, ítem 0.4 del plan): reescrito a
  doctrina N2.a + guard **nunca en los services (F5)** + "hoy no hay exposición
  de ESTE hueco"; también se corrigieron el "ESPEJO EXACTO" (espeja caminos, no
  predicados) y "rama 2 defensiva".

- **#2 — 3-ter: filtro `cbte_tipo` en la subquery `nc` de F4** — ✅ RESUELTO
  (bloque 1.4 del plan, `94ac18e`, 08/09). `getIssuedCreditNoteCompensationTotal`
  filtraba compensación desde CUALQUIER comprobante colgado de una FT revertidora;
  una Factura B mal vinculada inflaba el total → fail-OPEN (cancelación sin NC
  real). Ahora filtra `nc.cbte_tipo = ANY(CBTE_TIPOS_NOTA_CREDITO)` en el WHERE
  externo (las 2 ramas del `UNION ALL` seleccionan la columna). Constante nueva
  en `afip-catalog.constants.ts`, no `= 8` literal. Tests: invariante de la
  constante + forma de query + routing de `invoice.service.ts:357` + 3 de
  integración (Factura B rama 1 / rama 2 / mixta → F4 da 0/0/sólo-la-NC).
  Mutación probada; **no-regresión OBSERVADA** (0 filas afectables en las 2
  tenants de prod). **Preventivo, no correctivo.** Contexto de dependencia:
  `#2 3-ter ──▶ #5 subcaso 2` (la rama consolidada de F4 se vuelve real en
  B-reservas).

- **#1 — CHECK `chk_financial_transactions_reversed_invoice_type` (schema v46→v47)**
  — ✅ RESUELTO (bloque 1.1 del plan, `3bcf5ab`, 08/09, pusheado + deployado +
  verificado). `CHECK (reversed_invoice_id IS NULL OR type IN ('REFUND','ADJUSTMENT'))`
  sobre `financial_transactions`. Cierra la **mitad de datos** de la condición 3
  del re-gate (la mitad de código = `reversed-invoice-id-convention.test.ts`,
  `0baf2b6`).
  - **Ensayo** en rama descartable `ensayo-v47-2026-09-08` (`br-morning-math-axljb1yc`,
    copia de producción Demo con 20 FT reales): CHECK aplicado + def correcta;
    `INSERT type='CHARGE'` + `reversed_invoice_id` → **rechazado** (`23514`);
    filas `REFUND`/`ADJUSTMENT` + `reversed_invoice_id` y `CHARGE`/`REFUND` + NULL
    → OK; **`schema.sql` completo reaplicado con las filas revertidoras presentes
    → sin error**, `convalidated: true`.
  - **Deploy** `dep-daftmg15efls73b7jon0` (live). `[migrate-tenants] Versión
    objetivo: v47` → `✅ biz-demo-01 — migrado a v47` + `✅ cd6cd508… — migrado a
    v47` (los dos "migrado", no "ya estaba al día"). Verificación de producción:
    `pg_get_constraintdef` = la def esperada en las 2 tenants; 0 filas no
    conformes en las 2; `schema_migrations MAX = 47` en las 2;
    `businesses.schema_version = 47`: cerrado por construcción, no solo por el
    log. `migrate-tenants.ts:65` corre
    `platformRepo.updateSchemaVersion(business.id, 47)` con el `business.id` que
    salió de `platformRepo.listAll()` sobre esa misma tabla en la misma corrida
    (`:50,:56`), así que el `UPDATE businesses SET schema_version WHERE id = $2`
    no puede matchear 0 filas. (El log `✅ migrado a v47` prueba "no tiró
    excepción", que por sí solo no descarta un `UPDATE` de 0 filas —
    `updateSchemaVersion` no chequea `rowCount`; lo que lo descarta es el
    origen del id.) Corroboración empírica: si el puntero no se hubiera movido,
    `tenant.middleware.ts:91` estaría logueando un warning por request en el log
    de runtime de Render post-tráfico — no aparece. Sin filas `ensayo-v47-*` en
    producción (0 en Demo). Ningún ALTER a mano contra producción — lo hizo el
    deploy vía `migrate:tenants`.
  - **Ramas Neon (runbook — registrar propósito/origen/estado):**
    · `respaldo-pre-v47-demo-2026-09-08` (`br-steep-sunset-axxvv9il`) — backup
      durable, desde `production` (Demo) @ LSN `0/478E368` / 09:39 UTC 08/09,
      `no_compute`. **Punto de retorno pristino, NO tocar.**
    · `ensayo-v47-2026-09-08` (`br-morning-math-axljb1yc`) — rama de ensayo,
      desde `production` @ mismo LSN, con compute. Ya cumplió su función; borrable
      cuando se cierre el bloque.
    · Alamos: sin backup — 0 filas, 0 FT; un backup de tabla vacía no da punto de
      retorno útil. Declarado.
    · Se borró `ensayo-v46-served-at-2026-09-03` (`br-calm-mode-ax1ltup4`) para
      liberar un slot (límite de 10 ramas del proyecto Neon), **autorizado
      explícitamente por el usuario para esa rama puntual**. Era el ensayo del
      bump v45→v46 (columnas de sello de `orders`), en producción desde el
      03/09. **Registro incompleto contra el runbook** (falta LSN/origen,
      resultado del ensayo y estado final — los 4 que el runbook pide antes de
      borrar); la rama ya no existe, no se recupera. Nota de proceso: la próxima
      vez que un límite de slots fuerce un borrado, capturar los 4 antes.
  - **Rollback declarado en el commit** (`3bcf5ab`): no es "git revert y listo"
    — el revert deja el constraint vivo + `schema_version` en 47 → warning por
    request. Rollback real = re-landear, o dropear el constraint a mano en las 2
    tenants + bajar `schema_version`.
- **`MID-LOG-001`** — ✅ RESUELTO (bloque 0.2 del plan, 08/09).
  `src/api/middleware/error.middleware.ts`: política declarada — todo `DomainError`
  que mapea a `>= 409` (carreras, reglas de negocio, dependencia externa, code sin
  mapeo) se loguea `warn` con `{ code, status, method, url, businessId }`, **nunca
  `err.message`** (trae ids/montos/razón social, A7.1). Los 4xx de cliente
  rutinario (400/401/403/404) no. Reemplaza el special-case de
  `REFUND_BASE_CHANGED`.
  - `domainErrorStatus` gana los 5 codes del escape
    (`CREDIT_NOTE_CANCELLATION_PENDING`/`_ISSUED_ORDER_NOT_CANCELLABLE` → 422;
    `CREDIT_NOTE_CANCELLATION_REJECTED`/`CREDIT_NOTE_MULTI_INVOICE`/`ORDER_INVOICE_HAS_NO_LINES`
    → 409, alineados con el ladder inline de la ruta). Antes caían al `default:`
    → 500 + "sin mapeo".
  - **El escape (`POST /api/orders/:id/cancel-with-credit-note`) resuelve el
    error inline y NO pasa por el middleware** → `orders.routes.ts` gana un
    `logger.warn({ code, orderId, businessId })` al tope del `catch` para
    `DomainError` (endpoint de bajo volumen, se loguea todo fallo). Esto es lo
    que hace visible la rama D1 del ADR §7.
  - `url` = **path solo** (`req.originalUrl.split('?')[0]`) — A7.2: `GET
    /api/customers` todavía recibe `email`/`name` por query string (deuda
    pre-existente); el path solo lleva el id de recurso. Umbral `>= 409`:
    403/402 excluidos **a propósito** (autz va a `audit_log`; 402 es upsell),
    dicho en el comentario para que no se lea como accidente numérico.
  - `ORDER_STATE_UNKNOWN` también agregado al 409 (misma familia — inline como
    409 en 4 sitios de `orders.routes.ts`, antes caía al `default:` → 500).
  - Test: `error.middleware.test.ts` nuevo (8) — 422/409 se loguean con la
    forma exacta y sin `message`; 404/400 no; code sin mapeo → 500 +
    `logger.error` una vez; sin `req.user` → `businessId: null`; **query
    string nunca viaja al log**; `ORDER_STATE_UNKNOWN` → 409.
  - **Divergencias ladder inline vs `domainErrorStatus`** (pre-existentes del
    sub-bloque 4) — **✅ RECONCILIADAS (09/09/2026)**, ver el ítem
    "Deuda declarada de paso" más arriba (búsquedalo por
    "gate de cierre de 3.3-b2") para el detalle completo: las dos rutas de
    escape (órdenes y reservas) ahora delegan a `error.middleware.ts`, con
    una única excepción declarada del lado reservas.
  - **Deuda que queda — ✅ RESUELTA (09/09/2026):** las dos políticas de
    logging que convivían (el escape logueaba todo `DomainError` incl. 404,
    el middleware solo `>= 409`) quedaron unificadas en la del middleware —
    reversión declarada, no una equivalencia (los 404 de estas 2 rutas
    dejan de loguearse). La convención "todo `*.routes.ts` delega los
    `DomainError` al middleware salvo divergencia declarada" no se volvió
    una cerca de arquitectura (el gate lo dejó fuera de este commit) — hoy
    es cumplida de hecho por las 13 rutas del repo (las otras 11 ya
    delegaban), no forzada por ningún test.
- **Lectura por el pool del repo en vez de por `client`** en
  `cancel-order-with-credit-note.service.ts` — ✅ RESUELTO (bloque 1.5, `3608edf`
  código + declaración en `c4aac3c` + corrección de anclas en el commit
  siguiente). **Son 6 sitios, no 2** (números al HEAD de `c4aac3c`+corrección):
  `getByIdempotencyKey` en la rama `order.status === 'CANCELLED'` (`:192`),
  `getByOrderId` (`:200`), `resolveInvoiceLinkage` (`:210`),
  `getChargeIdsForInvoice` (`:223`), `getByIdempotencyKey` (`:277`) y el
  re-read del fallback post-ON-CONFLICT (`:309`) — todos por el pool del repo
  mientras `client` tiene la tx1. **Se declara, no se arregla:** entre el
  `getByIdForUpdate` (`:186`) y el `createWithClient` (`:283`) NO hay ningún
  write vía `client`, así que no hay estado no-commiteado propio que perder; un
  concurrente commiteado se ve bajo READ COMMITTED; y el fallback siempre ve
  la fila por el orden del lock especulativo del índice único de
  `idempotency_key`. Comentario in-place arriba de `:277`. El `!` no-nulo que
  había tras `createWithClient` null (era **uno**, en el viejo `:269`, no dos)
  → re-read explícito + throw "invariante rota"; + `assertRevertsExpectedInvoice()`.
  **Costo residual:** presión de pool (2 de 5 conexiones por escape en vuelo,
  `tenant.middleware.ts` `max: 5`) — es **POOL-STARV-001** (#10 / bloque
  3.2-pre); pasar `client` a las 5 lecturas va ahí, donde el presupuesto de
  pool se mide. **(iii) `buildInvoiceService` → NO se extrae:** ya está
  extraído/reusado desde el 07/09 (`orders.routes.ts:58` ← `invoices.routes.ts:56`,
  una sola def); y moverlo a un `.ts` no-`.routes.ts` viola
  `no-repo-concreto-de-otro-dominio` de `.dependency-cruiser.cjs` (sólo
  exceptúa `*.routes.ts`), y meterlo al `pathNot` cambia una cerca por
  convención de nombre por un allowlist a mano (RBAC-SYNC-001). **(iv)**
  `84efea9`: `OrderNotFoundError`/`InvalidOrderTransitionError` movidos a
  `domain/errors.ts`.
- **`reservation.cancel-confirmed.test.ts` — falla determinística en bordes de
  hora exactos (no es flakiness).** `src/tests/domain/reservation.cancel-confirmed.test.ts:77-81`
  (caso 1h). **Mecanismo:** `msFromNow()` (`:33`) lee `Date.now()`, y después el
  default `now = Date.now()` de `canCancelConfirmed` (`:25`) lo lee **de nuevo**;
  para el caso 1h, `msUntilStart = 3600000 − delta` y
  `Math.floor(3599999 / 3600000) = 0` → `expected +0 to be 1`. El archivo ya
  documenta este hazard en `:46-51` y lo arregló para el borde 24h pasando un
  `now` explícito (`:52-53`) — nunca se aplicó a los otros bordes exactos.
  **Hermanos latentes:** `:57-61` (25h → puede leer 24), `:63-67` (48h → 47).
  **Reproductor:** run de CI `34217329434` (commit `c519d98`, doc-only) — falló
  el job `test` en esa línea; los runs de `f86dd66`/`7cf460e`/`2839beb`, sin
  cambio a ese archivo, pasaron. **Consecuencia:** un CI rojo que no corresponde
  a ningún cambio enseña al equipo a re-correr en vez de leer. Test-only, sin
  código de producción, no es regresión de ningún bloque 1.x. **NO** es el caso
  que la regla 10 de la sesión de plan advierte (esa nombra
  `credit-note-compensation.integration.test.ts`, donde un flake taparía un
  TOCTOU documentado — archivo y clase de riesgo distintos). → bloque propio.
- **`EMISOR_NOTA_CREDITO` en `appfrontend-main`, bloque 5.1 -- 🟡 PARCIAL
  (09/09/2026, gate `architecture-governor`, segundo candidato transversal
  del día).** Tres catálogos a mano del frontend listaban 8 grupos sin él:
  `dashboard/roles/page.tsx:18-26`, `superadmin/roles-de-fabrica/page.tsx`,
  `superadmin/planes/page.tsx`. **NO se perdía en el save** (verificado
  antes de tocar nada): `roles/page.tsx:83` sembraba el form desde
  `[...r.permissionGroups]` y `:104` lo mandaba entero -- un rol que ya
  tenía el grupo lo conservaba. Fail-safe, no fail-open -- por eso esto no
  bloqueó el gate final del 08/09, aunque siguiera siendo un hueco de
  governance real.
  - **✅ Cerrados 2 de 3** (`appfrontend-main`, `ba01d3d`): `dashboard/roles/page.tsx`
    -- hueco funcional REAL, no cosmético, verificado: `platform.schema.sql:782-786`
    deja `plan_limit_allowed_permission_groups` con 0 filas a propósito para
    PRO/ENTERPRISE ("0 filas = sin restricción"), o sea que esos negocios SÍ
    podían crear un rol custom con este grupo según el backend, pero no
    existía ningún checkbox para hacerlo. `superadmin/planes/page.tsx` --
    `plan_limit_allowed_permission_groups` se lee vivo en cada request
    (`assertPermissionGroupsAllowedInPlan`), no se propaga a tenants;
    agregar el checkbox ahí es reversible y simétrico.
  - **✅ Copy falsa corregida, todavía LOCAL/sin pushear ni deployar
    (`app-main` `f91d7ad`+`328b134`+`14c5166`, `appfrontend-main`
    `5ba8b57`+`6a427c9`; gate `architecture-governor`, 09-10/09/2026).**
    `superadmin/roles-de-fabrica/page.tsx` edita PRESETS, que SÍ se
    propagan por backfill a TODOS los tenants existentes en cada boot
    (`platform.schema.sql:350-355`, `ON CONFLICT DO NOTHING` -- un
    otorgamiento sobrevive el próximo deploy, una revocación no revoca
    nada). La copy vieja ("Editar acá NO afecta a los negocios que ya
    existen") era **FALSA** -- verificado leyendo
    `platform.repository.ts:850-852` (`DELETE` + loop de `INSERT` sobre la
    tabla de presets, no un `UPDATE`) + el backfill. Reemplazada por un
    bloque de advertencia visible con el mecanismo real
    (`roles-de-fabrica/page.tsx:57-79`). Misma afirmación falsa que estaba
    duplicada en el backend, corregida en el mismo bloque:
    `src/platform/platform.routes.ts:419-437`. **El checkbox de
    `EMISOR_NOTA_CREDITO` en este catálogo (bloque B) sigue sin agregar** --
    su precondición declarada es que esta corrección esté verificada EN
    PRODUCCIÓN, no solo commiteada; falta push + deploy + verificación de
    los dos repos antes de tocarlo.
  - **También sigue abierto:** "no se puede identificar" -- `dashboard/roles/page.tsx:196`
    muestra `permissionGroups.length` (un número), nunca los nombres, y
    los roles `isSystem` (`OWNER`/`ADMIN`/`RECEPTIONIST`, los que
    realmente tienen el grupo) nunca abren el modal. Bloque de UI aparte.
  - ~~**Cerca de fondo, todavía sin escribir**~~ **✅ RESUELTO (09/09/2026,
    gate `architecture-governor`)**: `src/tests/security/roles-catalog-sync.test.ts`
    (`ROLES-CATALOG-DRIFT-001`) congela el conjunto del catálogo `Roles` +
    espejo `key===value`, con 3 mutaciones verificadas (agregar, sacar,
    RENOMBRAR un grupo). No verifica que `appfrontend-main` se haya
    actualizado de verdad -- sigue siendo un recordatorio en el momento
    del cambio, no una sincronía real entre repos.
- **TTL de NC `PENDING`/`FAILED_UNCERTAIN` huérfana — deuda aceptada, no
  bug.** (08/09/2026, gate `architecture-governor` bloque 2.2, grounding
  `auditor-circuitos-erp`.) Una NC que queda `PENDING` (nunca se resolvió con
  AFIP) o `FAILED_UNCERTAIN` (CAE incierto, requiere reconciliación manual)
  no tiene expiración ni alerta — nadie la barre. Anclas:
  `src/db/schema.sql:2718-2719` (el `CHECK` de `status`, sin columna de
  vencimiento) + `src/facturacion/invoice.service.ts:1006-1018`
  (`reconcileAfterFailure()`, la única reconciliación que existe, automática
  — no hay ningún flujo de reconciliación MANUAL en el repo). **Verificado
  contra ERPNext/Odoo 19/QloApps: ninguna de las 3 referencias tiene
  TTL/expiración automática de una solicitud de corrección en curso** — es
  un gap aceptado en la industria, se mitiga con reportería/alertas
  operativas, no con lógica de dominio. Mitigación ya existente en este repo,
  al mismo nivel que esas referencias: `GET /api/invoices?status=` (bloque
  2.1, `fc809dc`) + `MID-LOG-001` (`df07bdf`, bloque 0.2). No bloquea nada —
  registrado para que quede visible, no como omisión silenciosa.
- **A6.6 sin resolver — quién puede cancelar/rechazar una solicitud de NC en
  curso.** (08/09/2026, gate `architecture-governor` bloque 2.2.) Si algún
  día se construye `credit_note_request` (hoy en HOLD, ver ADR §6.5/§10 fila
  1), la transición `PENDIENTE_CAE → CANCELADO`/`RECHAZADO` necesita
  `authorize(Roles.EMISOR_NOTA_CREDITO)`, no `FRONT_DESK` — mismo criterio
  que el resto de la familia de cercas RBAC de este ADR (`app-main/CLAUDE.md`,
  sección RBAC). Implica `EXPECTED_AUTHORIZE_CALL_SITES` +1, fila nueva en
  `docs/rbac-matriz-endpoints.md`, posible fila nueva en `ESCAPE_ROUTES` de
  `credit-note-escape-containment.test.ts`. **No aplica hoy** (no hay tabla,
  no hay transición que gatear) — queda anotado para cuando se reabra 2.3,
  no como bloqueo del bloque 2.4.

---

## Arrastrado de `pendientes-2026-09-06.md` — abierto, detalle allá

**ADR "cancelar con NC" — resto:** ~~CHECK `reversed_invoice_id` mitad de datos (#1)~~ ✅ `3bcf5ab` ·
~~3-ter filtro `cbte_tipo` (#2)~~ ✅ `94ac18e` · ~~4 filas de deuda de `ef27e42` (#3)~~ ✅ `3608edf`+`84efea9` (i/ii/iv; iii = no se hace, declarado) · B3
(~~`?status=` (#4a)~~ ✅ bloque 2.1, 08/09/2026 — `GET /api/invoices?status=`,
`InvoiceRepository.getByStatus()`, mismo `authorize(FRONT_DESK)`; `credit_note_request`
+ bandeja completa (#4b) sigue abierto, bloqueado por el gate del bloque 2.2) · B-reservas
(~~`getByReservationId` UNION + fail-closed, 5 caracterizaciones~~ ✅ bloque 3.1,
`3525bde` — ver #22; siguen abiertos: subcasos directa/consolidada/pool mixto,
`EXPIRED-FACT-01`, F4 en reservas/subcaso 2) (#5) · Anexo A1/A2/A4 ·
Frontend (🟡 bloque 5.1 -- 2 de 3 catálogos sin `EMISOR_NOTA_CREDITO` ya
cerrados en `appfrontend-main` `ba01d3d`, detalle en la sección
"🟠 Deuda menor detectada" de este mismo archivo; copy falsa de
`roles-de-fabrica` corregida cross-repo pero todavía LOCAL/sin pushear
(ver esa misma sección) -- el checkbox de `EMISOR_NOTA_CREDITO` en ese
catálogo sigue sin agregar, gate propio; consumir `description`/`kind`
del dead-letter).

**Deuda estructural:** Residual B-1 (redefinido 08/09 como **3.2-b**, ver #25 —
no cerrable sin transaccionalizar `recordPayment()`) · ~~`REFUND-INT-GUARD-001`~~
✅ bloque 3.2-bis, 08/09 · ~~`MID-LOG-001`~~ ✅ bloque 0.2, 08/09 ·
~~`POOL-STARV-001`~~ ✅ bloque 3.2-pre, 08/09 (medido: 2/5 conexiones, no 3-4) ·
`REFUND-ISSUED-RACE-01` (nuevo, 08/09, ver #24 — `markIssued()` sin lock ni
transacción, no cerrable por ningún lock de fila) · `CONCIL-INCONSIST-01`
(absorbe INV-ORF-01 + pt1 ORDER-13) · `OUTBOX-RETRY-HIST-01` ·
`OUTBOX-BACKOFF-01` · `OUTBOX-DL-COMPENSATOR-01` ·
`OUTBOX-DL-THROTTLE-RESET-01` 🟠 · `EMAIL-FROMNAME-RFC5322-01` 🟠 ·
~~CI techo~~ ✅ bloque 0.1, 08/09 · A7.6.

**Seguridad:** `SEC-ROT-001` (runbook ✅, falta código 2-claves + `reencrypt-secrets.ts`
+ IV 16→12) · ~~`RBAC-SYNC-001 §4`~~ ✅ RESUELTO (09/09/2026, gate `architecture-governor`,
recomendación transversal #2 del día -- `rbac-matrix-public-routes-sync.test.ts`
nueva, 3 tests, cruza la sección 4 de `rbac-matriz-endpoints.md` contra
`PUBLIC_ROUTES` en las dos direcciones, fail-loud. Corrió ROJO primero
contra el doc sin arreglar -- atrapó las 3 celdas divergentes reales antes
de tocarlas -- y VERDE después de normalizarlas. 6 mutaciones obligatorias
verificadas y revertidas. **Corrección post-cierre (mismo día):** el gate
encontró que importar `PUBLIC_ROUTES` desde `rbac-route-coverage.test.ts`
(un `*.test.ts`) hacía que Vitest re-ejecutara su `describe()` de nivel
superior -- `RBAC-ROUTE-001` corría 2 veces en la suite completa (40
tests contados donde eran 39 reales). Extraído a
`src/tests/security/public-routes.fixture.ts` (módulo no-test), los dos
tests lo importan de ahí. Suite completa **2020/2021** sin regresión
(2017 antes de este bloque + 3 tests reales nuevos, no 4) ·
`FACT-INV-BIZID-001`/`FAILOPEN-001` (re-etiquetar).

**Higiene:** desfase de fecha "08/09"→"07/09" en ~5 docs (verificar si sigue
aplicando tras esta sesión, que sí es del 08) · DA-CONT-001 · DOC-ANCLA-001 ·
ficha M10 stale

~~`RBAC-MATRIX-HEADER-STALE-001`~~ **✅ RESUELTO (09/09/2026, gate
`architecture-governor`, recomendación transversal #4 del día -- auditoría
de "número derivado de código citado a mano en prosa" que salió de la
sesión de CONTRACT-001).** Encontrado de paso cerrando RBAC-SYNC-001 §4, NO
corregido a propósito en ese momento (mismo motivo por el que
RBAC-SYNC-001 §4 existía: abrir y cerrar un hallazgo de doc-desactualizado
en el mismo movimiento no deja rastro de que hubo un hallazgo).
`docs/rbac-matriz-endpoints.md`, sección 2, decía "205 call-sites" cuando
`EXPECTED_AUTHORIZE_CALL_SITES` (`src/tests/security/rbac-matrix-sync.test.ts`
-- ancla por nombre de constante, no por línea: ese archivo acumula 2-4
líneas cada vez que el número cambia, así que un `:línea` citado acá queda
stale en el mismo evento que lo motiva) exigía **206** desde el bloque
3.3-b2 (09/09/2026, `reservations.routes.ts` sumó la ruta de escape) --
nadie actualizó la prosa del encabezado en ese momento. Corregido en
`a8f9e67` (205→206); su nota inicial afirmó en pasado una cerca que
todavía no existía, corregido en `80805f2` (segunda ronda del mismo gate
-- "un doc que afirma que una cerca existe cuando no existe es peor que el
número stale original"). Cerrado de fondo en `d39b8b7`: tercer `it()` en
`rbac-matrix-sync.test.ts` que cruza el encabezado contra
`EXPECTED_AUTHORIZE_CALL_SITES`/`EXPECTED_ROUTES_FILE_COUNT`
automáticamente, con 4 mutaciones verificadas (header con el número viejo,
header reformateado sin match, header duplicado en una cita con más de un
match, segundo número divergente) -- este número ya se había pudrido dos
veces en el mismo lugar (la primera, 198/204, con drift de semanas; la
segunda, 205/206, con drift de cero commits) y ahora no puede volver a
hacerlo sin que la suite se ponga roja.

~~`CONTRACT-001`~~ **🟡 PARCIAL (09/09/2026, gate `architecture-governor`,
recomendación transversal #3 del día).** Origen del ítem completo:
`docs/pendientes-2026-08-31.md:89` (3 componentes ahí: #1 documentación
incompleta, #2 sin test de cruce, #3 deriva real ya detectada). Cerrados
hoy #2 y #3:

- **#3 (deriva):** `src/openapi/spec.ts` documentaba 3 de 19 paths (no "2
  de 18" como decía el hallazgo original del 31/08 -- recontado leyendo el
  objeto `paths` real) que daban 404 real: `/api/reports/summary` y
  `/api/reports/underutilized` (reales: bajo `/occupancy/`, rotos desde
  `ad856d4`, 23/06/2026, ~2.5 meses sin detectarse) y
  `/api/resources/{id}/availability` (ruta fantasma, cero matches en
  `resources.routes.ts`, sin equivalente real -- se borró en vez de
  inventar un reemplazo, mismo criterio que `284f988` que ya había borrado
  otro fantasma de este archivo). Corregido en `a96aa90`.
- **#2 (sin cruce):** nueva cerca
  `src/tests/architecture/openapi-spec-route-sync.test.ts` (`cf59908`, 6
  tests) -- importa `openApiSpec` como módulo real (no regex sobre el
  texto) y cruza cada path+método documentado contra el `*.routes.ts`
  real, vía dos allowlists chicas con motivo (`MOUNT_TO_ROUTES_FILE`,
  `EXCLUDED_PATHS` para `/health`+`/health/db`, que son `app.get()`
  directos de `app.ts` sin `*.routes.ts`). Corrió ROJO contra
  `git show e322dc7:src/openapi/spec.ts` -- exactamente las 3 violaciones
  de arriba, ni una más -- y VERDE después. Mutaciones de fail-loud
  (archivo mapeado roto) y de entrada obsoleta (prefijo sin uso)
  verificadas y revertidas. Sin `EXPECTED_*` de conteo a propósito:
  documentar un endpoint nuevo no debe romper el build. Limitación
  declarada en el header del archivo: no verifica que
  `MOUNT_TO_ROUTES_FILE` siga apuntando al router que `app.ts` monta
  realmente en cada prefijo -- el mapa es manual, verificado a mano el
  09/09/2026, y se re-verifica a mano si esos mounts cambian. Suite
  completa **2020 → 2026** (+6, exactos los del archivo nuevo; sin riesgo
  de la doble-ejecución de `e322dc7` porque importa `spec.ts`, no un
  `*.test.ts`).

**#1 (documentación incompleta), reencuadrado 09/09/2026 -- 🟡 PARCIAL,
ya no "sin bloque propio":**

- **Sub-componente existencia -- ✅ RESUELTO (`2194849`, opción (A)
  elegida por el dueño).** `docs/inventario-rutas.md`, generado por
  `src/scripts/generate-route-inventory.ts` (`npm run docs:routes`,
  verificado en CI, job `route-inventory-check`): **251** endpoints
  reales -- 211 observados booteando la app real y caminando
  `app._router.stack` (árbol vivo de Express, no regex sobre `app.ts`) +
  40 declarados vía `CLOSURE_MOUNTS` para los 6 mounts que arman su
  router dentro de un closure por-request y por eso el árbol vivo no los
  ve (`/api/reports`, `/api/system`, `/api/housekeeping`,
  `/api/maintenance-windows`, `/api/stays`, `/api/accounts-receivable`,
  confirmado por spike real, no inferido). El hallazgo original de 33
  routers sin entrada en `spec.ts` (`git show 6beff80:docs/pendientes-2026-09-08.md`
  para el texto tal como quedó antes de este reencuadre) queda respondido
  por este inventario -- ya no hace falta mantenerlo a mano ni volver a
  recontarlo.
- **Sub-componente narrativa/responses -- sigue abierto.** El inventario
  dice QUÉ RUTAS EXISTEN, no la forma del request/response. `spec.ts`
  sigue siendo el único artefacto con eso, para 18 de 251 -- completar
  el resto (o decidir no hacerlo) sigue siendo la decisión de producto
  pendiente que le corresponde al dueño.
- **Sub-componente autz -- sigue abierto, y no es extraíble del árbol
  vivo.** `authorize(Roles.X)`/`requireModule(...)`/`authorizePlatform(...)`
  capturan el permiso en un closure (`src/security/auth.middleware.ts:367`,
  arrow anónima) -- nada de eso es legible caminando
  `app._router.stack`. Esa pregunta ya tiene dueño
  (`docs/rbac-matriz-endpoints.md` + 7 cercas); cruzarla contra el
  inventario nuevo es un bloque futuro, no decidido todavía.

**Lo que esto SÍ y NO desbloquea:** el paso 2 del pedido de UI
(`pendientes-2026-08-31.md:89`, "documentar el contrato antes de escribir
la pantalla") y el paso 3 de idempotencia de D+A
(`docs/continuidad-da-orden-estados-2026-09-02.md:331`,
`docs/pendientes-2026-09-02.md:306`) necesitan la FORMA del contrato y un
análisis de consumidores respectivamente -- ninguno de los dos lo resuelve
un inventario de existencia. **Siguen bloqueados**, sin cambio de estado
por este commit -- que quede explícito para no repetir el error de
CONTRACT-001 (marcar cerrado algo que solo resolvió una parte).

**Hallazgo nuevo sin bloque propio (09/09/2026, mismo gate):** 5 bloques
`@swagger` en JSDoc (`src/api/routes/auth.routes.ts:154,248,293`,
`src/platform/business.routes.ts:48,79`) que no generan nada --
`swagger-jsdoc` no está en `package.json` ni en el lockfile. Un tercer
"origen" aparente de documentación de API que en realidad no alimenta
ningún artefacto y puede confundir a quien asuma que el spec es
parcialmente generado. No corregido hoy (borrar comentarios es limpieza,
bloque aparte).

**`RBAC-MATRIX-SECTION2-001` -- deuda de normalización, cuantificada,
no cerrada (09/09/2026, gate `architecture-governor`).** La cerca nueva
`src/tests/architecture/rbac-matrix-section2-sync.test.ts` cruza fila por
fila la sección 2 de `docs/rbac-matriz-endpoints.md` contra el código
real, pero **11 archivos** (`EXCLUDED_FILES` en ese mismo archivo,
líneas 66-111) describen sus rutas protegidas en prosa en vez de bullets
parseables, y quedan sin verificar fila por fila: `customer.routes.ts`
(7 rutas), `invoices.routes.ts` (8), `admin.routes.ts` (2),
`platform.routes.ts` (11), `waste-reasons.routes.ts` (5),
`consumption-destinations.routes.ts` (5), `products.routes.ts` (30),
`cancellation-policies.routes.ts` (5), `roles.routes.ts` (5),
`user-invitation.routes.ts` (4), `accounts-receivable.routes.ts` (3 --
este SÍ tiene bullets, pero uno diverge del código real,
`GET \`/?companyCustomerId=\`` vs `GET \`/\``). **85 rutas protegidas en
total**, verificado contra `route-enumeration.fixture.ts` +
`PUBLIC_ROUTES` (comando: correr
`npx vitest run src/tests/architecture/rbac-matrix-section2-sync.test.ts`
-- la primera aserción reporta cualquier desvío entre `hiddenCount`
declarado y el conteo real). Normalizar estos 11 archivos a bullets (y
sacarlos de `EXCLUDED_FILES`) es un bloque de docs aparte, no decidido
todavía -- `products.routes.ts` (30) va solo, por tamaño.

**Hueco declarado en la misma cerca, obligatorio ANTES de normalizar
cualquiera de los 11 (no antes del push de hoy):** `EXCLUDED_FILES` hoy
solo verifica que el conteo de rutas protegidas siga coincidiendo, no
que el archivo siga sin bullets parseables. Si alguien normaliza
`products.routes.ts` a sus 30 bullets reales y se olvida de sacarlo del
allowlist, el conteo sigue dando 30 y la cerca queda verde ignorando los
30 bullets nuevos -- verificado en las dos direcciones para todos los
demás allowlists del repo (`PUBLIC_ROUTES`, `EXCLUDED_ROWS`,
`CLOSURE_MOUNTS`), todavía no para este. Cerrarlo (contar bullets
parseables por archivo, compararlo contra 0 o contra lo que
corresponda) es el próximo bloque de código de este ítem.

**Riesgo de auto-deadlock por anidamiento de `PgTransactionManager.run()`
-- sin cerca, sin ocurrir hoy (09/09/2026, gate `architecture-governor`,
encontrado de paso cerrando LOCK-ORDER-001, `7150dfa`).** Si alguna vez
`requestInvoice()` (`src/facturacion/invoice.service.ts`) se llamara
DENTRO de una transacción que ya lockeó la misma fila de `invoices`, el
modo de falla no sería ABBA (mismo lock, mismo xid, Postgres lo concede)
sino un deadlock real entre DOS conexiones distintas del pool --
`PgTransactionManager.run()` (`src/db/pg.transaction-manager.ts:23`) hace
`pool.connect()` nuevo en cada invocación, sin detectar reentrada.
Verificado: los 5 call-sites productivos de `requestInvoice()` corren
hoy fuera de toda tx abierta (`cancel-order-with-credit-note.service.ts:164,328`,
`cancel-reservation-with-credit-note.service.ts:278,482`,
`src/facturacion/invoices.routes.ts:97`) -- el riesgo es un supuesto sin
ocurrir, no un bug activo, y ninguna cerca lo vigila si alguien lo
rompiera. Reproducir: `grep -rn "requestInvoice(" src --include="*.ts" | grep -v test`
-- **ese comando es el ancla robusta de este ítem, no los números de
línea de arriba.** Corrección de registro (09/09/2026, gate
`architecture-governor`, segunda ronda sobre este mismo ítem): las líneas
de `cancel-reservation-with-credit-note.service.ts` citadas primero
(276/480) eran correctas en `9be3eb7` -- `7150dfa` agregó 2 líneas al
docblock de ese archivo y corrió el ancla a 278/482, no fue un error de
transcripción como se dijo al principio, fue la regla 2 de "Pendientes —
revalidar antes de arrastrar" (el ancla se mueve, re-chequeala) actuando
sobre el propio commit que se estaba documentando. Y
`api/routes/invoices.routes.ts:97` (ruta de directorio equivocada,
corregido a `src/facturacion/invoices.routes.ts:97`) sí fue una
transcripción de memoria después de correr el grep correcto -- el mismo
patrón que el array parafraseado de la mutación (d) en `7150dfa`: el paso
de verificar corrió, el paso de copiar el resultado no.

**Backlog de producto (sin fecha):** Gap C1-C · AR-FACT-NO-ISSUED-01 Fases 2-8 ·
FACT-BORRADOR-001 (v2.8) · C1-B (bloqueada por proveedor) · C2/C3 · D7 (5 endpoints
de reportes sin consumidor) · **ORDER-10 B4** (período contable — **decisión del
dueño 08/09: NO es "sesión con el contador"; es un flag configurable por tenant
+ su chequeo en el orquestador. El lado fiscal ya está cubierto por la NC con
fecha actual. Ver ADR §0 "Frontera de responsabilidad", corolario B4**) ·
circuito POS-caja (ORDER-12 / CAJA-ORD-01 / AUDIT-ORD-01) · heredados
(Redis, BullMQ, downgrade, datos demo en prod).

---

## Higiene

- Commit de docs de esta sesión: los 6 del arco (`af2b2b5`..`cf47763`) ya
  incluyen los updates de `pendientes-2026-09-06.md` in-place. Este archivo +
  el plan + las correcciones de estado van en un commit de docs aparte.
