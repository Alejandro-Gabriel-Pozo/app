# Pendientes — Viernes 5 de Septiembre 2026

Arrastra lo que seguía abierto en `pendientes-2026-09-03.md` (no hubo archivo
para el 04/09). Los ítems cerrados quedan allá marcados, no se repiten acá.

**Alcance de esta sesión:** cierre completo de `BRECHA-REFUND-01` (Fases 1–3 +
dos residuales de arquitectura), con `architecture-governor` en cada paso.
Push total autorizado por el dueño al final — `app-main` (20 commits,
`1f72f41..1807ca8`) y `appfrontend-main` (1 commit, `9a08417..613c206`).

**Disciplina de evidencia**, igual que los archivos anteriores: `[V]` verificado
contra el árbol real / Postgres real en esta sesión; `[P]` decisión propuesta,
no final; `[H]` hipótesis sin verificar.

---

## ✅ Cerrado — verificado en esta sesión

### BRECHA-REFUND-01 — `confirmRefund()` podía duplicar reembolso / Nota de Crédito · ✅ RESUELTO (05/09/2026)

Registrada `04/09/2026` en `pendientes-2026-09-03.md:683` (bloqueaba C2 — "no
construir la UI sin resolver primero"). Cerrada en 3 commits, todos con
`architecture-governor` antes de cada uno, todos en `origin/main`:

- `b08b0d2` — **Fase 1**: `getCollectedPaymentTotalForReservation()` resta los
  `REFUND` ya emitidos (antes sumaba solo `PAYMENT`, repetía el bruto).
- `46ffaf3` — **F-A**: el reparto ignora Notas de Crédito ya emitidas (misma
  tabla `invoices`) — sin esto, una NC podía terminar apuntando a otra NC.
- `3f11949` — **Fase 3**: advisory lock + `idempotencyKey` derivada
  server-side + capado contra `getRefundableForUpdate()` (`LEAST` de dos
  invariantes, no `impTotal` a secas). El chequeo de retry corre dos veces
  (rápido afuera, autoritativo bajo el lock) — la primera versión de este
  commit tenía el chequeo SOLO afuera; `architecture-governor` lo bloqueó
  con un escenario reproducible antes de aprobar, ver `[V]` abajo.
- `1807ca8` — **residuales #1 y #2** (mismo día, segunda vuelta de
  `architecture-governor` sobre el propio `3f11949`):
  - **Residual #1 (ABBA `confirmRefund()`/`recordPayment()`): CERRADO SIN
    CAMBIO DE CÓDIGO.** `[V]` `recordPayment()` (`customer-account.service.ts:182-188`,
    desde `a2aaf40`, dos días antes) ya ordena sus locks de forma canónica
    (`localeCompare` ascendente sobre `invoices.id`) — el mismo comparador
    que `confirmRefund()`. `architecture-governor` había marcado esto como
    residual abierto en su primera revisión de `3f11949` **citando un
    comentario del propio código como evidencia**, sin releer
    `customer-account.service.ts` actualizado — el comentario estaba
    desactualizado desde `a2aaf40`. Corregido en la segunda vuelta. Detalle
    completo, incluida la regla de proceso ("no citar un comentario de otro
    archivo como estado verificado"), en
    [conocimiento/playbook-idempotencia-bajo-lock.md](conocimiento/playbook-idempotencia-bajo-lock.md).
  - **Residual #2 (chunk `:sin-asignar` sin re-capar bajo lock): CERRADO
    PARCIALMENTE.** `collected` e `issuedInvoices` se releen dentro de la
    transacción, después del pre-lockeo canónico de facturas. Dos
    escenarios reachable verificados con test que falla antes del fix y
    pasa después (`[V]`, contra Postgres real):
    - **Escenario A** (factura que pasa a `ISSUED` en vuelo, vía
      outbox/worker AFIP): antes caía a `:sin-asignar` ledger-only sin
      emitir NC; ahora se ata a la factura real.
    - **Escenario B** (`PAYMENT` concurrente sobre la misma reserva, vía
      `recordPayment()` o cobro de checkout/POS): antes quedaba un
      sub-reembolso silencioso y permanente (Q-C hace `confirmRefund()` de
      un solo tiro por reserva); ahora se refleja.
  - **Residual #2-B, declarado NO cerrado (no confundir con "cerrado"):**
    el `FOR UPDATE` sobre facturas no protege una escritura sobre la
    reserva que no tenga FK a ninguna fila lockeada (un `PAYMENT` genérico
    sin `settled_invoice_id`, dentro de la ventana entre el pre-lockeo y el
    commit). Estrechado, no eliminado — ver `BRECHA-REFUND-01-B` abajo.
  - **Residual #2-C, declarado NO verificado:** la semántica de `FOR KEY
    SHARE`/`FOR UPDATE` que sostiene la protección de Escenario A/B es
    inferencia sobre comportamiento documentado de Postgres, no un hecho
    medido con un test dedicado — ver `FOR-KEY-SHARE-001` abajo.

**Q-A / Q-C** (confirmadas por el dueño antes de Fase 3): reembolso nunca
supera lo efectivamente cobrado; `confirmRefund()` es único e irrepetible por
reserva (retry devuelve lo ya creado, no completa una diferencia después).

**Verificación acumulada de la sesión:** 1815 tests unitarios, 130 de
integración contra Postgres real (incluye los 9 del archivo nuevo
`cancellation-refund.integration.test.ts`), `tsc --noEmit`, `lint`, `lint:arch`
— todo verde antes de cada uno de los 4 commits.

**C2 (`Cancelar reserva` no usa el preview/confirm de reembolso,
`pendientes-2026-08-31.md:262`) queda DESBLOQUEADA.** Sigue sin construirse —
es trabajo de UI aparte, no autorizado en esta sesión — pero ya no tiene la
condición "no construir sin resolver primero" encima.

---

## ✅ Cerrado — mismo día, segunda vuelta (05/09/2026)

### LOCK-ORDER-001 — el orden canónico de lock sobre `invoices` no estaba protegido por nada · ✅ RESUELTO

Comparador extraído a `canonicalInvoiceLockOrder()`
(`clientes-finanzas/payment-application.ts`), usado por los dos sitios
reales (`customer-account.service.ts`, `cancellation-refund.service.ts`).
Cerca eléctrica nueva: `src/tests/architecture/lock-order.test.ts` — cuenta
qué archivos invocan las primitivas de lock de `invoices`, exige que la
lista sea exactamente la conocida (clasificados `MULTI_INVOICE_CALLERS` vs
`SINGLE_INVOICE_CALLERS`, con el porqué de cada uno) y que los
multi-invoice usen el helper. `[V]` Verificado que la cerca detecta una
regresión real (se revirtió `cancellation-refund.service.ts` a mano y el
test falló); en el camino se encontró y corrigió un bug propio de la cerca
(sin `stripComments()`, un comentario que menciona la función bastaba para
pasar sin que el código la llamara). Detalle en
[conocimiento/playbook-idempotencia-bajo-lock.md](conocimiento/playbook-idempotencia-bajo-lock.md).

### FOR-KEY-SHARE-001 — la semántica de bloqueo del residual #2 no estaba verificada empíricamente · ✅ RESUELTO

`src/tests/integration/for-key-share-lock-semantics.integration.test.ts`
(nuevo) confirma contra Postgres real: un `INSERT` en
`financial_transactions` con `settled_invoice_id` hacia una factura que
otra transacción sostiene con `FOR UPDATE` queda esperando y completa
recién después del commit. `[V]` La inferencia del comentario en
`cancellation-refund.service.ts` era correcta — el comentario ya no dice
"no verificado", enlaza el test. Con brazo de control (una segunda factura
sin lockear, que sí resuelve dentro de la misma ventana de 600ms) — sin
eso, un Postgres remoto lento podía dar un falso positivo indistinguible
de un bloqueo real. **Alcance declarado, no ampliar sin releer:** solo se
midió `settled_invoice_id`; `reversed_invoice_id` se asume igual por tener
la misma forma de FK, no por una segunda medición. El test es de
integración manual — no corre en ningún pipeline de CI.

### Residuales declarados al cerrar LOCK-ORDER-001 / FOR-KEY-SHARE-001 — no reabren lo cerrado, quedan registrados

- **Comparador `localeCompare` vs. `ORDER BY id` en SQL.** `canonicalInvoiceLockOrder()`
  ordena en JS (`localeCompare`, sensible a locale/ICU); `sql.resource.repository.ts:167`
  ya ordena locks de OTRO dominio (`resources`) en SQL (`ORDER BY id`, bajo
  collation de Postgres). Hoy no chocan (dominios distintos, un solo
  proceso Node) — pero un futuro camino que lockee `invoices` ordenando en
  SQL no sería necesariamente consistente con este helper. No se tocó el
  comparador en este bloque a propósito (la extracción tenía que ser cero
  cambio de comportamiento) — decisión de diseño diferida, no bug.
- **3 falsos negativos declarados de la cerca `lock-order.test.ts`**
  (documentados en su propio header): exige el nombre literal `client` como
  argumento; un método `...ForUpdate` nuevo agregado dentro de
  `sql.invoice.repository.ts` es invisible (archivo excluido a propósito);
  y el chequeo de `canonicalInvoiceLockOrder()` solo prueba que la función
  aparece en el archivo, no que envuelve el array que de verdad alimenta el
  loop de lock.

---

## 🔴 Abierto — registrado por primera vez (05/09/2026)

### BRECHA-REFUND-01-B — un `PAYMENT` sin factura, concurrente con `confirmRefund()`, todavía puede sub-reembolsar · ⚠️ MITIGADO (06/09/2026, commit `6dcb047`, local sin push)

**Mitigado, NO cerrado.** Guard optimista estilo ERPNext en `confirmRefund()`:
relee `getCollectedPaymentTotalForReservation()` (por el pool, después del
loop de INSERT y antes del COMMIT) y aborta con 409 `REFUND_BASE_CHANGED`
si cambió — convierte el sub-reembolso silencioso y permanente en error
visible y reintentable. `architecture-governor` APROBÓ CON CONDICIONES (todas
aplicadas). **Residual B-1 abierto** (ver `pendientes-2026-09-06.md`): el
guard solo ve lo commiteado antes de su `SELECT`; la ventana `guard → COMMIT`
sigue descubierta. Cerrarla exige un lock que cubra la reserva en sí — no
existe. Texto original abajo, sin tocar.

**No es lo mismo que la fila de arriba ya cerrada.** El fix de Residual #2
protege lo que está atado por FK a una factura lockeada. Un `PAYMENT`
puramente contra la reserva (`reservation_id`, sin `settled_invoice_id`) que
commitea en la ventana entre el pre-lockeo de facturas y el `COMMIT` final de
`confirmRefund()` sigue sin reflejarse — la ventana se estrechó (de "toda la
sección antes de la transacción" a "unas pocas sentencias dentro de ella"),
no desapareció. Como `confirmRefund()` es de un solo tiro por reserva (Q-C),
ese faltante queda permanente, no un error visible.

Cerrarlo del todo exige releer `collected` DESPUÉS de adquirir algún lock que
también cubra la reserva en sí (no solo sus facturas) — hoy no existe ese
lock. Bloque de diseño aparte, con `architecture-governor` antes de tocar
código — no autorizado en esta sesión.

---

### F2 — la suite de integración (`src/tests/integration/**`) nunca corre en CI · ✅ RESUELTO (05/09/2026, commit `3073f36`)

**Cerrado en la cuarta vuelta.** Job `integration` nuevo en `ci.yml`
(postgres:16-alpine, `npm run test:integration`, `timeout-minutes: 20`);
sacados del job `test` el contenedor de Postgres y el `TEST_DATABASE_URL`
muertos; y `skipIfNoDb` pasó a `!TEST_DATABASE_URL && !CI`, así que en CI la
falta de la variable da ROJO en vez del verde silencioso. `[V]` Suite
completa contra Postgres real: **148/148, exit 0, 125 s, 0 unhandled
rejections**. `[V]` Fail-loud medido en las dos direcciones: sin `CI` y sin
BD → 19 skipped; con `CI=true` y sin BD → 19 archivos rojos, exit 1, 42
mensajes explícitos, 0 `ECONNREFUSED`.

**Lo que NO está probado todavía, y es la distinción que este mismo ítem
registra:** la suite nunca corrió contra `postgres:16-alpine`. Los 148/148
son contra Neon. Diferencias plausibles: collation por default (cruza con el
residual abierto de `localeCompare` vs `ORDER BY`) y contención de
conexiones. **F2 está implementado, no probado en el entorno donde va a
vivir** — hace falta la primera corrida verde del job en Actions. Si flakea,
mirar antes que nada `hookTimeout` (sin setear, default 10 s, y
`createTestDatabase()` corre en `beforeAll`) y `max_connections=100` de la
imagen, no `timeout-minutes`.

El texto original queda abajo, sin tocar, como registro de lo que se
encontró.

Hallazgo de `architecture-governor` al revisar `FACT-CONSOL-TOCTOU-01`
(05/09/2026) -- preexistente, no causado por ese commit, pero cambia qué
significa "verificado" para TODA la evidencia de integración citada en
este archivo (ORDER-10, RESERVA-10, FACT-CONSOL-TOCTOU-01, y cualquier
`*.integration.test.ts` anterior). `.github/workflows/ci.yml` corre
`npm run test:coverage` → `vitest run --coverage`, que usa
`vitest.config.ts` -- ese config tiene `exclude: ['src/tests/integration/**']`
**siempre**, sin importar los argumentos de la CLI (el propio docblock del
archivo lo dice). Ningún job de `ci.yml` corre `npm run test:integration`
(el que sí apunta a `vitest.integration.config.ts`). `TEST_DATABASE_URL` y
el contenedor de Postgres del job `test` en `ci.yml` (ancla original
`ci.yml:44`, **línea eliminada por el commit `3073f36`** — no buscarla) son
configuración muerta para
esa suite.

**Consecuencia concreta:** cada prueba determinística de lock (ORDER-10,
RESERVA-10, FACT-CONSOL-TOCTOU-01) es un hecho real pero **local y de una
sola sesión** -- no hay gate automático que la vuelva a correr en el
próximo PR/commit. Peor: `describe.skipIf(skipIfNoDb)` hace que la
ausencia de `TEST_DATABASE_URL` sea **verde silencioso**, no rojo -- si
algún día CI corriera esa suite sin la variable configurada, reportaría
"todo bien" en vez de "no se corrió nada".

~~**No arreglado acá**~~ (**arreglado el mismo día**, commit `3073f36` — ver
el encabezado ✅ de este ítem) -- toca `.github/workflows/ci.yml`, bloque propio con
su propio diseño (¿un job nuevo con Postgres real, con qué costo de
tiempo de CI? ¿mantener `skipIf` o exigir la variable en CI?). Registrado
para que no le pase lo que a `requestConsolidatedInvoice()` (H3): un hueco
real, sin categoría propia, que nadie vuelve a mirar.

---

## ✅ Corrección de arrastre — ORDER-05, ORDER-06, ORDER-07, ORDER-09, ORDER-03-b estaban RESUELTOS, no abiertos (05/09/2026)

`pendientes-2026-09-03.md` y la primera versión de este archivo arrastraban
estos ítems como abiertos ("Familia ORDER-\*") sin re-chequear el ancla.
**Segunda vuelta independiente con `erp-audit-orchestrator`** (pedida por el
dueño después de una primera revalidación manual): confirmó los tres
veredictos originales, corrigió dos anclas mal citadas, encontró que el
comando de evidencia documentado NO reproducía "22 passed" (corría 22
*skipped* por no exportar `TEST_DATABASE_URL`), y sumó dos ítems más
(ORDER-09, ORDER-03-b) que también estaban resueltos y sin re-chequear.

**Comando reproducible real** (la corrida anterior de este mismo comando,
sin exportar la variable, da `Tests 22 skipped (22)` en <1s — confirmado
de nuevo al escribir esta corrección):

```bash
source <(grep -v '^#' .env | sed -E 's/^([^=]+)=(.*)$/export \1="\2"/')
npx vitest run --config vitest.integration.config.ts \
  src/tests/integration/order-effects.integration.test.ts \
  src/tests/integration/charge-uniqueness.integration.test.ts \
  --no-file-parallelism
```
→ `Test Files  2 passed (2)` · `Tests  22 passed (22)` · `Duration  121.03s`
(corrida real contra Postgres, 05/09/2026 — la duración de ~2 min, no
milisegundos, es el discriminante barato entre "corrió de verdad" y
"se salteó").

- **ORDER-05 · ✅ RESUELTO (cierra la CAUSA, no todo el síntoma original).**
  `O2I-01`: dos `confirmOrder()` GENUINAMENTE concurrentes (`Promise.allSettled`)
  sobre la misma orden → `reservado() === 3` (la cantidad pedida), no 6.
  Antes de la fix (docblock `order.service.ts:590-604`, 02/09/2026): "6
  reservados para una orden que necesita 3". Mecanismo: la reserva de
  stock ahora cuelga de que `transitionWithClient` devuelva `CAMBIO` (la
  transición atómica solo puede ganarla una de las dos llamadas
  concurrentes) — antes reservaba ANTES de la transición.
  **Aclaración importante (erp-audit-orchestrator, segunda vuelta):**
  el enunciado original tenía DOS mitades — "cobran dos veces" (cerrado
  acá) **y** "dejan stock reservado que nadie libera". La segunda mitad
  (reservas huérfanas, tanto históricas como las que puede seguir dejando
  la compensación de dead-letter en `workers/inventory.handlers.ts:70-80`)
  sigue siendo **`INV-ORF-01`, abierto** — no leer "ORDER-05 RESUELTO" como
  "no quedan reservas huérfanas".
  **Nota estructural:** a diferencia de ORDER-07 (que además tiene un
  índice único de base), la protección acá es enteramente disciplinaria —
  un solo call site (`order.service.ts:620`) colgado de `CAMBIO`, sin
  ninguna clave/constraint en `reserve_stock` que lo haga estructural. Un
  caller futuro que reserve fuera de la transición reintroduce el síntoma
  sin que nada falle.
- **ORDER-06 · ✅ RESUELTO.** `O2I-08` (nombre explícito del test): "no se
  anula el cargo de una orden que NO está cancelada". La guarda real está
  en la IMPLEMENTACIÓN, `sql.financial-transaction.repository.ts:577-580`
  (`EXISTS (... AND o.status IN ('CANCELLED'))` dentro del UPDATE de
  `voidByOrderId`) — el docblock en `financial-transaction.repository.ts:298-304`
  es la interfaz, la describe pero no la ejecuta.
- **ORDER-07 · ✅ RESUELTO.** Evidencia correcta: `O2I-07` (orden cancelada
  no recibe CHARGE), `O2I-11` (estado `COMPLETED` aislado, sin
  `confirmed_at`, no autoriza creación financiera) y `O2I-06` (evento de
  otro `businessId` no crea el CHARGE) — los tres en
  `createOrderChargeIfConfirmed()` (`financial-transaction.repository.ts:271-289`,
  lock de la fila de `orders` + allowlist de estado + `confirmed_at`
  exigido). `O2I-02`/`V45-02` (citados antes acá por error) prueban
  UNICIDAD del cargo, que es la mitad financiera de ORDER-05, no ORDER-07
  — quedan como evidencia complementaria, no como el anchor principal.
  Defensa en profundidad real: lock de aplicación (`createOrderChargeIfConfirmed`)
  + índice único de base `uq_ft_un_charge_por_orden` (schema v45,
  03/09/2026) — **su presencia en las tenant DB de producción no se
  verificó en esta sesión**, no declarar "activa en producción" sin
  chequearlo.
- **ORDER-09 · ✅ RESUELTO.** `settleChargesByOrderId` liquida
  `ft.type IN ('CHARGE')` y nada más (`sql.financial-transaction.repository.ts:401`),
  contrato declarado en `financial-transaction.repository.ts:251-255`
  ("Un `PAYMENT`, un `REFUND` o un `ADJUSTMENT` bajo ese `order_id` no se
  liquidan y no cuentan como éxito"), test `O2R-02` en
  `sql.financial-transaction.repository.test.ts` (~316).
- **ORDER-03-b · ✅ RESUELTO** (la fila de "Familia ORDER-\*" decía
  explícitamente "no está cerrado" — estaba mal). Subsumida en la misma
  sentencia que ORDER-09: `o.status IN ('COMPLETED')` dentro del UPDATE de
  `settleChargesByOrderId` (`sql.financial-transaction.repository.ts:403-406`),
  declarado en `financial-transaction.repository.ts:257` ("ORDER-03-b
  queda subsumido acá"), test `O2R-07` en
  `sql.financial-transaction.repository.test.ts:367`.

**Hallazgo colateral de la misma revisión:** `financial-transaction.repository.ts:306-311`
declara **ORDER-15** ("anular acepta `CHARGE,ADJUSTMENT`, liquidar solo
`CHARGE` — un `ADJUSTMENT` con `order_id` podría anularse y nunca
liquidarse") — registrada en `pendientes-2026-09-03.md:63` pero **se cayó
de la lista** al armar este archivo. Repuesta, ver abajo. Impacto práctico
hoy: cero — ningún camino de código escribe `order_id` en un `ADJUSTMENT`
(el único escritor de `financial_transactions.order_id` es
`createOrderChargeIfConfirmed`, que siempre inserta `type = 'CHARGE'`) —
pero la asimetría queda latente para el día que eso cambie. Si llegara a
pasar hoy: `settleChargesByOrderId` lo clasifica `TIPO_NO_LIQUIDABLE` →
`RECHAZADO`, logueado por `registrarDesenlace()` (`outbox.handlers.ts:271-274`)
como `warn` no reintentable — no se pierde en silencio absoluto, pero queda
`PENDING` para siempre sin que nadie abra incidente.

### ORDER-13 · RESUELTO PARCIALMENTE — tercera vuelta, `erp-audit-orchestrator` (05/09/2026)

`[V]` Corrida real: `O2I-09`/`O2I-10` + los tests de `ChargeNeverCreatedError`/
`ChargeNotYetCreatedError` de `outbox-worker.integration.test.ts`, contra
Postgres real (31/31 tests entre ese archivo y `order-effects.integration.test.ts`,
100.29s).

**Mecanismo: cerrado.** `settleChargesByOrderId` distingue "nada que cobrar"
de "el CHARGE todavía no existe" dentro de la MISMA sentencia
(`sql.financial-transaction.repository.ts:443-449`); por debajo de
`UMBRAL_T01=12` reintentos (~1 min) es `DEPENDENCIA_PENDIENTE`, agotado el
techo es `ChargeNeverCreatedError` → dead-letter inmediato
(`outbox.handlers.ts:225,342-364`). El casillero de `processed_events` se
libera correctamente en el catch (`outbox.worker.ts:393-399`) — sin eso
todo lo anterior sería inútil. La creación tardía converge
(`createOrderChargeIfConfirmed` acepta `COMPLETED` solo con `confirmed_at`
no nulo).

**Precisión sobre la descripción original:** "el `catch` de `dispatch()`
no relanza" sigue siendo literalmente cierto (`outbox.worker.ts:331-361`) —
lo que cambió no es el mecanismo citado, es que el consumidor de aguas
abajo ya no confunde ese comportamiento con éxito.

**Corrección real al residual "sin que nadie se entere":** YA NO ES CIERTO
tal como está escrito. Existe `GET /api/system/outbox/dead-letter` +
`POST /api/system/outbox/:id/retry` (rol `MANAGEMENT`,
`system.routes.ts:24-70`) y el frontend lo consume con un banner rojo en
cualquier página del panel para OWNER/ADMIN (`OutboxAlertBanner`,
`appfrontend-main/src/app/dashboard/layout.tsx:78-120,438`) con botón de
reintento por evento. El operador SÍ ve `eventType`, `aggregateId`,
`lastError`.

**Lo que queda realmente abierto** (más chico y más preciso que "delegado
a O5"):
1. El reintento manual resetea `retry_count = 0`
   (`sql.domain-event.repository.ts:159`) — cada reintento arranca de
   nuevo los ~12 ciclos (~1 min) antes de volver a caer en dead-letter, sin
   que el operador entienda por qué se repite.
2. El mensaje (`ChargeNeverCreatedError`) no es de negocio — no le dice a
   alguien sin perfil técnico "la orden X se completó pero no tiene cargo,
   el cliente no debe nada".
3. **No existe ninguna conciliación "órdenes `COMPLETED` sin `CHARGE`"** —
   el único `NOT EXISTS` que cruza `orders`/`financial_transactions` en
   todo `src/` es el propio de `createOrderChargeIfConfirmed`
   (`sql.financial-transaction.repository.ts:505`). Si el evento se
   perdiera fuera del carril del outbox, nada lo detecta. **Este punto es
   acotado y NO depende del diseño de O5** — se puede resolver aparte.

**O5** (gestión operativa durable de incidentes) — confirmado **ABIERTO,
sin diseño ni diff**: `docs/continuidad-order-lifecycle-integrity-v1-2026-09-03.md:198-203`
lo declara explícito, y en código no existe ninguna tabla de incidentes
(`grep -in "incident" src/db/*.sql` no devuelve ninguna `CREATE TABLE`,
solo comentarios narrativos) ni ningún `onDeadLetter` registrado para
eventos financieros (`grep -rn "onDeadLetter" src/` → solo
`inventory.handlers.ts:144`).

**No decidido — 3 opciones, no elegidas:** (a) cerrar ORDER-13 del todo y
dejar el residual solo bajo O5; (b) mantenerlo parcial hasta que exista la
conciliación del punto 3; (c) cerrar ORDER-13 y abrir un ítem chico
separado solo por los puntos 1+3, dejando O5 para la tabla de incidentes
en sí.

### ORDER-10 · ABIERTO — más grave de lo que decía la fila original, tercera vuelta (05/09/2026)

`[V]` Ancla verificada BYTE A BYTE contra el commit que la registró
(`3f2097c`) — `invoice.service.ts:304-316` es idéntico, no está stale.

**No es solo "sin implementación" — es reachable desde la UI real de
producción, por una decisión de producto ya tomada y documentada:**

1. Se confirma una orden → `CHARGE` `PENDING` con `order_id`
   (`outbox.handlers.ts:289-321`).
2. Aparece en Cuentas Corrientes del cliente con botón de facturar activo
   — a propósito: *"Facturar es independiente de haber cobrado (PENDING es
   válido)"* (`appfrontend-main/.../cuentas-corrientes/page.tsx:298-306`,
   comentario explícito, decisión tomada, no descuido).
3. `requestInvoice()` no mira `tx.status` en ningún punto
   (`invoice.service.ts`, cero referencias a `tx.status` en todo el
   archivo) — se emite Factura B con CAE real contra un cargo `PENDING`.
4. Se cancela la orden (`CONFIRMED → CANCELLED` permitido,
   `order.service.ts:226`). `cancelOrder()` no consulta facturas en NINGÚN
   momento — cero referencias a `invoice` en todo `src/pos-menu/`.
5. `voidByOrderId` (`sql.financial-transaction.repository.ts:557-611`)
   anula el `CHARGE` sin ningún JOIN/EXISTS contra `invoices`.
6. **Es silencioso**: el desenlace es `APLICADO` sin rechazos,
   `registrarDesenlace()` no loguea ese caso.

**Resultado:** una factura `ISSUED` con CAE real de AFIP apuntando a un
`CHARGE` `VOIDED`. Sin Nota de Crédito, sin señal, sin registro — el
comprobante fiscal existe frente a AFIP, el hecho económico que lo respalda
fue borrado del saldo del cliente.

**Sin ninguna implementación parcial:** cero referencias a "ORDER-10" en
todo `src/`; `InvoiceRepository` tiene `getByReservationId()` pero **no**
`getByOrderId()` — ni siquiera existe la consulta para encontrar las
facturas de una orden. Las 108 pruebas unitarias de `invoice.service` +
`order.service` pasan porque el caso no tiene ninguna aserción, no porque
esté cubierto.

**Contraste con reservas, con matices honestos:** `CancellationRefundService.confirmRefund()`
resuelve el caso análogo para reservas (LIFO, tope por factura, NC real) —
pero es acción MANUAL separada de `/cancel` (no dispara sola al cancelar),
y reparte sobre lo COBRADO. Un port literal no serviría acá: el caso típico
de ORDER-10 tiene `CHARGE` `PENDING` (nada cobrado todavía) — con
`collected = 0`, `confirmRefund` lanzaría `NothingToRefundError` y la
factura seguiría igual de huérfana. Lo que hace falta es una NC por
anulación de comprobante, no un refund.

**4 opciones de resolución, NINGUNA elegida** (decisión del dueño):
(a) fail-closed en el cancel — rechazar cancelar una orden con `CHARGE`
facturado `ISSUED`, exigir pasar por un flujo de NC antes (menor diff,
mismo precedente que AR-FACT-NO-ISSUED-01 Fase 1); (b) compensar
automático — emitir la NC al cancelar (más correcto, mucho más caro,
hereda la complejidad de reparto de `confirmRefund`); (c) fail-closed
aguas arriba — no facturar un `CHARGE` `PENDING` de orden (**contradice
una decisión de producto ya tomada y documentada**, no es neutral
proponerlo); (d) barrera estructural — trigger/constraint que impida
`VOIDED` sobre una `financial_transaction` con factura `ISSUED` (invariante
más fuerte, pero rompe con error de base sin mensaje de negocio).

**Evidencia que falta y requiere autorización aparte:** no se verificó si
el caso ya ocurrió en las tenant DB reales (`Hotel los Alamos`, `Demo`).
Consulta de solo lectura preparada, no corrida:
```sql
SELECT i.id, i.cbte_nro, i.status, ft.id, ft.status, ft.order_id
FROM invoices i JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
WHERE i.status='ISSUED' AND ft.status='VOIDED' AND ft.order_id IS NOT NULL;
```
Si esa consulta devuelve filas, esto deja de ser riesgo latente y pasa a
ser un descuadre fiscal que ya existe — cambia la prioridad por completo.

### ORDER-10 — revisión de diseño con `architecture-governor` (05/09/2026), APROBADA CON CONDICIONES

Antes de escribir código se mandó la síntesis de las 3 consultas ERP
(ERPNext, Odoo 19 genérico, módulos argentinos de `odoarg` — estos
últimos NEGATIVO CONFIRMADO, sin lógica de cancelación con CAE, solo
presentación) a revisión de diseño. El gobernador encontró 3 agujeros
reales en la propuesta original ("un `NOT EXISTS` en `voidByOrderId()`"),
no solo estilo:

1. **El predicado ingenuo es fail-open para facturas consolidadas** —
   `invoices.financial_transaction_id` es NULLABLE (C1-Fase C); una
   factura consolidada vincula por `invoice_charges`, no por esa columna.
   El guard tiene que espejar el mismo `UNION ALL` que ya usa
   `resolveInvoiceLinkage()` (`sql.invoice.repository.ts:227-238`), no
   solo el lado individual.
2. **Bloquear solo en `status='ISSUED'` es más débil que el precedente
   que invoca** (AR-FACT-NO-ISSUED-01): también hay que bloquear en
   `PENDING` (CAE en vuelo) y en `FAILED_UNCERTAIN` con
   `afip_contacted=TRUE` (puede existir ya en AFIP) — pero NO en
   `REJECTED` (AFIP rechazó explícito, sobre-bloquear ahí congela cargos
   legítimos para siempre).
3. **El guard dentro de `voidByOrderId()` solo, NO cierra la ventana de
   carrera que dice cerrar** — es el hallazgo más importante. No hay lock
   compartido entre `voidByOrderId()` (autocommit, sin transacción) y
   `requestInvoice()` (`getById()` pre-transaccional, nunca lockea la
   fila del `CHARGE`). Es write-skew clásico: las dos operaciones pueden
   commitear sin verse. La reparación real necesita que `requestInvoice()`
   releea la `financial_transaction` con `FOR UPDATE` DENTRO de su propia
   transacción y rechace si ya está `VOIDED` — mismo patrón, mismo
   archivo de lección, que el residual #2 de BRECHA-REFUND-01 (`1807ca8`)
   cerró para `confirmRefund()`.

Además: (4) sería el primer SQL de `clientes-finanzas` contra tablas de
`facturacion` — `lint:arch` no lo va a ver (chequea imports, no SQL cross-
dominio) — hay que elegir y documentar explícitamente si se acepta el
acoplamiento o se mueve el chequeo al handler (esto último reabre la
carrera salvo que el `FOR UPDATE` del punto 3 ya esté puesto); y (5)
`voidByReservationId()` (lado reservas) tiene el defecto idéntico — no se
arregla en este bloque, ver ítem propio abajo.

**Pregunta de negocio reformulada, no resuelta por el gobernador a
propósito** (hay una decisión real con dos respuestas válidas, y una
tercera opción -- "que la orden vuelva a `CONFIRMED`" -- **no es
técnicamente viable**: no existe transición de des-cancelar, el stock ya
se restauró para cuando el guard rechazaría, y `handleOrderCancelled` no
tiene ni repo de órdenes ni transaction manager para revertir nada):

- **(A) Rechazar la cancelación en la puerta** — la orden sigue
  `CONFIRMED`, el stock no se restaura, pero queda trabada hasta que
  exista un flujo de Nota de Crédito (que hoy no está construido).
- **(B) Aceptar la cancelación, dejar el cargo vivo** — la orden pasa a
  `CANCELLED`, el stock se restaura, pero el `CHARGE` no se anula: el
  cliente sigue debiendo esa plata hasta que alguien emita la NC a mano.

La respuesta determina si el guard en `cancelOrder()` es el mecanismo
PRIMARIO (rama A) o si NO debe construirse porque bloquearía la
operación que el dueño quiere permitir (rama B) — no es "opcional de UX"
en ninguna de las dos ramas.

**Sin schema nuevo** para el guard en sí (predicado sobre tablas/columnas
existentes) — **salvo** que se elija un estado intermedio tipo "pendiente
de nota de crédito", que sí sería schema (bloque aparte, con backup
durable previo).

### ORDER-10 — decisión de negocio del dueño + segunda revisión de diseño, `architecture-governor` (05/09/2026)

El dueño respondió **(A) con puerta de escape administrativa**: la
cancelación se rechaza en la puerta si el cargo ya tiene factura con CAE;
existe una acción separada (`Roles.MANAGEMENT`) que emite una Nota de
Crédito real y recién con eso habilita cancelar. Propuso una tabla
`credit_note` nueva y dedicada para esa NC.

`architecture-governor` **rechazó la tabla nueva, con motivo** (no la
doctrina de negocio, que quedó intacta): campo por campo, todo lo que
pedía la tabla ya existe en `invoices`/`financial_transactions` — y el
ciclo de vida de dos estados que proponía (`PENDIENTE_EMISION`/`EMITIDA`)
es más pobre que el que ya hay (`PENDING`/`ISSUED`/`REJECTED`/
`FAILED_UNCERTAIN`+`afipContacted`): le faltan justo los dos estados
donde vive el riesgo de duplicar un comprobante ante AFIP. Decisión final,
diseño completo y consecuencias (sin schema nuevo, `ADJUSTMENT`
compensatorio en vez de status nuevo, cierre de la ventana de carrera vía
lock en `orders`, alcance de bloque 1 fail-closed en todo lo demás):
[diseno-cancelacion-orden-nota-credito-2026-09-05.md](diseno-cancelacion-orden-nota-credito-2026-09-05.md).

**Verificado contra las dos bases reales (ambas de datos ficticios de
prueba, confirmado por el dueño 05/09/2026), de solo lectura, 05/09/2026:**
las 3 consultas que quedaron pendientes arriba dieron **0 filas / 0 / 0**
en `Hotel los Alamos` y en `Demo` — ORDER-10 sigue siendo riesgo latente,
no un descuadre ya ocurrido, y no hay datos preexistentes que rompan el
discriminador nuevo de `requestInvoice()`.

**B1 -- ✅ RESUELTO (commit `22f0559`, 05/09/2026).** Guard fail-closed
completo: `cancelOrder()` rechaza contra factura vinculada,
`voidByOrderId()` tiene su backstop (`CARGO_CON_COMPROBANTE_VIVO`), y
`requestInvoice()` cierra la ventana TOCTOU tomando el mismo lock de
`orders`. Autorizado por `architecture-governor` en dos vueltas, con
correcciones al mensaje de commit. 1827 tests unitarios + 25 de
integración contra Postgres real (incluida una prueba determinística de
bloqueo de lock y el backstop con una Factura B `ISSUED` real, ambas
verificadas por mutation testing manual). Detalle completo:
[diseno-cancelacion-orden-nota-credito-2026-09-05.md](diseno-cancelacion-orden-nota-credito-2026-09-05.md).
~~**Commiteado en `main`, NO pusheado todavía** (`git push` es autorización
aparte del usuario).~~ **CORREGIDO en la cuarta vuelta (05/09/2026):
`22f0559` YA está en `origin/main`** — verificado con `git ls-remote` y
`git merge-base --is-ancestor 22f0559 origin/main` → true. O sea que **B1
está en producción**, y con él la puerta de cancelación cerrada sin la
ventana de B2 abierta (ver bloque 2 de la cuarta vuelta). Los 6 commits
que sí siguen sin pushear son `caf24e1`, `32125d3`, `179b4ad`, `f68db51`,
`1f3af80`, `2f9f23f`.

**ORDER-10 sigue ABIERTO** -- B2 (escape administrativo con Nota de
Crédito), B3 (visibilidad de NC pendientes) y B4 (cierre de período
contable) no están implementados. No confundir "B1 resuelto" con "ORDER-10
cerrado".

**Ítems nuevos, encontrados al implementar/revisar B1 (no bloquean B1, sí
a B2 o a la salud general del repo):**
1. Sin cerca automática que garantice el orden de locks `orders`-antes-que-
   `invoices` hacia adelante -- verificado por inspección manual que hoy
   no existe el camino inverso, pero nada lo impide estructuralmente.
   `src/tests/architecture/lock-order.test.ts` fenza otra cosa (orden
   multi-fila DENTRO de `invoices`), no esto.
2. `CARGO_CON_COMPROBANTE_VIVO` se degrada a `INFO` (no `grave`) si algún
   día existiera un `ADJUSTMENT` con `order_id` -- hoy inalcanzable
   (ningún creador real de `ADJUSTMENT` usa `orderId`), declarado no
   cerrado.
3. Ese mismo log se va a volver un falso positivo ruidoso en cuanto exista
   B2: una cancelación legítima vía NC también deja la Factura B original
   `ISSUED` y pasa por el mismo camino de rechazo. B2 tiene que
   reconciliar esto antes de salir a producción.
4. La prueba de bloqueo de lock
   (`order-cancel-invoice-toctou.integration.test.ts`) no es estable en
   pass/fail cuando corre junto a otras suites de integración contra el
   Postgres remoto de `TEST_DATABASE_URL` (Neon, latencia real ~8-15s por
   test) -- su ventana es de 4s fijos. Corrida sola pasa 3/3; en una
   corrida combinada puede fallar por latencia acumulada. Degrada en
   ROJO, nunca aprueba un guard roto en falso -- pero no es "siempre
   verde en CI". ~~Pendiente: ventana adaptativa o marcarla para correr
   aislada.~~ **✅ RESUELTO (05/09/2026, commit `f95c9c5`) — ventana
   adaptativa.** El diagnóstico original se quedaba corto: medido con
   mutation testing, el brazo de CONTROL resuelve en **3978 ms contra una
   ventana de 4000 ms**. No era "no estable en corrida combinada", era un
   test apoyado exactamente sobre el borde. Ahora la referencia temporal es
   el propio control (se espera a que el brazo sin lock termine, techo duro
   30 s, y recién ahí se pregunta si el bloqueado sigue pendiente, margen
   1,5 s); el invariante afirmado pasa a ser "el bloqueado sobrevive al de
   control" y no depende de la latencia absoluta. `[V]` 3/3 y suite completa
   148/148 contra Postgres real. Residual del residual, declarado: la
   mutación se hizo sobre el archivo de test, no sobre el guard de
   `invoice.service.ts:384` — el clasificador de permisos bloqueó editar
   producción y no se forzó.

### `voidByReservationId()` — mismo defecto que ORDER-10, lado reservas · ✅ RESUELTO (05/09/2026, commit `179b4ad`) — etiqueta "RESERVA-10"

**Definición de la etiqueta (única, para que no le pase lo mismo que a
"RBAC — mecanismos 1 y 2"):** "RESERVA-10" nombra este bloque -- puerta
fail-closed en `cancelReservation()` + backstop en `voidByReservationId()`
+ guard TOCTOU simétrico en `InvoiceService.requestInvoice()` para
`tx.reservationId`. El `10` está **prestado** del número de ORDER-10 (es
el mismo bug, portado al circuito de reservas) -- no abre una serie
`RESERVA-01..09` propia ni numera nada más.

~~`sql.financial-transaction.repository.ts:308-316` anula `CHARGE`/
`ADJUSTMENT` de una reserva sin mirar facturas — mismo mecanismo exacto
que ORDER-10, y encima devuelve `number` en vez de `EfectoDesenlace` (ni
siquiera tiene el vehículo de rechazo tipado que `voidByOrderId()` ya
tiene). Si se cierra ORDER-10 solo del lado órdenes, este queda con la
forma idéntica del bug y un lector futuro va a suponerlo cubierto porque
"ya se arregló eso". Ítem propio, no se toca hasta que haya diseño
dedicado.~~

**Resuelto:** decisión del dueño del producto (AskUserQuestion) -- mismo
alcance completo que ORDER-10 Bloque 1, sin escape administrativo
todavía (la Nota de Crédito para reservas no existe, igual que B2 del
lado órdenes). Verificado read-only contra las dos tenant DB antes de
implementar: 0 filas afectadas -- riesgo latente, no descuadre ya
ocurrido. Evidencia: 16 tests unitarios nuevos, 3 archivos de integración
contra Postgres real (incluido uno nuevo con la prueba determinística de
bloqueo de lock, mismo patrón que ORDER-10), mutation testing manual
sobre el guard TOCTOU y sobre el `NOT EXISTS` del backstop -- las dos
verificadas fallando con el guard desactivado y volviendo a pasar
restaurado.

**Ítems nuevos, encontrados al implementar/revisar RESERVA-10 (ninguno
bloqueante, `architecture-governor`, 05/09/2026):**

1. **`reservation-hold-expiry.worker.ts` -- el `voidByReservationId()`
   del worker de holds vencidos quedó como no-op estructural.** Una
   reserva que vence llega a `EXPIRED` (`Reservation.ts`), nunca
   `CANCELLED` -- el `EXISTS` nuevo del CTE exige `CANCELLED`, así que
   esa llamada ahora resuelve siempre `RECHAZADO`
   (`RESERVA_ESTADO_NO_ELEGIBLE`). Sin impacto de datos hoy (ningún
   `CHARGE` existe todavía para una reserva que nunca se confirmó), pero
   el comentario original del archivo afirmaba una garantía ("cubre el
   `CHARGE` si el modelo cambia más adelante") que dejó de sostenerse --
   corregido en el mismo commit (docblock + log del desenlace en vez de
   descartarlo en silencio). Ampliar el CTE a `('CANCELLED','EXPIRED')`
   es una decisión de negocio nueva (¿el cargo de un hold vencido se
   anula igual que uno cancelado?), no tomada -- fuera de alcance.
2. **`reserva_no_elegible` usa test negativo, `voidByOrderId()` usa
   whitelist positiva.** Declarado con un comentario en la sentencia SQL
   -- `reservations` no tiene un conjunto cerrado de "estados no
   elegibles" que valga enumerar (solo `CANCELLED` es elegible). Un
   estado desconocido futuro cuenta en dos columnas del lado reserva
   (`reserva_no_elegible` y `estado_desconocido`) contra una sola del
   lado orden. Más ruidoso a propósito, no menos correcto.
3. ~~**`requestConsolidatedInvoice()` no tiene NINGÚN guard TOCTOU** -- ni
   de orden cancelada ni de reserva cancelada. El hueco es unidireccional
   (la puerta de cancelación SÍ cubre facturas consolidadas, porque
   `resolveInvoiceLinkage()` unifica `invoice_charges`), pero existe: se
   puede consolidar-facturar el cargo de una orden o reserva que se
   acaba de cancelar, en una ventana que ningún lock cubre hoy.
   **Este hueco existe desde ORDER-10 (05/09/2026) y nunca se había
   registrado en ningún `pendientes-*.md` hasta ahora** -- exactamente
   el patrón "hallazgo fuera de toda categoría que alguien relee" que
   este mismo archivo advierte más arriba. Bloque propio, cubre órdenes
   y reservas juntas, con su propio diseño -- no se toca acá.~~
   **H3 · ✅ RESUELTO (05/09/2026, commit `1f3af80`) -- etiqueta
   "FACT-CONSOL-TOCTOU-01"** (nombre único, definido acá una sola vez: no
   es un `ORDER-N` ni un `RESERVA-N`, es la etiqueta propia de este
   hallazgo, para que no le pase lo que a "RBAC — mecanismos 1 y 2").
   Ancla: `src/facturacion/invoice.service.ts:449-466` (docblock) y
   `:522-552` (el guard en sí, dentro de `transactionManager.run()`).
   Generaliza el mismo mecanismo de ORDER-10/RESERVA-10 a los N
   `orderId`/`reservationId` distintos de un lote consolidado, lockeados
   en orden ASCENDENTE de id (A8.1/A8.2) y deduplicados. Decisión del
   dueño del producto (AskUserQuestion, 05/09/2026): si CUALQUIERA de las
   N resulta CANCELLED, se rechaza el LOTE ENTERO -- misma política que
   el guard de double-billing ya existente en la misma función, mecanismo
   distinto (ese corre antes de abrir la transacción, sin lock; este
   corre dentro, con `FOR UPDATE` real). Investigación previa confirmó
   que el único creador real de `accounts_receivable`
   (`transferStayBalanceToReceivable()`) siempre setea `reservationId`,
   nunca `orderId` -- el lado órdenes del guard no tiene hoy ningún
   llamador de producción, existe por paridad con `requestInvoice()`.
   Evidencia: 5 tests unitarios nuevos + 3 de integración contra Postgres
   real (`consolidated-invoice-toctou.integration.test.ts`, incluida la
   prueba determinística de bloqueo de lock), mutation testing manual de
   los dos guards contra fakes Y contra Postgres real, más un tercer
   mutation test sobre el invariante de orden ascendente de lock (ver
   residual 1 abajo).

   **Residuales encontrados en la revisión de este commit
   (`architecture-governor`, ninguno bloqueante):**
   - **R1 -- fail-open si la orden/reserva no existe.**
     `invoice.service.ts:539` (`if (order && order.status === 'CANCELLED')`)
     y `:548` (misma forma del lado reserva): si la fila no existe,
     factura igual. Simétrico con el guard ya existente de
     `requestInvoice()` (`:385`, `:401`), consistente pero fail-open, sin
     documentar hasta ahora.
   - **R2 -- `getByIdWithLock` es opcional en la interfaz**
     (`src/reservas/reservation.repository.ts:48`). Un repositorio que no
     lo implemente degrada en silencio a una lectura sin lock -- la
     seguridad hoy es una propiedad del *wiring* (`invoices.routes.ts` sí
     inyecta `SqlReservationRepository`, que lo implementa), no del
     sistema de tipos: nada fallaría de compilar si ese wiring cambiara.
     El arreglo real (hacerlo obligatorio en la interfaz) toca
     `reservation-hold-expiry.worker.ts` y `reservation.service.ts` --
     bloque propio, no se toca en este commit.
   - **R3 -- este commit NO cierra el gap de `markInvoiced()` post-commit.**
     Después de `issue()`, `requestConsolidatedInvoice()` marca cada
     `accounts_receivable` como FACTURADO en un loop best-effort, FUERA de
     la transacción y del lock (`invoice.service.ts` ~588-600). Un CAE
     real puede existir con esas filas todavía `PENDIENTE_FACTURAR` si ese
     paso falla. Ya trackeado como AR-FACT-NO-ISSUED-01 (Fases 2-8
     diferidas) -- este commit cierra la carrera de facturar-algo-ya-
     cancelado, no ese gap distinto.
   - **R4 -- el lado órdenes del guard no tiene cobertura de integración.**
     Cubierto solo por unit tests con fakes (ningún creador real de
     `accounts_receivable` setea `orderId` hoy) -- para que un lector
     futuro no confunda "tiene tests" con "verificado contra Postgres
     real", que es cierto solo del lado reservas.

### Discrepancia de estado git encontrada (no resuelta, fuera de alcance del auditor)

`docs/continuidad-ar-fact-no-issued-01-2026-09-04.md:9-11` afirma
`HEAD = b088cbc`, 14 commits por delante de `origin/main = 1f72f41`, sin
push — no coincide con el árbol de hoy (`main` avanzó mucho desde
entonces, con push intermedio). Mismo linaje que el arrastre stale que
veníamos corrigiendo: un documento afirmando un estado que nadie
revalidó. Se resuelve con un `git fetch` + comparación, no hecho todavía.

### ORDER-17 — `addItem`/`removeItem` validan el estado de la orden FUERA del lock (mismo linaje que ORDER-04) · ✅ RESUELTO (05/09/2026, commit `caf24e1`)

Encontrado por `erp-audit-orchestrator` en la segunda vuelta, verificado y
corregido en tercera ronda con `architecture-governor` (dos vueltas de
revisión). **Corrección al mecanismo descripto originalmente acá abajo**
(dejado tachado, no borrado, por la regla de este repo de no reescribir
historial): la descripción original decía que `sql.order.repository.ts`
"SÍ toma `FOR UPDATE` sobre la fila de `orders` dentro de su propia
transacción (`addItem()`, líneas 411-418)". **Eso era falso.** Esa rama
chequeaba `(this.db as unknown as {_pool?})._pool` para decidir si abría
ese `BEGIN`/`FOR UPDATE`/`COMMIT` a mano — pero ningún `SqlClient` real
(el que arma `tenant.middleware.ts` para `req.db`) expone `_pool`, así que
esa rama NUNCA corrió en producción. El camino real caía siempre a
`addItemWithClient()`, que insertaba el ítem pero **nunca actualizaba
`orders.total_amount`** — no era una carrera de concurrencia, pasaba
SIEMPRE que se agregaba un ítem después de crear la orden (vía
`POST /:id/items`, activo en el frontend desde el fix de ORDER-11).

~~**Consecuencia:** agregar o quitar un ítem mientras se confirma la misma
orden puede dejar el importe cobrado (`CHARGE`) distinto del importe final
de la orden (`total_amount`), y stock sin reservar para un ítem que sí
quedó en `order_items` — de forma permanente, porque
`uq_ft_un_charge_por_orden` (correctamente) impide recrear el cargo.~~
**Consecuencia real (verificada al implementar):** todo ítem agregado
después de crear la orden se servía y descontaba stock, pero
`orders.total_amount` nunca se movía de su valor original — el `CHARGE`
que emite `order.confirmed` se quedaba corto (o en cero, si la orden se
creó vacía), sin necesitar ninguna concurrencia. Aparte, `removeItem()`
(`sql.order.repository.ts`, antes de este fix) hacía
`DELETE FROM order_items WHERE id = $1` **sin `AND order_id`**, pese a
recibir `orderId` como parámetro — con el `itemId` de otra orden borraba
la línea ajena.

**Verificación contra las dos tenant DB reales (ambas de datos ficticios
de prueba), 05/09/2026, antes de implementar el fix:** 0 filas con
`total_amount` desincronizado de `SUM(order_items.subtotal)` en
`Hotel los Alamos` y en `Demo` — el bug no había producido daño real
todavía en ninguna de las dos, era riesgo latente verificado en código,
no un descuadre ya ocurrido.

**Fix:** mismo criterio ya aplicado por ORDER-04/05/08/14 y ORDER-10 —
`addItem()`/`removeItem()` (autocommit) ELIMINADOS de `IOrderRepository`
en vez de quedar como código muerto. `OrderService.addItem()`/
`removeItem()` corren ahora dentro de `transactionManager.run()`, con
`getByIdForUpdate()` (el lock que ya existe, agregado para ORDER-10) como
primera operación — cierra la ventana entre chequear `status === 'DRAFT'`
y escribir. `removeItemWithClient()` (nuevo, reemplaza a `removeItem()`)
lleva `AND order_id = $2` en el `DELETE`. El total se recalcula con
`UPDATE orders SET total_amount = COALESCE((SELECT SUM(subtotal)...),0)`
dentro de la misma transacción, no sumando en JS (`getByIdForUpdate()`
devuelve una foto en SQL pero la MISMA referencia ya mutada en memoria en
el fake de tests — el `SUM` contra la fuente de verdad es lo único
correcto contra las dos implementaciones).

Evidencia: `tsc`/`lint`/`lint:arch` limpios; 1835 tests unitarios; suite
de integración completa (17 archivos, 140 tests) contra Postgres real sin
regresiones, incluidos 3 tests nuevos en `order-flow.integration.test.ts`
que ejercitan el SQL real (el fake en memoria nunca tuvo ninguno de los
dos bugs, así que solo un test contra Postgres real podía detectarlos).
Mutation testing manual sobre el `DELETE` de `removeItemWithClient()`
(sacarle el scoping por `order_id`): el test de integración
correspondiente falla como se espera; restaurado, vuelve a pasar.

**Anclas (estado ANTERIOR al fix, para quien busque el commit que lo
introdujo):** `order.service.ts:535-549` (guard fuera de transacción) +
`sql.order.repository.ts:411-418` (`addItem`, lock muerto) +
`sql.order.repository.ts:508-524` (`removeItem`, sin lock ni scoping).

**Residuales abiertos, encontrados al implementar/revisar (ninguno
bloqueante para este fix):**

1. **`addItem()` sostiene el `FOR UPDATE` sobre `orders` mientras
   `resolveOrderItemInput()` consulta producto/tarifa por una SEGUNDA
   conexión del mismo pool de tenant** (`getTenantRawPool(businessId)`,
   `max: 5` — `tenant.middleware.ts`). Con 5 `addItem()` concurrentes del
   mismo tenant, las 5 conexiones quedan tomadas esperando una sexta.
   Acotado por `connectionTimeoutMillis: 5000` (degrada a error, no a
   cuelgue permanente) y es patrón preexistente (`createOrder()` hace lo
   mismo). Ancla: `order.service.ts` (método `addItem()`) +
   `tenant.middleware.ts:105`.
2. **Decisión de producto sin tomar:** `removeItem()` con un `itemId` que
   no pertenece a la orden del path ahora devuelve 204 "silencioso" (antes
   borraba la fila equivocada; ahora no borra nada, pero tampoco avisa).
   Si conviene 404 en vez de 204 para ese caso es una decisión de
   producto, no técnica.
3. **ORDER-17-b (mejora estructural, no bug):** `recalculateTotalWithClient()`
   vive hoy como SQL crudo dentro de `OrderService` (el único
   `*.service.ts` del repo con `client.query` directo). Movería mejor a
   `IOrderRepositoryWithClient` (SQL = `UPDATE...SUM`, in-memory =
   `reduce`), lo que además haría que los tests unitarios SÍ puedan
   detectar una regresión si alguien borra la llamada (hoy no pueden, ver
   docblock del describe en `order.service.test.ts`), y permitiría reusar
   el helper en `createOrder()` (`order.service.ts`), que hoy repite el
   mismo `UPDATE` a mano.
4. **`SqlOrderRepository.create()` (legacy, documentado como tal en su
   propio docblock)** sigue sumando el total en JS y solo lo escribe
   `if (total > 0)` — misma familia de defecto, fuera de alcance de este
   bloque.

---

## 🔴 Arrastrado de `pendientes-2026-09-03.md`

**Sin re-verificar en esta sesión, salvo donde se indica arriba.** Su estado
se conserva porque nadie lo cerró, no porque se haya vuelto a comprobar.

- **ORDER-15** — anular (`voidByOrderId`) acepta `type IN ('CHARGE','ADJUSTMENT')`
  mientras que liquidar (`settleChargesByOrderId`) quedó en `('CHARGE')`
  solo — un `ADJUSTMENT` con `order_id` (hoy no existe, el único creador
  usa `reservationId`) podría anularse y nunca liquidarse. Declarada en
  `financial-transaction.repository.ts:306-311`. Repuesta en la lista
  (ver corrección arriba — se había caído).
- **ORDER-13** — RESUELTO PARCIALMENTE (ver corrección arriba): mecanismo
  cerrado, queda abierto solo el residual acotado (retry_count reseteado,
  mensaje no de negocio, sin conciliación `COMPLETED` sin `CHARGE`) — no
  depende de O5 para ese último punto.
- **ORDER-10** — B1 (guard fail-closed) ✅ RESUELTO, commit `22f0559`
  (05/09/2026, sin pushear). ABIERTO igual: B2 (escape administrativo con
  Nota de Crédito), B3 (visibilidad de NC) y B4 (cierre de período
  contable) siguen sin implementar — ver corrección arriba.
- **ORDER-17** (`addItem`/`removeItem` sin lock de estado) — ✅ RESUELTO,
  commit `caf24e1` (05/09/2026, sin pushear todavía). 4 residuales
  registrados, ninguno bloqueante — ver corrección arriba.
- **RESERVA-10** (`voidByReservationId()`, mismo defecto que ORDER-10 lado
  reservas) — ✅ RESUELTO, commit `179b4ad` (05/09/2026, sin pushear
  todavía). 3 hallazgos nuevos registrados (H1 hold-expiry worker, H2
  divergencia de test negativo, H3 `requestConsolidatedInvoice()` sin
  guard TOCTOU en NINGÚN lado, órdenes incluido) — ver ítem propio arriba.
- **FACT-CONSOL-TOCTOU-01** (H3 de RESERVA-10, `requestConsolidatedInvoice()`
  sin guard TOCTOU) — ✅ RESUELTO, commit `1f3af80` (05/09/2026, sin
  pushear todavía). 4 residuales registrados (R1 fail-open sin fila, R2
  `getByIdWithLock` opcional en la interfaz, R3 `markInvoiced()`
  post-commit sin cerrar -- AR-FACT-NO-ISSUED-01 sigue abierto, R4 lado
  órdenes sin cobertura de integración) — ver ítem propio arriba. También
  salió de esta revisión **F2** (suite de integración nunca corre en CI) —
  ítem propio, sección "Abierto — registrado por primera vez".
- **INV-ORF-01** — reservas de stock huérfanas: la causa de doble-reserva
  (ORDER-05) está cerrada, pero las filas históricas y la otra causa
  (compensación de dead-letter, `inventory.handlers.ts:70-80`) siguen
  abiertas.
- **EVT-ORF-01**, **CAJA-ORD-01**, **AUDIT-ORD-01**, **ORDER-12**.
- **O1-b** — los reportes no distinguen "no consta" de "cero".
- **Seguridad / aislamiento:** FACT-INV-BIZID-001, SEC-ROT-001, RBAC-OWN-001,
  RBAC-SYNC-001, RBAC-MOUNT-001, FAILOPEN-001.
- **Documentales:** ~~AUDIT-DOC-001~~ (**✅ RESUELTO**, commit `e1476f5`, 38
  archivos versionados — estaba arrastrado stale y **este mismo archivo lo
  documenta cerrado 50 líneas más abajo**, en la sección de higiene),
  DA-CONT-001 (parcial), DOC-ANCLA-001, CONTRACT-001,
  ~~"RBAC mecanismos 1 y 2"~~ (**ETIQUETA RETIRADA** en la cuarta vuelta —
  origen localizado en `pendientes-2026-08-25.md:1379-1380`, nunca definida
  en ninguno de los dos repos, viajó idéntica por 8 archivos; regla 1 del
  `CLAUDE.md` de `app-main`).
- **Backlog de producto:** Gap C1-C (**mitad cerrada sin registrarse** — ver
  cuarta vuelta), FISCAL-CBTE-001, FACT-BORRADOR-001,
  C1-Fase A, **C1-Fase B (REPUESTA en la cuarta vuelta: se cayó de la lista
  entre el 02/09 y el 03/09 sin que nadie la cerrara — "bloqueada hasta que el
  negocio elija proveedor")**,
  **C2 (ya no bloqueada, ver arriba — sigue sin construir)**, C3,
  D7, frontend visual (SEM-001, SEM-002, TOAST-003, A11Y-001, overlays de
  Superadmin), heredados (Redis rate-limit, BullMQ, etapas 2-3 de downgrade,
  datos demo en la base real).
- **A7.6** — política de retención escrita: sigue abierto, sin purga para
  `audit_log` ni `domain_events`.
- **AR-FACT-NO-ISSUED-01** — Fase 1 cerrada (`4029b96`, `4d2d694`, `b088cbc`,
  ya en `origin/main`); Fases 2-8 (tabla `invoice_reconciliations`, máquina
  de estados, permiso dedicado de reconciliación) diferidas, con checkpoint
  documental propio (`docs/continuidad-ar-fact-no-issued-01-2026-09-04.md`)
  — no empezar sin releer ese checkpoint primero.

---

## Higiene pendiente — estado

1. **Portar `O4-03` y `O4-11`** al archivo de `origin/main` · ✅ RESUELTO
   (05/09/2026). Los dos tests vivían solo en el archivo LOCAL untracked
   preservado el 03/09/2026 (`b47e5115-.../scratchpad/evidencia-o4-2026-09-03/`,
   ver `MANIFIESTO.md` de esa carpeta) — cubrían las dos únicas ramas de
   `dispatch()` sin equivalente de integración: un evento sin ningún
   handler registrado (`outbox.worker.ts:302-310`) y una versión sin
   handler yendo a dead-letter en el primer intento (A10.4,
   `UnsupportedEventVersionError`). Verificado que los dos mecanismos
   seguían intactos (nada cambió desde el 03/09) antes de portar. Adaptados
   a los helpers actuales de `outbox-worker.integration.test.ts`
   (`sembrar`/`fila`/`triggerPoll`, no los viejos `encolar`/`evento`/`correr`
   del archivo local) y agregados como `O4-03` y `O4-11` en la sección
   "OutboxWorker — poll/dispatch reales". `[V]` 21/21 tests del archivo
   pasan contra Postgres real (19 originales + los 2 nuevos); 1816
   unitarios, `tsc`, `lint`, `lint:arch` verdes. Sin cambios a
   `outbox.worker.ts` ni a ningún código de producción — solo el archivo
   de test.
2. **6 artefactos untracked, triage cerrado (05/09/2026) · ✅ RESUELTO.**
   Decisión del dueño, uno por uno:
   - `.claude/skills/neon/`, `.claude/skills/neon-postgres/`, `skills-lock.json`
     — **afuera del repo**, agregados a `.gitignore`. Dan acceso directo a la
     base (crear/borrar branches, correr SQL, migraciones — varias
     `destructiveHint: true`); quedan locales a cada máquina, no disponibles
     automáticamente para cualquiera que clone el repo.
   - `.reviews/` — **borrado**, y agregado a `.gitignore` para que no
     reaparezca solo. Eran reportes de preflight de un protocolo puntual de
     una sesión pasada (31/08/2026), ya habían cumplido su función.
   - `docs/erp-auditoria-v2/` — **versionado**. Auditoría de completitud
     real y completa (21 fichas, 158 hallazgos, 431 anclas verificadas,
     corrida 02/09/2026) — mismo criterio que otras auditorías ya
     commiteadas del repo (`auditoria-tecnica-infra-reservas.md`,
     `auditoria-modularidad.md`).
   - `docs/programa-auditoria-completitud-erp-2026-09-01.md` (v1.0,
     borrador, reemplazado por `erp-auditoria-v2/00-programa-v2.md`) —
     **versionado igual, como historial** — mismo criterio de "no borrar el
     rastro de decisiones/versiones anteriores" que el resto del repo.

---

## 🔎 Cuarta vuelta — revalidación completa de la lista abierta (05/09/2026)

**Encargo:** revalidar contra el árbol real **todos** los ítems abiertos de este
archivo (no solo la familia ORDER), y buscar en paralelo precedente de diseño en
dos ERP maduros. Dos agentes en paralelo, ninguno implementó ni commiteó:

- `erp-audit-orchestrator` — ~45 ítems revalidados con ancla verificada en el día.
- `auditor-circuitos-erp` — 7 fichas contra el código real de ERPNext
  (`erpnext-develop`) y Odoo 19.0, con anclas `archivo:línea` de esos árboles.

**Por qué se corrió:** la lista arrastrada ya había fallado en las dos
direcciones el 05/09 (ORDER-05/06/07/09/03-b estaban resueltos y se
arrastraban como abiertos). Esta vuelta asume que cualquier fila puede estar
stale hasta verificarla.

### A. Estado git real (verificado, no citado)

`app-main`: `main` = `2f9f23f`, working tree limpio, **6 commits sin pushear**
(`origin/main` = `5a3a588`, confirmado con `git ls-remote`, no con el ref
cacheado). `appfrontend-main`: `main` = `613c206`, sincronizado.

Dos afirmaciones de estado git que había que corregir:

| Afirmación | Realidad |
|---|---|
| ORDER-10 B1 (`22f0559`) "NO pusheado todavía" | **Ya está en `origin/main`.** Corregido in-place arriba |
| `continuidad-ar-fact-no-issued-01-2026-09-04.md:9-11` y `:300-302`: "`HEAD = b088cbc`, 14 commits por delante de `origin/main = 1f72f41`, sin push" | **Stale.** Los 3 commits de Fase 1 (`4029b96`, `4d2d694`, `b088cbc`) **están pusheados**; `b088cbc` es ancestro de `origin/main`. La instrucción "No pushear" de su §4 quedó sin objeto y engaña a quien lo abra como checkpoint vivo. **Pendiente: corregir ese doc** |

### B. Cambios de veredicto sobre filas existentes

- **AUDIT-DOC-001 — ✅ RESUELTO** (`e1476f5`). Marcado in-place arriba.
- **"RBAC — mecanismos 1 y 2" — ETIQUETA RETIRADA.** Origen en
  `pendientes-2026-08-25.md:1379-1380`, nunca definida. Retirada in-place.
- **FACT-INV-BIZID-001 — baja de severidad.** `[V]` El único origen del campo
  es `invoices.routes.ts:82` y `:107`, ambos `req.user!.businessId!`: el
  cliente **no puede inyectar** un `businessId` arbitrario. La hipótesis de
  exposición cross-tenant queda **refutada por el wiring**, no solo sin
  confirmar. Sigue abierto como invariante sin verificar (defensa en
  profundidad), no como riesgo vivo.
- **RBAC-OWN-001 — la fila estaba subdescrita.** Decía "sin guard central ni
  test negativo" y omitía que **los guards de pertenencia por ruta sí existen**
  (`customer.routes.ts:703`, `:763`, más `requireCustomerId()` en `:305-315`).
  Lo que falta es (a) el guard central y (b) la prueba negativa.
- **RBAC-SYNC-001 — parcial.** La mitad §2 se cerró (204 call-sites / 37
  archivos coinciden entre `rbac-matriz-endpoints.md:53` y
  `rbac-matrix-sync.test.ts:44,49`). La §4 ↔ `PUBLIC_ROUTES` sigue "a ojo",
  como el propio doc declara. Las dos cercas corren verdes (4 tests, 467 ms).
- **RBAC-MOUNT-001 y FAILOPEN-001 — confirmados como cercas faltantes, no
  agujeros.** El primero: `app.ts:317` monta `authenticate()` antes de los
  routers protegidos, verificado en producción el 31/08, pero **nada lo
  mantiene así** (`src/tests/architecture/` tiene un solo archivo y fenza otra
  cosa). El segundo: el fail-open de `provider.tsx:84` es **de navegación**;
  `managementOnly` depende de `isManagement` por separado y el backend igual
  exige `authorize()`. **Sugerencia: bajar FAILOPEN-001 de prioridad** — está
  en el mismo bloque por patología, no por tamaño.
- **Gap C1-C — la mitad se cerró y nadie lo registró.**
  `getOutstandingByCustomerId` ya es `LEFT JOIN` desde O2-F2 (`5856306`,
  03/09). `getByReservationId` **sigue con `INNER JOIN`** — ver hallazgo #1.
- **C1-Fase B — REPUESTA en la lista.** Estaba en `pendientes-2026-09-01.md:207`
  y `-09-02.md:346` ("bloqueada hasta que el negocio elija proveedor"); ausente
  en `-09-03.md` y en este archivo, **sin que nadie la cerrara**. Tercer caso
  del mismo modo de falla.
- **13 anclas stale corregidas.** ORDER-15 (`sql.financial-transaction.repository.ts:682-685`
  y `:734` / `:525`, no `financial-transaction.repository.ts:306-311`),
  ORDER-13 #3 (`:635`, no `:505`), O1-b (por **tercera** vez:
  `sql.order.repository.ts:484,513,545` + `sql.customer.repository.ts:394`),
  Gap C1-C (`:198` LEFT / `:260` INNER), FACT-INV-BIZID-001 (las 5),
  RBAC-MOUNT-001 (`app.ts:317`, se movió 50 líneas), FISCAL-CBTE-001,
  FACT-CONSOL R1 (`invoice.service.ts:540`, corrido 1 línea), ORDER-12.
  **La causa no es el paso del tiempo:** `caf24e1`, `179b4ad`, `1f3af80` y
  `22f0559` tocaron los 4 archivos que concentran casi todas las anclas. El
  único ancla intacta de todo el informe (`FacturarButton.tsx:74`, SEM-002) es
  del repo que nadie tocó.

### C. Hallazgos nuevos — no estaban en ninguna lista

#### 1. `confirmRefund()` es ciego a las facturas consolidadas · 🔴 el más grave

`[V]` en código, `[H]` en alcanzabilidad end-to-end. La cadena:

1. `transferStayBalanceToReceivable()` (`accounts-receivable.service.ts:168-175`)
   crea el `CHARGE` con `reservationId`.
2. Se factura por `requestConsolidatedInvoice()`, que inserta la factura con
   **`financial_transaction_id = NULL`** (`invoice.service.ts:558`) y la vincula
   por `invoice_charges`.
3. `confirmRefund()` busca qué revertir con `getByReservationId()`
   (`cancellation-refund.service.ts:189`).
4. Esa query hace **`INNER JOIN financial_transactions ft ON ft.id = i.financial_transaction_id`**
   (`sql.invoice.repository.ts:257-263`) → la factura consolidada **no aparece**.
5. Con `issuedInvoices` vacío, todo el reembolso cae a `:sin-asignar` con
   `reversedInvoiceId: null` (`:263-265`): **asiento en el ledger sin Nota de
   Crédito, contra una Factura B con CAE real de AFIP.**

**Es exactamente el Escenario A que el residual #2 de BRECHA-REFUND-01 dio por
cerrado.** El fix releyó `issuedInvoices` dentro de la transacción **sin tocar
la query**: cerró la carrera, no la ceguera. El repo ya tiene la primitiva
correcta (`resolveInvoiceLinkage()`, `sql.invoice.repository.ts:217-243`);
`confirmRefund()` no la usa.

**No verificado:** qué devuelve `getCollectedPaymentTotalForReservation()` en
ese escenario (el pago del huésped va contra `stayId`, el cargo de la empresa
contra `reservationId`). Si diera 0, el síntoma sería `NothingToRefundError` en
vez de NC faltante — sigue mal, con otra cara. **Requiere prueba dedicada
contra Postgres real, no más lectura de código.**

Por qué nadie lo vio: Gap C1-C vive en "Backlog de producto" desde el 27/08 con
la redacción "2 queries con JOIN" que el propio repo ya identificó como
subdimensionada (regla 3 del `CLAUDE.md`), y se reescribió el 01/09 **sin
reconectarlo con el circuito de refund**.

#### 2. Las anclas se mueven más rápido de lo que se revalidan

Ver B. La regla 2 del `CLAUDE.md` ("al arrastrar se re-chequea el ancla") está
bien escrita pero **mide lo que no se mueve**.

#### 3. Cinco endpoints de reportes con cero consumidores

`reports.routes.ts:141-220` expone `/pos/sales-by-product`, `/pos/waste`,
`/pos/ticket-summary`, `/crm/new-vs-recurring`, `/crm/applied-rates`. `grep` en
todo `appfrontend-main/src` → **ninguna llamada** desde el 22/08. Está
registrado como D7 pero **descripto como deuda de UI**, no como "5 superficies
de API sin consumidor" — que es lo que hace que se puedan romper sin que nadie
se entere. Sumado a O1-b: cuando se construya la pantalla, devolverá cero para
todo el histórico previo a `d7bb254`.

#### 4. `C1-Fase B` desapareció de la lista sin decisión

Ver B. Tercer caso del mismo modo de falla (ORDER-15 el 03/09→05/09; las filas
❌ del roadmap el 25/08).

#### 5. `AUDIT-DOC-001` se contradecía dentro de este mismo archivo

Documentado cerrado en la sección de higiene y listado abierto 50 líneas antes.
**No hace falta un archivo viejo para arrastrar algo stale.**

#### 6. `getInvoicedFinancialTransactionIds()` — hueco de doble comprobante metido en una fila de infraestructura

`sql.invoice.repository.ts:245-255` filtra `i.status = 'ISSUED'`. El checkpoint
de AR-FACT lo llama *"el hallazgo más grave de toda esta investigación, todavía
sin cerrar"* (`continuidad-ar-fact-no-issued-01-2026-09-04.md:130-139`), pero
acá está subsumido en "AR-FACT-NO-ISSUED-01 Fases 2-8, diferidas" — la misma
bolsa que la tabla, la máquina de estados y los permisos. **Es un hueco de
doble comprobante fiscal (S1) leyéndose como trabajo de infra.** Regla 3, otra
vez. Merece fila propia.

#### 7. `reservation.expired` no tiene consumidor, pero sí tiene costo

EVT-ORF-01 está como línea suelta. Lo que no dice: el evento **se persiste en
`domain_events`, el `OutboxWorker` lo poll-ea cada 5s por tenant, no encuentra
handler y lo descarta** (`outbox.worker.ts:302-310`). Con A7.6 abierto (sin
purga), es una tabla que crece con filas que nunca van a producir efecto. Los
dos ítems estaban en la lista; **la intersección no**.

### D. Precedente de diseño — ERPNext y Odoo 19

Anclas verificadas en los checkouts locales de ERPNext y Odoo 19.0.
**Límite declarado:** ningún módulo AFIP con lógica real de webservice está en
disco, así que la semántica específica de CAE no tiene precedente verificable —
el diseño de `invoice.service.ts:12-17` es propio, ni confirmado ni contradicho.

**Dónde `app-main` ya está adelante de los dos** (no gastar esfuerzo ahí):

- **Locking de reembolso.** Es el único de los tres con lock pesimista explícito
  sobre el recurso disputado, con la trampa de la foto stale medida
  empíricamente y con orden canónico fenceado por test. Odoo no tiene **un solo
  `FOR UPDATE` en todo `addons/account`**: su protección contra dos reembolsos
  simultáneos es efecto colateral del row lock implícito del UPDATE.
- **Modelo de estado del comprobante.** `InvoiceStatus` de 4 valores +
  `afipContacted` distingue cuatro situaciones que Odoo colapsa en dos
  (`sending_data` Json sí/no, `account_move.py:722`). Odoo **abandona borrando
  el marcador** (`account_move_send.py:850-855`): no puede responder "qué se
  abandonó". Para AFIP eso sería un bug. ERPNext core directamente no modela
  "existe en base pero el fisco no lo aceptó" (negativo confirmado).

**Lo accionable, por ítem abierto:**

| Ítem | Precedente | Qué implica |
|---|---|---|
| **BRECHA-REFUND-01-B** | ERPNext `payment_entry.py:421` `validate_allocated_amount_with_latest_data()`, aborta en `:470-476` si el saldo fresco difiere del asumido | **Deja de exigir un lock nuevo.** Releer `getCollectedPaymentTotalForReservation()` antes del COMMIT y tirar si cambió respecto de `cancellation-refund.service.ts:245`. Convierte un sub-reembolso silencioso y permanente en error visible y reintentable. Un `SELECT`, cero schema. **No arregla el hallazgo #1 — son dos defectos distintos en la misma función** |
| **ORDER-10 B2** | Odoo `_need_cancel_request()` (`account_move.py:1892`) apaga `button_draft` (`:6278`) y enciende `button_request_cancel` (`:6384`) | La decisión de qué botón se ofrece debe ser **predicado calculado en backend y expuesto al frontend**, no inferido por el cliente. `resolveInvoiceLinkage()` ya devuelve `{status, afipContacted}` |
| **ORDER-10 residual #3** (falso positivo de `CARGO_CON_COMPROBANTE_VIVO`, declarado bloqueante de B2) | Odoo no discrimina por estado del cargo sino por **existencia de la reversa** (`reversed_entry_id`) | El `NOT EXISTS` de `voidByOrderId` (`sql.financial-transaction.repository.ts:740-752`) debe dejar pasar la anulación cuando exista un `ADJUSTMENT` con `reversed_invoice_id` hacia esa misma factura. **Mismo predicado, sin excepción ad-hoc ni columna nueva** |
| **ORDER-10 B3** | Odoo: el dominio del cron es también el filtro de la pantalla (`account_move.py:6506-6509`) | B3 = agregar `?status=` a `GET /api/invoices` (hoy exige `financialTransactionId` o `customerId`, 400 sin uno: `invoices.routes.ts:181`). El predicado ya está escrito **3 veces** en el repo. **Dos bandejas, no una**: `FAILED_UNCERTAIN && afipContacted` = intervención humana; el resto = reintento (el discriminante ya está en `retryExisting()`, `:803-804`). Cero schema |
| **ORDER-10 B4** | Odoo: 5 fechas de corte en `res.company` (`company.py:76-102`), cero filas de período; `hard_lock_date` irreversible separado de los negociables; excepción como registro auditable (`account.lock_exception`) y no como rol | **La forma es N fechas en `business_profile`, no tabla de períodos.** Y **B4 depende de B2, no al revés**: cerrar el período bloquea también la reversa (`general_ledger.py:642`, `_can_be_unlinked`), así que si B2 sale primero sin considerarlo, la NC podrá emitirse con fecha dentro de un período que después se cierre |
| **ORDER-13 punto 3** | Odoo separa por forma del hueco: previene donde la contrapartida está en el mismo registro (contabilidad), **concilia donde el hecho llega asíncrono** (POS: `pos_order.py:34` `_get_valid_session()`, sesión de rescate como entidad con contador visible en `pos_config.py:133`) | `app-main` está en el caso POS (el `CHARGE` llega por outbox). **Descarta la opción (a)** de la sección de ORDER-13; apunta a (b) o (c). Y la conciliación necesita **artefacto visible, no un log** |
| **O5** | ERPNext `Repost Item Valuation`: el incidente vive **como campos del registro que falló** (`status` + `error_log`), no en bitácora aparte | **No hace falta tabla de incidentes.** `domain_events` ya tiene `retry_count`, `failed_at`, `last_error` e índice. Falta (a) clasificar el error y (b) notificar a un rol. **O5 es más chico de lo que parece** |
| **ORDER-13 punto 1** (retry manual resetea `retry_count`) | ERPNext `repost_item_valuation.py:577-580`: clasifica **por tipo de excepción**, no por substring del traceback — con el comentario que documenta que la versión anterior se perdía los deadlocks de Postgres (`"deadlock detected"` vs `"Deadlock found"` de MariaDB) | Un error recuperable no gasta intentos; uno no recuperable no reintenta 12 veces. `app-main` ya tiene vocabulario (`EfectoRechazo`, `financial-transaction.repository.ts:137`). **La advertencia sobre el substring aplica literal** |
| **Ficha 7 — decisión a dejar escrita** | Odoo expone `FOR UPDATE` vs `FOR NO KEY UPDATE` como parámetro (`allow_referencing`, `odoo/orm/models.py:5589-5592`) | `getRefundableForUpdate` (`sql.invoice.repository.ts:154`) usa `FOR UPDATE` **precisamente para** bloquear los INSERT hijos que necesitan `FOR KEY SHARE`. Es el caso donde la recomendación de Odoo **no** aplica y alguien podría "optimizarlo" y romper la protección. **Merece comentario, no cambio** |

**Corrección al ADR:** `diseno-cancelacion-orden-nota-credito-2026-09-05.md:80`
declara `voidByReservationId()` "fuera de este bloque… ítem propio". El código
ya lo tiene resuelto (`sql.financial-transaction.repository.ts:374-386`,
RESERVA-10). **Esa línea del ADR está stale.**

### E. Bloques de trabajo propuestos

Reagrupación por *mismo problema*, no por etiqueta. **Propuesta, no decidida.**

1. **"Verificado a mano una vez, sin gate automático"** — F2 (raíz) + ORDER-10
   residual #1 + los 3 falsos negativos de `lock-order.test.ts` + RBAC-MOUNT-001
   + RBAC-SYNC-001 (§4) + FACT-CONSOL R2 y R4 + ORDER-10 residual #4 +
   CONTRACT-001. **F2 va primero**: mientras la suite de integración no corra en
   CI, cualquier cerca nueva escrita como test de integración nace con el mismo
   defecto. FAILOPEN-001 pertenece por patología pero **no por tamaño**.
2. **"La puerta se cerró sin abrir la ventana"** — ORDER-10 B2 + RESERVA-10 H1.
   **No es backlog: es el saldo pendiente de commits ya desplegados.** B1 está
   en producción y deja una orden con factura viva **sin ningún camino de
   cancelación** (verificado enumerando las 10 rutas de `orders.routes.ts:137-304`
   y las 8 de `invoices.routes.ts:74-224`: ninguna de NC).
3. **"`confirmRefund()`, plata y AFIP"** — hallazgo #1 (ceguera del INNER JOIN,
   usar `resolveInvoiceLinkage()`) + BRECHA-REFUND-01-B (chequeo optimista
   estilo ERPNext). Dos defectos distintos en la misma función, los dos sin
   schema, los dos con la primitiva ya en el repo. **Antes de tocar código:
   la prueba contra Postgres real que el hallazgo #1 pide.**
4. **"El `INNER JOIN` de las consolidadas"** — Gap C1-C (mitad viva) +
   AR-FACT-NO-ISSUED-01 Fase 2 (hallazgo #6) + FACT-CONSOL R3. Mismo defecto de
   modelo: *hay dos formas de vincular factura y cargo, y parte del código
   conoce una sola*. El trabajo es censar quién no usa `resolveInvoiceLinkage()`.
5. **"El efectivo del POS no existe para la caja"** — ORDER-12 + CAJA-ORD-01 +
   AUDIT-ORD-01. Siguiente circuito por dependencia de negocio.
6. **"Reportes que mienten por silencio"** — O1-b + D7 + C3.
7. **Higiene de la lista** — hecho en esta vuelta: AUDIT-DOC-001 cerrado, "RBAC
   mecanismos 1 y 2" retirada, C1-Fase B repuesta, 13 anclas corregidas.
   **Queda:** "etapas 2-3 de downgrade" (sin referente, candidata a la misma
   cirugía), DOC-ANCLA-001, DA-CONT-001, y corregir el estado git del checkpoint
   de AR-FACT.

### F. Pendiente de decisión del dueño

- ORDER-13: las 3 opciones ya registradas **más una cuarta pregunta que ninguna
  cubre** — si la conciliación solo *reporta* o además *repara* (crea el `CHARGE`
  faltante). Odoo repara, ERPNext repara vía cola manual.
- B4: posponer vs. rechazar. Odoo pospone compras y rechaza ventas
  (`_compute_date`, `:869`). Para AFIP el lado ventas está forzado (numeración
  correlativa, fecha en el CAE); el de cargos internos podría ir a cualquiera.
- B4: si la excepción al cierre es registro auditable con vencimiento y usuario
  (Odoo) o rol exento permanente (ERPNext). El primero **sí justifica una tabla
  chica nueva** — es configuración, no duplica `invoices`/`financial_transactions`.
- `inalterable_hash` (encadenamiento criptográfico de asientos, Odoo `:6378`):
  requisito de ciertos fiscos europeos. **Verificar si AFIP lo exige** antes de
  considerarlo — no asumido.
- Los 6 commits sin pushear.

### G. Fuera de alcance de esta vuelta

- **Datos demo en la base real** — INDETERMINADO, requiere query read-only
  contra `Hotel los Alamos` y `Demo`. No corrida.
- **INV-ORF-01** — el mecanismo está confirmado (`inventory.handlers.ts:57`,
  `:144`), pero **el volumen de filas huérfanas existentes requiere query** a
  las dos tenant DB. `[H]`.
- Ninguno de los dos agentes implementó, commiteó ni tocó código. Las únicas
  corridas fueron de lectura y 3 archivos de cerca (`vitest run`, 4 tests
  verdes, 467 ms).

---

## 🔎 Continuación — `confirmRefund()` vs. facturas consolidadas: decisión del dueño, arbitraje del tope, N0-N3 completos (05/09/2026)

Continuación directa del hallazgo #1 de la cuarta vuelta (más arriba). Todo
lo de acá abajo pasó por `architecture-governor` en dos rondas antes de
escribir una línea de test; nada de código de producción se tocó todavía.

### Decisión del dueño (Q1, verbatim)

Sobre si corresponde emitir una NC contra una factura que también cubre
otras reservas:

> "Sí a la NC parcial, es un hecho fiscal, no una decisión — lo que decido
> es que su emisión pasa por el mismo mecanismo administrativo ya
> establecido para ORDER-10/RESERVA-10, no automático."

O sea: **fail-closed automático + escape administrativo (`Roles.MANAGEMENT`)
que sí emite la NC parcial** — misma forma que ORDER-10 B1/B2, no un simple
bloqueo permanente. El dinero vuelve a la **empresa**, que es quien pagó (no
al huésped, que es lo que el código hace hoy por accidente — ver W2).

**Tarea de seguimiento que el dueño define, y que NO es "implementar A o
B":** conseguir la respuesta del contador sobre si la Factura B a la
empresa ampara la **consolidada como paquete** o la **reserva individual**.
Bloqueante para N4, no para N0-N3. `architecture-governor` afinó la
pregunta real a hacerle: la Factura B no ampara "la reserva" sino **el
saldo neto de la estadía transferido en un momento dado**
(`getNetBalanceByStayId()`, incluye consumo POS y descuenta pagos previos
del huésped) — no es necesariamente el mismo número que el precio de la
reserva.

### El tope: el dueño encontró un defecto más profundo que el `ic.amount` crudo

Análisis del dueño (verbatim, resumido): un tope calculado con el
"reembolsado GLOBAL" de la factura contamina el cálculo de una reserva con
reembolsos que le corresponden a OTRA reserva del mismo lote —
`architecture-governor` lo verificó y lo encontró **peor de lo reportado**:
`getRefundableForUpdate()` (`sql.invoice.repository.ts:150-175`) tiene las
DOS ramas del `LEAST` contaminadas a nivel de cabecera, no solo la resta
(`reembolsado`) sino también el minuendo (`SUM(p.amount) settled_invoice_id
= i.id` es lo pagado de TODA la factura).

**Confirmado sin cambio de esquema.** El REFUND que crea `confirmRefund()`
ya lleva `reservationId` Y `reversedInvoiceId` a la vez
(`cancellation-refund.service.ts:270-280`) — "reembolsado de esta reserva
contra esta factura" es derivable HOY como
`SUM(amount) WHERE reversed_invoice_id = I AND reservation_id = R`, sin
tabla nueva ni columna nueva. El dueño ya había rechazado una tabla nueva en
ORDER-10 por duplicar campos existentes; acá aplica el mismo criterio.

**Arbitraje del matiz `ic.amount` crudo vs. proporcional:** el dueño tenía
razón en el principio (capar por reserva en los dos lados), pero
`architecture-governor` corrigió el término exacto — `invoice_charges.amount`
crudo **sub-capa** cuando `pricesIncludeIva = false` (`splitAmount`,
`invoice.service.ts:207-220`, hace `impTotal = amount + impIva`). El
segundo término tiene que ser la porción PROPORCIONAL de `imp_total`
(`imp_total * share_R / SUM(todos los ic.amount)`), misma aritmética que
`buildCreditNote()` ya usa (`invoice.service.ts:702`). No es un desacuerdo
de fondo, es la fórmula exacta.

**Cuatro huecos encontrados por `architecture-governor` al verificar, para
tener en cuenta antes de N4:**
- **H-a (activo).** El chunk `:sin-asignar` histórico ya tiene
  `reservationId` pero `reversedInvoiceId: null` — un tope filtrado por
  `reversed_invoice_id = I` no ve esa población. Pregunta de backfill, no
  de fórmula. **Dimensionado en N3, ver abajo.**
- **H-b (dormido).** `financial_transactions.reservation_id` es
  `ON DELETE SET NULL`. `SqlReservationRepository.delete()` existe pero
  sin ningún caller de producción — dormido, no cerrado.
- **H-c (real, a favor del argumento del dueño).** Una misma reserva SÍ
  puede aparecer en dos consolidadas distintas (`idx_stays_reservation_active`
  solo impide dos estadías `CHECKED_IN` simultáneas). Es la razón de fondo
  por la que el tope tiene que ser por PAR `(factura, reserva)`.
- **H-d.** `resolveInvoiceLinkage()` no sirve tal cual para el pool LIFO de
  N facturas (toma un `financialTransactionId`, devuelve `LIMIT 1`). Hace
  falta un método nuevo por `reservationId`.

### Plan de bloques, todos chicos y reversibles, uno por commit

| # | Bloque | Estado |
|---|---|---|
| **N0** | Tests de caracterización W1/W2/W3 (hallazgo #1: cae a `:sin-asignar`, sin NC) | ✅ commits `def9b51` (test) sobre `fd0d810` |
| **N1** | Caracterización del camino AR PURO real (`transferStayBalanceToReceivable` → `requestConsolidatedInvoice` → `markCollected()` de verdad) → `NothingToRefundError`, no `:sin-asignar` — segundo síntoma del mismo agujero | ✅ commit `fe53acd` |
| **N2** | Caracterización de `getRefundableForUpdate()` con 3 cargos y 2 reembolsos previos — el caso de contaminación que pidió el dueño, a nivel de repositorio (no end-to-end: la query hoy ni siquiera ve la consolidada) | ✅ commit `5fcc10e` |
| **N3** | Consulta read-only en las dos tenant DB reales para dimensionar el backfill de H-a | ✅ ver resultado abajo — sin commit de código, solo este registro |
| **N4** | ADR del fix completo (fail-closed + escape MANAGEMENT + fórmula proporcional por par) | 🔴 bloqueado — esperando al contador |

### N3 — resultado de la consulta (05/09/2026, solo lectura, `mcp__plugin_neon_neon__run_sql`)

Mapeo de tenants verificado contra la BD de plataforma (`businesses`):
`Demo` (`biz-demo-01`) = proyecto `ancient-king-17098519`, branch
`production`; `Hotel los Alamos` (`cd6cd508-...`) = mismo proyecto, branch
`tenant-hotel-los-alamos`.

Query (`REFUND` con `reservation_id` seteado, `reversed_invoice_id IS NULL`,
`status='SETTLED'`, cuya reserva tenga un cargo en una consolidada
`ISSUED`): **0 filas en las dos.**

**Pero el cero no es "sin riesgo" — es "sin datos".** Verificado con un
segundo query de contexto: ninguna de las dos tenant DB tiene una sola fila
en `accounts_receivable`, `invoice_charges`, ni una factura consolidada
(`financial_transaction_id IS NULL`). El circuito de facturación por
empresa **nunca se ejecutó** en ninguna de las dos:

| | Demo | Hotel los Alamos |
|---|---|---|
| Reservas | 41 | 0 |
| Facturas (`ISSUED`) | 11 | 0 |
| Clientes `kind='COMPANY'` | **0** | 0 |
| `accounts_receivable` | 0 | 0 |

`Demo` tiene actividad real (41 reservas, 11 facturas emitidas) pero **cero
clientes tipo empresa** — y `transferStayBalanceToReceivable()` exige
`company.kind === 'COMPANY'` (`accounts-receivable.service.ts:121`): es
estructuralmente imposible que el bug haya ocurrido ahí, no porque nadie lo
haya disparado por buena suerte. `Hotel los Alamos` es una cáscara vacía.

**Conclusión de N3: no hace falta backfill de H-a hoy, en ninguna de las dos
bases de práctica** — pero por ausencia total de uso del circuito, no
porque el circuito sea seguro. La pregunta de backfill vuelve a ser
relevante en cuanto exista el primer cliente `COMPANY` real con una
consolidada emitida.



---

## 🔎 N4 — directiva del dueño sobre facturación configurable, reconciliación con FACT-BORRADOR-001, y N4-a cerrado (05/09/2026)

Continuación directa de la sección anterior ("Continuación — `confirmRefund()` vs.
facturas consolidadas"). Dos rondas más de `architecture-governor`, más una
directiva nueva del dueño sobre el módulo de facturación en general.

### La directiva del dueño (verbatim)

> "El módulo de facturación debe permitir al emisor crear y emitir líneas
> configurables, incluyendo conceptos no originados en otros módulos, sin
> imponer una lista cerrada de operaciones. Debe conservar la propuesta del
> ERP, la versión final emitida y toda modificación manual relevante. Las
> Notas de Crédito deben operar sobre el comprobante efectivamente emitido,
> con límites de monto, trazabilidad y control de duplicados."

**Reconciliada contra `docs/diseno-factura-borrador-2026-08-31.md`
(FACT-BORRADOR-001, v2.8, leído completo por `architecture-governor` —
2049/2049 líneas). Veredicto por cláusula:**

1. **"Líneas configurables, sin lista cerrada"** — ya diseñado en §24
   (`source_kind` con rama `MANUAL` declarada). Matiz aclarado con el dueño:
   lo abierto es el **concepto** (texto libre), no el **origen** (cerrado a
   4 tipos a propósito) — confirmado, ver decisión abajo.
2. **"Conservar la propuesta del ERP + versión final + modificación manual"**
   — parcialmente cubierto; escondía una decisión de negocio real (¿snapshot
   inmutable o reconstrucción por `audit_log`?) — resuelta, ver abajo.
3. **"NC contra el comprobante efectivamente emitido, límites, trazabilidad,
   duplicados"** — **ya construido**, verificado contra el código vivo:
   `invoice.service.ts:685-700` exige `reversedInvoiceId` + `status='ISSUED'`
   + `cbteNro` no nulo + `cbteTipo === FACTURA_B` (guard `F-A`, agregado el
   mismo 05/09); `getRefundableForUpdate()` topea monto; `reversed_invoice_id`
   trazabilidad; `idempotencyKey = 'invoice:' + financialTransactionId`
   control de duplicados. **No va a FACT-BORRADOR-001** — su lugar correcto
   es `diseno-cancelacion-notas-credito-c2-2026-08-23.md` + este bloque N.

**Estado real de FACT-BORRADOR-001, verificado (no asumido):** un solo
commit en su historia (`ef3ba6a`, 31/08 23:55, v2.8), sin cambios desde
entonces. Sigue *"diseño, no implementado, NO aprobado como diseño final"*,
con 4 correcciones pendientes sobre sí mismo (§26.1) y 5 decisiones del
dueño sin cerrar (§26.3) — de esas 5, esta sesión cerró 2 (ver abajo).

**Hallazgo documental nuevo — `C-5` (no registrado en §26.1 del propio
diseño):** entre §8 y §24 del documento, la rama de origen `RECEIVABLE`
(la que corresponde a facturas consolidadas) **desapareció sin que ninguna
sección lo dijera**. §13 sigue citándola como si existiera. Es territorio
directo de N4 — cuando se retome FACT-BORRADOR-001, hay que decidir dónde
queda el origen de una línea consolidada.

**Hallazgo documental nuevo — ficha stale:** `docs/erp-auditoria-v2/fichas/M10-facturacion.md:133`
dice *"6 decisiones del dueño abiertas"*; en realidad las 6 (D1-D6) están
**cerradas** en §4 del diseño. Mismo patrón de arrastre que este archivo
viene corrigiendo en otros lados.

**¿Reemplaza o depende de N4?** Ninguna de las dos — son **ortogonales**.
FACT-BORRADOR-001 gobierna la emisión (armar líneas, pedir CAE); N4 gobierna
la reversión (cuánto se puede acreditar). El propio diseño lo declara en
§22: *"El borrador cubre el antes; no compiten."* Confirmado que N4-a no
necesita nada del diseño grande — `invoice_items.subtotal`/`iva_rate`/
`reservation_id`, ya congelados hoy, alcanzan.

### Las cuatro preguntas del dueño, respondidas

| Pregunta | Respuesta del dueño | Efecto |
|---|---|---|
| ¿Cómo se conserva la propuesta ORIGINAL del ERP? | **Snapshot inmutable al crear** (no reconstrucción por `audit_log`) | Va a FACT-BORRADOR-001 cuando se retome — requiere una fila/tabla adicional por borrador, sigue en HOLD |
| "Sin lista cerrada": ¿aplica también a los orígenes? | **Solo al concepto/descripción** | §24 queda confirmado tal cual, sin reabrir los 4 tipos de origen |
| Residuo de redondeo al repartir IVA de un grupo entre reservas | **Lo absorbe la reserva de mayor monto** | Implementado en `resolveRefundableForPair()`, commit `eda4a2f`, con test de empate exacto |
| ¿`notes` + `confirmed_by` alcanzan como evidencia reconstruible? | **No — hace falta algo estructurado** | Pasa a requisito de N4-b (columna/campo nuevo, schema, sigue en HOLD hasta esa etapa) |

### Corrección de fórmula (el dueño encontró algo que `architecture-governor` había arbitrado mal)

La fórmula propuesta en la ronda anterior (`imp_total * share_R / SUM(ic.amount)`)
prorrateaba la **cabecera** de la factura completa. El dueño la corrigió:
la base de una NC parcial es *"la composición fiscal ORIGINAL de la
operación revertida, no un prorrateo ciego del total"*.

Verificado contra el código real que esa composición **ya está congelada**,
por grupo de tasa, en `invoices.afip_request.Iva[]` (`BaseImp`/`Importe`
tal como salieron al emitir) — `buildCreditNote()` ya la usa
(`invoice.service.ts:702-708`) y nunca re-deriva desde
`business_profile.pricesIncludeIva` actual. La corrección de la fórmula usa
la misma ancla, con el reparto proporcional **por reserva dentro de cada
grupo de tasa** (no una sola cabecera) — respeta comprobantes con tasas
mixtas y **no requiere congelar `pricesIncludeIva` por ítem**, como se había
llegado a plantear como posible necesidad y se descartó por innecesaria.

### N4-a — ✅ RESUELTO (05/09/2026, commit `eda4a2f`)

`resolveRefundableForPair(invoiceId, reservationId)`, función pura, cero
schema, cero caller de producción, sin tocar `getRefundableForUpdate()`,
`confirmRefund()` ni `buildCreditNote()`. `[V]` 9 tests nuevos + 1864/1864
unitarios totales verdes, `tsc`/`lint`/`lint:arch` limpios.

Cubre: equivalencia con el fixture de N2 (3 reservas $500/$300/$200, refunds
previos $400/$100 — el tope global contaminado daba $500 para cualquier
reserva del lote, esta función da $200 para C, su propio remanente);
tasa única; tasas mixtas; redondeo con empate exacto (reserva de mayor
monto, orden estable de `Map` documentado); anomalía visible sin
`GREATEST(...,0)` (mismo criterio que `getRefundableForUpdate()`); y tres
motivos de `BLOCKED` fail-closed: `NO_ITEMS` (facturas Nivel A — confirmado
9 de 11 en la tenant `Demo` sin `invoice_items`), `RESERVATION_NOT_IN_INVOICE`,
`MISSING_FROZEN_IVA_ENTRY`.

**Lo que sigue sin resolver — N4-b, todavía en HOLD:**
- Cablear la función a `getByReservationId()`/`confirmRefund()` (hoy siguen
  intactos, el hallazgo #1 sigue reproducido).
- Campo estructurado de evidencia de NC (decisión del dueño de hoy: hace
  falta, `notes` no alcanza) — schema nuevo.
- Las dos fechas del plazo de 15 días (`reservations.cancelled_at` +
  "conocimiento formal del emisor", ninguna de las dos existe hoy) — schema
  nuevo.
- La única pregunta que sigue siendo genuinamente fiscal, no de diseño
  interno: qué nivel de desagregación acepta el contador (Q1 refinada de la
  sección anterior) — bloqueante para decidir la forma final del cableado.

