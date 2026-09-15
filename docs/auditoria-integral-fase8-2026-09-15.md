# Auditoría técnica integral — Fase 8: revisar errores y observabilidad

Fecha: 15/09/2026
Repos: `app-main` (backend, `/home/user/app`) · `appfrontend-main` (frontend, `/home/user/appfrontend`)
Fase previa: `docs/auditoria-integral-fase7-2026-09-15.md`
Alcance: manejo de errores, ciclo de vida del fallo y observabilidad. **Cero cambios de código** — fase de análisis.

---

## 0. Método y criterio

Esta fase **no re-investiga** las cuatro operaciones críticas que las fases 3, 6 y 7 ya
recorrieron desde otros ángulos (`C6-06`, `C6-09`, `C6-10`, `C6-15`, `F7-04`, `F7-05`,
`F7-07`). Las reusa como evidencia y les aplica las **7 preguntas** del protocolo, que
ninguna de esas fases respondió como conjunto: en particular la 6 (*¿puede dejar el
sistema en un estado intermedio?*), que es la que produce la mitad de los hallazgos
nuevos de acá.

Lo que sí se levantó de cero: logs con datos sensibles, identificadores de correlación,
información de versión, reintentos sin tope, catches que tragan, y el registro de
errores como canal (qué llega a Sentry y qué no).

Qué se leyó completo (no en diagonal): `src/logger.ts`, `src/instrument.ts`,
`src/app.ts` (secciones 1-6 y 18), `src/api/middleware/error.middleware.ts`,
`src/db/pg.transaction-manager.ts`, `src/repositories/sql.client.ts`,
`src/workers/outbox.worker.ts`, `src/workers/outbox.handlers.ts`,
`src/workers/outbox.registry.ts`, `src/workers/adaptive-poller.ts`,
`src/workers/dead-letter-notify.ts`, `src/workers/reservation-hold-expiry.worker.ts`,
`src/repositories/processed-event.repository.ts`,
`src/repositories/sql.domain-event.repository.ts`, `src/platform/tenant.middleware.ts`,
`src/platform/tenant-db.setup.ts`, `src/platform/neon-provisioning.ts`,
`src/platform/admin.routes.ts`, `src/platform/business.routes.ts` (alta),
`src/platform/platform.routes.ts` (provision), `src/platform/company-sync.worker.ts`,
`src/facturacion/invoice.service.ts` (`requestInvoice`/`issue`/`reconcileAfterFailure`/
`retryExisting`/`finalizeIssued`), los dos `cancel-*-with-credit-note.service.ts`,
`src/clientes-finanzas/customer-account.service.ts` (`recordPayment`), y del frontend
`src/app/dashboard/cuentas-corrientes/page.tsx` + `src/lib/http.ts`.

Mediciones reproducibles (comando y resultado, no estimación):

| Medición | Comando | Resultado |
|---|---|---|
| Call sites de `logger.<nivel>(` en producción | script node que recorre `src/**/*.ts` excluyendo `*.test.ts` y balancea paréntesis de cada llamada | **98** |
| …de esos, con `businessId` o `tenant:` dentro de la MISMA llamada | mismo script, regex sobre el texto de la llamada | **30** (+6 que lo reciben por spread `...base` en `outbox.handlers.ts:596,601,621,650,651,652` → **36** reales) |
| `console.*` en `src/` fuera de `scripts/` y tests | `grep -rn "console\." src --include="*.ts" \| grep -v /scripts/ \| grep -v .test.ts` | **0** usos reales (4 coincidencias, todas dentro de strings de ayuda) |
| Catches vacíos `catch {}` | `grep -rn -A2 "} catch {" src` | **10**, todos con comentario; 3 son hallazgo (F8-04, F8-13) |
| Dependencias de métricas/tracing | `package.json` | `@sentry/node` únicamente. **No** hay `prom-client`, statsd, ni OpenTelemetry propio |
| `Sentry.captureException` en producción | `grep -rn "Sentry\." src` | **2 sitios, los dos en el arranque** (`server.ts:56`, `server.ts:88`) |
| `process.on('unhandledRejection'\|'uncaughtException')` | `grep -rn "process.on" src` | **0** (solo `SIGTERM`/`SIGINT` en `app.ts:592-593`) |
| Versión del código expuesta o logueada | `grep -rn "RENDER_GIT_COMMIT\|COMMIT_SHA\|APP_VERSION\|npm_package_version" src` | **0** |

---

## 1. El checklist de observabilidad del protocolo, respondido primero

Va antes que las operaciones críticas a propósito: seis de las siete respuestas
condicionan qué se puede afirmar sobre *"¿se puede reproducir?"* y *"¿hay suficiente
información para diagnosticarla?"* en cada operación.

| Mecanismo | Existe | Evidencia | Qué falta |
|---|---|---|---|
| **Logs estructurados** | **Sí, y bien** | `src/logger.ts` — único punto de creación de `pino` del proceso, JSON de una línea en producción, `pino-pretty` fuera. Los mejores sitios usan una clave `evento:` estable y consultable (`outbox.handlers.ts:596-652`, `invoice.service.ts:516`, `order.service.ts:455`) y una política declarada de qué NO se loguea (`error.middleware.ts:79-84`, MID-LOG-001: *"NUNCA `err.message`"*) | `redact` no está configurado en `pino()` — ver F8-10 |
| **Identificadores de correlación** | **No, en la práctica** | `pinoHttp` asigna `req.id`, pero (a) el default de pino-http 11.0.0 es un **contador entero por proceso** (`node_modules/pino-http/logger.js:236-238`), no un UUID como afirma el comentario de `app.ts:142`; (b) **`req.log` no se usa en ningún archivo del repo** (`grep -rn "req\.log" src` → 0), así que las 98 llamadas a `logger.*` salen del logger de módulo, sin `req.id`; (c) `domain_events.correlation_id`/`causation_id` existen en el schema y su propio contrato dice *"Hoy SIEMPRE null"* (`domain-event.repository.ts:16-18`) | F8-11 |
| **Métricas** | **No** | Ninguna dependencia de métricas. Los únicos números observables son `uptimeSeconds` (`/health`) y `countDeadLettered()` vía `GET /api/system/outbox/...` | Sin hallazgo propio: es una ausencia total y declarada por el stack, no una degradación silenciosa. Se registra como brecha en §4 |
| **Trazas** | **Parcial** | `Sentry.init({ tracesSampleRate: 0.1 })` (`instrument.ts:18-24`) instrumenta express/pg al 10% | Sin `release`, así que una traza no se puede atar a un commit (F8-12). Los workers no generan trazas (no hay `startSpan` en ningún lado) |
| **Información de versión** | **No** | `package.json` dice `1.0.1` y ese dato no aparece en ningún log, endpoint ni en `Sentry.init`. `/health` devuelve `status`/`mode`/`uptimeSeconds` (`app.ts:225-231`) | F8-12 |
| **Registro de errores** | **Parcial, con un filtro por clase** | `Sentry.setupExpressErrorHandler(app, { shouldHandleError: err => !(err instanceof DomainError) && !(err instanceof ValidationError) && !(err instanceof ZodError) })` (`app.ts:540-545`) | El filtro es por CLASE, no por severidad: `AFIP_REQUEST_UNCERTAIN` es `DomainError` → nunca llega a Sentry. Y los workers no pasan por express → **ningún** fallo de outbox/hold-expiry/company-sync llega a Sentry (F8-03, F8-08) |
| **Mecanismos para reproducir fallos** | **Parcial** | Suite con Postgres real (`*.integration.test.ts`), `?fresh=1` en `/health/db`, `POST /api/system/outbox/:id/retry`, `npm run docs:routes` | No hay captura del payload del request que falló, ni forma de re-ejecutar un request; el `afipRequest` persistido en la columna `JSONB` es el único payload externo reproducible del repo (y eso es un efecto lateral de F7-04(b), no un mecanismo de diagnóstico diseñado) |

---

## 2. Las cuatro operaciones críticas × las 7 preguntas

### 2.1 `TransactionManager.run()` — el mecanismo del que depende toda la atomicidad

Reusa `C6-06` (Fase 6: la interfaz no declara contrato, el ROLLBACK puede enmascarar
el error original, `rowCount?` es opcional). Ancla: `src/db/pg.transaction-manager.ts`
(43 líneas, leído completo), `src/db/transaction-manager.ts` (15 líneas),
`src/repositories/sql.client.ts:6-11`. **69 call sites** en 25 archivos
(`grep -rn "transactionManager\.run" src | grep -v test | wc -l` → 69).

**1. ¿Cómo falla?** Cuatro formas, ninguna declarada en la interfaz: (a) `pool.connect()`
falla → no hay transacción, error de infraestructura limpio; (b) `BEGIN` falla → ídem;
(c) `work` lanza → `:39` corre `ROLLBACK` y `:40` re-lanza; (d) **`COMMIT` falla
(`:36`)** → el catch corre `ROLLBACK` sobre una conexión cuyo COMMIT ya se envió al
servidor.

**2. ¿Cómo se informa?** Se re-lanza tal cual, sin envolver. El caller decide: en
`*.routes.ts` va a `next(err)` → `error.middleware.ts`. Si el error es `DomainError`
sale con su status; si es el error de pg del ROLLBACK/COMMIT, cae a
`error.middleware.ts:115-119` → `logger.error({ err })` + `500 INTERNAL_ERROR`.

**3. ¿Cómo se registra?** `run()` **no loguea nada**. El único registro es el del borde
HTTP. Para los 3 call sites que están dentro de un worker (`outbox.handlers.ts:685`,
`inventory.handlers.ts`, `reservation-hold-expiry.worker.ts:96`) el registro es el
`logger.error({ err, eventId, eventType })` de `outbox.worker.ts:435` — sin `businessId`
(F8-08).

**4. ¿Se puede reproducir?** Los efectos transaccionales sí, y están cubiertos: 4 archivos
`*-transactional.integration.test.ts` contra Postgres real. El **modo de falla del
ROLLBACK, no**: exige matar la conexión entre el fallo de `work` y el `ROLLBACK`
(`pg_terminate_backend` desde una segunda sesión). No hay ningún test así.

**5. ¿Se puede reintentar con seguridad?** **Depende del caller, y `run()` no lo dice.**
Los callers que tienen clave natural se auto-curan (`invoices.idempotency_key`
`invoice:<ftId>`, `financial_transactions.idempotency_key`, el `NOT EXISTS` por
`order_id` de `createOrderChargeIfConfirmed`, `processed_events`). Los que no la tienen,
no: `recordPayment()` con `idempotencyKey` ausente (F8-15) y el cierre de turno de caja
(`C6-10` grupo B).

**6. ¿Puede dejar el sistema en un estado intermedio?** **Sí, dos formas, y es lo que
`C6-06` no cubrió** → F8-01. (i) *COMMIT ambiguo*: si `:36` falla por corte de conexión,
la transacción pudo haberse confirmado del lado del servidor; el caller recibe una
excepción y no tiene forma de distinguir "no pasó nada" de "pasó todo". (ii) *Conexión
devuelta al pool en estado abortado*: `:42` hace `conn.release()` **sin argumento** — si
el `ROLLBACK` de `:39` no llegó a ejecutarse, la conexión vuelve al pool dentro de una
transacción fallida y el próximo request que la tome recibe `25P02 current transaction
is aborted` en la primera query.

**7. ¿Hay suficiente información para diagnosticarla?** **No, para el caso (c)+(d).** Es
el hueco (a) de `C6-06` visto desde esta fase: el error del ROLLBACK **reemplaza** al de
negocio y nada loguea el original antes de perderlo. En producción se vería un
`500 INTERNAL_ERROR` con el mensaje del ROLLBACK y ninguna traza de qué regla se
violó.

### 2.2 `InvoiceService.requestInvoice()` y la llamada a AFIP

La operación más financiera + externa del repo. Reusa `F7-04` (el puerto deja pasar el
request crudo, el payload es una columna `JSONB`), `C6-09` (un rechazo documentado sale
500) y `C6-15` (el warning se pierde en el reintento). Ancla:
`src/facturacion/invoice.service.ts:524-674` (`requestInvoice`), `:1444-1528` (`issue`),
`:1531-1578` (`reconcileAfterFailure`), `:1371-1389` (`retryExisting`), `:1403-1407`
(`finalizeIssued`), `src/domain/errors.ts:531-544`.

