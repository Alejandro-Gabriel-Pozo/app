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

### BRECHA-REFUND-01-B — un `PAYMENT` sin factura, concurrente con `confirmRefund()`, todavía puede sub-reembolsar

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
**Commiteado en `main`, NO pusheado todavía** (`git push` es autorización
aparte del usuario).

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
   verde en CI". Pendiente: ventana adaptativa o marcarla para correr
   aislada.

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
3. **`requestConsolidatedInvoice()` no tiene NINGÚN guard TOCTOU** -- ni
   de orden cancelada ni de reserva cancelada. El hueco es unidireccional
   (la puerta de cancelación SÍ cubre facturas consolidadas, porque
   `resolveInvoiceLinkage()` unifica `invoice_charges`), pero existe: se
   puede consolidar-facturar el cargo de una orden o reserva que se
   acaba de cancelar, en una ventana que ningún lock cubre hoy.
   **Este hueco existe desde ORDER-10 (05/09/2026) y nunca se había
   registrado en ningún `pendientes-*.md` hasta ahora** -- exactamente
   el patrón "hallazgo fuera de toda categoría que alguien relee" que
   este mismo archivo advierte más arriba. Bloque propio, cubre órdenes
   y reservas juntas, con su propio diseño -- no se toca acá.

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
- **INV-ORF-01** — reservas de stock huérfanas: la causa de doble-reserva
  (ORDER-05) está cerrada, pero las filas históricas y la otra causa
  (compensación de dead-letter, `inventory.handlers.ts:70-80`) siguen
  abiertas.
- **EVT-ORF-01**, **CAJA-ORD-01**, **AUDIT-ORD-01**, **ORDER-12**.
- **O1-b** — los reportes no distinguen "no consta" de "cero".
- **Seguridad / aislamiento:** FACT-INV-BIZID-001, SEC-ROT-001, RBAC-OWN-001,
  RBAC-SYNC-001, RBAC-MOUNT-001, FAILOPEN-001.
- **Documentales:** AUDIT-DOC-001, DA-CONT-001, DOC-ANCLA-001, CONTRACT-001,
  "RBAC mecanismos 1 y 2" (sigue sin referente).
- **Backlog de producto:** Gap C1-C, FISCAL-CBTE-001, FACT-BORRADOR-001,
  C1-Fase A, **C2 (ya no bloqueada, ver arriba — sigue sin construir)**, C3,
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
