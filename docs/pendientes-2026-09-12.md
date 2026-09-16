# Pendientes — 12/09/2026

Fuente de verdad vigente (reemplaza a `pendientes-2026-09-10.md` como el
archivo que se lee al empezar la próxima sesión). Arrastra TODO lo que
seguía abierto ahí (mismo criterio que la transición 08-10→08-13):
contenido íntegro conservado más abajo, sin re-auditar cada ancla una
por una (eso excede lo que se puede hacer en una sesión) — solo la
sección nueva de arriba es de hoy, con ancla verificada.

**Actualización 12/09/2026, más tarde — sesión concurrente del Zuluhub
Test Orchestrator (`app-main-frontend-root/zuluhub-test-orchestrator/`,
sesión distinta a la que armó este archivo, sin gate `architecture-governor`
de este repo de por medio).** Ese archivo nuevo se creó arrastrando
`pendientes-2026-09-10.md` ANTES de que esta otra sesión le agregara
`CN-VOID-COREJECT-STALE-TEST-001` (bullet `1c-0` más abajo) -- las dos
sesiones corrieron en paralelo sobre el mismo repo sin saberlo, `git`
detectó la divergencia recién al pushear, reconciliado con un merge
normal (sin forzar nada, sin conflictos: tocaban archivos/secciones
distintos). Esta actualización propaga ese hallazgo acá para que no
quede huérfano en el archivo que dejó de ser "el de fecha más alta". No
se tocó ningún archivo de `src/` en esta actualización -- solo
documentos.

---

## 🔍 Verificaciones pendientes (código listo, falta confirmar en entorno real)

Distinto de "🔴 bloqueado en decisión" y de "🟡 listo para encarar": acá el
código ya está escrito, gate-aprobado y (cuando corresponde) commiteado —
lo único que falta es correrlo o medirlo contra algo que esta sesión no
tuvo disponible (Postgres real, un backend levantado, producción). Se saca
de acá (se corta, no se tacha) y recién ahí pasa a `docs/resuelto.md` con la
evidencia de la corrida, cuando alguien confirma el resultado real — no
cuando se pushea.

- **`5fb2487`** (Wave 1 / D-21, plan de ejecución integral, 16/09/2026) —
  `seedResource()` (`src/tests/integration/helpers/seed.ts:93`) ya no
  defaultea a `'Habitación 101'` fijo (colisionaba con
  `uq_resources_name`, schema v59) — ahora usa
  `` `Habitación ${randomUUID().slice(0, 8)}` ``, único por llamada.
  Gateado (`architecture-governor`, APPROVED WITH CONDITIONS, ambas
  cumplidas en el commit), típecheck/lint/lint:arch/suite unitaria
  verdes — pero **sin `TEST_DATABASE_URL` en este entorno, la corrida
  real contra Postgres (objetivo 382/0 — 380 del baseline de Fase 15 +
  2 tests nuevos de `helpers/seed.test.ts`) no se ejecutó.** Acción
  puntual: `TEST_DATABASE_URL=... npm run test:integration` y confirmar
  `Test Files … / Tests …` en 0 fallos. Si algo queda rojo, distinguir
  si es una falla NUEVA o una de las 227 que D-21 (Fase 15) ya advertía
  que nadie puede asegurar hoy (`seedResource()` tapaba el resto del
  `beforeAll` en 145/153 fallas medidas). **Relacionado con el ítem
  `073a8d4` de más abajo** (el mismo `uq_resources_name` nunca corrió
  contra Postgres real) — esta corrida, si sale verde, confirma también
  el `23505`/409 `RESOURCE_NAME_CONFLICT` de ese ítem en el camino feliz
  del seed, pero NO cubre el escenario que `073a8d4` pide (dos recursos
  con nombres normalizados iguales insertados a propósito) — no cerrar
  `073a8d4` solo con esta corrida, son pruebas distintas del mismo
  índice. Tampoco cubre F13-02 (una BD por archivo de test, resultados
  potencialmente order-dependent) — finding separado, sin bloque
  asignado todavía.