**Forma real del ciclo de vida:** una transacción de BD crea `invoices` + líneas +
auditoría (`:606-671`, con los locks TOCTOU de ORDER-10/RESERVA-10 adentro); **después**,
fuera de toda transacción, `issue()` habla con AFIP (`:673`).

**1. ¿Cómo falla?** Seis desenlaces distintos, todos explícitos en el código:

| Desenlace | Dónde | Estado persistido | Error tipado |
|---|---|---|---|
| No se pudo ni preguntar el último comprobante | `:1449-1472` | `FAILED_UNCERTAIN`, `afipContacted: false` | `AfipRequestUncertainError` |
| AFIP rechaza (`resultado === 'R'`) | `:1481-1503` | `REJECTED`, `afipContacted: true`, `afip_response` crudo | `AfipRequestRejectedError` → 422 |
| AFIP responde sin `CbteDesde`/`CAE` | `:1505-1519` | `FAILED_UNCERTAIN`, `afipContacted: true` | `AfipRequestUncertainError` → 409 |
| Error de red al pedir el CAE, y `FECompUltimoAutorizado` **sí** avanzó | `:1546-1557` | `ISSUED` con el CAE recuperado | ninguno — se recupera |
| Error de red, y no avanzó (o no se pudo reconciliar) | `:1559-1577` | `FAILED_UNCERTAIN`, `afipContacted: true` | `AfipRequestUncertainError` → 409 |
| Guard cruzado de doble facturación | `:550,553` | nada | `InvoiceAlreadyLinkedByOtherPathError` → **500 por falta de `case`, `C6-09`** |

**2. ¿Cómo se informa?** Al usuario: status + `err.message` completo por la rama
`DomainError` de `error.middleware.ts:107-110`. El frontend lo muestra en un toast
(`FacturarButton.tsx:135-142`). Dos problemas: el mensaje del caso ambiguo lleva
`JSON.stringify(result.raw)` adentro (`:1506`) → la respuesta cruda de WSFEv1 viaja al
navegador (F8-03); y `INVOICE_ALREADY_LINKED_BY_OTHER_PATH` sale con status 500 aunque
el mensaje sea correcto (`C6-09`, ya corregido en su propia ficha).

**3. ¿Cómo se registra?** **En la fila de `invoices`, no en el log** — y eso es mejor que
un log: `error_message` + `afip_response` + `afip_contacted` quedan durables y
consultables. El log solo aporta el `logger.warn({code,status,method,url,businessId})` de
`error.middleware.ts:96-105` por ser ≥409. `issue()` no tiene ninguna llamada a
`logger`. **Sentry no ve ninguno de los seis desenlaces** (todos son `DomainError`,
filtrados en `app.ts:540-545`).

**4. ¿Se puede reproducir?** Sí para los seis, con un fake del puerto: `AfipBillingPort`
(`afip-billing.port.ts`) es inyectable y `invoice.service.test.ts` ya ejercita los
errores y la idempotencia. Lo que **no** es reproducible hoy es el estado intermedio de
F8-02 (exige hacer fallar la escritura de `markFailed` después de que el fake respondió).

**5. ¿Se puede reintentar con seguridad?** **Sí, y es el mejor mecanismo del repo** —
con un hueco. La clave determinística `invoice:${financialTransactionId}` (`:530`) hace
que todo reintento pegue contra la misma fila, y `retryExisting()` (`:1371-1389`)
decide por estado: `ISSUED` → devuelve; `FAILED_UNCERTAIN` con `afipContacted` y sin
`uncertainClearedAt` → **devuelve sin reintentar** (fail-closed correcto, no se pide un
segundo CAE sobre una incertidumbre viva); el resto → reintenta con el MISMO
`afipRequest` persistido. El hueco es que `PENDING` está en "el resto" y se puede llegar
a `PENDING` **después** de haber contactado a AFIP (F8-02).

**6. ¿Puede dejar el sistema en un estado intermedio?** **Sí, uno reconocible y uno no
documentado.**
- *Reconocible:* `FAILED_UNCERTAIN` es un estado de primera clase, con `afipContacted`
  para distinguir "seguro no se emitió" de "no se sabe", visible en la UI
  (`dashboard/facturacion/page.tsx:123` lo rotula "Incierta") y con una bandeja de
  resolución manual desde el 15/09/2026 (`credit-note-requests.routes.ts`,
  `markUncertainClearedWithClient`). Esto está bien resuelto.
- *No documentado:* si la escritura de `markFailed`/`markFailedWithClient` falla
  (`:1471`, `:1490`, `:1512`, `:1565`) la factura queda **`PENDING` con AFIP ya
  contactado**, y el error que sale es el de la BD, no el de AFIP → F8-02.

**7. ¿Hay suficiente información para diagnosticarla?** Sí, salvo en un punto: el
`catch {}` de `:1541` descarta la causa de por qué no se pudo reconciliar
(F8-04), y el mensaje final solo dice "no avanzó de forma confirmable" — que es
verdad y no dice si la reconciliación se intentó y falló, o si se intentó y dio un
número que no avanzó. Son dos situaciones operativas distintas.

### 2.3 La saga de aprovisionamiento de tenant

Reusa `F7-05` (cuatro copias, ninguna transaccional, ninguna con compensación) y
`F7-04(c)` (Neon sin puerto). Ancla: `src/platform/business.routes.ts:173-184`,
`src/platform/platform.routes.ts:399-411`, `src/platform/admin.routes.ts:88-110` y
`:135-155`, `src/platform/neon-provisioning.ts:104-141`,
`src/platform/tenant-db.setup.ts`, `src/platform/platform.repository.ts:578-602`.

**1. ¿Cómo falla?** Cinco pasos, cinco puntos de fallo, **cero compensación**:
`provisionTenantDatabase()` (2 llamadas HTTP a Neon) → `applyTenantSchema()` (DDL
completo) → `encryptConnectionString()` → `activateBusiness()` → `updateSchemaVersion()`.
Los dos últimos son **dos UPDATE sueltos** contra la BD de plataforma
(`platform.repository.ts:583-588` y `:598-601`), sin `runInTransaction`.

**2. ¿Cómo se informa?** Tres políticas distintas para la misma secuencia: alta pública
→ **fail-open declarado** (`business.routes.ts:182-184`, el registro devuelve 201 y el
mensaje dice *"falta activar su base de datos — contactá a soporte"*); panel de
superadmin → `next(err)` → 500 genérico; las dos de `admin.routes.ts` → 500 + un
`logger.error({ err })` local.

**3. ¿Cómo se registra?** `logger.error({ err: provisionErr, businessId })`
(`business.routes.ts:183`) y `logger.error({ err })` (`admin.routes.ts:111,159` — **sin
`businessId`**). Loguear el `err` completo es lo que convierte F8-06 en fuga de secreto.

**4. ¿Se puede reproducir?** Parcialmente. No hay ningún test de integración de los 4
caminos (`F7-05` ya lo pidió como característica de regresión previa a extraer el
servicio). Reproducirlo exige o la API de Neon o un doble, y hoy `provisionTenantDatabase`
es una **función suelta no inyectable** (`F7-04(c)`), así que no hay punto de sustitución.

**5. ¿Se puede reintentar con seguridad?** **No del todo.** El único guard del reintento
es `if (business.dbUrlEncrypted) → 400 ALREADY_PROVISIONED`
(`platform.routes.ts:396-399`). Ese campo se escribe en el **paso 4 de 5**: cualquier
fallo en los pasos 1-3 deja el guard abierto y el reintento **crea un branch de Neon
nuevo**. El connection string del branch anterior solo existió en una variable local.

**6. ¿Puede dejar el sistema en un estado intermedio?** **Sí, cuatro, enumerados** →
F8-05:

| Falla en | Qué queda en Neon | Qué queda en la BD de plataforma | Detectable desde el producto |
|---|---|---|---|
| `provisionTenantDatabase` (branch creado, `connection_uri` falla) | branch + compute endpoint **huérfanos** | `status=PENDING`, `db_url_encrypted=NULL` | **No** — nada guarda el branch id |
| `applyTenantSchema` | branch vivo, schema a medias (`schema.sql` se aplica como **un solo `pool.query(sql)`**, sin transacción explícita) | ídem | **No** |
| `encryptConnectionString` (falta `DB_ENCRYPTION_KEY`) | branch vivo con schema completo | ídem | **No** |
| `updateSchemaVersion` | branch correcto | **`status=ACTIVE` con `schema_version` stale/NULL** | Sí, pero **solo como `logger.warn`** en el primer cache-miss del pool (`tenant.middleware.ts:91-96`, fail-soft declarado) |

**7. ¿Hay suficiente información para diagnosticarla?** **No.** `repair-tenant-db`
**no es la compensación de esta saga**: apunta el negocio a
`process.env.DATABASE_URL` — la base del **propio proceso**, compartida
(`admin.routes.ts:67-100`) — no al branch huérfano, cuya URL ya no existe en ningún
lado. Recuperar el branch exige entrar a la consola de Neon a mano. El archivo se
autodescribe como *"herramienta de uso único para negocios sembrados directo por SQL"*
(`admin.routes.ts:6-9`): es honesto, y significa que la saga sigue sin reparación
propia.

### 2.4 `OutboxWorker` / `outbox.handlers.ts` — el mecanismo de reintento central

Ancla: `src/workers/outbox.worker.ts` (635 líneas, leído completo),
`src/workers/outbox.handlers.ts` (789), `src/repositories/sql.domain-event.repository.ts:100-189`,
`src/repositories/processed-event.repository.ts`, `src/workers/outbox.registry.ts:72-186`,
`src/workers/dead-letter-notify.ts`.

**1. ¿Cómo falla?** Tres niveles, los tres con política escrita: (a) el poll entero
(`:330-366`) — `42P01` → aviso único + auto-pausa (`:376-395`), cualquier otro →
`logger.error` y se reintenta al ciclo siguiente; (b) un handler (`:433-468`) — no se
marca dispatched, `recordFailure` incrementa; (c) el notificador de dead-letter
(`:350-359`) y los compensadores (`:571-584`) — aislados con `Promise.allSettled`, no
pueden frenar el poll ni revertir la marca.

**2. ¿Cómo se informa?** Al operador, por tres canales reales: el banner del panel
(`GET /api/system/outbox/...`), un mail a los MANAGEMENT del tenant con cooldown de 15
min y agrupado por ciclo (`dead-letter-notify.ts:39,65-126`), y `describeDeadLetter()`
que traduce el `last_error` a una frase. **Es el subsistema mejor informado del repo.**
Lo que no llega a ninguna parte: Sentry (los workers no pasan por express).

**3. ¿Cómo se registra?** Log estructurado con `evento:`/`causa:`/`reintentable:` y
severidad graduada por tipo de desenlace (`outbox.handlers.ts:566-653`: `info` para lo
benigno, `warn` para estado de negocio, `error` para anomalía de integridad) — ejemplar.
Y en la base: `retry_count`, `first_failed_at`, `last_failed_at`, `failed_at`,
`last_error` (categorizado, **nunca el mensaje crudo**, `:592-597`, A7.1). Dos defectos:
`last_error` guarda solo la categoría (`PG_23505`/`TypeError`), así que el mensaje real
del fallo **no queda en ningún lado durable** — vive solo en el `logger.error` de
`:435-438`, y esa línea no tiene `businessId` (F8-08).

**4. ¿Se puede reproducir?** Sí, ampliamente: `outbox.worker.test.ts` (717 líneas),
`outbox.handlers.test.ts` (1037), `inventory.handlers.test.ts` (465),
`dead-letter-notify.test.ts`, `adaptive-poller.test.ts`. El worker acepta
`processedEventRepository` opcional justo para poder testear sin BD.

**5. ¿Se puede reintentar con seguridad?** **Sí: contrato de reintento completo y
declarado.** Con tope, con backoff real y con dos capas de idempotencia:
- **Backoff** en `getPending()` (`sql.domain-event.repository.ts:128-146`, schema v48):
  escalones `retry_count ≤2 → 5s`, `≤9 → 30s`, `≤29 → 120s`, `≥30 → 300s`.
  `retry_count = 0` y `last_failed_at IS NULL` siempre elegibles (la segunda rama
  existe para que una fila vieja no desaparezca por la lógica de 3 valores de SQL —
  razonamiento correcto y documentado en el propio query).
