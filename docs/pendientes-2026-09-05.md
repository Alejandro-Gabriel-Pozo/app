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

**No re-verificado en esta pasada:** ORDER-13 (tiene tratamiento explícito
vía `DEPENDENCIA_PENDIENTE`/`ChargeNeverCreatedError`, pero su propio
comentario delega la resolución operativa durable a O5 — no declarar
cerrado sin decidir esa parte) y **ORDER-10** (cero referencias en `src/`
— es, de los cuatro originalmente listados junto a ORDER-13, el único sin
ninguna señal de estar resuelto).

### Hallazgo NUEVO, no registrado antes — `addItem`/`removeItem` validan el estado de la orden FUERA del lock (mismo linaje que ORDER-04)

Encontrado por `erp-audit-orchestrator` en la segunda vuelta. **No se
arregla en este bloque** — se registra, el fix es un cambio de dominio que
necesita su propia revisión.

**Consecuencia:** agregar o quitar un ítem mientras se confirma la misma
orden puede dejar el importe cobrado (`CHARGE`) distinto del importe final
de la orden (`total_amount`), y stock sin reservar para un ítem que sí
quedó en `order_items` — de forma permanente, porque
`uq_ft_un_charge_por_orden` (correctamente) impide recrear el cargo.

**Mecanismo:** `addItem()` (`order.service.ts:535-542`) y `removeItem()`
(`order.service.ts:544-549`) leen el estado de la orden con un `getById()`
NO transaccional y validan `status !== 'DRAFT'` ANTES de abrir cualquier
transacción. `sql.order.repository.ts` sí toma `FOR UPDATE` sobre la fila
de `orders` dentro de su propia transacción (`addItem()`, líneas 411-418),
pero nunca RE-LEE `status` bajo ese lock — y `removeItem()`
(`sql.order.repository.ts:508-524`) ni siquiera tiene lock, corre en
autocommit. Con un `POST /:id/items` y un `POST /:id/confirm` concurrentes:
T1 lee `DRAFT` y pasa la guarda; T2 toma el lock, reserva stock, emite
`order.confirmed` con el `totalAmount` viejo y commitea; T1 recién ahí
obtiene el lock, inserta el ítem y recalcula `total_amount` — la orden
queda `CONFIRMED` con un total que el `CHARGE` ya emitido no cubre.

**Anclas:** `order.service.ts:535-549` (guard fuera de transacción) +
`sql.order.repository.ts:411-418` (`addItem`, lock sin re-lectura) +
`sql.order.repository.ts:508-524` (`removeItem`, sin lock alguno).

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
- **ORDER-13** — tratamiento explícito (`DEPENDENCIA_PENDIENTE`/`ChargeNeverCreatedError`),
  pero la resolución operativa durable queda delegada a **O5** — no cerrar
  sin decidir esa parte.
- **ORDER-10** — sin ninguna referencia en `src/` (grep completo). Sin
  señal de estar resuelto — probablemente el único genuinamente abierto de
  lo que quedaba de la familia.
- **`addItem`/`removeItem` sin lock de estado** (hallazgo nuevo, ver arriba)
  — mismo linaje que ORDER-04, sin fix en este bloque.
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