- **Fase 2 de la auditoría, 5 bloques (15/09/2026) — verificaciones contra
  Postgres real, ninguna corrida en este entorno (sin `TEST_DATABASE_URL`)**:
  - **`089ca3e`** (limpieza SSL/migraciones/PDF) — el cambio de SSL en los 3
    `pg.Client` (`tenant-db.setup.ts::applyTenantSchema()`,
    `company-sync.worker.ts`, `outbox-purge.ts`) no se verificó contra la
    flota real de tenants de producción — si algún tenant tiene un
    certificado que hoy no validaría con `rejectUnauthorized: true`, el
    cambio lo rompe. El dueño ya autorizó el cambio igual (decisión #4 de
    `docs/decisiones-auditoria-fase2-2026-09-15.md`). Acción puntual:
    confirmar contra la flota real antes del próximo deploy, o correr
    `npm run migrate:tenants` contra un tenant descartable con
    `NEON_SSL=true` primero.
  - **`073a8d4`** (unicidad de nombre de recurso, F2-13) — el índice único
    parcial `uq_resources_name` nunca corrió contra Postgres real; solo se
    ejercitó el catch del `23505` con un mock. Acción puntual: aplicar
    `applyTenantSchema()` contra un tenant de prueba, insertar dos
    recursos con nombres normalizados iguales, confirmar el `23505` real y
    el 409 `RESOURCE_NAME_CONFLICT` resultante.
  - **`4c4a17b`** (credenciales AFIP, F2-05+F2-06) — `afip-credentials-
    transactional.integration.test.ts` compila y se saltea limpio sin
    `TEST_DATABASE_URL`. Acción puntual: `TEST_DATABASE_URL=... npx vitest
    run src/tests/integration/afip-credentials-transactional.integration.test.ts`
    — confirmar la atomicidad real (rollback de las 2 escrituras si falla
    una) y que la fila de `audit_log` no contiene el valor del secreto.
  - **`d5d27c4`** (auditoría de transiciones de reserva, D-10) — las
    aserciones reales sobre `audit_log` (filas creadas, `changed_by`
    correcto, 0 filas si el guard RESERVA-10 tira) viven en
    `reservation.service.integration.test.ts`,
    `cancellation-refund.integration.test.ts` y
    `reservation-cancel-invoice-toctou.integration.test.ts`, con
    `skipIfNoDb`. Acción puntual: `TEST_DATABASE_URL=... npx vitest run
    src/tests/integration/reservation.service.integration.test.ts
    src/tests/integration/cancellation-refund.integration.test.ts
    src/tests/integration/reservation-cancel-invoice-toctou.integration.test.ts`.
  - **D-14 (contrato canónico de paginación, RESUELTO
    15/09/2026 — reemplaza el ítem anterior sobre `bf29137`/tope
    provisorio de 100 que estaba acá)** —
    `reservations-unpaginated-limit.integration.test.ts` sigue sin poder
    correr contra Postgres real en este entorno (sin `TEST_DATABASE_URL`).
    Ya no es "verificar un tope provisorio": ahora hay que confirmar el
    contrato canónico completo contra una base real —
    `limit`/`offset` (default 50 / tope 200 vía `resolveReservationsLimit()`,
    clamp-and-report, nunca 400), envelope SIEMPRE
    `{data, limit, offset, total, hasMore}`, y el desempate
    `ORDER BY ..., id [ASC|DESC]` en los 5 listados (reservations +
    orders/products/cash-register-shift/customers). Acción puntual:
    `TEST_DATABASE_URL=... npm run test:integration` (excluido de `npm
    test` por `vitest.config.ts`, corre solo por esa vía) y confirmar que
    `getFiltered({})` sin `limit`/`offset` devuelve exactamente 50 filas
    (`RESERVATIONS_DEFAULT_LIMIT`, no las 100 del tope provisorio
    anterior) contra Postgres real, no solo contra el repo in-memory (ya
    confirmado en verde). Confirmar también, sembrando filas con
    `start_time`/`opened_at`/`created_at`/`display_name`/`name` empatados
    a propósito, que el desempate por `id` evita duplicados/faltantes
    entre páginas (motivo del cambio: `erpnext#49037`, citado en el
    grounding de D-14, docs/decisiones-auditoria-fase2-2026-09-15.md #12).
  - **`dd48592`** (horizonte de ventana de mantenimiento en dos tramos,
    D-03) — el test de atomicidad (`maintenance-window.service.test.ts`,
    caso "(d) atomicidad") corre contra `InMemoryTransactionManager` (sin
    BEGIN/COMMIT/ROLLBACK real), no contra Postgres — confirma que el
    wiring usa una sola invocación de `transactionManager.run()`
    envolviendo ventana + reservas, pero no que Postgres revierta el
    INSERT de la ventana si el UPDATE de una reserva falla a mitad de
    camino. Acción puntual: agregar un test de integración que fuerce el
    fallo del UPDATE de `needs_maintenance_review` de una reserva del
    tramo incierto (hoy no existe uno — solo el mock) y confirmar que la
    ventana tampoco queda en la tabla `maintenance_windows`.

- **`credit_note_request` Bloque 5 -- reconciliación manual, verificación
  contra Postgres real pendiente** (15/09/2026, gate `architecture-governor`,
  APPROVED WITH CONDITIONS). Código completo, gate-aprobado: `authorizeAny()`
  nuevo, las 3 rutas (`GET /api/credit-note-requests`, `GET
  /api/credit-note-requests/:id`, `POST /api/credit-note-requests/:id/resolve`),
  `InvoiceService.resolveCreditNoteRequestManually()` (un solo
  `transactionManager.run()` para EMITIDA/NO_EMITIDA + transición), schema
  v58 (`invoices.uncertain_cleared_at`/`_by`). El gate re-corrió `tsc`/
  `lint`/`lint:arch`/`vitest run` completo (171 archivos, 2381 tests) y
  regeneró `docs/inventario-rutas.md` de verdad (byte-idéntico al commiteado,
  262 rutas) -- todo eso SÍ está confirmado. Lo que el gate declaró
  explícitamente NO poder confirmar en este entorno (sin `TEST_DATABASE_URL`):
  (1) atomicidad real BEGIN/COMMIT/ROLLBACK de
  `resolveCreditNoteRequestManually()` contra una tenant DB real -- el
  código de `PgTransactionManager` la garantiza por construcción, pero el
  test unitario con el fake in-memory no puede verificar el rollback real;
  (2) que la migración v58 (`ALTER TABLE invoices ADD COLUMN IF NOT
  EXISTS uncertain_cleared_at/_by`) se aplique limpio contra una tenant DB
  real -- no se corrió `npm run migrate:tenants`; (3) un smoke test HTTP
  real de las 3 rutas nuevas (el test de rutas invoca el handler extraído
  directo, no un server HTTP end-to-end). Acción puntual: correr `npm run
  test:integration` con `TEST_DATABASE_URL` configurada (mismo patrón que
  los ítems de City Ledger de esta misma sección), y `npm run
  migrate:tenants` contra un tenant de prueba real, antes de considerar
  Bloque 5 completamente verificado.
- **`CRASH-CUSTOMER-RATE-RENDER-01`** — abrir la ficha de un cliente con
  una tarifa especial scope `categoryId`/`bucket`/`productId` en un
  entorno real (los 3 scopes nuevos de D9), confirmar que
  `clientes/[id]/page.tsx` la renderiza sin crash. Commit `bbf98c0`
  (appfrontend-main).
- **`CITY-LEDGER-ORDER-GUARD-M3-INTEGRATION-VERIFY-001`** — el guard de
  re-verificación tx1→tx2 del escape de NC de órdenes (hallazgo M3,
  14/09/2026, gate `architecture-governor`, APPROVED WITH CONDITIONS)
  tiene código completo, gate-aprobado, y tests unitarios en verde -- pero
  **nunca corrió contra Postgres real**. Existe
  `src/tests/integration/cancel-order-with-credit-note.integration.test.ts`
  (`describe.skipIf(skipIfNoDb)`, 12 llamadas reales al servicio) pero
  `vitest.config.ts:17` excluye TODO `src/tests/integration/**` de `npm
  test` -- ese archivo no participa de la corrida estándar, necesita
  `npm run test:integration` con `TEST_DATABASE_URL` seteada, no
  disponible en este entorno. Sin evidencia real todavía: la conexión
  anidada dentro del lock (ver `CITY-LEDGER-AR-NESTED-CONN-001` instancia
  11 arriba), la re-entrancia del lock del puerto
  (`orderCancelPort.cancelForCreditNote`, misma fila, misma tx/conexión --
  el comentario del código afirma que Postgres la concede de inmediato,
  nunca verificado en runtime), y la concesión efectiva del lock bajo dos
  transacciones genuinamente concurrentes. Mismo atenuante que el ítem de
  arriba: el precedente de reservas (`CreditNoteReservationInvoiceSetChangedError`)
  tampoco tiene test de integración dedicado -- no es una regresión de
  este commit, es un residuo que ya existía del lado reservas y ahora se
  duplica del lado órdenes. Acción puntual: correr `npm run
  test:integration` con `TEST_DATABASE_URL` configurada, y agregar (o
  confirmar que ya cubre) un caso que emita una factura AFIP real en la
  ventana tx1→tx2 y confirme que `CreditNoteOrderInvoiceSetChangedError`
  dispara antes de comprometer la cancelación.
- **`CITY-LEDGER-REVERSE-ROUTE-GROUP-FREEZE-001`** — decisión diferida del
  ADR (§4.4, docs/diseno-reconciliacion-city-ledger-2026-09-12.md),
  encontrada sin resolver por el gate `architecture-governor` al revisar
  Bloque 3c-iii (14/09/2026). Los dos `authorize()` en cadena de
  `POST /api/accounts-receivable/:id/reverse`
  (`src/clientes-finanzas/accounts-receivable.routes.ts:99-100` --
  `authorize(Roles.MANAGEMENT)` + `authorize(Roles.EMISOR_NOTA_CREDITO)`)
  solo están protegidos por la cerca de CONTEO
  (`rbac-matrix-sync.test.ts::EXPECTED_AUTHORIZE_CALL_SITES`) -- esa cerca
  ve que HAY 2 `authorize()`, no CUÁLES grupos. Ninguna de las otras
  cercas RBAC cierra ese hueco: `rbac-route-coverage` solo exige "algún"
  authz; `rbac-matrix-section2-sync` no valida el grupo que cada fila
  declara (documentado como hueco conocido en `CLAUDE.md`, sección RBAC);
  y el archivo sigue en `EXCLUDED_FILES` de esa misma cerca (prosa, no
  bullets parseables). **Consecuencia concreta, verificada por el gate:**
  si alguien cambia `Roles.EMISOR_NOTA_CREDITO` por otro grupo cualquiera
  en esa ruta (ej. `Roles.ORDERS`), el conteo total no se mueve (sigue en
  209), `rbac-route-coverage` sigue verde (sigue habiendo 2 `authorize()`),
  y la fila de la matriz queda stale sin que nada avise -- las 7 cercas
  RBAC del repo quedan en verde mientras el escape fiscal de la reversa
  (la protección que exige el doble rol a propósito, §3.7 del ADR) queda
  abierto con un solo permiso. Mismo modo de falla, mismo remedio, que
  `CN-ESCAPE-CONTAINMENT-001` ya resolvió para las rutas de cancelación
  con NC (`ESCAPE_ROUTES`, congela el GRUPO exacto, no solo la cantidad)
  -- ese archivo (`credit-note-escape-containment.test.ts`) es el patrón a
  copiar cuando se encare este bloque. No resuelto acá -- bloque aparte,
  con su propio diseño (decidir si se extiende `ESCAPE_ROUTES` a esta ruta
  o se crea una cerca nueva específica de AND-composition).
- **`REPORTS-DATEONLY-MISMATCH-001`** — confirmar los 5 reportes de
  `reportes/page.tsx` contra un backend `app-main` real levantado (esta
  sesión solo validó el formato contra el regex de `dateOnlySchema`, sin
  entorno/credenciales disponibles). Commit `9d70b07` (appfrontend-main).
- **`PATCH-STATUS-EVICT-001`** — suspender un negocio de prueba y
  confirmar 403 `BUSINESS_INACTIVE` sin reiniciar el proceso (el test
  nuevo mockea `evictTenantPool`, no corre contra Postgres real). Commit
  `5c7bef9` (app-main).
- **`PRESET-GROUP-VALIDATION-001`, verificación end-to-end** (13/09/2026,
  split del ítem al migrarlo a `docs/resuelto.md`). El `400
  VALIDATION_ERROR` real de `PUT /platform/role-presets/:name` y
  `PUT /platform/plan-limits/:plan` contra un grupo de permisos inválido
  sigue siendo inferencia del `error.middleware.ts` global (`ZodError →
  400`, verificado por lectura, no ejercitado end-to-end) -- requiere
  credenciales de superadmin de producción, no disponibles en la sesión
  que cerró el bloque. Confirmar cuando esas credenciales estén
  disponibles.
- **`PRESET-SAVE-ECHO-001`, residuo (a)** (13/09/2026, split del ítem al
  migrarlo a `docs/resuelto.md`). Verificación funcional pedida por
  el gate (guardar un preset sin cambios y comparar `PUT` vs. `GET` tras
  recargar) no realizada -- requiere credenciales de superadmin de
  producción (`PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD`, `sync:
  false` en `render.yaml`), no fabricadas a mano para no autenticar
  contra producción con un secreto de origen incierto. Confirmar cuando
  haya credenciales de superadmin. (Residuo (b) del mismo split --
  agregar el test de integración que falta -- no es código listo
  esperando confirmación, es trabajo de ingeniería nuevo: reclasificado
  a `### 🟡 Listo para encarar`, mismo criterio que
  `RESERVATION-STATUS-CROSSREPO-SYNC-001`.)
- **`INVOICE-CHARGES-GUARD-FRONTEND-02`, verificación visual** (13/09/2026,
  split del ítem al migrarlo a `docs/resuelto.md`). El estado nuevo del
  `FacturarButton` ("cubierto por consolidada") nunca se vio en pantalla
  real -- 0 casos hoy en ninguna tenant para dispararlo, y fabricar datos
  de prueba en una tenant compartida fue rechazado por el gate. Confirmar
  cuando un caso real aparezca, o fabricando el escenario en una tenant
  de test dedicada.
- **Polling adaptativo — ahorro de compute sin medir.** El bloque 1
  (`6f1289a`+`02629b7`) está deployado y verificado en producción, pero el
  ahorro de compute en Neon que motivó el bloque sigue siendo inferido, no
  medido — falta correr 24-48h post-deploy y comparar actividad de compute.
- **Caso 3 — 2 integration tests reescritos sin correr contra Postgres
  real.** `reservation-price-adjustment-stay.integration.test.ts` y
  `cancel-order-with-credit-note.integration.test.ts` se reescribieron
  para afirmar el comportamiento nuevo de `getNetBalanceByStayId()`
  (incluye `PENDING`), pero `describe.skipIf(skipIfNoDb)` los saltea en
  este entorno (sin Postgres real disponible) — nunca corrieron de
  verdad. Acción puntual: correr `npm run test:integration` con
  `TEST_DATABASE_URL` configurada. Commit `ad28d2e` (app-main). También
  sin verificar: abrir `dashboard/estadias/[id]/page.tsx` con una
  estadía real con saldo pendiente y confirmar el flujo de
  `ConfirmDialog` de MANAGEMENT — commit `4cb5a04` (appfrontend-main).
- **Caso 6 residuo parte 2 — `schema.sql` completo (v51, guard
  `pg_constraint` en los 3 CHECK de `financial_transactions`) nunca corrió
  contra Postgres real en su orden real.** La validación de esta sesión
  fue sobre los 3 bloques nuevos aislados, en una `TEMP TABLE` descartable
  (Neon, rama `test-integration-db`, vía `run_sql_transaction`) — no sobre
  el archivo completo, de punta a punta, contra una BD (el camino real de
  alta de tenant, el mismo que ya rompió una vez el 25/08 — "relation
  products does not exist", comentado en `schema.sql:1035-1039`).
  `schema-redeploy-idempotent.integration.test.ts` es el harness que
  corresponde y quedó `describe.skipIf(skipIfNoDb)` (sin
  `TEST_DATABASE_URL` en este entorno) — no corrió. Acción puntual: correr
  `npm run test:integration` con `TEST_DATABASE_URL` configurada. **La
  otra mitad de este ítem (comparar las 3 definiciones contra las de
  `schema.sql` en cada tenant real) ya se cerró** — corrida el 12/09/2026
  contra Demo y Hotel los Álamos vía Neon MCP, las 3 coinciden exacto, sin
  colisión de nombre; ver `docs/resuelto.md`, entrada "Caso 6, residuo
  parte 2" — no se repite acá, este bullet queda acotado a la mitad
  todavía abierta (el archivo completo, de punta a punta). Commit
  `9b7296a` (app-main).
- **Caso 1 — purga del outbox: 7 tests de integración nuevos nunca
  corrieron contra Postgres real.** `purgeResolved()`
  (`sql.domain-event.repository.ts`) y el predicado de "resuelto"
  (incluye dead-letter, confirmado por el dueño) están cubiertos por
  `outbox-worker.integration.test.ts`, SECCIÓN 1-C (PENDING nunca se
  purga, resuelto dentro/fuera de ventana, dead-letter, el caso
  `retryDeadLettered()`, CASCADE de `processed_events`, caso límite
  `retentionDays=0`) pero `describe.skipIf(skipIfNoDb)` los saltea sin
  `TEST_DATABASE_URL` en este entorno. Acción puntual:
  `TEST_DATABASE_URL=... npm run test:integration -- outbox-worker`.
  También sin correr contra Postgres real (mismo motivo): el binding de
  parámetro `($1 || ' days')::interval` en `purgeResolved()` — patrón
  nuevo en este archivo (el precedente en `getPending()` usa una
  expresión computada, no un parámetro bindeado); se espera que
  resuelva sin problema (`unknown || unknown` → `text`), y si no, falla
  ruidoso en la primera corrida real, no en silencio. Introducido en el
  commit que sigue a `f2954d7` (app-main) — buscar el hash con
  `git log --oneline --grep "purga del outbox\|purgeResolved"` si hace
  falta citarlo desde otro documento.

- **`CITY-LEDGER-AR-WARNING-VERIFY-001`** — Bloque 6, §9.2 (13/09/2026,
  gate `architecture-governor`, commit `0f2aa24`): el warning
  `accountsReceivableWarning` de los 2 escapes de NC está cubierto por 6
  tests unitarios (fakes, sin BD) pero NUNCA se corrió contra Postgres
  real con una `accounts_receivable` de verdad (requiere seedear un
  check-in completo + `transferStayBalanceToReceivable()` + el escape de
  NC). Confirmar: seedear ese camino real en un test de integración y
  verificar que el campo llega correcto en la respuesta HTTP.
- **`CITY-LEDGER-AR-NESTED-CONN-001`** — deuda de clase, con ancla
  (Bloque 6, §9.2, 13/09/2026, gate `architecture-governor`): las 5
  lecturas de tx1 en `cancel-reservation-with-credit-note.service.ts`
  (`liveInvoiceIdsForReservation`, `getByIdempotencyKey`,
  `invoiceRepo.getById`, `getChargeIdsForInvoice`, y la nueva
  `accountsReceivableRepo.getByStayId()`) NO reciben `client` -- sacan una
  SEGUNDA conexión del pool del tenant (**corrección 14/09/2026, gate
  `architecture-governor`, ronda 4 de Bloque 3c-ii: el pool es `max: 10`
  por default -- `DB_POOL_MAX`, `db/pg.client.ts:94` -- no `max: 5` como
  decía este ítem hasta ahora**, `connectionTimeoutMillis: 5000`) mientras
  tx1 sigue abierta sobre la primera. Hoy no rompe nada (son de solo
  lectura, el pool falla ruidoso por timeout, no cuelga) pero es una clase
  de riesgo que crece con cada lectura nueva que se agregue de la misma
  forma. Candidato: convertir las 5 a `*WithClient()` (convención
  `createWithClient()` que el repo ya usa). Bloque aparte, no decidido
  cuándo.
  **Instancia 6 (gate ronda 4, 14/09/2026) -- ya shippeada, sin registrar
  hasta ahora:** `AccountsReceivableService.transferStayBalanceToReceivable()`
  (`accounts-receivable.service.ts:257-321`) ya llama a
  `this.invoiceRepo.resolveInvoiceLinkage(charge.id)` sin `client`, adentro
  de `transactionManager.run()` -- mismo patrón exacto, mismo riesgo, sin
  ancla en este ítem hasta esta corrección.
  **Instancias 7-10 -- shippeadas (Bloque 3c-ii, 14/09/2026, gate
  `architecture-governor`, implementación revisada en ronda de gate de
  implementación).** `AccountsReceivableService.reverseTransfer()`
  (código real ahora, `docs/diseno-reconciliacion-city-ledger-2026-09-12.md`
  §4.3) agrega CUATRO lecturas sin `client` dentro de la MISMA transacción
  que abre, no una sola -- corrección sobre el registro anterior de este
  ítem, que solo nombraba la del guard 8-bis:
  - **7.** `this.invoiceRepo.resolveInvoiceLinkage(charge.id)` (guard
    8-bis) -- corre siempre.
  - **8.** `this.financialRepo.getById(lockedAr.guestPaymentTransactionId!)`
    (lee el `PAYMENT` del huésped para el `customerId` de la pata
    huésped) -- corre siempre.
  - **9.** `this.stayRepo.findById(lockedAr.stayId, lockedAr.businessId)`
    -- solo en la rama `correctedBalance > 0`.
  - **10.** `this.businessProfileRepo.get()` (moneda) -- solo en la misma
    rama `correctedBalance > 0`.
  Mismo riesgo que las 6 anteriores (solo lectura, sin lock, el pool falla
  ruidoso por timeout, no cuelga) -- las 4 son secuenciales dentro de la
  misma llamada, así que no multiplican la concurrencia POR REQUEST, solo
  el número de lecturas nested que este ítem tiene que seguir contando.

  **Instancia 11 -- shippeada (hallazgo M3, 14/09/2026, gate
  `architecture-governor`, ronda de gate de implementación) -- CUALITATIVAMENTE
  DISTINTA de las 10 anteriores.** `cancel-order-with-credit-note.service.ts`,
  tx2 del escape de NC de órdenes: `liveInvoiceIdsForOrder(orderId)` (sin
  `client`) corre DENTRO de `transactionManager.run()`, DESPUÉS de
  `this.orderRepo.getByIdForUpdate(client, orderId)` -- a diferencia de las
  10 instancias anteriores (todas lecturas sueltas, sin ningún lock
  sostenido a la vez), esta es la PRIMERA registrada que ocurre MIENTRAS
  la transacción sostiene un `FOR UPDATE` sobre una fila real (`orders`).
  Consecuencia distinta, no solo "una lectura más": bajo saturación del
  pool del tenant (`max: 10` default, `connectionTimeoutMillis: 5000`,
  `db/pg.client.ts:94`), lo que crece no es solo el riesgo de timeout de
  la lectura -- es el TIEMPO DE RETENCIÓN DEL LOCK sobre `orders`, hasta
  los mismos 5s del timeout, mientras esta transacción espera una segunda
  conexión del mismo pool que la primera ya está usando. Mismo patrón
  exacto en el precedente de reservas (`liveInvoiceIdsForReservation()`
  dentro de tx2 de `cancel-reservation-with-credit-note.service.ts`, ya en
  producción) -- no es una clase de riesgo nueva que este commit
  introduce, pero si el precedente de reservas alguna vez se contó bajo
  este ítem, no tenía su propia instancia numerada; queda corregido acá,
  con las dos citadas.
- **`ACCOUNTS-RECEIVABLE-STATUS-REVERTIDO-TS-001`** — deuda con ancla
  (Bloque 6, §9.2, 13/09/2026): `(ar.status as string) !== 'REVERTIDO'`
  en los 2 escapes de NC filtra un valor que `AccountsReceivableStatus`
  (TS) todavía no declara -- a propósito, mismo criterio que evitó
  `ROLES-CATALOG-DRIFT-001` (el schema v52 ya acepta `REVERTIDO`, pero
  `reverseTransfer()` no existe todavía, así que ampliar el tipo ahora
  sería ampliar un lado sin que el mecanismo real exista). Se angosta el
  cast (y probablemente se amplía el tipo) junto con el Bloque 2 de §8
  (`reverseTransfer()`) — no antes, no aislado.
  **Segundo artefacto cross-repo del mismo concepto, encontrado por el
  gate `architecture-governor` al revisar la decisión de §7.8
  (13/09/2026):** `appfrontend-main/src/lib/finanzas/types.ts:37`
  (`AccountsReceivableStatus`, mismo union de 3 valores) y
  `appfrontend-main/src/app/dashboard/reportes/page.tsx:17`
  (`AR_STATUS_LABEL: Record<AccountsReceivableStatus, string>`, 3
  claves, consumida en `:304` como `{AR_STATUS_LABEL[ar.status]}`) --
  esa pantalla YA CONSUME `listByCompany()` hoy. Consecuencia concreta
  si se olvida ampliar junto con el Bloque 2: una fila `REVERTIDO` real
  hace que `AR_STATUS_LABEL['REVERTIDO']` sea `undefined` y la celda de
  estado se renderice vacía -- exactamente lo contrario de la decisión
  de §7.8 ("mostrar, con estado visible, para no esconder que hubo una
  corrección").
  **Esta lista NO es exhaustiva todavía (mismo gate, misma revisión):**
  la misma pantalla tiene otros 3 sitios que comparan `ar.status` contra
  un literal -- `reportes/page.tsx:281` (habilita "Facturar ahora",
  emite CAE AFIP real), `:308` ("Marcar facturado") y `:326` ("Marcar
  cobrado"). Los 3 son ALLOWLIST (`=== 'PENDIENTE_FACTURAR'`/
  `'FACTURADO'`), no denylist -- fallan del lado seguro por
  construcción: una fila `REVERTIDO` no entra en ninguno de los 3
  conteos ni ofrece acciones, sin que nadie lo haya decidido a
  propósito. Antes de dar la matriz de impacto del Bloque 2 por cerrada,
  falta enumerar también los 3 usos ya existentes en el backend del
  mismo predicado (`(ar.status as string) !== 'REVERTIDO'` en
  `cancel-order-with-credit-note.service.ts:377`,
  `cancel-reservation-with-credit-note.service.ts:462` e
  `invoice.service.ts:394`) y los 3 hallazgos de concurrencia de §7.2.

  **Cierre parcial (Bloque 3c-ii, 14/09/2026, gate `architecture-governor`,
  Condición C1/C3).** `AccountsReceivableStatus` (TS, backend) ya incluye
  `REVERTIDO` -- ampliado en el mismo commit que agrega
  `AccountsReceivableService.reverseTransfer()`, el mecanismo real que
  ahora puede producir el valor (sin él, `markRevertedWithClient()` no
  tipa). Los 3 casts `(ar.status as string) !== 'REVERTIDO'` de los
  escapes de NC (`cancel-order-with-credit-note.service.ts:377`,
  `cancel-reservation-with-credit-note.service.ts:464`,
  `invoice.service.ts:394`) **NO se angostaron** -- decisión explícita del
  gate: esos 3 archivos son de emisión fiscal y §7.2 les reserva su propio
  gate, angostarlos como efecto colateral de este commit sería tocar esa
  superficie sin la revisión que le corresponde. Siguen compilando y
  comportándose igual bajo el union ampliado (el cast a `string` ya los
  hacía indiferentes al tamaño real de la unión).
  **Lo que sigue abierto, y pasa a ser precondición DURA del Bloque 3c-iii
  (no solo pendiente):** el lado `appfrontend-main` --
  `src/lib/finanzas/types.ts:37` (`AccountsReceivableStatus`, todavía 3
  valores) y `AR_STATUS_LABEL`/los 3 sitios allowlist de
  `dashboard/reportes/page.tsx` (`:281,308,326`), sin tocar. Hoy es inerte
  (sin ruta, ninguna fila `REVERTIDO` puede existir todavía) -- deja de
  serlo en cuanto el Bloque 3c-iii exponga `POST /:id/reverse`: una AR
  revertida real haría que `AR_STATUS_LABEL['REVERTIDO']` renderice
  `undefined` (celda en blanco, sin crash) en la misma pantalla que ya
  consume `listByCompany()`. Residuo NO resuelto -- se mueve, no se
  entierra (mismo criterio que la regla de "residuo" del `CLAUDE.md`
  raíz): sigue siendo este mismo ítem, con este párrafo describiendo
  exactamente qué falta.

  **Segunda precondición DURA del Bloque 3c-iii, encontrada en la ronda de
  gate de IMPLEMENTACIÓN (14/09/2026), no solo la de diseño de arriba:**
  `sql.accounts-receivable.repository.ts:170-183`
  (`getReportByPeriod()`, base del reporte de cierre de mes) hace
  `COUNT(*)`/`SUM(ar.amount) AS total_amount` SIN filtrar por `status`,
  más 3 `FILTER (WHERE ar.status = ...)` que solo cubren los 3 estados
  viejos (`PENDIENTE_FACTURAR`/`FACTURADO`/`COBRADO`) -- sin bucket
  propio para `REVERTIDO`. Consecuencia (no mecanismo): en cuanto exista
  una fila `REVERTIDO` real, `pending + invoiced + collected` deja de
  sumar `total_amount` en el reporte de cierre de mes, sin ninguna
  columna que explique la diferencia -- mismo síntoma que el hueco del
  frontend de arriba, mismo motivo de por qué hoy es inerte (sin ruta,
  ninguna fila `REVERTIDO` puede existir todavía). Bloque 3c-iii tiene
  que resolver esto junto con la ruta, no como deuda que se arrastra
  después -- agregar el bucket `revertedAmount` (o equivalente) a
  `AccountsReceivableReportRow`/`getReportByPeriod()` antes de exponer
  `POST /:id/reverse`.
- **`CITY-LEDGER-AR-STAY-ADOPTION-RACE-001`** — deuda con ancla (Bloque
  3c-ii, 14/09/2026, gate `architecture-governor`, ronda 5, Finding C).
  La mitigación de `reverseTransfer()` (§4.3 paso 5 del ADR,
  `stayId: charge.stayId` en vez de `stayId: null` fijo, mismo precedente
  sancionado en `cancel-order-with-credit-note.service.ts:355`) REDUCE la
  ventana en la que `linkStayToReservationCharges()`
  (`sql.financial-transaction.repository.ts:921`) puede adoptar el
  `CHARGE` original y el `ADJUSTMENT` compensatorio de forma
  desincronizada — de "cualquier adopción entre la transferencia y la
  reversa" (días) a "una adopción cuyo snapshot de statement cae dentro
  de la transacción de `reverseTransfer()`" (milisegundos) — pero no la
  ELIMINA. Bajo READ COMMITTED: si el `UPDATE` de adopción toma su
  snapshot mientras `reverseTransfer()` ya tiene el `FOR UPDATE` sobre el
  `CHARGE` pero no commiteó, ese `UPDATE` bloquea, despierta tras el
  commit, y Postgres re-chequea (EvalPlanQual) la fila que YA había
  encontrado (el `CHARGE`) sin re-escanear por filas insertadas después de
  su snapshot (el `ADJUSTMENT`, recién visible tras el commit) — adopta el
  `CHARGE` solo. Consecuencia (no mecanismo): el folio de un stay ajeno
  recibe el `+amount` del `CHARGE` de la empresa sin su `-amount`
  compensatorio, deuda fantasma angosta pero real. Candidato de fix, no
  aplicado acá (cambio de comportamiento sobre un método compartido con
  otros callers — `checkIn()` y el propio `transferStayBalanceToReceivable()`
  — necesita su propio gate): agregar `AND reversed_transaction_id IS
  NULL` al `WHERE` de `linkStayToReservationCharges()`.
- **`CITY-LEDGER-AR-DOUBLE-TRANSFER-001`** — bug preexistente,
  independiente de `reverseTransfer()`, con ancla (encontrado al analizar
  Finding C, Bloque 3c-ii, 14/09/2026, gate `architecture-governor`, ronda
  5). La protección "a propósito NO va acá" del `CHARGE` compensatorio de
  la empresa (`accounts-receivable.service.ts`, bloque `companyChargeId`,
  comentario `:390-399`) solo protege el momento de CREACIÓN (nace sin
  `stayId`) — no evita que `linkStayToReservationCharges()` lo adopte
  después por `reservation_id`. Consecuencia real:
  `transferStayBalanceToReceivable()` corre `linkStayToReservationCharges()`
  en `:243`, ANTES de leer el saldo en `:245`; el `CHARGE` de la empresa
  de una transferencia ANTERIOR sobre la misma estadía (todavía con
  `reservation_id` seteado y `stay_id NULL`) queda adoptado por una
  SEGUNDA transferencia sobre esa misma estadía — el folio vuelve a dar
  saldo positivo, `NoBalanceToTransferError` no dispara, y la MISMA deuda
  se transfiere a la empresa dos veces. Fuera de alcance de Bloque 3c-ii
  (no lo introduce `reverseTransfer()`, ya existe hoy) — requiere su
  propio diseño, candidato más directo que el de arriba: excluir de la
  adopción cualquier fila que ya tenga `financial_transaction_id`
  referenciado desde una `accounts_receivable` (mismo espíritu que el
  candidato de `CITY-LEDGER-AR-STAY-ADOPTION-RACE-001`, pero acá no
  alcanza con `reversed_transaction_id` — el `CHARGE` de una transferencia
  vieja nunca tiene ese campo seteado, es el ORIGEN, no una reversa).
- **`CITY-LEDGER-GUARD-RETRY-EMITS-001`** — §9.4, encontrado por el gate
  `architecture-governor` al revisar el cierre de
  `CITY-LEDGER-GUARD-INVOICE-ORDER-OPEN-001` (13/09/2026, commit
  `bc5cb46`), NO cerrado en ese bloque. `requestInvoice()` tiene un
  fast-path idempotente (`invoice.service.ts:422`,
  `if (existing) return this.retryExisting(existing);`) que corre ANTES
  de que el nuevo warning de §9.4 pueda calcularse. `retryExisting()`
  (`invoice.service.ts:1200-1218`) no se limita a devolver una invoice ya
  `ISSUED`: llama `issue()` de verdad -- una emisión REAL contra AFIP --
  salvo que el estado previo sea `ISSUED` o `FAILED_UNCERTAIN` con
  `afipContacted`. Escenario concreto: invoice `PENDING` -> AFIP rechaza
  (`REJECTED`, sin warning porque `REJECTED` no bloquea en ningún guard de
  esta familia) -> `transferStayBalanceToReceivable()` corre sin
  obstáculo -> alguien reintenta el mismo `POST /api/invoices` ->
  `retryExisting()` -> `issue()` real -> Factura B emitida al huésped por
  un cargo cuyo saldo ya está en la cuenta corriente de la empresa, sin
  warning ni log. El tipo `RequestInvoiceResult` no lo puede detectar
  (propiedad opcional -- `Invoice` sigue siendo asignable, el compilador
  no fuerza el campo en ningún camino). Requiere diseño propio (¿cubrir la
  rama de `retryExisting()` que llega a `issue()` con el mismo
  `resolveAccountsReceivableWarning()`? ¿bloquear en vez de exponer, dado
  que acá sí hay un guard hermano — §9.1 — para inspirarse?) y su propio
  gate -- no decidido ni implementado acá.
- **`CITY-LEDGER-GUARD-STANDALONE-CHARGE-001`** (R2, deuda con ancla,
  defensiva hoy) — Bloque 6, §9.1 (13/09/2026, gate
  `architecture-governor`): un cargo *solo-estadía* (sin `reservationId`
  NI `orderId`, legal por el CHECK
  `chk_financial_transactions_order_or_reservation`) con una Factura B
  `ISSUED` encima queda bloqueado por el guard PARA SIEMPRE, sin camino de
  salida (fail-closed, no hay entidad contra la cual llamar `classify*`).
  Mitigado hoy: ningún camino de producción crea un CHARGE solo-estadía
  (verificado en los 4 sitios de creación: `stay.service.ts:471`,
  `outbox.handlers.ts:192`/`:206`,
  `accounts-receivable.service.ts:264` — los 4 setean siempre
  `reservationId` u `orderId`). Revisar antes de que algún camino nuevo
  cree ese tipo de cargo facturable.
- **`CITY-LEDGER-GUARD-INVOICE-MISMATCH-001`** (R3, cosmético, con ancla,
  **acotado a la rama `ISSUED`** -- corregido 13/09/2026 al cerrar la
  extensión "en vuelo", gate `architecture-governor`: en la rama nueva
  `NOT_ISSUED` el `invoiceId` y el `status` del mensaje salen del MISMO
  `resolveInvoiceLinkage(charge.id)` que decidió bloquear -- no hay
  mismatch posible ahí, solo en la rama `ISSUED`)
  — Bloque 6, §9.1 (13/09/2026, gate `architecture-governor`): el
  `invoiceId` del mensaje 422 de `StayChargeAlreadyInvoicedError` para el
  caso `ISSUED` sale de `resolveInvoiceLinkage(charge.id)` (por cargo),
  pero la decisión de bloquear sale de `classify*(entidad)` (por
  reserva/orden completa). Con 2 facturas distintas sobre la misma
  reserva, el mensaje puede nombrar la factura ya compensada mientras la
  que realmente bloquea es otra. El mensaje llega tal cual al usuario
  (`appfrontend-main/src/app/dashboard/estadias/[id]/page.tsx:154`,
  `extractErrorMessage`). No confunde el resultado (bloquea igual, motivo
  correcto en esencia), pero el detalle puede inducir a error al staff que
  lo lee.
- **`INVOICE-CHARGES-GUARD-FRONTEND-RESIDUE-001`** — residuo de
  `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` hallazgo 3 (13/09/2026, gate
  `architecture-governor`, cerrado en `docs/resuelto.md`, commit
  `495154f`). El backend ya exige `MANAGEMENT` para facturar
  individualmente un cargo de un cliente `kind='COMPANY'`, pero
  `appfrontend-main/src/components/FacturarButton.tsx` se monta sin
  gating de rol ni de tipo de cliente en **2 pantallas**: la SUPERFICIE
  PRINCIPAL es `appfrontend-main/src/app/dashboard/cuentas-corrientes/page.tsx:315`
  (el statement de cuenta corriente, que renderiza el botón para todo
  `tx.type === 'CHARGE'` no `VOIDED`/`FAILED` — exactamente la pantalla
  que un cliente `COMPANY` con `enable_current_account=true` usa) y,
  secundaria, `appfrontend-main/src/app/dashboard/reservas/[id]/page.tsx:517`.
  Un `FRONT_DESK` sin `MANAGEMENT` sigue viendo el botón activo sobre un
  cargo de empresa y ahora recibe un 403 al clickearlo (antes conseguía
  la factura). Mismo patrón que `INVOICE-CHARGES-BUTTON-DEADEND-01`, ya
  resuelto una vez para el caso consolidada -- acá aplica al caso nuevo.
  Bloque de frontend aparte, no autorizado todavía.
- **`INVOICE-CHARGES-GUARD-RETRY-PATH-001`** — residuo de
  `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` hallazgo 3 (13/09/2026, gate
  `architecture-governor`, cerrado en `docs/resuelto.md`, commit
  `495154f`). El guard `requireManagementForCompanyCharge()` corre ANTES
  de la idempotencia de `requestInvoice()` (`retryExisting()`,
  `invoice.service.ts:350-352`). Un `FRONT_DESK` que antes podía
  re-obtener una factura YA EMITIDA de un cargo de empresa reintentando
  el mismo `POST /api/invoices` (doble click, timeout del cliente) ahora
  recibe 403 en ese camino puntual -- el dato sigue accesible por las
  rutas GET (`/:id`, `?customerId=`, `/:id/pdf`, todas `FRONT_DESK` sin
  cambios) y por la pantalla `/dashboard/facturacion`, así que es una
  regresión de UX en un atajo, no de acceso. No nombrado por el dueño al
  decidir -- registrado para que se note si alguien lo reporta.
- **`CITY-LEDGER-GUARD-INVOICE-EMIT-VERIFY-001`** — §9.4 (13/09/2026, gate
  `architecture-governor`, commit `bc5cb46`). Toda la evidencia de
  `resolveAccountsReceivableWarning()` es unitaria contra
  `FakeAccountsReceivableRepo` -- cero cobertura de integración contra el
  `getByStayId()` real de `SqlAccountsReceivableRepository` sobre
  Postgres, y ninguna prueba end-to-end vía `POST /api/invoices`. Mismo
  hueco que `CITY-LEDGER-GUARD-INVOICE-INFLIGHT-VERIFY-001` (§9.1,
  cerrado en `docs/resuelto.md`, commit `ea3e4a1`) tenía antes de
  cerrarse, aplicado al camino de emisión en vez del de transferencia.
  Confirmar:
  agregar un test de integración que seedee una `accounts_receivable`
  real vinculada a la `stayId` del cargo y corra `requestInvoice()`
  contra Postgres real, y si el tiempo lo permite, un test end-to-end vía
  `POST /api/invoices`.
- **`CITY-LEDGER-GUARD-NO-UI-SURFACE-001`** — §9.2 + §9.4 (13/09/2026, gate
  `architecture-governor`, commit `bc5cb46`). `accountsReceivableWarning`
  (el campo aditivo que tanto el escape de NC -- §9.2 -- como la emisión
  de Factura B -- §9.4 -- exponen para revisión manual de management)
  tiene **0 consumidores** en `appfrontend-main/src` (verificado por
  grep). La decisión del dueño en ambos casos fue "exponer, no
  bloquear" -- hoy esa exposición llega solo a los logs del servidor
  (`nc_escape_con_ar_viva`, `factura_con_ar_viva`) y al JSON crudo de la
  respuesta HTTP, sin ninguna pantalla que se lo muestre a management. Sin
  esto, §9.2 y §9.4 quedan "resueltos" en el sentido de que no bloquean
  nada indebidamente, pero la revisión manual que ambos dicen habilitar
  no tiene dónde ocurrir todavía. Confirmar: diseñar y construir la
  pantalla/sección del dashboard (`appfrontend-main`) que liste estas
  facturas/notas de crédito con `accountsReceivableWarning` presente,
  para que management la revise -- bloque de producto propio, con su
  propio gate.
- **`CITY-LEDGER-OUTSTANDING-NC-STALE-SURFACE-001`** (14/09/2026, gate
  `architecture-governor`, condición C3 sobre
  `docs/diseno-city-ledger-balance-asymmetry-pasos-2b-3-2026-09-14.md`).
  Hermano de `CITY-LEDGER-GUARD-NO-UI-SURFACE-001` (arriba) — mismo
  origen (la decisión ya tomada del dueño, "Guard en la NC — exponer, no
  bloquear" — `docs/diseno-reconciliacion-city-ledger-2026-09-12.md`: la
  NC procede igual sobre una AR viva, y se detecta/expone para que
  management la revise), pero por una VÍA DISTINTA: acá no es
  `accountsReceivableWarning` (facturación) — es
  `cityLedgerOutstanding`, el campo nuevo de
  `CustomerAccountService.getStatement()` (paso 2(b) del ítem
  `CITY-LEDGER-CUSTOMER-BALANCE-STATUS-ASYMMETRY-001` — ítem completo
  cerrado 14/09/2026, cortado de este archivo, ver `docs/resuelto.md`,
  sección `14/09/2026`). Como el circuito de cancelación con Nota de
  Crédito no actualiza `accounts_receivable.status` cuando cancela una
  reserva/orden con una AR activa encima (mismo hallazgo de
  `CITY-LEDGER-GUARD-NO-UI-SURFACE-001`), `cityLedgerOutstanding` puede
  seguir sumando una AR que el negocio ya considera resuelta del lado
  fiscal. **La diferencia real con el ítem hermano:** hasta ahora ese
  desbalance solo llegaba a logs (`nc_escape_con_ar_viva`) y al JSON
  crudo de la respuesta HTTP — invisible en cualquier pantalla. Con el
  paso 2(b) implementado (14/09/2026), `cityLedgerOutstanding` queda
  EXPUESTO por `GET /api/customers/:id/account` — verificado: 0 usos del
  campo en `appfrontend/`, `lib/clientes/types.ts::CustomerStatement`
  todavía no lo declara, así que hoy no llega a ninguna pantalla, incluida
  `dashboard/cuentas-corrientes/page.tsx`. El riesgo real es para CUANDO
  el frontend lo consuma (backlog, sin bloque asignado todavía): en ese
  momento el staff vería directamente un número que puede estar
  sobreestimado, sin saber por qué. No se resuelve con el paso 2(b) ni con
  el paso 3 (fuera
  de su alcance, ver el diseño citado, §1.3) — confirmar junto con
  `CITY-LEDGER-GUARD-NO-UI-SURFACE-001`, probablemente la misma pantalla
  de revisión de management resuelve los dos a la vez (ambos son "una AR
  viva que la NC dejó sin sincronizar, expuesta en un lugar distinto").
- **`CITY-LEDGER-GUARD-AR-VIVA-PREDICATE-TRIPLE-001`** — §9.2 + §9.4
  (13/09/2026, gate `architecture-governor`, commit `bc5cb46`). El
  predicado "¿esta estadía/reserva tiene una AR viva?" (filtrar
  `status !== 'REVERTIDO'` + mapear a `AccountsReceivableWarningEntry`)
  está escrito 3 veces: `cancel-order-with-credit-note.service.ts:375-386`,
  el equivalente en `cancel-reservation-with-credit-note.service.ts`, y
  ahora `invoice.service.ts::resolveAccountsReceivableWarning()`. Si
  mañana entra un estado nuevo tipo `ANULADO`, hay que tocar los 3
  lugares a mano. El tipo compartido (`AccountsReceivableWarningEntry`)
  ya vive en `cancel-with-credit-note.ts:56` -- casa natural para un
  helper, no extraído todavía. Bloque aparte, no decidido.
- **`CITY-LEDGER-GUARD-ADR-ANCHOR-DRIFT-001`** (13/09/2026, gate
  `architecture-governor`, encontrado al cerrar
  `CITY-LEDGER-GUARD-INVOICE-INFLIGHT-VERIFY-001`). `docs/diseno-reconciliacion-city-ledger-2026-09-12.md:677`
  cita `invoice.service.ts:451-453`/`:604-606` como el lock que
  serializa contra `requestInvoice()` -- esas líneas ya quedaron
  desactualizadas por `bc5cb46` (el código real se movió). El propio
  repo ya declaró esa ancla podrida en otro archivo
  (`src/tests/integration/accounts-receivable-invoice-linkage.integration.test.ts:742`,
  comentario del test de concurrencia de §9.1), pero el ADR nunca se
  corrigió -- dos afirmaciones contradictorias sobre la misma cita, en
  dos archivos distintos. Confirmar: reemplazar por cita por método
  (`invoice.service.ts::requestInvoice()`, sin rango de línea), mismo
  criterio que `SCHEMA-ANCHOR-DRIFT-001`. No cerrado en este bloque a
  propósito (mezclar el fix con el cierre de `VERIFY-001` habría
  combinado dos motivos distintos en un mismo commit) -- bloque de docs
  chico y aparte.
- **`CITY-LEDGER-GUARD-ANCHOR-DRIFT-002`** (13/09/2026, gate
  `architecture-governor`, encontrado en la 4ª ronda de revisión del
  commit de docs de City Ledger Bloque 3b -- deuda de la misma clase que
  `CITY-LEDGER-GUARD-ADR-ANCHOR-DRIFT-001`, sin corregir todavía. 3
  anclas de línea a `outbox.handlers.ts` quedaron stale por commits
  anteriores a `c9b1fd2` (no por ese commit -- ese ya se corrigió):
  1. `docs/diseno-reconciliacion-city-ledger-2026-09-12.md:35` cita
     `handleReservationCancelled` en `outbox.handlers.ts:225-270` --
     stale desde `d48a6e8` (Bloque 3a); real hoy `:318-445`.
  2. `docs/diseno-reconciliacion-city-ledger-2026-09-12.md:1011` y
     `docs/pendientes-2026-09-12.md:220` (mismo par, citado en los 2
     archivos) apuntan a los sitios de creación de `CHARGE` en `:192`/
     `:206` -- real hoy `:209`/`:223`.
  3. `docs/pendientes-2026-09-12.md:1826` cita la rama
     `comprobanteReconciliado` en `outbox.handlers.ts:395` -- stale, sin
     verificar el target real todavía (hay 3 ramas `comprobanteReconciliado`
     distintas en el archivo, región candidata `:593-601`, no confirmada).
  Mismo criterio que `SCHEMA-ANCHOR-DRIFT-001`: reemplazar por cita por
  método/función cuando se corrija, no por rango de línea. No corregido
  en este bloque a propósito (evitar una 5ª ronda de "corregir anclas
  que el propio commit de corrección de anclas dejó rotas") -- bloque de
  docs chico y aparte.
- **`FACT-BORRADOR-DESIGN-ANCHOR-DRIFT-001`** (13/09/2026, encontrado al
  migrar el cierre de "Hueco de doble comprobante ...
  CONSOLIDADA↔CONSOLIDADA" a `docs/resuelto.md`; corregido 13/09/2026,
  gate `architecture-governor` -- la primera versión de este ítem citaba
  el guard equivocado, ver nota al final).
  `docs/diseno-factura-borrador-2026-08-31.md`
  (FACT-BORRADOR-001, **v2.13**, diseño SIN aprobar) cita el guard
  anti-double-billing de RECEIVABLE en `invoice.service.ts:429-432` --
  esas líneas ya se movieron, el guard real hoy está en
  `invoice.service.ts:628-631` (`getInvoicedFinancialTransactionIds()` +
  `AccountsReceivableAlreadyInvoicedError`, docblock desde `:616`,
  verificado vigente 13/09/2026) -- y planea revalidarlo dentro de la
  transacción de emisión. Deuda registrada, no se tocó ese documento (no
  aprobado, fuera del radio del fix que la encontró). **No es una cita
  aislada, es deuda de clase:** `:429-432` aparece 3 veces en ese mismo
  documento (`:860`, `:1035`, `:1305`), y el doc arrastra ~20 anclas
  `invoice.service.ts:NNN` en total (archivo real: 1353 líneas) -- 4
  muestreadas al gate de esta corrección (`:322-326`, `:147-157`, `:374`,
  además de `:429-432`), las 4 cayeron en código sin relación con lo que
  citaban. Confirmar: corregir la cita en
  `diseno-factura-borrador-2026-08-31.md` cuando se retome ese diseño --
  como barrido del documento completo, no un solo renglón -- o antes si
  otra sesión lo toca de paso -- preferir cita por
  método (`requestConsolidatedInvoice()`, el guard de
  `getInvoicedFinancialTransactionIds()`, único call-site en el archivo)
  en vez de un rango de línea nuevo, mismo criterio que
  `SCHEMA-ANCHOR-DRIFT-001`, para no repetir el mismo drift una tercera
  vez.
  *(Nota: la primera versión de este ítem citaba `:503-512`
  -- `OrderCancelledCannotInvoiceError`, el guard TOCTOU de orden
  cancelada, un mecanismo distinto sin relación con RECEIVABLE -- y
  "v2.8" en vez de "v2.11". El gate lo encontró al re-verificar contra
  el código y el doc vivos antes de este commit.)*
- **`RESERVATION-STATUS-EXPIRED-FRONTEND-01`, residuo de verificación**
  (13/09/2026, split del ítem al migrarlo a `docs/resuelto.md`).
  Verificación funcional real: captura de pantalla con una reserva
  `EXPIRED` mostrando el badge nuevo (`.badge-expired`) — no había datos
  de prueba a mano en la sesión que cerró el bloque, sin fabricarlos en
  tenant compartida.
- **`CITY-LEDGER-BLOQUE3A-INTEGRATION-VERIFY-001`** — detección de AR
  viva en `handleReservationCancelled()` nunca corrió contra Postgres
  real (13/09/2026, commit `d48a6e8`). El código está gate-aprobado (3 rondas)
  y cubierto por 8 tests con mocks (`FakeStayRepository`/
  `FakeAccountsReceivableRepository`, `src/workers/outbox.handlers.test.ts`),
  pero `TEST_DATABASE_URL` no estaba seteada en la sesión que lo escribió
  -- ni el wiring real del registry (`accountsReceivableRepo = new
  SqlAccountsReceivableRepository(db)`) ni el path completo se ejercitaron
  contra una BD real. Los 5 call-sites actualizados en
  `src/tests/integration/cancel-reservation-with-credit-note.integration.test.ts`
  (líneas `479,507,532,589,619`) tampoco lo cubren, y **no alcanza con
  sembrar un stay real ahí**: los 5 pasan `new FakeAccountsReceivableRepo()`
  (`:99`, `getByStayId()` devuelve `[]` siempre) -- si alguien solo agrega
  el stay pero no cambia ese fake, `findByReservation()` deja de dar
  `null`, el detector CORRE, pero lee `[]` del fake y no loguea nada: el
  verificador concluye "probado, no salta" cuando en realidad nunca leyó
  una AR real -- falso negativo, no falta de cobertura. Acción puntual,
  las DOS partes son necesarias, no alcanza con una sola: correr
  `npm run test:integration` con `TEST_DATABASE_URL` configurada,
  agregando un caso que (a) siembre un stay real y (b) reemplace
  `new FakeAccountsReceivableRepo()` por `new SqlAccountsReceivableRepository(db)`
  en ESE call-site -- que sí transfiera una estadía a una empresa y
  cancele la reserva después -- o, en su defecto, cancelar una
  reserva real con AR viva en un entorno con datos y confirmar el log
  estructurado `evento: reservation_cancelled_con_ar_viva`.

**Migración de ítems ✅ mezclados en el resto del archivo (13/09/2026,
triage con 2 agentes en paralelo + ejecución propia):** de las 61
menciones de `✅` fuera de las 3 secciones ya migradas el 12/09/2026, se
revisaron individualmente las ~28 que correspondían a hallazgos/tickets
reales (el resto era ruido: encabezados, punteros internos, o el propio
archivo citando el `✅` incorrecto de `docs/roadmap-pms-multirubro.md`).
**3 resultaron duplicados stale** de ítems que ya tenían su entrada
completa en `docs/resuelto.md` — cortados sin migrar de nuevo (uno de
ellos, `ORDER-CONSOLIDATED-PARTIAL-01` en "Reclasificación de 🔴", citaba
"RESUELTO" sobre un ticket que el propio archivo sigue trackeando
abierto, en HOLD de implementación, más abajo — no se creó una entrada
falsa en `resuelto.md` para eso). **10 eran genuinamente autocontenidos
y se cortaron a `docs/resuelto.md`** (medido: `grep -c '^- \*\*'` sobre
el diff agregado a `resuelto.md`), con el matiz de residuo separado
cuando correspondía (`RESERVATION-STATUS-EXPIRED-FRONTEND-01`, arriba).
**3 afirmaban "LOCAL/sin pushear" pero ya estaban pusheados** (`b38bce4`
en `appfrontend-main`; `a36f877` en `app-main`; y el commit
`74f6872` de `SEC-ROT-001` Parte 1, que sigue abierto por alcance —
Partes 2/3 — aunque su Parte 1 ya esté en producción) — corregido al
migrar o señalado in-place, mismo patrón que el `CLAUDE.md` de este repo
ya documenta como incidente recurrente.
**No tocado a propósito:** el mega-bullet `ORDER-CONSOLIDATED-PARTIAL-01`
(sección "🟡 Listo para encarar", ~250 líneas) narra una saga de fases
(1c-0 → 1c-i → 1c-ii-a/b/c) con piezas cerradas y abiertas entrelazadas
en prosa continua — extraer las piezas cerradas rompería el hilo
narrativo que un lector necesita para entender por qué cada fase
importa. La propia sesión de triage lo señaló como "estructura ideal
para partir en filas independientes, no decidido todavía" — sigue sin
decidir. Tampoco se tocaron los ítems de `🟢 Deuda aceptada`/triage de
riesgo (`FACT-INV-BIZID-001`/`FAILOPEN-001`).

**Actualización 13/09/2026 -- el trío `PRESET-*` migrado en una pasada
aparte:** `PRESET-REVOKE-001` (mergeando 2 bullets del archivo de
origen en una sola entrada, más una tercera mención duplicada/stale
encontrada y borrada), `PRESET-GROUP-VALIDATION-001` y
`PRESET-SAVE-ECHO-001` (los 2 con split: cierre a `docs/resuelto.md`,
residuos de verificación separados con ancla -- uno de los 2 residuos de
`PRESET-SAVE-ECHO-001` reclasificado a `### 🟡 Listo para encarar` en
vez de `## 🔍 Verificaciones pendientes`, mismo criterio que
`RESERVATION-STATUS-CROSSREPO-SYNC-001`). 3 hashes de "LOCAL/sin
pushear" stale encontrados
y corregidos: `dc81a39` (`PRESET-GROUP-VALIDATION-001`) y
`cd4dff6`+`18a3c93` (mitad de `PRESET-REVOKE-001`), los 3 confirmados
ancestros de `origin/main`.

**Actualización 13/09/2026 -- `CITY-LEDGER-OVERTRANSFER-PAYMENT-001`
cerrado en código, residuos de runtime separados (commit `93a9416`,
gate `architecture-governor` APPROVED WITH CONDITIONS, condiciones de
comentario aplicadas en el mismo commit).** El fix ((a) `recordPayment()`
setea `stayId` cuando la estadía está `CHECKED_IN` al pagar, (c)
`transferStayBalanceToReceivable()` corre
`linkStayToReservationCharges()` como red de seguridad antes de leer el
saldo) quedó gate-aprobado, tipado y con `vitest` verde (111/111 en los
2 archivos de test con cambios de comentario; 156/156 en la ronda
anterior sobre los 3 archivos con cambios de lógica) — pero sin una sola
corrida contra Postgres real (sin `TEST_DATABASE_URL` en esta sesión).
Seis residuos, cada uno con su ancla y acción puntual:

- **Filtro `CHECKED_IN` en `POST /:id/payments`** — confirmar contra
  Postgres real: reserva con estadía `CHECKED_IN` → el `PAYMENT` nuevo
  queda con `stay_id` seteado; reserva con única estadía `CHECKED_OUT`
  → `stay_id` queda `null` (fail-safe, comportamiento sin cambios).
  `src/clientes-finanzas/customers.routes.ts` (bloque `POST
  /:id/payments`), commit `93a9416`.
- **Red de seguridad (c)** — confirmar que
  `linkStayToReservationCharges()` efectivamente adopta las filas
  huérfanas al transferir y que el monto transferido coincide con el
  saldo esperado; y confirmar el 409 nuevo (`StayChargeAlreadyInvoicedError`)
  cuando el `CHARGE` recién adoptado tiene un comprobante fiscal vivo.
  `src/clientes-finanzas/accounts-receivable.service.ts::transferStayBalanceToReceivable()`,
  commit `93a9416`.
- **`getFolio()` / frontend (`appfrontend-main`)** — desde este commit
  el folio de una estadía puede traer filas `PAYMENT` que antes no
  aparecían vinculadas; confirmar que la pantalla del folio las
  renderiza con el signo correcto y no asume "toda fila es un cargo".
  Residuo de runtime más visible del bloque — requiere UI con datos
  reales, señalado por el gate como el próximo a mirar.
- **`checkOut()`** — confirmar el cambio de comportamiento intencional:
  un huésped que ya pagó durante la estadía no debería necesitar más
  `overridePendingBalance` al hacer check-out, ahora que su pago tiene
  `stay_id`. `src/pms-estadias/stay.service.ts`.
- **Deriva de anclas causada por este commit** (`accounts-receivable.service.ts`
  ganó 19 líneas contiguas en la 219 -- toda cita `≥219` en `src/`
  quedó corrida `+19`, verificado una por una por el gate): `src/facturacion/invoice.service.ts:385`
  (cita `:292-315`, real `311-334`); `src/reservas/cancellation-refund.service.ts:172`
  (cita `:321`, real `340`) y `:183` (cita `customer-account.service.ts:240`,
  real `~252`); `src/tests/integration/cancellation-refund.integration.test.ts:420`
  y `:923` (citan `:353`/`:394`, reales `372`/`413`);
  `src/tests/integration/accounts-receivable-invoice-linkage.integration.test.ts:653`
  (cita `:275-318`, real `294-337`). Además hay anclas en `docs/` sin
  enumerar exhaustivamente por el gate. Ninguna de estas citas está
  rota funcionalmente (son comentarios/docs, no código que ejecute mal)
  — es deuda de referencia, se corrige de-pineando por firma (mismo
  criterio ya aplicado a `outbox.handlers.ts:249` en este mismo commit),
  no urgente.
- **`docs/diseno-reconciliacion-city-ledger-2026-09-12.md` §4.6 quedó
  contradiciendo al código** — sigue diciendo que el sobrepago *"es
  estructuralmente invisible para este cálculo"* y describe el hallazgo
  como *"fuera de alcance de este bloque … ítem propio en
  `docs/pendientes-2026-09-12.md`"* (puntero que, tras migrar ese ítem a
  `docs/resuelto.md`, ya no tiene destino). Las dos afirmaciones son
  falsas desde `93a9416`: el comentario de `handleReservationCompleted`
  en `outbox.handlers.ts` ya dice lo contrario, y `getNetBalanceByStayId()`
  resta `PAYMENT` sobre `WHERE stay_id`, así que un sobrepago con
  `stay_id` seteado sí puede dar saldo negativo. Deuda de documento, no
  de código; corregir en un bloque de docs aparte.

No autorizado en este bloque, explícitamente fuera de alcance: el
backfill histórico de los `PAYMENT` ya huérfanos en producción (necesita
su propio `AskUserQuestion` sobre reservas multi-stay +
`irreversible-action-gate`), y el push de este commit ni de los 6
anteriores.

- **Residual B-1/3.2-b** (13/09/2026, commit `038cd83`, gate
  `architecture-governor` APPROVED WITH CONDITIONS — código ya aplicado
  las 3 condiciones). `TEST_DATABASE_URL` sin definir en este entorno:
  nada de este bloque corrió contra Postgres real. Dos verificaciones
  puntuales, no el bloque entero:
  1. `sql.financial-transaction.repository.ts::settleByReservationId()`
     — el `UPDATE ... AND type <> 'PAYMENT'` hoy solo está verificado por
     assertion de string (`toContain`), no ejecutado contra una tabla
     real.
  2. `CustomerAccountService.recordPayment()`, rama sin `allocations` —
     que la transacción nueva (`transactionManager.run(...)`) haga
     commit/rollback de verdad; el `FakeTransactionManager` del test no
     ejecuta `BEGIN`/`COMMIT` real, solo invoca el callback.
  Se sacan de acá (se cortan, no se tachan) recién cuando alguien las
  corra contra Postgres real y confirme el resultado.

- **Bloque 3a — mecanismo general de reversa del ledger** (14/09/2026,
  commit `5ae9044`, gate `architecture-governor` APPROVED WITH CONDITIONS
  — código ya aplica las 2 condiciones de código, C1/C2; esta entrada es
  la condición 3 del mismo gate). `TEST_DATABASE_URL` sin definir en este
  entorno: el DDL de este bloque NUNCA corrió contra Postgres real — ni
  las 2 tenants de producción (Neon `ancient-king-17098519`,
  `br-snowy-tree-ax5wmq70`/`br-square-leaf-axzvu903`). **Corrección
  (`git fetch origin main` + `origin/main:src/platform/tenant-db.setup.ts`,
  14/09/2026): producción sigue en schema v52, NO v53** — `8f11d19`
  (el commit que bumpeó 52→53) tampoco está pusheado (`git branch -r
  --contains 8f11d19` vacío). El salto real que el próximo push+deploy
  produciría es **v52 → v54 en una sola corrida de `migrate:tenants`**,
  aplicando de una el DDL aditivo de `8f11d19` (`guest_payment_transaction_id`)
  y el primero DESTRUCTIVO de la serie (este bloque: `DROP COLUMN` +
  2 `ADD CONSTRAINT` con lock `ACCESS EXCLUSIVE` sobre
  `financial_transactions`) — no el salto de una sola versión que una
  lectura rápida del texto anterior insinuaba. Inferencia por git +
  `render.yaml` (corre `migrate:tenants` desde `main`, sin branch propia),
  no una lectura directa de `schema_migrations` — un `SELECT MAX(version)
  FROM schema_migrations` de solo lectura contra las dos tenants la
  confirmaría como hecho medido en vez de inferido, si en algún momento
  hace falta certeza total antes de autorizar el push.
  Verificaciones puntuales, no el bloque entero:
  1. Los 2 `CHECK` nuevos en `financial_transactions`
     (`chk_financial_transactions_reversed_not_self`,
     `chk_financial_transactions_reversed_transaction_type`) — el guard
     `pg_constraint` que evita revalidar en cada deploy nunca se ejecutó
     contra una tabla real; el `ADD CONSTRAINT` en sí (lock `ACCESS
     EXCLUSIVE` breve) tampoco.
  2. `ALTER TABLE accounts_receivable DROP COLUMN IF EXISTS
     reversal_transaction_id` — sin datos que perder por construcción (0
     call sites históricos en todo `src/`), pero el `DROP` en sí nunca
     corrió contra una tabla real.
  3. La aridad de los 2 `INSERT` de `SqlFinancialTransactionRepository::insert()`
     (camino idempotente 20 columnas/`$20`, camino plano 19
     columnas/`$19`) — contada a mano, verificada dos veces (por mí y por
     el gate), pero solo Postgres real prueba que los placeholders están
     en la posición correcta.
  La suite que cierra las 3 de una: `src/tests/integration/schema-redeploy-idempotent.integration.test.ts`
  (`skipIfNoDb`, hoy skippeada). Se sacan de acá (se cortan, no se tachan)
  recién cuando alguien las corra contra Postgres real y confirme el
  resultado.

---

## Hallazgos de diseño abiertos, registrados por el gate (15/09/2026)

La mayoría no requiere entorno real — ya confirmados por lectura de código,
quedan acá (no bajo "Verificaciones pendientes") porque lo que falta es una
decisión de diseño, no una corrida. **Excepción, desde F5-01 (15/09/2026):**
esa entrada SÍ tiene corrida real confirmada (suite de integración contra
Postgres, ver la entrada) — queda igual en esta sección porque lo que falta
después de esa corrida sigue siendo una decisión de diseño (cuál de los 3
caminos de fix tomar), no otra verificación.

- **`CUSTOMER-EMAIL-REQUIRED-001` — escape hatch residual (gate
  `architecture-governor`, bloque email obligatorio de `POST /customers`,
  `docs/decisiones-auditoria-fase3-2026-09-15.md` §2).** La decisión del
  dueño fue "email obligatorio, sin excepción — se elimina el alta
  solo-teléfono". El schema (`CreateCustomerSchema.email`, ya sin
  `.optional()`) lo cumple para el caso común. Pero
  `customers.routes.ts:625-637` sigue dejando que `contactMethods`
  explícito (array completo, precedencia ya existente desde antes de este
  bloque) prevalezca sobre `email` sin exigir que incluya un canal EMAIL
  — si un caller manda `contactMethods: [{channel:'PHONE',...}]` **junto
  con** el `email` que el schema ya exige, ese email pasa la validación
  pero nunca se persiste como `ContactMethod`, y el cliente queda creado
  sin ningún email real. El alta solo-teléfono sigue técnicamente
  alcanzable, solo que ahora exige mandar un email de relleno que el
  sistema ignora. **Sin caller real hoy** — el dashboard
  (`appfrontend/src/lib/clientes/api.ts::create()`) solo manda
  `{fullName, email}`, nunca `contactMethods`; es un escape hatch de API
  sin consumidor conocido. Pendiente decidir: ¿corregirlo (exigir un
  canal EMAIL dentro de `contactMethods` cuando ese array viene
  explícito) o aceptarlo como riesgo residual documentado? No se corrige
  en este bloque — el gate lo marcó como hallazgo separado, no como
  condición bloqueante.

- **`CANCEL-WITH-NC-UI-001` — advertencia de City Ledger en un toast no
  persistente (gate `architecture-governor`, bloque UI de cancelar con
  Nota de Crédito, repo `appfrontend-main`).** Cuando
  `reservationsApi.cancelWithCreditNote()`/`ordersApi.cancelWithCreditNote()`
  devuelven `accountsReceivableWarning` (hay traspasos a cuenta corriente
  todavía activos — plata que sigue debiéndose aunque la reserva/orden ya
  esté cancelada), `appfrontend-main/src/app/dashboard/reservas/[id]/page.tsx::submitCancelWithCreditNote()`
  y su espejo en `ordenes/[id]/page.tsx` lo muestran con el mismo toast
  de 4000ms fijo que cualquier notificación trivial
  (`appfrontend-main/src/context/ToastContext.tsx` — sin variante
  persistente/sticky). El propio código ya trata esta información como
  "no se puede ignorar" en su comentario, pero la UI no lo refleja.
  Pendiente decidir: ¿un banner persistente en la propia pantalla (no
  solo un toast), un modal de confirmación al ver la advertencia, o
  aceptar el toast de 4s como suficiente? No se corrige en este bloque
  — el gate lo marcó como seguimiento, no como condición bloqueante.

- **`F3-ID-COLLISION-001` — la etiqueta `F3-0N` significa cosas distintas
  en 4 documentos de auditoría (gate `architecture-governor`, 15/09/2026,
  al revisar `docs/auditoria-integral-fase3-2026-09-15.md` y su puntero
  de supersesión).** `docs/auditoria-integral-fase3-2026-09-15.md`
  (flujos: F3-01/F3-02 = cancelar-con-NC sin UI, F3-03 =
  `accounts-receivable/:id/reverse` sin consumidor, F3-04 = bandeja
  `credit-note-requests`) y
  `docs/auditoria-integral-fase3-grounding-2026-09-15.md` (mismo
  grounding, misma numeración) usan una serie; `docs/auditoria-integral-fase3-duplicacion-2026-09-15.md`
  (F3-01 = redondeo duplicado, F3-02 = doble rate-limiter, F3-03 = email
  obligatorio, F3-04 = tipos redefinidos a mano) y
  `docs/auditoria-integral-fase4-2026-09-15.md` (que cita esa segunda
  numeración en su §0) usan otra. Ningún documento nuevo la agrava —
  `docs/auditoria-integral-fase3-canonico-2026-09-15.md` y el puntero de
  supersesión de esta sesión desambiguan nombrando siempre el archivo
  fuente — pero la colisión en sí es preexistente y sigue sin resolverse.
  Pendiente decidir: ¿renumerar/prefijar por documento (ej. `F3-FLUJO-0N`
  vs. `F3-DUP-0N`) — bloque de docs aparte, toca 4 archivos y cambia
  identificadores que otros docs ya citan — o aceptar la colisión como
  riesgo residual siempre que cada cita nueva siga nombrando su fuente?
  No se corrige en este bloque — registrado como hallazgo, no como
  condición bloqueante de ningún commit ya hecho.

- **`F5-01` — token CUSTOMER del portal alcanza 4 rutas mutantes de STAFF
  sin guard de ownership (`docs/auditoria-integral-fase5-2026-09-15.md`
  §F5-01 + apéndice del gate; reproducido con corrida real contra
  Postgres, `src/tests/integration/customer-token-staff-route-ownership.integration.test.ts`,
  gate `architecture-governor` 15/09/2026).** Verificado en código y en
  runtime: `authenticate()` acepta un JWT CUSTOMER (cookie o header
  `Authorization: Bearer`, el login del portal devuelve el token en el
  body — `api/routes/customer.routes.ts:393,427,464`), `authorize(Roles.BOOKING)`
  lo deja pasar (`CUSTOMER_PERMISSION_GROUPS` incluye `BOOKING`,
  `security/roles.ts:81-84`), y `requireModule()` también. Las 4 rutas
  (`POST /api/reservations`, `POST /api/reservations/:id/schedule-request`,
  `POST /api/orders`, `POST /api/orders/:id/items`) no comparan
  `req.user.customerId` contra el dueño del recurso en ningún punto —
  `requireOwnReservation()` vive solo en `customer.routes.ts`, y ninguna
  de las 5 cercas RBAC existentes mira ownership dentro de routers de
  staff. Consecuencia si se explotara: un cliente del portal podría crear
  reservas y órdenes a nombre de otro cliente del mismo negocio, y agregar
  consumos a la orden de otro huésped.
  **Corrida real (15/09/2026, re-verificada por el gate con log de
  servidor):** hoy NO hay bypass de escritura — las 4 rutas devuelven 500
  antes de tocar la BD del tenant, por dos mecanismos distintos (caso 1:
  `TypeError` al derefenciar `req.db` indefinido en
  `reservations.routes.ts:369`; casos 2-4: throw explícito de
  `buildTenantTransactionManager`, `db/tenant-context.ts:78`, porque
  `tenantMiddleware` no fija `req.db`/`req.businessId` para tokens
  CUSTOMER — `platform/tenant.middleware.ts:193-196`, rama pensada para
  `/api/customer/*`). El test mide (no infiere) que ninguna fila nueva se
  escribe a nombre del cliente víctima, y deja el objetivo real (403 por
  ownership) como 4 `it.todo` — el 500 de hoy es un efecto colateral no
  diseñado, no una protección deliberada.
  Pendiente: decisión del dueño entre los 3 caminos de
  `docs/auditoria-integral-fase5-2026-09-15.md` §F5-01 punto 5 (guard de
  actor en el borde / guard de pertenencia por ruta / partir el grupo
  `BOOKING`) — **con la matriz de impacto ampliada** que apareció al
  gatear este bloque (ver ítem siguiente) cerrada primero, porque el fix
  obvio (poblar `req.db` para CUSTOMER) reabre el bypass de escritura en
  el mismo cambio que arreglaría el hallazgo de abajo.

- **`CUSTOMER-TOKEN-STAFF-ROUTE-500-001` — el mismo token CUSTOMER
  alcanza 9 rutas GET más por el mismo mecanismo, una con consumidor real
  roto en producción (encontrado por el gate `architecture-governor` al
  verificar F5-01, 15/09/2026, confirmado por camino de código — no
  observado corriendo contra producción).** 7 rutas GET con
  `authorize(Roles.BOOKING)` (`bookable-services.routes.ts:129,146,171,208,266`,
  `resources.routes.ts:342`, `business-hours.routes.ts:27`) y 2 GET de
  `categories.routes.ts` que no tienen `authorize()` en absoluto reciben
  el mismo token y el mismo 500 accidental que F5-01. `GET /api/bookable-services`
  tiene un consumidor real en `appfrontend-main`
  (`src/lib/customerApi.ts:221`, llamado desde
  `app/portal/[businessSlug]/cuenta/reservas/page.tsx:112,130`) que hoy
  recibe ese 500 y lo traga en silencio (`.catch(() => {})`) — el
  selector de servicios del portal de clientes queda vacío sin ningún
  error visible al usuario. Pendiente decidir junto con F5-01: el fix
  que arregla este consumidor (poblar `req.db` para tokens CUSTOMER en
  rutas de staff) es el mismo cambio que reabriría el bypass de escritura
  de F5-01 si se hace sin el guard de ownership antes o en el mismo
  commit — no se corrige en este bloque.

---

## ✅ Cerrado esta sesión (12/09/2026)

**Los ítems cerrados de este bloque se movieron a `docs/resuelto.md`**
(convención nueva del 12/09/2026 — ver `CLAUDE.md` raíz). Lo que tenía
residuo sin confirmar quedó en `## 🔍 Verificaciones pendientes`, más
arriba en este archivo. Queda acá solo la nota que sigue, que no es un
ítem cerrado sino el resumen de la revisión que abre la sección
siguiente:

- **Revisión del 🔴 "Bloqueado en decisión del dueño" — TERMINADA
  (12/09/2026, `auditor-circuitos-erp`, grounding vía `WebSearch`/`WebFetch`
  contra los 5 sistemas de referencia, con instrucción explícita del
  dueño de revalidar el grounding ya citado en el repo, no darlo por
  asentado).** Resultado, condensado — el detalle completo con cada
  ancla verificada vive en la sección nueva
  **"Reclasificación de 🔴 (12/09/2026)"**, inmediatamente después de
  este bloque: **de los 7 ítems que estaban en esa sección, 5 ya estaban
  resueltos en el código y la etiqueta no se había actualizado — 3 de
  esos 5 resultaron duplicados stale de ítems que ya tenían su entrada
  completa en `docs/resuelto.md`, cortados de acá el 13/09/2026 sin
  migrar de nuevo; quedan 2 visibles abajo, uno de ellos con una
  pregunta de negocio todavía abierta; 1 es una
  precondición técnica encadenada a `FACT-BORRADOR-001` (no una decisión
  sobre ESE ítem); y la intuición del dueño sobre
  `INVOICE-CHARGES-BUTTON-DEADEND-01` se confirmó, pero desplazada: el
  caso puntual está cerrado (para el staff), y lo que sí falta —
  confirmado con grounding en los 5 sistemas de referencia — es un
  circuito de producto entero: la mitad documental/financiera del
  portal de clientes, que `docs/roadmap-pms-multirubro.md` marca ✅
  Construido cuando solo la mitad de reservas lo está.**

---

## Reclasificación de 🔴 (12/09/2026, `auditor-circuitos-erp` + revalidación propia)

Los 5 hashes que cita el informe (`e02a4fb`, `c58b8f2`, `42c8611`, `844247b`,
`81e9eb2`) están **verificados por esta sesión contra `git log origin/main`**
— el subagente no tiene `git`, así que esto no lo hizo él. Confirmado:
`e02a4fb`/`c58b8f2`/`844247b`/`81e9eb2` en `app-main`, `42c8611` en
`appfrontend-main`. **Esto confirma "pusheado", no "deployado en
producción"** — mismo criterio del `CLAUDE.md` raíz sobre no declarar
estado de deploy como un hecho fijo del texto; si hace falta esa
evidencia, se pide en el momento (`/health/db`, log de `migrate:tenants`).

**4 ítems, causa real de cada uno (no la etiqueta que tenían) — eran 7,
3 se sacaron el 13/09/2026 por ser stale/duplicados** (`EMISOR_NOTA_CREDITO`
checkbox e `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` ya tenían su entrada
completa en `docs/resuelto.md`, cortados ahí; el ítem de
`ORDER-CONSOLIDATED-PARTIAL-01` de esta lista revalidaba anclas de un
pendientes YA VIEJO contra un ticket que este mismo archivo sigue
trackeando completo y más abajo, `## Backlog completo consolidado`,
todavía en HOLD de implementación — borrado, no migrado, para no marcar
"resuelto" algo que el propio archivo sigue teniendo abierto):

1. **`credit_note_request` la TABLA** — **no es una decisión sobre la
   tabla, es una precondición técnica encadenada a `FACT-BORRADOR-001`**
   (`docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:1651,2020`
   ya lo dice así — cerrado hoy con 0 preguntas propias, ver arriba). La
   cadena SÍ tiene decisiones de negocio genuinas sin responder, pero
   viven enterradas en `FACT-BORRADOR-001` §26.3, nunca
   promovidas a un pendientes — **mismo modo de falla que el `CLAUDE.md`
   describe ("se pudre lo que queda fuera de una categoría que alguien
   relee")**. Promovidas acá, con su ancla: presupuesto de reintentos de
   emisión, quién ve la cola de borradores, qué pasa con un borrador
   abandonado, qué pasa si el cliente del borrador se da de baja (la
   propia §26.3 lo marca *"verificar si es intencional"*), y cierre de
   caja sobre un borrador pendiente. Ninguna se responde en este bloque
   — quedan registradas para cuando se retome `FACT-BORRADOR-001`.

   **Actualización 13/09/2026 — las 5 preguntas de §26.3 tienen
   resultado.** Grounding a 6 sistemas (Odoo 16/18, ERPNext,
   india-compliance, Dolibarr, QloApps, OCA/pms — verificados en
   código real; Cloudbeds bloqueado por red, no usado como evidencia).
   `docs/diseno-factura-borrador-2026-08-31.md` sigue en **v2.11**
   (re-chequeado contra el propio encabezado del documento en el
   momento de escribir esto — no citar sin re-chequear la versión de
   nuevo si pasó tiempo).

   1. **Presupuesto de reintentos** — **CERRADA por consenso, no
      requiere al dueño.** No es un número, es una clasificación
      transitorio/terminal (Odoo `blocking_level`, ERPNext
      `Auto-Retry` vs. `Failed`). Este repo YA tiene el mecanismo de
      clasificación transitorio/permanente:
      `src/workers/outbox.worker.ts:451`,
      `classifyError(err) === 'permanent' ? 1 : this.maxRetries` (el
      `maxRetries=60` en sí vive en `outbox.worker.ts:219`, con su
      docblock en `:610` — la cita `:139-140` que §26.3 usa hoy es un
      ancla stale del propio documento de diseño, arrastrada acá sin
      corregir, a corregir en un commit de docs aparte).
      `EMISSION_BLOCKED` **no está implementado** — es el estado
      terminal que `docs/diseno-factura-borrador-2026-08-31.md` §5
      define para este mecanismo (`:52`, `:432`, `:445`, `:457`, `:501`,
      `:526`), todavía sin código en `src/`. El `maxRetries=60`
      aplica solo a asentar el `CHARGE` (paso transitorio, análogo al
      outbox) — **nunca** a la llamada a AFIP en sí: eso tiene que ser
      0 reintentos automáticos tras un rechazo confirmado, con
      reintento manual explícito (acción humana, como
      `action_retry_edi_documents_error` de Odoo).
   2. **Quién ve la cola de borradores** — **CERRADA por consenso:**
      rol de facturación, no mostrador/todo el staff. 2 de 3 sistemas
      de referencia ni tienen pantalla dedicada — el error vive en el
      documento mismo, con badge/filtro. No hace falta diseñar una
      pantalla nueva.
   3. **Borrador abandonado** — **CERRADA por consenso unánime (3/3):**
      ningún sistema caduca ni borra automáticamente un borrador. Se
      puede opcionalmente reportar por antigüedad — mejora sobre el
      estado del arte, no paridad: ningún referente lo hace, así que no
      vale citarlo como "así lo hace la industria".
   4. **Cliente dado de baja** — **DECIDIDA por el dueño vía
      `AskUserQuestion`, siguiendo la opción recomendada: "No bloquea
      nunca".** El borrador sigue vivo y emitible aunque el cliente se
      archive. Alineado con 2 de 3 referentes (Odoo/Dolibarr:
      "archivar ≠ borrar", ningún chequeo de partner archivado al
      emitir), con la regla ya existente de este repo
      (`docs/criterios-datos.md`, borrado≠pausado) y con que hoy YA se
      puede facturar a un cliente inactivo (no hay chequeo de
      `customer.active` en facturación). Divergencia notada pero
      descartada: ERPNext bloquea siempre (incluso retroactivo) con
      escape configurable por rol.
   5. **Cierre de caja con borrador pendiente** — **DECIDIDA por el
      dueño (14/09/2026, `FACT-BORRADOR-001` §26.3, ver el documento de
      diseño): solo advertir, no bloquear**, para el caso que el
      operador NO puede resolver solo (`ISSUED_PENDING_LEDGER`: ya
      emitido, cargo sin asentar) — el caso `DRAFT` ya estaba resuelto
      como "advertir". Sin respaldo externo (ningún sistema de
      referencia tiene precedente para ese estado específico) pero
      tampoco contradicción — mismo motivo que ya traía el diseño: el
      cajero no puede resolver un comprobante fiscal ya emitido, así
      que bloquear el cierre no ayuda.

   **Hallazgo transversal del grounding, no una de las 5 preguntas:**
   tres de las cinco respuestas de los sistemas de referencia NO viven
   en el documento de factura — viven en el cierre de caja
   (`src/clientes-finanzas/cash-register.service.ts::closeShift()`,
   líneas 104-124, hoy sin ninguna validación fiscal) y en el camino de
   baja de cliente. Si `FACT-BORRADOR-001` se implementa solo dentro de
   `src/facturacion/`, las preguntas 4 y 5 van a quedar sin dueño de
   código — advertencia de reparto de trabajo a tener en cuenta ANTES
   de partir esto en tareas, no después.

   Con esto, las 5 preguntas de §26.3 quedan cerradas: 1/2/3 por
   evidencia (no hizo falta volver a preguntarle al dueño), 4 y 5
   decididas por el dueño (13/09/2026 y 14/09/2026 respectivamente).

   **Actualización 14/09/2026 — el dueño también cerró §27.3** (destino
   de `POST /api/invoices`, el botón de un click que hoy crea Y emite
   en el mismo request): **se retira o redirige al flujo de borrador de
   3 pasos, no queda como bypass.** Cambio de contrato público, su
   propio bloque de trabajo y gate — no implementado acá. Con esto, de
   los bloqueantes de negocio que `FACT-BORRADOR-001` §28.3 listaba
   (C-1 a C-4 mecánicos, §26.3 × 5, §27.2 mecánico, §27.3), **solo
   quedaba uno sin decisión del dueño: `PN-2` (§21 del diseño)** —
   "¿la regla de cuenta corriente que puede rechazar la emisión (D1) es
   el booleano `customers.enable_current_account` por cliente, o un
   tope de crédito por tenant a construir?". **No estaba en la lista de
   bloqueantes de §28.3 del propio documento de diseño ni en el radar
   de ninguna sesión anterior de este archivo** — encontrada al
   verificar que no quedara ninguna otra pregunta de negocio abierta
   antes de declarar el diseño completo.

   **Actualización, mismo día (14/09/2026) — `PN-2` DECIDIDA por el
   dueño.** La condición es el booleano que ya existe,
   `customers.enable_current_account`, por cliente — **no** se
   construye un tope de crédito por tenant ahora. El dueño no descartó
   esa segunda idea: la declaró backlog futuro explícito (*"La feature
   nueva [tope de crédito] está bien pero no para ahora"*) — ver el
   ítem propio en `### 📋 Backlog de producto`, más abajo en este mismo
   archivo, para que no se pierda. **Con esto, `FACT-BORRADOR-001`
   (v2.13) no tiene ninguna pregunta de negocio abierta** — ver
   `docs/diseno-factura-borrador-2026-08-31.md` §21/§30.4 para el texto
   completo y las citas. El diseño sigue sin autorizar `CREATE TABLE`,
   migraciones ni código: falta el gate `architecture-governor`.

   **Actualización 14/09/2026, más tarde el mismo día (bloque de
   correcciones puntuales del gate, v2.15) — stale.** Esa última frase
   ("no tiene ninguna pregunta de negocio abierta") dejó de ser cierta
   el mismo día en que se escribió: la investigación del hueco de
   §17.3/§31.5 (una línea `MANUAL`/`STAY`-only de `invoice_draft_items`
   no tiene hoy forma válida de convertirse en una fila de
   `invoice_items` al emitir, y ni §29 la resuelve ni hay una forma
   técnica sin ambigüedad que no reabra el `chk_invoice_item_origin` que
   §17 ya cerró como no negociable) encontró que es una decisión de
   negocio genuina, sin decidir — formalizada como **PN-6**
   (`docs/diseno-factura-borrador-2026-08-31.md` §31.5, con la pregunta y
   las dos opciones completas). `FACT-BORRADOR-001` (ahora **v2.15**)
   vuelve a tener una pregunta de negocio bloqueante — mismo patrón que
   ya le pasó a este mismo ítem con PN-2 (línea 970 arriba: "no estaba en
   la lista de bloqueantes... encontrada al verificar"). No se reescribe
   el párrafo de arriba — se marca acá, mismo criterio de todo este
   archivo.

   **Actualización 14/09/2026, más tarde el mismo día — PN-6 ✅
   RESUELTA (v2.16).** El dueño decidió, en base al grounding ERP
   pedido a `auditor-circuitos-erp` (Odoo 17, ERPNext, Dolibarr,
   QloApps, Cloudbeds): se mantiene `chk_invoice_item_origin` sin
   relajar (postura A) — **condicionada** a construir §29 (Alternativa
   B, rama `SERVICE` de `item_type`, catálogo de servicios
   administrativos, precedente QloApps) como parte del mismo bloque de
   trabajo, no como deuda futura, siguiendo el principio ya declarado
   en `CLAUDE.md` (*"la app no le dice al cliente cómo trabajar..."*) y
   el precedente `CN-ESCAPE-ORPHAN-ADJUSTMENT-001`. El grounding fue
   4-a-1 a favor de permitir una línea sin producto de catálogo en el
   documento final, pero **ninguno** de los 5 sistemas de referencia la
   permite sin absolutamente ninguna coordenada obligatoria — la
   variante literal de la opción (2) del planteo original de PN-6
   (los tres orígenes en `NULL`, sin ninguna coordenada) **queda
   descartada, no solo pospuesta.** Detalle completo, con la tabla
   comparativa y la cita del veredicto, en
   `docs/diseno-factura-borrador-2026-08-31.md` §31.5 (y el resumen en
   §21). **Revisado además §29 completo (no solo §29.4): no está listo
   para implementación tal cual** — §29.5 deja 2 sub-decisiones sin
   resolver (qué entidad es el FK de la rama `SERVICE` nueva — un
   catálogo propio o `products` reutilizado con
   `requires_inventory = FALSE`; el relevamiento completo de sitios de
   `app-main` que asumen `item_type` exhaustivo en 3 valores, listado
   parcial ya en §29.4) — **candidatas a `AskUserQuestion` cuando se
   encare la implementación de §29**, no resueltas por esta ronda de
   documentación. Con esto, `FACT-BORRADOR-001` **no tiene ninguna
   pregunta de negocio abierta que bloquee el `CREATE TABLE`** — sigue
   sin autorizar `CREATE TABLE`, migraciones ni código: falta el gate
   `architecture-governor` sobre el diseño técnico completo.

   **Actualización 14/09/2026, más tarde el mismo día — las 2
   sub-decisiones de arriba ✅ RESUELTAS, vía `AskUserQuestion`.** El
   dueño decidió: **(1)** FK de la rama `SERVICE` = tabla nueva
   dedicada (nombre sin fijar, p. ej. `service_items`), no `products`
   reutilizado — mismo argumento que ya ganó para `RESERVATION`.
   **(2)** `confirmOrder()` saltea el `INSERT` en `stock_movements` para
   un ítem `SERVICE` — no hay producto/variante que mover. Texto
   completo en `docs/diseno-factura-borrador-2026-08-31.md` §29.5
   (v2.17). **Sigue sin resolverse** (paso mecánico, no de negocio) el
   relevamiento completo de sitios que asumen `item_type` exhaustivo en
   3 valores, listado parcial en §29.4 de ese mismo documento. Esto
   **sigue sin autorizar** `CREATE TABLE`, `ALTER TABLE`, migraciones ni
   código — falta el diseño real de la tabla nueva y el gate
   `architecture-governor`.

   **Actualización 14/09/2026, más tarde el mismo día — relevamiento
   mecánico ✅ COMPLETO (v2.18, §29.6 nueva).** Grep exhaustivo sobre los
   dos repos, superando (no solo complementando) el barrido parcial de
   §29.4/§29.5. **2 sitios nuevos** no cubiertos por ese barrido, los dos
   con forma de decisión de negocio escondida — **✅ RESUELTOS 15/09/2026,
   vía `AskUserQuestion`** (ver `docs/diseno-factura-borrador-2026-08-31.md`
   v2.20, §29.6 puntos 7/17: resolución server-side desde el catálogo
   nuevo, no a cargo del caller): `OrderService.resolveUnitPrice()`
   (`order.service.ts:546-556`) e `InvoiceService.resolveOrderItemLine()`
   (`invoice.service.ts:306-357`) — los dos son `if (itemType ===
   'RESERVATION') {...} else {...}`, no un `switch` exhaustivo, así que
   un ítem `SERVICE` caería silenciosamente en el `else` que hoy asume
   PRODUCT/PRODUCT_VARIANT. El segundo es el más serio: hoy produciría
   una línea de factura con la descripción literal `"Producto"` para un
   servicio, sin fallar de forma visible (antipatrón que
   `honest-degradation` pide evitar). También confirmado con evidencia de
   código (no solo inferido) que los 4 índices únicos parciales de
   `stock_movements` son inaplicables a `SERVICE` — nunca llega a existir
   una fila que lo referencie, por la Decisión (2) de arriba. Detalle
   completo, sitio por sitio (21 en `app-main`, 3 en `appfrontend-main`,
   sin sitios nuevos del lado frontend), en
   `docs/diseno-factura-borrador-2026-08-31.md` §29.6. Esto **sigue sin
   autorizar** `CREATE TABLE`, `ALTER TABLE`, migraciones ni código.
   `credit_note_request` la TABLA (bullet
   aparte, más abajo en este mismo archivo, ADR
   `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5/§10
   fila 1) sigue en HOLD por su propia decisión del dueño, no
   encadenada a PN-2 — no se toca acá.
2. **UI de `cancellation-refund/preview|confirm`** — **no es una
   decisión, es un circuito sin frontend.** Backend construido y con
   tests de integración (`reservations.routes.ts:589-618`,
   `Roles.FRONT_DESK`); `grep` sobre `appfrontend-main/src` para
   `cancellation-refund` → 0 resultados. El botón real de cancelar
   (`dashboard/reservas/[id]/page.tsx:615-621`) pega directo a
   `POST /:id/cancel`, sin paso de plata. Absorbido en "Circuito A" más
   abajo.
3. **Hueco de doble comprobante en `getInvoicedFinancialTransactionIds()`**
   — **✅ RESUELTO en las 3 direcciones**, confirmado contra
   `sql.invoice.repository.ts:1121-1138` (UNION) e
   `invoice.service.ts:368-374` (tercera dirección). **Pregunta de
   negocio que surgió acá — INVESTIGADA con grounding real
   (12/09/2026, `auditor-circuitos-erp`, vía `WebSearch`/`WebFetch`
   contra código público, revalidando lo ya citado):**
   `invoice.repository.ts:88-91` (índice real: `schema.sql:3227-3228`,
   `idx_invoice_charges_ft` único SIN `WHERE`) documenta a propósito que
   un cargo cuya factura CONSOLIDADA fue `REJECTED` queda bloqueado para
   re-consolidarse PARA SIEMPRE. **4 sistemas verificados en código +
   Cloudbeds vía índice de búsqueda coinciden: ninguno deja el cargo
   consumido para siempre por un comprobante que no llegó a existir**
   — ERPNext libera el cargo al
   cancelar el merge log (`consolidated_invoice = None`,
   `pos_invoice_merge_log.py`+`pos_invoice.py`, confirmado con cita
   verbatim), Odoo por `move_id.state != 'cancel'`
   (`sale_order_line.py`), Dolibarr con una figura propia — factura de
   reemplazo, `TYPE_REPLACEMENT`/`STATUS_ABANDONED` — que re-emite el
   contenido completo sin perderlo, QloApps con un `UPDATE` mutable
   sobre `order_detail.id_order_invoice` filtrado por estado, Cloudbeds
   liberando todas las transacciones al anular ("Void invoice and issue
   a credit note", vía índice de búsqueda — la página cruda está
   bloqueada por egress en esta sesión, sin verificar textual). El punto
   técnico común: **ninguno usa un índice único incondicional
   append-only como guard de "ya facturado"** — todos preguntan sobre el
   estado VIVO del vínculo, y ERPNext prueba que conservar rastro
   histórico y liberar el cargo no son excluyentes (el merge log
   cancelado se conserva; lo que cambia es el predicado).
   **Recomendación del grounding**: `idx_invoice_charges_ft` pasaría a
   índice único PARCIAL que excluya el status terminal-no-emitido,
   alineando esta rama con `INVOICE_STATUSES_CONSUMING_CHARGE` que la
   otra rama del mismo guard ya usa. Costo declarado, no oculto: es una
   migración de schema, y
   `tests/integration/consolidated-invoice-toctou.integration.test.ts:388`
   fija la asimetría actual A PROPÓSITO — ese test tiene que cambiar
   primero, deliberadamente. **Lo que el grounding NO resuelve, y queda
   para el dueño**: en los 5 sistemas la liberación la dispara un acto
   HUMANO explícito (cancelar, anular, validar el reemplazo) — acá
   `REJECTED` llega de AFIP sin acción del usuario. ¿Se libera
   automático al llegar el rechazo, o queda a la espera de una acción
   explícita tipo "liberar cargos para re-consolidar"? Hay precedente
   para la segunda (los 5 sistemas), no para la primera.
4. **`INVOICE-CHARGES-BUTTON-DEADEND-01`** — **✅ RESUELTO para el caso
   puntual (staff), confirmado**: `clientes-finanzas/customers.routes.ts:857-871` +
   `FacturarButton.tsx:140-158` + `facturacion/page.tsx:43,95-98,192-196`
   (commit `42c8611`, `appfrontend-main`). **Docblock stale encontrado y
   a corregir** (no en este bloque): `facturacion/page.tsx:14-20` sigue
   diciendo que el link no existe, 20 líneas antes de implementarlo —
   mismo patrón que el incidente "LOCAL/sin pushear" del 11/09 (texto
   escrito antes del cambio, nadie volvió). **La intuición del dueño era
   correcta a nivel de clase, no de este ítem puntual** — ver Circuito B.

### Circuito A — "Cancelar, devolver y anular" en el panel de staff (Parcial: backend Construido, frontend No existe)

Agrupa la UI de `cancellation-refund/preview|confirm` (ítem 2 de arriba)
con los dos que ya estaban en 🟡 más abajo (`POOL-MIXTO-MANUAL-01`,
frontend del ADR común cancelar-con-NC). Mismo circuito faltante, visto
desde permisos: `EMISOR_NOTA_CREDITO` ya es otorgable desde las 3
pantallas del frontend (cerrado, `docs/resuelto.md`) pero no habilita
ninguna acción visible — los 2 endpoints que lo exigen
(`POST /api/reservations/:id/cancel-with-credit-note`,
`POST /api/orders/:id/cancel-with-credit-note`) no tienen ningún
consumidor en `appfrontend-main` (`grep` → 0).
Endpoints construidos, cero consumidor de UI, medido por `grep`, no
estimado: `GET/POST .../cancellation-refund/preview|confirm`,
`POST .../cancel-with-credit-note` (reservas y órdenes),
`GET /api/invoices/unreconciled`. Superficie estimada: 0 tablas nuevas, 0
endpoints nuevos, ~3 pantallas (sección de plata en el detalle de
reserva/orden, bandeja de comprobantes no conciliados, manejo tipado de
los 409 que el backend ya emite). Sin impacto RBAC nuevo — los grupos ya
existen.

### Circuito B — Portal de clientes, lado documental/financiero (No existe)

**Esto confirma la lectura del dueño**, desplazada del ítem puntual (ya
cerrado) a la clase. Verificado: ningún endpoint de
`facturacion/invoices.routes.ts` es alcanzable por `Roles.CUSTOMER_ONLY`;
`api/routes/customer.routes.ts` no tiene ninguna ruta de folio/saldo/
comprobante (solo `register/login/availability/me/reservations`);
`appfrontend-main/src/app/portal` no tiene ninguna referencia a
factura/saldo/cuenta corriente/folio (`grep` → 0); no existe envío de
comprobante por mail (`email/templates.ts`, 4 plantillas, ninguna de
factura).

**`docs/roadmap-pms-multirubro.md:47-53` marca "Portal de clientes" ✅
Construido — mide solo la mitad de reservas y declara construido el
circuito entero.** No se corrige acá (el roadmap no se lee ni se edita
automáticamente, por regla del proyecto) — queda señalado para que el
dueño decida si pide la corrección.

**Grounding, 5 de 5 sistemas de referencia lo tienen** (fuentes
verificadas hoy, no reusadas sin chequeo): Odoo (`/my/invoices`,
`addons/account/controllers/portal.py`), ERPNext (`standard_portal_menu_items`,
`erpnext/hooks.py`), Dolibarr (módulo WebPortal **nativo**, no plugin,
con flags de habilitación por instalación —
`WEBPORTAL_INVOICE_LIST_ACCESS` — el precedente más cercano a
"configurable"), QloApps (facturas descargables desde el front-office,
gateadas por `PS_INVOICE` en `PdfInvoiceController.php` — detalle y
cita real en la pregunta 2 más abajo, que retira una cita previa de
esta misma sesión que no se pudo confirmar en código), Cloudbeds
(Guest Portal con resumen de folio y pago de saldo).

Superficie estimada: 0 tablas nuevas (el dato ya existe); 3-4 endpoints
nuevos en `customer.routes.ts` (`GET /me/invoices`,
`GET /me/invoices/:id/pdf`, `GET /me/account` o folio por reserva); 1-2
pantallas nuevas en el portal. Costo no trivial: cada ruta nueva con
`:param` de recurso dispara `RBAC-OWN-001` — hace falta un
`requireOwnInvoice()` análogo a `requireOwnReservation()`, más
sincronizar `EXPECTED_AUTHORIZE_CALL_SITES`, secciones 2 y 4 de
`docs/rbac-matriz-endpoints.md`, y `docs/inventario-rutas.md`.

**Dos decisiones de negocio nuevas que este circuito abre:**
- Un cargo de huésped facturado en la consolidada de una EMPRESA (City
  Ledger): ¿el huésped ve ese comprobante, o solo la empresa? (el cargo
  nace de la estadía, pero `invoices.customer_id` es la empresa —
  `AccountsReceivableService.transferStayBalanceToReceivable()`,
  `accounts-receivable.service.ts:211`, abre la cuenta por cobrar contra
  `input.companyCustomerId`; la factura consolidada real la crea
  `InvoiceService.requestConsolidatedInvoice()` con
  `customerId: input.companyCustomerId`, `invoice.service.ts:691`).
  **RESUELTA (13/09/2026) — decisión del dueño vía `AskUserQuestion`: "No
  lo ve nunca".** Respaldo: grounding a 4 sistemas (Odoo, ERPNext,
  Dolibarr, QloApps, los 4 verificados en código fuente real —
  Cloudbeds quedó bloqueado por red, no se usó como evidencia) con
  consenso unánime: la visibilidad del comprobante se resuelve por el
  SUJETO del documento (`partner_id`/`commercial_partner_id`/`fk_soc`/
  `id_customer` — la empresa), nunca por quién consumió el servicio, y
  ninguno de los 4 filtra por línea (es todo-o-nada: la empresa ve el
  comprobante completo o no lo ve, nunca una versión parcial recortada
  al huésped). Esto es **precondición de diseño**, no un fix sobre algo
  que hoy filtra mal — el Circuito B / portal documental sigue sin una
  sola ruta de comprobantes: `customer.routes.ts` tiene 0 matches de
  `folio`/`comprobante`, y los 3 matches de `invoice` (`:108`, `:242`,
  `:260`) son solo el wiring de `SqlInvoiceRepository` como dependencia
  de `ReservationService`, no una ruta de documentos. La decisión fija
  la regla ANTES
  de escribir la primera ruta (`GET /me/invoices`, etc.), para no
  repetir el patrón de D5 (`CLAUDE.md`, "Preguntas de alcance pueden
  esconder una decisión de negocio") de construir primero y decidir
  después.
- ¿El portal de comprobantes se habilita por tenant/módulo o viene
  siempre incluido con `FACTURACION`? **INVESTIGADA con grounding real
  (12/09/2026, `auditor-circuitos-erp`).** 4 de 5 sistemas tienen
  interruptor explícito — Dolibarr (`WEBPORTAL_INVOICE_LIST_ACCESS`,
  `webportal/admin/setup.php`, doble compuerta: módulo activo + flag),
  QloApps (`PS_INVOICE`, gateado en el propio endpoint
  `PdfInvoiceController.php`, no solo en el menú), ERPNext (`Portal
  Menu Item.enabled`, pero **solo apaga el ítem de menú** — la ruta
  sigue viva, gate real por rol/permisos — lección: ocultar el link NO
  es control de acceso), Cloudbeds (toggles por propiedad, empaquetado
  como producto aparte, "Guest Experience"). El único sin interruptor
  es **Odoo** — puro ACL (`ir.rule` + grupo portal), sin flag. **Cita de
  QloApps de una ronda previa NO se pudo confirmar (el "Show Group
  Invoices in Front Office" solo aparece en marketing, no en código) —
  se reemplaza por el `PS_INVOICE` real, verificado.**
  **Recomendación del grounding**: habilitarlo por tenant vía
  `requireModule` (ya existe en el repo), con el gate aplicado en las
  RUTAS nuevas de `customer.routes.ts` (no solo en el render del
  portal — si no, es ERPNext, no QloApps), y NO como feature de plan
  pago salvo que el dueño quiera monetizarlo a propósito (Cloudbeds es
  el único con incentivo comercial para eso). Multirubro es la razón de
  fondo: un tenant de barbería razonablemente no necesita exponer
  comprobantes en portal; un hotel con City Ledger sí. **Lo que el
  grounding NO decide**: si el flag es uno solo ("portal documental
  sí/no") o granular por tipo de documento al estilo Dolibarr — ahí no
  está claro que los módulos de este repo sean tan independientes entre
  sí como los de Dolibarr.

---

## Auditoría transversal — navegación, autogestión y reservas (12/09/2026, `auditor-circuitos-erp`)

Pedida por el dueño con 4 áreas puntuales, con grounding revalidado
contra ERPNext, Dolibarr, QloApps y **`frappe/hospitality`** (sistema
nuevo en esta sesión — módulo vertical de Frappe para hotelería,
**archivado desde el 04/10/2023**: sirve como referencia de MODELADO,
no de "estado del arte"; donde su modelo es más pobre que el de
`app-main` se dice explícito, no todo grounding termina en hallazgo
contra el repo propio).

**Dos cosas que la auditoría descarta, para que no se re-pregunten:**
no hay links rotos en el sidebar (las 21 entradas de `NavList.tsx`
apuntan a rutas reales, y viceversa); el circuito de check-in/check-out
de `app-main` (`stays`, con `checked_in_at`/`checked_out_at`/`no_show_at`
y un índice único parcial que impide dos estadías activas sobre la
misma reserva) es **superior** a las dos referencias hoteleras — ninguna
de las dos modela no-show ni quién hizo el check-in.

### Área 1 — Navegación / sidebar

- **"Admin BD" — atajo muerto, promocionado.** `NavList.tsx:154-158`
  (sin gate de rol) y un QuickLink del Home (`dashboard/page.tsx:292-295`)
  apuntan a una pantalla cuya única acción, desde el 19/08/2026, exige
  token de plataforma `SUPERADMIN` (`platform/admin.routes.ts:57`) — la
  funcionalidad real se mudó a `/superadmin`. Falla para el 100% de los
  usuarios del panel, incluido el OWNER. Una tercera copia
  (`appfrontend-main/src/app/admin/page.tsx`, ruta raíz `/admin`) no
  tiene ningún link entrante en todo el repo, lee el token a mano
  saltando `AuthContext`, y hardcodea un enum de recursos
  (`CABIN/RESTAURANT_TABLE/SPA/TOUR_SEAT`) que ya no existe en el
  dominio. `admin.routes.ts:8` ya dice que se puede borrar sin efectos
  secundarios.
- **Causa raíz compartida de varios síntomas — el sidebar gatea por
  NOMBRE de rol, no por grupo de permiso.** `useIsManagement()`
  (`hooks/useAuthRole.ts:14-17`) compara `user.role === 'OWNER' || 'ADMIN'`,
  pero `role` es el nombre LIBRE y editable de la fila de `roles`
  (`PUT /api/roles/:id` lo renombra). Consecuencia real: roles
  personalizados son una **feature paga** — un tenant que la compra y
  crea un rol "Gerente" con el grupo `MANAGEMENT` pierde del sidebar
  Usuarios y Roles aunque el backend lo autorice. El dato correcto
  (`BusinessContext.permissionGroups`) ya está en el navegador y ya se
  usa para otra cosa (`enabledModules`) — falta aplicarlo acá. Misma
  causa explica: **Mi Negocio** y **Empresa** visibles sin gate
  (`NavList.tsx:144-153`) para roles que el backend rechaza con 403 —
  es el mismo incidente D6 que el `CLAUDE.md` de `app-main` ya
  documentaba (regla 5 de "Pendientes — revalidar antes de arrastrar"),
  nunca corregido del lado del sidebar. Y "Empresa" tiene un gap de
  contrato adicional: `BusinessContext` no expone el plan del tenant —
  **corrección post-gate: no es que sea imposible gatear por plan, es
  que hoy no está en el contexto que `NavList` ya consume**. Sí existe
  `GET /api/business/plan-limits` (`{ plan, limits }`, deliberadamente
  sin `authorize(Roles.MANAGEMENT)`, con cliente ya tipado en
  `lib/negocio/api.ts:51`) — gatear el sidebar por plan hoy exigiría un
  fetch aparte a ese endpoint, o sumar `plan` al `BusinessContext` para
  no duplicar la llamada.
- **City Ledger operativo escondido dentro de "Reportes".**
  `dashboard/reportes/page.tsx:200-330` no es un reporte — tiene la
  política de facturación por empresa y un botón que **emite un
  comprobante AFIP real** ("Facturar ahora"). Su único link está
  gateado por `moduleKey: 'REPORTES'`, pero los endpoints que usa exigen
  `requireModule(CUENTAS_CORRIENTES)` — un tenant con uno de los dos
  módulos y no el otro pierde el camino de navegación o come 402 en el
  peor punto posible. Contradice además la convención de
  `appfrontend-main/CLAUDE.md` que excepciona `reportes` de Refine por
  ser "solo lectura".
- **Catálogos de POS separados de la transacción que los usa** (Motivos
  de Merma, Destinos de Consumo — un solo campo `name` cada uno) como
  ítems top-level del sidebar, cuando la transacción que los consume
  (`WasteModal`) vive adentro de Productos — el propio empty-state
  manda al usuario a "crear uno primero" en otra sección. Sidebar plano
  de 21 ítems bajo un único `<ul>`, sin agrupación — ninguno de los 3
  sistemas de referencia navega así por encima de ~10 entradas.
  `frappe/hospitality` subordina esto a nivel de datos: menú activo,
  serie de facturación y template de impuestos cuelgan del doctype
  `Restaurant`, no son entidades sueltas.
- **Tres catálogos manuales de navegación, ya con drift.** `NAV`,
  `PAGE_TITLES` (`dashboard/layout.tsx:51-72`) y `REFINE_RESOURCES`
  (`:34-48`) son listas paralelas de las mismas rutas. Facturación se
  agregó a `NAV` el 11/09/2026 y no a `PAGE_TITLES` — el breadcrumb de
  `/dashboard/facturacion` dice "Dashboard". Misma clase de deuda que
  el repo ya tiene documentada del lado backend (`ROLES-CATALOG-DRIFT-001`
  y afines).

### Área 2 — Autogestión de usuario (❌ el circuito no existe)

Ningún empleado puede ver ni editar su propia ficha — el bloque de
usuario del sidebar es un `<div>` no clickeable. `GET /api/auth/me`
tiene 3 rutas: GET, logout, refresh — **sin `PATCH`**. Todo `/api/users/*`
exige `MANAGEMENT` o más. Cambiar la contraseña propia requiere salir a
un flujo público de mail no autenticado (`/api/password-resets/*`),
como si el usuario no estuviera logueado — no existe "cambiar mi
contraseña con la contraseña actual". Frappe resuelve esto con un
scope explícito (`update_password` acepta clave de reset O contraseña
vieja verificada); Dolibarr tiene permisos de primera clase separados
(`user->self->creer`, `user->self->password`) — `app-main` no tiene
noción de "sobre mí mismo" en su modelo de roles.

**Contraste que vale la pena marcar**: el portal de cliente tiene la
asimetría inversa — `DELETE /api/customer/me` existe, no hay `PATCH`.
El cliente puede borrarse la cuenta pero no corregirse el nombre ni el
email.

### Área 3 — Autogestión de empresa/sucursal (⚠️ negocio bien, sucursal no)

- **"Mi Negocio" está bien resuelto** (identidad, fiscal AFIP,
  certificado cifrado, candado `OWNER_ONLY` sobre el perfil fiscal ya
  cargado) — observación menor: junta 4 dominios distintos en un
  singleton con un único gate `MANAGEMENT`.
- **`locations` (sucursales dentro de un tenant) — hueco de circuito
  real, no scaffolding muerto.** **Corrección post-gate, dos precisiones:**
  es FK `NOT NULL` de 3 tablas transaccionales (`resources`, `orders`,
  `inventory_levels`) — no 4: en `stock_movements` las tres columnas de
  ubicación (`location_id`, `from_location_id`, `to_location_id`) son
  NULLABLE, con `chk_stock_movements_location` imponiendo "exactamente
  una forma poblada" (TRANSFER exige el par `from`/`to`; el resto exige
  `location_id` solo) — el argumento de fondo se sostiene igual (toda
  fila de movimiento referencia al menos una `location`), solo cambia
  el mecanismo. Y la tabla `locations` tiene **5** columnas
  (`id, name, active, created_at, updated_at`), no 3 — ninguna de
  domicilio/teléfono/horario, que es lo que importa para el hallazgo.
  El CRUD no tiene `PUT`/`DELETE`, y en el
  frontend **`locationId` no existe — cero ocurrencias**. Consecuencia
  medida, no estimada: `docs/roadmap-pms-multirubro.md:237` declara
  **"✅ Transferencia entre depósitos — resuelto"**, y el endpoint
  existe con tests, pero con una sola ubicación sembrada y sin pantalla
  para crear una segunda ni para disparar la transferencia, la feature
  es inalcanzable para el usuario real — mismo modo de falla que el
  `CLAUDE.md` raíz ya advierte sobre el roadmap. Además:
  `business_profile.afip_sales_point` es único POR NEGOCIO, no por
  sucursal — bloquea multi-sucursal real en Argentina, no es cosmético.
  Y "sucursal" hoy significa dos cosas sin decidir: `locations` (fila
  dentro del mismo tenant) vs. `companies` (otro tenant vinculado,
  plan ENTERPRISE) — las dos mitades construidas, ninguna terminada.
  ERPNext separa esto de fábrica (`Company`, árbol, con series de
  numeración propias por compañía; `Warehouse` para el lado operativo,
  también árbol). QloApps tiene el modelo más maduro:
  `HotelBranchInformation` con horarios, dirección, políticas y
  **reglas de reembolso por propiedad**, propias de cada sucursal.
  `frappe/hospitality` está en la posición de hoy de `app-main`
  (`Hotel Settings` es un Single, un solo hotel por instalación) — pero
  es justamente el ejemplo de que el mismo equipo, al modelar
  Restaurant después, lo sacó del Single. **Decisión pendiente, no
  resuelta por el grounding**: ¿multi-sucursal se resuelve con
  `locations` dentro de un tenant, o con un tenant por sucursal
  agrupados por `companies`? Bloquea a cualquier cadena — hotelería,
  gastronomía, barberías/spa — no es de un solo rubro.

### Área 4 — Circuito de reservas: `app-main` vs. QloApps vs. `frappe/hospitality`

- **`reservations` no tiene `location_id`** (a diferencia de `orders`,
  que sí lo tiene) — hoy la sucursal de una reserva se deriva solo por
  join a `resources.location_id`; reasignar un recurso de ubicación
  re-atribuye retroactivamente TODAS sus reservas históricas, incluidos
  reportes ya cerrados. Latente mientras haya una sola `location`, se
  vuelve real el día que se resuelva el punto de Área 3. QloApps lleva
  `id_hotel` en la propia línea de booking, no solo por join.
  **Candidata a hallazgo.**
  — **verificar si es intencional, no es error obvio**: `reservations`
  snapshotea al cliente (`customer_name`/`customer_email`) pero NO al
  recurso — renombrar "Cabaña 3" reescribe la historia en listados y
  reportes. QloApps snapshotea agresivamente (nombre de habitación,
  tipo, hotel, dirección) en cada línea de booking. La asimetría dentro
  de la misma fila (sí para cliente, no para recurso) es lo raro, no
  necesariamente un bug.
- **Reserva por unidad concreta, no por tipo** (`resource_id NOT NULL`)
  — decisión de producto pura, con alternativa ya vigente (reasignación
  manual). `frappe/hospitality` es el extremo opuesto (reserva por tipo,
  sin habitación — defecto reconocido por el propio proyecto,
  `frappe/erpnext#16161`); QloApps hace las dos cosas a la vez
  (`id_product` + `id_room`, más `is_back_order` para overbooking
  deliberado) — el modelo hotelero maduro. Un hotel con unidades
  intercambiables no puede vender "una cabaña doble" sin comprometer
  cuál, lo que fragmenta disponibilidad. **No se resuelve acá — costo
  alto, decisión de negocio.**
- **Verificado y descartado como hallazgo (numerado 4.4 en el informe
  original del agente — agregado acá para no dejar el salto de 4.3 a
  4.5 sin explicar):** `adultos`/`ninos` (desglose de `party_size`) y
  `requested_check_in_time`/`requested_check_out_time` +
  `schedule_approval_status` + `schedule_charge_amount` (early
  check-in/late check-out con cargo y aprobación) ya están cubiertos en
  `app-main`, y comparados bien contra QloApps (que solo tiene
  `adults`/`children`/`child_ages`, sin el desglose de aprobación) y
  `frappe/hospitality` (que no cubre esto en absoluto — `late_checkin`
  es apenas un checkbox). Sin acción.
- **`bookable_services.booking_mode = 'event'`** — **corrección post-gate:
  la afirmación original de este ítem era falsa.** `'event'` SÍ está
  distinguido de `'block'`, ya implementado y ya decidido: en pricing
  (`reservation-pricing.service.ts:132-140`) `'block'` cotiza por noche
  (`calculateNights()`), `'slot'`/`'event'` cotizan como 1 unidad de
  precio plano; en agenda (`reservation-schedule.service.ts:39-46`)
  `'event'` queda excluido de la grilla de turnos, a mano por el
  organizador. Los dos puntos llevan el mismo comentario: **"decisión
  explícita, confirmada con el dueño, 18/08/2026,
  `docs/auditoria-modularidad.md` Fase 4"**. No requiere decisión — ya
  está tomada y documentada en el código hace más de 3 semanas. Sin
  hallazgo real acá.

### Tabla resumen (13 hallazgos + 1 descartado post-gate)

| # | Hallazgo | Tipo | Estado | Bloquea |
|---|---|---|---|---|
| 1.A | "Admin BD" en sidebar + QuickLink del Home → SUPERADMIN de plataforma; `/admin` raíz huérfano | UI | ❌ | confianza/ruido |
| 1.B | Sidebar gatea por nombre de rol, no por grupo — rompe roles personalizados (feature paga) | UI+circuito | ❌ | transversal, Planes y permisos |
| 1.B-bis | `BusinessContext` no expone el plan — gatear "Empresa" por plan exige fetch aparte a `GET /api/business/plan-limits` | gap de contrato | ❌ | Planes y límites |
| 1.C | City Ledger operativo dentro de "Reportes"; gate de nav ≠ gate de API | UI+decisión | ❌ | Caja/CxC/Facturación |
| 1.D | Catálogos de POS top-level, separados de su transacción; sidebar sin agrupar | UI+decisión | ⚠️ | POS, UX general |
| 1.E | 3 catálogos manuales de nav ya con drift (Facturación sin título) | UI | ⚠️ | — |
| 2.1 | Autogestión de usuario: circuito inexistente para staff | circuito | ❌ | transversal |
| 2.2 | Portal cliente: se puede borrar la cuenta, no corregir el nombre | circuito+decisión | ⚠️ | CRM |
| 3.1 | "Mi Negocio" junta 4 dominios en un gate único | UI menor | ⚠️ | — |
| 3.2 | `locations`: FK NOT NULL en 3 tablas + CHECK en `stock_movements`, CRUD incompleto, 0 en frontend, roadmap sobredeclarado | circuito+decisión | ❌ | multi-sucursal, todos los rubros |
| 4.1 | `reservations` sin `location_id`; reasignar recurso reescribe historia | UI+decisión | ⚠️ | latente hasta resolver 3.2 |
| 4.2 | `reservations` no snapshotea el nombre del recurso — verificar intención | decisión | ⚠️ | reportería PMS |
| 4.3 | Sin reserva por tipo de unidad, solo por unidad concreta | decisión | ⚠️ | hotelería de volumen |
| 4.4 | `adultos`/`ninos` + aprobación de check-in/check-out tardío — verificado, sin acción | — | ✅ verificado, sin acción | — |
| ~~4.5~~ | ~~`booking_mode = 'event'` sin semántica~~ — **descartado post-gate, afirmación falsa**: ya implementado y decidido (18/08/2026) | — | ✅ descartado | — |

**Fuentes externas** (repos públicos, rama `develop`/`main`, revalidadas
esta sesión — no reusadas de grounding previo sin chequear):
`frappe/frappe` (`core/doctype/user/user.{json,py}`,
`public/js/.../toolbar.js`, `desk/doctype/workspace/workspace.json`),
`frappe/erpnext` (`setup/doctype/company/company.json`,
[Company-wise Naming Series](https://docs.frappe.io/erpnext/company-wise-naming-series)),
`frappe/hospitality` ([repo](https://github.com/frappe/hospitality),
`hotels/doctype/hotel_room_reservation/`, `hotels/doctype/hotel_settings/`,
`restaurant/doctype/restaurant/`),
[`frappe/erpnext#16161`](https://github.com/frappe/erpnext/issues/16161)
(defecto reconocido, reserva sin habitación), `Qloapps/QloApps`
(`modules/hotelreservationsystem/classes/HotelBookingDetail.php`,
`HotelBranchInformation.php`), `Dolibarr/dolibarr`
(`core/class/menubase.class.php`,
[#11873](https://github.com/Dolibarr/dolibarr/issues/11873),
[#30523](https://github.com/Dolibarr/dolibarr/issues/30523)).

### Meta-hallazgo — esta ronda cubrió 4 áreas que el dueño nombró, no la superficie real de `app-main`

**Corrección de metodología pedida explícitamente por el dueño, para
dejar registrada antes de la próxima ronda**: esta auditoría arrancó de
4 áreas que el dueño señaló a mano (navegación, autogestión de usuario,
autogestión de empresa, reservas) — un método correcto pero parcial,
porque asume que el dueño ya sabe dónde mirar. **El método correcto,
declarado ahora como el que hay que seguir**: al revés — primero
enumerar la superficie REAL de dominios de `app-main` (no una lista de
memoria), y recién then, dominio por dominio, cruzarla contra qué
tienen y cómo lo resuelven los sistemas de referencia. Esta ronda no lo
hizo — quedó acotada a lo que el dueño pudo nombrar sin haber mirado el
código.

**Superficie real medida hoy** (prefijos de ruta reales de `app.ts`, no
una lista de memoria — 34 dominios/prefijos montados, algunos ya
tocados por esta ronda, la mayoría NO):

`login` · `customer` (portal) · `admin` (tocado, 1.A) · `invitations` ·
`password-resets` (tocado, 2.1) · `companies` (tocado parcial, 3.2) ·
`auth`/me (tocado, 2.1) · `business/modules` · `business/plan-limits`
(tocado parcial, 1.B-bis) · `resources` (tocado parcial, 4) ·
`locations` (tocado, 3.2) · `reservations` (tocado, 4) ·
`cancellation-policies` (**NO tocado**) · `customers` (**NO tocado** —
CRM de clientes en sí, distinto del portal) · `rate-catalog` (**NO
tocado** — tarifas especiales) · `users`/`users/invitations` (tocado
parcial, 2.1) · `roles` (**NO tocado** — la UX de administrar roles en
sí, más allá del bug de 1.B) · `categories` (**NO tocado**) ·
`products` (tocado parcial, 1.D) · `orders` (tocado parcial, 1.D) ·
`waste-reasons`/`consumption-destinations` (tocado, 1.D) ·
`bookable-services` (tocado parcial, vía 4 — el ítem 4.5 que citaba este
prefijo se descartó post-gate, ver arriba) · `business-hours` (**NO
tocado**) · `business-profile`(+`afip-credentials`) (tocado, 3.1) ·
`business/context` (tocado parcial, 1.B-bis) · `invoices` (tocado
parcial, vía 1.C) · `audit-log` (**NO tocado**) · `reports` (tocado
parcial, vía 1.C — el resto de los reportes NO) · `system` (**NO
tocado**) · `housekeeping` (**NO tocado — módulo entero**) ·
`maintenance-windows` (**NO tocado**) · `stays` (tocado — es la base del
circuito de check-in/check-out ya evaluado como superior a las
referencias, ver el párrafo de apertura de esta sección; NO cubre la
gestión operativa de housekeeping/mantenimiento que depende de él, esos
siguen sin tocar) · `accounts-receivable` (tocado tangencial, vía 1.C —
el circuito propio NO) · **`cash-register`** (**NO tocado — arqueo de
caja**, `requireModule(CUENTAS_CORRIENTES)`, `app.ts:387`; faltaba en
esta lista, agregado post-gate). Faltan además, fuera de `app.ts`, los
flujos de `/superadmin` (plataforma: aprovisionamiento de tenants,
planes de fábrica) — ni rozados por esta ronda.

**Cómo se retoma**: no re-lanzar "4 áreas más" a mano — la próxima
ronda debería tomar esta lista de 34 prefijos, agruparlos en dominios de
negocio reales (housekeeping, CRM/clientes, tarifas especiales,
administración de roles/permisos, reportería, mantenimiento, superadmin
de plataforma son los candidatos más grandes sin tocar todavía), y
recorrer cada uno contra los 5 sistemas de referencia — mismo criterio
de "existencia primero (Nivel 1), mecanismo después (Nivel 2)" que ya
se usó acá, pero disparado por la superficie real del código, no por lo
que a alguien se le ocurre nombrar.

---

## ✅ Cerrado esta sesión — arco transversal completo

**Movido a `docs/resuelto.md`** (4 ítems: FN#2 lock-order, EMISOR_NOTA_CREDITO
bloque 5.1, guard `isSystem` en `renameRole()`, polling adaptativo bloque 1).
El residuo sin confirmar de dos de ellos quedó en
`## 🔍 Verificaciones pendientes` más arriba (medir compute post-deploy del
polling); el fix estructural relacionado con el guard `isSystem`
(consumidores por `roles.name` en vez de `role.id`) se agregó como ítem
nuevo en `### 🟡 Listo para encarar`, más abajo en este archivo.

---

## Hallazgos nuevos, registrados por el gate — no corregidos en este bloque

Ninguno bloqueaba el cierre de arriba. Los cinco quedan para bloques
futuros, cada uno con su propio alcance.

- **`SCHEMA-ANCHOR-DRIFT-001` (09-10/09/2026, gate `architecture-governor`).**
  `f91d7ad` agregó +9 líneas netas a `src/db/platform.schema.sql` a
  partir de ~línea 285 (confirmado con 5 puntos de control:
  `245`→`245` ✓ intacto por debajo del corte, `286`→`295` ✓, `301`→`310` ✓,
  `782`→`791` ✓, `815`→`824` ✓). **Cualquier documento que cite una línea
  ≥285 de ese archivo quedó corrido en silencio** — nada en el repo lo
  detecta. Ya corregidas 5 anclas en `src/` (`14c5166`, `9d8ad1a`). Anclas
  todavía corridas, medidas por el gate (no arreglar sin releer el
  contexto de cada una primero — regla 2 de "Pendientes — revalidar
  antes de arrastrar"):
  - `docs/pendientes-2026-09-08.md:1129` (ahora corregida, ver arriba) —
    era `:782-786`, real `:791-795`.
  - `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md:684` —
    `:302-306`, real `:311-315`.
  - `docs/pendientes-2026-09-01.md:57` — `:307`, real `:316`.
  - `docs/erp-auditoria-v2/fichas/T02-usuarios-permisos.md:38,56` —
    `:286` y `:301`, reales `:295` y `:310`.
  - `docs/diseno-factura-borrador-2026-08-31.md:313` — `:266-284`, hoy
    cruza el bloque editado, real `:266-293`.
  - `docs/mapa-companies-vs-locations-2026-09-01.md:29-31` —
    `:815-820`/`:833-834`/`:836-837`/`:844-852`, reales
    `:824-829`/`:842-843`/`:845-846`/`:853-861`.
  - `docs/erp-auditoria-v2/hallazgos.csv:83` y
    `docs/erp-auditoria-v2/fichas/M14-plataforma.md:41,107,152` —
    `:950`, real `:959` (y ya apuntaba a una línea de comentario, no a
    `platform_audit_log`, desde antes de este drift — error separado).
  **La deuda de fondo, que vale más que la lista puntual:** toda edición
  de `platform.schema.sql` corre en silencio cada ancla numérica
  posterior de los dos repos, y hoy nada lo detecta. Ningún test la
  cubre. **DECIDIDO por el dueño (13/09/2026): disciplina manual, no
  cerca automática** — confirma lo que el propio hallazgo ya
  anticipaba ("probablemente no, el ruido sería alto"). Se sigue
  citando por NOMBRE, no por línea (convención ya adoptada en varios
  puntos de este mismo archivo desde este hallazgo, ej.
  `PLAN-LIMITS-SEED-REVERT-001` más abajo en esta misma lista), y se
  revisa a mano al tocar
  `platform.schema.sql`. Sin cerca nueva a construir.
- **`PRESET-GROUP-VALIDATION-001`** — código cerrado, pusheado y
  deployado, cortado a `docs/resuelto.md` el 13/09/2026. Residuo de
  verificación separado, con ancla, en `## 🔍 Verificaciones
  pendientes` (arriba): el `400` real contra las 2 rutas en producción
  sigue siendo inferencia, no ejercitado end-to-end.
- **`PRESET-REVOKE-001`** — Parte 1+2, resuelto entero, pusheado y
  deployado, verificado en producción; historia completa de diseño
  (2 rondas de HOLD, decisión del dueño) cortada a `docs/resuelto.md`
  el 13/09/2026. La deuda estructural que queda explícitamente fuera de
  alcance (consumidores por `roles.name` en vez de `role.id`/`is_system`)
  ya está trackeada aparte, ver "Consumidores de `roles.name`..." más
  abajo en `### 🟡 Listo para encarar`.
- **`PLAN-LIMITS-SEED-REVERT-001`** — ✅ **RESUELTO (11/09/2026, gate
  `architecture-governor`, APPROVED WITH CONDITIONS, todas cumplidas en el
  mismo commit).** Hallado 09-10/09/2026 al aplicar §4.0 sobre el diseño de
  `PRESET-REVOKE-001` -- mismo defecto, mismo archivo, tercera vez que
  aparece este par. Anchors de esta entrada YA estaban stale al momento de
  cerrarla (shift de +25 líneas por commits de facturación posteriores a
  esta sesión, ninguno tocaba este bloque) -- corregido citando por
  NOMBRE, no línea, desde `SCHEMA-ANCHOR-DRIFT-001` (mismo criterio que
  `roles-catalog-sync.test.ts` ya adoptó por la misma razón).
  El backfill de `max_custom_roles` (`src/db/platform.schema.sql`, los 3
  `UPDATE plan_limits SET max_custom_roles = ...`) y los `INSERT` de
  `plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`
  corrían INCONDICIONALMENTE en cada arranque, igual que el seed de
  presets antes de `PRESET-REVOKE-001` -- y los 3 tienen escritor real por
  panel (`PUT /platform/plan-limits/:plan` -> `updatePlanLimits()` en
  `platform.repository.ts`, `DELETE`+`INSERT`/`UPDATE` del set completo;
  UI de checkboxes en `appfrontend-main/src/app/superadmin/planes/page.tsx`,
  no tocado, fuera de alcance a propósito).
  **Consecuencia, no mecanismo**: destildar un grupo de permisos de
  FREE/STARTER en el panel de planes se revertía solo en el próximo
  reinicio del servidor -- el TECHO de autorización de roles CUSTOM se
  re-ensanchaba sin que nadie lo hubiera decidido. Más grave que el caso
  de presets: acá la reversión re-abría una restricción (fail-open), no
  reponía un default. Mismo defecto para `max_custom_roles=null` ("sin
  límite"): el panel lo acepta, pero el backfill lo revertía a 0/2/10 en
  el próximo arranque si empezó `NULL`.
  **Fix**: mismo mecanismo que `PRESET-REVOKE-001` -- reusa
  `platform_seed_markers` (ya existente), 3 seed_keys propias
  (`plan_limits_max_custom_roles`, `plan_limit_allowed_roles`,
  `plan_limit_allowed_permission_groups`). `src/db/platform.schema.sql`
  (los 3 seeds gateados + 2 docblocks actualizados),
  `src/tests/integration/platform-schema.integration.test.ts` (describe
  de primer nivel nuevo, 7 tests: primer arranque histórico, upgrade real,
  revocación pre-existente revierte una vez para `plan_limit_allowed_roles`,
  retención positiva al sacar un grupo de `plan_limit_allowed_permission_groups`,
  `max_custom_roles=NULL` revierte una vez y después persiste, semántica
  del vacío -- `PLAN-LIMITS-EMPTY-MEANS-ALL-001` de abajo --, idempotencia).
  29/29 tests del archivo en verde contra Postgres real
  (`TEST_DATABASE_URL`, Neon, `test-integration-db`), suite unitaria
  completa 2100/2100 (+1 skip +1 todo preexistentes), `tsc --noEmit` y
  `eslint` limpios. Mutation testing manual, 6 mutantes (sacar el
  `WHERE NOT EXISTS`/`AND NOT EXISTS` de cada uno de los 3 sitios + sacar
  el `INSERT` de cada marca), cada uno puesto en rojo un test nombrado y
  revertido antes de commitear -- evidencia completa en el mensaje del
  commit. Condiciones del gate cumplidas en el mismo commit: docblock de
  `plan_limits` corregido (el invariante "las 3 filas se seedean siempre
  juntas" ya no es cierto para un plan `BusinessPlan` nuevo agregado a
  futuro -- documentado con la mitigación), test de semántica del vacío
  (C2, ver arriba), anchor de `platform.repository.ts` citado por nombre
  (C3), ítem `PLAN-LIMITS-EMPTY-MEANS-ALL-001` abierto abajo (C5).
  **Pendiente antes de deploy (C4, NO del commit)**: medir divergencia
  real en producción (4 SELECT read-only sobre `plan_limits`/
  `plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`/
  `platform_seed_markers`) -- si hay divergencia, el primer arranque
  post-deploy la revierte una vez y hay que decirle al dueño qué fila se
  va a pisar ANTES de deployar. No medido en esta sesión -- local, sin
  push, sin deploy.
  **Runbook reconciliado, en 2 pasadas** (`fe60917` + este commit, gate
  `architecture-governor`, hallazgo del cierre "GROUP VERIFIED" --
  encontrado dos veces, la segunda DENTRO de la corrección de la
  primera): `docs/conocimiento/runbook-deploy-render.md` describía
  `platform_seed_markers` como si gatéara una sola seed_key
  (`role_preset_permission_groups`) y decía "borrar la marca no ayuda,
  pero tampoco hace daño" -- desactualizado desde `0a72f0f`, que sumó 3
  seed_keys más. `fe60917` enumeró las 4 y agregó, para las 3 nuevas, que
  borrar la marca NO es solo inútil sino PELIGROSO (re-ensancha un techo
  de autorización revocado, fail-open) -- a diferencia de
  `role_preset_permission_groups`, que sí tiene su break-glass reescrito
  más arriba en el mismo runbook. El gate encontró DOS defectos en
  `fe60917` mismo: (a) afirmaba "desde el 11/09/2026 gatea CUATRO" como
  hecho de producción cuando `0a72f0f` (las 3 seed_keys nuevas) no está
  pusheado -- solo `cd4dff6` (la primera) está en `origin/main` -- mismo
  patrón de "estado de push como hecho fijo del texto" que este mismo
  archivo prohíbe más arriba (nota de precisión: no es solo `cd4dff6` --
  `18a3c93`, la segunda mitad de la misma reconciliación de
  `PRESET-REVOKE-001` (cerrado, ver `docs/resuelto.md`), también está en
  `origin/main` -- re-chequear con `git merge-base --is-ancestor <hash>
  origin/main` antes de asumir cualquiera de los dos, en vez de confiar en
  esta nota); (b) el "ver más abajo" que citaba en su momento no
  resolvía a nada (nada de seeds bajo esa línea en las 600 del archivo).
  Este commit corrige los
  dos: el runbook ahora describe lo que el código DEFINE (por nombre, no
  por fecha ni línea) y remite a `SELECT seed_key FROM
  platform_seed_markers ORDER BY seed_key` como única fuente autoritativa
  del estado real de una instalación puntual -- verdadero antes y después
  de cualquier deploy futuro, sin necesidad de reescribir esta nota de
  nuevo.
- **`PLAN-LIMITS-EMPTY-MEANS-ALL-001`** (11/09/2026, gate
  `architecture-governor`, condición C5 de `PLAN-LIMITS-SEED-REVERT-001`
  de arriba, `requiere decisión del dueño`, NO implementado). Consecuencia,
  no mecanismo: destildar TODOS los grupos de permiso de un plan en el
  panel de superadmin (`appfrontend-main/.../planes/page.tsx`) lo deja SIN
  RESTRICCIÓN ('ALL') en vez de SIN PERMISOS -- al revés de
  `role_preset_permission_groups` (0 pares = ese preset no puede nada,
  fail-closed), acá 0 filas en `plan_limit_allowed_permission_groups` se
  lee como 'ALL' (fail-open, `PlatformRepository.getPlanLimits()`).
  Alcanzable por UI: `UpdatePlanLimitsSchema` no exige mínimo. Antes de
  `PLAN-LIMITS-SEED-REVERT-001` esto se autorreparaba por accidente en el
  próximo reinicio (mismo bug que el resto del archivo); desde ese commit,
  con el seed gateado, un vaciado deliberado persiste de verdad -- correcto
  para el caso frecuente (destildar UNO), pero saca la red que existía
  para el caso "los 5 a la vez". `.min(1)` en el schema sería incorrecto
  (PRO/ENTERPRISE tienen 0 filas legítimamente). Decisión del dueño: ¿UI
  que confirme explícitamente "sin restricción" al vaciar el set, un
  mínimo distinto de 1, o aceptar el fail-open como está?
- **`PRESET-SAVE-ECHO-001`** — código cerrado en 2 rondas, pusheado y
  deployado, cortado a `docs/resuelto.md` el 13/09/2026. 2 residuos
  separados, con ancla, en DOS secciones distintas: residuo (a)
  (verificación funcional con credenciales de superadmin) en `## 🔍
  Verificaciones pendientes` (arriba); residuo (b) (test de integración
  que todavía no existe -- no es código listo esperando confirmación,
  es ingeniería nueva) en `### 🟡 Listo para encarar` (más abajo). El
  hallazgo de paso sobre
  `SqlReservationRepository.save()`/`syncLines` (mismo barrido de
  impacto, distinto de este ítem) ya está trackeado aparte, ver esa
  entrada también en `### 🟡 Listo para encarar`.
- **`SUPERADMIN-CONTRAST-001`** (09-10/09/2026, gate
  `architecture-governor`, hallado incidentalmente al verificar que el
  bloque de advertencia nuevo renderizara bien). Pre-existente, NO
  introducido por esta sesión: `/superadmin/roles-de-fabrica` (y
  probablemente otras pantallas `/superadmin/*` con el mismo patrón)
  usa markup legado de panel oscuro (`text-white`, `text-slate-400`)
  sobre el `--bg` real de `:root` (`#F5F4EF`, blanco cálido — la
  polaridad V2 de ZULU Hub, que `/superadmin` no compensa porque no
  aplica `.zulu`/`.zulu-shell-dark`). El `<h1>` y el subtítulo quedan
  casi ilegibles. Calculado por el gate, no medido en navegador —
  confirmar visualmente antes de priorizar el fix.

---

## Deuda estructural grande, investigada esta sesión — arrastrada con anclas corregidas

Estos dos ítems venían de `pendientes-2026-09-08.md` (#24 y #25) y se habían
caído del arrastre a este archivo cuando se abrió (mismo modo de falla que
el incidente del roadmap del 25/08 — el único doc que se relee al empezar
sesión no los tenía). Investigados a fondo esta sesión: research ERP
(`auditor-circuitos-erp`, ERPNext + Odoo) → diseño propuesto → gate
`architecture-governor`, que **rechazó el diseño propuesto** y autorizó
solo un test de caracterización.

- **`REFUND-ISSUED-RACE-01`** — Block A: medido con test de
  caracterización (`b6ed750`, **pusheado desde antes de esta sesión,
  está en `origin/main`**). **Corrección 10/09/2026, tarde**: Block B
  (abortar con 409) ya se implementó encima y convirtió esos mismos 2
  tests de caracterización a spec -- ya no documentan el defecto, prueban
  el fix. Ver el bloque `✅ implementado` más arriba.
  (`src/tests/integration/refund-issued-race.integration.test.ts`,
  gate 09-10/09/2026, Block A). `InvoiceService.finalizeIssued()` →
  `markIssued()` (`src/facturacion/sql.invoice.repository.ts:814-825` —
  **no `:718-728`**, esa cita estaba corrida) es el único escritor de
  `invoices.status='ISSUED'`, corre por el pool sin transacción, después de
  AFIP. `CancellationRefundService.confirmRefund()` vive en
  **`src/reservas/cancellation-refund.service.ts`** (**no**
  `src/facturacion/` — esa cita también estaba corrida) y lee
  `issuedInvoices` en `:189`, dentro de su transacción. Si una factura
  `PENDING` de la reserva pasa a `ISSUED` en la ventana entre esa lectura y
  el COMMIT, el monto cae a `:sin-asignar` en vez de atarse a la factura
  real, y si es consolidada, evade el fail-closed de 3.1
  (`ReservationOnConsolidatedInvoiceError`) sin aviso. **Las 2 variantes
  ahora están medidas contra Postgres real** (antes: "No medido en
  producción"), no solo inferidas.
  - **Diseño RECHAZADO por el gate**: el bracket de 2 transacciones (patrón
    N1.a, el que sí usa `cancel-reservation-with-credit-note.service.ts`)
    no aplica -- `confirmRefund()` no tiene ninguna llamada de red que
    bracketear, y aplicarlo igual reabriría 3 guards ya cerrados
    (BRECHA-REFUND-01 Fase 3, O2F2-B, FOR-KEY-SHARE-001). Re-lockear la
    reserva tampoco sirve: `markIssued()` nunca toca `reservations`, mismo
    lock-sin-efecto que un gate anterior (08/09) ya había rechazado.
  - **Forma correcta identificada, no implementada todavía**: ensanchar el
    `FOR UPDATE` existente (`:261-263`) para cubrir también las facturas
    `PENDING`, no solo las `ISSUED` -- `getRefundableForUpdate()` ya es
    status-agnóstico (`sql.invoice.repository.ts:201`). **Bloqueado a
    propósito**: si `markIssued()` blocked-then-throws, la excepción sale
    **sin capturar** de `issue()` (`invoice.service.ts:1087` — no
    `:945`, esa cita también estaba corrida) y la factura queda `PENDING`
    con un CAE real ya emitido en AFIP -- `retryExisting()` la trataría
    como "segura para reintentar" y pediría un **segundo CAE para el mismo
    cargo**. Hay que blindar ese camino de falla ANTES de ensanchar el
    lock.
  - **Pregunta de negocio — ✅ RESPONDIDA (10/09/2026, decisión del dueño,
    grounding ERPNext/Odoo)**: si una factura llega a `ISSUED` a mitad de
    un refund, ¿el resultado correcto es (i) abortar con 409 reintentable,
    o (ii) atar el reembolso a la factura recién emitida? Se eligió (i) --
    ver el bloque `REFUND-ISSUED-RACE-01 Block B` más abajo, ya
    implementado, pusheado y deployado. **Corrección 11/09/2026**: esta
    viñeta seguía diciendo "todavía sin `AskUserQuestion`" -- quedó sin
    actualizar cuando se decidió, mismo tipo de drift que las 2 entradas
    "LOCAL/sin pushear" corregidas arriba en esta misma revisión.
  - **Corrección retractada (gate architecture-governor, 09-10/09/2026):**
    una versión anterior de este bullet decía "`DB_POOL_MAX` es 10, no 5 --
    varios documentos citan `max:5`, stale". Eso conflacionaba dos pools
    distintos y estaba MAL -- son los 6 documentos citados los que tenían
    razón, no esta corrección. Hay dos pools separados en el repo: el de
    PLATAFORMA (`src/db/pg.client.ts:94`, `max: parseInt(DB_POOL_MAX ?? '10')`,
    detrás de `getPlatformRawPool()`) y el de CADA TENANT
    (`src/platform/tenant.middleware.ts:105`, `max: 5` hardcodeado, sin env
    var, uno por negocio). `confirmRefund()` corre sobre el pool de
    TENANT -- confirmado en `src/reservas/reservations.routes.ts:164-174`,
    `buildCancellationRefundService(req)` usa `req.db` +
    `buildTenantTransactionManager(req)`, nunca el pool de plataforma. Los
    `max: 5` citados en `pendientes-2026-09-03.md:497`, `-09-05.md:816`,
    `-09-06.md:136`/`:138`, `-09-08.md:507`/`:1091` y
    `zulu-hub-continuidad-2026-09-08.md:167` (la dimensión de
    `POOL-STARV-001`) son correctos y no estaban stale -- no re-abrir esa
    dimensión a partir de esta nota.
- **Residual B-1 / "3.2-b"** — sigue abierto, sin tocar en este bloque.
  Diagnóstico angostado por el research: el camino de `recordPayment()` CON
  `allocations` ya es correcto y transaccional -- no hace falta tocarlo.
  Solo el camino SIN `allocations` (`customer-account.service.ts:139`,
  `this.financialRepo.create({...})` suelto por el pool) necesita
  transaccionalizarse -- gap mecánico, no de diseño, reusando
  `createIdempotentPaymentWithClient` (NO un `createWithClient` armado a
  mano -- el camino con idempotencia nula releía por el pool dentro de una
  tx sería el mismo aliasing hazard ya documentado en
  `cancellation-refund.service.ts:345-354`). `lockById()` (la primitiva que
  se había diseñado en una sesión anterior) es **prematura** -- ningún
  camino real crea un `PAYMENT` en `PENDING` contra una reserva todavía.
  `settleByReservationId()` (`sql.financial-transaction.repository.ts:280-289`)
  es un interferente dormido -- el tripwire propuesto por el research
  ("alertar si actualiza >0 filas") es RUIDO, no señal, porque settear
  `CHARGE`/`ADJUSTMENT` en `PENDING` es el trabajo normal de ese handler;
  la forma correcta es agregar `AND type <> 'PAYMENT'` al `UPDATE`
  (arregla la interferencia en vez de solo vigilarla).

**`REFUND-ISSUED-RACE-01` Block B — ✅ implementado, PUSHEADO Y
DEPLOYADO en producción (10/09/2026, gate `architecture-governor`).**
**Corrección 11/09/2026**: esta entrada decía "LOCAL/sin pushear" -- ya
no es cierto, quedó sin actualizar cuando se pusheó. Verificado con
`git log origin/main`: el commit `6b9a23b` ("REFUND-ISSUED-RACE-01
Block B -- abortar si el set de facturas ISSUED cambia antes del
commit") está en el historial remoto, ancestro directo de `68e0153`
-- cuyo deploy (`dep-dahlnhgjo6nc73dg1qqg` = `live`) ya se confirmó con
evidencia real en la entrada de `OUTBOX-RETRY-HIST-01`/`OUTBOX-BACKOFF-01`
más arriba. Un deploy de Render sube el `HEAD` completo, no un diff --
desplegar `68e0153` desplegó `6b9a23b` con él. Decisión del dueño con
grounding ERP (ERPNext lock optimista, Odoo lock pesimista + precondición
de estado -- los dos convergen en abortar, ninguno recalcula/ata en la
misma operación): **abortar con 409 reintentable**, code propio
`REFUND_INVOICE_SET_CHANGED` (no reusa `REFUND_BASE_CHANGED` -- el log de
producción solo emite `code`, nunca `message`, A7.1; reusar mezclaría dos
carreras distintas en una sola métrica e inutilizaría `0 warns
REFUND_BASE_CHANGED` como evidencia ya citada de `BRECHA-REFUND-01-B`).
Extiende el bloque `BRECHA-REFUND-01-B` existente (`cancellation-refund.service.ts:379-422`)
con un guard hermano: relee `issuedInvoices` por el pool justo antes del
COMMIT y aborta si aparece una factura que no estaba en la foto inicial.
Predicado compartido extraído (`isReversibleIssuedInvoice()`) entre la
foto inicial y el re-chequeo. 2 tests de integración convertidos
in-place (de caracterización a spec, con aserción de rollback real +
convergencia del reintento) + 2 tests unitarios nuevos con cobertura en
CI (`ShiftingIssuedInvoicesRepository`, mismo patrón que
`ShiftingCollectedRepository`). Mutación M1/M2 corrida y confirmada con
sets de rojo disjuntos (M1: 1 test; M2: 10 tests, sin solape). `tsc`/
`eslint` limpios. **Corregido 10/09/2026, tarde -- ya se corrieron los 2
tests de integración**, contra Postgres real (Neon, branch de test
`test-integration-db` del proyecto tenant): pasan los dos, con las 3
aserciones completas (rechazo, rollback real -- 0 filas `REFUND`
commiteadas --, e interferencia commiteada). Reintento converge en los
dos casos: directa ata `reversedInvoiceId`, consolidada choca con
`ReservationOnConsolidatedInvoiceError`. Y no son 539 tests, es la suite
COMPLETA del proyecto: **2047 passed, 1 todo, 160 archivos** (`npm run
test`). **Residual de cobertura en CI, declarado:** los 2 tests de
integración NO corren en el pipeline de CI (necesitan `TEST_DATABASE_URL`
a mano) -- en CI, toda la protección de este guard descansa en el único
test unitario nuevo que sí corre ahí. Si ese test se borra o se ablanda,
CI no lo va a atrapar.

**⚠️ ESTRECHA, NO CIERRA `REFUND-ISSUED-RACE-01`**: bajo READ COMMITTED,
la ventana entre el SELECT del re-chequeo y el COMMIT sigue descubierta
-- un `markIssued()` que commitea justo en esa ventana milimétrica sigue
sin detectarse. Mismo límite declarado que (c) del guard hermano de
`collected`. No presentar esto como "cerrado" en ningún doc futuro.

**Próximo bloque, no autorizado todavía**: la mitad NO tocada de
`REFUND-ISSUED-RACE-01` (blindar el camino de falla de `markIssued()`
antes de poder ensanchar el `FOR UPDATE`, si algún día se revisita la
opción B rechazada) y la residual B-1 (transaccionalizar + el filtro de
tipo en
`settleByReservationId()`).

---

## Documentales — correcciones in-place

- `pendientes-2026-09-06.md:1104` ("`superadmin/roles-de-fabrica/page.tsx:60-62`
  ... es falso") — ✅ tachado y marcado RESUELTO in-place, referencia acá.
- `pendientes-2026-09-08.md:1137-1155`, `:1201-1205`,
  `plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md:228`,
  `zulu-hub-continuidad-2026-09-09.md:213-225` — los 4 punteros que
  decían "sigue abierto"/"LOCAL sin pushear" reescritos in-place a
  "cerrado, verificado en producción" (`7cee110` para push, este archivo
  para el estado post-deploy).

---

## Backlog completo consolidado (10/09/2026, tarde)

Todo lo que seguía abierto en `pendientes-2026-09-08.md` -- leído entero,
sección por sección. Marcado explícito lo que esta sesión SÍ revalidó
(cerrado o con ancla corregida) contra lo que se arrastra tal cual estaba
(ancla vieja, sin re-chequear). Agrupado igual que el archivo de origen.

### 🔴 Bloqueado en una decisión del dueño

> **Reclasificada hoy — ver "Reclasificación de 🔴 (12/09/2026)" al
> principio de este archivo.** Los 7 ítems que seguían abiertos en esa
> sección quedan como registro histórico (no se borran de acá abajo),
> pero su clasificación real ya no es la que dice este heading — 5
> estaban resueltos (3 de ellos duplicados stale de ítems ya cerrados en
> `docs/resuelto.md`, cortados de la reclasificación el 13/09/2026 sin
> migrar de nuevo — quedan 2 visibles ahí), 1 es precondición técnica, y
> el último desplaza la pregunta a un circuito de producto. No usar esta
> sección para saber qué está bloqueado hoy — ni los 7 reclasificados ni
> ningún otro bullet suelto que todavía diga 🔴 más abajo. En
> particular, `INVOICE-CHARGES-GUARD-INDIVIDUAL-01` (uno de los 3
> duplicados de arriba) ya cerró del todo, ver `docs/resuelto.md`.

- **Caso 3, residuo Q2 — reconciliación de City Ledger con montos
  `PENDING` transferidos — DECIDIDO (13/09/2026).**
  Ancla: `accounts-receivable.service.ts::transferStayBalanceToReceivable`
  (docblock del método -- sin pin de commit, mismo criterio de cita por
  firma que el resto de este bullet; el docblock se actualizó de nuevo en
  `9c051d6` para reflejar esta decisión). Desde el fix de
  `getNetBalanceByStayId()` (caso 3,
  `docs/investigacion-decisiones-bloqueado-2026-09-12.md`),
  `transferStayBalanceToReceivable` puede transferir un saldo que
  todavía no es final (un `ADJUSTMENT` `PENDING` que recién liquida en
  `reservation.completed`). Si después de transferir algo ajusta el
  saldo de la estadía hacia abajo (o la reserva se cancela), el folio
  del huésped puede quedar negativo mientras la empresa ya recibió el
  `CHARGE` completo `SETTLED` por el monto viejo. Esto ya no queda sin
  ninguna barrera: el guard del Bloque 6 §9.1 (`d75296a`, extendido en
  `b09555a`) SÍ bloquea `transferStayBalanceToReceivable()` cuando algún
  `CHARGE` de la estadía ya tiene una factura `ISSUED` viva al huésped —
  lo que sigue sin cubrir es acotado al caso de un `ADJUSTMENT`
  `PENDING` sin comprobante emitido todavía, que es el que este residuo
  Q2 trata. El fix de `checkOut()` (Q1, sí decidido) es inseparable de
  este cambio de comportamiento porque comparten la misma función.

  **Decisión del dueño (`AskUserQuestion`, 13/09/2026 -- grounding ERP ya
  registrado en §2/§3 del diseño, no nuevo de esta ronda: Cloudbeds/Odoo/
  ERPNext/Dolibarr unánime en los 4 aplicables, QloApps sin city ledger
  corporativo): no bloquear la transferencia ni construir reconciliación
  automática -- ningún sistema de referencia hace ninguna de las dos
  cosas. Construir `reverseTransfer()` + detección.** El mecanismo YA
  está diseñado completo, no es diseño nuevo:
  `docs/diseno-reconciliacion-city-ledger-2026-09-12.md` §4.3
  (`AccountsReceivableService.reverseTransfer()`, cita por firma del
  método, no por línea -- mismo criterio que
  `CITY-LEDGER-GUARD-ADR-ANCHOR-DRIFT-001` más arriba en este archivo),
  §4.5 (detección por EXISTENCIA de AR no-terminal asociada + log
  estructurado en los 2 handlers de outbox -- **no** es todavía una
  comparación de montos (`ar.amount` vs. saldo vivo recalculado): esa
  comparación, si hace falta, queda como diseño a completar dentro del
  Bloque 3, no algo ya resuelto en §4.5), secuenciado en §8 en 6 bloques.
  **El Bloque 1 (schema v52, estado `REVERTIDO`) YA ESTÁ IMPLEMENTADO Y
  PUSHEADO** -- `b82d828`, en `origin/main`; `CURRENT_SCHEMA_VERSION = 52`
  en `tenant-db.setup.ts`, CHECK de 4 valores en `schema.sql`. Lo que
  sigue pendiente es Bloque 2 (`reverseTransfer()` + ruta + RBAC + tests
  -- el union TS `AccountsReceivableStatus` en los 2 repos va con este
  bloque, ya registrado como `ACCOUNTS-RECEIVABLE-STATUS-REVERTIDO-TS-001`
  más arriba en este archivo, no se repite acá) y Bloque 3 (la detección
  de §4.5, puede ir junto con el 2 o separado).

  **Precondición declarada antes de dar el Bloque 2 por completo -- los
  3 hallazgos de §7.2 no comparten el mismo tratamiento: el que toca
  código fuera de `AccountsReceivableService` lleva gate propio (texto
  del diseño, §7.2): "un cambio sobre una ruta que emite documentos
  fiscales reales merece su PROPIO gate, no se resuelve como efecto
  colateral de este bloque".** Son 3 hallazgos de concurrencia
  documentados en §7.2, no 2: **(a)** `voidByReservationId()` (worker de
  outbox, `handleReservationCancelled`) puede anular el MISMO `CHARGE`
  original al `VOIDED` en el mismo instante en que `reverseTransfer()`
  corre -- dos reversas del mismo cargo; requiere `SELECT ... FOR UPDATE`
  sobre la fila `financial_transactions` del `CHARGE` original, dentro de
  la transacción de `reverseTransfer()`. **(b)** los dos caminos de
  emisión de factura AFIP --
  `InvoiceService.requestConsolidatedInvoice()` (`UPDATE` best-effort
  post-emisión que no loguea si no afecta ninguna fila) e
  `InvoiceService.finalizeIssued()` (ni siquiera un `UPDATE`, un `if` en
  memoria que simplemente no entra) -- pueden emitir un CAE real de AFIP
  contra un cargo que `reverseTransfer()` ya revirtió, CERO rastro en
  logs, porque ninguno de los dos caminos toma el lock de
  `reverseTransfer()` sobre la fila AR. Los tres no comparten alcance:
  **(a)** el diseño pide el lock "DENTRO de la transacción de
  `reverseTransfer()`" -- código de `AccountsReceivableService`, mismo
  servicio del Bloque 2, sin gate aparte. **(b)** toca el camino de
  emisión AFIP en `InvoiceService` -- fuera de
  `AccountsReceivableService`, y ese sí lleva su propio gate, tal como
  dice la cita de arriba.

  **§7.8 -- DECIDIDO (13/09/2026, `AskUserQuestion`):** el panel de
  cuentas por cobrar de una empresa (`listByCompany()`/
  `getByCompanyCustomerId()`) muestra las filas `REVERTIDO` tal cual,
  mezcladas con el resto, con su estado visible -- no se esconde que
  hubo una corrección. No se agrega ningún parámetro de filtro nuevo al
  contrato HTTP de listado (se descartó filtrar por default o exigir un
  toggle). El tratamiento visual distinto (badge/color en vez de solo
  texto de status) queda como decisión de UI de `appfrontend-main`, a
  resolver junto con el Bloque 2 -- **no** "cuando llegue la pantalla":
  la pantalla que consume `listByCompany()` YA EXISTE hoy
  (`appfrontend-main/src/app/dashboard/reportes/page.tsx`); lo que sigue
  sin fecha es la pantalla para DISPARAR la reversa (`POST
  /:id/reverse`, decisión distinta, §3.6/punto 5 de §7 del diseño). Esa
  pantalla de listado tiene hoy `AR_STATUS_LABEL` con solo 3 claves --
  sin ampliar ese `Record` y el union TS junto con el Bloque 2, una fila
  `REVERTIDO` real se renderiza con la celda de estado VACÍA, lo
  contrario de lo que esta decisión pide. Anclado en
  `ACCOUNTS-RECEIVABLE-STATUS-REVERTIDO-TS-001` más arriba en este
  archivo -- ampliada en este mismo commit para incluir
  `AR_STATUS_LABEL` de `reportes/page.tsx` como segundo artefacto
  cross-repo del mismo concepto (y, tras una segunda ronda del gate, los
  3 sitios adicionales de comparación que esa misma pantalla ya tenía).

  **Actualización 13/09/2026, sesión posterior -- Bloque 3 dejó de ser un
  solo bloque.** Se partió en 3a (`handleReservationCancelled`) y 3b
  (`handleReservationCompleted`), porque no comparten mecanismo (§4.5 del
  diseño, actualizado): **3a IMPLEMENTADO** (commit `d48a6e8`, detección
  por existencia de AR no revertida, filtro `!== 'REVERTIDO'`, `COBRADO`
  incluido a propósito; verificación contra Postgres real todavía
  pendiente, `CITY-LEDGER-BLOQUE3A-INTEGRATION-VERIFY-001` más arriba en
  este archivo). **3b -- IMPLEMENTADO** (commit `c9b1fd2`, mecanismo
  diseñado en §4.6 del diseño: detección por existencia no sirve para
  `handleReservationCompleted` -- dispara siempre, toda reserva de City
  Ledger normal llega a `completed` con una AR `PENDIENTE_FACTURAR`
  colgada -- el mecanismo real compara `round2(getNetBalanceByStayId(stayId))`
  contra cero DESPUÉS de `settleByReservationId()`, no `ar.amount` fila
  por fila; verificación contra Postgres real todavía pendiente,
  `CITY-LEDGER-BLOQUE3B-INTEGRATION-VERIFY-001` más abajo en este mismo
  bloque).

  **Lo que sigue pendiente, sin implementar todavía:** solo Bloque 2
  (`reverseTransfer()` + ruta + RBAC + tests + sync cross-repo + los 3
  hallazgos de concurrencia como precondición). Con §7.8 ya decidido, no
  queda ninguna decisión del dueño pendiente que bloquee su arranque --
  queda para su propio bloque de implementación con su propio gate.

  **`CITY-LEDGER-BLOQUE3B-INTEGRATION-VERIFY-001`** -- el path de
  detección de divergencia de monto en `handleReservationCompleted`
  (commit `c9b1fd2`) nunca corrió contra Postgres real. Cubierto por 12
  tests unitarios (mocks, `src/workers/outbox.handlers.test.ts`), pero ni
  el wiring real (`SqlAccountsReceivableRepository`/`SqlStayRepository`)
  ni un saldo real movido fuera de cero se ejercitaron. Comparte sesión
  de verificación con `CITY-LEDGER-BLOQUE3A-INTEGRATION-VERIFY-001` (más
  arriba en este archivo) pero es una acción distinta, con un fixture
  estrictamente más grande: (1) transferir el saldo de una estadía a una
  empresa (`transferStayBalanceToReceivable()`), (2) un segundo
  `confirmPriceAdjustment()` que mueva el saldo real fuera de cero
  DESPUÉS de esa transferencia, (3) completar la reserva
  (`completeReservation()`), (4) confirmar el log estructurado `evento:
  reservation_completed_ar_divergencia` con el `balance` esperado.
  Acción puntual: correr `npm run test:integration` con
  `TEST_DATABASE_URL` configurada, agregando ese caso -- se corta de acá
  (no se tacha) recién cuando alguien lo corre y confirma el resultado
  real.

- ~~`REFUND-ISSUED-RACE-01`, Block B~~ — ✅ **RESUELTO 10/09/2026** (decidido:
  abortar con 409; implementado, verificado contra Postgres real,
  `FEATURE VERIFIED` por el gate. Ver el bloque de arriba en este mismo
  archivo). La mitad NO tocada (blindar `markIssued()` para poder
  ensanchar el `FOR UPDATE`) sigue abierta, sin decisión pendiente --
  bloque propio.
- **`SCHEMA-ANCHOR-DRIFT-001` — ✅ RESUELTO, ACOTADO (10/09/2026, gate
  `architecture-governor`, `d7268f3`+`6b235e0`+`9cad495`, pusheado y
  deployado -- `dep-dahh842jnfac73ddhhtg`, `live` confirmado en Render,
  CI verde incluido `schema-version-check` corriendo por el camino real
  no solo el fallback).** Decisión del dueño con grounding ERP (ni
  ERPNext ni Odoo citan por número de línea dentro del propio repo --
  nombre de archivo/método/constraint, o SHA de commit para código
  externo; 1 solo caso de línea numérica en ~2M líneas revisadas):
  citar por nombre, no por línea. **Resuelto SOLO para esta clase
  exacta:** 0 anclas de línea a `schema.sql`/`platform.schema.sql` en
  `src/` de los dos repos, verificado por `grep` directo (no inferido) —
  y el propio bloque volvió a autoinfligirse 2 veces mientras estaba
  abierto (4 anclas por `d7268f3`, 2 más por `8fc30c3` aterrizando en
  paralelo), la 4ª y 5ª aparición del patrón, ambas corregidas hacia
  adelante en el mismo bloque, ambas verificadas con el mismo método.
  **Lo que sigue abierto, con número medido, no una estimación:**
  ~42 anclas `archivo.ts:N` (a OTROS archivos `.ts`, no a los schemas)
  en `src/` de `app-main` -- esta cifra se mueve sola con el desarrollo
  normal, no se congeló; ~102 anclas en `docs/erp-auditoria-v2/fichas/`
  (ya gobernadas por `validar-anclas.py`, blind spot documentado en
  `00-programa-v2.md` §4.2); ~158 en docs fechados históricos
  (`diseno-*`, `pendientes-*`, `mapa-*` -- deuda declarada, no se
  re-fecha retroactivamente); 31 en `hallazgos.csv` (derivado, se
  regenera solo). **Próximo bloque, no autorizado todavía:** una cerca
  que falle si aparece una ancla NUEVA de línea a cualquiera de los dos
  schemas en `src/` -- baseline 0, allowlist vacío, sin el problema de
  ruido que hacía inviable la cerca cuando el baseline era 78% stale.
- **`credit_note_request` la TABLA** — sigue en HOLD, decisión del dueño
  sin cambios (ADR §6.5/§10 fila 1). Ver
  `diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`. **La
  bandeja** (la parte de este mismo bloque que SÍ se resolvió, sin tabla
  nueva) **se cortó a `docs/resuelto.md` el 13/09/2026** —
  `InvoiceRepository.listUnreconciledLiveInvoices()` +
  `GET /api/invoices/unreconciled`, commits `49372b0`→`65f9c45`.
- **UI de `cancellation-refund/preview\|confirm`** (#6-A4, circuito C2
  de plata) — D2-diferido, decisión de roadmap explícita, no
  follow-up automático del ADR.
- **`EMISOR_NOTA_CREDITO`, checkbox en `roles-de-fabrica`** (bloque B) —
  la precondición (copy corregida y verificada en producción) YA se
  cumple desde hoy. Listo para su propio gate de diseño cuando se pida.
- **W2, `cancellation-refund.service.ts:271`** — ✅ **medido 10/09/2026**:
  0 filas de divergencia entre `invoice.customerId` y
  `reservation.customer.id` en REFUNDs reales, en las 2 tenants
  (`SELECT ... FROM financial_transactions ft JOIN invoices i ON
  i.id=ft.reversed_invoice_id WHERE ft.type='REFUND' AND
  ft.customer_id<>i.customer_id`, Neon `ancient-king-17098519`, branches
  `production`=Demo + `tenant-hotel-los-alamos`=Hotel los Álamos --
  **las dos son datos de práctica ficticios** (memoria del proyecto:
  "Tenant DBs are test data"), no clientes reales; "0 divergencia" acá
  es más débil que si fuera producción real con tráfico genuino). No
  urgente -- no hay bug manifestándose hoy. Sigue como deuda de diseño
  (el código no lo garantiza estructuralmente, solo no divergió todavía
  en los datos de práctica).
- **`ORDER-CONSOLIDATED-PARTIAL-01`** — **DECIDIDO (negocio) + HOLD
  (implementación), 11/09/2026.** Pregunta de producto que este bloque
  dejaba abierta -- ✅ **RESPONDIDA con grounding ERP** (Cloudbeds,
  Odoo, ERPNext, QloApps vía `auditor-circuitos-erp` +
  `AskUserQuestion` al dueño con el trade-off completo): sí, se va a
  soportar cancelar con NC una orden específica dentro de un comprobante
  consolidado multi-orden, atribuyendo la NC solo a esa orden. Evidencia:
  ERPNext tuvo el mismo bug exacto (PR real `frappe/erpnext#46277`, crea
  una NC separada por cada POS Invoice original al consolidar) y QloApps
  ata la devolución a una reserva/booking específica (`id_htl_booking` en
  `order_return_detail`/`order_slip_detail`). Cloudbeds -- el único de
  los 4 con evidencia clara en sentido contrario ("the invoice cannot be
  canceled partially") -- fue mostrado igual antes de decidir. Odoo
  inconcluso.

  **Mapeo de código, re-verificado por el gate (anclas corridas,
  corregidas):**
  1. `cancel-order-with-credit-note.service.ts:290-291` -- el `ADJUSTMENT`
     del escape de órdenes SIEMPRE lleva `reservationId: null`. Válido.
  2. `invoice.service.ts:824` -- la rama "pair" de `buildCreditNote()`
     exige `tx.reservationId != null` -- un ADJUSTMENT de orden nunca
     entra ahí. Válido.
  3. `invoice.service.ts:864-877` (throw en `:874`) -- cuando ese
     ADJUSTMENT llega a la rama restante sin ser reversión total, el
     código tira (`N1.a`). Válido **como texto, pero inalcanzable para
     este caso** -- ver bloqueo real más abajo.
  4. ~~Hallazgo "row huérfana" (`tx1` commitea el ADJUSTMENT antes del
     throw)~~ -- **REFUTADO por el gate**: el test
     `cancel-order-with-credit-note.service.test.ts:204-210`
     (`expect(ft.rows.size).toBe(0)`) prueba que no queda nada
     commiteado. No hay row que limpiar -- el hazard estructural que
     describía (tx1 commitea antes de que `buildCreditNote()` corra fuera
     de transacción) es real en general, pero no se materializa en este
     camino.
  5. **Bloqueo real, no mapeado en la primera ronda -- encontrado por el
     gate, 12 líneas antes del hallazgo #1, mismo archivo:**
     `cancel-order-with-credit-note.service.ts:223-226` --
     `getChargeIdsForInvoice()` (UNION `invoices.financial_transaction_id`
     + `invoice_charges`) devuelve N>1 cargos para una consolidada
     multi-orden, y el guard tira `CreditNoteMultiInvoiceError` **antes**
     de llegar a la parte que este bloque investigaba originalmente
     (`:286`, dentro de la misma transacción `tx1`, `:185-326`). El throw
     de `invoice.service.ts:874` (hallazgo #3) es código muerto para este
     camino -- está guardado río arriba.
  6. `invoice_items` no tiene `order_id` directo, solo `order_item_id`
     (FK a `order_items.id`) -- confirmado, y **más preciso de lo que se
     había dicho**: el gate verificó que el JOIN
     `invoice_items.order_item_id → order_items.order_id` es estable
     (`order_items.order_id` nunca se actualiza en `src/pos-menu/`, y el
     `ON DELETE SET NULL` no puede orfanar una línea facturada sin violar
     `chk_invoice_item_origin` primero) -- **no hace falta columna nueva
     ni bump de `CURRENT_SCHEMA_VERSION`**, alcanza con el JOIN. Además,
     la query de tope por par (`getInFlightCreditNoteTotalForPairForUpdate`,
     `sql.invoice.repository.ts:591`) NO necesita el JOIN -- filtra sobre
     la transacción reversora, que ya trae `order_id` directo. Solo el
     lado de ATRIBUCIÓN necesita el JOIN.
  7. Corrección semántica: el guard de `:223-226` está etiquetado "N2.a"
     en el código, pero **no lo es** -- ADR §6.5/N2.a (línea 274 del ADR
     común) exige cardinalidad 1:1 NC↔factura, y una NC de orden granular
     sigue apuntando a una sola factura. Lo que `:223-226` enforcea de
     verdad es el §5 ("órdenes es todo o nada", línea 394 del ADR) -- la
     regla que esta decisión efectivamente amiende. Ojo al actualizar el
     ADR: no reabrir N2.a por error.
  8. Grounding adicional ya existente en el ADR (línea 476, hallazgo
     previo de `auditor-circuitos-erp` del 08/09) que sostiene la forma
     de la solución: ERPNext no proratea nada porque cada línea ya sabe
     su FK de origen -- solo el desglose de IVA congelado
     (`afip_request.Iva[]`) necesita redistribuirse por grupo de tasa,
     que es exactamente lo que `resolveRefundableForPair()` ya hace.

  Las órdenes SÍ soportan facturación consolidada multi-orden
  (`InvoiceService.requestConsolidatedInvoice()`, `invoice.service.ts:505`
  y `:570`) -- confirmado.

  **Estado (actualizado 11/09/2026, segunda ronda de gate): bloque 1a
  ✅ IMPLEMENTADO** (`629fb27`,
  `refund-attribution.ts` generalizado sobre clave de atribución opaca,
  behavior-preserving, 217/217 tests de facturación sin regresión,
  `credit-note-escape-containment.test.ts` verificado que sigue sin
  tocarlo). Nombres de campo (`reservationId`) NO renombrados a
  propósito -- renombrarlos hubiera tocado los 2 callers de producción,
  fuera de alcance de 1a; el rename real queda para 1c. **1b/1c/1d
  siguen en HOLD** -- la matriz de impacto rehecha encontró 8
  ubicaciones más no mapeadas originalmente, la más grave un numerador
  de F4 (`sql.invoice.repository.ts:443-454`,
  `getIssuedCreditNoteCompensationTotalForReservation`) que SÍ necesita
  el JOIN (a diferencia del tope por par, que no). El ADR de órdenes NO
  reafirma todo-o-nada como doctrina -- solo excluye el caso del alcance
  de un bloque anterior (ver ADRs reconciliados, `3aa04ef`). Query de
  producción sobre facturas consolidadas multi-orden reales: sigue sin
  correr (sin credenciales/tools de Neon en esa sesión del gate).
  **`REFUND-ATTRIBUTION-RESIDUAL-001` — ✅ RESUELTO (11/09/2026, gate
  `architecture-governor`, `df7abc0`).** Hallazgo NO
  buscado, real, en código YA en producción (encontrado al escribir los
  tests de 1a): `distributeGroupAmount()` (`refund-attribution.ts`)
  calculaba el residuo de redondeo contra `frozenAmount` COMPLETO en vez
  de contra la porción de los ítems CON clave -- si una consolidada
  mezclaba un ítem sin clave (origen orden) y uno con clave (origen
  reserva) en el MISMO grupo de tasa, el residuo le atribuía TODO el
  monto del ítem sin clave a la clave presente, no un centavo (medido:
  2420 en vez de 1210, el doble). Vivo desde el bloque 3.3-a (08/09/2026).
  **Cambio de comportamiento real, no solo refactor**: antes del fix,
  una consolidada reserva+orden a la misma tasa hacía que
  `InvoiceService.buildCreditNote()` SIEMPRE tirara
  `CreditNoteAttributionMismatchError` (el ledger real nunca coincidía
  con la atribución inflada) -- la NC parcial de esa reserva era
  imposible de emitir. Ningún dinero salió mal atribuido a AFIP antes
  del fix -- el guard de mismatch contenía el error fail-closed
  (síntoma: "no se puede emitir", no "se emitió mal"). **Medido,
  read-only, las 2 tenants reales** (Neon `ancient-king-17098519`,
  11/09/2026): 0 facturas `ISSUED` mezclan `invoice_items` de origen
  reserva y de origen orden en el mismo grupo de tasa en ninguna de las
  2 -- el fix fue preventivo, nadie estaba bloqueado hoy por este bug.
  4+1 tests nuevos/reescritos + evidencia de mutación (revertir solo la
  línea del fix pone en rojo exactamente esos tests, aplicada y
  revertida sin commitear). Suite completa 2123/2123 (+3), arquitectura
  30/30 sin cambios. **Desbloquea el bloque 1c de
  `ORDER-CONSOLIDATED-PARTIAL-01`**, que sigue sin autorizar aparte --
  ver ese bullet más arriba.

  **Bloque 1c -- HOLD (11/09/2026, ronda de gate del diseño de 1c).** No
  rechazado: reseteado por un hallazgo no mapeado por ninguna ronda
  previa (§4.0). El resto del diseño cierra limpio -- ver detalle de
  cada punto en los bullets siguientes, en el orden que el gate los
  resolvió.

  - **`:360` (la línea que más preocupaba, "settlear TODAS las
    charges de la consolidada, no solo la orden que se cancela")
    -- resuelta, sin diseño nuevo.** El precedente de reservas
    (`cancel-reservation-with-credit-note.service.ts:524-527`) ya
    congela el conjunto de charges en `frozenChargeIds` en tx1 y nunca
    re-deriva en tx2 -- mismo código-comentario cita exactamente este
    riesgo. Para órdenes es más simple (CHARGE único por orden, índice
    v45): el conjunto congelado es el singleton `{charge.id}`, la
    re-derivación en `:360-361` se elimina y el guard cardinal
    (`:223-226`) se relaja a una comprobación de membership.
  - **Rename `reservationId` → clave neutra -- DIFERIDO, no forma
    parte de 1c.** 1a asumió (`refund-attribution.ts:79-82`) que 1c
    tocaría los 3 productores y podría hacer el rename ahí junto con el
    wiring. Falso: 1c-ii solo toca `buildCreditNote()`;
    `resolveReservationPairAttribution()` (producción, reservas) no
    necesita cambiar. Renombrar ahora forzaría tocar ese método sin
    necesidad, agrandando el diff de un bloque que emite comprobantes
    fiscales reales. Bloque mecánico aparte, después de 1c/1d.
    **Trampa registrada, no implementar:** unificar a
    `attributionKey = reservationId ?? orderId` en una sola llamada de
    `resolveRefundableForPair()` NO preserva comportamiento -- cambia
    a qué clave se le asigna el residuo de redondeo
    (`refund-attribution.ts:206-225`), un corrimiento de un centavo
    contra `CREDIT_NOTE_COMPENSATION_TOLERANCE` que sí es
    decision-relevant. Mantener las dos computaciones separadas, como
    ya hace el `LEFT JOIN` de 1b.
  - **Split propuesto por el gate, más chico que 1c-i/1c-ii original:
    1c-0 → 1c-i → 1c-ii (+ 1d empaquetado, decisión del dueño,
    confirmada por `AskUserQuestion` 11/09/2026).** 1c-0 (ver bullet
    propio, ✅ RESUELTO) primero por decisión del dueño. 1c-i (ver
    bullet propio, ✅ RESUELTO): relaja el guard a membership + congela
    `frozenChargeIds` + agrega el guard de reversión total propia
    (`CreditNoteConsolidatedFullReversalError`, mismo hazard que ya
    tiene su guardia del lado reservas) -- **sin rama nueva en
    `buildCreditNote()`**. El espejo del tope por par a `r.order_id`
    (punto 4 original) se corrigió: una 2da ronda de gate lo RECHAZÓ
    para 1c-i (contradice `refund-attribution.ts:79-82`, que ya declara
    que el rename+wiring van juntos en 1c-ii) -- va empaquetado ahí, no
    en 1c-i. 1c-ii: recién ahí se cablea la rama de atribución de
    órdenes -- primer commit de esta cadena que puede emitir un
    comprobante que antes no existía. 1d (`classifyOrderLiveInvoice`
    para órdenes, mismo residual que 3.3-d cerró para reservas) va
    empaquetado con 1c-ii, no después -- 1b ya construyó las piezas que
    necesita.

  - **Actualización 15/09/2026 — 1d ✅ IMPLEMENTADO (sin commitear
    todavía, pendiente de gate `architecture-governor`).** Al re-verificar
    contra el código real (no contra este archivo) se encontró que
    **1c-ii ya estaba hecho** -- los docblocks de `resolveOrderPairAttribution()`/
    `getIssuedCreditNoteCompensationTotalForOrder()`
    (`sql.invoice.repository.ts`) ya narraban "1c-ii-b" como completo,
    fechado 11/09/2026, en una sesión anterior a la que dejó este archivo
    diciendo "1c-ii sigue sin hacer" -- este archivo había quedado stale
    en ese punto específico, no el código. Lo que faltaba de verdad era
    solo **1d**: `classifyOrderLiveInvoice()` seguía comparando F4/ledger
    por FACTURA ENTERA incluso después de que 1c-ii-b permitiera una NC
    granular por orden -- una orden totalmente reconciliada podía seguir
    clasificando `NOT_RECONCILED` porque OTRA orden de la misma
    consolidada no tenía su NC. Fix: mismo patrón exacto que 3.3-d ya
    aplicó del lado reservas -- resuelve el par `(invoiceId, orderId)` vía
    `resolveOrderPairAttribution()` (ya existía, sin consumidor hasta
    ahora) y, si resuelve, compara F4/ledger acotado a esa orden; si no
    resuelve (Nivel A / anomalía), fail-back byte a byte al comportamiento
    de antes. `buildCreditNote()` NO se tocó -- 1c-ii-b seguía intacto.
    Sin schema nuevo, sin rename de `reservationId` (diferido, fuera de
    alcance, como ya estaba decidido). Verificado: `tsc --noEmit` limpio;
    `npm run lint`/`lint:arch` limpios; **2282/2282 unit** (164 archivos) +
    **329/329 integration contra Postgres real** (local, 39 archivos,
    incluido el test nuevo `classify-order-live-invoice-pair-classifier.integration.test.ts`,
    3 casos -- reconciliado por par, no-reconciliado por par, y un caso de
    NC "incompleta" sin IVA sumado que expone que F4 por-par es tan
    estricto como el F4 por-factura-entera que reemplaza en ese scope).
    Sin push ni commit todavía -- diff en el working tree, pendiente de
    gate.
  - **Producción, medido 11/09/2026 (Neon `ancient-king-17098519`,
    ambos tenants, `production` y `tenant-hotel-los-alamos`): 0 facturas
    consolidadas ISSUED con >1 orden distinta hoy.** El bloque es
    preventivo, no desbloquea plata trabada ahora mismo. **Corrección
    (gate de 1c-i, verificado con código, no solo con la query): no es
    solo "0 hoy" -- es "no alcanzable por NINGÚN camino de producción
    todavía".** El único creador real de `accounts_receivable`
    (`AccountsReceivableService.transferStayBalanceToReceivable()`,
    `accounts-receivable.service.ts:168`) SIEMPRE setea `reservationId`
    en el cargo que factura, NUNCA `orderId` -- 0 referencias a
    `AccountsReceivableService`/`arRepo` en `src/pos-menu/` (grep).
    `requestConsolidatedInvoice()` no discrimina por origen del cargo
    (eso es cierto, lo verificó bien el gate de diseño), pero nada real
    puebla `accounts_receivable` con un cargo de orden para que llegue
    a usarlo. El escenario sigue siendo preventivo, más aún de lo que
    se pensaba -- ver el test de integración de 1c-i, que lo construye
    a mano (mismo criterio que `consolidated-invoice-toctou.integration.test.ts`
    ya usa para reservas) para probar que el código responde bien SI
    ese estado llegara a existir.
  **`STAY-ADJUSTMENT-PRICE-001` -- ✅ RESUELTO (11/09/2026, gate
  `architecture-governor`, `e57138d`).** `handleReservationPriceAdjusted()`
  (`src/workers/outbox.handlers.ts`) creaba el ADJUSTMENT de un ajuste de
  precio de reserva SIN campo `stayId` -- quedaba NULL siempre (a
  diferencia del ADJUSTMENT del escape de órdenes, que 1c-0 ya corrigió).
  `linkStayToReservationCharges()` corre UNA sola vez, al hacer check-in,
  y solo rescata filas que en ESE momento tengan `stay_id` NULL -- un
  ajuste confirmado con el huésped YA adentro nunca lo adopta nadie
  después. **Corrección a la redacción original de este ítem (regla 3,
  "describir la consecuencia real, no una más grande" -- verificado por
  el gate):** el fail-mode incondicional, con o sin `SETTLED`, es que
  `getFolio()` (`GET /stays/:id/folio`) nunca muestra el ajuste -- no
  filtra por status. Los dos fail-modes de saldo (sobre-declara/traba
  check-out con signo negativo; sub-declara/deja salir al huésped con
  deuda con signo positivo) SÍ requieren que la fila llegue a `SETTLED`
  primero (`getNetBalanceByStayId` filtra `status='SETTLED'`) -- ocurre
  cuando la reserva se completa antes de cerrar la estadía, camino real
  pero no el único. Fix: el `stayId` se resuelve en el handler mismo (no
  desde el payload del evento -- cierra la ventana de carrera
  check-in-entre-emisión-y-dispatch), mismo patrón que
  `StayService.approveScheduleChange()` ya usa para el mismo problema
  general. 50/50 unit (+6) + 3/3 integration (nuevo archivo, contra
  Postgres real, los dos signos) + 3 mutantes manuales -- uno de ellos
  (sacar el `?? null`) ni siquiera compila, `exactOptionalPropertyTypes`
  lo rechaza antes de llegar a runtime. Suite completa: 2140/2140 unit
  (162 archivos), 291/292 integration -- mismo 1 rojo preexistente de
  1c-0/1c-i, no relacionado.

  **Movido a `docs/resuelto.md`** — el hallazgo "`StayService.checkOut()`
  solo cuenta `SETTLED`" se resolvió el 12/09/2026 (caso 3,
  `ad28d2e`). Dos residuos de ese cierre quedan abiertos por separado:
  el de reconciliación de AR más abajo en `### 🔴 Bloqueado en una
  decisión del dueño`, y la verificación de los 2 integration tests en
  `## 🔍 Verificaciones pendientes`, al principio de este archivo.
  - **`financial-transaction.repository.ts:347-352` (comentario
    ORDER-15) -- premisa caduca, hallazgo del gate de 1c-0.** El
    comentario dice *"un ADJUSTMENT con `order_id` -- que hoy no
    existe, el único creador siempre usa `reservationId`"* -- falso
    desde que shippeó el escape de órdenes (bloque de creación del
    ADJUSTMENT compensatorio en `cancel-order-with-credit-note.service.ts`
    -- `createWithClient(...)` con `orderId`/`stayId`; de-anclado a
    símbolo, no a línea: la cita original `:290,293` ya quedó stale una
    vez por el corrimiento de 1c-i, mismo motivo por el que el propio
    archivo dejó de citarse líneas a sí mismo desde esa ronda -- ver el
    comentario "Citas de línea retiradas a propósito" ahí). El hazard que
    describe (ADJUSTMENT de orden anulable por `voidByOrderId` pero no
    liquidable por `settleChargesByOrderId`) **parece** contenido por
    ORDER-10 + la rama `comprobanteReconciliado`
    (`outbox.handlers.ts:395`), pero el gate NO lo verificó end-to-end
    -- no afirma que esté cerrado, solo que el comentario está
    desactualizado. Corregir el comentario + verificar el hazard real
    es un bloque de higiene chico, sin decisión de negocio.
  - **Residual del borde de cuenta corriente -- declarado, no bloqueado
    por 1c-0.** Si una estadía ya pasó por
    `transferStayBalanceToReceivable` (PAYMENT que salda el folio a la
    empresa) y DESPUÉS corre el escape de una orden de esa estadía, el
    folio queda en negativo -- `checkOut()` sigue pasando (no bloquea
    saldo negativo) pero `transferStayBalanceToReceivable` tiraría
    `NoBalanceToTransferError` si se reintentara, y el crédito no vuelve
    solo a la fila de `accounts_receivable` de la empresa (la
    ADJUSTMENT lleva el `customerId` del huésped, no el de la empresa).
    Pre-existente a 1c-0 (antes el folio quedaba inflado y positivo, que
    es peor) -- 1c-0 lo hace visible, no lo introduce. Sin bloque
    asignado todavía.

  **`1c-0` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `4aa09fe`).** El ADJUSTMENT compensatorio del escape de órdenes
  (`cancel-order-with-credit-note.service.ts`, asignación `const stayId =
  charge.stayId ?? null` que alimenta el `createWithClient(...)` de más
  abajo -- de-anclado a símbolo, no a línea, mismo motivo que la cita de
  más arriba: `:292` ya había quedado stale por el corrimiento de 1c-i)
  creaba `stayId: null`
  incondicional -- una orden cargada a una estadía y cancelada por NC
  dejaba el saldo de esa estadía sobre-declarado por el monto completo
  de la orden (el CHARGE, SETTLED con `stay_id`, contaba en
  `getNetBalanceByStayId`; la reversión, con `stay_id` NULL, no
  matcheaba el `WHERE stay_id = $1`). Efecto real: `checkOut()` bloqueado
  por una deuda que la NC ya canceló. Fix: el ADJUSTMENT hereda
  `charge.stayId` -- sin rama "mixed" (a diferencia del precedente de
  reservas), los guards existentes ya dejan el conjunto congelado como
  singleton por construcción. Medido, read-only, ambos tenants
  (`ancient-king-17098519`, 11/09/2026): 0 filas de órdenes canceladas
  por el escape con `stay_id` huérfano -- preventivo, sin corrupción de
  datos que reparar. 20/20 unit + 8/8 integration (contra Postgres real,
  `StayService` con sus repos SQL reales, no fakes) + 3 mutantes
  manuales con red-sets distintos. Suite completa: 2129/2129 unit
  (162 archivos), 288/289 integration -- el 1 rojo
  (`cancel-reservation-with-credit-note.integration.test.ts`, caso
  C1(ii), `expect(logger.error).toHaveBeenCalledWith(...)` con 0 calls)
  es preexistente en `origin/main` (confirmado con `git stash` + re-run
  contra HEAD limpio antes de este commit) y no relacionado a 1c-0.

  **Caso 5, residual 2 -- verificación de datos reales, sin correr
  todavía.** ¿Existe en producción el caso "seña cobrada (`PAYMENT` con
  `reservation_id`), reembolsada (`REFUND`), y la reserva cancelada
  DESPUÉS con NC (`ADJUSTMENT` con `reversed_invoice_id` no nulo)"? Bajo
  el guard viejo (pre-11/09/2026, ya retirado) ese caso podía loguearse
  como `grave` sin serlo -- ruido de log, no corrupción de datos (el
  guard era conservador, nunca dejaba de anular por error). Query
  candidata, no corrida todavía contra ninguna tenant DB:
  ```sql
  SELECT DISTINCT p.reservation_id
  FROM financial_transactions p
  JOIN financial_transactions r ON r.reservation_id = p.reservation_id AND r.type = 'REFUND'
  JOIN financial_transactions a ON a.reservation_id = p.reservation_id
    AND a.type = 'ADJUSTMENT' AND a.reversed_invoice_id IS NOT NULL
  WHERE p.type = 'PAYMENT' AND p.reservation_id IS NOT NULL;
  ```
  Origen: `docs/investigacion-decisiones-bloqueado-2026-09-12.md`, Caso 5,
  "Residuo del dueño" (segundo ítem).

  **Caso 5, residual 3 -- regla de crédito `PAYMENT`-vivo-tras-NC:
  verificado para `refundPercentage=100`, commit `9cb3fad` (2 rondas de
  gate `architecture-governor`).** La regla del dueño ("crédito por
  defecto, salvo devolución real de dinero") sale, para ese caso acotado,
  de primitivos existentes (signo de `REFUND`, `ADJUSTMENT` negativo del
  escape, `CustomerAccountService.getStatement()`) -- sin código nuevo,
  con test de composición + mutation testing real en
  `src/tests/integration/cancel-reservation-with-credit-note.integration.test.ts`.
  **NO cierra acá** -- el gate encontró 2 huecos reales que el alcance
  100% no cubre, cada uno su propio ítem:

  - **Penalidad retenida en reembolso parcial (`refundPercentage < 100`,
    `CancellationRefundService.confirmRefund()`,
    `reservas/cancellation-refund.service.ts:308`).** Pregunta al dueño
    (`AskUserQuestion`, 12/09/2026): **"Depende del rubro/negocio, no hay
    regla única"** -- explícitamente NO se decide una regla fija de
    sistema. Consecuencia: no se implementa ningún mecanismo de crédito
    para la penalidad retenida en este bloque -- haría falta un
    mecanismo CONFIGURABLE por negocio/rubro, que es una feature aparte,
    sin diseñar ni priorizar todavía. Sin bloque asignado.
  - **PAYMENT sintético de City Ledger contamina el balance del cliente
    (`AccountsReceivableService.transferStayBalanceToReceivable()`,
    `clientes-finanzas/accounts-receivable.service.ts:156`).** Crea un
    `PAYMENT` con `customerId: stay.customerId` (el huésped) y `stayId`
    SIN `reservationId` -- no aparece en `getByReservationId()`, pero SÍ
    contamina `getNetBalanceByCustomerId()`. Si una estadía transferida a
    una empresa (City Ledger) tiene su reserva todavía `CONFIRMED`
    (check-in no cambia `ReservationStatus`, verificado) y se cancela con
    NC, el huésped queda con crédito de plata que nunca pagó, mientras el
    `CHARGE` de la empresa sigue vivo -- `cancelReservationWithCreditNote()`
    no tiene ningún guard sobre `accounts_receivable`. El gate lo marcó
    como pregunta de DISEÑO, resoluble sin el dueño (definir si la regla
    de crédito se computa por reserva o por cliente resuelve o elimina el
    problema) -- pendiente de encarar, sin bloque asignado todavía.
  - RBAC de `GET /customers/:id/account` -- verificado por el gate
    (`FRONT_DESK` + preset `RECEPTIONIST` lo tiene), sin hallazgo. Cerrado,
    no requiere seguimiento.

  (La corrección de la causa raíz del test stale que este bullet
  describía -- `CN-VOID-COREJECT-STALE-TEST-001`, residual 1 de 3 -- se
  cerró y movió a `docs/resuelto.md`, 12/09/2026.)

  **`1c-i` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `d834329`).** `cancelOrderWithCreditNote()` bloqueaba TODA factura
  consolidada (cardinalidad ≠ 1) con `CreditNoteMultiInvoiceError` --
  correcto para el caso de siempre (una orden = una factura), pero
  hubiera roto también la NC granular futura (1c-ii) sin distinguir
  "esta orden no es la única en la factura" de "no soportado
  todavía". Fix: guard a membership (`chargeIds.includes(charge.id)`)
  + `frozenChargeIds` congelado en tx1 (nunca re-derivado en tx2 --
  ahí vivía el hazard real: una re-derivación en una consolidada
  multi-orden habría settleado también el cargo de OTRA orden) + guard
  de reversión total (`CreditNoteConsolidatedFullReversalError`,
  reusada del lado reservas) + rechazo explícito de cualquier
  subconjunto propio mientras 1c-ii no exista (decisión del dueño,
  grounding ERPNext/Odoo/Dolibarr/Cloudbeds/QloApps: los 5 bloquean en
  el borde con un rechazo tipado, nunca dejan un estado a medias).
  Corrige además la premisa de alcanzabilidad de la ronda de diseño
  anterior -- ver el bullet de "Producción, medido 11/09/2026" más
  arriba. 26/26 unit (+6) + 9/9 integration (+1, consolidada REAL vía
  `requestConsolidatedInvoice()`, no un INSERT a mano) + 3 mutantes
  manuales con red-sets distintos (uno de ellos, "tx2 no re-deriva", es
  la ÚNICA red contra el bug real -- para el caso de una sola orden
  re-derivar da el mismo resultado, así que ningún otro test lo
  detectaría). Suite completa: 2135/2135 unit (162 archivos, incluidas
  las 4 cercas de arquitectura que este bloque podía afectar) + 288/289
  integration -- mismo 1 rojo preexistente de 1c-0, no relacionado.

  **`1c-ii` -- el diseño original NO es implementable tal cual (gate,
  11/09/2026), partido en 1c-ii-a/b/c.** Una ronda de gate anterior
  asumió `resolveOrderPairAttribution()` (bloque 1b) como consumidor
  directo de la rama de órdenes en `buildCreditNote()` -- falso:
  `resolveOrderPairAttribution(client, …)` exige `SqlClient`, pero la
  atribución de `buildCreditNote()` corre FUERA de la transacción. El
  par correcto es `getOrderIdsByInvoiceItemId()` (nuevo) +
  `resolveRefundableForPair()` directo, igual que ya hace la rama de
  reservas -- `resolveOrderPairAttribution()` es para 1d
  (`classifyOrderLiveInvoice`), no para esto.

  **`1c-ii-a` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `c58b8f2`).** Preparación mecánica, cero cambio de comportamiento
  observable: `getOrderIdsByInvoiceItemId()` (nuevo, sin consumidor
  todavía, mismo criterio que 1b), `getInFlightCreditNoteTotalForPairForUpdate()`
  generalizado a un discriminador `{kind: 'RESERVATION'|'ORDER', id}`
  (columna elegida por `switch` sobre unión cerrada, nunca interpolada),
  `pairAttribution` local de `buildCreditNote()` generalizado en
  paralelo. 2140/2140 unit IDÉNTICO al baseline (cero test roto, cero
  valor esperado cambiado) + 294/295 integration (+3: discriminador
  `RESERVATION` vs `ORDER` sobre la misma factura, `getOrderIdsByInvoiceItemId()`
  contra el productor real, y equivalencia probada del camino de
  reservas -- mismos 3 tests preexistentes de `credit-note-pair-cap.integration.test.ts`,
  mismos valores). Mutation testing, 3 mutantes: 2 confirmados (invertir
  columna del discriminador, `Map` vacío en el método nuevo); el 3ro
  (sacar el `FOR UPDATE` preexistente de la línea que este bloque no
  tocó) **no rompió ningún test en 3 corridas** -- declarado como
  debilidad ya existente del test de concurrencia, no una regresión de
  este commit.

  **Corrección de evidencia de mutación (auditoría `erp-audit-orchestrator`,
  11/09/2026, sobre `c58b8f2`).** El mensaje de ese commit (local, no
  amendeable) afirma que el mutante M1 (invertir la columna del
  discriminador) "rompe el discriminador Y los 3 tests preexistentes de
  reservas" -- overclaim: rompe 2 de los 3, no los 3. No cambia la
  conclusión (mutation testing sigue confirmando que el camino vivo
  depende de esta línea), corrige el conteo exacto de tests afectados.
  Mecanismo verificado línea por línea: bajo M1 el tope por par de
  RESERVATION queda filtrando por una columna
  que las reservas nunca tienen (`order_id`) y por eso siempre ve 0 en
  vuelo -- deja de bloquear, no deja de dejar pasar. El test 2
  ("las dos completan, la suma no excede el total") solo afirma que
  ambas NC concurrentes terminan `ISSUED` -- eso sigue siendo cierto
  aunque el tope nunca bloquee nada, así que M1 no lo toca; los otros
  2 preexistentes sí afirman un rechazo (`CreditNotePairCapExceededError`
  o "exactamente una NC") que M1 elimina.

  **Corrección de alcanzabilidad (gate, esta ronda):** 1c-ii no
  habilita ninguna emisión AFIP nueva alcanzable HOY -- mismo hallazgo
  que 1c-i (ver "Producción, medido 11/09/2026" arriba), reconfirmado:
  el único creador real de `accounts_receivable` nunca setea `orderId`.
  El riesgo real de 1c-ii-b, cuando llegue, es de REGRESIÓN sobre el
  camino de reservas (vivo, comparte código), no de emitir mal una NC
  de orden.

  **Decisión de negocio -- ✅ RESUELTA (11/09/2026, dueño + grounding
  ERPNext/Odoo/QloApps/Dolibarr), implementación pendiente en
  `1c-ii-c`.** Retirar el rechazo placeholder de 1c-i (bloque
  `if (isProperSubset) { throw new CreditNoteMultiInvoiceError(...) }` en
  `cancel-order-with-credit-note.service.ts` -- de-anclado a símbolo, no a
  línea, por el mismo motivo que las dos citas de más arriba: el comentario
  que precede a ese `if` ya lleva registrado, desde el forward-fix
  `21fc413`, el criterio de aceptación bloqueante MUT-B para cuando
  `1c-ii-c` lo retire) movería una
  falla determinística de ANTES del ledger (hoy, dentro de tx1, antes
  del INSERT del ADJUSTMENT) a DESPUÉS (si `buildCreditNote()` tira
  `CreditNoteAttributionBlockedError`/`_MismatchError` tras el commit
  de tx1) -- un ADJUSTMENT PENDING huérfano permanente, a diferencia de
  un rechazo de AFIP (transitorio, reintentable). **Decisión: (a)
  pre-validar la atribución en tx1, antes del INSERT del ADJUSTMENT.**
  El grounding corrigió la dicotomía original ("¿pre-validar cuesta una
  3ra computación, o aceptar el huérfano?") -- Odoo (`account_move_reversal.py`,
  `_prepare_default_reversal()` + `@api.constrains` ANTES de escribir
  ningún `account.move`) y ERPNext (`make_return_doc()` construye y
  valida el documento SIN guardar, los GL entries recién existen en
  `on_submit`) resuelven esto con UN SOLO cómputo -- no dos: la
  atribución se hace al tope de tx1, sobre datos que tx1 YA lee (el
  comentario "SIETE lecturas de tx1" de
  `cancel-order-with-credit-note.service.ts` -- de-anclado a símbolo, no a
  línea, mismo motivo que las citas de más arriba), y el resultado se
  CONGELA para tx2 -- mismo mecanismo que `frozenChargeIds` (nacido del
  mismo modo de falla). Dolibarr es el único de los 5 que escribe
  primero y valida después (`compta/facture/card.php`, rama NC de
  situación, sin rollback explícito) -- es el contraejemplo, no el
  modelo a seguir. Implementación queda para cuando se encare
  `1c-ii-c` (después de `1c-ii-b`, todavía en HOLD) -- este bullet solo
  fija la decisión, no el código.

  **Deuda de wording, ESCALADA de teórica a real por 1c-ii-b (ver más
  abajo).** `CreditNoteAttributionBlockedError`, `CreditNoteAttributionMismatchError`
  y `CreditNotePairCapExceededError` (`domain/errors.ts`) dicen *"La
  reserva …"* también cuando quien dispara el error es una orden -- misma
  deuda ya diferida para `CreditNoteConsolidatedFullReversalError`
  (`domain/errors.ts:1140`, el parámetro del constructor sigue
  llamándose `reservationId`, verificado vigente 13/09/2026 -- no
  renombrado, deuda registrada acá para que no se pierda si el bullet
  que la traía antes se toca de nuevo). Hasta
  1c-ii-a esto era teórico (ninguna orden llegaba a estas 3 clases); desde
  1c-ii-b la rama ORDER de `buildCreditNote()` SÍ las tira con un
  `orderId` real en el mensaje -- sigue sin bloque asignado (no requiere
  código de error nuevo, `error.middleware.ts` ya mapea los 4 a 409), pero
  ya no es un caso hipotético.

  **`1c-ii-b` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  APPROVED WITH CONDITIONS, condiciones C1/C2/C4).** Cablea la rama ORDER
  real en `buildCreditNote()` (`invoice.service.ts`) -- espejo estructural
  exacto de la rama RESERVATION: mismo predicado (`ADJUSTMENT`, sujeto
  no-nulo, con líneas), mismo `resolveRefundableForPair()`, mismo cruce de
  monto contra `tx.amount`, misma copia 1-a-1 de la porción. Tres
  decisiones del gate, cada una grounded o explícita:
  - **C1 (lector de atribución, decisión del dueño tras
    `AskUserQuestion`):** inline vía `getOrderIdsByInvoiceItemId()`
    (`this.invoiceRepo`, FUERA de la transacción, igual que `originalItems`
    ya resuelve la rama de reservas) -- NO `resolveOrderPairAttribution()`
    (bloque 1b, que exige un `client` abierto). Ese método queda
    **PARKEADO** (docblock corregido: no se borra, cálculo correcto,
    cobertura de integración real) y se usa como oráculo de equivalencia:
    `classify-order-live-invoice-pair.integration.test.ts` (nuevo `it`,
    7mo test del archivo) prueba contra Postgres real que el camino
    parkeado y el camino real de `buildCreditNote()` dan el MISMO
    `attributedNeto`/`attributedIva`/`attributedTotal` para un fixture
    mixto (orden + reserva en el mismo grupo de tasa) -- las dos lecturas
    del mismo concepto no pueden divergir sin que este test lo note.
  - **C2 (ambigüedad `orderId`+`reservationId` no-nulos a la vez,
    grounding `auditor-circuitos-erp`):** `financial_transactions` no
    tiene CHECK que lo impida (solo disciplina de los 2 creadores del
    escape) -- ninguno de los 5 sistemas de referencia (Odoo, ERPNext,
    QloApps, Dolibarr; Cloudbeds sin evidencia utilizable, closed-source)
    deja esto resuelto solo por precedencia de código implícita. Odoo lo
    cierra con CHECK real en el propio ledger
    (`account_move_line._sql_constraints`); QloApps (único con el mismo
    diseño de 2 columnas nullable) tiene el mismo agujero sin protección,
    por limitación de MySQL 5.x que acá no aplica (Postgres). Recomendación
    combinada, no una u otra: **(a) fail-loud en código, este commit** --
    `CreditNoteAmbiguousSubjectError` (`domain/errors.ts`,
    `CREDIT_NOTE_AMBIGUOUS_SUBJECT`, 409), guard en
    `invoice.service.ts` ANTES de cualquier rama (ni siquiera depende de
    `isFullReversal`) -- y **(b) CHECK real de schema, bloque de migración
    APARTE** (nada de schema en este commit; riesgo de producción real,
    `migrate:tenants` corre contra todas las tenant DB en cada deploy; la
    forma recomendada es `(order_id IS NOT NULL)::int + (reservation_id
    IS NOT NULL)::int <= 1` -- `<= 1`, NO `= 1`: `sql.invoice.repository.ts`
    ya declaró NULL+NULL como falso negativo aceptado, un `= 1` lo
    revertiría de contrabando -- vía `ADD CONSTRAINT ... NOT VALID` +
    `VALIDATE CONSTRAINT` aparte, con medición previa por tenant. **Sin
    bloque asignado todavía** -- backlog de schema, ver roadmap si aplica.
  - **C4 (rename `attributionKey`, cumplido):** `reservationId` →
    `attributionKey` en `FrozenInvoiceItemShare`/`ResolveRefundableForPairInput`
    (`refund-attribution.ts`) y sus 3 callers (`invoice.service.ts` x2
    ramas, `resolveReservationPairAttribution()`, `resolveOrderPairAttribution()`).
    Cumple la promesa del bloque 1a en el mismo commit que cablea la rama
    de órdenes, como estaba escrito.
  - **C3 (docblocks "3 ramas" → 4 ramas):** actualizados
    `getIssuedCreditNoteCompensationTotalForReservation()`/`ForOrder()`
    (`sql.invoice.repository.ts`) -- la propiedad ("ninguna rama reparte
    una NC parcial entre múltiples sujetos") se mantiene con la 4ta rama
    porque es 1:1 con UNA orden, misma forma que la rama por-par de
    reservas.

  **Corrección del gate de pre-commit (segunda ronda, 11/09/2026,
  `architecture-governor`, APPROVED WITH CONDITIONS -- 4 hallazgos, los 4
  aplicados antes de commitear, ninguno de negocio):**
  - **F1 -- mutante sobreviviente real, cerrado.** El test de tope-por-par
    de orden sobreescribía `getInFlightCreditNoteTotalForPairForUpdate`
    con `async () => 500` (mismo patrón que su espejo de reservas) --
    ignora sus argumentos, así que un mutante que invirtiera
    `kind: 'ORDER'` por `kind: 'RESERVATION'` en el `pairAttribution` de
    la rama nueva seguía dejando el tope silenciosamente fail-open para
    órdenes (filtra por `r.reservation_id = <orderId>`, que nunca
    matchea, entonces `getInFlightCreditNoteTotalForPairForUpdate` da 0 y
    el tope nunca bloquea) y el test entero de todos modos en VERDE (el
    fake, 0-ário, tampoco tipaba los argumentos -- mismo defecto que
    `ROLES-CATALOG-DRIFT-001`: un chequeo que no puede ver un rename
    porque nunca inspecciona el valor). Corregido: el test captura la
    llamada real y afirma `subject: { kind: 'ORDER', id: 'ord-A' }` --
    reproducido el mutante después del fix, ahora rompe exactamente ese
    test (`npx vitest run src/facturacion/invoice.service.test.ts` con el
    mutante aplicado a mano vía script, revertido sin commitear: 82/83,
    1 rojo, el correcto).
  - **F2 -- comentario y mensaje de error desactualizados por este mismo
    bloque.** La rama `else` heredada (proporcional/Nivel A) decía "un
    ADJUSTMENT de orden debe revertir la factura completa" -- cierto
    hasta 1c-ii-a, falso desde 1c-ii-b: ahora un `ADJUSTMENT` parcial con
    `orderId` real nunca llega ahí (lo captura la rama nueva). Reescrito
    para describir el único caso que sigue llegando: parcial SIN ningún
    sujeto (`orderId`/`reservationId` ambos `null`), una fila de ledger
    anómala.
  - **F3 -- ancla de línea stale, reintroducida por este mismo diff.** El
    docblock de `buildCreditNote()` citaba `:816` para el call site de
    `resolveRefundableForPair()` -- ya estaba corrida en HEAD antes de
    este bloque (apuntaba a una línea de comentario) y el diff la corrió
    más. De-anclada a prosa, sin número de línea (mismo criterio que
    `206964b`, el commit INMEDIATO ANTERIOR en esta misma rama, que hizo
    exactamente esta corrección en otro archivo del mismo módulo).
  - **F4 -- doctrina de ramas de `buildCreditNote()` sin actualizar por
    3.3-a, agravado acá.** El docblock decía "Dos ramas según total vs.
    parcial" desde 08/09 -- ya era 3 desde 3.3-a (rama por-par de
    reserva) sin corregirse, y 1c-ii-b agregaba la 4ta sin tocar este
    párrafo. Reescrito a "Cuatro ramas", con las dos ramas por-par
    (reserva/orden) documentadas explícitamente y sin fecha de
    vencimiento nueva.

  Evidencia (COMANDO + salida real, no resumen -- corrección del gate:
  la ronda anterior de este documento presentaba estos números como
  verificados por el gate sin que el gate hubiera podido correr la suite
  de integración, `TEST_DATABASE_URL` sin definir en su sesión):
  - `npx vitest run` (unit, sin integración): **2147/2147**, 1 todo, 162
    archivos (baseline 2140 +7 nuevos, IDÉNTICO en lo demás -- cero valor
    esperado cambiado).
  - `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
    npx vitest run --config vitest.integration.config.ts`: **295/296**,
    35/36 archivos. El único rojo:
    `cancel-reservation-with-credit-note.integration.test.ts`, caso
    C1(ii) del residual 2 de 3.3-d (`expected "spy" to be called ... /
    Number of calls: 0`). **Re-verificado con `git stash` + mismo comando
    contra HEAD (`206964b`, sin este cambio) en esta misma sesión, DOS
    veces** (antes y después de aplicar F1-F4): mismo archivo, mismo
    test, mismo mensaje -- confirmado PRE-EXISTENTE, no una regresión de
    1c-ii-b. Ver `CN-VOID-COREJECT-STALE-TEST-001` más arriba (bullet de
    `1c-0`) -- causa raíz probable identificada 12/09/2026: el test
    parece codificar el guard exact-match que este MISMO residual 2
    reemplazó por el allowlist positivo.
  - `classify-order-live-invoice-pair.integration.test.ts` en aislamiento
    (mismo `TEST_DATABASE_URL`): **7/7**, incluido el test de equivalencia
    C1 contra Postgres real.
  - Mutation testing, 3 mutantes manuales (aplicados y revertidos, sin
    commitear, cada uno restaurado desde una copia y reverificado en
    82/83 → 83/83 después de revertir):
    1. Filtrar `originalItems` a las líneas de la orden ANTES de mapear a
       `shareItems` (en vez de `orderIdMap.get(i.id) ?? null` sobre
       TODAS) reproduce el bug inverso de `REFUND-ATTRIBUTION-RESIDUAL-001`
       -- rompe exactamente 3 de los 7 tests nuevos (mezcla orden+reserva,
       reconstrucción de 3 órdenes, tope por par -- los 3 que dependen del
       denominador correcto).
    2. Neutralizar el guard de ambigüedad (`if (false)`) rompe
       exactamente el test dedicado a `CREDIT_NOTE_AMBIGUOUS_SUBJECT`,
       ninguno más.
    3. (F1) Invertir `kind: 'ORDER'` → `'RESERVATION'` en `pairAttribution`
       -- ANTES del fix de F1 sobrevivía (83/83 en verde, tope silenciosamente
       fail-open para órdenes); DESPUÉS del fix rompe exactamente el test
       de tope por par corregido, ninguno más.
  - `cancel-order-with-credit-note.service.ts` **sin tocar** en ningún
    momento (`git status --short` no lo lista) -- `frozenChargeIds`/tx2/el
    placeholder de 1c-i quedan intactos, MUT-B sigue como criterio
    bloqueante de 1c-ii-c, no de este bloque.
  - **Chequeo pre-deploy que el gate pidió (no bloqueante para el commit,
    corrido igual -- read-only, barato, mejor tenerlo listo antes de pedir
    autorización de push):** `SELECT count(*) FROM financial_transactions
    WHERE order_id IS NOT NULL AND reservation_id IS NOT NULL AND
    reversed_invoice_id IS NOT NULL` contra los dos tenants reales del
    proyecto Neon `ancient-king-17098519` -- **`production`
    (`br-snowy-tree-ax5wmq70`): 0. `tenant-hotel-los-alamos`
    (`br-square-leaf-axzvu903`): 0.** Ninguna fila hoy quedaría convertida
    de NC-que-funciona a 409 por el guard nuevo -- el resto de las
    branches del proyecto son backups/templates/test, no tenants vivos.

  DEFENSIVE_DEVELOPING §2: cambio en `src/facturacion/` (dominio de
  facturación, no `src/api/routes/`/`container.ts`/`platform/`/`workers/`
  -- §3 no aplica). `criterios-negocio`: no crea entidad ni tabla nueva,
  extiende un cálculo puro (`resolveRefundableForPair()`) y una rama de
  servicio de dominio ya existente al segundo sujeto que el schema ya
  soporta (`invoice_items.order_item_id`); la clasificación
  transacción/maestro/documento de `Invoice`/`InvoiceItem`/`FinancialTransaction`
  no cambia.

  **`1c-ii-c` -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  APPROVED WITH CONDITIONS).** Retira el rechazo placeholder de 1c-i en
  `cancel-order-with-credit-note.service.ts` (`if (isProperSubset) throw
  new CreditNoteMultiInvoiceError(...)`) -- ya no hace falta:
  `buildCreditNote()` tiene la rama de atribución de órdenes cableada
  desde 1c-ii-b. El guard del borde-100% (`CreditNoteConsolidatedFullReversalError`)
  **no se toca**, sigue vigente. `CreditNoteMultiInvoiceError` queda con
  UN solo disparador real: el guard de membership (`!chargeIds.includes(charge.id)`),
  invariante rota si salta (imposible por construcción: `originalInvoiceId`
  se resolvió DESDE ese mismo cargo) -- docblock y mensaje corregidos a ese
  único caso.

  **MUT-B, criterio de aceptación bloqueante registrado al cerrar 1c-i --
  CERRADO acá, con evidencia real, no solo la intención.** Antes de este
  commit, ningún test ejercitaba tx2 con `chargeIds.length > 1` (el
  placeholder siempre rechazaba antes) -- un mutante que devolviera
  `frozenChargeIds: chargeIds` (el conjunto ENTERO de la consolidada) en
  vez de `[charge.id]` seguía verde en toda la suite. Cerrado con dos
  tests reescritos (antes probaban el RECHAZO, retirado; ahora prueban el
  ÉXITO):
  - Unitario (`cancel-order-with-credit-note.service.test.ts`, "1c-ii-c --
    consolidada real con OTRA orden..."): afirma que `settleByIdsWithClient`
    se llama con `[adj.id]` y `[CHARGE_ID]`, nunca con el cargo de la otra
    orden.
  - Integración contra Postgres real (`cancel-order-with-credit-note.integration.test.ts`,
    describe "(d)"): 2 órdenes reales, consolidada real vía
    `requestConsolidatedInvoice()`, el cargo de la orden AJENA sembrado
    **PENDING a propósito** (no `SETTLED` como el fixture viejo de 1c-i --
    con `SETTLED` un bug de re-derivación habría sido un no-op inocuo, no
    discriminaba nada). Después de cancelar-con-NC la orden A, se lee la
    fila de la orden B DIRECTO de la base: sigue `PENDING`.
  - Mutación reproducida (aplicada y revertida, sin commitear) DESPUÉS
    del fix: `frozenChargeIds: chargeIds` en el `return` de tx1 rompe
    exactamente esos 2 tests (1 unitario + 1 de integración), ningún otro
    -- 25/26 y 8/9 respectivamente, restaurado a 26/26 y 9/9 al revertir.

  Evidencia (comando + salida real): `npx vitest run` -> 2147/2147
  (idéntico al baseline, cero test nuevo neto -- 2 reescritos en el mismo
  archivo, no agregados). `TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
  npx vitest run --config vitest.integration.config.ts` -> 295/296, único
  rojo el mismo pre-existente de siempre (residual 2 de 3.3-d, no
  relacionado). `npm run lint:arch` limpio (295 módulos). `tsc`/`eslint`
  limpios.

  **Hallazgo del gate, corregido en el mismo commit (Finding C):** el
  docblock de `OrderInvoiceHasNoLinesError` (`domain/errors.ts`) afirmaba
  que para una reserva Nivel A "el camino proporcional... sigue
  funcionando... no lanza este error" -- falso: la rama heredada de
  `buildCreditNote()` tira este mismo error para CUALQUIER `ADJUSTMENT`
  (orden o reserva) con `originalItems.length === 0`. Corregido a
  registrar la deuda de wording real (el nombre/`code` quedan mal puestos
  para el caso reserva) en vez de afirmar lo contrario.

  **`CN-ESCAPE-ORPHAN-ADJUSTMENT-001` (11/09/2026, hallazgo del gate
  `architecture-governor` al revisar 1c-ii-c) -- registrado, NO
  resuelto.** En los DOS escapes de cancelación-con-NC (órdenes y
  reservas), tx1 commitea el `ADJUSTMENT` compensatorio ANTES de que
  `InvoiceService.buildCreditNote()` valide la atribución fiscal (la
  llamada real ocurre en el paso "AFIP", fuera de toda transacción,
  DESPUÉS de que tx1 ya cerró). Si `buildCreditNote()` tira un error
  determinístico -- factura "Nivel A" sin `invoice_items`
  (`OrderInvoiceHasNoLinesError`), atribución `BLOCKED`/`MISMATCH`
  (`CreditNoteAttributionBlockedError`/`CreditNoteAttributionMismatchError`),
  o sujeto ambiguo (`CreditNoteAmbiguousSubjectError`, 1c-ii-b) -- el
  `ADJUSTMENT` queda `PENDING` para siempre: reintentar con la misma
  clave de idempotencia SIEMPRE recalcula lo mismo y falla igual, porque
  los insumos (`invoice_items`/`afip_request.Iva[]` de la factura ya
  emitida) son inmutables. Consecuencia real: el escape no se puede
  completar y la orden/reserva queda con su factura viva sin resolver,
  hasta intervención manual -- hoy sin pantalla que lo muestre (B3).
  Alcanzable HOY por la vía Nivel A en los dos escapes (población
  documentada: 9 de 11 facturas de la tenant `Demo`,
  `refund-attribution.ts`); la vía de atribución `BLOCKED`/`MISMATCH` en
  consolidada parcial hoy solo es alcanzable del lado reservas (órdenes
  no puede: `accounts_receivable` nunca setea `orderId`). **Mitigación
  parcial verificada:** la fila es financieramente inerte -- toda query
  de saldo (`getOutstandingForUpdate`/`getRefundableForUpdate`/`getNetBalanceBy*`)
  filtra `status = 'SETTLED'`, y los topes de NC (N5/por-par) cuentan
  filas de `invoices`, nunca creadas en este camino. Sin incidente de
  producción registrado. **No lo introduce 1c-ii-c** -- ya existía en los
  dos escapes antes de este bloque.

  **La lista completa y clasificada de TODO lo que `buildCreditNote()`
  puede tirar (determinístico vs transitorio, con el porqué de cada uno)
  ya no vive en este párrafo -- vive en `EXPECTED_THROWS`,
  `src/tests/architecture/build-credit-note-throw-catalog.test.ts`
  (`BUILD-CREDIT-NOTE-THROW-CATALOG-001`, 12/09/2026, retro de esta
  misma sesión sobre por qué costó tantas vueltas cerrar este hallazgo):
  esa cerca falla si `buildCreditNote()` gana o pierde un `throw` sin que
  alguien lo clasifique acá y ahí. Motivo de existir: la lista de 3
  errores de más arriba había quedado corta un commit después de
  escribirse (`CreditNoteAmbiguousSubjectError` se agregó en 1c-ii-b,
  `e02a4fb`, y no se sumó a esta enumeración hasta que el gate la
  encontró revisando 1c-ii-c) -- una prosa a mano no se entera sola de un
  caso nuevo agregado en otro bloque; una cerca sí. Al encarar la salida
  manual, la fuente de verdad de qué interceptar es esa cerca, no este
  párrafo.

  **Decisión de producto sobre cómo cerrarlo -- grounding
  `auditor-circuitos-erp` (11/09/2026), unánime en los 5 sistemas:**
  ninguno de Odoo/ERPNext/Dolibarr/QloApps/Cloudbeds bloquea con un error
  terminal cuando el cálculo automático de una NC/reversión no cierra --
  los 5 (4 con documento fiscal real) dejan un documento en BORRADOR
  (`account.move` sin confirmar en Odoo, `Sales Invoice` docstatus 0 en
  ERPNext, `facture` brouillon en Dolibarr, `OrderSlip` con monto editable
  en QloApps) que un humano completa/edita antes de que tenga efecto
  fiscal -- la derivación automática es un PREFILL, no una condición.
  Ninguno de los 5 intenta lo que hace este sistema (derivar
  automáticamente por línea y decidir si "cierra" o no), así que el
  estado "PENDING para siempre" que produce el bug no existe en ninguno
  porque el camino que lo produce tampoco existe ahí.
  **Descartada** la alternativa evaluada primero (marcar el `ADJUSTMENT`
  como `FAILED` -- estado ya válido en el CHECK del schema,
  `financial_transactions.status`, pero sin ningún escritor hoy): el
  gate encontró que `voidByOrderId()`/`voidByReservationId()` YA cuentan
  `FAILED` junto a `VOIDED` como "anulado" en sus reportes de
  conciliación -- marcar así un `ADJUSTMENT` sin resolver lo escondería
  en la conciliación como si el caso ya estuviera cerrado, el peor lugar
  posible.

  **Corrección 13/09/2026 -- las 4 preguntas de alcance de más abajo ya
  están decididas, este párrafo había quedado sin actualizar.** El
  diseño completo vive en
  `docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md` (v7.2,
  12 pasadas de `architecture-governor`, tabla de partición de §9:
  "Preguntas reales abiertas para el dueño — ninguna, 0"):
  - **Campos editables**: línea por línea (Odoo/ERPNext), no un monto
    único con tope (QloApps) -- sobre `invoice_draft_items`. El diseño
    ya topea por PAR (factura, sujeto) vía
    `getInFlightCreditNoteTotalForPairForUpdate()` (§6.1 -- NO por
    §9 ítem 9, que solo lo menciona para excluirlo) -- ese
    tope NO filtra por origen de línea, suma el `imp_total` completo de
    la NC contra el sujeto. Las queries que SÍ atribuyen por origen de
    línea, y a las que el matiz de abajo realmente aplicaría, son
    `getIssuedCreditNoteCompensationTotalForReservation()`/`...ForOrder()`.
    Grounding ERP nuevo, re-verificado
    13/09/2026 contra código crudo (`validate_quantity()`,
    `sales_and_purchase_return.py`), **no citado en el diseño**:
    ERPNext además topea cada línea individual contra el original menos
    lo ya devuelto -- matiz a nivel de línea, complementario al tope
    por par que ya existe, sugerencia condicional para cuando se
    implemente, no decisión tomada.
  - **Motivo habilitante**: solo `AMOUNT_MISMATCH`. **No es que
    `AMOUNT_MISMATCH` "nunca dispare con cero líneas" -- ES `NO_ITEMS`
    el motivo que dispara con cero líneas, y es justamente el que se
    retiró en v7.0.** El motivo real del retiro (§0 del diseño): (a) el
    período histórico "Nivel A" (facturas sin `invoice_items`) está
    cerrado por la migración C3 -- toda factura posterior ya tiene
    líneas reales; (b) supuesto de negocio VOLÁTIL, no verificable desde
    el código -- todos los tenants de hoy son demo/descartables.
    **Gatillo de reapertura, textual del diseño**: "Si alguna vez un
    tenant de los que existen hoy se PROMUEVE a cliente de producción...
    `NO_ITEMS` vuelve a ser un caso real -- nada en este documento lo va
    a detectar solo." Cualquier decisión de promover un tenant demo a
    producción tiene que re-chequear esto -- no vive en ningún otro
    documento que se relea por sesión, así que queda anclado acá
    también, no solo en §0. Grounding ERP nuevo, **no
    citado en el diseño**: precedente parcial en Odoo (`blocking_level`
    en `account.edi.document`, severidad persistida en el documento)
    para cuando haga falta agregar un segundo motivo -- sugerencia
    condicional, no decisión tomada.
  - **Rol**: un solo grupo `EMISOR_NOTA_CREDITO` de punta a punta, sin
    split D4 -- decidido por el dueño (12/09/2026) porque, a diferencia
    de una factura de venta nueva (motivo real de D4 en
    `FACT-BORRADOR-001`), acá no hay un actor "operativo" separado del
    "fiscal" (§8 del diseño). **Cola que §8 marca "no es un detalle
    menor" y este bullet no puede perder**: la ruta nueva de completado
    manual queda FUERA de la aserción (D) de
    `credit-note-escape-containment.test.ts` (que hoy solo congela las
    2 rutas `cancel-with-credit-note`) -- sería el primer camino que
    emite una NC por fuera del cuello de botella con token de marca
    (`CreditNoteCancellationAuthorization`). Implica extender la
    contención (cerca nueva o fila en el equivalente de
    `ESCAPE_ROUTES`, el sexto artefacto manual del repo) -- a decidir
    con el gate cuando se implemente, no resuelto por esta corrección.
  - **El `ADJUSTMENT` viejo**: no cambia de fila ni se duplica -- la
    misma fila viaja de `PENDING` a `SETTLED` (decisión textual de §4
    del diseño, estados reales verificados en `schema.sql:2168`).
    Grounding ERP nuevo, **no citado en el diseño**: análogo al
    `account.move` en borrador de Odoo (no al patrón "anular y
    reemitir" de ERPNext/Cloudbeds, que aplica al comprobante fiscal,
    no al asiento de ledger) -- sugerencia condicional que refuerza la
    decisión ya tomada, no la decide.

  **La única precondición externa** que bloquea encarar esto es la
  secuenciación detrás del HOLD de `invoice_drafts` en
  `FACT-BORRADOR-001` (§9 ítem 3 del diseño) -- "no una pregunta de
  nadie", solo falta de tiempo/gate. El ítem 6 de §9 es "Parcial",
  resolución condicional, explícitamente "no es un 'resuelto' liso como
  2/4" -- verificado 13/09/2026 que no admite mecanismo de
  configuración ni grounding nuevo (la ecuación AFIP no es negociable
  por nadie; la clasificación por línea la resuelve el operador caso a
  caso, ya cubierto por `FACT-BORRADOR-001` §25.7/§25.8). **Bloque
  propio, sin fecha, sin encarar todavía** -- decisión explícita del
  dueño (11/09/2026) de cerrar primero 1c-ii-c chico y tratar esto
  aparte.

  **Ítem 8 de §9 -- DECIDIDO (13/09/2026, grounding `auditor-circuitos-erp`
  a 5 sistemas: Odoo/ERPNext/Dolibarr verificados en código, QloApps
  parcial código + doc, Cloudbeds solo doc con red bloqueada).** El
  dueño ya había resuelto que existe y es configurable por tenant
  (12/09/2026); quedaban 3 sub-preguntas, ahora cerradas:
  - **Valor default: apagada (sin ventana) por defecto** -- consenso
    4/4 entre los sistemas con ventana configurable (Odoo 5 lock dates
    vacíos, ERPNext 3 campos sin default, PrestaShop/QloApps
    `PS_ORDER_RETURN = 0`; Cloudbeds queda afuera de este conteo -- su
    ventana de 24hs no es configurable, no es instancia de la misma
    pregunta). Sin efecto de comportamiento hoy (no hay ventana ahora
    tampoco), por eso cerrado por consenso sin `AskUserQuestion`, mismo
    criterio que "borrador abandonado" de `FACT-BORRADOR-001` §26.3.
  - **Sub-decisión de evidencia más débil, NO cubierta por el consenso
    de arriba -- a confirmar con el dueño recién al implementar (la
    ventana apagada no le da efecto todavía):** si se activa, ¿desde
    dónde se mide? Unidad días, medida desde el `created_at` del
    `ADJUSTMENT` original (no desde la creación del borrador de NC) es
    la recomendación, pero se apoya en **un solo** precedente del grupo
    (`stock_frozen_upto_days` de ERPNext, `add_days(posting_date, N)
    &lt;= today()` -- 1/5, no 4/5) y tiene una alternativa igual de
    razonable ("cuánto hace que el operador lo tiene encima" en vez de
    "cuánto hace que pasó el problema") -- criterio D5 del `CLAUDE.md`
    raíz de este repo: no hereda la confianza del ítem de arriba solo
    por estar en el mismo bullet. Sí descartado: un `lock_date` sobre
    la fecha del documento (los 3 sistemas contables) **no dispararía
    nunca** acá, porque la NC se emite con fecha de hoy.
  - **Mecanismo: columna tipada en `business_profile`**, no tabla de
    settings genérica ni hardcode -- precedente de los 2 sistemas que
    evolucionaron este eje (Odoo `res.company`, ERPNext migró de
    singleton global a `Company`); el contraejemplo (Dolibarr,
    clave-valor genérico) es también el único sin bypass por rol ni
    granularidad -- Dolibarr es además el contraejemplo del ítem 9,
    aunque por otro motivo (ahí es el único sin origen por línea, no
    por su forma de configuración; el ítem 9 nunca evaluó este patrón).
    `business_profile` ya es el registro de política fiscal por tenant
    en este repo (`default_iva_rate`) -- coincide con la conclusión
    independiente de ORDER-10 B4 (`docs/pendientes-2026-09-05.md:1136`,
    mismo precedente Odoo `res.company`), no descansa en un grounding
    único.
  - **Comportamiento al vencer: DECIDIDO por el dueño vía
    `AskUserQuestion` -- solo advertir, no bloquear.** Coincide con el
    hallazgo transversal del grounding: 0/5 sistemas dejan la acción
    sin salida al vencer (todos bloquean con excepción por rol, o
    redirigen a otro instrumento -- nunca "no hay nada que hacer").
    Descarta la alternativa (bloquear + excepción por rol), que hubiera
    exigido reabrir el ítem 1 (`EMISOR_NOTA_CREDITO`, un solo grupo,
    12/09/2026) para agregar un segundo rol de excepción -- sin eso,
    "requiere un rol" colapsa en el mismo rol que ya se pedía. El ítem
    1 queda intacto, sin reabrir.

  **Deuda de documento que este registro deja abierta, a propósito no
  corregida acá:** `docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md`
  §9, fila del ítem 8, sigue diciendo (v7.2) "el valor default, el
  mecanismo de configuración y qué pasa al vencer siguen como bloque de
  implementación (sin gate todavía)" -- las 3 quedan decididas con este
  bullet, dos de ellas por el dueño. Propagar a v7.3 cuando se abra el
  bloque de implementación de §9 ítem 8, no en este commit de docs
  (mismo criterio que `SCHEMA-ANCHOR-DRIFT-001`: no reescribir un
  documento gate-aprobado fuera de su propio ciclo de revisión).

  **Reconciliación cruzada sin resolver, para no perderla:** ORDER-10
  B4 (`docs/pendientes-2026-09-05.md:1136`) y este ítem 8 proponen los
  dos una columna de fecha/plazo fiscal en `business_profile`, por
  controles distintos (cierre de período sobre fecha de documento vs.
  ventana desde el `created_at` del `ADJUSTMENT`). No se contradicen --
  la ventana de acá explícitamente "no dispara nunca" con la semántica
  de period-lock -- pero nadie reconcilió todavía si son un mecanismo o
  dos. Resolver antes de escribir la primera de las dos columnas.

  **Hallazgo adicional del grounding, más importante que el mecanismo
  de ventana en sí:** el ítem 8 trata como una sola cosa dos
  "lateness" distintas -- emitir la NC tarde (fiscal, resuelto arriba)
  y cancelar la orden/reserva tarde (`§7.1` tx2). El control estándar
  de industria para lo segundo no es un reloj, es RE-VERIFICACIÓN DE
  ESTADO (QloApps bloquea por "ya checked-in/checked-out" o "ya
  solicitada la cancelación"; Odoo por `_need_cancel_request()`, ya
  groundeado en `docs/pendientes-2026-09-05.md:1133`). El repo ya tiene
  ese guard del lado reservas (`CreditNoteReservationInvoiceSetChangedError`)
  y declara que le falta del lado órdenes -- hallazgo M3 punto 5 de §7.1
  del diseño, hoy "riesgo residual aceptado, no decidido". El grounding
  dice que ESE guard faltante es el control real, y la ventana temporal
  es el control débil -- si hay que priorizar uno de los dos, priorizar
  el guard de órdenes, no la ventana.

  **`1d` sigue en HOLD**, sin fecha.
- **`RESERVATION-STATUS-EXPIRED-FRONTEND-01`** — implementación cerrada,
  cortada a `docs/resuelto.md` el 13/09/2026 (**pusheado** —
  `appfrontend-main` `b38bce4` confirmado en `origin/main`, el texto
  anterior decía "LOCAL/sin pushear" y estaba stale). Quedan 2 residuos,
  registrados acá con ancla: (a) sin verificar, captura de pantalla real
  con una reserva `EXPIRED` — no había datos de prueba a mano; (b)
  follow-up sin encarar: no existe ningún test que congele
  `ReservationStatus` entre `app-main` (`src/types/enums.ts:13`) y
  `appfrontend-main` (`lib/reservas/types.ts:1`), análogo de
  `roles-catalog-sync.test.ts` — es lo que permitió que el drift
  original (`EVT-ORF-01`, cerrado, `docs/resuelto.md`) viviera ~3
  semanas sin que nadie lo notara.
- **Hueco de doble comprobante en `getInvoicedFinancialTransactionIds()`**
  -- ✅ **RESUELTO, PERO SOLO PARA LA DIRECCIÓN CONSOLIDADA↔CONSOLIDADA**,
  cortado a `docs/resuelto.md` el 13/09/2026 (**pusheado y deployado** —
  commit `a36f877` confirmado en `origin/main`, el texto anterior decía
  "LOCAL, sin pushear ni deployar todavía" y estaba stale). **No declarar
  cerrado el concepto completo** -- la TERCERA dirección sin guardia,
  `INVOICE-CHARGES-GUARD-INDIVIDUAL-01`, ya cerró aparte (13/09/2026, ver
  `docs/resuelto.md`).
- **`INVOICE-CHARGES-GUARD-FRONTEND-02` (Bloque 2)** -- código cerrado,
  cortado a `docs/resuelto.md` el 13/09/2026. Residuo separado, con
  ancla, en `## 🔍 Verificaciones pendientes` (arriba): verificación
  visual en vivo del estado nuevo, no hecha (0 casos reales para
  dispararla).

- **`INVOICE-CHARGES-BUTTON-DEADEND-01`** (11/09/2026, hallazgo del gate
  al cerrar el Commit 2 -- consecuencia, no mecanismo). Un cargo cubierto
  por una factura consolidada muestra "Facturado (consolidado)" y el
  usuario **no tiene ningún camino a ese comprobante** -- ni número, ni
  CAE, ni PDF -- desde ninguna pantalla. Antes de este bloque, al menos el
  click fallido nombraba el comprobante (`"El cargo X ya está vinculado
  al comprobante Y"`); ahora no hay ningún camino, ni siquiera torpe. El
  patrón ERP completo (Odoo/ERPNext, grounding ya verificado) es "ocultar
  la acción de crear" + "un widget separado y persistente para ver
  documentos ya vinculados" (`Connections` en ERPNext) -- este bloque
  implementó solo la primera mitad. El backend YA expone lo necesario
  (`GET /api/invoices?customerId=`, `InvoiceRepository.getByCustomerId()`,
  agregado en O2-F2 explícitamente "para facturas consolidadas, que no
  había forma de listar por cliente en absoluto") -- falta el consumidor
  en el frontend. Anclas:
  `appfrontend-main/src/lib/facturacion/api.ts:19-38` (`invoicesApi` no
  tiene `listByCustomer`, solo `get`/`listByFinancialTransaction`/
  `downloadPdf`), `appfrontend-main/src/components/FacturarButton.tsx`
  (el estado nuevo, sin salida). **No bloqueante hoy** (0 casos reales) --
  bloque propio, gate propio.
  **Actualización 11/09/2026, `INVOICE-CHARGES-FACTURACION-SCREEN-01`
  (gate `architecture-governor`) -- la primera mitad del patrón ERP ya
  tiene navegación real, la segunda sigue sin cerrar.** `invoicesApi.listByCustomer()`
  + pantalla `/dashboard/facturacion` (`appfrontend-main`, commit local
  `42c8611`) + `GET /api/invoices?customerId=` enriquecido con
  `cbteTipoLabel()` (`app-main`, commit local `844247b`) -- el estado
  "Facturado (consolidado)" de `FacturarButton` ahora es un `<Link>` a
  esa pantalla, preseleccionando al cliente. **Todavía NO es el link
  preciso cargo→factura**: el usuario llega a la lista completa del
  cliente y tiene que escanearla para encontrar cuál comprobante cubre
  el cargo puntual -- eso requiere exponer
  `InvoiceRepository.resolveInvoiceLinkage()` por HTTP (hoy sin ningún
  endpoint, solo consumidores internos), bloque backend + contrato
  cruzado, sin decisión ni gate todavía. No marcar este ítem `✅
  RESUELTO` hasta que exista ese link preciso.

- **`CANCEL-POLICY-SCOPE-BASE-001`** (13/09/2026, grounding
  `auditor-circuitos-erp` a 5 sistemas: QloApps verificado en código
  real; Cloudbeds verificado en su Help Center público — este grounding
  puntual sí tuvo acceso directo a esas páginas (a diferencia de los
  otros 3 groundings de esta sesión, donde Cloudbeds quedó bloqueado
  por red y solo hubo excerpts de búsqueda — variación de acceso entre
  rondas, no inconsistencia de criterio); ERPNext confirmado **sin**
  motor de penalidad de
  reserva — cancelación = Nota de Crédito manual; Odoo open-source
  también **sin** motor de penalidad de reserva, solo aporta el patrón
  de modelado de `account_payment_term` como catálogo con líneas
  ordenadas; Dolibarr sin módulo de reserva). Relacionado pero distinto
  de "Penalidad retenida en reembolso parcial" más arriba (esa pregunta
  es sobre qué hacer con lo YA retenido al confirmar un reembolso
  parcial; ésta es sobre CÓMO se configura y calcula la penalidad de
  cancelación en sí, por rubro).

  El repo ya tiene el motor de tramos (`cancellation_policies`, ladder
  por `min_days_before_checkin`, `src/db/schema.sql:914-929`), pero
  escala solo por `business_id` — sin scope por recurso/categoría/
  bucket. El patrón de scope que falta ya existe implementado dos veces
  en el mismo módulo (`deposit_policies`,
  `src/db/schema.sql:867-898`, resource/service/category/bucket; y
  `customer_rates`) — no hace falta inventar nada, solo extender
  `cancellation_policies` con el mismo scope de 4 vías y el mismo
  `SPECIFICITY_ORDER` de
  `src/reservas/sql.deposit-policy.repository.ts:30`.

  **DECIDIDA por el dueño vía `AskUserQuestion` — base de cálculo:
  "Configurable por política".** Precedente Cloudbeds: `Full Deposit`
  vs. `Full Stay`, el usuario elige por política si la base es la seña
  o el valor total. Esto cierra el hallazgo de que hoy el repo calcula
  sobre `collected` (lo efectivamente cobrado) sin precedente en ningún
  sistema de referencia — ni QloApps ni Cloudbeds usan esa base.

  **Las 4 sub-decisiones — TODAS DECIDIDAS (13/09/2026, vía
  `AskUserQuestion` en esta sesión, ninguna registrada todavía en un
  commit anterior) — con un residuo sin cerrar: el default de la
  tercera todavía no está confirmado, ver abajo:**
  - **Unidad temporal — días fraccionarios/float.** Hoy
    `min_days_before_checkin INTEGER CHECK (>= 0)`
    (`src/db/schema.sql:917`) no expresa ventanas de horas
    (barbería/spa). Decidido vía `AskUserQuestion`: precedente QloApps
    (`days` float) — sin cambiar de unidad si mañana hace falta una
    ventana de horas.
  - **Extras/cargos adicionales SÍ entran a la base de cálculo.**
    Decidido vía `AskUserQuestion`: precedente QloApps, explícito
    (`total_price_tax_incl + totalServicesPrice`).
  - **Snapshot al reservar vs. regla viva al cancelar — CONFIGURABLE
    POR TENANT, no una respuesta única del sistema.** Ningún referente
    lo resuelve de forma copiable (QloApps resuelve contra la regla
    viva, Cloudbeds sugiere snapshot) — mismo tipo de pregunta que el
    caso D5 (22/08/2026, `CLAUDE.md` de `app-main`). Decisión del dueño
    (13/09/2026): dado que es una decisión de la RELACIÓN del negocio
    con sus clientes, no del sistema, el sistema no elige por el
    tenant — se agrega como campo configurable.
    **DÓNDE vive el campo y CON QUÉ GRANULARIDAD — DECIDIDO por el
    dueño hoy (14/09/2026, `CANCEL-POLICY-SCOPE-BASE-001` Bloque 1):
    el campo vive POR POLÍTICA/TRAMO** (scope de `cancellation_policies`,
    no global en `business_profile`) — permite mezclar criterio dentro
    del mismo tenant (ej. reservas corporativas con un criterio,
    temporada alta con otro). **Default: snapshot al reservar**
    (`SNAPSHOT_AT_BOOKING`) — más conservador, protege la expectativa
    del cliente, y además coincide con lo que R9
    (`docs/criterios-datos.md`) ya favorece de fondo. Implementado
    (Bloque 1, 14/09/2026) como columna `cancellation_policies.
    policy_resolution_timing` (`VARCHAR(30) NOT NULL DEFAULT
    'SNAPSHOT_AT_BOOKING'`, enum `SNAPSHOT_AT_BOOKING`/
    `LIVE_AT_CANCELLATION`) + CRUD completo (repositorio, servicio,
    rutas, schemas Zod) — ver docblock en `src/db/schema.sql` y en
    `src/reservas/cancellation-policy.repository.ts` para el
    razonamiento completo, incluida la desviación deliberada de R9 que
    habilita `LIVE_AT_CANCELLATION`. **Nombre de columna:**
    `policy_resolution_timing`, no `refund_basis_timing` (ese nombre
    colisiona con el campo hermano de "base de cálculo" — ver la
    sub-decisión de arriba, "Configurable por política" — que también
    va a vivir en esta tabla; "basis" ya está tomado para ESE concepto,
    sobre qué monto se calcula el %, mientras que este campo es sobre
    CUÁNDO se resuelve la política, un eje distinto). El campo hoy es
    de solo CRUD, sin efecto observable en `CancellationRefundService`
    — ver Bloque 2 más abajo, sección "🟡 Listo para encarar".
  - **POS/órdenes NO entra al mismo motor de penalidad — queda
    acotado a reservas/turnos.** Decidido vía `AskUserQuestion`. Hoy
    `src/pos-menu/order.service.ts` no tiene concepto de penalidad
    (verificado: 0 matches de `penalt`/`cancellation` salvo un
    comentario que remite al lado reservas, `:376`); ningún sistema de
    referencia lo modela unificado con hotelería — se construye
    separado si/cuando haga falta, sin acoplar POS al motor de
    reservas.

  **Fuera de alcance de este bloque, a propósito** — el grounding
  recomienda NO tocarlos acá, quedan como deuda separada si no lo están
  ya: `rate_plans.cancellation_policy TEXT`
  (`src/db/schema.sql:280` — sí se persiste y se expone, ver
  `sql.bookable-service.repository.ts:57`/`:238`/`:263` y
  `bookable-service.service.ts:201`; lo que falta es lógica de
  cancelación que la consuma, no está "muerta" a nivel de dato) y
  `CANCEL_ADVANCE_MS`
  (`src/api/routes/customer.routes.ts:127`, constante hardcodeada de
  ventana de PERMISO de cancelar, no de penalidad — son ejes distintos,
  no unificarlos).

### 🟡 Listo para encarar (sin decisión pendiente, solo falta tiempo/gate)

- **`credit_note_request` -- gap del camino ISSUED (15/09/2026, gate
  `architecture-governor` sobre Bloque 4).** El ADR
  (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5
  bis, tabla de transiciones) documenta 4 transiciones automáticas:
  REJECTED→CERRADA, `FAILED_UNCERTAIN`+`afipContacted`→EN_REVISION_MANUAL
  (x2 orígenes), e ISSUED→CERRADA. Bloque 4 implementó las 3 primeras
  (las que pasan por `markFailedWithClient()`, ya atómico desde Bloque
  2) -- la 4ta (`finalizeIssued()`/`markIssued()`, camino de ÉXITO) NO
  pasa por `markFailedWithClient()` en ningún punto, así que quedó fuera
  del alcance real de Bloque 4 tal como estaba delimitado. Sin esto, una
  `credit_note_request` que llega a `ISSUED` (la NC se emitió con éxito)
  se queda en `PENDIENTE` para siempre -- nunca cierra sola.
  **Nuance que complica la implementación, no ignorar:** `retryExisting()`
  (`invoice.service.ts:1327-1345`) NO bloquea el reintento de una factura
  `REJECTED` -- así que una NC puede: 1er intento REJECTED (`credit_note_
  request` auto-cierra CERRADA, resolution_outcome NULL), 2do intento
  (retry) ISSUED (la NC se emitió). Esa fila queda `CERRADA`/`NULL` aunque
  la NC finalmente SÍ se emitió -- `invoices` sigue siendo la fuente de
  verdad real (sin riesgo de doble emisión ni de NC faltante), pero es un
  gap de bookkeeping en la fila de workflow: nadie debería leer
  `CERRADA`+`resolution_outcome: null` como "confirmado que no se emitió"
  sin chequear `invoices` directamente. Al implementar esto, resolver
  explícito (no inferir) si `finalizeIssued()` necesita la MISMA lógica
  de tolerancia que Bloque 4 ya armó para `fromState==='CERRADA'`
  (retry-post-cierre es alcanzable acá también) o si amerita una regla
  propia.
- **`credit_note_request` -- cobertura de test faltante en la rama de
  tolerancia de Bloque 4** (15/09/2026, mismo gate). El único camino de
  decisión nuevo de Bloque 4 (`transitionCreditNoteRequestAfterFailure()`
  tolera `CreditNoteRequestInvalidTransitionError` solo cuando
  `err.fromState === 'CERRADA'`, aborta la transacción en cualquier otro
  caso) no tiene ningún test que lo ejercite hoy -- el test de
  "atomicidad" existente fuerza un `Error` genérico, no el error tipado
  real. Agregar un test (unit, reusando `FakeCreditNoteRequestRepository`
  de `invoice.service.test.ts`, `seed()` de una fila ya `CERRADA` +
  reintento) que confirme que la tx SÍ commitea en ese caso -- cerrar
  antes de considerar el bloque completamente cubierto.
- **`credit_note_request` -- `recordFieldChanges()` nunca se wireó, pese a
  que el ADR lo pide explícito** (15/09/2026, gate `architecture-governor`
  sobre Bloque 5). §6.5 bis, punto 4 de "El consumidor real de
  `resolved_by`", texto literal del ADR: *"Auditoría: sigue el patrón
  compartido `domain/audit.ts::recordFieldChanges()`... mismo criterio que
  `RateCatalogService`"*. Verificado contra el código real: no hay ningún
  `recordFieldChanges()` wireado para `credit_note_request`, ni en Bloque 4
  (transiciones automáticas) ni en Bloque 5 (`resolveCreditNoteRequestManually()`,
  transición manual). No es una regresión de Bloque 5 -- la brecha ya
  existía desde Bloque 4 y no se había señalado en aquel gate tampoco.
  Mitigante real, no excusa: `resolved_by`/`resolved_at`/`resolution_note`
  quedan poblados como columnas de primera clase en la propia fila (el dato
  no se pierde), y `CERRADA` es terminal -- no hay múltiples transiciones
  que auditar por fila, así que el caso de uso principal de
  `recordFieldChanges()` (historial de ediciones repetidas) no aplica tan
  directo acá como en `RateCatalogService`. Aun así, es una desviación
  explícita del texto del ADR sin que en ningún lugar del diff quede
  declarada la decisión de omitirla. Antes de dar el bloque completo del
  ADR por cerrado (no bloqueante para el commit puntual de Bloque 5):
  decidir explícito si se wirea `recordFieldChanges()` para
  `credit_note_request` (Bloques 4+5) o si se documenta en el ADR la
  decisión consciente de omitirlo y por qué.

- **`CANCEL-POLICY-SCOPE-BASE-001` Bloque 2** (14/09/2026, split del
  Bloque 1 -- gate `architecture-governor` sobre el diff de Bloque 1).
  Bloque 1 (schema + CRUD de `cancellation_policies.
  policy_resolution_timing`) ya está — ver la sub-decisión "Snapshot al
  reservar vs. regla viva al cancelar" más arriba. Lo que falta para que
  el campo tenga efecto real:

  - **Puntos de inserción exactos, y corrección de un registro previo:**
    `src/reservas/cancellation-refund.service.ts:89`
    (`previewRefund()`) y `:159` (`confirmRefund()`) son donde
    `findApplicableTier()` se resuelve hoy contra la tabla en vivo — ahí
    es donde el Bloque 2 tiene que ramificar por
    `policy_resolution_timing`. El comentario en `:147-153` explica que
    esa resolución se saca del lock (`transactionManager.run()`) A
    PROPÓSITO, para no sostener `FOR UPDATE` sobre N facturas durante
    round-trips de red (catálogo y config, ninguno de los dos participa
    de la carrera). **Esto corrige un registro previo:** los dos puntos
    de inserción NO están dentro del lock — la lógica de concurrencia
    (`atomic-state-mutation`/`concurrency-reasoning`) no es el
    bloqueante real de este bloque.

  - **El bloqueante REAL — pregunta de negocio abierta para el dueño,
    marcada explícitamente para `AskUserQuestion` futuro, NO respondida
    acá:** las reservas que ya están `CONFIRMED` antes de que exista la
    columna de snapshot en `reservations` no van a tener ningún
    snapshot congelado. Al cancelarlas, ¿el sistema cae a regla viva
    (`LIVE_AT_CANCELLATION` de facto, aunque la política diga
    `SNAPSHOT_AT_BOOKING`), o rechaza el cálculo hasta que alguien
    decida a mano? Dos respuestas defendibles, con consecuencia de
    plata directa (cuánto se reembolsa) — no elegir una acá.

  - **Lado de escritura:** `ReservationService.confirmReservation()`
    tiene que poblar el snapshot (`reservations.
    cancellation_policy_snapshot JSONB`, diseño ya discutido, sin
    implementar). Falta decidir si se congela el ladder COMPLETO de
    tramos (todas las filas de `cancellation_policies` vigentes al
    momento de confirmar) o solo el tramo aplicable a esa reserva en
    ese momento — cada uno tiene trade-offs distintos si la
    anticipación real de la cancelación cae en un tramo distinto al
    esperado.

  - **Deuda de cobertura de test heredada del Bloque 1
    (condición 6 del gate, 14/09/2026):** las 18 fixtures de
    `cancellation-refund.service.test.ts` (`FakePolicyRepository`)
    quedaron todas en `LIVE_AT_CANCELLATION` porque es lo único que el
    service implementa hoy — ninguna cubre `SNAPSHOT_AT_BOOKING`. El
    Bloque 2 va a necesitar fixtures nuevas que ejerciten esa rama de
    verdad (snapshot congelado real, no solo cambiar el valor del
    enum), sumadas a las 18 existentes, no en su reemplazo.

- **`RESERVATION-STATUS-CROSSREPO-SYNC-001`** (13/09/2026, split del
  cierre de `RESERVATION-STATUS-EXPIRED-FRONTEND-01`, `docs/resuelto.md`
  — reclasificado desde `## 🔍 Verificaciones pendientes` porque no es
  código listo esperando confirmación, es trabajo de ingeniería nuevo:
  no hay cerca todavía que construir). No existe
  ningún test que congele `ReservationStatus` entre `app-main`
  (`src/types/enums.ts:13`) y `appfrontend-main`
  (`lib/reservas/types.ts:1`) — análogo de `roles-catalog-sync.test.ts`
  (ver `ROLES-CATALOG-DRIFT-001`, `app-main/CLAUDE.md`). Es lo que
  permitió que el drift de `EXPIRED` viviera ~3 semanas sin que nadie lo
  notara. Construir: cerca de sincronía cross-repo, mismo
  patrón que la ya existente para el catálogo de roles.
- **`PRESET-SAVE-ECHO-001`, residuo (b)** (13/09/2026, split del ítem al
  migrarlo a `docs/resuelto.md` — reclasificado desde `## 🔍
  Verificaciones pendientes` porque no es código listo esperando
  confirmación, es trabajo de ingeniería nuevo: no hay test todavía que
  escribir). Sin test de integración de `listRolePresets()`/
  `listPlanLimits()` con `client` opcional contra Postgres real -- la
  corrección queda demostrada por unit test + semántica documentada de
  READ COMMITTED, no por ejecución contra la BD real. Construir: test de
  integración de las 2 rutas corregidas.
- **Consumidores de `roles.name` en vez de `role.id`/`is_system`**
  (residuo del guard `isSystem` en `renameRole()`, cerrado 10/09/2026 —
  ver `docs/resuelto.md`). El guard cierra el camino que CREA la
  divergencia (un rename ya no puede chocar contra `roles_pkey` ni
  saltarse la protección de rol OWNER), pero los consumidores que siguen
  autorizando por STRING de nombre en vez de por id/flag no se tocaron:
  `users.routes.ts:201,276`, `user-invitation.routes.ts:156`, el JOIN
  `role_preset_permission_groups rppg ON rppg.preset_name = r.name` de
  `PlatformRepository::updateRolePresetPermissionGroups()`
  (`platform.repository.ts`), y el techo `allowedRoleNames`
  (`resolvePlanLimits()`, consumido en `users.routes.ts` por
  `role.name`). Sin decisión de negocio de por medio — es una
  refactorización de la forma en que esos sitios resuelven el rol (por
  `role.id`/`is_system` en vez
  de por `roles.name`), no un cambio de comportamiento.
- **`POOL-MIXTO-MANUAL-01`** (bloque 3.5 del ADR común cancelar-con-NC,
  hallazgo de esta revisión 11/09/2026 -- no estaba registrado en ningún
  lado). `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
  §10 fila 2: el dueño decidió (08/09/2026) que el pool mixto (una
  reserva con >1 factura `ISSUED` viva) se resuelve **manual, factura
  por factura** -- no fan-out automático. §6.6 especifica el mecanismo:
  "`>1` → error tipado fail-closed, SIN llamar a AFIP y SIN crear
  ADJUSTMENT... bloque 3.5, gate propio, **con un parámetro explícito de
  factura destino**". **Verificado en el código real
  (`cancel-reservation-with-credit-note.service.ts:310-315`): la mitad
  fail-closed SÍ está -- `issuedInvoiceIds.size > 1` tira
  `CreditNoteReservationMultiInvoiceError` (correcto, seguro, ya
  deployado como parte de 3.3-b1). La mitad "manual" NO está --
  `cancelReservationWithCreditNote(reservationId, auth)` no acepta
  ningún parámetro de factura destino** (`:252-255`, firma completa).
  Efecto real: hoy, si una reserva llega a tener 2 facturas `ISSUED`
  vivas simultáneas, el escape con NC queda permanentemente inalcanzable
  para esa reserva -- no hay forma de que un operador la resuelva, ni por
  API ni por panel (tampoco hay panel, ver el punto de frontend de
  abajo). Fail-closed es lo correcto mientras tanto (no corrompe nada),
  pero el bloque 3.5 tal como lo definió el dueño no está cerrado. Sin
  medir en esta revisión cuántas reservas reales están en ese estado hoy
  -- verificar contra Neon antes de priorizar.
- **Frontend del ADR común cancelar-con-NC, declarado desde el diseño
  original (§7, "en pasadas posteriores por bloque, hallazgo A4: hoy no
  existe nada")** -- sigue sin existir ninguna pantalla para: la bandeja
  de facturas vivas no conciliadas (`GET /api/invoices/unreconciled`, sin
  consumidor de UI), el manejo de los `409 REFUND_INVOICE_SET_CHANGED`/
  `CreditNoteReservationMultiInvoiceError` que el backend ya emite, ni un
  panel para resolver manualmente el pool mixto de arriba una vez que
  exista. Backend completo y deployado, frontend en cero -- mismo estado
  que cuando se escribió el ADR.
- **Residual B-1 / 3.2-b** (`CustomerAccountService.recordPayment()`,
  camino sin `allocations`) — transaccionalizar (mecánico, patrón ya
  usado 20 líneas más abajo en el mismo archivo) + filtro de tipo en
  `settleByReservationId()` (interferente dormido). Mecanismo ya
  investigado a fondo esta sesión (research ERPNext/Odoo/QloApps, ver
  más arriba).
- **`PLAN-LIMITS-SEED-REVERT-001`** — ✅ **RESUELTO (11/09/2026)**, mismo
  mecanismo que `PRESET-REVOKE-001` (marca de seed), aplicado a
  `plan_limit_allowed_roles`/`plan_limit_allowed_permission_groups`/
  `max_custom_roles`. Ver más arriba. Abrió `PLAN-LIMITS-EMPTY-MEANS-ALL-001`
  (decisión del dueño, no implementado) y dejó C4 (medir divergencia real
  en producción) pendiente antes de deploy.
- **`RBAC-MATRIX-SECTION2-001`, hueco del `EXCLUDED_FILES`** — la cerca
  solo verifica que el CONTEO de rutas protegidas siga coincidiendo, no
  que el archivo siga sin bullets parseables. Cerrarlo (contar bullets
  parseables por archivo) es prerequisito antes de normalizar cualquiera
  de los 11 archivos en prosa (85 rutas protegidas sin verificar fila
  por fila: `customer.routes.ts` 7, `invoices.routes.ts` 8,
  `admin.routes.ts` 2, `platform.routes.ts` 11,
  `waste-reasons.routes.ts` 5, `consumption-destinations.routes.ts` 5,
  `products.routes.ts` 30, `cancellation-policies.routes.ts` 5,
  `roles.routes.ts` 5, `user-invitation.routes.ts` 4,
  `accounts-receivable.routes.ts` 3 -- este último con un bullet que ya
  diverge del código real, `GET /?companyCustomerId=` vs `GET /`).
- **`SUPERADMIN-CONTRAST-001`** — texto casi ilegible en `/superadmin/*`
  (blanco sobre el `--bg` claro de V2). Calculado, no medido en
  navegador -- confirmar antes de priorizar.
- **`SqlReservationRepository.save()`/`syncLines`** no atómico por el
  pool cuando no se entra vía `saveWithClient()` -- hallazgo de esta
  sesión, sin bloque todavía.
- **`SEC-ROT-001`** — runbook de rotación ya escrito
  (`docs/conocimiento/runbook-rotacion-db-encryption-key.md`).
  **Parte 1 -- ✅ RESUELTA (11/09/2026, gate `architecture-governor`,
  2 rondas: HOLD → APPROVED WITH CONDITIONS, commit `74f6872`).**
  Verificado 13/09/2026: `74f6872` está pusheado (confirmado ancestro de
  `origin/main`) -- el texto anterior decía "LOCAL/sin pushear" y estaba
  stale, mismo patrón que el `CLAUDE.md` de este repo documenta como
  incidente recurrente. `decryptConnectionString()` acepta `DB_ENCRYPTION_KEY_OLD`
  como fallback -- las 3 familias de columnas cifradas (connection
  strings de tenant, certificado/clave AFIP, tickets WSAA) pasan por las
  MISMAS 2 funciones (`tenant-db.setup.ts`), así que este único cambio
  las cubre a las tres. Sin `DB_ENCRYPTION_KEY_OLD` seteada, comportamiento
  idéntico al de antes -- probado con conteo real de llamadas a
  `Decipheriv` (spy sobre `node:crypto`), no solo con el resultado. El
  gate encontró 5 ubicaciones nuevas en la matriz de impacto original
  (N1-N5) -- la más seria: reusar `activateBusiness()` para el barrido
  de la Parte 2 hubiera reactivado negocios `SUSPENDED`/`PENDING` en
  silencio, así que la Parte 2 necesita un método angosto nuevo
  (`PlatformRepository.updateDbUrlEncrypted()`) en vez de reusar ese.
  **Sigue sin ser una capacidad real** -- runbook §2 sigue vigente:
  falta la Parte 2 (`reencrypt-secrets.ts`, el barrido de re-cifrado) y
  ensayar contra un branch Neon descartable antes de que "rotar" sea
  algo que se pueda hacer de verdad.
  **Fuera de alcance de la Parte 1, registrado para cuando se retome**:
  Parte 2 (script de barrido + el método nuevo de `PlatformRepository`),
  Parte 3 (IV 16→12, deliberadamente separada -- mezclarla hubiera roto
  el argumento de "sin `DB_ENCRYPTION_KEY_OLD` el comportamiento es
  idéntico" que hace segura a la Parte 1), el comentario fechado en
  `render.yaml` junto a `DB_ENCRYPTION_KEY` (recién cuando
  `DB_ENCRYPTION_KEY_OLD` exista de verdad en Render, no antes) + el
  procedimiento de `docs/auditoria-dominios.md` que eso dispara, y una
  línea nueva en la Fase 0 del runbook nombrando `admin.routes.ts:63`
  (`set-tenant-url`) y `:124` (`repair-tenant-db`) como los 2 endpoints
  que el freeze de rotación tiene que cubrir y que hoy nada hace cumplir.
  **Hallazgo de paso, no de este bloque**: `migrate-tenants.ts:58` hace
  `continue` ANTES de descifrar cuando el schema ya está al día -- o sea
  que `npm run migrate:tenants` en cada deploy de Render NO es una
  prueba de descifrado real para los tenants ya al día (que son la
  mayoría, casi siempre). La red de seguridad implícita que la Fase 1
  del runbook parecía dar por cierta no existe.
- **`CONCIL-INCONSIST-01`** (absorbe `INV-ORF-01` + pt1 `ORDER-13`) --
  diseño ya grounded contra ERPNext/Odoo (cron que NO emite + query
  on-demand + contador junto a `countDeadLettered()`). 0 filas huérfanas
  medidas (07/09) -- riesgo latente, no urgente.
- **`OUTBOX-RETRY-HIST-01`** + **`OUTBOX-BACKOFF-01`** — ✅ **RESUELTOS,
  pusheados y deployados en producción, verificados** -- entrada completa
  cortada a `docs/resuelto.md` el 13/09/2026.
- **`OUTBOX-DL-COMPENSATOR-01`** — idempotencia del compensador de
  `onDeadLetter`; bloquea a `CONCIL-INCONSIST-01`, así que va primero si
  se retoma esta familia. **Riesgo agravado por `OUTBOX-BACKOFF-01`
  (gate `architecture-governor`, ronda 5, 10/09/2026, ver
  `docs/diseno-outbox-backoff-2026-09-10.md`):** antes de ese bloque, los
  dead-letters convergían en una ráfaga de ~5 minutos; con backoff real
  se desparraman hasta ~3.3h. La carrera que este ítem describe (el
  proceso muere entre `recordFailure()` devolviendo `true` y que el
  compensador termine) sigue siendo igual de angosta por evento, pero
  la cantidad de momentos de transición expuestos a un reinicio de
  proceso (deploy de Render, restart, ciclo de scale-to-zero de Neon)
  aumenta porque esos momentos ahora están esparcidos en una ventana
  mucho más ancha -- y cada uno protege un recurso (stock retenido, A8.7)
  que para entonces ya estuvo tomado más tiempo que antes. No bloquea el
  cierre de `OUTBOX-BACKOFF-01`; sí es motivo más fuerte para que este
  ítem vaya primero si se retoma la familia.
  **Bloque A -- ✅ RESUELTO (11/09/2026, gate `architecture-governor`,
  `APPROVED WITH CONDITIONS`, cierre `FEATURE VERIFIED`).** Es el
  PRERREQUISITO de idempotencia, no la solución -- **la carrera de
  `OUTBOX-DL-COMPENSATOR-01` sigue abierta, sin cambios**: si el proceso
  muere hoy entre que `recordFailure()` confirma el dead-letter y que el
  compensador termina de correr, el stock sigue quedando retenido para
  siempre, sin que nada lo reintente automáticamente. Lo único que
  cambió es que ahora existe la marca durable en `processed_events` que
  un sweep de recuperación futuro necesitaría para saber si ya corrió --
  ese sweep sigue en HOLD, ver abajo.
  `OutboxWorker.onDeadLetter(eventType, handler, options)` ahora exige
  `options.name` cuando hay `processedEventRepository` (mismo guard que
  `on()`, mensaje espejado) -- **no opcional** como venía en la primera
  propuesta (el gate lo corrigió: opcional + un sweep futuro = un
  compensador sin nombre correría para siempre sin dedup, exactamente el
  modo de degradación que el guard de `on()` existe para impedir).
  `runDeadLetterHandler()` nuevo reclama el casillero en
  `processed_events` ANTES de correr y lo libera si el compensador falla
  -- mismo patrón que `runHandler()`. Nombrado el único compensador real,
  `'inventory:order.confirmed:deadletter-release'`
  (`inventory.handlers.ts:146-150`). 2 tests de integración actualizados
  (`outbox-worker.integration.test.ts`, registraban compensadores sin
  nombre con `processedRepo` presente -- rompían con el guard nuevo) + 5
  tests unitarios nuevos (gana el casillero → corre; ya tomado → saltea;
  falla → libera; sin repo → corre como antes; exige nombre con repo
  presente) + evidencia de mutación (sacar el claim/release pone en rojo
  exactamente los 2 tests que prueban ese mecanismo, aplicada y
  revertida). 38/38 tests de integración contra Postgres real
  (`outbox-worker.integration.test.ts` completo, no solo los 2 tocados).
  **Corrección de hecho del gate sobre mi propio análisis, antes de
  autorizar**: cité `ux_stock_movements_order_item_type` como el índice
  que hace idempotente a `releaseReservationHold()` -- ese índice ya no
  existe (`schema.sql:1827`, dropeado), los vigentes son
  `ux_stock_movements_order_item_type_product`/`_variant` y
  `ux_stock_movements_order_item_resolution_product`/`_variant`
  (`:1828-1843`). La conclusión (idempotente, seguro re-invocar) seguía
  siendo cierta, la cita estaba muerta.
  **El sweep de recuperación (el punto (c) del pedido original) sigue en
  HOLD** -- el gate encontró 5 defectos de diseño reales (D1-D5:
  retrocompatibilidad + sweep = compensador sin nombre corriendo para
  siempre; costo sin auto-límite; claim-before-run angosta la carrera sin
  cerrarla del todo; carrera nueva contra `retryDeadLettered()` manual;
  riesgo de que el propio sweep apague el despacho de un tenant si tira
  `42P01`) y 6 ubicaciones que la matriz de impacto original no
  enumeraba (4 implementadores de `DomainEventRepository`, el propio
  `schema.sql` con `handler_name VARCHAR(100)`, y la decisión explícita
  del 03/09 en el header de `outbox-worker.integration.test.ts` de "no
  agregarle persistencia nueva a `onDeadLetter`" -- que este mismo Bloque
  A revierte a propósito, ya reconocida y dada de baja en ese header).
  Próximo paso: `docs/diseno-outbox-dl-compensator-2026-09-11.md` con la
  matriz completa y las 3 decisiones del dueño (cadencia del sweep,
  observabilidad de la compensación recuperada, backfill sobre
  dead-letters históricos al primer deploy) antes de volver al gate --
  bloque propio, no encarado todavía.
  **§8, nota de interacción cruzada (hallazgo del gate de
  `CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`, 11/09/2026)**: `ensureTenantWorker()`
  ahora tiene DOS call sites -- `tenantMiddleware` (staff) y el middleware
  de `customer.routes.ts` (portal de clientes). El guard nuevo de
  `onDeadLetter()` de este bloque hace que un futuro compensador
  registrado sin nombre (con `processedEventRepository` presente, que
  siempre está en producción) tire una excepción DENTRO de
  `ensureTenantWorker` -- y como el portal ahora también llama esa
  función, ese error ya no solo rompería el arranque para tráfico de
  staff, sino también la PRIMERA request autenticada de un cliente en el
  portal para un tenant sin worker todavía (el `try/catch` del portal
  manda cualquier error no-tenant a `next(err)` → 500). Hoy no hay
  ningún compensador sin nombre (el único real, de inventario, ya lo
  tiene) -- impacto real: cero. Pero es una consecuencia real de que los
  dos bloques compartan el mismo primitivo, y quien agregue el próximo
  `onDeadLetter()` en el futuro tiene que saber que un olvido de nombre
  ahora es visible también desde el portal, no solo desde el panel de
  staff.
  **PUSHEADO Y DEPLOYADO en producción, verificado** (junto con
  `CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001`): 8 commits
  (`2d811d6`..`d495b9f`) pusheados 11/09/2026 con autorización explícita
  del dueño; deploy `dep-daht2c1srm7s73d8l8t0` = `live` (finished
  10:01:56Z), instancia nueva `srv-d8tdt41kh4rs73buo5ng-h8k78`; log de
  build confirma `migrate:tenants` -- `2 negocio(s) con BD asignada.
  Versión objetivo: v48.` / `2/2 OK, 0 fallo(s)` (esperado: ninguno de
  los 8 commits cambia schema); `GET /health/db` = 200 post-deploy.
  **Sin verificar, declarado**: el arranque real de `OutboxWorker` vía
  el nuevo call site del portal (`ensureTenantWorker` desde
  `customer.routes.ts`) es por-tenant y bajo demanda -- solo corre
  cuando llega una request real de ese tenant, no en el boot del
  proceso, así que no aparece en los logs de arranque. Confirmarlo
  requeriría tráfico orgánico real de portal para un tenant, o generar
  una request sintética contra producción -- ninguna de las dos se hizo
  en esta sesión. El deploy en sí está confirmado con evidencia real
  (build, migrate:tenants, health, identidad de instancia); el
  comportamiento del nuevo call site en tráfico real queda para la
  próxima vez que alguien lo audite con datos de producción.
- **Deuda de comentario en `outbox.handlers.ts`** — el docblock de
  `registrarDesenlace()` sigue diciendo que solo `handleOrderCancelled`
  pasa `opts`; desde `6d55876` también `handleReservationCancelled` lo
  pasa. Comment-only, chico.
- **5 bloques `@swagger` sin generar nada** (`auth.routes.ts:154,248,293`,
  `business.routes.ts:48,79`) -- `swagger-jsdoc` no está instalado, esos
  comentarios no alimentan ningún artefacto. Limpieza, no bug.

### 🟢 Deuda aceptada, no bug (documentado, no accionable)

- **`FACT-INV-BIZID-001` / `FAILOPEN-001`** — ✅ triage de seguridad
  07/09/2026 (`pendientes-2026-09-06.md`, HEAD `1e28f8f`) bajó los dos de
  severidad; re-verificado acá el 11/09/2026 contra HEAD `aa607ac` (anclas
  corregidas, la cita original tenía una corrida). Ninguno es riesgo vivo.
  **`FAILOPEN-001`**: el fail-open es solo visibilidad de módulos en el
  menú (`appfrontend-main/src/app/dashboard/NavList.tsx:191-196`, no
  `:182` como decía el triage original). `managementOnly` en el frontend
  (`useIsManagement()`, `useAuthRole.ts:14`) es fail-**closed** (`false`
  sin user), pero no es "el gate real" — su propio docblock aclara que no
  gatea nada por sí solo; el gate real es `authorize()` en el backend,
  que igual se exige en cada ruta.
  **`FACT-INV-BIZID-001`**: los 2 orígenes HTTP directos
  (`invoices.routes.ts:102`/`:127`) siguen siendo `req.user!.businessId!`
  — el cliente no puede inyectar otro valor. Desde el triage original
  aparecieron 4 call-sites más (post cancelar-con-NC,
  `cancel-order-with-credit-note.service.ts:165`/`:332` y
  `cancel-reservation-with-credit-note.service.ts:279`/`:483`) que pasan
  `businessId` de una fila ya leída de la tenant DB, no de `req.user`
  directo — sigue sin ser un hueco porque el aislamiento real es físico
  (una BD por negocio, A2.8; declarado explícito en
  `invoice.repository.ts:193`), no el wiring de `req.user`. Es un
  invariante sin test explícito (defensa en profundidad), no un riesgo
  vivo. Sin acción de código.
- **TTL de NC `PENDING`/`FAILED_UNCERTAIN` huérfana** — verificado contra
  ERPNext/Odoo/QloApps: ninguno tiene TTL automático de una corrección
  fiscal en curso tampoco. Mitigado con `GET /api/invoices?status=` +
  `MID-LOG-001`, ya existentes.
- **A6.6** — quién puede cancelar/rechazar una solicitud de NC en curso.
  No aplica hoy (`credit_note_request` sigue en HOLD) -- anotado para
  cuando se reabra.
- **Guard `pg_constraint` (schema v51, caso 6 residuo parte 2) pierde
  convergencia — `schema.sql`/`repair-tenant-db` ya no corrigen una
  definición divergente de los 3 CHECK de `financial_transactions`.**
  Hallazgo del gate `architecture-governor` al revisar el commit que sigue
  a `2156f76`. El patrón viejo (`DROP CONSTRAINT IF EXISTS` + `ADD
  CONSTRAINT` incondicional) no solo creaba la constraint: la hacía
  converger — reaplicar `schema.sql` contra un tenant con una definición
  vieja la reemplazaba por la canónica del archivo. Con el guard por
  nombre (`IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
  ...)`), eso desaparece: si algún tenant tiene
  `chk_financial_transactions_amount` con una expresión más débil,
  `schema.sql` — ni `POST /repair-tenant-db`, cuyo propio docblock en
  `admin.routes.ts` dice "reparación/mantenimiento puntual" — nunca la va
  a corregir, en silencio. Riesgo medido hoy: cero (revisado el historial,
  bajo estos 3 nombres nunca hubo más de una definición). Riesgo hacia
  adelante: si hace falta CAMBIAR la definición de alguno de estos 3 en el
  futuro, hay que sacar el guard a mano, dejar correr un DROP+ADD real una
  vez, y volver a poner el guard — documentado en el comentario de
  `schema.sql` (bloque `chk_financial_transactions_amount`), pero sin
  cerca que lo haga cumplir. Sin acción de código por ahora — declarado
  para no perder el trade-off si algún día hace falta cambiar una de las
  3 definiciones.
- **`schema.sql` queda con dos patrones de CHECK conviviendo, sin regla
  escrita de cuál usar en un bloque nuevo.** Mismo hallazgo del gate: ~40
  pares `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` incondicionales
  siguen con el patrón viejo, contra 3 con el guard `pg_constraint` nuevo
  (`chk_financial_transactions_*`). Un contribuyente que copie el bloque
  de al lado (`chk_reservations_*`/`chk_products_*`/
  `chk_stock_movements_*` están a pocas líneas) puede quedarse con
  cualquiera de los dos sin saber por qué elegir uno. Sin acción de
  código: no está decidido si migrar los ~40 restantes conviene en todos
  los casos (por la pérdida de convergencia del ítem de arriba), así que
  no hay todavía una regla para escribir.

### Menores / cosmético

- **`INTEGRATION-HARNESS-ORPHAN-DB-01`** 🟠 (11/09/2026, hallazgo del gate
  al revisar `INTEGRATION-HARNESS-DROPDB-MASK-01`, ya cerrado y cortado a
  `docs/resuelto.md` el 13/09/2026 -- ese cierre NO resuelve el huérfano
  real que este ítem describe, condición explícita del gate para no
  montarlos en el mismo commit) -- `createTestDatabase()`
  (`db.ts:127-166`) no tiene try/catch entre `CREATE DATABASE` (`:142`) y
  el `return` (`:166`, después de construir el pool en `:159` y aplicar
  `schema.sql` completo en `:164`). Si el timeout medido (contención real
  contra Neon) ocurre en `:164` -- el paso más probable, aplicar el schema
  entero es lo más lento -- la BD `test_<uuid>` y su pool quedan
  huérfanos: ni `dbName` ni `pool` se asignaron en el test file, así que ni
  siquiera el guard de `dropTestDatabase()` (ya resuelto, ver
  `docs/resuelto.md`) tiene con
  qué buscarlos para dropearlos. Se acumulan hacia el límite de recursos
  de Neon ya documentado (`runbook-deploy-render.md`, 10 branches/proyecto
  plan free) por un camino DISTINTO (bases de datos huérfanas dentro de UN
  branch/proyecto de test, no branches de más). Fix real: try/catch
  DENTRO de `createTestDatabase()` que cierre el pool (si llegó a
  construirse) y dropee la BD (si llegó a crearse) antes de relanzar el
  error original -- bloque propio, con su propio gate.
- **`OUTBOX-DL-THROTTLE-RESET-01`** 🟠 — el cooldown del aviso de
  dead-letter se resetea con `pool.on('error')`, correlacionado con
  outages. Techo real sigue bajo, no urgente.
- **`EMAIL-FROMNAME-RFC5322-01`** 🟠 — `email.sender.ts:72`, `from` sin
  quotear ante `"`/`<`/`,`/`;` en `display_name`.
- **Desfase de fecha "08/09"→"07/09"** en ~5 docs -- verificar si sigue
  aplicando (puede que ya se haya corregido en una sesión posterior).
- **`DA-CONT-001`**, **`DOC-ANCLA-001`**, ficha M10 desactualizada --
  **mecanismo recuperado (11/09/2026, auditoría de arrastre)**: el ancla
  sobrevivió el arrastre pero el detalle se degradó por el camino --
  `pendientes-2026-09-06.md:1132` sí tenía el mecanismo completo:
  `erp-auditoria-v2/fichas/M10-facturacion.md:133` dice "6 decisiones
  abiertas" cuando en realidad ya están cerradas. No verificado de nuevo
  contra la ficha real en esta pasada -- solo se restituyó la cita que se
  había perdido, para que la próxima sesión no tenga que re-derivarla.
- **`C-5`** (`FACT-BORRADOR-001`, v2.13, sigue en HOLD sin aprobar; C-5 vive
  acá, en pendientes -- la tabla de §26.1 del propio documento solo tiene
  C-1 a C-4, no hay una fila C-5 ahí) -- hallazgo de
  `pendientes-2026-09-06.md:1131`: la rama de origen
  `RECEIVABLE` aparece en §8 del documento de diseño y desaparece en §24,
  inconsistencia interna del propio doc. Se perdió en el salto a
  `pendientes-2026-09-08.md`, encontrado en la auditoría de arrastre
  (11/09/2026). **Re-verificado contra el documento real el 11/09/2026
  (sesión de reconciliación, ver abajo) -- confirmado, sigue sin
  resolver**: `source_type` (§6/§8, líneas del borrador) admite
  `ORDER_ITEM`/`RESERVATION`/`RECEIVABLE`/`FREE`; `source_kind` (§24,
  líneas emitidas) admite `ORDER_ITEM`/`RESERVATION`/`STAY`/`MANUAL` --
  dos catálogos sin mapeo declarado entre sí, ninguno menciona al otro.
  Impacto bajo mientras el diseño siga sin aprobar, pero hay que
  resolverlo antes de aprobar `FACT-BORRADOR-001`, no después.
- **Reconciliación `FACT-BORRADOR-001` vs. pedido del dueño "no se debería
  facturar con un solo click, revisá el modelo de Odoo" (11/09/2026)** --
  el pedido derivó primero en un documento nuevo
  (`diseno-factura-borrador-confirmar-2026-09-11.md`) escrito **sin buscar
  antes si ya existía diseño para el mismo problema**. Sí existía:
  `FACT-BORRADOR-001` (11 días más viejo), con D3 (descarte por
  `status='DISCARDED'`, nunca `DELETE` físico) y D4 (permiso separado
  `FISCAL_ISSUE` para confirmar/emitir) ya decididos por el dueño --
  contradichos por la propuesta nueva sin saberlo. **Corregido**: el
  documento nuevo quedó retirado (su cabecera explica la contradicción
  punto por punto) y sus tres aportes reales -- grounding contra Odoo
  19.0 real confirmando el mínimo de 3 pasos, un hueco no tratado en
  ninguna de las 26 secciones de `FACT-BORRADOR-001` (los guards
  `OrderCancelledCannotInvoiceError`/`ReservationCancelledCannotInvoiceError`,
  definidos en `errors.ts:783`/`:825`, lanzados en
  `invoice.service.ts:423`/`:439` (individual) y `:584`/`:592`
  (consolidada) -- nunca se revalidan al confirmar un borrador que vivió
  varios días; el camino de un solo paso ya lo prueba hoy con 3 suites
  TOCTOU de integración, que dejarían de sostener la garantía en cuanto
  crear y emitir dejen de ser la misma transacción), y la pregunta sin
  resolver de qué pasa con `POST /api/invoices` (la ruta de un solo paso
  actual, ya citada en el doc) una vez que exista el camino de borrador --
  se trasladaron al **§27** (nuevo, v2.9) de `FACT-BORRADOR-001`. Revisado
  por el gate `architecture-governor` -- **APPROVED WITH CONDITIONS**,
  4 correcciones aplicadas (anclas de §27.2, cita de C-5, bump de versión,
  y esta misma entrada). Commit pendiente, 3 archivos en un solo commit
  doc-only (`diseno-factura-borrador-2026-08-31.md`,
  `diseno-factura-borrador-confirmar-2026-09-11.md`, este archivo).
  El estado real sigue siendo el de antes: diseño **no aprobado**,
  bloqueado por C-1 a C-4 (§26.1, mecánico) + C-5 (arriba, de decisión) +
  las 5 decisiones de negocio de §26.3 (presupuesto de reintentos de
  `ISSUED_PENDING_LEDGER`, quién ve esa cola, borradores abandonados,
  cliente dado de baja, cierre de caja) + ahora también §27.2 (revalidar
  cancelación al confirmar, mecánico) y §27.3 (destino de la ruta de un
  solo paso, decisión). No se implementó código en esta sesión.

  **Estado actualizado 14/09/2026 — no se reescribe lo de arriba (es el
  registro de la sesión del 11/09), se corta acá lo que ya no aplica.**
  Decisiones de negocio completas: las 5 de §26.3 (1-3 por consenso de
  grounding, 4 decidida por el dueño el 13/09, 5 —cierre de caja— decidida
  por el dueño el 14/09) y §27.3 (destino de `POST /api/invoices`:
  retirar o redirigir, decidida por el dueño el 14/09) — ambas registradas
  con su texto completo en `docs/diseno-factura-borrador-2026-08-31.md`
  §26.3 y §27.3. Quedan sin decisión del dueño: **C-1 a C-4** (§26.1,
  mecánicos, no requieren al dueño, no bloqueantes) y **§27.2**
  (mecánico, revalidar cancelación al confirmar, no bloqueante). **C-5**
  (arriba) sigue siendo **BLOQUEANTE — decisión de modelado, no
  mecánica**: el propio diseño (§27.4) dice explícito que su resolución
  "NO es mecánica: falta decidir si una línea consolidada (RECEIVABLE)
  viaja a `invoice_items` como `MANUAL` (perdiendo la distinción) o si
  `source_kind` necesita una quinta rama", y §28.3 la mantiene como
  bloqueante que **DESAPARECE si D2 se formaliza** — condicional a una
  formalización de D2 que todavía no pasó por ningún gate. No reclasificar
  a "mecánico" hasta que esa formalización ocurra.

  **`PN-2`** (§21 del diseño — "¿la regla de cuenta corriente que puede
  rechazar la emisión, D1, es el booleano `customers.enable_current_account`
  por cliente o un tope de crédito por tenant a construir?") fue un
  hallazgo nuevo de esa misma sesión, no una de las preguntas que había
  venido a cerrar — no aparecía en la lista de bloqueantes de arriba
  (11/09) ni en ninguna sesión anterior de este archivo; se encontró al
  verificar, antes de declarar el diseño "completo del lado de negocio",
  que no quedara ninguna otra pregunta de negocio suelta en el documento.
  Fue la única pregunta de negocio que seguía bloqueando el `CREATE TABLE`
  — y **también se cerró, más tarde el mismo 14/09/2026: DECIDIDA por el
  dueño, la condición es el booleano `customers.enable_current_account`
  por cliente, no un tope de crédito por tenant** (esa segunda idea queda
  como backlog futuro explícito, no descartada — ver
  `### 📋 Backlog de producto` más abajo). Detalle completo:
  `docs/diseno-factura-borrador-2026-08-31.md` §21/§30.4 (v2.13).
  **Estado resultante: decisiones de negocio del dueño COMPLETAS —
  listo para gate de arquitectura antes de implementar, bloque grande de
  implementación no encarado todavía.**

  **`PN-3` y `PN-5`** (§21 del diseño) — promovidas acá el 14/09/2026,
  mismo motivo que `PN-2` arriba: viven en §21 (y sus referencias en
  §22/§27.4/§28.3/§11.1) pero no estaban en ningún `pendientes-*.md`
  todavía. Ninguna de las dos bloquea el `CREATE TABLE` (§21 solo lista
  PN-1/PN-2/PN-4 entre "las tres primeras que bloquean"); las dos siguen
  abiertas, fuera del camino crítico (§30.3).
  - **`PN-3`** (numeración humana de `orders`) — fuera de alcance
    declarado en §22, comportamiento de fallback ya resuelto en §21/§22
    (el snapshot guarda la etiqueta que exista).
  - **`PN-5`** (recálculo de `CbteFch` en un reintento tardío) — un
    borrador que falla la emisión y se reintenta días después reutiliza
    un `CbteFch` congelado y puede ser rechazado por AFIP (error 10016).
    §11.1 lo describe como "bug preexistente, independiente de este
    diseño", pero esa defensa queda debilitada: T6 (`retryExisting()` sin
    cambios) + el estado `EMISSION_FAILED` de §5 hacen que el flujo de
    borrador nuevo herede exactamente este problema — no es puramente
    preexistente, el diseño nuevo lo reproduce puertas adentro.
- **Instrucción del dueño (11/09/2026, mismo bloque): re-verificar D1-D6
  contra Odoo 19.0 real, con Odoo ganando donde diverja "más allá de las
  decisiones que haya tomado antes"** -- **resuelta** (`FACT-BORRADOR-001`
  v2.10, §28). Historia del proceso, no solo el resultado: una primera
  ronda propuso D3 "retirada hacia Odoo, con condición" citando R14 mal
  (`criterios-datos.md:255-259` es "un solo camino de escritura", nada
  sobre borrado/edición) -- el gate `architecture-governor` lo encontró
  antes de aprobar el commit. Re-anclada contra la regla real (tabla de
  clasificación `criterios-datos.md:20-28`, fila "¿Se borra? Nunca. Se
  cancela o se revierte" -- independiente de la fila "¿Se edita? Solo
  antes de confirmarse") y contra el precedente real y directo de
  `orders` (la entidad que el documento dice imitar: tiene su propio
  `DRAFT`, *"carrito abierto sin confirmar"*, y la transición real es
  `DRAFT → CANCELLED` -- cero `DELETE FROM orders` en todo el módulo, ni
  siquiera para el carrito más abandonado posible), la conclusión se
  revirtió y el dueño confirmó D3 **mantenida** con la evidencia completa
  delante -- mismo trato que D6 recibió cuando su primer research resultó
  incompleto. Resultado final, las 6:
  - **D1 (cuándo nace el cargo), D3 (descarte de borrador, `DISCARDED`
    siempre, nunca `DELETE` físico en ningún estado), D4 (permiso fiscal
    separado), D5 (revalidación de catálogo fiscal) -- MANTENIDAS.** Cada
    una tiene una razón de dominio real ya verificada contra este repo:
    AFIP es constitutivo (D1); `orders` ya resolvió el mismo escenario de
    "carrito abandonado" sin borrado físico (D3); `CN-ESCAPE-CONTAINMENT-001`
    ya separa el mismo tipo de acto fiscal en otro punto del sistema (D4);
    `afip-catalog.constants.ts` ya implementa la defensa que D5 exige, y
    funciona (D5).
  - **D2 (origen de línea), D6 (columna de descuento) -- retiradas hacia
    el patrón de Odoo,** con riesgos reales aceptados explícitamente, no
    ausentes: D2 contradice una regla ya escrita del `CLAUDE.md` raíz de
    este repo (prohíbe "N columnas nullable sin discriminador" para
    "exactamente uno de N") y pierde la distinción entre línea `MANUAL` y
    origen perdido por bug; D6 pierde la capacidad de cargar un descuento
    como monto fijo sin porcentaje.
  - `§8`/`§24`/`§7.5`/`T18` de `FACT-BORRADOR-001` quedan `SUPERSEDIDAS`
    (D3 no genera ninguna -- §4.3 queda intacta). `C-5` (arriba) queda sin
    objeto si D2 se formaliza.
  - Sigue sin autorizar `CREATE TABLE`, migraciones ni código -- disposición
    de diseño, pendiente de pasar por el gate `architecture-governor`.
- **`generate-route-inventory.ts` conecta contra la BD de plataforma
  REAL cuando se corre local** (10/09/2026, hallazgo de paso al
  regenerar `docs/inventario-rutas.md`) -- el docblock del script
  afirma "una `PLATFORM_DATABASE_URL` dummy" (línea 21), pero
  `process.env['PLATFORM_DATABASE_URL'] ??= '...dummy...'` (línea 98)
  con `??=` no pisa un valor YA seteado -- y `.env` local sí trae la
  URL real de producción. Efecto observado: bootea `createApp()` +
  arranca `CompanyCatalogPropagationWorker` contra la BD real por unos
  cientos de ms antes de pararlo. **Verificado sin escritura real**: el
  worker usa `setInterval(POLL_INTERVAL_MS=10_000)`, nunca tiquea antes
  de que el script llame `stopCompanySyncWorker()`; el diff del
  inventario generado fue exactamente el esperado (solo la ruta nueva
  agregada, sin ruido). No urgente -- pero el docblock miente sobre su
  propio comportamiento en un entorno con `.env` real, y vale la pena
  corregirlo (ej. no usar `??=`, exigir explícitamente que no haya
  `PLATFORM_DATABASE_URL` real seteada, o aceptar el comportamiento y
  corregir el comentario).

### 📋 Backlog de producto (sin fecha, roadmap -- no re-auditado)

`Gap C1-C` · `AR-FACT-NO-ISSUED-01` Fases 2-8 · `FACT-BORRADOR-001` (v2.13,
decisiones de negocio completas, pendiente de gate + implementación)
· C1-B (bloqueada por proveedor externo) · C2/C3 · D7 (5 endpoints de
reportes sin consumidor de frontend) · circuito POS-caja (`ORDER-12`/
`CAJA-ORD-01`/`AUDIT-ORD-01`) · heredados (Redis, BullMQ, downgrade de
plan, datos demo en prod).

- **Tope de crédito por tenant en cuenta corriente** — idea de producto
  validada por el dueño (14/09/2026), no construida: *"La feature nueva
  está bien pero no para ahora"*. Surgió como la alternativa descartada al
  resolver `PN-2` de `FACT-BORRADOR-001` — hoy la única regla real que
  puede rechazar la emisión por cuenta corriente es
  `customers.enable_current_account`, un booleano **por cliente**
  (`sql.customer.repository.ts:321`); esto agregaría, aparte, un límite de
  monto configurable **por tenant** que hoy no existe en ningún lado del
  schema. Sin diseño todavía — ni tabla, ni dónde vive el límite, ni qué
  pasa al superarlo (¿rechaza la emisión, solo advierte, requiere
  aprobación?). Ver `docs/diseno-factura-borrador-2026-08-31.md` §22 y
  §30.4 para el registro completo de la decisión que lo dejó fuera de
  alcance.

**Ojo, esto es distinto del roadmap de producto completo**
(`docs/roadmap-pms-multirubro.md`, qué le falta a la app por rubro) --
ese documento NO se leyó en esta sesión ni en esta consolidación. Por
regla del proyecto no se lee automáticamente cada sesión; pedilo aparte
("repasá el roadmap") si lo querés en el radar.

### ✅ Cerrado, confirmado durante esta lectura (no estaba marcado así antes)

**Movido a `docs/resuelto.md`** — corrección de etiqueta del mismo FN#2
(`lock-order.test.ts`) ya registrado como cerrado en `docs/resuelto.md`.