- **Tope**: `maxRetries = 60` → `recordFailure` setea `failed_at` en la **misma UPDATE**
  que incrementa (`:175-189`, A8.2 — no hay SELECT-decidir-escribir) y el evento sale de
  `getPending` (`WHERE ... failed_at IS NULL`). **No hay reintento infinito.** Peor caso
  de pared ~3.3h, declarado en `:206-218`.
- **Poison message**: dos mecanismos. `ORDER BY retry_count ASC` lo manda al fondo de la
  cola para que no frene a los nuevos (patrón `ORDER BY failure_count` de Odoo, citado);
  y `classifyError()` (`:622-635`) manda a dead-letter **en el primer intento** lo que
  nunca se va a arreglar solo (`UnsupportedEventVersionError`, `ChargeNeverCreatedError`,
  `TypeError`/`RangeError`/`SyntaxError`, y todo SQLSTATE clasificado `permanent`), con
  `maxRetries = 1` reusando la MISMA UPDATE, no un segundo camino de escritura.
- **Idempotencia**: la de adentro son claves naturales por handler
  (`${event.id}:CHARGE:DEPOSIT`/`:BALANCE`, `${event.id}:ADJUSTMENT`, identidad por
  `order_id` en `createOrderChargeIfConfirmed`, índices únicos en `stock_movements`); la
  de afuera es el casillero `(domain_event_id, handler_name)` de `processed_events`,
  reclamado con `INSERT ... ON CONFLICT DO NOTHING RETURNING` (decisión y escritura en
  una sola operación) y **liberado si el handler falla**.
- El caso "dos ciclos de poll solapados" está cubierto por el flag `polling`
  (`:331-333`) y por el claim.

**6. ¿Puede dejar el sistema en un estado intermedio?** **Sí, uno — y es el único agujero
real del subsistema** → F8-07. El casillero se reclama **antes** de correr y se libera
**solo en el `catch`**. Si el proceso muere entre el claim y el fin del handler
(SIGKILL de Render tras el timeout de 10s de `app.ts:585-588`, OOM, crash), el casillero
queda tomado sin que el efecto haya ocurrido; al reiniciar, `runHandler` ve `won === false`,
loguea a nivel **`debug`** (`:493-497`) y saltea; si los demás handlers pasan, el evento
se marca dispatched. Resultado: **un CHARGE que nunca se crea, sin dead-letter, sin
warn, sin rastro en producción** (`LOG_LEVEL` default en producción es `info`,
`logger.ts:25`). El repo ya nombró la variante contigua —el fallo del `release`, con su
costo explicitado en `:505-515`— y tiene el prerrequisito del sweep de recuperación hecho
(`OUTBOX-DL-COMPENSATOR-01`), con el sweep mismo **en HOLD**.

**7. ¿Hay suficiente información para diagnosticarla?** Para el camino normal, sí. Para
F8-07, **no** (nivel `debug`, y no dice que el efecto no ocurrió — dice que el handler
"ya procesó"). Para atribuir cualquier línea del worker a un tenant, **no**: F8-08.

---

## 3. Hallazgos

### F8-01 — `TransactionManager.run()`: el COMMIT ambiguo y la conexión devuelta al pool en estado abortado

```text
Hallazgo: además del enmascaramiento del error que ya describió C6-06, el
ROLLBACK sin protección de `src/db/pg.transaction-manager.ts:37-41` produce
dos estados intermedios que ningún caller puede distinguir: (i) si el
`COMMIT` de `:36` falla por corte de conexión, la transacción pudo haberse
confirmado del lado del servidor y el caller recibe una excepción — "no
pasó nada" y "pasó todo" son el mismo evento observable; (ii) `:42` hace
`conn.release()` sin pasar el error, así que una conexión cuyo `ROLLBACK`
no llegó a ejecutarse vuelve al pool dentro de una transacción abortada y
contamina al próximo request que la tome.
Evidencia: src/db/pg.transaction-manager.ts:22-43 (archivo completo; `:36`
COMMIT, `:39` ROLLBACK sin try propio, `:40` throw, `:42` release sin
argumento) · src/db/transaction-manager.ts (interfaz de 15 líneas, sin
cláusula de excepción) · 69 call sites en 25 archivos
(`grep -rn "transactionManager\.run" src | grep -v test | wc -l`) · callers
protegidos por clave natural: invoice.service.ts:530
(`invoice:${financialTransactionId}`), outbox.handlers.ts:213,227,536
(`${event.id}:CHARGE:*`), createOrderChargeIfConfirmed (identidad por
order_id) · callers SIN clave natural: customer-account.service.ts:203
(`idempotencyKey: params.idempotencyKey ?? null`, ver F8-15),
sql.cash-register-shift.repository.ts:86-110 (C6-10 grupo B).
Impacto: para los callers con clave natural el COMMIT ambiguo se
auto-cura en el reintento (el segundo intento relee la fila y devuelve la
existente) — es la razón por la que esto no explotó todavía. Para los que
no la tienen, el reintento duplica un hecho financiero. La contaminación
del pool, si ocurre, produce un `25P02` en un request ajeno al que causó
el problema: el síntoma aparece en un endpoint que no tiene nada que ver
con la causa.
Causa probable: `run()` se extrajo para resolver acoplamiento (no depender
de pg.client.ts) y cumplió ESE objetivo; el ciclo de vida de la conexión
ante error nunca se escribió porque en el momento de extraerla había un
solo implementador. `conn.release(err)` es un detalle de la API de
node-postgres que solo importa en el camino de excepción.
Nivel de certeza: Alta para el código (es lectura directa de 43 líneas) y
para el razonamiento del COMMIT ambiguo. HIPÓTESIS_A_CONFIRMAR para el
`25P02` en un request posterior: depende de que `pg` no marque la conexión
como no reusable por sí solo en ese escenario puntual.
Severidad: Alta. No hay bug activo confirmado; el mecanismo afectado es el
que sostiene toda la integridad transaccional del backend.
Recomendación: (1) envolver el ROLLBACK en su propio try/catch que loguee
y re-lance el error ORIGINAL (ya pedido por C6-06, sigue vigente);
(2) pasar el error a `release(err)` en el camino de excepción para que el
pool descarte la conexión en vez de reusarla; (3) declarar en la interfaz
qué significa una excepción de `run()` — en particular que un error DESPUÉS
del COMMIT no garantiza que no se haya escrito, y que por eso todo caller
que escriba dinero necesita clave natural. Las tres son independientes y
ninguna requiere decisión de negocio.
¿Requiere modificar código?: Sí, (1) y (2) son ~6 líneas en un archivo;
(3) es documentación de contrato.
Prueba necesaria: test de integración con Postgres real que (a) haga
fallar `work` y mate la conexión con `pg_terminate_backend` desde una
segunda sesión, aserando que el error que sale de `run()` es el de `work`;
(b) tras ese fallo, tome N conexiones del mismo pool y asere que ninguna
devuelve `25P02`.
```

### F8-02 — La factura queda `PENDING` con AFIP ya contactado si falla la escritura del fallo, y el reintento la considera segura

```text
Hallazgo: las cuatro ramas de fallo de `issue()`/`reconcileAfterFailure()`
persisten el estado con una escritura que ocurre DESPUÉS de haber hablado
con AFIP. Si esa escritura falla (BD caída, COMMIT ambiguo de F8-01), el
error que se propaga es el de la base —no `AfipRequestUncertainError`— y la
fila de `invoices` queda en `PENDING`. `retryExisting()` clasifica `PENDING`
en "se sabe con certeza que no quedó nada emitido, reintento seguro" y
vuelve a pedir un CAE por el mismo cargo, con el mismo `afipRequest`.
Evidencia: src/facturacion/invoice.service.ts:1471 (`markFailed`, sin
transacción a propósito), :1486-1501 (`markFailedWithClient` dentro de
`transactionManager.run`, rama REJECTED), :1505-1518 (ídem, rama sin
CbteDesde/CAE), :1559-1576 (ídem, `reconcileAfterFailure`) ·
:1371-1373 (`retryExisting`: corta en `ISSUED` y en `FAILED_UNCERTAIN &&
afipContacted && !uncertainClearedAt`; `PENDING` NO está en ninguno de los
dos guards) · :1361-1369 (el docblock que afirma la premisa hoy falsa:
"El resto (PENDING, REJECTED, o FAILED_UNCERTAIN con afipContacted=false):
se sabe con certeza que no quedó nada emitido") · :606-671 (la fila se crea
y commitea ANTES de la llamada externa de :673).
Impacto: en la rama ambigua (`:1505`, AFIP respondió sin CbteDesde/CAE) el
reintento puede producir un SEGUNDO comprobante fiscal real por el mismo
cargo. El mecanismo de reconciliación no lo detecta: en el reintento,
`lastVoucherBefore` se lee fresco (`:1447`), así que un comprobante
emitido en el intento anterior ya está incluido en ese número de partida y
la comparación `lastVoucherAfter > lastVoucherBefore` no puede verlo. Es el
único camino identificado en esta fase que puede duplicar un documento
fiscal ante AFIP.
Causa probable: el diseño A8.6 razonó (correctamente) sobre la
incertidumbre de la llamada externa y asumió que la escritura del
resultado es confiable. Los bloques 2 y 4 del 15/09/2026
transaccionalizaron esas escrituras —lo que mejora la atomicidad con
`credit_note_request`— y en el mismo movimiento le agregaron un punto de
fallo más a la ventana.
Nivel de certeza: Alta para la cadena de código (las 4 ramas y los 2
guards de `retryExisting` están leídos línea por línea). El disparo exige
un fallo de BD en una ventana de milisegundos — baja probabilidad, efecto
fiscal.
Severidad: Alta.
Recomendación: dos opciones, ninguna elegida acá. (A) marcar la intención
antes de llamar a AFIP: un `afip_contacted = true` (o un estado
`IN_FLIGHT`) escrito ANTES de `createNextVoucher()`, de modo que cualquier
interrupción posterior deje la fila del lado seguro — fail-closed por
construcción, al costo de exigir resolución manual de todo lo que quede
colgado. (B) que `retryExisting()` no trate `PENDING` como seguro y pase
SIEMPRE por la reconciliación de `reconcileAfterFailure()` antes de pedir
un CAE nuevo. (A) cambia el invariante; (B) es más chico y deja la
detección en el mismo lugar donde ya vive. La elección toca el circuito
fiscal → decisión del dueño del dominio.
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: test de `requestInvoice()` con un `AfipBillingPort` fake
que devuelva una respuesta sin `CbteDesde` y un `InvoiceRepository` cuyo
`markFailedWithClient` lance; aserar el estado de la fila (hoy: `PENDING`)
y después, en un segundo `requestInvoice()` sobre el mismo `ftId`, aserar
si `createNextVoucher` se invoca por segunda vez (hoy: sí).
```

### F8-03 — La respuesta cruda de AFIP viaja al navegador, y la falla que exige intervención humana no llega a ningún canal de alerta

