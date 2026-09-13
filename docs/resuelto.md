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
  `src/facturacion/sql.invoice.repository.ts:1069-1076`) seguía sin
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
