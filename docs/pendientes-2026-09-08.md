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

### #21 — Tope N5 (acumulado por factura revertida): sin cap fiscal propio, hoy inalcanzable · 🟠 recaracterizado (08/09/2026, gate `architecture-governor`)

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

**Se vuelve alcanzable con el bloque 3.1 del plan** (`getByReservationId()` →
UNION con el camino consolidado): ahí dos reservas distintas pueden apuntar a
la misma factura consolidada, `confirmRefund()` se llama una vez por reserva
(claves de idempotencia distintas), y dos `REFUND` con el mismo
`reversed_invoice_id` se vuelven alcanzables — recién ahí la propiedad 2 deja
de contener. **El plan no dice hoy que 2.4 (tope N5) tiene que aterrizar ANTES
que 3.1** — hay que forzarlo (ver plan, tabla de bloques).

- **RBAC, hallazgo aparte del gate, no de N5:** `POST /api/invoices` emite NC
  efectivamente (branch `tx.type === 'REFUND'|'ADJUSTMENT'`,
  `invoice.service.ts:357`) bajo `authorize(Roles.FRONT_DESK)`
  (`invoices.routes.ts:78-98`), mientras el escape dedicado de órdenes exige
  `Roles.EMISOR_NOTA_CREDITO`. **No** es un filtro de `type` a agregar —
  filtrar rompería el camino legítimo de facturar REFUND/ADJUSTMENT. Es una
  asimetría de grupo de autz. Ítem propio, cruzado contra
  `docs/rbac-matriz-endpoints.md`, gate propio.
- **NO tocado en este cierre** (fuera del alcance autorizado por el gate):
  bloque 2.3 (`credit_note_request`, v48) — bloqueado aguas arriba por el
  bloque 2.2 (auditor + gate §10 fila 1); `buildCreditNote()`; el `authorize`
  de `invoices.routes.ts`.
→ el tope real (bloque 2.4) sigue pendiente, sin urgencia hoy — depende del
2.2/2.3 y tiene que aterrizar antes del bloque 3.1.

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
  - **Divergencias ladder inline (`orders.routes.ts`) vs `domainErrorStatus`**
    (pre-existentes del sub-bloque 4, NO se tocan acá — sólo se registran):
    `AFIP_NOT_CONFIGURED` 422 ruta / 503 middleware; `AFIP_REQUEST_REJECTED`
    409 ruta / 422 middleware. Reconciliarlas es cambio de contrato (chequeo
    de frontend) — bloque propio.
  - **Deuda que queda:** dos políticas de logging conviven — el escape loguea
    **todo** `DomainError` (incl. 404, por bajo volumen), el middleware sólo
    `>= 409`. Las rutas que resuelven inline sin `next(err)` (el escape, los
    guards de reservas del portal) no pasan por el middleware. Una convención
    "todo `*.routes.ts` delega los `DomainError` al middleware salvo
    divergencia de status declarada" reconciliaría las dos — bloque propio.
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
- **`EMISOR_NOTA_CREDITO` no existe en `appfrontend-main`** (HEAD `613c206`, 0
  hits). En `app-main` está en `security/roles.ts:59` y en `platform.schema.sql:314,317,319`
  (OWNER/ADMIN/RECEPTIONIST). Tres catálogos a mano del frontend listan 8 grupos
  sin él: `dashboard/roles/page.tsx:18-26`, `superadmin/roles-de-fabrica/page.tsx`,
  `superadmin/planes/page.tsx`. **NO se pierde en el save**: `roles/page.tsx:83`
  siembra el form desde `[...r.permissionGroups]` y `:104` lo manda entero — un
  rol que ya lo tenga lo conserva. **Consecuencia:** el privilegio de emitir una
  Nota de Crédito fiscal **no se puede otorgar a un rol custom, no se puede
  revocar y no se puede identificar** en el panel de administración. Fail-safe
  (no fail-open) y los presets lo llevan, por eso no bloqueó el gate final —
  pero es un hueco de governance vivo sobre una capacidad AFIP. → bloque **5.1**
  del plan (frontend), sin dependencias. Interactúa con 2.1 (la bandeja de NC):
  el panel no puede mostrar quién tiene el permiso.

---

## Arrastrado de `pendientes-2026-09-06.md` — abierto, detalle allá

**ADR "cancelar con NC" — resto:** ~~CHECK `reversed_invoice_id` mitad de datos (#1)~~ ✅ `3bcf5ab` ·
~~3-ter filtro `cbte_tipo` (#2)~~ ✅ `94ac18e` · ~~4 filas de deuda de `ef27e42` (#3)~~ ✅ `3608edf`+`84efea9` (i/ii/iv; iii = no se hace, declarado) · B3
(`credit_note_request` + bandeja + `?status=`) (#4) · B-reservas
(`getByReservationId` UNION, subcasos directa/consolidada/pool mixto,
`EXPIRED-FACT-01`, F4 en reservas, 5 caracterizaciones) (#5) · Anexo A1/A2/A4 ·
Frontend (3 catálogos sin `EMISOR_NOTA_CREDITO`, copy falsa `roles-de-fabrica`,
consumir `description`/`kind` del dead-letter).

**Deuda estructural:** Residual B-1 + `REFUND-INT-GUARD-001` · `MID-LOG-001` ·
`POOL-STARV-001` · `CONCIL-INCONSIST-01` (absorbe INV-ORF-01 + pt1 ORDER-13) ·
`OUTBOX-RETRY-HIST-01` · `OUTBOX-BACKOFF-01` · `OUTBOX-DL-COMPENSATOR-01` ·
`OUTBOX-DL-THROTTLE-RESET-01` 🟠 · `EMAIL-FROMNAME-RFC5322-01` 🟠 · CI techo · A7.6.

**Seguridad:** `SEC-ROT-001` (runbook ✅, falta código 2-claves + `reencrypt-secrets.ts`
+ IV 16→12) · `RBAC-SYNC-001 §4` · `FACT-INV-BIZID-001`/`FAILOPEN-001` (re-etiquetar).

**Higiene:** desfase de fecha "08/09"→"07/09" en ~5 docs (verificar si sigue
aplicando tras esta sesión, que sí es del 08) · DA-CONT-001 · DOC-ANCLA-001 ·
CONTRACT-001 · ficha M10 stale.

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