```text
Hallazgo: dos defectos del mismo desenlace. (i) El mensaje de
`AfipRequestUncertainError` de la rama ambigua incluye
`JSON.stringify(result.raw)` —la respuesta completa de WSFEv1— y
`error.middleware.ts:107-110` devuelve `err.message` tal cual en el body
409; el frontend lo muestra en un toast. (ii) Los seis desenlaces de fallo
de AFIP son `DomainError`, y el `shouldHandleError` de Sentry excluye la
clase `DomainError` entera: la operación más crítica del repo no tiene
ningún canal de alerta — ni Sentry, ni mail, ni banner (a diferencia del
outbox, que tiene los tres).
Evidencia: src/facturacion/invoice.service.ts:1506 (`respuesta de AFIP sin
CbteDesde/CAE ...: ${JSON.stringify(result.raw)}`) ·
src/domain/errors.ts:531-538 (el mensaje interpola `cause` sin filtrar) ·
src/api/middleware/error.middleware.ts:107-110 (body = `err.message`) ·
:337 (`AFIP_REQUEST_UNCERTAIN` → 409) · src/app.ts:540-545 (el filtro de
Sentry, por clase) · src/instrument.ts:18-24 (sin `release`) ·
appfrontend/src/components/FacturarButton.tsx:135-142 (toast con el
mensaje) · contraste: el estado SÍ es visible en una lista
(appfrontend/src/app/dashboard/facturacion/page.tsx:123, rótulo
"Incierta") — visible, no alertado.
Impacto: (i) detalle de protocolo de un tercero en la UI, en un canal que
no está pensado para eso; el `raw` de AFIP puede contener datos del
receptor del comprobante (`DocNro`) si el servicio los devuelve. Es
exposición a un usuario autenticado de staff, no pública — por eso no es
Alta. (ii) es el más grave de los dos: un comprobante en estado
`FAILED_UNCERTAIN` requiere que una persona verifique contra AFIP antes de
reintentar, y nadie se entera hasta que alguien abra la pantalla de
facturación. El filtro de Sentry es correcto en su intención (no llenar el
tracker con 404/400) y está implementado por la dimensión equivocada: la
clase del error en vez de la severidad operativa.
Causa probable: (i) el mensaje se armó para dejar constancia forense en la
columna `error_message`, que es el destino correcto; que el mismo string
sea también el body HTTP es un efecto del contrato uniforme de
`DomainError`. (ii) el filtro se escribió cuando `DomainError` era
sinónimo de "error esperado del cliente"; después el catálogo creció a 122
clases (C6-09) e incorporó desenlaces que sí son incidentes.
Nivel de certeza: Alta. Las tres cadenas están leídas completas; la
exclusión de Sentry es lectura directa del predicado.
Severidad: Media-Alta.
Recomendación: (i) separar el string forense (columna) del mensaje al
usuario (un texto estable + el `invoiceId`), con el `raw` accesible solo
por la fila. (ii) invertir el criterio del filtro de Sentry: pasar de
"excluir por clase" a "incluir los códigos que exigen intervención
humana", con una lista explícita (`AFIP_REQUEST_UNCERTAIN`,
`AFIP_RECONCILIATION_PENDING`, los `CREDIT_NOTE_*` de pendiente) — mismo
patrón de allowlist con motivo que el repo ya usa siete veces.
¿Requiere modificar código?: Sí para las dos. (i) toca un mensaje
observable → confirmar con el dueño. (ii) no cambia comportamiento de
producto.
Prueba necesaria: (i) test de ruta que dispare la rama ambigua y asere
que el body NO contiene el raw. (ii) test del predicado `shouldHandleError`
con una instancia de cada código de la lista.
```

### F8-04 — `reconcileAfterFailure()` descarta la causa de por qué no pudo reconciliar

```text
Hallazgo: el `catch {}` de `invoice.service.ts:1541-1543` traga el error
del segundo `getLastVoucher()` con el comentario "no se pudo ni reconciliar
-- queda incierto, un humano lo revisa a mano". El humano que lo revisa no
tiene cómo saber si la reconciliación se intentó y falló (AFIP caído,
credencial vencida) o si se intentó, respondió, y el número no avanzó
(AFIP no procesó nada) — dos situaciones con acciones opuestas.
Evidencia: src/facturacion/invoice.service.ts:1531-1543 (el catch, sin
`logger` y sin acumular la causa) · :1559 (el mensaje final solo lleva
`originalErrorMessage`, el del PRIMER error, y afirma "no avanzó de forma
confirmable" tanto si no se pudo consultar como si se consultó y no
avanzó) · :1548 (`.catch(() => null)` sobre `getVoucherInfo`, mismo patrón
un paso más adelante: si el CAE existía pero no se pudo leer, la causa
también se descarta).
Impacto: alarga el tiempo de resolución de un caso que ya es manual y
fiscal. No cambia el estado persistido (`FAILED_UNCERTAIN` con
`afipContacted: true` es correcto en los dos casos) — es un defecto de
diagnóstico, no de integridad.
Causa probable: el catch se escribió para que un fallo de la
reconciliación no tape el error original —criterio correcto— y se resolvió
descartándolo en vez de sumándolo.
Nivel de certeza: Alta.
Severidad: Media.
Recomendación: sumar la causa al mensaje persistido (dos oraciones: el
error original y el de la reconciliación) o loguearla con un `evento:`
propio. No hay decisión de negocio involucrada.
¿Requiere modificar código?: Sí, ~4 líneas en un archivo.
Prueba necesaria: test con un fake cuyo segundo `getLastVoucher()` lance,
aserando que el `errorMessage` persistido nombra las dos causas.
```

### F8-05 — La saga de tenant deja cuatro estados intermedios, tres invisibles, y `repair-tenant-db` no es su compensación

```text
Hallazgo: los cinco pasos del aprovisionamiento producen cuatro estados
intermedios distintos según dónde fallen. Tres de los cuatro son
indetectables desde el producto: dejan un branch de Neon vivo —con compute
endpoint facturable y, en dos de los casos, con el schema completo
aplicado— cuya connection string existió solo en una variable local y no
se guarda en ninguna parte. El cuarto (`updateSchemaVersion` falla) deja el
negocio ACTIVE con `schema_version` stale y se señala solo con un
`logger.warn` fail-soft en el primer cache-miss del pool. El guard de
reintento mira `db_url_encrypted`, que se escribe en el paso 4 de 5: un
fallo en los pasos 1-3 lo deja abierto y el reintento crea un branch nuevo.
Evidencia: src/platform/business.routes.ts:173-184 (los 5 pasos + el
fail-open declarado) · src/platform/platform.routes.ts:396-411 (el guard
`if (business.dbUrlEncrypted)` y la misma secuencia) ·
src/platform/neon-provisioning.ts:104-141 (dos llamadas HTTP; el branch se
crea en la primera, el connection string llega en la segunda) ·
src/platform/platform.repository.ts:578-602 (`activateBusiness` y
`updateSchemaVersion` son DOS UPDATE sueltos, sin `runInTransaction`, que
el mismo archivo sí usa en `:322-323` y que `platform.routes.ts:258-270`
sí usa para el cambio de estado) · src/platform/tenant.middleware.ts:84-96
(el chequeo warn-only) · src/platform/admin.routes.ts:67-100 (el "repair"
apunta a `process.env.DATABASE_URL`, la base del propio proceso — no al
branch huérfano) · :6-9 (el archivo se declara herramienta de uso único).
Impacto: costo de infraestructura silencioso (branches y computes que
nadie puede enumerar desde el sistema) y, más grave, una base de datos con
el schema de un tenant aplicado, sin dueño registrado y sin rastro — si
ese branch se ramificó de la plantilla queda vacío de datos, pero sigue
siendo una superficie viva con credenciales que nadie rotó ni revocó. La
reparación real exige entrar a la consola de Neon a mano y cruzar nombres
`tenant-<slug>` contra la tabla `businesses`.
Causa probable: es exactamente lo que F7-05 diagnosticó (la secuencia se
copió a cada handler nuevo y nunca existió como unidad). Sin un lugar que
describa la saga, no hay lugar donde escribir su compensación.
Nivel de certeza: Alta para los cuatro estados y para el guard (lectura
directa de los cuatro handlers y del repositorio). HIPÓTESIS_A_CONFIRMAR
para el comportamiento de Neon ante un segundo branch con el mismo nombre
`tenant-<slug>`: si la API lo rechaza por nombre duplicado, el reintento
falla en vez de duplicar. `No confirmado.` `Información faltante: si la
API de Neon exige unicidad de nombre de branch dentro de un proyecto.`
`Cómo verificarlo: POST /projects/{id}/branches dos veces con el mismo
`branch.name` contra el proyecto de staging, o la doc del endpoint.`
Severidad: Alta.
Recomendación: prerrequisito el `TenantProvisioner` de F7-04(c) y el
servicio único de F7-05. Encima de eso, dos piezas propias de esta fase:
(1) persistir el identificador del branch y la connection string cifrada
ANTES de aplicar el schema —invirtiendo el orden actual— así el estado
intermedio queda registrado y el reintento puede reusar el branch en vez de
crear otro; (2) `activateBusiness` + `updateSchemaVersion` en una sola
`runInTransaction` (el repositorio ya sabe hacerlo). Compensar de verdad
(borrar el branch huérfano) es una acción destructiva sobre
infraestructura y entra en `irreversible-action-gate`: no se propone acá.
¿Requiere modificar código?: Sí. No implementado. El orden importa: esto
NO se toca antes de F7-04(c) ni sin backup durable (corre DDL contra bases
de producción).
Prueba necesaria: la característica de regresión que F7-05 ya pidió (un
test de integración por cada uno de los 4 caminos, aserando
`businesses.status`, `db_url_encrypted`, `schema_version` y pool evictado
o no), más un test nuevo por cada punto de fallo inyectado que asere qué
queda registrado.
```

### F8-06 — El connection string del tenant, con contraseña, puede terminar en el mensaje de un error que se loguea completo

