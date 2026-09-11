# Diseño: polling adaptativo de los 3 workers (Neon scale-to-zero)

**Fecha:** 2026-09-10. **Gate:** `architecture-governor`, ronda 1 = HOLD (ver
`docs/pendientes-2026-09-10.md`). Este documento existe porque el checklist
§2 de `DEFENSIVE_DEVELOPING.md` lo exige cuando el alcance admite más de una
interpretación razonable — no se escribe en paralelo al código, va antes.

## 0. Por qué existe este bloque

`company-sync.worker.ts` (10s), `outbox.worker.ts` (5s por tenant) y
`reservation-hold-expiry.worker.ts` (60s por tenant) pollean más seguido que
la ventana fija de 5 minutos del scale-to-zero de Neon (free plan) — ningún
compute llega nunca a esos 5 minutos de inactividad, así que queda activo
casi continuo. Esto agotó el cupo de compute del plan free el 2026-09-10
(incidente ya resuelto activando billing en la organización; este bloque es
la corrección de fondo, no un apagafuegos).

Se descartó "subir el intervalo fijo a ≥5 min" por costo de latencia de
negocio (outbox tarda en despachar cargos/mails/consolidación de stock). El
dueño pidió "polling adaptativo" como su propio bloque.

## 1. Decisión de negocio (obtenida, no asumida)

**Pregunta separada de "¿adaptativo sí o no?"**, per `app-main/CLAUDE.md`
("Preguntas de alcance pueden esconder una decisión de negocio"): ¿el primer
evento de outbox después de un rato sin actividad puede esperar hasta el
intervalo idle completo, o hace falta un mecanismo de despertar inmediato?

**Respuesta del dueño (`AskUserQuestion`, 2026-09-10): sí, implementar
`wake()`.** El intervalo largo queda como red de seguridad, no como camino
principal.

## 2. Mecanismo de scheduling — helper compartido

`src/workers/adaptive-poller.ts` (nuevo). Reemplaza el `setInterval` de
intervalo fijo en los 3 workers — no convive con él (DEFENSIVE_DEVELOPING
§1 principio 5, "un solo camino por responsabilidad": si uno de los tres
quedara con `setInterval` viejo, habría dos formas de schedulear en el
mismo repo).

Recibe **solo** `() => Promise<boolean>` (true = encontró trabajo) y
números — nunca un repo, pool o `SqlClient`. Esto es lo que mantiene el
helper fuera de DEFENSIVE_DEVELOPING §3 (no toca `req.db` vs
`getPlatformRawPool()`, no abre conexiones).

### 2.1 Contrato de scheduling

- `setTimeout` autoreprogramado (no `setInterval` de intervalo fijo):
  después de que cada `poll()` termina, se decide el próximo delay.
- Binario: `pollFn()` devuelve `true` → próximo delay = `activeIntervalMs`.
  Devuelve `false` → próximo delay = `idleIntervalMs`. Sin backoff gradual
  (más simple de razonar/testear; sin motivo de negocio para graduarlo).
- **Primer tick NO es inmediato** — igual que `setInterval` hoy, el primer
  `poll()` corre recién después del primer `activeIntervalMs`. Esto
  preserva la garantía que `src/scripts/generate-route-inventory.ts`
  necesita (arranca `createApp()` con un `.env` que puede tener
  `PLATFORM_DATABASE_URL` real, y depende de que el worker de
  company-sync no tiquee antes de que el script llame
  `stopCompanySyncWorker()` unos cientos de ms después — ver
  `docs/pendientes-2026-09-10.md`, sección de higiene).

### 2.2 Contrato de `start()`/`stop()` — generación, no booleano

