# Recomendaciones técnicas — infraestructura y motor de reservas

> Documento vivo. Segunda opinión externa (25/08/2026, "Recomendaciones
> técnicas — app-main", traída por el dueño) más lo que se verificó/
> encontró al empezar a ejecutarla. No son cambios urgentes en su
> mayoría — es una lista para priorizar con el developer. Los hallazgos
> de las secciones 3 y 4 (bugs reales en producción) quedaron resueltos
> en una sesión de continuidad el mismo día — ver "Estado" al final.

Última actualización: 2026-08-25.

## 1. Observabilidad e infraestructura (documento original, sin tocar)

### 1.1 Logging estructurado — Pino — ✅ RESUELTO (25/08/2026)
Instalados `pino` + `pino-http` (+ `pino-pretty` como devDependency, solo
para consola local — en producción sale JSON de una línea, lo que espera
cualquier agregador de logs). Nuevo `src/logger.ts`, único punto de
creación de la instancia (mismo criterio que `sslConfig()` en
`db/pg.client.ts`). `pino-http` montado en `app.ts` como paso 2 (justo
después de `trust proxy`, antes de helmet/rate-limit) — loguea cada
request/response con `req.id` autogenerado para correlación.

**Alcance del reemplazo:** los 110 usos reales de `console.log/error/warn`
en `src/` (no 93 — recontado 25/08/2026) se dividían en dos grupos.
47 viven en `src/scripts/*.ts` (CLI corridos a mano por un humano que lee
la terminal — `encrypt-database-url.ts`, `concurrency-test-reservations.ts`,
`migrate-tenants.ts`) y quedaron **a propósito sin tocar**: no corren
dentro del proceso del servidor, `console.log` ahí es la herramienta
correcta, no una omisión. Los otros 63, en 20 archivos que sí corren en
el proceso real (workers, middlewares, `app.ts`/`server.ts`,
`container.ts`, rutas de plataforma, `email.sender.ts`, `pg.client.ts`,
etc.), se reemplazaron todos por `logger.info/warn/error` con campos
estructurados (`businessId`, `err`, `eventId`, etc. como objeto, nunca
interpolados en el string). Las 2-3 ocurrencias de `console.log` que
aparecían DENTRO de un string (mensajes de ayuda tipo `"Generá una con:
node -e \"console.log(...)\""`) se dejaron intactas, no son logging real.

**Tests rotos por el cambio — arreglados:** 3 tests
(`tenant.middleware.test.ts` ×2, `company-sync.worker.test.ts`,
`email.sender.test.ts`) espiaban `console.warn`/`console.error`
directamente. `tenant.middleware.test.ts` hace `vi.resetModules()` +
`await import(...)` en cada test — un `vi.spyOn(logger, ...)` normal no
sobrevive a eso (el reimport crea una instancia de `logger.js` nueva); se
resolvió con `vi.mock('../logger.js', ...)`, que sí persiste. Los otros
dos, con import estático simple, solo necesitaron apuntar el spy a
`logger` en vez de `console`. Suite completa: 1493/1493.

**Verificado además contra el proceso real:** `npm run build` +
`node dist/server.js` local — la salida pretty-printed confirma formato
coloreado, correlación por línea y, en el catch de la migración fallida
(sin Postgres local corriendo), el error serializado completo (stack +
`AggregateError` con sus causas anidadas) en vez de un `console.error`
plano.

### 1.2 Error tracking — Sentry — ✅ RESUELTO (25/08/2026)
Cuenta creada por el dueño, DSN provisto en el chat. Instalado
`@sentry/node`. `src/instrument.ts` (nuevo) llama a `Sentry.init()` y se
importa como PRIMERA línea de `server.ts` — Sentry instrumenta paquetes
CommonJS (express, pg) enganchándose al cache de `require()`, necesita
correr antes de que algo más los importe. `app.ts` monta
`Sentry.setupExpressErrorHandler(app, { shouldHandleError })` justo antes
del `errorHandler` propio, con un filtro que excluye `DomainError`/
`ValidationError`/`ZodError` — esos ya se mapean a su status HTTP correcto
en `error.middleware.ts`, no son bugs; sin el filtro, Sentry se llenaría
de "ruido" (404 NOT_FOUND, 400 VALIDATION_ERROR) y taparía los 500
genuinos. `main().catch()` y el catch de la migración de
`platform.schema.sql` en `server.ts` también capturan y hacen `flush()`
antes de `process.exit(1)` — un fallo al arrancar es justamente el caso
que más urge ver en Sentry.

**DSN — no es secreto pero no se hardcodea:** `SENTRY_DSN` agregada a
`render.yaml` con `sync: false` (mismo criterio que `GOOGLE_CLIENT_ID`).
Sin la variable, `Sentry.init({dsn: undefined})` queda en no-op — el
proceso arranca igual, fail-open a propósito. Falta que el dueño la
pegue en el dashboard de Render.

**Verificado:** build + lint + suite completa (1493/1493) sin romper
nada. Verificación end-to-end real: script standalone con el DSN
provisto, `Sentry.captureException()` + `await Sentry.flush(5000)` →
`true` (el evento se mandó y confirmó contra el ingest de Sentry).

### 1.3 CI — ✅ RESUELTO (25/08/2026) — el diagnóstico original estaba desactualizado
El documento decía que había dos workflows (uno funcional, uno
`noop` placeholder) y que "no se ve un job de typecheck ni de lint
corriendo". **Verificado contra `.github/workflows/`, 25/08/2026:**
- Hay 4 workflows, no 2: `ci.yml`, `a.yml`, `lint-autofix.yml`,
  `pr-checklist.yml`.
- `ci.yml` **ya corre 4 jobs en cada push/PR a main**: tests+coverage,
  typecheck (`npm run build`), lint (`npm run lint`), y un chequeo de
  que `CURRENT_SCHEMA_VERSION` se haya bumpeado si `schema.sql` cambió.
  El `README.md` no mentía.
- `a.yml` es un placeholder inerte (`workflow_dispatch`, nunca corre
  solo) y `lint-autofix.yml` es una herramienta manual de un solo uso
  que su propio comentario dice borrar después de correrla. Ninguno de
  los dos compite con `ci.yml` ni deja huecos de validación.

**Conclusión: el punto 1.3 tal como estaba planteado no aplicaba.** Lo
único real que quedaba era housekeeping cosmético — **hecho**: se
borraron `a.yml` y `lint-autofix.yml` (25/08/2026). `ci.yml` sigue
siendo el único workflow real, sin cambios.

### 1.4 Redis para rate-limiting
`auth.routes.ts` ya tiene el comentario propio "Para multi-instancia
reemplazar por un store Redis" (**verificado, cita exacta**). No urgente
con la escala actual (un tenant, una instancia). Requiere una cuenta
externa (Upstash u otro) — igual que Sentry, lo tiene que dar de alta el
dueño.

### 1.5 BullMQ para workers
Sin tocar — el outbox worker actual está bien diseñado. Dejar para
cuando haga falta cron/prioridades/backoff más sofisticado.

### 1.6 Cobertura de validación con Zod
31 de 237 archivos de código importan Zod (**verificado, el documento
decía 32 — diferencia despreciable**).

**Auditoría completa hecha (25/08/2026)** — recorridas las 34 rutas
(`*.routes.ts`). La mayoría de los `POST /:id/accion` sin body (confirmar,
cancelar, completar, etc.) están bien: no hay nada que validar más allá
del `:id`, que ya resuelve a 404 si no existe. Gaps reales encontrados,
por severidad:

- **Nivel 1 — sin ninguna validación, `req.body` directo a SQL — ✅
  RESUELTO (25/08/2026).** `POST /api/products`, `PUT /api/products/:id`,
  `POST /api/products/:id/variants`, `PUT /api/products/:id/variants/:variantId`.
  Antes llegaba crudo hasta `sql.product.repository.ts::create()` — sin
  chequeo de tipo ni de presencia, contraste directo con las rutas
  hermanas `/recipe-items` del mismo archivo, que sí usaban
  `CreateRecipeItemSchema.parse()`. Agregado `src/api/schemas/product.schemas.ts`
  (`CreateProductSchema`/`UpdateProductSchema`/`CreateProductVariantSchema`/
  `UpdateProductVariantSchema`), límites 1:1 con las columnas reales
  (`VARCHAR(255)`, `CHECK base_price >= 0`, `CHECK assemble_on_demand =
  FALSE OR product_type = 'COMPOSITE'`, etc.). `CreateProductSchema` usa
  `superRefine` porque `name`/`basePrice` son obligatorios solo cuando
  NO viene `companyProductId` (el alta vinculada a una empresa copia esos
  datos del maestro, el cliente no los manda). 6 tests nuevos en
  `products.routes.test.ts` (antes 36, ahora 42) cubriendo los 400 que
  antes no existían. Verificado además contra el backend real corriendo
  (`biz-demo-01`): `POST /api/products` sin `name`/`basePrice` → 400 con
  el mensaje de cada campo; `basePrice: -5` → 400; producto válido → 201,
  cancelado después (dato de prueba).
- **Nivel 2 — query params de fecha/número sin validar, `new
  Date(undefined)`/`Number('abc')` en silencio — ✅ RESUELTO (25/08/2026).**
  Clasificadas las ~25 rutas GET/DELETE originalmente marcadas por el
  audit; la mayoría (`audit-log.routes.ts`, `customer.routes.ts /me`,
  `accounts-receivable.routes.ts`, `customers.routes.ts` ×2,
  `invoices.routes.ts`, `platform.routes.ts /businesses`,
  `products.routes.ts GET /`, `bookable-services.routes.ts
  /available-slots`) ya tenían guardas manuales (`typeof`, regex,
  presencia) que devuelven 400 correctamente — falsos positivos del
  regex del audit, sin tocar (inconsistencia de estilo nomás, no un bug).
  Gaps reales, arreglados: `reports.routes.ts` (11 rutas, todas
  compartían el mismo `req.query as {from, to}` → `new Date(from)`
  directo), `orders.routes.ts GET /`, `reservations.routes.ts GET /`
  (`from`/`to` sin validar + `page`/`limit` con `Number()` sin chequear
  NaN) y `cash-register.routes.ts GET /` (mismo problema de NaN en
  `limit`/`offset`). Agregado `dateOnlySchema`/`DATE_ONLY_REGEX` a
  `common.schemas.ts` (valida formato Y que la fecha exista de verdad —
  rechaza `2026-02-30`, que `new Date()` acepta corriéndose al 2 de
  marzo) y `src/api/schemas/report.schemas.ts` con
  `DateRangeQuerySchema`/`OccupancySummaryQuerySchema`/
  `UnderutilizedQuerySchema`/`PurgeQuerySchema`. `orders`/`reservations`
  usan `z.string().datetime()` en vez de `dateOnlySchema` — esos
  filtros son sobre timestamps de reserva/orden, no días de negocio
  calendario como los reportes. 6 tests 400 nuevos (uno por archivo
  tocado + un caso de fecha calendario inválida en reports). Suite
  completa: 1493/1493.
  **Sin tocar a propósito:** `housekeeping.routes.ts` (`GET /` y
  `/late-checkouts`) — su `date` ya viene validado con regex pero
  deliberadamente NO se envuelve en `Date` (bug de zona horaria ya
  encontrado y arreglado antes de esta sesión, ver nota en el propio
  archivo); envolverlo en un schema que devuelva `Date` reintroduciría
  ese bug. `POST /:id/complete` (housekeeping) y `PATCH /:id/notes`
  (orders) siguen con `req.body.x as string` sin Zod; `POST
  /:id/stock/decrement` (×2, products) sigue validando `quantity` a
  mano — funciona, solo es inconsistente de estilo, no un gap real.

### 1.7 Higiene menor
**`ts-prune` → `knip` — ✅ RESUELTO (25/08/2026).** Reemplazado como
devDependency (`npm run deadcode`), con `knip.json` mínimo (declara
`src/scripts/*.ts` y `.puppeteerrc.cjs` como entry points — si no,
`knip` los marca "unused file" por no ser importados por nadie, son
scripts que se invocan directo). Confirmado el "95% falsos positivos"
que reportaba `auditoria-modularidad.md` para `ts-prune`: la primera
corrida de `knip` sin ese `entry` marcó como "no usado" el propio
script de concurrencia que se acababa de escribir y usar. Con el
`entry` declarado, la lista bajó a algo revisable: 2 devDependencies
sin uso (`dependency-cruiser`, `jscpd` — herramientas de auditorías
puntuales anteriores, no se borraron: siguen siendo válidas para la
próxima auditoría de modularidad), 1 dependencia no listada
(`puppeteer`, usada solo por `.puppeteerrc.cjs`), y ~42 exports/tipos
sin uso externo. **No se tocó ninguno de los 42** — es trabajo de
limpieza de código, no de tooling, y no era lo que pedía este punto;
queda para una pasada aparte si se decide hacerla.

Duplicación 2.16% backend (no prioridad) vs. 7.71% frontend (ahí rinde
más el DRY) — sin tocar, dato del documento original.

## 2. Auditoría del motor de reservas — plan original

Punto de partida: ya existe `SELECT ... FOR UPDATE` con tests dedicados
(`resource-lock.service.test.ts`, `sql.resource-lock.repository.test.ts`,
**verificados, existen**). Orden sugerido: 2.1 coverage → 2.2 concurrencia
real → 2.3 auditoría de máquina de estados → 2.4 property-based testing
con `fast-check`.

## 3. Lo que se encontró al ejecutar 2.1 + 2.2 — ⚠️ BUG REAL

### 3.1 Coverage (2.1) — el mapa de riesgo señaló el lugar exacto

`npx vitest run --coverage` escopeado a `src/reservas/`:

- `reservation.service.ts` (818 líneas): **98% cubierto.** Los dos huecos
  son triviales (un getter de una línea, la rama "no encontrado" de un
  helper privado) — no priorizar.
- `reservation-availability.service.ts` (368 líneas): **84.7% cubierto —
  pero el hueco es exactamente el método que previene el doble-booking.**
  `resolveOccupyingReservations()` tiene una rama con lock
  (`getActiveForResourceInRangeWithLock`, usada dentro de
  `transactionManager.run()`) y un fallback sin lock. **La rama con lock
  nunca se ejecuta en los 274 tests de `src/reservas/`** — no por
  descuido: el propio comentario en `reservation.service.ts:37` lo dice
  ("fallback sin lock si el repositorio no lo implementa, **como los
  mocks en tests**"). Los mocks de test deliberadamente no implementan
  los métodos `...WithLock`.

Esto ya era la señal: un test unitario con mocks estructuralmente no
puede probar si el lock real serializa bajo concurrencia. Hacía falta
2.2, no como buena práctica sino como la única forma de ejercitar ese
código.

### 3.2 Test de concurrencia real (2.2) — reprodujo el doble-booking

Script nuevo: `src/scripts/concurrency-test-reservations.ts`
(`autocannon`, agregado como devDependency). Dispara N `POST
/api/reservations` simultáneos reales contra el mismo recurso + mismo
rango horario y cuenta cuántos ganan.

**Resultado contra el backend local real (`biz-demo-01`), 3 corridas
distintas:**
- Corrida 1 (20 conexiones, recurso Habitación 01, rango 2026-11-23
  10:00-11:00 UTC): **3 reservas creadas** para el mismo recurso/rango
  exacto (`reservationNumber` 35, 50, 32).
- Corrida 2 (20 conexiones, mismo recurso, rango 2027-03-13 10:00-11:00
  UTC): **3 reservas creadas** de nuevo (`reservationNumber` 63, 61, 65).
- Corrida 3 (8 conexiones, rango 2028-01-07 10:00-11:00 UTC): **3
  reservas creadas** (`reservationNumber` 130, 131, 134), más 5 de 8
  requests devolviendo `500` en vez de `400`/`201` — probablemente
  Postgres tirando un error de serialización bajo contención real que el
  código no captura explícitamente. Anotado, no investigado a fondo —
  secundario al hallazgo principal.
- Una corrida con solo 5 conexiones sí sirvió como control: 1×`201` +
  4×`400`, sin duplicados — con menos concurrencia real, la ventana de
  carrera es más chica y a veces no se dispara. Esto es consistente con
  la causa raíz de abajo, no la contradice.

Las 9 reservas duplicadas de prueba se cancelaron después de cada
corrida (no quedó nada activo en `biz-demo-01`).

### 3.3 Causa raíz, confirmada en el código

`sql.reservation.repository.ts::getActiveInRange()`:

```sql
WHERE r.resource_id = $1 AND r.status = ANY($4)
  AND r.start_time < $3 AND r.end_time > $2
FOR UPDATE
```

`FOR UPDATE` bloquea **filas que ya existen** hasta el COMMIT de quien
las tiene lockeadas. Cuando el hueco está libre (el caso normal — nadie
reservó ahí todavía), esta consulta devuelve **0 filas**, y `FOR UPDATE`
sobre un resultado vacío no bloquea nada en absoluto. Transacciones
concurrentes corren el mismo SELECT en la misma ventana, todas ven "0
conflictos", todas insertan. Es el gotcha clásico de Postgres:
`SELECT ... FOR UPDATE` sirve para serializar *modificaciones* a filas
existentes, no para prevenir *inserciones* nuevas que compiten por un
mismo hueco.

**Sin backstop a nivel de base de datos** — `schema.sql` (tabla
`reservations`) no tiene ninguna constraint `EXCLUDE`/`UNIQUE` que
impida el solapamiento. La única protección hoy es este `FOR UPDATE`,
que no cubre el caso de hueco vacío.

### 3.4 Opciones de arreglo (sin decidir todavía — para charlar con el developer)

1. **Constraint `EXCLUDE` en Postgres (recomendado)** — con extensión
   `btree_gist`:
   `EXCLUDE USING gist (resource_id WITH =, tstzrange(start_time, end_time) WITH &&) WHERE (status IN ('PENDING','CONFIRMED'))`.
   Blindaje real a nivel de base, no depende de que el código de
   aplicación acierte siempre en every call site presente y futuro. Es
   un cambio de schema: requiere bump de `CURRENT_SCHEMA_VERSION`, pasar
   por la skill `criterios-negocio` (`reservations` ya es TRANSACCIÓN),
   y probar contra `biz-demo-01` antes de dar por cerrado.
2. **Advisory lock por `resourceId`** —
   `pg_advisory_xact_lock(hashtext(resourceId))` antes del SELECT,
   dentro de `transactionManager.run()`. Cambio más chico, sin tocar
   schema — pero sigue siendo disciplina de código: cualquier caller
   nuevo que arme una reserva por otro camino y se olvide del lock
   reabre el mismo hueco.
3. **No arreglar hoy, solo documentar** — opción elegida por el dueño en
   esta sesión (25/08/2026). Retomar cuando se defina el approach con el
   developer.

## 4. Auditoría de máquina de estados (2.3) — ⚠️ SEGUNDO BUG REAL, misma familia

### 4.1 El grafo de transiciones en sí está bien

`Reservation.ts::ALLOWED_TRANSITIONS` — `PENDING → {CONFIRMED, CANCELLED,
EXPIRED}`, `CONFIRMED → {CANCELLED, COMPLETED}`, `CANCELLED`/`COMPLETED`/
`EXPIRED` terminales sin salida. Ciclo de vida estándar de reservas, sin
huecos ni transiciones espurias — `transitionTo()` lo hace cumplir de
forma centralizada, no hay ningún lugar del código que mute `_status`
por afuera de ese método (`Reservation.restore()` reconstruye desde
persistencia sin pasar por ahí, a propósito, es el único escape y está
documentado como tal).

### 4.2 El problema no es el grafo — es el mismo gotcha de concurrencia de la sección 3, en el UPDATE en vez del INSERT

`confirmReservation()`, `cancelReservation()`, `completeReservation()` y
`confirmPriceAdjustment()` (`reservation.service.ts`), más
`ReservationHoldExpiryWorker.expireOne()`, comparten el mismo patrón:

```
const reservation = await this.reservationRepository.getById(id);  // SELECT sin lock
reservation.confirm();                                              // muta en memoria
await this.transactionManager.run(async (client) => {
  await this.reservationRepository.saveWithClient(client, reservation); // UPSERT ciego
});
```

`getById()` es un `SELECT` liso — nunca `FOR UPDATE`. `saveWithClient()`
es un `INSERT ... ON CONFLICT DO UPDATE` sobre TODAS las columnas del
objeto en memoria, sin `WHERE status = $esperado` ni columna de versión
— no detecta si la fila cambió entre el `SELECT` y el `UPDATE`, la
pisa entera. `FOR UPDATE` en este código **solo se usa** para las
consultas de disponibilidad (`getActiveForResourceInRangeWithLock`,
sección 3) — nunca para leer-antes-de-mutar una reserva puntual.
`ReservationHoldExpiryWorker.expireOne()` ya vuelve a leer el estado
DENTRO de su transacción para no confiar en el `SELECT` viejo del
`poll()` (comentario explícito: "Puede haberse cobrado/cancelado entre
el SELECT del poll y acá") — pero esa relectura tampoco usa `FOR
UPDATE`, así que solo protege contra staleness *secuencial*, no contra
una transacción de verdad concurrente que lee la misma fila al mismo
tiempo.

### 4.3 Escenario concreto

Depósito con vencimiento (`depositDueBy`) justo en el borde:

1. `ReservationHoldExpiryWorker` lee la reserva `PENDING`, ve que el
   depósito no está pagado todavía (`paidSoFar < depositAmount`).
2. Al mismo instante, el huésped termina de pagar y confirma —
   `confirmReservation()` lee la MISMA fila (`PENDING`, aún no expirada).
3. Las dos transacciones commitean en cualquier orden. Si gana el
   worker: la reserva queda `EXPIRED` pese a estar pagada y confirmada
   — la disponibilidad ya pudo haberse marcado ocupada
   (`recordOccupancy()`) antes de que el worker pisara el estado.
4. Caso más simple, sin depósito de por medio: doble clic en
   "Cancelar" (o un reintento de red) dispara dos `cancelReservation()`
   casi simultáneos. Cada uno lee `CONFIRMED`, cada uno pasa la
   validación de transición (las dos ven el mismo estado de origen
   válido), cada uno inserta su propio evento `reservation.cancelled`
   — dos filas en `domain_events`, dos disparos de efectos secundarios
   por una sola acción del usuario.

### 4.4 Consecuencias reales — no todas iguales de graves

- **Pérdida silenciosa de la transición "correcta"** (el caso worker vs.
  confirmación): sin ningún error, sin nada en los logs — la reserva
  queda en el estado que ganó la carrera, no el que reflejaba la
  realidad de negocio.
- **Eventos duplicados no siempre son inofensivos.** `voidByReservationId`
  (`financial-transaction.repository.ts`) SÍ es idempotente (`WHERE
  status IN ('PENDING','SETTLED')` — voidear una fila ya `VOIDED` es un
  no-op) — un doble `reservation.cancelled` no duplica el void. Pero
  `handleReservationConfirmed` arma su `idempotencyKey` como
  `` `${event.id}:CHARGE` `` — **incluye el id del evento**, no el id de
  la reserva. Dos `confirmReservation()` concurrentes generan DOS filas
  distintas en `domain_events` (dos `event.id` distintos), así que la
  dedup por `idempotencyKey` no los agarra: un doble-confirm bajo
  carrera puede terminar creando **dos CHARGE** para la misma reserva,
  no uno.

### 4.5 Opciones de arreglo (mismo criterio que la sección 3 — sin decidir, para charlar con el developer)

1. **`SELECT ... FOR UPDATE` en `getById()` cuando se lee para mutar** —
   requiere una variante con lock (mismo patrón `...WithLock` que ya
   existe para disponibilidad) y que cada transición la use dentro de
   `transactionManager.run()` (hoy el `SELECT` pasa ANTES de abrir la
   transacción en los cuatro métodos de `reservation.service.ts` —
   habría que mover el `getById` adentro). Cambio de forma, no de
   schema.
2. **Compare-and-swap explícito** — `UPDATE reservations SET status =
   $nuevo WHERE id = $id AND status = $esperado RETURNING *`; si
   `rowCount = 0`, la transición se perdió la carrera y hay que
   rechazarla con un error claro (`INVALID_RESERVATION_CONFLICT`, ya
   existe el code) en vez de pisar en silencio. No requiere lock
   explícito, más simple que la opción 1, pero significa reescribir
   `saveWithClient()` para que la transición-de-estado sea un UPDATE
   angosto (columna por columna) en vez del UPSERT genérico actual que
   graba el objeto entero.
3. **`idempotencyKey` de `handleReservationConfirmed` con el id de la
   reserva, no el del evento** (parche puntual, más chico, no arregla el
   lost-update de `status` en sí, solo el riesgo de doble CHARGE) —
   `` `${reservationId}:CHARGE` `` en vez de `` `${event.id}:CHARGE` ``.
4. **No arreglar hoy, solo documentar** — mismo criterio que la sección
   3, a confirmar con el dueño.

## 5. Property-based testing (2.4) — `fast-check`

### 5.1 Qué se probó

`availability.ts` es la lógica pura de disponibilidad (sin BD, sin
tiempo real) que sí está en el camino caliente de reservar
(`ReservationAvailabilityService.checkAvailability()` la reusa vía
`isBlockingStatus`/`hasTimeOverlap`). Ya tenía 19 tests con ejemplos a
mano (`availability.test.ts`) — se sumó `availability.property.test.ts`
(nuevo, `fast-check` como devDependency) con 13 propiedades que generan
cientos de rangos de fecha y listas de reservas al azar por corrida, en
vez de los casos puntuales que se nos ocurrieron:

- `hasTimeOverlap`: simetría, reflexividad (todo rango se solapa
  consigo mismo), semiabierto (dos rangos consecutivos NUNCA se
  solapan), equivale a la definición directa (`!(aEnd<=bStart ||
  bEnd<=aStart)`), monotonía (ensanchar un rango que ya se solapaba no
  puede dejar de solaparse).
- `assertValidTimeRange`: nunca lanza para `start<end`, siempre lanza
  para `start>=end`.
- `isResourceAvailable`: sin reservas activas siempre disponible;
  reservas de OTRO `resourceId` nunca afectan; `CANCELLED`/
  `COMPLETED`/`EXPIRED` nunca bloquean sin importar el solapamiento;
  `PENDING`/`CONFIRMED` con el rango exacto siempre bloquean;
  `excludeReservationId` libera exactamente esa reserva y ninguna otra;
  y una propiedad "espejo" que recalcula el resultado esperado a mano
  contra listas de reservas generadas al azar (mezcla de estados,
  ids, solapamientos parciales) y lo compara contra el resultado real.

**Resultado: las 13 propiedades pasan.** El motor de solapamiento en sí
—la aritmética de fechas y el filtro por estado— está bien: no salió
ningún caso límite nuevo (fechas exactamente iguales, rangos de 1
minuto, offsets grandes, mezclas de estados bloqueantes/no bloqueantes
en la misma lista). Esto acota el problema real del motor de reservas a
lo ya encontrado en las secciones 3 y 4 — la capa pura de disponibilidad
no es la fuente del bug de concurrencia, es la capa de acceso a datos
(falta de lock/CAS) la que lo introduce después.

### 5.2 Hallazgo colateral — `capacity`/`availableSlots()` no está conectado a nada — ✅ RESUELTO (25/08/2026, sesión de continuidad, "Bug 1")

Al armar los generadores para las propiedades de arriba se encontró que
`PhysicalResource.availableSlots()` (pensado para recursos con
`capacity > 1` — "clases grupales, tours", docblock del propio método)
**no tiene ningún call site en el código real**, solo se referencia a
sí mismo en su propio comentario. Se confirmó revisando
`ReservationAvailabilityService.checkAvailability()`
(`reservation-availability.service.ts`, el chequeo real que usa
`ReservationService.createReservation()`): es binario — "¿hay
CUALQUIER reserva activa que se solape?" — sin mirar `partySize` ni
`capacity` en ningún punto. En la práctica, hoy un recurso con
`capacity > 1` (una clase de yoga para 20 personas, un tour) se
comporta exactamente igual que uno con `capacity = 1`: la primera
reserva que se solapa con un rango lo marca "no disponible" para
cualquier otra, aunque queden 19 lugares libres.

`capacity` SÍ se usa en un solo lugar — la validación de
`Reservation`'s constructor (`partySize > resource.capacity` rechaza al
crear una reserva individual demasiado grande) — pero nada agrega los
`partySize` de las reservas YA activas contra el `capacity` total del
recurso al decidir si hay lugar para una más.

**No es parte de los bugs de concurrencia de las secciones 3/4** — era
un gap funcional distinto (¿el negocio realmente necesita reservas
grupales con cupo parcial, o `capacity > 1` es un campo que existe en
el modelo pero nunca se terminó de cablear al flujo de reserva?). El
dueño confirmó que sí hace falta (recursos exclusivos vs. cupo
compartido, decisión de negocio explícita) y se implementó en la misma
sesión de continuidad que las secciones 3/4 — ver `pendientes-2026-08-25.md`,
sección "Bug 1 — cupo compartido", para el detalle completo (incluye un
bug prerequisito encontrado de paso: `capacity`/`description` nunca se
persistían en `SqlResourceRepository`). El bug menor de `availableSlots()`
que este párrafo señalaba (contaba `EXPIRED`/`COMPLETED` como "todavía
ocupando", inconsistente con `isBlockingStatus()`) quedó corregido como
parte del mismo fix.

## Estado

- Sección 1: 1.1 (Pino), 1.2 (Sentry), 1.3 (CI, era diagnóstico
  desactualizado), 1.6 (Zod niveles 1 y 2) y 1.7 (knip) resueltas
  (25/08/2026). Quedan sin empezar 1.4 (Redis rate-limiting — no urgente
  con la escala actual, requiere cuenta externa) y 1.5 (BullMQ —
  deferred a propósito).
- Sección 2 (auditoría del motor de reservas): 2.1, 2.2, 2.3 y 2.4
  hechas (25/08/2026). 2.1/2.2/2.3 derivaron en los hallazgos de
  concurrencia de las secciones 3 y 4; 2.4 (property-based testing,
  `fast-check`, 13 propiedades sobre `availability.ts`) confirmó que la
  capa pura de solapamiento está bien — el problema es de acceso a
  datos, no de esta lógica — y de paso encontró que `capacity`/
  `availableSlots()` (reservas grupales con cupo parcial) no está
  conectado a ningún flujo real de reserva (sección 5.2, gap de
  producto, no bug de concurrencia).
- Sección 3 (bug de doble-booking, INSERT sin lock efectivo) — **✅
  RESUELTO (25/08/2026, sesión de continuidad)**. Fix elegido:
  `ResourceRepository.lockByIds()` (lock de fila en `resources`, ordenado
  por id) en `ReservationAvailabilityService.assertAllResourcesAvailable()`,
  más EXCLUDE constraint de respaldo (`reservations_no_overlap_exclusive`)
  solo para recursos exclusivos (`resource_categories.is_exclusive`,
  columna nueva, desacoplada de `is_lodging` a pedido explícito del
  dueño). Detalle completo, decisiones de negocio y verificación:
  `pendientes-2026-08-25.md`, sección "Bug real: doble-booking bajo
  concurrencia".
- Sección 4 (lost-update en transiciones de estado, misma familia que la
  3 pero en el UPDATE) — **✅ RESUELTO (25/08/2026, misma sesión)**.
  `ReservationRepository.getByIdWithLock()` + lectura/mutación movida
  adentro de la transacción en `confirmReservation()`/`cancelReservation()`/
  `completeReservation()`/`confirmPriceAdjustment()`/
  `ReservationHoldExpiryWorker.expireOne()`. Detalle en
  `pendientes-2026-08-25.md`, sección "Bug 3 — lost update en
  transiciones de estado".
- Script `src/scripts/concurrency-test-reservations.ts` sigue en el
  repo (sin volver a correrlo con autocannon esta sesión — la
  verificación se hizo con la suite de integración real, ver más abajo).
  No cubre el hallazgo de la sección 4 (dispara `POST /reservations` en
  paralelo, no confirmaciones/cancelaciones concurrentes sobre la misma
  reserva) — si hace falta un script de carga real para la 4, es aparte.
- **Verificación real de ambos fixes**, contra Postgres real (no solo
  mocks/in-memory): `src/tests/integration/reservation.service.integration.test.ts`,
  18/18 tests verdes — incluye un test nuevo de 10 `createReservation()`
  concurrentes sobre el mismo slot (exactamente 1 éxito) y 2 tests nuevos
  del EXCLUDE constraint. De paso se encontraron y corrigieron 2 bugs sin
  relación que bloqueaban CUALQUIER test de integración en este repo
  (nunca se habían corrido con `TEST_DATABASE_URL` antes): orden de
  statements en `schema.sql` (`products` referenciado ~200 líneas antes
  de crearse — rompía el alta de un negocio nuevo desde cero) y
  `location_id`/`deposit_amount` faltantes en los helpers de seed de
  test. Detalle completo en `pendientes-2026-08-25.md`.