```text
Hallazgo: `neon-provisioning.ts:136` construye el mensaje de error con
`raw.slice(0, 300)`, donde `raw` es el body de
`GET /projects/{id}/connection_uri` — o sea, exactamente la respuesta que
contiene la connection string con usuario y contraseña de la base del
tenant. Ese error viaja como `NeonProvisioningError` al caller, y el caller
loguea el error COMPLETO: `logger.error({ err: provisionErr, businessId })`
en `business.routes.ts:183`, o `next(err)` → la rama genérica de
`error.middleware.ts:115` (`logger.error({ err })`). `pino` serializa la
clave `err` con su serializador estándar, que incluye `message` y `stack`.
No hay `redact` configurado en `logger.ts`.
Evidencia: src/platform/neon-provisioning.ts:126-138 (la rama: se dispara
cuando `conn.uri ?? conn.connection_uri` es undefined, con `raw` completo
en el mensaje) · :66-77 (el docblock declara la incertidumbre que motivó
ese `raw`: "Nombre de la respuesta no 100% confirmado contra la doc ... por
eso neonApiFetch() devuelve el body crudo además de parseado, para poder
loguear el shape real la primera vez que esto corra contra producción") ·
:92 (segundo `raw.slice(0,300)`, sobre un body de error de la API) ·
src/platform/business.routes.ts:183 · src/api/middleware/error.middleware.ts:115
· src/logger.ts:24-32 (sin `redact`) · contraste: `tenant-db.setup.ts:126-135`
resuelve el mismo problema bien, con un mensaje explícito y la nota
"Nunca material de clave ni ciphertext acá".
Impacto: una credencial de base de datos de producción queda en el log
del servicio y en cualquier agregador que lo reciba, con un TTL
indefinido, sin que nada la rote ni la revoque. Y el disparo no es
exótico: la rama existe precisamente porque el shape de la respuesta de
Neon no está confirmado, que es el escenario para el que el `raw` se puso
ahí.
Causa probable: el `raw` se agregó como ayuda de diagnóstico para un
shape desconocido —decisión razonable— sin notar que en ESE endpoint el
body ES el secreto. El caller, por su parte, loguea `err` entero porque es
el patrón por defecto de todo el repo.
Nivel de certeza: Alta para el código y para la serialización de `pino`
(la clave `err` usa el serializador estándar, verificado en la corrida de
F8-10, donde el objeto logueado se expandió completo).
HIPÓTESIS_A_CONFIRMAR para el contenido exacto del body:
`No confirmado.` `Información faltante: la forma literal de la respuesta
de GET /projects/{id}/connection_uri de la API v2 de Neon en el caso en
que ni `uri` ni `connection_uri` estén presentes.` `Cómo verificarlo:
llamar ese endpoint contra el proyecto de staging con NEON_API_KEY y
mirar el body — la connection string con password es el objeto ENTERO que
ese endpoint devuelve, así que cualquier variante de shape la sigue
conteniendo.`
Severidad: Alta (secreto en logs).
Recomendación: no loguear ni interpolar bodies de ese endpoint. Si hace
falta diagnosticar el shape, loguear `Object.keys(conn)` — resuelve
exactamente la duda que motivó el `raw` sin llevarse el valor. Y, como
defensa de clase, evaluar `redact` en `logger.ts` para `err.message`
de esta familia de errores (opción de radio ancho, decidir aparte).
¿Requiere modificar código?: Sí, dos líneas en `neon-provisioning.ts`. No
requiere decisión de negocio.
Prueba necesaria: test unitario de `provisionTenantDatabase()` con un
`fetch` fake que devuelva `{"connection_uris":[{"connection_uri":"postgresql://u:p@h/db"}]}`
(shape no soportado), aserando que el mensaje del error lanzado NO contiene
`postgresql://` ni la contraseña.
```

### F8-07 — Un crash entre el claim y el fin del handler deja el casillero tomado: el efecto financiero se saltea en silencio

```text
Hallazgo: `runHandler()` reclama el casillero de `processed_events` ANTES
de correr el handler y lo libera únicamente en su `catch`. Un crash del
proceso en esa ventana (SIGKILL de Render tras el timeout de cierre
forzado, OOM, excepción no capturada) no pasa por el catch: el casillero
queda tomado sin que el efecto haya ocurrido. Al reiniciar, el mismo
evento vuelve por `getPending()`, `claim()` devuelve `false`, el handler se
SALTEA con un `logger.debug` y —si los demás handlers del evento pasan— el
evento se marca despachado. El resultado es un CHARGE que nunca se crea,
sin dead-letter, sin `warn`, y sin línea visible en producción
(`LOG_LEVEL` default = `info`).
Evidencia: src/workers/outbox.worker.ts:482-518 (`runHandler`: `:491`
claim, `:501` handler, `:504` release solo en el catch) · :492-498 (el
skip, a nivel `debug`) · :430-431 (`Promise.all` de los handlers y luego
`markDispatched`) · src/repositories/processed-event.repository.ts:57-73
(el claim es un INSERT autocommiteado, fuera de la transacción del handler)
· src/logger.ts:25 (`level: 'info'` en producción) · src/app.ts:585-588
(`setTimeout(..., 10_000)` → `process.exit(1)`: el cierre forzado puede
matar un handler en vuelo en un deploy normal) · el propio repo ya nombró
la variante contigua: :505-515 ("el costo de este caso ... es que ese
handler no se reintenta para ESE evento -- visible en el log, no en
silencio") y :166-174 (el sweep de recuperación que esto necesitaría,
declarado "todavía en HOLD").
Impacto: pérdida silenciosa de un efecto financiero — el peor modo de
falla posible para un outbox, y el único que el resto del diseño (backoff,
tope, dead-letter, mail, banner) no cubre. Las claves naturales de adentro
(`idempotencyKey` + ON CONFLICT) protegen contra DUPLICAR, no contra
SALTEAR: son la defensa del caso opuesto.
Causa probable: reclamar antes de correr es la decisión CORRECTA para el
problema que el claim resuelve (dos polls solapados no pueden correr el
mismo handler a la vez) y su docblock lo argumenta bien. El costo —que un
claim sobrevive a una muerte del proceso mientras el trabajo no— es
inherente a esa elección y solo se cierra con un sweep, que está diseñado
y no implementado.
Nivel de certeza: Alta para el mecanismo (las tres piezas están leídas y
el claim es demostrablemente autocommiteado, en su propia sentencia).
HIPÓTESIS_A_CONFIRMAR para la frecuencia real en producción.
Severidad: Alta.
Recomendación: subir el skip de `debug` a `info`/`warn` cuando el evento
tiene `retry_count > 0` (un skip en el primer intento es imposible; un
skip en un reintento es o el caso benigno de otro handler que falló, o
exactamente esto) es el mitigante más chico y hace el caso visible. La
solución real es el sweep ya diseñado: detectar casilleros reclamados sin
efecto correspondiente. La tercera opción —reclamar DENTRO de la misma
transacción que el handler, donde el handler tenga una— cierra el agujero
por construcción para los handlers transaccionales y no aplica al de mail,
que es justamente el que motivó la tabla.
¿Requiere modificar código?: Sí. El sweep es un bloque propio, hoy en
HOLD por matriz de impacto incompleta.
Prueba necesaria: test de integración con Postgres real: claim manual de
`(event_id, 'financial:reservation.confirmed')`, correr un ciclo de poll y
aserar que (a) no se creó el CHARGE, (b) el evento quedó `dispatched_at`
no nulo. Eso fija el comportamiento actual como característica antes de
cambiarlo.
```

### F8-08 — Catorce líneas de log del OutboxWorker sin `businessId`, sobre un `event.id` que no es único entre tenants

```text
Hallazgo: hay un OutboxWorker POR TENANT, todos en el mismo proceso y
todos escribiendo por el mismo logger de módulo. La clase nunca recibe el
`businessId` (no está entre sus cinco parámetros de constructor), así que
sus 14 llamadas a `logger.*` no lo llevan. El identificador que sí llevan
—`eventId`— es la PK `BIGSERIAL` de la tabla del tenant, y el propio
contrato del evento declara que no es global: "dos negocios tienen su
propio id = 1". Consecuencia directa: la línea "[OutboxWorker] Evento pasó
a dead-letter {eventId: 1, eventType: 'order.confirmed'}" no se puede
atribuir a un negocio ni distinguir de la misma línea de otro.
Evidencia: src/workers/outbox.registry.ts:86 (`workers.set(businessId,
worker)` — un worker por tenant) · :140 (`new OutboxWorker(domainEventRepo,
5_000, 60, processedEventRepo, onDeadLetterBatch)` — sin businessId) ·
src/workers/outbox.worker.ts:305,323,339,355,383,394,407,435,460,493,511,
543,556,578 (las 14 líneas sin tenant) · :460-463 (la más costosa: la
transición a dead-letter) · src/repositories/domain-event.repository.ts:6-11
(`id` "solo es único dentro de esta tenant DB") · medición: de 98
`logger.*` de producción, 36 llevan `businessId`/`tenant:` (30 directo + 6
por spread `...base` en outbox.handlers.ts) — 62 no · contraste: los
handlers SÍ lo llevan (`outbox.handlers.ts:584`, `tenant: event.businessId`)
y `registrarDesenlace` incluso arma un `correlationId` a mano
(`:588`) · `ensureTenantWorker` lo loguea una vez al arrancar
(`outbox.registry.ts:151`) y nunca más.
Impacto: el subsistema con la mejor política de logging del repo produce,
para su evento más importante, una línea no accionable. Con el diagnóstico
de F8-07 encima, "un efecto se perdió" y "en qué negocio" son dos
preguntas y el log solo puede responder la primera. Y sumado a F8-11 (sin
correlación de request), no hay forma de reconstruir qué pasó en un tenant
a partir de los logs del proceso.
Causa probable: el worker se escribió como pieza genérica de
infraestructura, agnóstica del tenant, y el `businessId` vive en el
registry que lo instancia. Nada lo obligó a bajar un nivel porque el
`DomainEventRepository` inyectado ya viene atado a la base correcta.
Nivel de certeza: Alta. Conteos medidos con un script reproducible, no
estimados.
Severidad: Media-Alta.
Recomendación: pasar `businessId` al constructor del worker y emitirlo en
las 14 líneas — o, más limpio y de radio menor, darle al worker un logger
hijo (`logger.child({ businessId })`) creado en `ensureTenantWorker`, que
ya lo tiene. Lo segundo no toca ninguna de las 14 llamadas.
¿Requiere modificar código?: Sí, ~3 líneas con la variante del logger
hijo. Sin decisión de negocio.
Prueba necesaria: no hace falta un test nuevo; alcanza con un test
existente del worker capturando el stream de pino y aserando que toda
línea emitida trae `businessId`.
```

### F8-09 — El worker que se auto-pausa por tabla faltante no se vuelve a arrancar nunca

```text
Hallazgo: ante `42P01` (la tabla `domain_events` no existe en la tenant DB)
`handlePollError()` emite un aviso único y llama `void this.stop()` — una
degradación honesta y declarada. Pero `stop()` solo apaga el intervalo; la
entrada sigue en el `Map` del registry, y `ensureTenantWorker()` arranca con
`if (workers.has(businessId)) return`. O sea: el worker queda apagado
para siempre, los eventos siguen acumulándose sin despachar, y ningún
request posterior lo reactiva. El docblock afirma que "Se reactiva llamando
a worker.start() de nuevo una vez que la tabla exista" — nadie lo llama.
Evidencia: src/workers/outbox.worker.ts:376-395 (`void this.stop()`, y el
`missingTableWarned` que garantiza UNA sola línea) · :176-180 (el docblock
que promete la reactivación) · src/workers/outbox.registry.ts:85 (`if
(workers.has(businessId)) return`) · :186-198 (`stopTenantWorker()` SÍ
borra del Map — pero solo lo llaman `evictTenantPool` y el handler de
error del pool, `tenant.middleware.ts:109-114`, ninguno de los cuales se
dispara por una tabla faltante) · src/platform/tenant.middleware.ts:84-96
(el otro síntoma del mismo tenant desactualizado, también warn-only).
Impacto: un tenant cuya BD nunca pasó por `applyTenantSchema` (situación
real y documentada: "Hoy la mayoría de los negocios activos tiene
schema_version = NULL") opera con el outbox muerto — reservas y órdenes se
confirman y NINGÚN cargo financiero se crea, con una sola línea de warn en
todo el ciclo de vida del proceso. La recuperación existe pero es
incidental: un desalojo por LRU o un error de pool borran la entrada y el
próximo request lo recrea.
Causa probable: la auto-pausa se diseñó contra el ruido en logs (objetivo
cumplido) y el reinicio se dejó como acción manual sobre la instancia del
worker, sin notar que el registry no expone ninguna forma de llamarla.
Nivel de certeza: Alta. Las tres piezas (auto-pausa, guard del registry,
únicos callers de `stopTenantWorker`) están leídas.
Severidad: Media. Depende de un tenant mal aprovisionado — que es
justamente lo que F8-05 hace posible sin dejar rastro.
Recomendación: que la auto-pausa por tabla faltante borre la entrada del
registry (llamar `stopTenantWorker`, no `this.stop()`), así el próximo
request lo reintenta; con el `missingTableWarned` puesto en la propia
instancia, eso reintroduce ruido — la alternativa es un backoff largo
(reintentar el poll cada N minutos en vez de apagarse). Elegir entre las
dos es técnico, no de negocio.
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: test que dispare `42P01`, verifique el warn y la pausa,
y después asere que un `ensureTenantWorker()` posterior vuelve a arrancar
un worker (hoy: no).
```

### F8-10 — Cada request loguea el header `authorization` y el `cookie` de sesión (reproducido)

```text
Hallazgo: `app.ts:146` monta `pinoHttp({ logger })` con la configuración
por defecto. El serializador estándar de request de pino incluye
`headers`, así que TODA request del proceso —autenticada o no— emite una
línea de log con el Bearer JWT completo y la cookie `auth_token`. La misma
línea incluye la URL con query string, que el propio repo declara portadora
de PII en otro archivo. `logger.ts` no configura `redact`.
Evidencia: REPRODUCIDO. Corrida real con pino-http 11.0.0 (la versión
instalada) y la misma invocación del repo, `pinoHttp({ logger })`,
mandando un GET con los headers de una sesión real:

  {"level":30,"time":...,"req":{"id":1,"method":"GET",
   "url":"/api/customers?email=a@b.com",
   "headers":{"authorization":"Bearer SECRETJWT.abc.def",
   "cookie":"auth_token=SECRETCOOKIE","host":"...","connection":"keep-alive"},
   "remoteAddress":"127.0.0.1","remotePort":35276},
   "res":{"statusCode":200,...},"responseTime":1,"msg":"request completed"}

Anclas: src/app.ts:146 · src/logger.ts:24-32 (sin `redact`) ·
node_modules/pino-http/logger.js:27-36 (los serializadores por defecto:
`serializers.req` de pino-std-serializers) · el token que queda en el log
es el que emite `signToken(..., EXPIRES_IN_SECONDS)` con
`EXPIRES_IN_SECONDS = 86_400` (business.routes.ts:187-193) y el que
`setAuthCookie` deja como cookie httpOnly · contraste dentro del mismo
repo: `error.middleware.ts:79-84` documenta una política explícita de NO
loguear datos sensibles ("NUNCA `err.message`") y hasta excluye el query
string a propósito ("A7.2: `GET /api/customers` todavía recibe
`email`/`name` por query") — la política existe, se aplica en el handler
de errores, y el middleware de acceso montado 400 líneas antes la anula.
Impacto: una credencial de sesión válida por 24h, replayable, queda
escrita en el log de cada request, para staff y para clientes del portal.
El httpOnly de la cookie deja de proteger nada en cuanto el log se
persiste o se manda a un agregador. Es el único hallazgo de las ocho fases
que expone una credencial viva y no un dato de negocio.
Causa probable: `pinoHttp({ logger })` es la invocación canónica de la
documentación de la librería y su comportamiento por defecto (headers
incluidos) no es evidente desde el call site. La política de A7.1/A7.2 se
escribió razonando sobre los logs que el código del repo emite a mano; el
middleware que loguea automáticamente quedó fuera de ese razonamiento.
Nivel de certeza: Alta para el comportamiento (reproducido con la versión
instalada y la misma configuración). Alta para el efecto en producción
—el `NODE_ENV=production` solo cambia el transporte, no los
serializadores—. HIPÓTESIS_A_CONFIRMAR para la retención real:
`No confirmado.` `Información faltante: cuánto tiempo retiene Render los
logs de este servicio y si hay algún agregador externo enganchado.`
`Cómo verificarlo: Render Dashboard → el servicio → Logs (retención del
plan) y la sección de Log Streams.`
Severidad: Alta.
Recomendación: dos capas, la primera sola ya cierra el caso.
(1) `redact` en `logger.ts` para
`req.headers.authorization`/`req.headers.cookie`/`res.headers["set-cookie"]`
— un solo lugar, cubre también cualquier `logger.error({ err })` que
arrastre un request adentro. (2) un `serializers.req` propio en el
`pinoHttp` con la lista blanca de headers que interesan. Bajar el
query string a path pelado es la tercera, alineada con la decisión ya
tomada en `error.middleware.ts:101`.
¿Requiere modificar código?: Sí. Sin decisión de negocio: nadie eligió
loguear tokens.
Prueba necesaria: un test que monte la app real, dispare un request con
`authorization` y `cookie`, capture el stream de pino y asere que ninguna
línea contiene el valor de ninguno de los dos. Hoy falla.
```

### F8-11 — No hay identificador de correlación efectivo: el `req.id` no sale del middleware y `correlation_id` es siempre null

```text
Hallazgo: existe la forma de un mecanismo de correlación y no el
mecanismo. (a) `pinoHttp` asigna `req.id`, pero el default de pino-http
11.0.0 es un CONTADOR ENTERO por proceso, no un UUID como afirma el
comentario de `app.ts:142`, y no lee ningún header entrante — dos
instancias, o la misma después de un reinicio, emiten `req.id: 1` para
requests distintos. (b) `req.log` (el logger hijo que sí lleva ese id) no
se usa en NINGÚN archivo del repo: las 98 llamadas a `logger.*` salen del
logger de módulo, así que la única línea del proceso que tiene `req.id` es
la que emite pino-http al terminar el request. (c) `domain_events` tiene
columnas `correlation_id`/`causation_id` y su propio contrato dice "Hoy
SIEMPRE null: no existe correlationId de request en el backend todavía".
Evidencia: src/app.ts:142-146 (el comentario "req.id autogenerado (UUID)"
y el mount) · node_modules/pino-http/logger.js:236-238 (`let nextReqId = 0;
return function genReqId (req, res) { return req.id || (nextReqId =
(nextReqId + 1) & maxInt) }`) · `grep -rn "req\.log" src` → 0 resultados ·
src/repositories/domain-event.repository.ts:16-18 (la declaración de que
siempre es null) · src/repositories/sql.domain-event.repository.ts:93
(`event.correlationId ?? null` — ningún productor la manda) ·
src/workers/outbox.handlers.ts:588 (`correlationId: event.correlationId ??
event.eventId ?? String(event.id ?? '')` — el fallback que hoy siempre cae
a la segunda o tercera rama).
Impacto: dado un incidente, no hay forma de agrupar las líneas de un
mismo request: ni entre middlewares, ni entre un handler HTTP y el evento
de outbox que ese request encoló, ni entre el 500 del borde y el
`logger.error` del servicio que lo causó. En un proceso que multiplexa
TODOS los tenants (un solo proceso, N pools, N workers) eso se suma a
F8-08: las líneas no se pueden agrupar ni por request ni por negocio.
Causa probable: el comentario de `app.ts:142` describe la intención ("queda
disponible como correlación en el resto de los logs de ese request si algún
handler lo necesita") y ningún handler lo necesitó nunca, así que la mitad
que faltaba —usar `req.log`— no se hizo. La columna del evento se creó con
el criterio explícito y correcto de "que el día que exista sea una línea".
Nivel de certeza: Alta para las tres partes. El default de pino-http está
verificado en el código instalado, no inferido de la doc.
Severidad: Media-Alta.
Recomendación: tres piezas, cada una útil sola. (1) `genReqId` que lea
`x-request-id` del proxy y genere un UUID si no viene (Render/Cloudflare
ya mandan uno); (2) `AsyncLocalStorage` con el request id, consumido por
un método del logger, para que las 98 llamadas existentes lo hereden sin
tocarlas una por una — la alternativa (pasar `req.log` por parámetro) toca
todas las firmas; (3) poblar `correlation_id` al insertar el evento, que
es la línea que su contrato ya anticipó.
¿Requiere modificar código?: Sí, las tres. Ninguna requiere decisión de
negocio. (1) es de radio 1 archivo.
Prueba necesaria: test que dispare dos requests concurrentes y asere que
las líneas de cada uno comparten un id distinto entre sí; y un test que
asere que el evento insertado por un request lleva el mismo id.
```

### F8-12 — El sistema no expone ni loguea ninguna versión del código desplegado

```text
Hallazgo: no hay forma, desde afuera ni desde los logs, de saber qué
código está corriendo. `package.json` declara `1.0.1` y ese valor no se
lee en ningún lado. No hay commit SHA (Render expone
`RENDER_GIT_COMMIT`, sin usar), `/health` devuelve solo `status`, `mode` y
`uptimeSeconds`, y `Sentry.init()` no recibe `release`, así que ninguna
traza ni ningún error del tracker se puede atar a un deploy.
Evidencia: `grep -rn "RENDER_GIT_COMMIT\|COMMIT_SHA\|APP_VERSION\|
npm_package_version" src` → 0 · src/app.ts:225-231 (`/health`) ·
src/app.ts:233-241 (`/health/db`: `db`, `checkedAt`, `ageMs`, `cached`) ·
src/instrument.ts:18-24 (`dsn`, `environment`, `tracesSampleRate` —
sin `release`) · render.yaml (ninguna env de versión; `SENTRY_DSN` es la
única entrada relacionada) · package.json (`"version": "1.0.1"`) · lo
único versionado del runtime es `CURRENT_SCHEMA_VERSION`
(tenant-db.setup.ts), que describe el schema de CADA TENANT, no el código,
y se compara warn-only (tenant.middleware.ts:84-96).
Impacto: ante un incidente no se puede responder "¿esto ya tiene el fix?"
sin correlacionar a mano la hora del log contra el historial de deploys de
Render. Y el repo commitea directo a `main` sin PR, varias veces por
sesión: la ventana entre dos versiones distintas es de minutos. Es además
lo que impide cerrar el ciclo de F8-03: aun arreglando el filtro de
Sentry, un error agrupado no diría en qué versión apareció.
Causa probable: nunca hizo falta hasta ahora — con un solo servicio y un
solo entorno, la hora del log alcanzaba. El `release` de Sentry es un
campo opcional y su ausencia no produce ningún error.
Nivel de certeza: Alta (es una ausencia medida con grep sobre todo `src`
más `render.yaml` y `package.json`).
Severidad: Media.
Recomendación: una sola pieza resuelve las tres caras: leer
`RENDER_GIT_COMMIT` (con fallback a la versión de `package.json`) al
arrancar y usarla en (a) un campo del log de boot, (b) `/health`, (c)
`Sentry.init({ release })`. Es el caso de uso exacto de la capa de
configuración que F7-06 pidió construir, así que conviene hacerlo junto o
después de eso, no antes.
¿Requiere modificar código?: Sí, chico. Sin decisión de negocio.
Prueba necesaria: test que asere que `/health` incluye una versión no
vacía cuando la env está seteada, y que no rompe cuando no lo está.
```

### F8-13 — Los dos escapes con Nota de Crédito tragan cualquier error de `requestInvoice()`, incluida la incertidumbre de AFIP

```text
Hallazgo: el fast-path de reintento de los dos orquestadores del escape
fiscal envuelve la llamada completa a `InvoiceService.requestInvoice()` en
un `catch {}` vacío con el comentario "cae al camino normal". Ese catch no
distingue nada: le pasa lo mismo un `AfipRequestUncertainError` (AFIP pudo
haber emitido la NC), un `AfipNotConfiguredError` (falta el certificado:
un problema de configuración, no de estado), un `InvoiceAlreadyLinked...`
y un timeout de la base. No hay `logger` en ninguna de las dos ramas.
Evidencia: src/facturacion/cancel-order-with-credit-note.service.ts:251-273
(el try envuelve `requestInvoice` entero; `:271-273` el catch vacío) ·
src/facturacion/cancel-reservation-with-credit-note.service.ts:298-323
(espejo exacto; `:321-323`) · src/facturacion/invoice.service.ts:1444-1528
(los seis desenlaces que ese catch unifica) · el camino normal al que "cae"
responde `CreditNoteCancellationPendingError` → 422
(error.middleware.ts:203), que es correcto para el caso ambiguo y
engañoso para el de configuración: le dice al operador "quedó pendiente,
revisión manual" cuando lo que falta es cargar un certificado.
Impacto: el operador recibe un mensaje que describe el síntoma
("pendiente") y no la causa, y no hay log que permita recuperarla después.
En el subcaso `AfipNotConfiguredError` la pérdida es total: ese error se
lanza ANTES de cualquier escritura (`invoice.service.ts:595-601`), así que
no queda ni la fila de `invoices` con `error_message` — no queda nada, en
ningún lado. Es el caso textual de "errores que no distinguen causa de
síntoma" del protocolo.
Causa probable: el fast-path se agregó para resolver el reintento de un
escape ya iniciado, y su contrato se pensó como "si no sale, seguí por el
camino largo" — que es correcto como control de flujo y se implementó
descartando la información en vez de registrarla.
Nivel de certeza: Alta. Los dos bloques y el camino de caída están leídos
completos.
Severidad: Alta (circuito fiscal, y un subcaso sin ningún rastro).
Recomendación: mantener el control de flujo (seguir al camino normal) y
agregar un `logger.warn` con `evento:` propio y la clase del error antes
de caer — el repo ya tiene el patrón exacto tres líneas más arriba en el
mismo dominio (`invoice.service.ts:516`, `evento:
'factura_con_ar_viva'`). Aparte y opcional: no tragar
`AfipNotConfiguredError`, que no es un estado del que el camino normal
pueda recuperarse.
¿Requiere modificar código?: Sí, ~8 líneas en dos archivos. El segundo
punto cambia un status observable → confirmar con el dueño.
Prueba necesaria: test de cada orquestador con un `InvoiceService` fake
que lance `AfipNotConfiguredError`, aserando qué se loguea y qué status
sale. Hoy: nada y 422.
```

### F8-14 — `ReservationHoldExpiryWorker` reintenta indefinidamente, sin backoff, sin tope y sin dead-letter

```text
Hallazgo: el worker de vencimiento de holds captura el error por reserva,
loguea y sigue. La reserva que falló sigue siendo `PENDING` con seña
vencida, así que el próximo `getPendingWithExpiredDeposit()` la devuelve
otra vez: si la causa es estable (una invariante de dominio que lanza en
`reservation.expire()`, una fila inconsistente), el mismo error se
reproduce cada 60 segundos, para siempre, sin contador de intentos, sin
backoff y sin ningún estado terminal. Es el contraste exacto del
OutboxWorker, que en el mismo repo tiene las tres cosas.
Evidencia: src/workers/reservation-hold-expiry.worker.ts:79-91 (el poll:
`for` con try/catch por reserva, `logger.error` y continuar) · :54
(`pollIntervalMs = 60_000`) · :93-155 (`expireOne`, sin ninguna marca de
intento) · contraste: outbox.worker.ts:219 (`maxRetries = 60`),
sql.domain-event.repository.ts:128-146 (backoff 5s/30s/120s/300s),
:175-189 (`failed_at` en la misma UPDATE) · la línea de error tampoco
lleva `businessId` (`:85`, `{ err, reservationId }`), aunque el worker SÍ
lo tiene en `this.businessId` y lo usa en `:60-63`.
Impacto: una reserva atascada produce una línea de `error` por minuto,
indefinidamente — 1440 por día, por reserva. Eso no solo es ruido: ahoga
la señal del resto (y el propio repo ya declaró ese criterio en
error.middleware.ts:70-71, "ruido de alto volumen que ahoga la señal"). Y
nada escala el caso a una persona: no hay mail, ni banner, ni estado
terminal que alguien pueda listar.
Causa probable: el worker se escribió como el hermano chico del de outbox
(mismo ciclo de vida, arrancado en el mismo lugar) y no heredó su política
de reintento, que es lo que el outbox tiene de más valioso. El caso
"expirar una reserva falla siempre" probablemente no se consideró
alcanzable.
Nivel de certeza: Alta para el mecanismo (156 líneas leídas completas).
HIPÓTESIS_A_CONFIRMAR para que exista hoy una causa estable de fallo:
`No confirmado.` `Información faltante: si alguna ruta de
reservation.expire()/saveWithClient puede lanzar de forma determinística
para una fila concreta.` `Cómo verificarlo: revisar los guards de
Reservation.expire() y los CHECK de la tabla reservations contra los
estados alcanzables.`
Severidad: Media.
Recomendación: la decisión de fondo es si este worker merece el mismo
contrato que el outbox (contador + backoff + estado terminal, que en este
caso sería una columna nueva en `reservations` o una fila de dead-letter)
o si alcanza con un límite de ruido (loguear el mismo `reservationId` una
vez por ventana). Son dos niveles de esfuerzo muy distintos y la elección
depende de cuánto importe la reserva atascada — decisión del dueño. Lo que
NO es decisión de negocio es sumar `businessId` a la línea de error.
¿Requiere modificar código?: Sí. No implementado.
Prueba necesaria: test con un repositorio fake que devuelva siempre la
misma reserva y un `saveWithClient` que lance; correr N polls y aserar el
comportamiento esperado (hoy: N errores idénticos, sin estado terminal).
```

### F8-15 — La `idempotencyKey` del pago existe pero está atada al intento, no al pago: el reintento humano tras un error ambiguo duplica plata

```text
Hallazgo: `recordPayment()` es idempotente sólo si le llega una
`idempotencyKey`, y el parámetro es opcional: con `undefined` se persiste
`null` y el índice único no puede correlacionar dos llamadas (dos NULL no
colisionan en Postgres). El único caller real —la pantalla de cuentas
corrientes— la genera con `crypto.randomUUID()` DENTRO del handler del
submit, así que cada envío produce una clave nueva. Resultado: la clave
protege el caso que no ocurre (un reintento automático del mismo request;
`lib/http.ts` no tiene ninguno) y no protege el que sí ocurre (el operador
vuelve a apretar "Registrar pago" después de un 500 o un timeout, que es
exactamente el escenario del COMMIT ambiguo de F8-01).
Evidencia: src/clientes-finanzas/customer-account.service.ts:146
(`idempotencyKey?: string`), :203 (`idempotencyKey: params.idempotencyKey
?? null`), :121-124 (el docblock que promete "si el caller reintenta el
mismo pago (ej. timeout de red seguido de un click de 'reintentar'), no se
duplica") · src/api/schemas/request.schemas.ts:441 (`idempotencyKey:
z.string().min(1).optional()`) · src/clientes-finanzas/customers.routes.ts:945
(`...(body.idempotencyKey && { idempotencyKey: body.idempotencyKey })` — se
reenvía solo si vino) · appfrontend/src/app/dashboard/cuentas-corrientes/page.tsx:180-204
(`async function handleRecordPayment` → `:187` `const idempotencyKey =
crypto.randomUUID()`, dentro del handler; el comentario de `:185-186` dice
"si el pedido se reintenta por un corte de red, el backend no duplica el
pago") · :426 (`disabled={paying || ...}`: el doble click concurrente SÍ
está cubierto, por el estado del botón, no por la clave) ·
appfrontend/src/lib/http.ts (sin retry, sin timeout, sin AbortController).
Impacto: dos filas `PAYMENT` `SETTLED` por un solo pago recibido, con el
saldo del cliente sobredeclarado y sin ninguna señal de duplicado —
`financial_transactions` no tiene otra clave natural que pueda frenarlo.
Corregirlo después exige un contra-asiento manual. Es el hueco de
idempotencia más caro de los encontrados, y el mecanismo para cerrarlo ya
está construido: solo está mal anclado.
Causa probable: la clave se agregó pensando en el reintento de transporte
(el caso que la palabra "idempotencia" evoca) y se generó donde era más
cómodo. Que el reintento realista sea humano —y que por definición pase por
un render nuevo del handler— no se consideró.
Nivel de certeza: Alta. Las dos puntas (servicio y pantalla) están leídas;
la ausencia de retry en `http.ts` verificada por grep.
Severidad: Alta.
Recomendación: anclar la clave a la INTENCIÓN de pago, no al intento —
generarla al abrir el formulario (o derivarla de
`customerId+amount+allocations+día`, que es la forma que usa el propio
backend en `invoice:${ftId}` y en `hashIds()`), y regenerarla sólo cuando
el operador cambia los datos. Aparte: evaluar si `idempotencyKey` debería
ser obligatoria en el schema HTTP para un endpoint que mueve dinero —eso
rompe cualquier cliente que hoy no la manda, así que es decisión del dueño.
¿Requiere modificar código?: Sí, en los dos repos. El cambio del frontend
es chico y no requiere decisión de negocio; volverla obligatoria sí.
Prueba necesaria: test de integración con Postgres real: dos POST
/api/customers/:id/payments con la MISMA clave → una sola fila (hoy pasa);
y una prueba manual de la pantalla que confirme que dos envíos consecutivos
del mismo formulario mandan la misma clave (hoy: no).
```

### F8-16 — El proceso no tiene handler de `unhandledRejection`/`uncaughtException`: una caída no deja log estructurado ni llega al tracker

```text
Hallazgo: no hay ningún `process.on('unhandledRejection')` ni
`process.on('uncaughtException')`. El repo usa `void` sobre promesas en
varios caminos de worker, así que una promesa rechazada ahí termina el
proceso por el default de Node — con un stack trace crudo en stderr, sin
pasar por `pino` (o sea, sin JSON, sin `businessId`, sin nada de lo que el
agregador espera) y sin `Sentry.captureException`, que el repo solo invoca
en los dos caminos de arranque.
Evidencia: `grep -rn "process.on" src` → únicamente src/app.ts:592-593
(`SIGTERM`, `SIGINT`) · src/server.ts:56-57 y :88-89 (los dos únicos
`Sentry.captureException`, los dos en el boot) · `void` sobre promesas en
caminos de worker: src/workers/outbox.worker.ts:304 (`void this.poll()`),
:389 (`void this.stop()`), src/platform/tenant.middleware.ts:113 (`void
stopTenantWorker(businessId)`), src/workers/reservation-hold-expiry.worker.ts:59
· mitigante real: los `poll()` de los tres workers tienen try/catch con
`finally`, y `stopTenantWorker`/`worker.stop()` no tienen ninguna operación
que razonablemente rechace — por eso esto es una brecha de red, no un bug
activo.
Impacto: la caída del proceso —el evento más grave posible— es el peor
documentado de todos: el diagnóstico queda en un stream que no está
estructurado ni correlacionado, y el tracker de errores no lo ve. Con
F8-12 encima, tampoco se sabe qué versión cayó.
Causa probable: los handlers de proceso son una pieza que no hace falta
hasta el primer incidente, y el repo ya tiene shutdown ordenado por señal,
que cubre el caso previsto.
Nivel de certeza: Alta para la ausencia. HIPÓTESIS_A_CONFIRMAR para la
alcanzabilidad: ninguno de los `void` identificados tiene hoy un camino de
rechazo evidente.
Severidad: Media.
Recomendación: dos handlers de proceso que loguen por `pino` con la clave
`err`, hagan `Sentry.captureException` + `flush`, y —para
`uncaughtException`— salgan con código distinto de 0 para que Render
reinicie. Sin decisión de negocio.
¿Requiere modificar código?: Sí, ~10 líneas en `server.ts`.
Prueba necesaria: un spike que dispare un rechazo no capturado en un
entorno de prueba y confirme que la línea sale estructurada y que Sentry
la recibe.
```

---

## 4. Resumen por severidad

| ID | Hallazgo | Severidad | ¿Código? | Decisión del dueño |
|---|---|---|---|---|
| F8-10 | `authorization` y `cookie` de sesión en el log de cada request (reproducido) | **Alta** | Sí | No |
| F8-06 | Connection string con contraseña en el mensaje de un error que se loguea completo | **Alta** | Sí | No |
| F8-07 | Crash entre el claim y el handler → efecto financiero salteado en silencio | **Alta** | Sí | No (el sweep está en HOLD) |
| F8-15 | `idempotencyKey` del pago atada al intento → el reintento humano duplica el pago | **Alta** | Sí (2 repos) | Solo si se vuelve obligatoria |
| F8-02 | Factura `PENDING` con AFIP ya contactado; el reintento la cree segura | **Alta** | Sí | **Sí** (circuito fiscal) |
| F8-05 | Cuatro estados intermedios en la saga de tenant; `repair-tenant-db` no compensa | **Alta** | Sí | No, pero bloqueado por F7-04(c) |
| F8-13 | Los dos escapes de NC tragan cualquier error de `requestInvoice()` | **Alta** | Sí | Parcial |
| F8-01 | COMMIT ambiguo + conexión devuelta al pool en estado abortado | **Alta** | Sí | No |
| F8-03 | Raw de AFIP al navegador; y ningún canal de alerta para `FAILED_UNCERTAIN` | Media-Alta | Sí | Parcial |
| F8-08 | 14 líneas del OutboxWorker sin `businessId`, sobre un `event.id` no único | Media-Alta | Sí | No |
| F8-11 | Sin correlación efectiva: `req.log` sin usar, `correlation_id` siempre null | Media-Alta | Sí | No |
| F8-04 | `reconcileAfterFailure` descarta la causa de no poder reconciliar | Media | Sí | No |
| F8-09 | El worker auto-pausado por `42P01` no se rearranca nunca | Media | Sí | No |
| F8-12 | Cero información de versión (ni SHA, ni release de Sentry, ni `/health`) | Media | Sí | No |
| F8-14 | Hold-expiry reintenta indefinidamente, sin backoff ni tope ni dead-letter | Media | Sí | **Sí** (cuánto importa la reserva atascada) |
| F8-16 | Sin handlers de `unhandledRejection`/`uncaughtException` | Media | Sí | No |

**Brecha registrada sin hallazgo propio:** no existe ninguna métrica
(contador, gauge, histograma) en el backend — no es una degradación
silenciosa ni un defecto de implementación, es una capa que no se
construyó. Decidir si se construye (y con qué) es producto, no auditoría.

**Lo que está bien y conviene no romper**, porque tres de los hallazgos de
arriba son justamente "esto no está a la altura del resto":

1. El contrato de reintento del OutboxWorker (backoff escalonado por
   evento, tope de 60, dead-letter en la misma UPDATE atómica, permanente
   vs. transitorio, poison message desprioritizado, tres canales de aviso
   al operador). Es el mejor del repo y responde las 7 preguntas del
   protocolo sin ayuda.
2. La política de logging declarada de `error.middleware.ts:64-94`
   (MID-LOG-001): qué se loguea, qué no, y por qué — con exclusiones
   deliberadas y no accidentes del umbral. F8-10 es grave en parte porque
   esta política ya existía y el middleware de acceso la anula.
3. El estado `FAILED_UNCERTAIN` con `afipContacted` como estado de primera
   clase, con UI y bandeja de resolución manual: es la respuesta correcta
   a "¿puede dejar el sistema en un estado intermedio?" — un intermedio
   nombrado, visible y resoluble.
4. `registrarDesenlace()` (`outbox.handlers.ts:566-653`): severidad
   graduada por tipo de desenlace, con `causa` estructurada y el criterio
   explícito de no abrir incidente por un redelivery benigno.
5. La distinción fail-open / fail-closed razonada caso por caso en los
   handlers (fail-closed para `classify*LiveInvoice`, que protege una
   decisión real; fail-open para los detectores de divergencia, que corren
   después de que el trabajo ya commiteó), cada una con su `evento:` propio
   para que "no hay anomalía" y "el detector tiró" no se confundan.

---

## 5. No confirmado

```text
No confirmado.
Información faltante: retención real de los logs de Render para este
servicio y si hay algún Log Stream externo configurado — determina el
radio de F8-10 y F8-06.
Cómo verificarlo: Render Dashboard → servicio → Logs (retención del plan)
y sección Log Streams.
```

```text
No confirmado.
Información faltante: si Sentry, con `sendDefaultPii` en su default
(false), recorta los headers `authorization`/`cookie` del contexto de
request que adjunta a un error — es una segunda vía de salida de los
mismos tokens de F8-10, independiente de pino.
Cómo verificarlo: disparar un 500 en un entorno de prueba con `SENTRY_DSN`
seteada y mirar el evento recibido en el proyecto de Sentry.
```

```text
No confirmado.
Información faltante: si la API de Neon exige unicidad de nombre de branch
dentro de un proyecto — determina si el reintento de F8-05 duplica el
branch o falla.
Cómo verificarlo: POST /projects/{id}/branches dos veces con el mismo
`branch.name` contra el proyecto de staging.
```

```text
No confirmado.
Información faltante: si existe hoy una causa determinística de fallo en
`Reservation.expire()`/`saveWithClient()` para una fila concreta — es lo
que convierte F8-14 de riesgo estructural en incidente alcanzable.
Cómo verificarlo: revisar los guards de `expire()` y los CHECK de
`reservations` contra los estados alcanzables por una fila PENDING con
seña vencida.
```

```text
No confirmado.
Información faltante: si `pg` marca como no reusable una conexión cuyo
`ROLLBACK` falló, o si la devuelve al pool en estado abortado (parte (ii)
de F8-01).
Cómo verificarlo: el test de integración descrito en la Prueba necesaria
de F8-01 — tomar N conexiones del mismo pool tras el fallo y ver si alguna
devuelve `25P02`.
```

---

## 6. Alcance excluido

- **El frontend, salvo dos puntas concretas.** Se leyeron
  `cuentas-corrientes/page.tsx` (F8-15), `lib/http.ts` (ausencia de retry)
  y `FacturarButton.tsx` (consumo del mensaje de error). El manejo de
  errores del panel como sistema —`ToastContext`, `extractErrorMessage`, el
  interceptor de sesión vencida— no se auditó: es su propia fase.
- **`src/scripts/*`.** `logger.ts` los excluye a propósito (corren a mano,
  con un humano leyendo la terminal). `migrate-tenants.ts` entra igual por
  el `buildCommand` de `render.yaml`, y su manejo de errores toca
  `pipeline-trust`, no esta fase.
- **Los 62 sitios de `logger.*` sin `businessId`, uno por uno.** Se midió
  el agregado y se detalló el grupo que más duele (los 14 del
  OutboxWorker, F8-08). Barrer los 48 restantes es un bloque de higiene,
  no un hallazgo.
- **Contenido de los mensajes de error de las 122 clases `DomainError`.**
  `C6-09` ya midió la fragmentación del catálogo; qué dato de negocio lleva
  cada mensaje (y por lo tanto qué expone el body HTTP) es una revisión de
  122 strings que no se hizo acá. Solo se verificó el caso del raw de AFIP
  (F8-03), por ser el único que interpola una respuesta externa completa.
- **Volumen real de logs y costo.** No se midió; F8-14 afirma la
  aritmética (1440 líneas/día/reserva atascada), no una observación de
  producción.

---

## Apéndice — verificación independiente del gate `architecture-governor` (15/09/2026)

El cuerpo de arriba es verbatim del agente productor y no se edita. Este apéndice
registra lo que el gate verificó por su cuenta antes de autorizar el commit —
incluida una re-ejecución en vivo de F8-10, no solo lectura de código— y dos
correcciones factuales encontradas al hacer spot-check de los hallazgos.

**F8-10 — REPRODUCIDO de forma independiente, no solo confirmado por lectura.**
El gate corrió un script propio (fuera del repo, en su scratchpad) usando los
`node_modules` reales del repo (`pino-http` 11.0.0, `pino` 10.3.1) con la
invocación idéntica de `app.ts:146` sobre una réplica exacta de `logger.ts`.
Salida real:

```
{"level":30,"time":1789499351026,"pid":10515,"hostname":"vm",
 "req":{"id":1,"method":"GET","url":"/api/customers?email=cliente@ejemplo.com&name=Juan",
 "headers":{"authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.SECRETO_JWT_DE_SESION.firma123",
 "cookie":"auth_token=SECRETO_COOKIE_DE_SESION; otra=1","host":"127.0.0.1:45545",
 "connection":"keep-alive"},"remoteAddress":"127.0.0.1","remotePort":39678},
 "res":{"statusCode":200,"headers":{}},"responseTime":11,"msg":"request completed"}
```

El header `authorization` completo, la cookie `auth_token` completa y el query
string con PII salen en la misma línea, tal como afirma el hallazgo. Causa
confirmada por lectura de `node_modules/pino-std-serializers/lib/req.js:88`
(`_req.headers = req.headers` — copia verbatim, sin filtrar ninguna clave) más
la ausencia de `redact` en `logger.ts` (33 líneas, leído completo). De paso
queda confirmado F8-11(a): `req.id` sale `1` — un contador entero
(`pino-http/logger.js:236-238`), no el UUID que promete el comentario de
`app.ts:142-144`.

**Agravante no señalado por el informe (F8-06):** el serializador `err` de pino
emite el secreto DOS veces por línea — en `err.message` y en `err.stack` — no
solo una, como sugiere la redacción actual ("incluye `message` y `stack`").

**Árbol de git confirmado limpio de forma independiente**, incluso después de
correr sus propias reproducciones (el gate escribió sus scripts en su propio
scratchpad, nunca en el repo): `git status --porcelain --untracked-files=all`
en `/home/user/app` mostró una sola entrada, este mismo `.md`. Sin rastro del
`phttp-tmp.cjs` que el agente productor dice haber creado y borrado.

**Corrección 1 — F8-15, evidencia falsa sobre `appfrontend/src/lib/http.ts`,
la conclusión se sostiene y se fortalece.** El cuerpo de este documento afirma
tres veces (incluida la sección "Nivel de certeza: Alta ... verificada por
grep") que `appfrontend/src/lib/http.ts` no tiene reintento automático. Es
falso: el archivo sí lo tiene, con backoff exponencial —
`RETRYABLE_METHODS`/`MAX_RETRIES = 3`/`BASE_DELAY_MS = 1_500`
(`http.ts:52-57`, `:106`, `:125`, `:136`). El grep del agente productor falló
por ser case-sensitive sobre `"retry"` (no matchea `Retry`/`RETRYABLE_METHODS`/
`MAX_RETRIES`). La conclusión de F8-15 no cambia — y se fortalece: el retry
está limitado a `RETRYABLE_METHODS = new Set(['GET', 'HEAD'])`, así que un
`POST` que registra un pago nunca se reintenta solo (`canRetry === false`); el
propio archivo lo declara ("No reintenta en 4xx ... ni en mutaciones
peligrosas"). Eso significa que el reintento humano es el ÚNICO reintento que
existe para ese endpoint — exactamente el argumento por el que la
`idempotencyKey` necesita anclarse a la intención de pago, no al intento. La
frase "sin timeout, sin AbortController" del cuerpo sí es correcta. Bonus:
confirmado el índice único parcial `CREATE UNIQUE INDEX ... ON
financial_transactions (idempotency_key) WHERE idempotency_key IS NOT NULL`
(`src/db/schema.sql:2307-2309`) — excluye NULLs explícitamente, así que "dos
NULL no colisionan" es correcto y más fuerte de lo que el cuerpo declara.

**Corrección 2 — F8-08, ancla equivocada (no afecta la afirmación).** El
cuerpo cita `src/workers/outbox.registry.ts:86` para
`workers.set(businessId, worker)`. La línea 86 está en blanco; el guard
`workers.has(businessId)` está en `:85` (correctamente citado en F8-09); y
`workers.set(businessId, worker)` está en `:150`, no `:86`. La afirmación
("un worker por tenant") es verdadera — solo el número de línea es incorrecto.
El conteo central del hallazgo (las 14 líneas de `logger.*` sin `businessId`
en `outbox.worker.ts`) es correcto: coincide verbatim con las líneas citadas
(305, 323, 339, 355, 383, 394, 407, 435, 460, 493, 511, 543, 556, 578), y
`grep businessId src/workers/outbox.worker.ts` da 0 resultados.

**Observación de alcance sobre F8-07 (no es un error del hallazgo):** la misma
ventana claim→handler existe una segunda vez, en `runDeadLetterHandler`
(`outbox.worker.ts:541` claim / `:551` handler / `:554` release) — el camino
de `OUTBOX-DL-COMPENSATOR-01`. El sweep que F8-07 pide diseñar tendría que
cubrir los dos casos, no solo `runHandler`.

**Spot-check de anclas adicionales, todas exactas salvo dos off-by-one
triviales:** F8-01 (`pg.transaction-manager.ts:36/39/40/42`, el archivo tiene
45 líneas no 43), F8-02 (`retryExisting` `:1371-1373`, `issue()` `:1444`,
`markFailed` `:1471`), F8-03/F8-12 (filtro de Sentry por clase en
`app.ts:540-545`, `/health` sin versión), F8-06 (`neon-provisioning.ts:92,136`,
`business.routes.ts:183`), F8-13 (`cancel-order-with-credit-note.service.ts`:
el informe cita `:251` para el `try`, es `:252`). Mediciones de §0 re-corridas
de forma independiente y coincidentes: `req.log` = 0, greps de versión = 0,
`transactionManager.run` = 69, `Sentry.captureException` = 2, `process.on`
solo `SIGTERM`/`SIGINT` (un tercer match en `outbox.worker.ts:191` es un
docblock, no un call site).

**Escaneo de prompt injection / instrucciones ocultas: limpio**, incluido un
barrido byte a byte de los 82.035 caracteres del documento (0 codepoints de
formato Unicode, 0 zero-width, 0 bidi override, 0 BOM, 0 comandos shell u
patrones de exfiltración, 0 comentarios HTML/`<script>`/URLs).

**No re-verificado por este gate:** las 5 secciones "No confirmado" siguen sin
confirmar (correctamente declaradas como tales); el script de conteo de
98 call sites / 36 con `businessId` no se re-corrió; F8-04, F8-05, F8-09,
F8-11, F8-14 y F8-16 no se auditaron más allá de sus anclas incidentales
(F8-09 quedó parcialmente corroborado: `registry.ts:85`, `worker.ts:376-395`,
`stopTenantWorker` en `:186-198`, todos exactos).

**Decisión: APPROVED WITH CONDITIONS.** Autorizado el commit de este
documento, solo-docs (no toca rutas, `authorize()`, `spec.ts`, schema ni
`inventario-rutas.md` — ninguna cerca del repo queda implicada). **F8-10 NO
queda autorizado para ningún cambio de código en este gate** — es su propio
bloque, con su propio gate, próximo paso sugerido: un `redact` de ~4 líneas en
`src/logger.ts` (sin decisión de negocio pendiente).

**Riesgo de continuidad señalado por el gate (no bloquea este commit):**
ninguno de los 12 documentos `auditoria-integral-fase*.md` de este protocolo
figura en `docs/indice-conocimiento.md`, y ningún hallazgo de las 8 fases
completadas hasta ahora aparece en ningún `pendientes-*.md` — incluidos los
16 de esta fase (8 de severidad Alta, una credencial de sesión viva). Es el
mismo patrón que el incidente del roadmap del 25/08/2026 que este repo ya
tiene documentado. Merece su propio bloque, no bundlearlo en este commit.