Hallazgo 5 del gate: un booleano de "detenido" no alcanza. Con
autoreprogramación, un `stop()` seguido de un `start()` (camino real y
documentado — `outbox.worker.ts:148-152`: "Se reactiva llamando a
`worker.start()` de nuevo") puede dejar DOS cadenas de timers vivas si el
poll viejo, en vuelo cuando se llamó `stop()`, también reprograma al
terminar.

Diseño:
- Contador de generación (`number`), no booleano.
- `stop()` incrementa la generación **sincrónicamente, antes de cualquier
  `await`** — esto también cierra el Hallazgo 3 (el auto-stop de
  `handlePollError()` ante `42P01`, llamado DESDE ADENTRO de `poll()`, ya
  no puede perder la carrera: cualquier reprogramación posterior compara
  su generación contra la actual y no hace nada si no coincide).
- El wrapper guarda el handle del `setTimeout` vigente para que `stop()`
  lo pueda `clearTimeout` de inmediato, incluso mientras el worker está
  "dormido" en un intervalo idle largo — sin esto, un shutdown esperaría
  hasta 10 minutos.
- `start()` dejа de preguntar "¿existe un handle?" (puede no haber uno
  DURANTE un poll en curso) y pasa a un estado explícito
  (`stopped: boolean`, separado de la generación) para decidir si es
  no-op.
- `stop()` espera al ciclo en curso (`while (this.polling) await sleep`)
  — **los tres workers** quedan con este contrato, incluido
  `CompanyCatalogPropagationWorker` (ver 2.3).

### 2.3 `CompanyCatalogPropagationWorker.stop()` cambia de forma (Hallazgo 4)

Hoy es síncrono y NO espera a `running`. Con el helper compartido pasa a
ser consistente con los otros dos (`stop(): Promise<void>`, espera el
ciclo en curso). Esto es un cambio de comportamiento, no una extracción
neutra:
- `stopCompanySyncWorker()` (`company-sync.registry.ts`) ya es `async` y
  ya hace `await worker.stop()` — el call site no cambia de forma, el
  `await` que ya tenía empieza a esperar de verdad.
- Tests a actualizar en el mismo commit:
  `company-sync.worker.test.ts:73,79` (aserciones sobre `stop()` síncrono)
  y `company-sync.registry.test.ts` (si asume el timing viejo).

## 3. Valores por worker — no uno solo para los tres

### 3.1 `CompanyCatalogPropagationWorker` — el más simple

- `activeIntervalMs = 10_000` (sin cambio).
- `idleIntervalMs = 600_000` (10 min). Justificado por su propio docblock
  ("no es el camino crítico de venta, corre poco frecuente").
- **Corrección (C1, gate, ronda 3, 10/09/2026) — esta premisa era falsa
  tal como estaba escrita.** Decía que el único call site que encola una
  fila en `company_catalog_propagation_queue` vivía "en el mismo módulo
  (`platform/`)". Verificado: el único call site de producción de
  `enqueuePropagation()` es `src/pos-menu/company-catalog.service.ts:228`
  (`syncToCanonical()`) — un servicio de **dominio** (`pos-menu/`), no de
  `platform/`. La implementación original importaba
  `wakeCompanySyncWorker` directo desde ese servicio, lo cual sí cruzaba
  la capa que este diseño pedía no cruzar, y además revertía la
  convención propia del archivo (todas sus dependencias entran por
  constructor y se testean con fakes en memoria, nunca con `vi.mock` de
  un módulo).
  **Mecanismo real, corregido:** `CompanyCatalogService` recibe un 5º
  parámetro de constructor opcional, `onPropagationEnqueued: () => void`
  (default no-op), y lo llama después de `enqueuePropagation()` en vez de
  importar el registry. El **composition root** (`src/pos-menu/products.routes.ts`,
  que ya es el lugar legítimo de este repo para conectar infraestructura
  concreta — ver la excepción de `*.routes.ts` en `.dependency-cruiser.cjs`)
  es quien importa `wakeCompanySyncWorker` y lo pasa como ese callback.
  `pos-menu/ → platform/` no está prohibido por ninguna regla de
  `lint:arch` (la regla `platform-no-depende-de-dominios-de-negocio` es
  de sentido único, `platform/ → DOMINIOS`) — lo que se corrigió no es
  una violación de lint, es que el import vivía en el lugar equivocado
  (el servicio de dominio) en vez del composition root.

### 3.2 `ReservationHoldExpiryWorker` — NO binario, wake calculado

Hallazgo del gate: este worker no es una cola de trabajo genérica, es un
barredor de reloj de pared. Su predicado "¿encontré trabajo?" es falso
casi siempre → un binario activo/idle degrada a "fijo de 10 min" en la
práctica, y el hold vencido seguiría bloqueando disponibilidad hasta 10
min después de `deposit_due_by` (hoy ≤ 60s).

**Mecanismo mejor, adoptado**: en vez de activo/idle, calcular el próximo
timeout desde `MIN(deposit_due_by)` de las reservas `PENDING` con depósito
pendiente. La query que ya usa `getPendingWithExpiredDeposit` ordena por
`deposit_due_by ASC` (`sql.reservation.repository.ts:290-298`) — el dato
ya está a mano, solo hace falta una variante que devuelva también el
próximo `deposit_due_by` FUTURO (no vencido todavía) cuando no hay ninguno
vencido ahora mismo.

- Si hay reservas vencidas AHORA → procesarlas y volver a consultar
  (delay mínimo, ej. 1s, para no bloquear si el batch es grande).
- Si no hay vencidas pero hay una PENDING futura → dormir exactamente
  hasta ese `deposit_due_by` (con un piso de seguridad, ej. no menos de
  1s, no más de `idleIntervalMs=600_000` por si el reloj del proceso
  difiere del de la BD).
- Si no hay ninguna PENDING con depósito → dormir `idleIntervalMs` como
  red de seguridad (no hay wake externo para "se creó una reserva con
  depósito" — construirlo es más invasivo que el beneficio acá, a
  diferencia de outbox: expirar una reserva 5-10 min tarde es un cleanup
  interno de bajo impacto visible, no un cargo/mail/stock).
- Esto NO usa el helper binario de 2.1 — es su propia variante
  (`computeNextDelay(): Promise<number>` en vez de
  `poll(): Promise<boolean>`), o una segunda forma del mismo helper que
  acepte ambos contratos. A decidir en la implementación; ambos casos
  comparten el mecanismo de generación/`stop()` de 2.2.

### 3.3 `OutboxWorker` — binario + wake()

- `activeIntervalMs = 5_000` (sin cambio, preserva la cadencia de
  reintento mientras hay trabajo — ver §4).
- `idleIntervalMs = 600_000` (10 min), pero **solo como red de
  seguridad** — el camino principal es el wake().

#### Mecanismo de wake — propuesta, pendiente de aprobación del gate

`insertWithClient()` (`SqlDomainEventRepository`) se llama desde 5+ call
sites distintos (`reservation.service.ts`, `order.service.ts`,
`reservation-cancel-for-credit-note.ts`,
`order-cancel-for-credit-note.ts`, el propio
`reservation-hold-expiry.worker.ts`). Pedirle a cada call site que
recuerde llamar `wake()` es exactamente el modo de falla que
`DEFENSIVE_DEVELOPING.md` señala como degradación en silencio: un call
site nuevo que se olvide del wake no rompe nada visible, el evento
simplemente tarda hasta 10 min — nadie se entera hasta que alguien lo
nota en producción.

**Propuesta: hook `postCommit` en `PgTransactionManager`, mismo patrón
que `env.cr.postcommit.add()` de Odoo** (`Registry.py` /
`sql_db.py::Cursor.postcommit`) — un registro de callbacks que corren
SOLO si la transacción que los registró llegó a `COMMIT`, nunca si hizo
`ROLLBACK`. Evita duplicar el problema que ya generó
`REFUND-INVOICE-SET-CHANGED` en otro eje de esta sesión: un wake()
disparado ANTES del commit (p.ej. dentro de `work(client)`) encontraría
la fila todavía no visible para otra conexión → el poll saldría vacío →
el helper volvería a idle → el evento esperaría el `idleIntervalMs`
completo, peor que no tener wake.

Mecánica concreta:
```ts
// src/db/post-commit.ts (nuevo, neutral, sin conocer outbox ni workers)
const callbacks = new WeakMap<SqlClient, Array<() => void>>();

export function registerPostCommit(client: SqlClient, cb: () => void): void {
  const list = callbacks.get(client) ?? [];
  list.push(cb);
  callbacks.set(client, list);
}

export function runPostCommitCallbacks(client: SqlClient): void {
  const list = callbacks.get(client);
  if (!list) return;
  callbacks.delete(client);
  for (const cb of list) {
    try { cb(); } catch (err) { logger.error({ err }, '[postCommit] callback falló'); }
  }
}
```

`pg.transaction-manager.ts::run()`:
```ts
const result = await work(tx);
await conn.query('COMMIT');
runPostCommitCallbacks(tx);   // nueva línea, después del COMMIT real
return result;
```

`SqlDomainEventRepository.insertWithClient()`, después del INSERT:
```ts
registerPostCommit(client, () => wakeOutboxWorkerFor(event.businessId));
```

**Resuelto por el gate, ronda 2 (2026-09-10) — ninguna de las 3 alternativas
originales.** El bus en `src/workers/` no elimina la arista
`repositories/ → workers/`, solo la mueve a un módulo más tonto. El hook
`postCommit` en `PgTransactionManager` se **rechaza para este bloque**:
19 de las 20 implementaciones de `TransactionManager` son dobles de test
que no correrían el callback (todo unitario que inserta un evento pasaría
en verde sin disparar el wake — falso-verde por default), el
`WeakMap<SqlClient, cb[]>` puede quedar huérfano si `insertWithClient`
recibe un cliente que no es el `tx` de un `run()` (8 sitios de
construcción de `SqlDomainEventRepository`, no todos garantizados
transaccionales), y es un mecanismo transversal nuevo en la pieza más
compartida del repo para resolver un problema de cadencia de polling.

**Hallazgo nuevo, no cubierto por ningún mecanismo propuesto hasta acá:**
`customer.routes.ts` (portal de clientes) se monta en `app.ts:275`,
**antes** del gate `app.use('/api', tenantMiddleware(...))` de
`app.ts:345` — resuelve su pool directo, sin pasar por
`ensureTenantWorker`. El portal inserta eventos de dominio
(`SqlDomainEventRepository` en `customer.routes.ts:232`) sin que ningún
wake (post-commit o ventana) los cubra. Peor: **si un tenant recibe solo
tráfico de portal desde que arrancó el proceso, no existe `OutboxWorker`
para ese `businessId` en absoluto** — el Map de `outbox.registry.ts`
nunca lo creó. Hoy queda enmascarado porque el staff siempre genera al
menos una request autenticada por día. Es un hueco PREEXISTENTE que este
bloque no crea, pero que el wake (cualquiera sea el mecanismo) va a hacer
más visible el primer día que alguien lo note. **No se arregla en este
bloque** — requiere su propia decisión de producto (¿el portal también
arranca worker? ¿hay un worker de respaldo activo por tenant conocido?).
Registrado en `docs/pendientes-2026-09-10.md`.

**Contrapropuesta del gate, aceptada como dirección para el bloque de
wake del outbox (todavía en HOLD, no autorizado a implementar):**
`outbox.registry.ts` exporta `wakeTenantWorker(businessId): void`
(no-op si no hay worker para ese tenant). Se llama desde
`tenant.middleware.ts:207` (ya importa el registry, corre en toda request
de staff autenticada) — cero import nuevo entre capas. Semántica de
**ventana de actividad**, no wake por evento exacto: compone con el
binario de §2.1 porque, apenas el evento existe, la cola deja de estar
vacía y el poller se queda solo en `activeIntervalMs` — la ventana solo
tiene que cubrir el hueco de segundos entre "llegó la request" y "el
primer poll ve el evento". El único productor no request-driven
(`reservation-hold-expiry.worker.ts:123`, evento `reservation.expired` a
cualquier hora) se resuelve inyectando el wake por constructor desde el
registry al construir ese worker (mismo criterio que ya usa
`outbox.registry.ts:53-59` para no importar `getTenantRawPool()`
directo) — evita el ciclo de imports que se daría si el worker de holds
importara `outbox.registry.ts` de vuelta (`outbox.registry.ts:35` ya
importa `reservation-hold-expiry.worker.ts`, y `lint:arch` corta ciclos
con severidad `error`).

**Pregunta de negocio separada, respondida por el dueño (`AskUserQuestion`,
2026-09-10): "Garantía exacta (post-commit)".** El dueño prefiere el
mecanismo exacto sobre la ventana de actividad probabilística, pese al
costo de invasividad que motivó el rechazo de la ronda 2. **Esto NO
autoriza implementarlo ya** — el gate mantiene el wake del `OutboxWorker`
en HOLD hasta que la matriz de impacto incluya el hueco del portal
resuelto (arriba) y se diseñe un mecanismo post-commit que sí resuelva
los 3 problemas de la ronda 2 (dobles de test, `WeakMap` huérfano,
alcance transversal) — no el hook ingenuo descartado. Bloque propio,
gate propio, cuando se encare.

## 4. Invariante "~5 min de fallas antes de dead-letter" (Hallazgo 3 de la ronda 1, confirmado por el gate)

Se preserva EN LA PRÁCTICA: `getPending()` (`sql.domain-event.repository.ts`)
filtra `dispatched_at IS NULL AND failed_at IS NULL` — un evento que falló
pero no llegó a `maxRetries` sigue devolviéndose, así que la cola no está
vacía y el poller se queda en `activeIntervalMs=5s` mientras dura el
reintento.

**Precisiones que el gate pidió declarar, no asumir:**
- Lo que se preserva es "~5 min desde el PRIMER intento fallido", no desde
  la inserción del evento — el reloj de pared entre inserción y primer
  intento puede llegar a `idleIntervalMs` si el worker estaba dormido
  (mitigado por el wake() de §3.3, pero el wake es best-effort, no una
  garantía dura).
- La relación YA NO era exacta antes de este cambio —
  `docs/diseno-order13-o5-dead-letter-2026-09-07.md` ya declara que el
  `ORDER BY retry_count ASC` puede alargar los 60 intentos más allá de 5
  min si la cola tiene trabajo. Este cambio agrega una segunda fuente de
  divergencia sobre una que ya existía, no la primera.

**Comentarios a reescribir en el mismo commit** (afirman la relación como
constante, dejan de serlo):
- `src/workers/outbox.worker.ts:178` — docblock del constructor.
- `src/workers/outbox.worker.ts:382` — comentario sobre `maxRetries=1`.
- `src/workers/outbox.worker.ts:508` — docblock de `classifyError()`.

## 5. Fuera de alcance de este bloque (declarado, no descartado)

- **"Backoff real" por evento** (`docs/diseno-order13-o5-dead-letter-2026-09-07.md`
  §7, follow-up 1 — columna `last_failed_at`). Concepto distinto: reintento
  por EVENTO vs. cadencia del POLLER. Los dos tocan la relación
  "60 intentos ≈ 5 min" desde ejes distintos — cuando se encare, tiene que
  leer este documento primero para no razonar sobre una relación ya
  desactualizada por partida doble.
- LISTEN/NOTIFY (mencionado como opción futura en
  `outbox.registry.ts:11-12`) — mantiene una conexión dedicada persistente;
  su efecto sobre el autosuspend de Neon no está verificado, y no hace
  falta si el wake() in-process de §3.3 resuelve la latencia real.
- El `??=` de `generate-route-inventory.ts` (ya registrado en pendientes,
  subsistema distinto).

## 6. Evidencia técnica reunida (pedida por el gate)

**Autosuspend de Neon y conexiones ociosas** — no verificable directo
(sin acceso a métricas internas de Neon sobre qué cuenta como
"actividad"), pero hay evidencia indirecta suficiente en el propio código:
los pools de la app YA cierran conexiones ociosas muy por debajo de la
ventana de 5 min de Neon — `tenant.middleware.ts` usa
`idleTimeoutMillis: 30_000` (30s) y el pool de plataforma
(`container.ts`) no fija el valor, así que usa el default de `pg`
(10s). O sea que una conexión abierta-pero-sin-queries no se sostiene
minutos enteros por decisión de esta app — se cierra sola en 10-30s,
mucho antes de que pudiera interferir con el autosuspend de Neon. La
causa medida (queries reales cada 5-10-60s) sigue siendo la explicación
completa sin necesidad de invocar "conexión ociosa cuenta como
actividad" como variable adicional.

**Baseline antes de tocar código** (2026-09-10, commit `65f9c45`):
- `npm run test` → 2049 passed, 160 archivos, 1 skipped, 1 todo.
- `npm run lint:arch` → "no dependency violations found (294 módulos, 1393 deps)".

## 7. Bloque 1 -- CERRADO en código (LOCAL, sin pushear ni deployar)

Autorizado por el gate, ronda 2 (2026-09-10): helper compartido +
`CompanyCatalogPropagationWorker` únicamente. `OutboxWorker` y
`ReservationHoldExpiryWorker` siguen con `setInterval` fijo -- coexistencia
transitoria declarada, no permanente, hasta que el wake del outbox
(§3.3, todavía en HOLD) y la variante de hold-expiry (§3.2) tengan su
propio gate.

**Archivos nuevos:**
- `src/workers/adaptive-poller.ts` -- scheduler binario, contrato de
  generación, `wake()`.
- `src/workers/adaptive-poller.test.ts` -- 12 tests, incluida la prueba
  explícita del Hallazgo 3 (stop() llamado desde adentro de un poll en
  curso).

**Archivos modificados:**
- `src/platform/company-sync.worker.ts` -- migrado al helper;
  `stop(): void` → `Promise<void>`, espera el ciclo en curso (Hallazgo 4);
  `poll(): Promise<void>` → `Promise<boolean>` (informa al scheduler si
  encontró trabajo); `wake()` nuevo.
- `src/platform/company-sync.registry.ts` -- `worker.start()` sin
  intervalo fijo (usa los defaults del worker); `wakeCompanySyncWorker()`
  nuevo, exportado.
- `src/pos-menu/company-catalog.service.ts` -- único call site de
  producción de `enqueuePropagation()` (`syncToCanonical()`, línea ~226)
  ahora llama `wakeCompanySyncWorker()` después de encolar, si hubo
  sucursales hermanas.
- `src/platform/company-sync.worker.test.ts` -- tests de `start/stop`
  reescritos para el nuevo contrato async + arranque diferido; 4 tests
  nuevos (`wake()` x2, "stop() espera el ciclo en curso", "el primer poll
  no es inmediato").
- `src/platform/company-sync.registry.test.ts` -- 2 tests nuevos para
  `wakeCompanySyncWorker()`.
- `src/pos-menu/company-catalog.service.test.ts` -- mock del módulo
  `company-sync.registry.js`, 3 aserciones nuevas de `wake()` (llamado
  cuando hay propagación, no llamado sin sucursales hermanas, llamado
  también desde `shareProduct()`).

**Mutation testing del helper (los 4 pedidos por el gate, aplicados uno
por vez sobre `adaptive-poller.ts`, confirmados rojos, revertidos):**
1. Invertir el booleano activo/idle (`foundWork ? idle : active`) → **4
   tests en rojo** (los que verifican la cadencia correcta).
2. Sacar el chequeo de generación posterior al `await pollFn()` →
   **inicialmente quedó en VERDE** con la aserción original del test de
   Hallazgo 3 (medía reinvocación de `pollFn()`, que el chequeo del TOPE
   de `runCycle` ya neutraliza en el ciclo siguiente, aunque tarde). Se
   investigó la causa real (no se forzó un rojo artificial): sin ese
   chequeo, el efecto observable no es una reinvocación sino un **timer
   huérfano** que queda armado hasta `idleIntervalMs` después de que
   `stop()` ya resolvió -- riesgo real para un shutdown que espera a que
   el event loop se vacíe. Reescrita la aserción para medir
   `vi.getTimerCount()` inmediatamente después de `stop()` (no después de
   dejar que el huérfano dispare y se autolimpie) → **1 test en rojo**,
   ahora sí discrimina.
3. Mover el incremento de generación de `stop()` a después del primer
   `await` → **1 test en rojo** (el mismo de Hallazgo 3, misma causa: la
   carrera que el incremento síncrono existe para cerrar).
4. Hacer inmediato el primer tick (`scheduleNext(gen, 0)` en `start()`) →
   **3 tests en rojo** (los que verifican el arranque diferido).

**Verificación:**
- `npx tsc --noEmit` → limpio.
- `npm run lint:arch` → limpio, 295 módulos / 1396 deps (294→295: +1 por
  `adaptive-poller.ts`; 1393→1396: +3 aristas —
  `company-sync.worker.ts → adaptive-poller.ts`,
  `company-catalog.service.ts → company-sync.registry.ts`,
  `adaptive-poller.test.ts → adaptive-poller.ts`).
- `npx eslint --max-warnings 0` sobre los 8 archivos tocados → limpio.
- `npm run test` → **2068 passed** (baseline 2049 + 19 nuevos: 12 del
  helper, 4 de `company-sync.worker.test.ts`, 2 de
  `company-sync.registry.test.ts`, 1 de `company-catalog.service.test.ts`),
  161 archivos (+1), 1 skipped, 1 todo -- sin regresiones.
- Repetido el grep de `setInterval` en `src/`: **2** ocurrencias reales
  (`outbox.worker.ts`, `reservation-hold-expiry.worker.ts`) + el helper
  ya no usa `setInterval` (usa `setTimeout` autoreprogramado) -- coincide
  con lo que el gate esperaba ("ahora 2 + el helper").

**DEFENSIVE_DEVELOPING §2/§3 (para el mensaje de commit):**
- §2 -- ¿qué límite/config del sistema toca? Cadencia de polling de un
  worker de plataforma (10s activo / 10min idle, antes fijo 10s). No
  verificado contra el autosuspend real de Neon (declarado como
  inferido en §6); sí verificado que no rompe ningún contrato de datos.
  ¿Cambia una firma pública? Sí -- `CompanyCatalogPropagationWorker.stop()`
  (`void` → `Promise<void>`) y `.poll()` (`Promise<void>` →
  `Promise<boolean>`); los 2 call sites de producción
  (`company-sync.registry.ts`) y todos los tests que los usan quedaron
  actualizados en este mismo commit. ¿Agrega una forma nueva de hacer
  algo que ya existía? Sí, a propósito y declarado: coexistencia
  transitoria de `AdaptivePoller` (1 worker) junto a `setInterval` fijo
  (2 workers), hasta que los bloques de `OutboxWorker`/
  `ReservationHoldExpiryWorker` tengan su propio gate.
- §3 -- no toca `req.db`/`getPlatformRawPool()`/`TransactionManager`. El
  helper no recibe ni pool ni `SqlClient`, solo `() => Promise<boolean>`
  y números -- verificado en el propio código, no solo declarado.

**Estado: LOCAL, sin pushear ni deployar.** Sin cambio de schema.

## 8. Reporte pendiente para la próxima ronda del gate

1. Esta decisión de wake() del dueño (§1) — cerrada.
2. La pregunta abierta de §3.3 (dirección de dependencia del wake bus) —
   pide decisión del gate antes de escribir código.
3. Confirmación de que no apareció una sexta ubicación de polling fuera
   de las 3 conocidas (repetir el grep de `setInterval` en `src/` al
   momento de implementar, por si algo cambió desde la ronda 1).
4. Cuando el código esté escrito: diff, mutation testing por worker
   (incluida la variante de `ReservationHoldExpiryWorker`, que no es
   binaria), y DEFENSIVE_DEVELOPING §2/§3 en el mensaje de commit.
