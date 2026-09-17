# Resuelto

Log corrido de ítems cerrados, movidos acá desde `pendientes-<fecha>.md`
(convención desde el 12/09/2026 — ver `CLAUDE.md` raíz, sección "Pendientes
técnicos"). No se recrea por sesión ni por fecha — se le sigue agregando.

**Qué significa "resuelto" acá:** el trabajo (código, diseño o decisión) está
listo y, cuando aplica, pasó su gate de `architecture-governor`. **No**
significa necesariamente "pusheado" ni "deployado en producción" — ese es un
hecho volátil que este documento a propósito no registra como texto fijo
(mismo criterio que `pendientes.md`): se responde en el momento con
`git log origin/main --oneline | grep <hash>` en el repo que corresponda. Si
un ítem tiene una parte del trabajo lista pero otra parte sin confirmar
contra un entorno real, esa parte NO está acá — vive en
`pendientes-<fecha>.md`, sección `## 🔍 Verificaciones pendientes`, hasta que
se confirma.

Orden: más reciente primero. Cada entrada cita su origen (qué `pendientes-*.md`
o documento de auditoría la trajo) para no perder la trazabilidad.

---

## 14/09/2026

- **`CITY-LEDGER-AR-REPORT-ROW-FRONTEND-MIRROR-001`.** Origen:
  `docs/pendientes-2026-09-12.md` (hallazgo del gate `architecture-governor`
  al revisar Bloque 3c-iii de City Ledger — la ruta
  `POST /accounts-receivable/:id/reverse`). `appfrontend-main/src/lib/
  finanzas/types.ts` tenía su propio espejo de
  `AccountsReceivableReportRow` (`totalAmount`/`pendingAmount`/
  `invoicedAmount`/`collectedAmount`) sin el bucket `revertedAmount` que
  `app-main` agregó en el mismo bloque
  (`sql.accounts-receivable.repository.ts::getReportByPeriod()`, para
  que `pending+invoiced+collected+reverted` volviera a sumar `total`
  una vez que existe una fila `REVERTIDO`). A diferencia del union
  `AccountsReceivableStatus` (que sí compile-forceaba el arreglo vía
  `AR_STATUS_LABEL`, `Record` exhaustivo), acá nada lo forzaba — el
  único consumidor del reporte tipa la respuesta como `unknown` y la
  renderiza cruda. Mismo modo de falla que `ROLES-CATALOG-DRIFT-001`,
  severidad baja (tipo muerto, sin consumidor tipado todavía). Cerrado
  agregando `revertedAmount: number` a la interfaz —
  `appfrontend-main`, commit `e841d46`, verificado con `tsc --noEmit`
  limpio, `lint` sin errores nuevos, `test:unit` (25 tests) verde.
  Pusheado a `origin/main` de `appfrontend` el 14/09/2026 — estado de
  push verificable con `git log origin/main --oneline | grep e841d46`
  en ese repo, no citado acá como hecho fijo.

- **`CITY-LEDGER-REVERSE-TRANSFER-INTEGRATION-VERIFY-001`, 5 de 5 puntos
  (2, 3, 4, 5 -- vía SQL transcripto contra Neon; 1 -- vía el harness real
  de `vitest` contra un cluster Postgres 16.13 local del sandbox, agregado
  14/09/2026, gate `architecture-governor`, ronda 2).** Origen:
  `docs/pendientes-2026-09-12.md` (residuo de verificación de
  `AccountsReceivableService.reverseTransfer()`, Bloque 3c-ii, 14/09/2026).
  Puntos 2/3/4/5 verificados contra Postgres real: Neon, proyecto
  `ancient-king-17098519`, rama scratch `test-integration-db` --
  `br-bold-cell-axuvmork` (misma rama scratch ya documentada desde
  28/08/2026, `docs/pendientes-2026-08-28.md:27`, no una elegida ad-hoc),
  base descartable `verify_reverse_transfer_20260914` (creada, usada y
  borrada al terminar, confirmado — nunca tocó `production`
  (`br-snowy-tree-ax5wmq70`) ni `tenant-hotel-los-alamos`
  (`br-square-leaf-axzvu903`) -- ids, no solo nombre, ver
  `docs/pendientes-2026-09-10.md:1534-1536`/`:212`), con el schema.sql real
  completo aplicado, vía SQL-over-HTTP porque este sandbox bloquea TCP
  crudo a Postgres.

  **Alcance real de la evidencia, declarado sin matices por punto:**
  ningún TS de `accounts-receivable.service.ts` corrió en ningún momento —
  la verificación consistió en re-ejecutar a mano, contra Postgres real, el
  SQL transcripto de los repositorios reales, no el código compilado. NO
  cubre: la selección de rama en TS (`charge.reservationId ? … :
  'NOT_RECONCILED'`, el switch de `linkage.kind`,
  `correctedBalance != null && > 0`), el orden de escritura dentro de
  `TransactionManager.run()`, el rollback-on-throw, ni la fidelidad de la
  transcripción SQL contra lo que el repositorio realmente emite. Además,
  la base descartable fue borrada al terminar: lo que sobrevive es esta
  prosa, no un output capturado ni un comando reproducible — no hay evidencia
  re-consultable.
  - Punto 2 (CHECK `chk_financial_transactions_order_or_reservation`) —
    PASÓ a nivel SQL. INSERT real con `type='ADJUSTMENT'`,
    `reservation_id`+`stay_id` juntos (`order_id` NULL) aceptado; control
    negativo con `order_id`+`reservation_id` juntos rechazado por el mismo
    CHECK. Confirma contra Postgres real lo que la lectura estática de
    `schema.sql` ya decía: el XOR es solo entre
    `order_id`/`reservation_id`, `stay_id` no participa.
  - Punto 3 (guard 8-bis contra una factura real ISSUED/PENDING) — PASÓ a
    nivel SQL, cobertura parcial: `resolveInvoiceLinkage()` (confirmó
    `kind: ISSUED`) y `getIssuedCreditNoteCompensationTotal()` (confirmó
    `compensated: 0`) corridos con SQL real contra una factura ISSUED real
    vinculada al CHARGE. Lo que NO corrió: la query `facturas`
    (`sql.invoice.repository.ts:871-885`) ni
    `resolveReservationPairAttribution()` (`:892`) -- el selector de rama
    real, determina si el resultado termina en `RESOLVED` o `BLOCKED` -- y
    `getIssuedCreditNoteCompensationTotal()` (la que sí corrió) solo
    pertenece a la rama `BLOCKED` de fail-back; la rama `RESOLVED` usa una
    query distinta, `getIssuedCreditNoteCompensationTotalForReservation()`
    (`:897`), que nunca se ejecutó. Que `classifyReservationLiveInvoice()`
    devuelva `NOT_RECONCILED` y `reverseTransfer()` lance
    `ArReversalRequiresCreditNoteError` se confirmó leyendo la rama de
    código real (determinística), no ejecutando el TS compilado ni el
    selector de rama.
  - Punto 4 (rama `correctedBalance` de punta a punta) — PASÓ a nivel SQL.
    Reprodujo con SQL transcripto la secuencia completa que
    `postStayTransfer()` emite (no se ejecutó ese método en TS): revertir
    la AR original + insertar la AR de reemplazo. AR nueva quedó
    `PENDIENTE_FACTURAR`, `amount=1200`, `replaces_ar_id` apuntando a la AR
    revertida, CHARGE/PAYMENT nuevos creados correctamente.
  - Punto 5 (camino completo de punta a punta) — PASÓ a nivel SQL. Con una
    AR transferida real, ejecutó con SQL transcripto la secuencia exacta
    de `reverseTransfer()` y confirmó en SQL directo las 2 filas
    ADJUSTMENT: pata empresa (`amount=-1500`, `reservation_id` heredado,
    `stay_id=NULL` por diseño, `reversed_transaction_id` apuntando al
    CHARGE original, `status=SETTLED`), pata huésped (`amount=+1500`,
    `stay_id` heredado, `reservation_id=NULL`, `reversed_transaction_id`
    apuntando al PAYMENT original). La AR quedó `REVERTIDO` con
    `reversed_by`/`reversed_at`/`reversed_reason` seteados.

  Ningún fallo real de código encontrado en estos 4 puntos, dentro del
  alcance declarado arriba.

  **Punto 1 (lock `FOR UPDATE` bajo concurrencia real, dos transacciones
  genuinamente interleaved) — cerrado en una segunda ronda (14/09/2026, gate
  `architecture-governor`), con evidencia distinta y más fuerte que los
  puntos 2-5: no SQL transcripto, sino el harness real de `vitest` corrido
  con éxito contra un cluster PostgreSQL 16.13 **local al sandbox**
  (`pg_lsclusters` lo mostró instalado y apagado; se levantó con
  `pg_ctlcluster 16 main start`, mismo motor mayor que el `postgres:16-alpine`
  de `.github/workflows/ci.yml`) — no contra Neon, que sigue bloqueado por
  TCP crudo desde este sandbox. Se corrigieron antes 2 comentarios
  incorrectos y un dato inventado (`guest2`, un cliente que
  `Stay.checkIn()` nunca produciría para una segunda estadía sobre la misma
  reserva -- `stay.service.ts:220-227` siempre hereda `customerId` de la
  reserva) que un gate previo había señalado sin bloquear el commit por
  eso.
  - `src/tests/integration/reverse-transfer.integration.test.ts` (8 tests):
    **8/8 passed**, 4 corridas independientes, sin flakiness
    (`TEST_DATABASE_URL=postgres://testuser:testpass@localhost:5432/postgres
    npx vitest run --config vitest.integration.config.ts
    src/tests/integration/reverse-transfer.integration.test.ts`).
  - Suite de integración completa: **37 archivos / 317 tests, todos
    verdes** (misma `TEST_DATABASE_URL`, sin `--config` filtrado) — nada
    del resto del repo se rompió.
  - El interleaving real (no solo "el resultado final da 2 filas", que un
    `Promise.all` secuencial también daría) se probó instrumentando el
    cluster con `log_statement='all'` (revertido después) y leyendo el
    log: dos backends (pids `20038`/`20039`) abren `BEGIN` casi
    simultáneo, los dos ejecutan `SELECT ... accounts_receivable WHERE
    id=$1 FOR UPDATE` sobre la MISMA fila, el segundo backend queda
    bloqueado ~13ms hasta que el primero hace `COMMIT` -- y entre su
    `FOR UPDATE` y su propio `COMMIT` el backend perdedor no ejecuta
    ningún `INSERT`/`UPDATE`: tomó la rama idempotente de
    `accounts-receivable.service.ts:854-856` al releer la fila ya
    `REVERTIDO`, exactamente el guardrail que este punto buscaba
    confirmar.
  - `npx tsc --noEmit -p .` limpio. Sin bases `test_*` huérfanas tras las
    corridas (confirmado con `SELECT datname FROM pg_database WHERE
    datname LIKE 'test\_%'` → 0 filas).
  - **Lo que este punto NO verifica:** que Neon/producción se comporten
    igual que Postgres 16.13 local en este aspecto -- mismo motor mayor,
    semántica de `FOR UPDATE` estable entre ambos, pero es inferencia, no
    observación directa contra Neon.

  Commit del test:
  `src/tests/integration/reverse-transfer.integration.test.ts`, 8 tests,
  vía `git add` por path explícito (no `git add .`/`commit -a`, para no
  arrastrar archivos de otras sesiones en curso en el mismo working tree).

- **`CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001` — ítem completo
  cerrado (los 3 pasos tienen resolución final, ninguno sigue abierto).**
  Origen: `docs/pendientes-2026-09-12.md` (13/09/2026, grounding
  `auditor-circuitos-erp`). Diseño y verificación completos en
  `docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md`.

  1. ✅ **Hecho.** Vincular las dos patas de la transferencia — columna
     `guest_payment_transaction_id` en `accounts_receivable` (schema
     v52→v53). Commit `8f11d19` (13/09/2026).
  2. (a) ✅ **Hecho.** Docblock explícito en
     `financial-transaction.repository.ts` sobre por qué
     `getNetBalanceByCustomerId()` es `SETTLED`-only. Commit `8f11d19`
     (mismo commit que el paso 1).
     (b) ✅ **Hecho.** Separar los dos universos (`balance` SETTLED-only
     vs. `transactions` sin filtro) en el contrato de respuesta de
     `CustomerAccountService.getStatement()`, agregando el campo
     `cityLedgerOutstanding` (paso 2(b) del diseño, §1). Resuelve además
     `CITY-LEDGER-STATEMENT-TRANSFER-ROW-001` (la fila "AR Transfer" del
     statement sigue visible). Commit `1dc6c84` (14/09/2026). **Residuo
     explícito, no cerrado acá:** el relabel del `notes` de esa fila a
     "AR Transfer" (hoy sigue con su texto original) queda FUERA — es
     texto de UI, backlog sin bloque asignado todavía (ver §1.4 de
     `docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md`).
     Lo decidido acá es VISIBILIDAD de la fila, no su LABEL.
  3. **DECIDIDO NO IMPLEMENTAR (14/09/2026).** Cuatro rondas de diseño
     sucesivas para excluir del agregado del cliente la contribución
     fantasma que crea una transferencia a City Ledger fueron RECHAZADAS
     por el gate `architecture-governor`, cada una con un defecto
     aritmético real y distinto — ronda 1: un `PAYMENT` real del huésped
     contado como crédito fantasma; ronda 2: exclusión sin límite
     temporal; ronda 3: el predicado con límite temporal por
     `created_at` reproducía la misma regresión permanente que ya había
     obligado a revertir `8f11d19` para un cargo de POS "a la
     habitación" que no liquida junto con la reserva; ronda 4: una
     columna de vínculo (`absorbed_by_ar_id`) con corrección
     proporcional resolvía lo anterior pero rompía en la interacción con
     `reverseTransfer()` y tenía un escenario de pago parcial +
     liquidación escalonada sin medir bien. Con el diseño de la ronda 4
     ya verificado aritméticamente (12/12 escenarios contra Postgres
     real), el gate hizo la pregunta de negocio que quedaba, vía
     `AskUserQuestion` al dueño: ¿`balance` debe absorber esta corrección
     parcial, o debe quedar intacto (su definición actual, SETTLED-only,
     groundeada contra Odoo/ERPNext/QloApps en el paso 1 de este mismo
     ítem) dejando que `cityLedgerOutstanding` (paso 2(b), arriba)
     resuelva la visibilidad? **El dueño respondió: no tocar `balance`.**
     `getNetBalanceByCustomerId()` queda exactamente como está hoy, sin
     ningún cambio. El crédito fantasma transitorio (el caso que motivó
     las rondas) queda como comportamiento conocido y aceptado: se
     autocorrige solo en el camino feliz cuando el `CHARGE` original
     liquida (verificado empíricamente), y es explicable en pantalla vía
     `cityLedgerOutstanding`. Detalle completo de las 4 rondas, sus
     defectos y la verificación aritmética: §2 (§2.1-§2.9) de
     `docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md`.

  **Lo que esto NO cierra — sigue abierto, aparte:** el bug hermano de
  cancelación-con-Nota-de-Crédito ("PAYMENT sintético de City Ledger
  contamina el balance del cliente" — mismo síntoma que motivó este
  ítem, pero por cancelación-con-NC en vez del camino feliz, y de forma
  PERMANENTE, no transitoria) sigue vivo dentro de
  `ORDER-CONSOLIDATED-PARTIAL-01` en `docs/pendientes-2026-09-12.md` —
  la decisión de hoy sobre `balance` no lo toca ni lo resuelve.

---

## 13/09/2026

- **`CITY-LEDGER-OVERTRANSFER-PAYMENT-001`.** Origen:
  `docs/pendientes-2026-09-12.md` (hallazgo del gate
  `architecture-governor` al revisar §4.6 de City Ledger Bloque 3b). Un
  pago parcial del huésped posterior al check-in no bajaba
  `getNetBalanceByStayId()`, así que `transferStayBalanceToReceivable()`
  podía transferir a la empresa más de lo que el huésped debía —
  `CustomerAccountService.recordPayment()` nunca seteaba `stayId`, y el
  único backfill (`linkStayToReservationCharges()`) corría una sola vez,
  al check-in. Grounding ERP pedido ANTES de diseñar (`auditor-circuitos-erp`,
  5/5 sistemas de referencia: todos vinculan el pago a su documento al
  crearlo, ninguno hace fallback de FK al leer el saldo). Decisión del
  dueño, (a)+(c) combinado (registrada en el mensaje de `93a9416`) —
  `recordPayment()` setea
  `stayId` cuando la estadía está `CHECKED_IN` al pagar (resuelto en la
  ruta, sin romper bounded contexts — `SqlStayRepository` instanciado en
  `customers.routes.ts`, mismo patrón que `reservationId`), y
  `transferStayBalanceToReceivable()` corre `linkStayToReservationCharges()`
  como red de seguridad antes de leer el saldo, para los `PAYMENT` ya
  huérfanos. Gate: APPROVED WITH CONDITIONS, condiciones de comentario
  aplicadas en el mismo commit. Commit `93a9416` (fix de código, 7
  archivos) + `ddf7479` (docs, residuos de runtime registrados) — buscar
  con `git log --oneline --grep "CITY-LEDGER-OVERTRANSFER-PAYMENT-001"`.
  **No incluye** el backfill histórico de `PAYMENT` ya huérfanos en
  producción (necesita su propio `AskUserQuestion` sobre reservas
  multi-stay + `irreversible-action-gate`) ni los 6 residuos declarados
  (2 contra Postgres real, 1 de UI con datos reales en
  `appfrontend-main`, 1 de comportamiento de `checkOut()`, 1 de deriva
  de anclas, 1 de un ADR que quedó contradiciendo al código) — esos
  residuos viven en `docs/pendientes-2026-09-12.md`, sección `## 🔍
  Verificaciones pendientes`.

## 12/09/2026

- **Caso 6 — CHECK estructural `chk_financial_transactions_order_or_reservation`
  en `financial_transactions`.** Origen:
  `docs/investigacion-decisiones-bloqueado-2026-09-12.md`, caso 6. El
  guard de aplicación (`CreditNoteAmbiguousSubjectError`,
  `invoice.service.ts`) ya rechazaba ATRIBUIR una NC a una fila con
  `order_id` Y `reservation_id` no-nulos a la vez, pero es de lectura —
  no impedía que la fila ambigua se creara. Cierra la asimetría con
  `chk_invoice_item_origin` (tabla hermana) y
  `chk_financial_transactions_reversed_invoice_type` (misma tabla, v47).
  `<=1`, no `=1` como el precedente: hay filas legítimas con las dos
  columnas NULL (el `PAYMENT` que
  `AccountsReceivableService.transferStayBalanceToReceivable()` crea con
  solo `stayId`). Schema v49→v50. Decisión del dueño 12/09/2026
  (`AskUserQuestion`): bloque propio, ahora, no diferido. Introducido en
  este mismo commit (app-main) — buscar el hash con
  `git log --oneline --grep "chk_financial_transactions_order_or_reservation"`.
  **Verificación contra producción cerrada el 12/09/2026** (vía Neon MCP).
  El universo real de bases que toca `npm run migrate:tenants` no lo
  define el listado de branches de Neon, sino
  `src/scripts/migrate-tenants.ts`: `businesses` de la BD de plataforma
  (Neon `morning-unit-50056927`, branch `production`/`br-royal-mouse-aybe2ai3`)
  filtrado por `db_url_encrypted IS NOT NULL`, sin filtro de `status`.
  Corrida esa query exacta —
  `SELECT id, name, slug, status, schema_version, (db_url_encrypted IS
  NOT NULL) AS tiene_db FROM businesses ORDER BY created_at DESC` —
  devolvió exactamente 2 filas con `tiene_db = true`, las dos `ACTIVE`,
  las dos en `schema_version 49` (pre-v50): Hotel los Álamos
  (`hotel-los-alamos`) y Demo (`demo`). Coincide uno a uno con las 2
  tenant DB ya probadas — cadena cerrada, no quedan bases sin verificar.
  Sobre esas 2 (Neon `ancient-king-17098519`): `production`/Demo
  (`br-snowy-tree-ax5wmq70`) y `tenant-hotel-los-alamos`
  (`br-square-leaf-axzvu903`). `SELECT count(*) FROM
  financial_transactions WHERE order_id IS NOT NULL AND reservation_id
  IS NOT NULL` → `0` en las dos, sobre un total de 21 filas en Demo y 0
  en Hotel los Álamos (denominador, mismo formato que el precedente de
  v47). Evidencia también en el comentario del BLOQUE 22 de `schema.sql`.
  Ya no bloquea el deploy.

- **Caso 6, residuo parte 2 — costo recurrente de los 3 CHECK de
  `financial_transactions`.** Origen:
  `docs/investigacion-decisiones-bloqueado-2026-09-12.md:217-220`;
  decisión del dueño 12/09/2026 (`AskUserQuestion`): sí, resolver el costo
  ahora. **La pregunta tal como se planteó (¿mover a
  `migrations/NNN_*.sql`?) resultó tener una respuesta técnica distinta a
  la que se preguntó** — investigado antes de implementar (mismo criterio
  que D5/`criterios-negocio.md`, no ejecutar una decisión de negocio sin
  chequear que el mecanismo propuesto haga lo que promete):
  `migrations/NNN_*.sql` NO está conectado a `applyTenantSchema()` —
  ningún camino real de alta o reparación de tenant lo corre: son
  **5** call-sites (gate `architecture-governor` corrigió la
  enumeración original de esta entrada, que tenía 4 y se quedaba
  `platform.routes.ts` afuera) — `business.routes.ts` (alta pública),
  `admin.routes.ts` `repair-tenant-db`/`set-tenant-url`,
  `platform.routes.ts` `POST /platform/businesses/:id/provision`
  (reintento de aprovisionamiento del superadmin), y `migrate-tenants.ts`
  (runner de deploy) — todos corren únicamente `schema.sql`. Moverlos a
  `migrations/` habría dejado a todo tenant futuro sin los 3 CHECK, en
  silencio. Implementado en cambio: los 3
  (`chk_financial_transactions_amount`, `_reversed_invoice_type`,
  `_order_or_reservation`) pasan del patrón `DROP CONSTRAINT IF EXISTS` +
  `ADD CONSTRAINT` incondicional a un guard
  `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)`
  — el `ADD` (el costoso, revalida la tabla) solo corre la primera vez que
  un tenant no lo tiene; un tenant nuevo lo sigue recibiendo igual, porque
  sigue siendo parte de `schema.sql`. Schema v50→v51.
  **Validado parcialmente, no contra el archivo completo:** corrida
  aislada de los 3 bloques nuevos contra Neon real (rama
  `test-integration-db`, vía `run_sql_transaction`, `TEMP TABLE`
  descartable con la misma forma) — 1ª corrida crea las 3 constraints con
  la definición exacta de `schema.sql`, 2ª corrida no falla y no las
  re-crea, un INSERT válido pasa. `npx tsc --noEmit` limpio y
  `npx vitest run` completo (163 archivos, 2155 tests) verde — **pero
  ningún test de esa corrida ejecuta `schema.sql` contra Postgres real**
  (`schema-redeploy-idempotent.integration.test.ts` es
  `describe.skipIf(skipIfNoDb)`, sin `TEST_DATABASE_URL` en este entorno),
  así que la suite verde no es evidencia sobre el SQL en sí. Residuo
  abierto en `pendientes-2026-09-12.md`, § Verificaciones pendientes.

- **Caso 1 — purga del outbox (A7.6).** Origen:
  `docs/investigacion-decisiones-bloqueado-2026-09-12.md`, caso 1;
  retención (90 días, solo eventos "resueltos") ya decidida el
  10/09/2026, `docs/diseno-outbox-backoff-2026-09-10.md` §10 (cerrado
  hoy con la resolución de la interacción `retryDeadLettered()` que
  había quedado sin responder ahí). Decisión del dueño 12/09/2026
  (`AskUserQuestion`, 3 rondas): endpoint manual de superadmin ahora,
  sin cron de Render (plan free no lo soporta); alcance global (todos
  los tenants de una corrida, patrón `migrate-tenants.ts`); aviso de
  fallo por respuesta HTTP (`{ok, failed}`), sin canal nuevo; **dead-letter
  SÍ se purga a los 90 días** (confirmado explícitamente después de que
  el gate `architecture-governor` encontrara un consumidor no mapeado —
  `GET /api/system/outbox/dead-letter`, `Roles.MANAGEMENT`, bandeja
  operable en `appfrontend-main/components/SystemRail.tsx` — y planteara
  la consecuencia en esos términos antes de aprobar).
  `DomainEventRepository.purgeResolved(retentionDays)` nuevo
  (`sql.domain-event.repository.ts`) — `DELETE FROM domain_events WHERE
  occurred_at < NOW() - (retentionDays || ' days')::interval AND
  (dispatched_at IS NOT NULL OR failed_at IS NOT NULL)`;
  `processed_events` cae por `ON DELETE CASCADE` ya existente, sin
  DELETE propio. `src/platform/outbox-purge.ts` (nuevo): una sola función
  `purgeOutboxAcrossTenants()`, fail-soft (a diferencia de
  `migrate-tenants.ts`, que sale con código 1 -- acá un tenant caído no
  aborta el resto), consumida por 2 disparadores —
  `POST /platform/outbox/purge` (SUPERADMIN, bajo el `router.use()` ya
  existente de `platform.routes.ts`, sin `authorize()` nuevo que contar)
  y `npm run purge:outbox` (script standalone, mismo armado que
  `migrate-tenants.ts`). RBAC: `EXCLUDED_FILES['platform/platform.routes.ts'].hiddenCount`
  11→12 (`rbac-matrix-section2-sync.test.ts`), fila nueva en
  `docs/rbac-matriz-endpoints.md`, `docs/inventario-rutas.md` regenerado
  (252→253) — `EXPECTED_AUTHORIZE_CALL_SITES` sin cambios (correcto: ese
  contador es de `authorize(Roles.X)` de tenant, no de
  `authorizePlatform`). `npx tsc --noEmit` limpio, `npx vitest run`
  completo (163 archivos, 2158 tests) verde, `lint`/`lint:arch` limpios.
  **No validado contra Postgres real:** 7 tests de integración nuevos
  (`outbox-worker.integration.test.ts`, SECCIÓN 1-C) cubren el predicado
  completo (PENDING nunca se purga, resuelto dentro/fuera de ventana,
  dead-letter, el caso `retryDeadLettered()`, CASCADE de
  `processed_events`, caso límite `retentionDays=0`) pero
  `describe.skipIf(skipIfNoDb)` los saltea sin `TEST_DATABASE_URL` en
  este entorno — nunca corrieron de verdad. Residuo en
  `pendientes-2026-09-12.md`, § Verificaciones pendientes.

- **Caso 3 — `StayService.checkOut()` cuenta saldo `PENDING` y
  MANAGEMENT puede forzarlo con rastro.** Origen: hallazgo adyacente del
  gate de 1c-0, registrado sin bloque asignado en
  `pendientes-2026-09-12.md`; investigado y con grounding en
  `docs/investigacion-decisiones-bloqueado-2026-09-12.md`, caso 3.
  `getNetBalanceByStayId()` filtraba `status = 'SETTLED'` a secas — el
  CHARGE de saldo y los ADJUSTMENT de precio nacen `PENDING` y liquidan
  recién en `reservation.completed`, que el check-out no dispara: el
  guard casi nunca veía el ítem de ingreso principal de la estadía.
  Corregido a `status IN ('PENDING', 'SETTLED')`. Con el cálculo ya
  correcto, `checkOut()` pasa a advertir-y-permitir-con-permiso
  (grounding Cloudbeds/Oracle OPERA, decisión del dueño): MANAGEMENT
  puede forzar el check-out con `overridePendingBalance`, con rastro en
  `stays.balance_override_by`/`_at`/`balance_at_override` (A6.5, mismo
  patrón que `housekeepingOverride*`). Schema v48→v49. **Commit
  `ad28d2e`** (app-main, backend) + **commit `4cb5a04`**
  (appfrontend-main, contraparte de UI — sin la cual el fix de backend
  solo habría dejado el botón de check-out deshabilitado para casi toda
  estadía activa, regresión detectada por el gate en la primera pasada).
  2 residuos NO cerrados con esto, quedan abiertos por separado: la
  reconciliación de City Ledger con montos `PENDING` (Q2,
  `pendientes-2026-09-12.md`, `🔴 Bloqueado`, `requiere decisión del
  dueño`) y la corrida real de los 2 integration tests reescritos +
  verificación de UI con datos reales (`pendientes-2026-09-12.md`,
  `🔍 Verificaciones pendientes`).

- **Los 4 "bugs activos" de la auditoría transversal del 12/09** — origen:
  §1 y §10 de `docs/auditoria-transversal-navegacion-autogestion-circuitos-2026-09-12.md`.
  Implementados en paralelo (4 agentes, uno por bug, `isolation: "worktree"`
  para los 2 de `app-main`), gate combinado de `architecture-governor`
  aprobado con condición explícita de 4 commits separados (no 2 agrupados
  por repo) — cada uno es su propia unidad de revert y de evidencia.
  - **`CRASH-CUSTOMER-RATE-RENDER-01`** (§1.1 — la ficha de cualquier
    cliente con tarifa especial se caía, `rate.price` vs. `fixedPrice`
    real). `CustomerRate` (`appfrontend-main/src/lib/clientes/types.ts`)
    corregido al contrato real (5 scopes + `fixedPrice`/`discountPercentage`
    nullable); dos helpers nuevos en `clientes/[id]/page.tsx` reemplazan las
    dos expresiones inline que rompían. **Commit `bbf98c0`** (appfrontend-main).
    Verificación runtime (ficha con tarifa scope `categoryId`/`bucket`/
    `productId`) — ver `pendientes-2026-09-12.md`, § Verificaciones pendientes.
  - **`REPORTS-DATEONLY-MISMATCH-001`** (§1.2 — los 5 reportes con pantalla
    devolvían 400 siempre, `datetime-local`/`.toISOString()` contra
    `dateOnlySchema`). Los 10 inputs de fecha de `reportes/page.tsx` y los 3
    bloques de reportes de `admin/page.tsx` pasados a `type="date"`, sin
    transformación adicional; `components/ApiBlock.tsx` suma `'date'` al
    tipo `InputDef` (necesario para que compile). **Commit `9d70b07`**
    (appfrontend-main). Verificación contra backend real levantado — ver
    `pendientes-2026-09-12.md`, § Verificaciones pendientes.
  - **`PATCH-STATUS-EVICT-001`** (§10, severidad alta — suspender un
    negocio no cortaba el acceso hasta reiniciar el proceso).
    `PATCH /platform/businesses/:id/status` ahora llama a
    `evictTenantPool()` (ya existente, mismo patrón que `admin.routes.ts`)
    tras confirmar la transición. 3 tests nuevos. **Commit `5c7bef9`**
    (app-main). Verificación runtime contra Postgres real — ver
    `pendientes-2026-09-12.md`, § Verificaciones pendientes.
  - **`PLATFORM-AUDIT-ACTOR-STABLE-001`** (§10, severidad alta — el actor
    del audit log de plataforma era un UUID nuevo en cada login, imposible
    de correlacionar por persona). `sub`/`userId` del token de superadmin
    pasa de `randomUUID()` a `creds.email` (estable, `VARCHAR(255)` sin
    CHECK de formato UUID en el schema). No rediseña el modelo de un solo
    superadmin. **Commit `238b7df`** (app-main). Limitación conocida, no
    bug, sin acción pendiente: los tokens emitidos antes del deploy siguen
    válidos hasta 8h con el `sub` viejo (UUID) — el audit log va a tener un
    tramo mezclado UUID/email tras el deploy, esperado y no corregible sin
    invalidar sesiones activas.
  - Cierre en docs (marcar ✅ en el propio documento de auditoría, con
    hash) — **commit `839450c`** (app-main).

- **`diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md`** — diseño de la
  salida manual para `CN-ESCAPE-ORPHAN-ADJUSTMENT-001` (un `ADJUSTMENT`
  puede quedar `PENDING` para siempre si `buildCreditNote()` falla
  determinísticamente después de que el orquestador de escape ya commiteó
  tx1) y reapertura acotada de B3 (`credit_note_request`, ticket). **Cierre
  de DISEÑO, no de implementación** — no confundir las dos cosas. 12 pasadas
  de `architecture-governor` (v1→v7.2); cambio de alcance mayor en v7.0:
  `NO_ITEMS` se retira porque la migración Nivel A→B ya cerró ese período
  para cualquier tenant real y el dueño confirmó, vía `AskUserQuestion`, que
  todos los tenants existentes hoy son demo/descartables — con eso el único
  motivo habilitado es `AMOUNT_MISMATCH`, que siempre tiene `invoice_items`
  de origen reales. **Commit `15b2364`.** No queda ninguna pregunta abierta
  para el dueño (partición de §9: 0 de 10 ítems). **La IMPLEMENTACIÓN sigue
  bloqueada** por una precondición externa real: la cadena de HOLD de
  `invoice_drafts` en `FACT-BORRADOR-001` (ítem 3 de §9 del propio
  documento) — no hay tabla nueva, no hay código nuevo, solo el diseño.
  Origen: `pendientes-2026-09-12.md`.

- **`FACT-BORRADOR-001` §29 (v2.10→v2.11)** — nota registrada de una
  propuesta del dueño para modelar cargos administrativos/intangibles como
  ítem de catálogo de primera clase, en vez de línea manual sin origen.
  Corrige dos supuestos de la propuesta original contra el schema real
  (`order_items.item_type` ya tiene 3 ramas, no 1; `products.product_type`
  ya existe pero con OTRO significado — no reusable para
  `PHYSICAL`/`SERVICE` sin colisión) y presenta dos alternativas: A (columna
  `requires_inventory` ortogonal) y B (rama `SERVICE` nueva en `item_type`,
  preferida por el dueño — con su costo medido contra `app-main` **y**
  contra los 3 sitios de `appfrontend-main` que hardcodean el tipo, mismo
  patrón de riesgo que `ROLES-CATALOG-DRIFT-001`). No reabre §17/§24/§28 de
  ese documento. No autoriza `CREATE TABLE`/migración/código — pasa por
  `criterios-negocio` + `architecture-governor` antes de implementarse. Dos
  pasadas de gate. **Commit `e747982`.** Origen: `pendientes-2026-09-12.md`.

- **`lock-order.test.ts` blind spot (FN #2)** — commits `7150dfa`+`271fdd4`+
  `1cd9cea`. Detalle: `docs/zulu-hub-continuidad-2026-09-09.md`. Origen:
  `pendientes-2026-09-12.md`.

- **`EMISOR_NOTA_CREDITO` — bloque 5.1, los 3 catálogos frontend, CERRADO
  3/3.** Verificado en producción, no solo pusheado (Render deploy en commit
  `9d8ad1a` = `live`, `migrate:tenants` corrió limpio; Vercel verificado
  bajando el bundle real y greppeando — texto nuevo presente, cero
  ocurrencias del subtítulo falso viejo).
  - `dashboard/roles/page.tsx` + `superadmin/planes/page.tsx` —
    `appfrontend-main` `ba01d3d`.
  - `superadmin/roles-de-fabrica/page.tsx` — copy falsa ("Editar acá NO
    afecta a los negocios que ya existen") corregida por un bloque de
    advertencia con el mecanismo real. `app-main`: `f91d7ad` → `328b134` →
    `14c5166` → `7cee110` → `9d8ad1a`. `appfrontend-main`: `5ba8b57` →
    `6a427c9`.
  - Cerca de fondo (evita el próximo drift): `5dbbbc6`,
    `src/tests/security/roles-catalog-sync.test.ts`
    (`ROLES-CATALOG-DRIFT-001`) — congela el CONJUNTO ordenado del catálogo
    `Roles` + espejo `key===value`, 3 mutaciones verificadas.
  - **Bloque B, también cerrado** — el checkbox de `EMISOR_NOTA_CREDITO` en
    `roles-de-fabrica/page.tsx` se agregó el 11/09/2026 (gate
    `architecture-governor`, `ROLES-CATALOG-DRIFT-001` bloque B),
    `appfrontend-main` `0609483`. Con esto el ítem queda genuinamente
    completo: 3/3 catálogos + el checkbox.
  Origen: `pendientes-2026-09-12.md`.

- **Guard `isSystem` en `RoleService.renameRole()`** — `8fc30c3` (app-main),
  `cbdf1bd` (appfrontend-main, comentario espejo). Hallazgo encontrado de
  paso por el gate al revisar `PRESET-REVOKE-001` (10/09/2026):
  `renameRole()` no tenía guard de `isSystem` — consecuencia real: (a) el
  backfill de arranque inserta con `id` determinístico bajo
  `ON CONFLICT (business_id, name)`, un rename libera ese par y el próximo
  INSERT choca contra `roles_pkey` sin capturar, el próximo arranque del
  proceso revienta; (b) `roles.name` es de facto clave técnica de
  autorización — un ADMIN podía renombrar el rol OWNER de su negocio y
  saltarse esos guards. Medido en producción (10/09/2026): 0 roles de
  sistema renombrados a esa fecha — puramente preventivo. Guard:
  `before.isSystem && before.name !== name`. 6 mutantes verificados. Test de
  integración contra Postgres real confirma el crash sin el guard.
  **Residual aceptado, no cerrado a propósito:** ningún test cubre que
  renombrar un rol CUSTOM audite el cambio de nombre (dentro de
  `src/usuarios-roles/role.service.ts::renameRole()`, en el bloque
  `if (before.name !== name) { await this.auditLogRepo.record(...) }`)
  — deuda preexistente, no empeorada por este bloque. El fix estructural
  relacionado (consumidores por `roles.name` en vez de `role.id`/
  `is_system`) es un bloque aparte — ver `pendientes-2026-09-12.md`,
  sección "🟡 Listo para encarar". Origen: `pendientes-2026-09-12.md`.

- **Polling adaptativo — bloque 1 (helper + `CompanyCatalogPropagationWorker`).**
  `6f1289a`+`02629b7`. Detalle completo, 2 rondas de gate y las 3 condiciones
  (C1 bloqueante: import cruzado hacia `platform/` desde un servicio de
  dominio, corregido con inyección por constructor; C2: backoff tras error;
  C3: ventana de wake perdido) en
  `docs/diseno-polling-adaptativo-neon-2026-09-10.md`. Motivo: los 3 workers
  de producción polleaban más seguido que la ventana fija de 5 min del
  scale-to-zero de Neon, agotando el cupo de compute del plan free el
  10/09/2026. Verificado en producción: CI `integration` en verde (run
  `34546841825`), deploy `dep-dahknmks728c73bi7utg` = `live` en `02629b7`
  (identidad confirmada por API de Render, no solo `/health`), `/health/db`
  → `connected`. **No cierra el grupo "polling adaptativo de los 3
  workers"** — `OutboxWorker` y `ReservationHoldExpiryWorker` siguen con
  `setInterval` fijo, coexistencia transitoria declarada, cada uno con su
  propio diseño pendiente en el mismo doc. Medir el ahorro de compute real
  — ver `pendientes-2026-09-12.md`, § Verificaciones pendientes. Origen:
  `pendientes-2026-09-12.md`.

- **`lock-order.test.ts` blind spot, confirmado cerrado (corrección de
  etiqueta)** — el mismo FN#2 de arriba (`7150dfa`+`271fdd4`+`1cd9cea`)
  seguía listado como "declarado sin arreglar" en el archivo de origen
  (#27.2 de `pendientes-2026-09-08.md`). Confirmado con
  `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`, que ya
  dice, textual, "**✅ Punto ciego cerrado el 09/09/2026**". Origen:
  `pendientes-2026-09-12.md`.

- **`CITY-LEDGER-SCHEMA-V52-001` — confirmado contra Postgres real, en los
  2 tenants.** El `ALTER` de schema v52 (`docs/diseno-reconciliacion-
  city-ledger-2026-09-12.md` §4.2, commit `b82d828`, push `23d6bf7`)
  corrió en el deploy de Render y se verificó por tenant (Neon
  `ancient-king-17098519`, branches `br-snowy-tree-ax5wmq70` y
  `br-square-leaf-axzvu903`): `SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint WHERE conrelid = 'accounts_receivable'::regclass`
  muestra `chk_accounts_receivable_status` con los 4 valores
  (`PENDIENTE_FACTURAR`, `FACTURADO`, `COBRADO`, `REVERTIDO`) y **ninguna**
  entrada `accounts_receivable_status_check` (el nombre viejo) — el `DROP`
  no fue un no-op, no quedaron los dos CHECK conviviendo. Las 2 FK nuevas
  (`reversal_transaction_id`, `replaces_ar_id`) están presentes, sin
  cláusula `ON DELETE` explícita en `pg_get_constraintdef` porque `NO
  ACTION` es el default de Postgres y se omite al imprimir — coincide con
  lo escrito en el schema. `schema_migrations` confirma `MAX(version) = 52`
  en ambos tenants. Backup previo verificado: ramas
  `respaldo-pre-v52-city-ledger-2026-09-12` (producción) y
  `respaldo-hotel-pre-v52-city-ledger-2026-09-12` (Hotel Los Álamos),
  ambas `ready` antes del push. Origen: `pendientes-2026-09-12.md`.

- **`CN-VOID-COREJECT-STALE-TEST-001` -- cierra SOLO el test stale (residual
  1 de 3 del Caso 5).** El `it()` `C1(ii)` de
  `src/tests/integration/cancel-reservation-with-credit-note.integration.test.ts`
  seguía afirmando la guarda EXACT-MATCH vieja (`rechazos.length === 1 &&
  rechazos[0] === 'CARGO_CON_COMPROBANTE_VIVO'`), retirada el 11/09/2026
  (3.3-d residual 2, `docs/diseno-33d-residuales-2026-09-11.md` §2) a favor
  del allowlist positivo `esComprobanteVivoConCoRechazosBenignos()` que
  incluye `TIPO_NO_LIQUIDABLE` a propósito -- el test nunca se actualizó
  cuando ese residual shippeó. Reproducido primero TAL CUAL contra
  Postgres 16 real (local, este sandbox, no Neon) para confirmar la causa
  raíz de forma independiente -- falló exactamente como documentaba la
  investigación previa (0 llamadas a `logger.error`). Corregido para
  afirmar el comportamiento correcto y ya decidido (mismo patrón que el
  test de la línea ~586 del mismo archivo y el test unitario espejo de
  `src/workers/outbox.handlers.test.ts:651`): con el `PAYMENT` propio
  presente, el handler SÍ consulta la clasificación, da `RECONCILED`, y
  loguea `logger.info` con `reconciliado: true` -- nunca `logger.error`.
  Ningún archivo de `src/` fuera del test cambió -- el código de
  producción ya era correcto desde el 11/09/2026, lo que estaba mal era
  la aserción. Verificado: el archivo solo (9/9), la suite de integración
  COMPLETA contra el mismo Postgres real (36 archivos / 303 tests, 100%
  verde -- antes 288/289 con este mismo test como único rojo), la suite
  unitaria completa (163 archivos / 2158 tests), y `tsc --noEmit` limpio.
  **Los otros 2 residuales del Caso 5 NO cierran acá, siguen abiertos:**
  residual 2 (verificar contra datos reales de producción si existió el
  caso "seña reembolsada, cancelada después con NC") y residual 3 (regla
  de crédito `PAYMENT`-vivo-tras-NC, decisión del dueño ya tomada,
  implementación en curso) -- ambos en
  `docs/pendientes-2026-09-12.md`. **Nota de reconciliación:**
  `docs/pendientes-2026-09-10.md` arrastra una copia divergente de este
  mismo bullet (agregada ahí por una sesión concurrente después de que
  `-12.md` ya se había ramificado de `-10.md`) -- superada por fecha,
  nunca se actualiza sola; si alguien la lee sin saber esto puede
  reabrir un ítem ya cerrado acá. Origen: `pendientes-2026-09-12.md`.

- **`INVOICE-CHARGES-GUARD-INDIVIDUAL-01` -- los 3 hallazgos cerrados
  (13/09/2026).** Nació como hallazgo del gate `architecture-governor`
  (11/09/2026) al cerrar el ítem de arriba (§4.0, tercera dirección del
  mismo concepto). El fix de arriba cerraba SOLO consolidada-vs-consolidada.
  Esta tercera dirección (camino INDIVIDUAL, `requestInvoice()` nunca
  escribe `invoice_charges` -- solo las consolidadas pasan `charges`,
  `src/facturacion/sql.invoice.repository.ts:1229-1235,1265-1272`)
  seguía sin
  guardia. La alcanzabilidad por UI estaba CONFIRMADA, no era teórica: un
  usuario `FRONT_DESK` podía emitir un segundo CAE real de AFIP para un
  cargo que una consolidada ya había facturado -- un duplicado fiscal que
  no se puede borrar, necesita una Nota de Crédito contra AFIP
  (R12/DOCUMENTO). Tres hallazgos, cada uno agravaba al anterior:
  1. **El solapamiento es el camino de diseño, no una mala
     configuración.** `AccountsReceivableService.transferStayBalanceToReceivable()`
     (`src/clientes-finanzas/accounts-receivable.service.ts:121` exige
     `company.kind === 'COMPANY'`; `:143-174`) crea un `CHARGE` `SETTLED`
     nuevo (`companyChargeId`) en la cuenta corriente de la EMPRESA a
     propósito -- comentario propio: la deuda tiene que verse en el
     ledger normal "desde el momento de la transferencia, no recién
     cuando se facture" (pedido explícito del dueño, F1-Pieza 3,
     23/08/2026) -- y ESE MISMO `financial_transaction_id` es el que
     queda `accounts_receivable.financialTransactionId` para la
     consolidada. El camino que alimenta la factura consolidada es, por
     diseño, el mismo cargo que aparece en cuentas corrientes.
  2. **El botón individual de la UI tenía un argumento de seguridad
     escrito que era falso para el camino consolidado.**
     `appfrontend-main/src/components/FacturarButton.tsx:11-16` (usado en
     `appfrontend-main/src/app/dashboard/cuentas-corrientes/page.tsx:304-306`
     para cualquier cliente con `enableCurrentAccount=true`, sin filtrar
     por `kind` -- una EMPRESA con cuenta corriente entra igual) decía
     textual: "`POST /api/invoices` es idempotente por
     `financialTransactionId`... reintentar el click en una factura ya
     emitida devuelve la misma factura, nunca pide un CAE duplicado. Por
     eso este componente no pre-consulta el estado al montar". Cierto
     para el camino individual (`idempotencyKey = invoice:<ftId>`),
     falso para el consolidado (`idempotencyKey =
     invoice:consolidated:<hash>`, nunca choca) -- un cargo YA facturado
     por una consolidada seguía mostrando el botón "Facturar" activo, y
     clickearlo pedía un segundo CAE real sin que ningún mecanismo lo
     frenara. Exactamente el patrón que `honest-degradation` existe para
     atrapar.
  3. **Asimetría de autorización.** El endpoint consolidado era
     `Roles.MANAGEMENT` a propósito (`src/facturacion/invoices.routes.ts:112-117`,
     comentario propio: "es una decisión de facturación corporate, no una
     operación de mostrador"); el individual era `Roles.FRONT_DESK` sin
     ninguna excepción. Un recepcionista podía, sin querer, adelantarse o
     duplicar una decisión de facturación corporate que el código
     reservaba a propósito para MANAGEMENT.
  **Medido, read-only, las 2 tenants reales (Neon `ancient-king-17098519`,
  11/09/2026)**: 3 queries -- (i) `invoices` individuales que YA coinciden
  con un `financial_transaction_id` de `invoice_charges` (duplicado ya
  ocurrido): `0`/`0`. (ii) AR `PENDIENTE_FACTURAR` cuyo cargo ya tiene una
  invoice individual: `0`/`0`. (iii) cargos con `invoice_charges` (de
  cualquier status) que pertenecen a un cliente con
  `enable_current_account=true` (exposición en vivo): `0`/`0`. Sin
  incidente real ni exposición en vivo en los datos de práctica -- el
  mecanismo era genuinamente alcanzable, no solo posible en abstracto.
  **Pregunta de producto -- RESPONDIDA (11/09/2026, `AskUserQuestion` al
  dueño, grounding ERP verificado contra código real)**: facturar
  individualmente un cargo que ya está en un lote consolidado NO
  facturado todavía sigue siendo legítimo (parcial/escalonado es el caso
  normal en Odoo/ERPNext, no una excepción); lo único que se protege es
  el CARGO PUNTUAL una vez que YA tiene un comprobante real, por
  cualquiera de los dos caminos -- mismo patrón que
  `POS Invoice.consolidated_invoice`/`status` de ERPNext. Forma de cierre
  elegida: (c) backend + UI.

  **Bloque 1 (guard individual)**, commit `81e9eb2` (gate
  `architecture-governor`, 3 rondas: HOLD → APPROVED WITH CONDITIONS →
  APPROVED WITH CONDITIONS). `InvoiceService.requestInvoice()` rechaza
  (`InvoiceAlreadyLinkedByOtherPathError`) si `resolveInvoiceLinkage(ftId)`
  encuentra un comprobante vivo del OTRO camino (consolidada vía
  `invoice_charges`) en estado `ISSUED`/`PENDING`/`FAILED_UNCERTAIN` --
  `REJECTED` NO bloquea (decisión grounded: Odoo excluye `state=='cancel'`
  de `qty_invoiced`, `sale_order_line.py:1007-1011`; ERPNext excluye
  `docstatus==2`). Guard posicionado DESPUÉS de la idempotencia propia del
  camino individual (`invoice:<ftId>`) -- load-bearing, verificado con
  test dedicado que prueba que los 4 call-sites de cancelación-con-NC
  siguen cayendo en `retryExisting()`. Predicado
  `ISSUED|PENDING|FAILED_UNCERTAIN` extraído a
  `INVOICE_STATUSES_CONSUMING_CHARGE` (`invoice.entities.ts`), reusado en
  `getInFlightCreditNoteTotalForUpdate()`/`ForPair`
  (`sql.invoice.repository.ts:583,620`, antes duplicado a mano). Mutación
  verificada (comentar el guard pone en rojo exactamente los 3 tests que
  dependen de él, los otros 2 siguen verdes). Medido read-only, las 2
  tenants reales (Neon `ancient-king-17098519`): 0 cargos en el estado que
  el guard bloquearía -- el deploy no disparó el error nuevo sobre ningún
  caso existente. Suite completa 2097/2097 (+5 desde el bloque anterior),
  typecheck y eslint limpios.

  **Bloque 1-bis**, commit `605b3d5`.
  `getInvoicedFinancialTransactionIds()`
  (`sql.invoice.repository.ts::getInvoicedFinancialTransactionIds()`)
  también mira `invoices.financial_transaction_id` directo (camino
  individual), filtrado por `INVOICE_STATUSES_CONSUMING_CHARGE`
  (`ISSUED|PENDING|FAILED_UNCERTAIN`, no `REJECTED`) -- `UNION` con la
  rama `invoice_charges` existente, sin tocarla. Asimetría a propósito
  entre las 2 ramas del predicado (una consolidada `REJECTED` libera el
  cargo para facturarse individual, pero NO para re-consolidarse --
  `idx_invoice_charges_ft` es único, sin filtro de status, y
  `invoice_charges` nunca se borra), documentada en el docblock de la
  interfaz (`invoice.repository.ts`) y fijada con un test dedicado
  (`consolidated-invoice-toctou.integration.test.ts`, caso "asimetría a
  propósito"). 11 tests de integración contra Postgres real (este bloque
  editó SQL nuevo): 3 nuevos (`ISSUED`/`PENDING`/`FAILED_UNCERTAIN` vía
  factura individual rechazan), 1 nuevo (`REJECTED` vía individual NO
  rechaza, la consolidada nueva cubre el cargo), 1 nuevo (la asimetría --
  consolidada `REJECTED` sigue bloqueando), + los 6 preexistentes, todos
  verdes. Mutación verificada contra Postgres real: revertir el SQL al de
  antes de este bloque pone en rojo exactamente los 3 casos nuevos que
  dependen de la rama agregada, los otros 8 quedan verdes. `npx tsc
  --noEmit` y `npx eslint` limpios; suite unitaria sin cambios, 2097/2097
  -- este bloque no agregó tests unitarios a propósito, la cobertura real
  vive en integración.

  **Hallazgo 3 (asimetría de roles)**, commit `495154f` (13/09/2026, gate
  `architecture-governor`, diseño + implementación en 2 rondas --
  decisiones del dueño vía `AskUserQuestion`: "seguí con lo que esté en
  rojo" → este ítem; "Exigir MANAGEMENT para facturar individual a una
  EMPRESA"; "Solo Factura normal" para el fork de Nota de Crédito).
  `requireManagementForCompanyCharge()` (`invoices.routes.ts`), llamada
  inline en el handler de `POST /api/invoices` DESPUÉS de parsear el body
  con Zod y ANTES de invocar `requestInvoice()` -- mismo patrón que el
  `overrideHousekeeping`/`overridePendingBalance` de `stays.routes.ts`
  (elevación condicional a `MANAGEMENT`, 403 explícito), con el lookup a
  BD al estilo `requireOwnReservation()`. Acotado a Factura normal a
  propósito -- NO aplica si `tx.type` es `REFUND`/`ADJUSTMENT` (la Nota de
  Crédito del escape de cancelación sigue alcanzando con
  `Roles.EMISOR_NOTA_CREDITO`, sin reabrir el ADR
  `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §10 q7).
  Fail-closed explícito si el cliente no se puede resolver (inalcanzable
  hoy por el FK `NOT NULL` de `financial_transactions.customer_id` en
  `schema.sql`, pero sin un `?.` mudo que lo tape en silencio). Ninguna de
  las 10 cercas RBAC se tocó (corridas `rbac-matrix-sync`,
  `rbac-matrix-section2-sync`, `rbac-route-coverage`, las 3 verdes) -- no
  es un `authorize()` nuevo, la ruta ya tenía autz en su cadena.
  `docs/rbac-matriz-endpoints.md:178` actualizada dentro de la prosa
  existente, sin bullet nuevo (para no romper
  `EXCLUDED_FILES.docBullets: []` de `rbac-matrix-section2-sync`). 8 tests
  nuevos en `invoices.routes.test.ts` (7 directos sobre el guard exportado
  + 1 de wiring real vía el handler), mutación verificada: comentar la
  llamada al guard en el handler pone en rojo exactamente el test de
  wiring, los otros 24 (16 preexistentes + 7 del guard suelto) quedan
  verdes. Medido read-only, las 2 tenants reales (Neon
  `ancient-king-17098519`, 13/09/2026): `0`/`0` cargos CHARGE de un
  cliente `kind='COMPANY'` sin factura por ningún camino -- el 403 nuevo
  no era alcanzable sobre ningún caso existente el día de este commit.
  Suite completa 2178/2178 (163 archivos), suite de integración 304/304
  sin cambios, `tsc --noEmit` y `lint:arch` limpios.
  **2 residuos NO resueltos acá, con su ancla, en
  `docs/pendientes-2026-09-12.md` sección `## 🔍 Verificaciones
  pendientes`:** el frontend (`FacturarButton` en dos pantallas, sin
  gating por rol ni por tipo de cliente) y la pérdida de un atajo de
  lectura (el guard corre antes de la idempotencia de `requestInvoice()`).
  Origen: `pendientes-2026-09-12.md`.

- **`CITY-LEDGER-GUARD-INVOICE-INFLIGHT-001` -- decisión del dueño tomada
  y extensión implementada, commit `b09555a` (13/09/2026, gate
  `architecture-governor`).** El guard de `transferStayBalanceToReceivable()`
  (Bloque 6, §9.1, commit `d75296a`) solo bloqueaba sobre
  `linkage.kind === 'ISSUED'`. El guard hermano de reservas
  (`ReservationService.findBlockingInvoiceLinkage()`,
  `reservas/reservation.service.ts:864-875`) también bloquea cuando el
  comprobante está EN VUELO -- `NOT_ISSUED` con `status: 'PENDING'`, o
  `FAILED_UNCERTAIN` con `afipContacted: true` (AFIP contactada, resultado
  incierto). Asimetría encontrada por el gate al cerrar §9.1, registrada
  como "requiere decisión del dueño". El dueño decidió (`AskUserQuestion`,
  13/09/2026): extender el guard de §9.1 para que también bloquee esos 2
  casos, igual que el guard hermano.
  Mecanismo: mismo predicado exacto que el guard hermano, sin `classify*`
  para la rama en vuelo (no hay nada que reconciliar sobre un comprobante
  que ni siquiera se sabe si AFIP emitió). `REJECTED` nunca bloquea, ni
  acá ni en el hermano. `StayChargeAlreadyInvoicedError` amplió su
  constructor con un 3er parámetro (`invoiceStatus`, unión angosta) --
  el mensaje del caso `ISSUED` se conserva verbatim (ya shippeado, visible
  tal cual al staff), se agregó uno nuevo para el caso en vuelo.
  Efecto colateral positivo, verificado por el gate: para cargos ligados a
  una reserva, el mismo lock de `reservations` que el guard ya toma ahora
  también serializa contra la ventana committeada en la que
  `InvoiceService.requestInvoice()` deja la factura en `PENDING` mientras
  espera la respuesta de AFIP -- cierra buena parte del residuo de
  concurrencia de §9.1 para ese camino (orden y solo-estadía siguen igual,
  sin ese lock).
  6 tests nuevos, mutación verificada dos veces: (1) borrar la rama nueva
  pone en rojo exactamente los 3 tests que dependen de ella, los otros 37
  quedan verdes; (2) hardcodear el 3er argumento a `'ISSUED'` pone en rojo
  exactamente el test que assertea el mensaje de `FAILED_UNCERTAIN`, los
  otros 39 quedan verdes. `FakeInvoiceRepository` sin cambios -- ya
  soportaba `NOT_ISSUED`. Suite completa 2184/2184 (163 archivos, +6),
  integración 304/304 sin cambios, `tsc --noEmit` y `lint:arch` limpios.
  **De paso, `CITY-LEDGER-GUARD-INVOICE-MISMATCH-001` (R3) se angostó** a
  la rama `ISSUED` solamente -- en la rama nueva `NOT_ISSUED` el
  `invoiceId` y el `status` del mensaje salen del MISMO
  `resolveInvoiceLinkage()` que decidió bloquear, no hay mismatch posible
  ahí.
  **Residuo NO resuelto acá** (seguía abierto al momento de este commit,
  `b09555a`): `CITY-LEDGER-GUARD-INVOICE-INFLIGHT-VERIFY-001` -- cero
  cobertura de integración contra Postgres real para el predicado nuevo, y
  la carrera real contra un `requestInvoice()` concurrente sin probar.
  **Confirmado más abajo en este mismo archivo, commit `ea3e4a1`** -- ya
  no vive en `docs/pendientes-2026-09-12.md`. Origen: `pendientes-2026-09-12.md`.

- **`CITY-LEDGER-GUARD-INVOICE-ORDER-OPEN-001` -- decisión del dueño tomada
  y expuesto (no bloqueado), commit `bc5cb46` (13/09/2026, gate
  `architecture-governor`).** Dirección inversa de §9.1: el lock de
  `reservations` que toma `transferStayBalanceToReceivable()` solo cierra
  la carrera cuando `requestInvoice()` corre PRIMERO -- si la
  transferencia corre primero (crea el `PAYMENT` del huésped + `CHARGE`
  de la empresa + AR, commitea) y DESPUÉS alguien pide facturar
  individualmente ese mismo cargo del huésped, `requestInvoice()` no
  tenía ningún guard ni señal que lo mirara. El dueño decidió
  (`AskUserQuestion`, 13/09/2026, "Exponer, no bloquear"): no agregar un
  guard que bloquee la emisión -- agregar un campo aditivo opcional que
  la exponga para revisión manual de management, mismo patrón que §9.2
  (`AccountReceivableMarkCollectedResult`).
  Mecanismo: `RequestInvoiceResult extends Invoice { accountsReceivableWarning?:
  AccountsReceivableWarningEntry[] }`, un método privado nuevo
  (`resolveAccountsReceivableWarning()`) que consulta
  `accountsReceivableRepo.getByStayId()` (Pick del constructor ampliado),
  filtra `status !== 'REVERTIDO'` y normaliza a `undefined` -- nunca `[]`
  -- cuando no hay nada que revisar (la presencia de la clave es la
  señal, verificado con `'accountsReceivableWarning' in invoice`).
  Acotado a Factura B: devuelve `undefined` de entrada para
  `tx.type IN ('REFUND', 'ADJUSTMENT')`, porque `requestInvoice()` tiene 4
  call-sites de producción dentro de los 2 orquestadores de NC que YA
  calculan y exponen este mismo warning por su propio camino (§9.2) --
  sin el scoping, el campo aparecería duplicado en el mismo payload HTTP,
  rompiendo el contrato de §9.2 ("presente si y solo si hay algo que
  revisar"). Verificado por revisión de código, no solo por el `if`:
  entre la resolución de `tx` y el merge final de `requestInvoice()` hay
  un solo otro `return` (el fork NC) -- no queda camino que calcule el
  warning y lo tire, ni que lo omita debiendo exponerlo.
  6 tests nuevos (89/89 en el archivo, suite completa 2190/2190, +6), 2
  rondas de mutation testing (comentar el scoping de NC rompe
  exactamente los 2 tests NC; comentar la normalización `undefined`-vs-`[]`
  rompe exactamente los 2 tests "sin warning"). `tsc --noEmit` y
  `lint:arch` limpios. Gate de diseño: HOLD -> 2 correcciones aplicadas
  (scoping NC; gap de `retryExisting()` registrado como pendiente en vez
  de cerrado). Gate de cierre: APPROVED WITH CONDITIONS -- los 2 spies de
  `logger.warn` en los tests nuevos ahora se restauran con
  `mockRestore()`, para no filtrar el stub al segundo `describe`
  top-level del mismo archivo (`invoice.service.test.ts:1937`).
  **4 residuos NO resueltos acá, con su ancla, en
  `docs/pendientes-2026-09-12.md` sección `## 🔍 Verificaciones
  pendientes`:** `CITY-LEDGER-GUARD-RETRY-EMITS-001` (el fast-path
  idempotente de `requestInvoice()` puede emitir una factura real sin
  warning ni log en ciertos estados previos),
  `CITY-LEDGER-GUARD-INVOICE-EMIT-VERIFY-001` (sin cobertura de
  integración contra Postgres real ni e2e HTTP),
  `CITY-LEDGER-GUARD-NO-UI-SURFACE-001` (0 consumidores en
  `appfrontend-main/src` para `accountsReceivableWarning`, tanto en §9.2
  como en §9.4), y `CITY-LEDGER-GUARD-AR-VIVA-PREDICATE-TRIPLE-001` (el
  predicado "AR viva" escrito 3 veces, sin extraer a un helper
  compartido). Origen: `pendientes-2026-09-12.md`.

- **`CITY-LEDGER-GUARD-INVOICE-INFLIGHT-VERIFY-001` -- confirmado contra
  Postgres real, commit `ea3e4a1` (13/09/2026, gate
  `architecture-governor`).** Residuo de verificación de
  `CITY-LEDGER-GUARD-INVOICE-INFLIGHT-001` (§9.1, commit `b09555a`): ese
  bloque extendió el guard de
  `AccountsReceivableService.transferStayBalanceToReceivable()` para
  bloquear también sobre un comprobante EN VUELO
  (`NOT_ISSUED`/`PENDING`, o `FAILED_UNCERTAIN` con `afipContacted`),
  pero toda la evidencia era unitaria contra `FakeInvoiceRepository`.
  5 tests nuevos en `accounts-receivable-invoice-linkage.integration.test.ts`,
  corridos contra Postgres real con
  `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run --config vitest.integration.config.ts src/tests/integration/accounts-receivable-invoice-linkage.integration.test.ts`
  (el entorno de esta sesión sí tiene Postgres disponible -- la suite se
  salteaba en silencio por falta de esa variable, no por ausencia real
  del servidor; el config no-default es obligatorio, y `npm run
  test:integration` es ESE MISMO comando sin la variable -- hay que
  prefijársela igual, `TEST_DATABASE_URL=... npm run test:integration`,
  porque sin ella y fuera de CI `skipIfNoDb` saltea la suite en silencio,
  `src/tests/integration/helpers/db.ts`):
  `NOT_ISSUED PENDING` bloquea (conteo real de las 3
  escrituras que hace la transferencia -- `PAYMENT` del huésped, `CHARGE`
  de la empresa, fila de AR -- no solo ausencia de excepción);
  `FAILED_UNCERTAIN` + `afipContacted` bloquea; los 2 espejos
  (`FAILED_UNCERTAIN` sin contactar, `REJECTED`) NO bloquean y sí dejan
  las 3 escrituras; y un test de concurrencia real -- 2 conexiones del
  pool, una sosteniendo el mismo lock y orden que
  `InvoiceService.requestInvoice()` (`reservations FOR UPDATE` antes del
  INSERT en `invoices`, todavía sin commitear) mientras la otra intenta
  transferir, con un brazo de CONTROL sin ningún lock previo para
  distinguir "bloqueó por el `FOR UPDATE` real" de "algo más frenó la
  conexión" (mismo patrón que `for-key-share-lock-semantics.integration.test.ts`).
  17/17 en el archivo (12 preexistentes + 5 nuevos), suite unitaria
  completa 2190/2190 sin regresión, `tsc --noEmit` limpio.
  Gate: APPROVED WITH CONDITIONS -- 3 correcciones aplicadas: (1) ancla
  de línea corregida (el comentario citaba `invoice.service.ts:451-453`,
  desactualizado -- corregido a citar el método por nombre y
  comportamiento, no un rango de línea, mismo criterio que
  `SCHEMA-ANCHOR-DRIFT-001`); (2) el conteo de side-effects ahora incluye
  el `PAYMENT` del huésped (antes el título del primer test afirmaba "no
  crea PAYMENT/CHARGE/AR" pero solo se contaban `CHARGE`/AR); (3) 2
  limitaciones declaradas en el propio comentario del test de
  concurrencia -- la ventana de 600ms es un heurístico de reloj de pared
  (cómodo en Postgres local, al límite contra un `TEST_DATABASE_URL`
  remoto con latencia real) y la prueba solo aplica a cargos ligados a
  una RESERVA (`requestInvoice()` no toma lock de `reservations` cuando
  `tx.reservationId` es nulo -- superficie ya registrada y mitigada en
  `CITY-LEDGER-GUARD-STANDALONE-CHARGE-001`).
  Origen: `pendientes-2026-09-12.md`.

- **`CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`** — ✅ **RESUELTO (11/09/2026,
  gate `architecture-governor`, decisión del dueño; migrado a este archivo
  13/09/2026, commit `895586d`).** `customer.routes.ts`
  (portal de clientes) se monta en `app.ts:275`, **antes** del gate
  `tenantMiddleware` de `app.ts:345` — resolvía su pool directo y nunca
  llamaba `ensureTenantWorker`. Ese router SÍ inserta eventos de dominio
  (`SqlDomainEventRepository`, inyectado en `ReservationService`). Un
  tenant con tráfico ÚNICAMENTE de portal nunca despachaba sus eventos.
  Cierre: `customer.routes.ts` llama `ensureTenantWorker()` desde el mismo
  `router.use(...)` que ya resuelve `req.db` -- mecanismo simple elegido
  por el dueño entre 3 opciones presentadas (simple / barrido periódico de
  respaldo / solo en endpoints que escriben evento).
  **Costo real, corregido por el gate antes de la decisión final** (mi
  primera pregunta al dueño lo entendía mal -- decía "1 timer"): 
  `ensureTenantWorker()` arranca DOS timers por tenant, no uno --
  `OutboxWorker` 5s Y `ReservationHoldExpiryWorker` 60s
  (`outbox.registry.ts:134-143`) -- y la primera corrida del segundo en un
  tenant portal-only barre TODAS las holds vencidas acumuladas de una vez,
  anulando las transacciones financieras asociadas. El dueño confirmó la
  opción simple igual, con el costo corregido sobre la mesa.
  **Corrección 11/09/2026 (gate `architecture-governor`, auditoría a
  posteriori de este commit)**: la afirmación original de esta entrada
  ("impacto medido hoy: 0, las 2 tenants reales ya tienen tráfico de staff
  a diario") era una INFERENCIA desde el tráfico, no una medición del
  backlog real -- el gate marcó la diferencia como condición bloqueante
  antes de push/deploy, dado el efecto financiero irreversible. **Medido
  de verdad, read-only, antes de pedir push** (`SELECT COUNT(*) FROM
  reservations WHERE status = 'PENDING' AND deposit_due_by IS NOT NULL
  AND deposit_due_by < NOW()`, mismo predicado que
  `getPendingWithExpiredDeposit()`, `sql.reservation.repository.ts:290-298`):
  **0 holds vencidas en Demo** (Neon `ancient-king-17098519`, branch
  `production`/`br-snowy-tree-ax5wmq70`) **y 0 en Hotel los Álamos**
  (branch `tenant-hotel-los-alamos`/`br-square-leaf-axzvu903`), medido
  11/09/2026 ~09:46 UTC. Ahora sí es medición, no inferencia -- el primer
  arranque de `ReservationHoldExpiryWorker` vía el nuevo call site del
  portal es inocuo en las 2 tenants reales hoy.
  Idempotente por diseño (`workers.has(businessId)`) -- el segundo caller
  (portal o staff, el que llegue después) es un no-op. Tests: 2 nuevos en
  `customer.routes.test.ts` (el middleware `router.use` no lo camina el
  helper `runRoute` existente -- hay que ubicarlo por contenido de
  `.handle.toString()`, no por posición) + evidencia de mutación (sacar la
  línea nueva pone en rojo exactamente esos 2 tests, aplicada y revertida
  sin commitear). Comentarios stale corregidos en `outbox.registry.ts`
  (4 lugares que asumían `tenantMiddleware` como único caller).
  Origen: `pendientes-2026-09-12.md`.

- **"La bandeja" de facturas no conciliadas — IMPLEMENTADO, PUSHEADO Y
  DEPLOYADO en producción, verificado** (10/09/2026, gate
  `architecture-governor`, migrado a este archivo 13/09/2026). Parte del
  bloque `credit_note_request` la TABLA que SÍ se resolvió, sin tabla
  nueva -- la tabla en sí sigue en HOLD, decisión del dueño sin cambios
  (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5/§10
  fila 1), ver ese ítem en `docs/pendientes-2026-09-12.md`.
  `49372b0` (implementación) → `65f9c45`
  (C1+C2 del gate: rename `TERMINAL_SIN_REVERSION` →
  `TERMINAL_CON_COMPROBANTE_VIVO` + docblock de falso negativo conocido)
  → deploy `dep-dahjrgu1egvs738b71u0` = `live`, `GET /api/invoices/unreconciled`
  confirmado montado en producción (401 sin auth, no 404).
  Grounding ERP (Odoo `TransientModel` + ERPNext `docstatus=0`, 2 de 3,
  confirman que el HOLD de la tabla era correcto) → decisión del dueño:
  nombrar mejor el estado intermedio que ya existe, sin tabla.
  `InvoiceRepository.listUnreconciledLiveInvoices()` (mecanismo de dos
  pasos: enumera candidatos B1∪B2, clasifica con
  `classifyOrderLiveInvoice`/`classifyReservationLiveInvoice` -- ya
  existentes, cero SQL de compensación nuevo, una sola fuente de verdad
  de "¿está conciliado?") + `GET /api/invoices/unreconciled`
  (`Roles.FRONT_DESK`, sin gate de módulo, registrada ANTES de `/:id`).
  Tipo `UnreconciledLiveInvoice` (`invoice.entities.ts`). Bug real
  encontrado por el propio test de integración antes de cerrar: la
  primera versión emitía una fila `TERMINAL_SIN_REVERSION` falsa para
  candidatos que habían entrado SOLO por B2 (reserva activa, no
  terminal, con una reversión abierta) -- corregido con un segundo gate
  `isTerminal` explícito en el paso 2/3, que resultó ser el guard de
  corrección real (verificado por mutación: sacar el filtro de estado
  del paso 1 -- la enumeración de candidatos -- queda VERDE, es solo una
  optimización de performance ahora; forzar `isTerminal = true` sí
  rompe 2 tests, ese es el mutante que importa). 8 tests de integración
  contra Postgres real (Neon), lado RESERVAS -- lado ORDER sin cobertura
  directa, declarado (mismo query shape, mismo classify() reusado,
  riesgo bajo pero no cero). Artefactos RBAC actualizados:
  `EXPECTED_AUTHORIZE_CALL_SITES` 206→207,
  `EXCLUDED_FILES['facturacion/invoices.routes.ts'].hiddenCount` 8→9,
  fila + contador de `docs/rbac-matriz-endpoints.md`,
  `docs/inventario-rutas.md` regenerado (251→252). Hallazgo de paso,
  registrado en "Menores": `generate-route-inventory.ts` conectó contra
  la BD de plataforma real al regenerar el inventario (docblock dice
  "dummy", `.env` local ganó) -- sin escritura real, verificado.
  Origen: `pendientes-2026-09-12.md`.

- **`OUTBOX-RETRY-HIST-01` + `OUTBOX-BACKOFF-01`** — ✅ **PUSHEADO Y
  DEPLOYADO en producción, verificado** (5 rondas de gate
  `architecture-governor`, 10/09/2026; `app-main` `5f31533` observabilidad
  + `b1e9705` backoff + `a56864c` cobertura de `first_failed_at` +
  `8fb9f5e`/`4bf269a` docs; migrado a este archivo 13/09/2026). Diseño
  completo en
  `docs/diseno-outbox-backoff-2026-09-10.md`. `domain_events` gana
  `first_failed_at`/`last_failed_at` (schema v48); `getPending()` excluye
  eventos en backoff (escalón 5s/30s/120s/300s según `retry_count`,
  aprobado por el dueño; `maxRetries` se mantiene en 60).
  **Verificado en producción (10/09/2026):** deploy `dep-dahll9rtqb8s73c4650g`
  = `live` en commit `4bf269a`; log de build confirma
  `[migrate-tenants] 2/2 OK, 0 fallo(s)` (`biz-demo-01` y
  `cd6cd508-...` migrados a v48, no inferido de un build verde); columnas
  `first_failed_at`/`last_failed_at` confirmadas `timestamp with time
  zone` en las 2 branches de tenant (Neon `ancient-king-17098519`);
  `businesses.schema_version = 48` en las 2 filas (Neon
  `morning-unit-50056927`); `/health/db` → `connected`. Backups
  pre-deploy tomados antes de pushear:
  `respaldo-pre-outbox-backoff-v48-2026-09-10` (Demo) y
  `respaldo-hotel-pre-outbox-backoff-v48-2026-09-10` (Hotel los Alamos),
  ver `docs/conocimiento/runbook-deploy-render.md`. Bug real encontrado y corregido ANTES de
  tocar código (ronda 2 del gate): el guard original de `first_failed_at`
  (`CASE WHEN retry_count = 0`) se hubiera roto con `retryDeadLettered()`
  (que resetea `retry_count`), pisando el dato en la falla siguiente a
  cualquier reintento manual -- corregido a `CASE WHEN first_failed_at
  IS NULL`. 38/38 tests de integración contra Postgres real, incluida la
  verificación de que el guard corregido discrimina de verdad (mutación
  aplicada y revertida, no commiteada).
  - **Nota de proceso (ronda 4 del gate):** la matriz de impacto original
    contaba "3 secuencias" de tests de integración necesitando ajuste por
    backoff; al implementar aparecieron 4 (el test de claim/release
    también dispara 2 polls consecutivos sobre el mismo evento fallido).
    El gate lo revisó explícitamente y lo calificó **no material** —no
    ameritó volver a HOLD— por 4 motivos: (1) es un recuento mal hecho
    DENTRO de una ubicación ya identificada en la matriz, no una
    ubicación nueva; (2) lo detectó un mecanismo determinístico (la suite
    se puso roja), no suerte; (3) solo afecta código de test, sin
    consumidor de producción ni contrato ni schema; (4) se declaró en el
    mensaje del commit y en el reporte al gate sin que se pidiera.
    Precedente registrado para la próxima vez que la razón "total pasó a
    ser N+1, es solo un test" se use para no escalar -- compararla contra
    este caso, no re-argumentarla de cero.
  Origen: `pendientes-2026-09-12.md`.

- **3.3-d, residual 1 (consolidada-parcial)** — ✅ **RESUELTO (11/09/2026,
  gate `architecture-governor`, Commit A, `docs/diseno-33d-residuales-2026-09-11.md`;
  migrado a este archivo 13/09/2026)**.
  F4 pregunta por la factura ENTERA, la NC del escape es parcial por
  reserva. Cierre: clasificador por PAR `(invoiceId, reservationId)` en
  `classifyReservationLiveInvoice()` -- `resolveReservationPairAttribution()`
  usa `resolveRefundableForPair()` (BRUTO, `attributedTotal`, no NETO --
  ver docblock de `isReservationPortionFullyCompensatedByIssuedCreditNotes()`
  en `cancel-with-credit-note.ts`, la corrección del 10/09/2026 sobre NETO
  como denominador de PRORRATEO seguía vigente pero es una pregunta
  distinta de contra qué se compara el resultado) cuando la factura tiene
  `invoice_items` (`RESOLVED`); fail-back byte a byte al F4-factura-entera
  de antes cuando no (`BLOCKED`, Nivel A -- 9/11 facturas reales de la
  tenant Demo). Verificado contra el orquestador real, no solo SQL
  fabricado: `cancel-reservation-with-credit-note.integration.test.ts`,
  caso `C1(i)`, pasó de pinear `NOT_RECONCILED` a confirmar `RECONCILED`.
  Deja abierto, aparte, el residual simétrico del lado ÓRDENES -- ver
  `ORDER-CONSOLIDATED-PARTIAL-01` en `docs/pendientes-2026-09-12.md`.
  **PUSHEADO Y DEPLOYADO en
  producción, verificado**: commits `15f81ae` (código) + `f5947cc` (docs,
  registro del flake de harness encontrado al cerrar) pusheados
  11/09/2026 con autorización explícita del dueño; deploy
  `dep-dahmiau7bikc73e8vffg` = `live` (finished 02:37:46Z); log de build
  confirma `migrate:tenants` -- `2 negocio(s) con BD asignada. Versión
  objetivo: v48.` / `2/2 OK, 0 fallo(s)` (esperado: sin cambio de schema,
  la versión objetivo no se movió); `GET /health/db` = 200 post-deploy.
  Origen: `pendientes-2026-09-12.md`.

- **3.3-d, residual 2 (reserva con `PAYMENT` propio)** — ✅ **RESUELTO
  (11/09/2026, gate `architecture-governor`, Commit B, commit `cb8682c`;
  migrado a este archivo 13/09/2026)**.
  `esComprobanteVivoConCoRechazosBenignos()` (`outbox.handlers.ts`) --
  allowlist positivo (`CO_RECHAZOS_BENIGNOS_SI_RECONCILIADO = {TIPO_NO_LIQUIDABLE}`)
  compartido por los 3 call sites reales (`handleReservationCancelled`,
  `handleOrderCancelled`, dentro de `registrarDesenlace()` -- eran 3, no 2
  como decía la corrección anterior de este ítem). `CARGO_ANULADO` queda
  FUERA a propósito (contador agregado, no distingue fila anulada = fila
  viva de dos filas distintas). 8 tests nuevos + evidencia de mutación
  (revertir solo 1 de los 3 call sites al exact-match viejo pone en rojo
  exactamente los 2 tests de ese handler, aplicada y revertida sin
  commitear). Sin casos reales todavía (0/15 medición previa) -- el cierre
  es preventivo, no reactivo a un incidente. **PUSHEADO Y DEPLOYADO en
  producción, verificado**: commits `63e8d29`+`cb8682c`+`f5b1369`
  pusheados 11/09/2026 con autorización explícita del dueño; deploy
  `dep-dahrak1srm7s73d71sgg` = `live` (finished 08:02:32Z), instancia
  nueva `srv-d8tdt41kh4rs73buo5ng-cp4tr` (distinta de la vieja `-5h6xc`,
  confirma que no es un healthcheck sirviéndose desde el proceso viejo);
  log de build confirma `migrate:tenants` -- `2 negocio(s) con BD
  asignada. Versión objetivo: v48.` / `2/2 OK, 0 fallo(s)` (esperado: sin
  cambio de schema en ninguno de los 3 bloques); `GET /health/db` = 200
  post-deploy. Bloque 3 verificado además contra Postgres real antes del
  push (no solo tsc): 19/19 tests de integración en 3 suites reales
  (incluida la que había dado el flake) con la firma nueva de
  `dropTestDatabase()`.
  Origen: `pendientes-2026-09-12.md`.

- **`EVT-ORF-01`** — ✅ **CERRADO SIN HANDLER (11/09/2026, decisión del
  dueño, grounding ERP: Cloudbeds/Odoo/ERPNext/QloApps vía
  `auditor-circuitos-erp`, gate `architecture-governor` APPROVED WITH
  CONDITIONS; migrado a este archivo 13/09/2026).** `reservation.expired`
  se emite y ningún handler lo
  escucha -- reverificado, sigue siendo cierto:
  `reservation-hold-expiry.worker.ts:127` emite el evento;
  `src/workers/outbox.handlers.ts` no tiene ninguna mención de ese
  `eventType`; se descarta en silencio, por diseño del worker (el propio
  test de `outbox.worker.test.ts:626-627` documenta que un evento sin
  handler "no debe trabar la cola" como comportamiento esperado, no bug).
  **Decisión adoptada**: se queda sin handler dedicado, a propósito.
  Ningún sistema investigado con evidencia confirmada (Odoo, ERPNext,
  QloApps, Cloudbeds) dispara notificación obligatoria por defecto al
  vencer un hold sin seña -- Cloudbeds, el único 100% hotelero comercial
  del grupo y el más maduro, hace exactamente lo mismo que este repo:
  libera el hold y nada más (Courtesy Hold / calendar blocks). Ningún ERP
  investigado envía email automático al huésped por defecto en este caso
  (donde existe, es opt-in/configurable, no comportamiento de fábrica).
  **Corrección del gate (11/09/2026) sobre una afirmación falsa de esta
  misma sesión**: se había dicho que el estado `EXPIRED` "ya es
  reportable" en el producto porque `Reservation.expire()` deja
  `status = EXPIRED`, distinto de `CANCELLED` (`domain/reservation.entities.ts:361`,
  terminal en `:85`). Cierto a nivel de dato, **falso end-to-end**:
  `appfrontend-main/src/lib/reservas/types.ts:1` (`ReservationStatus`) NO
  incluye `EXPIRED` -- solo 4 de los 5 valores del enum real del backend
  (`src/types/enums.ts:13`). Consecuencia real: una reserva `EXPIRED` se
  renderiza hoy en `dashboard/reservas/page.tsx` y `dashboard/turnos/page.tsx`
  con badge vacío y sin label (`STATUS_BADGE_CLASS`/`STATUS_LABEL` sin
  fallback, 9 sitios en 5 archivos -- `reservas/page.tsx`,
  `reservas/[id]/page.tsx`, `turnos/page.tsx`, `turnos/[id]/page.tsx`), y
  el filtro de estado (`ALL_STATUSES`, 2 archivos) no permite
  seleccionarlo. `dashboard/page.tsx:53` es el único sitio que degrada
  bien (`?? r.status ?? '—'`). Mismo patrón de drift cross-repo que
  `ROLES-CATALOG-DRIFT-001`. **No bundleado en este cierre, a propósito**
  -- el frontend se cerró aparte, ver la entrada
  `RESERVATION-STATUS-EXPIRED-FRONTEND-01` más abajo en este mismo
  archivo.
  Origen: `pendientes-2026-09-12.md`.

- **`RESERVATION-STATUS-EXPIRED-FRONTEND-01`** — ✅ **RESUELTO**
  (`appfrontend-main` `b38bce4`, 11/09/2026, gate
  `architecture-governor` APPROVED WITH CONDITIONS; migrado a este
  archivo 13/09/2026 — **pusheado**, confirmado ancestro de `origin/main`
  el 13/09/2026; el texto original decía "LOCAL/sin pushear", quedó
  stale). Alcance final, 6
  archivos + `globals.css` (más grande que el mapeo original de 4
  archivos -- el gate encontró 2 consumidores más):
  `lib/reservas/types.ts:1` agrega `'EXPIRED'`; `STATUS_LABEL`/
  `STATUS_BADGE_CLASS`/`ALL_STATUSES` en `dashboard/reservas/page.tsx`,
  `dashboard/reservas/[id]/page.tsx`, `dashboard/turnos/page.tsx`,
  `dashboard/turnos/[id]/page.tsx`; `STATUS_BADGE`/`STATUS_LABEL` en el
  portal de clientes (`cuenta/reservas/page.tsx`, `CANCELLABLE` dejado
  SIN `EXPIRED` a propósito). **El hallazgo más grave era
  `RoomCalendar.tsx`, no cosmético:** una reserva `EXPIRED` caía al
  fallback `STATUS_BAR_STYLE.PENDING` y se dibujaba en el tape chart como
  pendiente real, ocupando lugar que el backend ya trata como libre
  (`NON_BLOCKING_STATUSES`) -- corregido excluyéndola del `Record` y del
  filtro de `:214`. Badge nuevo `.badge-expired` (no reusa
  `badge-cancelled`, backend distingue los dos estados a propósito),
  compuesto solo con tokens existentes (`--surface-4`/`--border`/
  `--text-primary`), cero hex/Tailwind crudo. Verificado: `tsc --noEmit`
  limpio (con `node_modules` real instalado, no el ruido de módulos
  ausentes), `eslint` limpio, `npm run lint:visual` sin deuda nueva,
  25/25 tests unitarios sin regresión.
  **2 residuos NO resueltos acá:** captura de pantalla real con una
  reserva `EXPIRED` sin verificar, con ancla en
  `docs/pendientes-2026-09-12.md` sección `## 🔍 Verificaciones
  pendientes`; y `RESERVATION-STATUS-CROSSREPO-SYNC-001` (test que
  congele `ReservationStatus` entre los 2 repos, todavía sin construir
  -- no es una verificación de código listo, es ingeniería nueva, ver
  `docs/pendientes-2026-09-12.md` sección `### 🟡 Listo para encarar`).
  Origen: `pendientes-2026-09-12.md`.

- **Hueco de doble comprobante en `getInvoicedFinancialTransactionIds()`**
  -- ✅ **RESUELTO, PERO SOLO PARA LA DIRECCIÓN CONSOLIDADA↔CONSOLIDADA**
  (11/09/2026, gate `architecture-governor`, ronda 2: HOLD → APPROVED WITH
  CONDITIONS, cierre `FEATURE VERIFIED` -- no `GROUP VERIFIED`; migrado a
  este archivo 13/09/2026 — **pusheado y deployado**, commit `a36f877`
  confirmado ancestro de `origin/main`; el texto original decía "LOCAL,
  sin pushear ni deployar todavía", quedó stale). **No
  declarar cerrado el concepto completo** -- el propio cierre encontró una
  TERCERA dirección sin guardia, `INVOICE-CHARGES-GUARD-INDIVIDUAL-01`
  -- los 3 hallazgos de ese ítem ya cerraron (13/09/2026, ver más
  arriba en este mismo archivo). El propio
  `pendientes-2026-09-06.md` ya pedía que
  esto "mereciera fila propia" y nunca la tuvo; se perdió en el salto a
  `-08.md`, encontrado en la auditoría de arrastre del 11/09/2026.
  **Corrección del gate sobre el diseño propuesto originalmente en esta
  misma fila**: el fix planeado (`status = ANY(['ISSUED','PENDING',
  'FAILED_UNCERTAIN'])`, copiando la doctrina de `getInFlightCreditNoteTotalForUpdate()`)
  tenía un defecto material -- `REJECTED` quedaba afuera, pero
  `invoice_charges` NUNCA se borra sea cual sea el desenlace de la
  factura (verificado: 0 `DELETE FROM invoice_charges` en código
  productivo), así que una factura `REJECTED` seguía bloqueando el cargo
  para siempre vía `idx_invoice_charges_ft` (único, sin filtro de
  status) -- con el predicado propuesto, ese caso hubiera seguido dando
  un `23505` crudo en vez del error tipado, exactamente lo que el bloque
  decía cerrar. **Predicado final, recomendado por el gate**: sin `JOIN`
  a `invoices` ni filtro de status -- "¿existe la fila en
  `invoice_charges`?", la misma pregunta que responde el índice único.
  Cambios: `sql.invoice.repository.ts:964-974` (SQL) + su docblock en
  `invoice.repository.ts` (doctrina completa: por qué este método NO
  sigue el patrón de los otros dos que sí filtran por status) +
  `errors.ts` (mensaje de `AccountsReceivableAlreadyInvoicedError`,
  antes decía "ya facturados" -- exacto solo para `ISSUED`, corregido a
  "ya están vinculados a un comprobante") + `schema.sql:3211-3218`
  (comentario, **0 DDL**) + 2 comentarios en `invoice.service.ts`.
  **Verificado contra Neon, las 2 tenants reales, antes de tocar
  código**: `idx_invoice_charges_ft` confirmado único de verdad en las
  dos (`ancient-king-17098519`, branches `production` y
  `tenant-hotel-los-alamos`); 0 filas con `invoice_charges` fuera de
  `ISSUED` en las dos -- no hay inconsistencia retroactiva que limpiar,
  el fix es puramente hacia adelante. **Mutación verificada dos veces**
  (unit + integración): revertir el predicado a `status='ISSUED'` pone
  en rojo exactamente los 3 tests nuevos (`PENDING`/`FAILED_UNCERTAIN`/
  `REJECTED`) en las dos capas -- en integración contra Postgres real,
  el rojo es literalmente el `23505` crudo (`duplicate key value
  violates unique constraint "idx_invoice_charges_ft"`) que el gate
  predijo, no un fallo genérico. `npx tsc --noEmit` limpio, `npx eslint`
  limpio, suite unitaria completa 2092/2092 verde, 6/6 tests de
  integración de `consolidated-invoice-toctou.integration.test.ts`
  corridos de verdad contra Postgres real (no skipeados,
  `TEST_DATABASE_URL` presente). **Fuera de alcance, registrado, no
  resuelto en este bloque**: `docs/diseno-factura-borrador-2026-08-31.md`
  cita este guard con anclas de línea que ya se movieron -- deuda
  abierta, con su ancla propia, en `docs/pendientes-2026-09-12.md`
  (`FACT-BORRADOR-DESIGN-ANCHOR-DRIFT-001`).
  Origen: `pendientes-2026-09-12.md`.

- **`INTEGRATION-HARNESS-DROPDB-MASK-01`** — ✅ **RESUELTO (11/09/2026,
  gate `architecture-governor`, commit `63e8d29`; migrado a este archivo
  13/09/2026)**. `dropTestDatabase()`
  ensanchó su firma a `pool: pg.Pool | undefined` con guard-clause de
  retorno temprano -- ya no tapa el timeout real de `createTestDatabase()`
  con un `TypeError` de `pool.end()`. Test dedicado (`db.test.ts`, corre
  sin `TEST_DATABASE_URL`) confirma el guard. **No resuelve el huérfano
  real** -- ver `INTEGRATION-HARNESS-ORPHAN-DB-01`,
  `docs/pendientes-2026-09-12.md`, condición explícita del gate para no
  montarlo en el mismo commit.
  Origen: `pendientes-2026-09-12.md`.

- **`INVOICE-CHARGES-GUARD-FRONTEND-02` (Bloque 2)** -- ✅ **RESUELTO EN
  CÓDIGO, Commit 1 (backend) + Commit 2 (frontend)** (11/09/2026, gate
  `architecture-governor`, varias rondas; migrado a este archivo
  13/09/2026). Cruce de módulo (pregunta que
  quedaba abierta) resuelto por el dueño: el linkage SOLO se calcula/expone
  si el negocio tiene `FACTURACION` habilitado -- `GET /customers/:id/account`
  (`customers.routes.ts`) chequea el gate a nivel de route, sin tocar
  `CustomerAccountService` (se mantiene tenant-puro). Backend:
  `InvoiceRepository.getFinancialTransactionIdsCoveredByConsolidated()`
  (método NUEVO, deliberadamente separado de
  `getInvoicedFinancialTransactionIds()` -- reusar ese hubiera ocultado el
  botón también sobre una factura individual propia, regresión real
  encontrada por el gate en la primera ronda de diseño). Frontend:
  `FacturarButton` oculta el botón SOLO cuando el cargo está cubierto por
  una consolidada viva (`ISSUED`/`PENDING`/`FAILED_UNCERTAIN`, no
  `REJECTED`) -- los otros 3 estados (CAE+PDF, "Reintentar factura",
  "Facturación no habilitada") sin cambios, grounding ERP confirmó que ya
  eran correctos. **Estado -- corrección 11/09/2026, tarde (reconciliación
  cross-feature, encontrado sin actualizar tras el push)**: `app-main`
  `086b827` **y** `dd500a0` (docs de cierre) pusheados y deployados,
  verificados (`live`, `migrate:tenants` 2/2 OK, `/health/db` 200 en los
  dos). `appfrontend-main` `dde7837` **PUSHEADO Y DEPLOYADO, VERIFICADO**
  -- sin acceso a Vercel vía MCP esta sesión (`list_teams` vacío),
  confirmado bajando el bundle JS real de `host.zuluhub.com.ar` y
  greppeando: `"Facturado (consolidado)"` y `coveredByConsolidatedTransactionIds`
  presentes en el chunk servido. Confirmado además contra la BD de
  plataforma (Neon `morning-unit-50056927`) que Demo tiene `FACTURACION`
  habilitado de verdad (ejercita el camino nuevo) y Hotel los Álamos no
  (camino viejo, sin cambios) -- no se fabricó un JWT contra producción
  para probar la respuesta HTTP completa end-to-end, mismo criterio que
  `PRESET-SAVE-ECHO-001`.
  **1 residuo NO resuelto acá, con su ancla, en
  `docs/pendientes-2026-09-12.md` sección `## 🔍 Verificaciones
  pendientes`:** verificación visual en vivo del estado nuevo, no hecha
  -- 0 casos reales hoy en ninguna tenant para dispararlo, y escribir
  datos de prueba en una tenant compartida fue explícitamente rechazado
  por el gate (`irreversible-action-gate`). El `<span>` nuevo reusa
  byte-a-byte el mismo patrón de estilo que el estado "Facturación no
  habilitada" del mismo componente (ya probado en producción) --
  declarado como verificación de bajo costo, no como sustituto de
  haberlo visto en pantalla.
  Origen: `pendientes-2026-09-12.md`.

- **`PRESET-GROUP-VALIDATION-001`** — ✅ **RESUELTO en código, pusheado y
  deployado** (`app-main` `dc81a39`, gate `architecture-governor`
  09-10/09/2026, diseño + implementación + sign-off, los 3 con revisión
  separada; migrado a este archivo 13/09/2026 -- el texto original decía
  "LOCAL/sin pushear ni deployar" en la apertura pero el mismo bullet ya
  declaraba más abajo "Pusheado y deployado" con evidencia -- contradicción
  interna resuelta a favor de la evidencia real, verificado además con
  `git merge-base --is-ancestor dc81a39 origin/main`).
  `PUT /platform/role-presets/:name` y
  `PUT /platform/plan-limits/:plan` ahora validan `permissionGroups[]` /
  `allowedPermissionGroups` con `z.nativeEnum(Roles)` contra el catálogo
  real de `security/roles.ts` — un grupo mal tipeado o inexistente
  devuelve `400 VALIDATION_ERROR` (`error.middleware.ts:34`) en vez de
  guardarse. `allowedRoleNames` queda sin tocar a propósito (no tiene
  catálogo fijo: se compara contra `role.name`, y los roles pueden ser
  CUSTOM con nombre libre). 2 tests nuevos + mutation testing (revertir a
  `z.string()` pone en rojo la aserción del error capturado, no la del
  repo) + query read-only contra la BD de plataforma de producción (Neon
  proyecto `morning-unit-50056927`, base `pdb-ppms`, branch
  `br-royal-mouse-aybe2ai3` -- los tres identificadores de la MISMA BD,
  reconciliados 10/09/2026): 0 filas fuera de catálogo en
  `role_preset_permission_groups` ni `plan_limit_allowed_permission_groups`
  — el fail-loud no rompe nada existente. **Lo que sigue sin cerrar, a
  propósito:** `permission_group` sigue siendo `VARCHAR(50)` sin FK/CHECK
  en `platform.schema.sql` — SQL a mano contra la BD de plataforma
  saltea esta cerca por completo (cierto siempre, sigue así); es una
  cerca sobre el camino del panel, no sobre la columna. **Nota de
  vigencia**: al momento de este commit (`dc81a39`, 10/09/2026 mañana),
  SQL a mano era la ÚNICA vía de revocación documentada -- eso dejó de
  ser cierto esa misma tarde, cuando `PRESET-REVOKE-001` Parte 2
  (`e8f97db`, más abajo) agregó revocación real por panel
  (`updateRolePresetPermissionGroups()` propaga bajas, no solo altas). Pusheado y deployado, confirmado: `485b334`,
  Render `dep-dahaogmq1p3s73b1paa0` = `live`, `/health` con
  `uptimeSeconds` creciente = instancia nueva sirviendo.
  **1 residuo NO resuelto acá, con su ancla, en
  `docs/pendientes-2026-09-12.md` sección `## 🔍 Verificaciones
  pendientes`:** el `400` real contra estas 2 rutas en producción sigue
  siendo inferencia del `error.middleware.ts` global, no ejercitado
  end-to-end -- requiere credenciales de superadmin de producción, no
  disponibles en la sesión que cerró el bloque.
  Origen: `pendientes-2026-09-12.md`.

- **`PRESET-REVOKE-001`** — ✅ **RESUELTO ENTERO (Parte 1+2), PUSHEADO Y
  DEPLOYADO, VERIFICADO EN PRODUCCIÓN** (10/09/2026, gate
  `architecture-governor`, `2c1c7ff`+`e8f97db`+`43d1c00`+`ebf9d5e` en
  `app-main`, `0123129` en `appfrontend-main`; migrado a este archivo
  13/09/2026, mergeando 2 bullets del archivo de origen -- el estado
  final y la historia de diseño que llevó a él, antes separados en 2
  ubicaciones distintas). La mitad que había
  quedado abierta (revocar hacia negocios que ya tienen el grupo) se
  cerró en la misma sesión, no quedó para "un bloque futuro":
  - **CI**: job `integration` (el que ejercita el SQL destructivo de la
    Parte 2 contra Postgres real por primera vez, `vitest.config.ts`
    excluye esa carpeta del job `test`) -- ✅ `success`, run `34529816290`,
    junto con `test`/`schema-version-check`/`route-inventory-check`/
    `lint`/`typecheck`.
  - **Render**: deploy `dep-dahhlce417fc73dsisv0`, commit `ebf9d5e` =
    `live` (identidad del deploy confirmada por la API de Render, no
    solo `/health`).
  - **Post-deploy, read-only contra producción** (Neon
    `morning-unit-50056927`): 23 pares de catálogo intactos, 0
    divergencia en las dos direcciones entre `role_preset_permission_groups`
    y `role_permission_groups` de los 2 negocios -- el deploy no movió
    ni una fila, como se esperaba (nadie tocó un preset durante la
    ventana de deploy).
  - `git ls-remote` + `HEAD` local = `origin/main` en los dos repos,
    confirmado tras el push.
  - **Parte 1** (`2c1c7ff`) -- `RoleService.updatePermissionGroups()`
    ya NO permite customizar el set de permisos de un rol `isSystem` por
    negocio (reversión de R11, con fecha). 409, guard por cambio de set
    (no incondicional), 3 mutantes con sets rojos disjuntos.
  - **Parte 2** (`e8f97db`) -- `PlatformRepository.updateRolePresetPermissionGroups()`
    propaga altas Y bajas a TODOS los roles de sistema de TODOS los
    negocios, dentro de la MISMA transacción del PUT -- ya no depende
    del próximo arranque para ninguna de las dos direcciones. 2
    mutantes verificados contra Postgres real.
  - **Decisión de la ronda de cierre**: el reconcile de arranque (marca
    `platform_seed_markers` corriendo una sola vez) se SACÓ del alcance
    -- medido en producción (10/09/2026) que el stock de divergencia
    histórica era 0/0, así que con el guard de la Parte 1 puesto ese
    reconcile hubiera sido un `DELETE` destructivo de radio
    plataforma-completa que nunca ejecuta nada.
  - **Runbook actualizado** (`43d1c00`) -- recuperación de un preset
    vaciado por error reescrita para la propagación instantánea: vía
    normal usa `platform_audit_log.old_value` + re-guardar por el panel
    (sin reinicio, sin backup); break-glass SQL con verificación antes
    de `COMMIT` como último recurso.
  - **Cartel del frontend corregido** (`0123129`,
    `appfrontend-main/src/app/superadmin/roles-de-fabrica/page.tsx`) --
    ya no afirma lo contrario de lo que el botón hace; agrega la
    advertencia del escenario de lockout (vaciar `OWNER` sin
    `MANAGEMENT`) y muestra el radio real (altas/bajas propagadas) en
    el toast de guardado.
  - Re-medido en producción inmediatamente antes de este cierre
    (10/09/2026, Neon `morning-unit-50056927`): 0/0/0 en las 3 queries
    de divergencia -- ninguna migración de datos hace falta, el código
    nuevo empieza desde un estado ya consistente.
  - **Fix estructural pendiente, bloque aparte, no cerrado acá**: hay
    consumidores por nombre de `roles.name` en vez de por
    `role.id`/`is_system`. El guard de `renameRole()` (`8fc30c3`,
    bloque previo) cierra el camino que PRODUCE la divergencia; no
    cambia esa dependencia estructural. Anclas exactas y detalle
    completo ya trackeados aparte en
    `docs/pendientes-2026-09-12.md`, sección `### 🟡 Listo para
    encarar` ("Consumidores de `roles.name`..." -- no repetidas acá a
    propósito, para no arrastrar una segunda copia que pueda quedar
    desactualizada).

  **Historia de diseño (preservada como registro -- 2 rondas de `HOLD`
  del gate antes de llegar a la decisión de arriba):**
  **Corrección de una afirmación falsa que este bullet tenía en su
  momento**: `role.service.ts:182` NO bloquea editar
  grupos de permiso de roles `isSystem` -- esa línea vive dentro de
  `deactivateRole()` y bloquea DESACTIVAR, nada más.
  `RoleService.updatePermissionGroups()` (`:112-118`) sí permite editar
  qué puede hacer un rol de sistema (`OWNER`/`ADMIN`/etc.) por negocio,
  a propósito, según su propio docblock -- alcanzable por
  `PUT /api/roles/:id` (`roles.routes.ts:160`, sin guard de `isSystem`),
  soportado, con límite de plan y auditado en `audit_log`. El panel
  (`dashboard/roles/page.tsx`) lo oculta con "No editable" para roles de
  sistema, pero eso es UI, no un bloqueo real de la API -- confundir las
  dos cosas fue lo que produjo la afirmación falsa original.

  **Investigación ERP** (`auditor-circuitos-erp`, ERPNext/Odoo/QloApps):
  los 3 convergen en que revocar un permiso de una plantilla se propaga
  a quien ya la tenía asignada -- ninguno lo deja manual. Con esa
  evidencia, el dueño decidió alinear `app-main` al patrón de ERPNext
  (backfill simétrico: agregar Y quitar).

  **2 rondas de diseño, 2 `HOLD` del gate, cada una achicando el
  alcance real**:
  1. Diseño inicial (`DELETE` simétrico solo en el backfill) -- `HOLD`:
     el seed de 23 pares (`platform.schema.sql`, numeración
     PRE-`cd4dff6`) corre
     INCONDICIONALMENTE en cada arranque y repone cualquier par
     revocado por panel -- el `DELETE` hubiera sido inerte para toda la
     matriz de fábrica (los 23 pares cubren el 100% del default).
  2. Diseño con seed condicional ("solo si la tabla está vacía") +
     `DELETE` con guard -- `HOLD`: encontró que el guard por vacío es
     alcanzable desde el propio panel (guardar con el array vacío deja
     la tabla vacía, resucitando el seed) -- se corrigió a una tabla de
     "marcas de seed" (`platform_seed_markers`, gatea por clave, no por
     contenido). Pero **el hallazgo que bloqueó esta ronda es más
     grande**: `RoleService.updatePermissionGroups()` (arriba) es un
     escritor legítimo, soportado y auditado de `role_permission_groups`
     para roles de sistema, que la matriz de impacto original no había
     detectado -- un `DELETE` simétrico le borraría a cualquier negocio
     su personalización de rol de fábrica en el próximo reinicio del
     servidor, SIN rastro de auditoría de esa reversión (la
     personalización original sí quedó auditada).

  **Las 3 opciones que el gate presentó**: **(a)** agregar guard
  `isSystem` a `updatePermissionGroups()` en el mismo bloque -- destruye
  cualquier personalización de negocio existente sobre un rol de
  sistema; **(b)** preservarlas con una columna de procedencia nueva --
  cambio de schema más grande; **(c)** implementar SOLO la marca de
  seed, sin `DELETE`, dejando la revocación hacia negocios que ya tienen
  el grupo para un bloque futuro.

  **Decisión del dueño (09-10/09/2026)**: opción **(c)** primero --
  **implementar SOLO la marca de seed, SIN el
  `DELETE`, en ese bloque.** Cierra el bug real que motivó todo esto
  (editar un preset de fábrica por panel ahora persiste de verdad en el
  catálogo -- ya no hay resurrección del seed original en el próximo
  arranque) sin tocar ninguna personalización de ningún negocio. **El
  cierre de ARRIBA (Parte 1+2, misma sesión) resolvió la pregunta que
  quedaba entre (a) y (b): se midió 0 personalizaciones reales de
  negocio que destruir** -- con ese número, la opción (a) ("destruir",
  el guard `isSystem` de Parte 1, `2c1c7ff`) dejó de tener costo real y
  se implementó, cerrando la mitad que en su
  momento había quedado abierta sin la columna de procedencia nueva de
  (b).

  **Implementación de la marca de seed, pusheada y deployada**
  (`cd4dff6` + `18a3c93`, 09-10/09/2026 -- el texto original decía
  "LOCAL/sin pushear ni deployar", quedó stale; verificado 13/09/2026
  que los 2 hashes son ancestros de `origin/main`). Tabla
  `platform_seed_markers`
  + seed de los 23 pares gateado por marca (no por vacío). 7 tests
  nuevos en `platform-schema.integration.test.ts` (`describe` aislado,
  BD propia) + 2 mutation tests con conjuntos de rojo distintos, los 2
  revertidos. Verificado en producción antes de commitear: 23 pares
  intactos, `platform_seed_markers` todavía no existe -- el camino de
  upgrade real que prueban los tests es el que va a correr en el
  próximo deploy, sin ninguna revocación previa que revertir.

  **Hallazgos de la revisión de implementación, registrados en su momento:**
  - **Copy del frontend** -- ✅ **corregida** (`0123129`, ver "Cartel del
    frontend corregido" arriba). Quedó falsa entre el deploy de
    `cd4dff6` (marca de seed) y el de la Parte 2 -- corregida en la
    misma sesión en que la Parte 2 se implementó, no quedó pendiente
    entre sesiones.
  - **Negativo confirmado, no hacía falta corregir nada**: se verificó
    que el catálogo de 8 grupos del frontend (`roles-de-fabrica/page.tsx`,
    sin `EMISOR_NOTA_CREDITO`, `ROLES-CATALOG-DRIFT-001`) NO pierde ese
    9° grupo al guardar -- `handleSave()` manda el array completo
    cargado por el `GET`, `toggle()` solo agrega/saca la clave
    tildada. El 9° grupo sobrevive invisible, igual que antes de este
    bloque.
  Origen: `pendientes-2026-09-12.md`.

- **`PRESET-SAVE-ECHO-001`** — ✅ **RESUELTO en código, en 2 rondas,
  pusheado y deployado** (`51ea0dc` + `db04daa` + `fa50557`, gate
  `architecture-governor` 09-10/09/2026; migrado a este archivo
  13/09/2026). Render `dep-dahcnveq1p3s73dbdovg`
  en commit `fa50557` = `live`; `/health` con `uptimeSeconds` creciente
  entre dos muestras (133→136s), instancia nueva sirviendo. Ronda 1
  corrigió el eco del `PUT /role-presets/:name`
  (devolvía el input en vez de releer). El gate, aplicando por primera vez
  el §4.0 (gate de análisis de impacto, agregado a su propia definición
  esa misma sesión) sobre ESE fix, encontró que la ronda 1 releía por
  `this.db` (el POOL) en vez de por el `client` de la transacción externa
  que el único call-site real (`platform.routes.ts`) siempre pasa --
  bajo READ COMMITTED, esa lectura no ve el `DELETE`/`INSERT` sin
  `COMMIT` todavía y devuelve el estado ANTERIOR. Con la ronda 1 sola en
  producción: el superadmin tilda un grupo, guarda, ve "actualizado" en
  verde, y el checkbox se destilda solo en pantalla -- mentira en la
  dirección OPUESTA al bug original, y peor (el eco viejo al menos
  coincidía con lo pedido). **Segundo sitio con el mismo defecto,
  encontrado por el §4.0**: `updatePlanLimits()` (`platform.repository.ts`)
  -- el método usado como "ejemplo correcto" en la ronda 1 tenía el mismo
  problema (releía vía `listPlanLimits()` por el pool). Los dos corregidos
  en `db04daa`: `listRolePresets()`/`listPlanLimits()` ahora aceptan un
  `client` opcional, los `update*` pasan `externalClient ?? this.db`.
  4 tests con 2 fakes distintos (pool vs. client de tx, estados
  deliberadamente distintos entre sí y del input) + 2 mutantes verificados
  (eco del input, lectura por pool en vez de por client).
  **2 residuos NO resueltos acá:** (a) verificación funcional pedida por
  el gate (guardar un preset sin cambios y comparar `PUT` vs. `GET` tras
  recargar) no realizada -- requiere credenciales de superadmin de
  producción, no disponibles en la sesión que cerró el bloque, ancla en
  `docs/pendientes-2026-09-12.md` sección `## 🔍 Verificaciones
  pendientes`; (b) sin test de
  integración de estas rutas contra Postgres real -- la corrección queda
  demostrada por unit test + semántica documentada de READ COMMITTED, no
  por ejecución contra la BD real -- no es una verificación de código
  listo, es ingeniería nueva (un test que no existe), ancla en
  `docs/pendientes-2026-09-12.md` sección `### 🟡 Listo para encarar`.
  **Hallazgo de paso, NO parte de este ítem, ya trackeado aparte**
  (`docs/pendientes-2026-09-12.md`, `### 🟡 Listo para encarar`):
  `SqlReservationRepository.save()`/`syncLines` hace `DELETE` + loop de
  `INSERT` por el pool SIN transacción cuando se entra por `save()` en
  vez de por `saveWithClient()` -- mismo tipo de no-atomicidad que el
  Bug #5 del 27/08 ya cerró en otros sitios, pero éste quedó afuera.
  Observación menor, riesgo bajo, no accionada:
  `security/customer.auth.service.ts:87` devuelve `customer: {
  fullName: input.fullName, email: input.email }` tras el alta -- eco de
  input, pero fila única sin loop, blast radius chico.
  Origen: `pendientes-2026-09-12.md`.

- **`F5-01`/`D-03` — token CUSTOMER del portal alcanzaba 4 rutas mutantes
  de STAFF sin guard de ownership** (`docs/auditoria-integral-fase5-2026-09-15.md`
  §F5-01, `docs/auditoria-integral-fase15-2026-09-16.md` D-03) — ✅
  **RESUELTO EN CÓDIGO, gate-aprobado en 2 rondas por
  `architecture-governor` (16/09/2026), commit `668e16c`.**
  Decisión del dueño (P-01/D-03, `docs/decisiones-plan-integral-2026-09-16.md`):
  opción (a) de Fase 15 — rechazar tokens CUSTOMER en rutas de staff, **y**
  extender la protección por ACTOR, no por archivo. `tenantMiddleware()`
  (`src/platform/tenant.middleware.ts`) ahora responde `403 FORBIDDEN`
  deliberado para `role === CUSTOMER` ANTES de llegar a cualquier ruta de
  staff — cubre las 4 rutas del hallazgo original
  (`POST /api/reservations`, `POST /api/reservations/:id/schedule-request`,
  `POST /api/orders`, `POST /api/orders/:id/items`) y cualquier otra ruta
  de staff presente o futura montada después de ese middleware, sin
  necesidad de un guard por-ruta (opción "b" de Fase 15, descartada por el
  dueño por más frágil).
  **Investigación más profunda, a pedido explícito del dueño** ("estamos
  parados en una decisión de diseño, sé más profundo" — el gate, ronda 1,
  había encontrado que el mismo rechazo también afectaba a
  `GET /api/categories`/`GET /api/bookable-services`, rutas de staff con
  consumidor real en el portal, rotas 500 desde el 03/07/2026
  independientemente de este fix): la pregunta de fondo no era ambigua —
  el wizard "Nueva reserva" del portal necesita ese catálogo para
  funcionar. Se construyeron 2 endpoints dedicados
  (`GET /api/customer/categories`, `GET /api/customer/bookable-services`,
  `src/api/routes/customer.routes.ts`, mismo patrón ya establecido de
  `/me/reservations`) y se migró el único consumidor real
  (`appfrontend-main/src/lib/customerApi.ts`) a usarlos — el motivo
  original del 23/08/2026 que dejaba esas 2 rutas de staff sin
  `authorize()` para el portal ("el portal las necesita logueado") quedó
  reconciliado en los 3 artefactos que lo describían
  (`docs/rbac-matriz-endpoints.md:429`, comentario espejo de
  `categories.routes.ts`, `public-routes.fixture.ts`).
  **Verificado en este commit:** `tsc --noEmit`, `eslint --max-warnings 0`,
  `lint:arch`, suite unitaria completa (173 archivos, 2435 tests, incluidas
  las 7 cercas RBAC/arquitectura del repo — ninguna necesitó tocarse salvo
  el `hiddenCount` de `rbac-matrix-section2-sync.test.ts`, 7→9, esperado).
  **2 residuos NO resueltos acá — evidencia de runtime pendiente, no
  código pendiente:** (a) el test de integración reescrito
  (`src/tests/integration/customer-token-staff-route-ownership.integration.test.ts`,
  4 casos, assertan 403 + body exacto + cero escritura) nunca corrió
  contra Postgres real — sin `TEST_DATABASE_URL` en este entorno; (b) el
  wizard "Nueva reserva" del portal nunca se abrió con un cliente real
  para confirmar que el selector de categoría/servicio se llena — la
  afirmación "el wizard vuelve a funcionar" es lectura de código, no una
  corrida observada (mismo tipo de brecha que el caso real D6 ya citado
  en `CLAUDE.md` de este repo: "UI pura" declarado 3 veces sin haber
  mirado el runtime). Ambos residuos, con ancla y acción puntual, en
  `docs/pendientes-2026-09-12.md` sección `## 🔍 Verificaciones
  pendientes`.
  **No resuelto en este commit, declarado explícitamente como bloque
  siguiente obligatorio, no retirado:** la "capa 2" que la decisión del
  dueño pedía junto con el rechazo por actor — una cerca RBAC molde
  `ESCAPE_ROUTES` (`credit-note-escape-containment.test.ts`) que congele
  (i) que `tenantMiddleware` siga rechazando `role === CUSTOMER`, y (ii)
  que ningún mount `/api/*` que requiera contexto de staff se registre
  antes de `tenantMiddleware` sin allowlist con motivo — el gate (ronda 2)
  encontró que hoy hay 4 mounts así entre `authenticate()` y
  `tenantMiddleware` (`/api/companies`, `/api/auth`,
  `/api/business/modules`, `/api/business/plan-limits`), dos de los
  cuales (`/api/business/modules`, `/api/business/plan-limits`) no tienen
  ningún `authorize()` y SÍ son alcanzables hoy por un token CUSTOMER —
  hallazgo preexistente, no introducido por este cambio, registrado en
  `docs/pendientes-2026-09-12.md` como material de alcance para esa capa 2.
  Origen: `pendientes-2026-09-12.md`.

- **`CUSTOMER-RBAC-ACTOR-FENCE-001` — capa 2 de la decisión del dueño para
  P-01/D-03** (`docs/decisiones-plan-integral-2026-09-16.md:51`, textual:
  *"rechazar tokens CUSTOMER en rutas de staff … **y** extender la cerca
  por actor … las dos capas, no una sola"*) — ✅ **RESUELTO EN CÓDIGO,
  gate-aprobado por `architecture-governor` (16/09/2026), commit `c1777e5`.**
  Las dos assertions que la decisión pedía quedan cubiertas, cada una en
  su lugar — **declarado así a propósito, no en el mismo archivo**:
  - **(i) "`tenantMiddleware` sigue rechazando `role === CUSTOMER`"** —
    cubierta por comportamiento real, no por texto, en
    `src/platform/tenant-isolation.test.ts` (test `'un token CUSTOMER se
    rechaza con 403...'`, ya commiteado en `668e16c`). No se duplicó acá.
  - **(ii) "ningún mount `/api/*` que requiera contexto de staff se
    registra antes de `tenantMiddleware` sin allowlist con motivo"** —
    cubierta por `RBAC-MOUNT-002` (nuevo, extiende
    `src/tests/architecture/api-auth-gate-order.test.ts`, mismo archivo
    que ya tenía `RBAC-MOUNT-001` para el gate de `authenticate()`):
    verifica que todo mount `/api/...` anterior a `tenantMiddleware` esté
    en `PRE_TENANT_API_MOUNTS` (superset de `PRE_AUTH_API_MOUNTS`, +4
    entradas reales: `/api/companies`, `/api/auth`,
    `/api/business/modules`, `/api/business/plan-limits`), y que no haya
    entradas stale. Verificado por mutación (no solo lectura): copias de
    `app.ts` con un mount nuevo pre-`tenantMiddleware`, una entrada
    movida, y el gate renombrado — las 3 disparan la aserción
    correspondiente.
  **Verificado en este commit:** `tsc --noEmit`, `eslint --max-warnings 0`,
  `lint:arch`, suite unitaria completa (173 archivos, 2438 tests) —
  ninguna corrida depende de entorno real, así que **sin residuo de
  verificación** (a diferencia del resto de Wave 2, que sigue con 2
  residuos abiertos en `## 🔍 Verificaciones pendientes` — este commit no
  los toca).
  **2 hallazgos encontrados al construir esta cerca, registrados aparte,
  NO cerrados acá** (`docs/pendientes-2026-09-12.md`):
  `CUSTOMER-STAFF-MOUNT-PRE-TENANT-001` (evidencia corregida en este
  mismo commit de docs — `/api/business/modules` sin consumidor conocido,
  `/api/business/plan-limits` con consumidor real; cierre probable
  `Roles.STAFF`, no `MANAGEMENT`, decisión de RBAC aparte) y
  `CUSTOMER-PERMISSION-GROUPS-UNFENCED-001` (hallazgo nuevo: la zona
  pre-`tenantMiddleware` no tiene congelado qué grupo la protege —
  `CUSTOMER_PERMISSION_GROUPS` queda fuera de cobertura de
  `roles-catalog-sync.test.ts`, ver ese ítem para el detalle).
  Origen: `pendientes-2026-09-12.md`.

- **`5fb2487`** (Wave 1 / D-21) — ✅ **verificación contra Postgres real
  CONFIRMADA (17/09/2026, retrospectiva Waves 1-7, Postgres 16.13 local,
  no Neon).** `TEST_DATABASE_URL=... npm run test:integration` →
  `Test Files 49 passed (49)` / `Tests 383 passed (383)`, incluyendo
  `helpers/seed.test.ts` (2 tests, el caso que este ítem pedía: dos
  `seedResource()` sin `name` no colisionan con `uq_resources_name`).
  0 fallos — ninguna de las 227 fallas que D-21 (Fase 15) advertía que
  nadie podía asegurar quedó expuesta por esta corrida. Origen:
  `pendientes-2026-09-12.md`.

- **`668e16c`** (Wave 2 / P-01/D-03), mitad automatizada — ✅ **verificación
  contra Postgres real CONFIRMADA (17/09/2026, retrospectiva Waves 1-7).**
  `TEST_DATABASE_URL=... npx vitest run
  src/tests/integration/customer-token-staff-route-ownership.integration.test.ts`
  → 4/4 tests verdes: 403 FORBIDDEN con el body exacto
  (`{code: 'FORBIDDEN', ...}`) y cero escritura cruzada a nombre de B,
  para las 4 rutas mutantes originales de F5-01. **La mitad manual (abrir
  el wizard del portal en un browser real) sigue sin correr** — queda en
  `pendientes-2026-09-12.md`, no se cierra acá. Origen:
  `pendientes-2026-09-12.md`.

- **`4c4a17b`** (credenciales AFIP, F2-05+F2-06) — ✅ **verificación contra
  Postgres real CONFIRMADA (17/09/2026, retrospectiva Waves 1-7).**
  `TEST_DATABASE_URL=... npx vitest run
  src/tests/integration/afip-credentials-transactional.integration.test.ts`
  → 2/2 tests verdes: atomicidad real confirmada (rollback de las 2
  escrituras si falla una) y la fila de `audit_log` no contiene el valor
  del secreto. Origen: `pendientes-2026-09-12.md`.

- **`d5d27c4`** (auditoría de transiciones de reserva, D-10) — ✅
  **verificación contra Postgres real CONFIRMADA (17/09/2026,
  retrospectiva Waves 1-7).** `TEST_DATABASE_URL=... npx vitest run
  src/tests/integration/reservation.service.integration.test.ts
  src/tests/integration/cancellation-refund.integration.test.ts
  src/tests/integration/reservation-cancel-invoice-toctou.integration.test.ts`
  → 3 archivos, 44/44 tests verdes (22+19+3), incluyendo el caso TOCTOU
  real entre `cancelReservation()` y `requestInvoice()` sobre la misma
  reserva (RESERVA-10: `requestInvoice()` espera el lock y ve la reserva
  ya `CANCELLED` una vez liberado). Origen: `pendientes-2026-09-12.md`.

- **`CONFIG-ENV-BASELINE-001`** (Wave 7, gate `architecture-governor`
  condición C7, 16/09/2026) — ✅ **RESUELTO, no detectado como tal hasta la
  retrospectiva (17/09/2026, `auditor-estructura`, hallazgo 2a).** Las 2
  formas de `process.env` que la cerca de conteo no cubría al escribirse
  este ítem (`process.env[name]` con clave dinámica en
  `neon-provisioning.ts`, `process.env` como objeto completo en
  `docs-exposure.ts`) quedaron cerradas por el propio Wave 7 bloque 3
  (`0662053`): `requireEnv()` se movió a recibir el valor ya resuelto
  (`neon-provisioning.ts:65`, ya no lee `process.env`), y
  `process-env-usage-count.test.ts:68` extendió `PROCESS_ENV_RE` a las 3
  formas (literal, bracket, bare object). El ítem se había quedado
  citando su propia condición de bloqueo ("Bloqueante para el bloque 3")
  después de que ese bloque ya corriera y la resolviera — quedó abierto
  por descuido de bookkeeping, no porque el trabajo faltara. Origen:
  `pendientes-2026-09-12.md`.

- **`SCHEMA-VERSION-GATE-NOT-PERMANENT-001`** (ALTA, retrospectiva Waves
  1-7, 17/09/2026) — ✅ **RESUELTO EN CÓDIGO (opción A elegida por el
  dueño, 17/09/2026), verificado reproduciendo el bug original y
  confirmando que ya no ocurre, contra Postgres 16.13 real.** Los 5 gates
  `IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE version = N)` de
  `src/db/schema.sql` pasan a `IF (SELECT COALESCE(MAX(version), 0) FROM
  schema_migrations) < N THEN` — un tenant cuya versión más alta ya pasó
  el cutover nunca vuelve a correr el backfill, sin depender de que la
  fila `N` exacta exista. Los 5 (por nombre, no por línea — las líneas se
  mueven con cada edición del archivo; reproducible con `grep -n
  "COALESCE(MAX(version), 0)" src/db/schema.sql`, debe dar 5 hits): v42
  `resource_categories.is_exclusive`; v42
  `reservations.is_exclusive_resource`; v60 `reservation_lines` (F10-17);
  v60 `customer_rates.fixed_price→discount_percentage` (D-07/F10-02);
  v60 `invoices.afip_contacted` (F10-16).
  **Reproducción del bug ANTES del fix, confirmada por
  `erp-audit-orchestrator`:** tenant con `schema_migrations` sin la fila
  42 (simula `tenant-hotel-los-alamos`, aprovisionado después de que 42
  dejara de ser `CURRENT_SCHEMA_VERSION`) + categoría de alojamiento con
  `is_exclusive = false` + 2 reservas CONFIRMED solapadas en cupo
  compartido → redeploy → `ERROR: conflicting key value violates
  exclusion constraint "reservations_no_overlap_exclusive"` →
  `applyTenantSchema()` lanza → build de Render entero falla.
  **Mismo escenario DESPUÉS del fix (verificado, no solo argumentado):**
  BD con `schema_migrations = {60}` (sin 42, mismo tenant simulado),
  categoría `is_exclusive = false`, 2 reservas CONFIRMED solapadas →
  re-aplicar `schema.sql` completo (`applyTenantSchema()` real) →
  `REDEPLOY OK, version 60` — sin error. Confirmado además que no hay
  reversión silenciosa: `resource_categories.is_exclusive` siguió en
  `false`, `reservations.is_exclusive_resource` en ambas reservas siguió
  en `false`, `schema_migrations` quedó exactamente en `{60}` (sin
  duplicar la fila, `ON CONFLICT DO NOTHING` intacto).
  **Decisión de negocio aparte, también del dueño (17/09/2026):**
  `is_exclusive` NO se re-deriva de `is_lodging` después de creada la
  categoría — queda editable a mano vía `PUT /api/categories/:id`, sin
  ningún camino de sincronización automática posterior. Es el
  comportamiento natural del fix elegido (el backfill deja de
  re-ejecutarse una vez que el tenant pasa el cutover), no un cambio de
  código adicional.
  **Verificado:** `tsc --noEmit` limpio; `schema-line-anchor-drift.test.ts`
  verde (0 anclas de línea a `schema.sql` dentro de `src/`, cerca
  intacta); suite completa (175 archivos, 2441 tests, mismo conteo);
  `lint`/`lint:arch` limpios (312 módulos, sin violaciones); suite de
  integración contra Postgres real (49 archivos, 383 tests, incluyendo
  `reservations-unpaginated-limit` y los tests de D-07(c) que dependen
  del mismo `applyTenantSchema()`).
  **No resuelto en este bloque, opciones (B)/(C)/(D) descartadas por el
  dueño a favor de (A):** el resto del contenido de las opciones
  descartadas y la calificación sobre la opción (B) (colisión con la
  extracción de `tenant-provisioning.service.ts` en Wave 15) ya no
  aplican — se resolvió por (A). El paso operativo de re-correr las 2
  consultas read-only contra los 2 tenants reales inmediatamente antes
  del push sigue vigente igual (el fix reduce el riesgo, no reemplaza la
  verificación previa al push — que en este servicio es deploy) — ver
  `SCHEMA-VERSION-GATE-FIX-PRE-PUSH-VERIFY-001` en
  `docs/pendientes-2026-09-12.md`, sección `## 🔍 Verificaciones
  pendientes`, para el detalle completo.
  **2 riesgos residuales de la opción A en sí, no bugs, propiedades
  permanentes a tener presentes de ahora en más (declarados por el gate
  `architecture-governor`, 17/09/2026):** (1) `schema_migrations` pasa a
  ser la ÚNICA autoridad sobre si un backfill de datos corre — editarla a
  mano, o restaurar un snapshot de datos más viejo que su propio
  `schema_migrations`, ahora SUPRIME el backfill en silencio en vez de
  re-correrlo a los gritos (la dirección de falla se dio vuelta, de
  ruidosa a silenciosa); (2) todo gate de versión FUTURO debe usar
  `N == la CURRENT_SCHEMA_VERSION que se bumpea en el mismo commit` —
  este fix retira el único canario que avisaba de un gate mal numerado
  (`schema-redeploy-idempotent.integration.test.ts` ya no se pone rojo
  con un bump sin actualizar el gate correspondiente). Cerca de
  numeración de gates de versión = bloque siguiente, no decidido
  todavía. Origen: `pendientes-2026-09-12.md`.
