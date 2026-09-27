# Diseño v6 — bloqueo de check-in antes de la fecha de inicio de la reserva (27/09/2026)

**v6 sobre v5.** El gate sobre v5 confirmó las 6 verificaciones pedidas
(alcance reducido coherente, aritmética de los casos 4/5, matriz de
tests de 17+3+2, seguridad de unificar el reloj, sin RBAC/schema/rutas,
firmas de los helpers) y encontró un hallazgo nuevo: `qualifiesForDateComparison()`
de J1-TZ excluye explícitamente `bookingMode='slot'` de la lógica de
marca-vs-instante — este guard nuevo NO lo hacía, así que un servicio
`slot` sobre un recurso de alojamiento a exactamente las 21:00 hora
Argentina quedaría mal interpretado como marca del día siguiente.
Medido contra Neon real (autorización de lectura vigente, 27/09/2026):
**0 reservas de alojamiento+slot en producción hoy** — caso teórico, no
real todavía. Decisión del dueño (`AskUserQuestion`): **aceptar que la
marca gane también para `slot`** — sin dependencia nueva en
`StayService` (no hace falta inyectar un repositorio de servicios),
registrado como residuo conocido, cruzado con J1-TZ (C1).

**Reemplaza la v4.** Gate sobre v4: HOLD — encontró que el tope superior
(`CheckInAfterDepartureDateError` + `skipDepartureWindowCheck`), tal
como estaba diseñado, o bien quedaba sin ningún consumidor real (si no
se exponía por HTTP) o bien abría una puerta trasera real (si se
exponía: cualquier `FRONT_DESK` podría mandar el flag en un check-in
normal y crear una estadía de una reserva ya vencida, sin ningún
registro — contradice "bloqueo duro, sin override"). Además encontró un
caso mal calculado en el test plan (B1), una matriz de tests incompleta
y mal contada (B3), y dos relojes distintos conviviendo en el mismo
método (B4).

## Decisión del dueño (27/09/2026, `AskUserQuestion`)

**Solo el tope inferior en este bloque.** El tope superior
(`CheckInAfterDepartureDateError`) queda explícitamente fuera de
alcance — se hace en un bloque aparte, como una operación atómica de
"registrar no-show" (crear la Stay y marcarla `NO_SHOW` en una sola
transacción, sin pasar por el `checkIn()` público ni por ningún flag
que viaje en un body HTTP). Esto elimina de raíz el dilema que encontró
el gate: sin tope superior en este bloque, no hay nada que
"saltear" — el registro de no-show tardío sigue funcionando exactamente
igual que hoy (sin ningún guard de fecha), sin regresión y sin puerta
trasera.

## Mecanismo final (reducido)

```ts
// stay.service.ts, importado desde reservas/reservation-time.utils.js
import { deriveCalendarDate, todayInBusinessTimezone } from '../reservas/reservation-time.utils.js';
```

```ts
export class CheckInBeforeArrivalDateError extends DomainError {
  constructor(reservationId: string, startDate: string) {
    super(
      `La reserva ${reservationId} recién puede hacer check-in a partir del ${startDate}.`,
      'CHECK_IN_BEFORE_ARRIVAL_DATE',
    );
  }
}
```

Sin override, bloqueo duro — decisión del dueño ya tomada (27/09/2026).
Sin flag nuevo en `CheckInInput`, sin cambios en `stay.schemas.ts`, sin
cambios en `stays.routes.ts`, sin cambios en RBAC/schema/rutas.

**Corrección H1(a) del gate — la ambigüedad NO desaparece, se resuelve
por política.** La v4 decía "sin ambigüedad" — es impreciso. Un
instante real a las 21:00 hora Argentina sigue siendo indistinguible de
una marca (`isCalendarDateMarker()` no puede diferenciarlos, por
construcción). Lo que cambió es que el dueño decidió (H1 de la ronda
anterior) que, ante esa ambigüedad, **la lectura como marca gana
siempre** — no que la ambigüedad se haya resuelto en el dato. Se
corrige la redacción en todo el documento (era imprecisa en 3 lugares
de la v4).

**Corrección H1(c) del gate — `deriveCalendarDate()` se usa también
sobre `endTime`, no solo `startTime`.** Este documento NO toca el tope
superior (decisión de arriba), así que en este bloque `deriveCalendarDate()`
se usa únicamente sobre `startTime` — la ampliación de su docblock
("solo para `startTime` de una reserva") queda para cuando el bloque
del tope superior se retome, no acá. Se deja registrado para no
olvidarlo.

**C1 (v6) — `slot` NO se excluye acá, a diferencia de J1-TZ, por
decisión del dueño.** `qualifiesForDateComparison()` (J1-TZ,
`reservation-time.utils.ts`) excluye `bookingMode === 'slot'` de la
lógica de marca-vs-instante siempre, incluso sobre un recurso de
alojamiento — este guard de check-in NO reusa esa función (usa
`deriveCalendarDate()` directo, sin distinguir por `bookingMode`,
porque `StayService` no tiene acceso a `categoryRepository`/
`bookableServiceRepository`, ver sección dedicada más abajo). Medido
contra Neon real (27/09/2026): **0 reservas de alojamiento+`slot` en
producción hoy**, en ninguno de los 2 tenants — caso teórico, no real
todavía. Decisión del dueño: aceptar la inconsistencia con J1-TZ como
residuo conocido, sin agregar la dependencia nueva que haría falta para
excluir `slot` acá también. Si en el futuro aparece un caso real
(alojamiento con servicio `slot`, instante exactamente a las 21:00
ART), el síntoma sería: check-in bloqueado ~3 horas la noche de la
llegada, con el mensaje de `CheckInBeforeArrivalDateError` — este
párrafo es la pista para diagnosticarlo rápido si pasa.

## Dónde se evalúa — bajo lock, con `locked.startTime`, un solo reloj (B4)

**Corrección B4 del gate — un solo reloj, no dos.** La línea 274 actual
(`stay.service.ts`) calcula "hoy" para el gating de housekeeping con
`DateTime.now().setZone(businessProfile.timezone).toISODate()!` —
instante REAL del servidor, no el reloj inyectado. Con el guard nuevo
usando `this.now()` por separado, cerca de medianoche los dos podrían
dar días distintos. **Se unifica: la línea 274 pasa a usar
`todayInBusinessTimezone(this.now(), businessProfile.timezone)`** (el
helper que el propio docblock de `deriveCalendarDate()` ya indica usar
para "ahora", J1-TZ) — una sola lectura de reloj para housekeeping Y
para el guard nuevo.

```ts
// stay.service.ts, línea 274 actual — CAMBIA de DateTime.now()... a esto:
const todayBusiness = todayInBusinessTimezone(this.now(), businessProfile.timezone);
// (el resto del gating de housekeeping, líneas 275-286, no cambia -- sigue usando la misma variable `todayBusiness`)
```

```ts
// dentro de la transacción, inmediatamente después de status !== 'CONFIRMED' (líneas 306-308 actuales), antes de Stay.checkIn() (línea 311 actual)
if (locked.status !== 'CONFIRMED') {
  throw new ReservationNotConfirmedError(locked.status);
}

const startDate = deriveCalendarDate(locked.startTime, businessProfile.timezone);
if (todayBusiness < startDate) {
  throw new CheckInBeforeArrivalDateError(input.reservationId, startDate);
}
```

`todayBusiness` (ahora calculado con `this.now()`) se reusa tal cual —
no se recalcula, no se redeclara con otro tipo dentro de la transacción
(la v4 tenía un bug de sombra de variable, corregido acá).

## H3 — reloj inyectable en `StayService` (confirmado seguro por el gate)

```ts
constructor(
  // ... 8 parámetros existentes, sin cambios ...
  private readonly now: () => Date = () => new Date(),
) {}
```

Noveno parámetro opcional, con default real. Confirmado por el gate:
**un solo sitio de construcción en producción**
(`reservations.routes.ts:279`, dentro de `buildStayService()`) — no
cambia. Los 3 callers de esa función (`reservations.routes.ts:804/823/842`)
y `app.ts:496` tampoco cambian.

**C2 (v6) — alcance de "un solo reloj", precisado.** La unificación de
B4 aplica SOLO a las 2 decisiones de fecha dentro de `checkIn()`
(housekeeping + el guard nuevo) — `checkOut()` (`stay.service.ts:395`,
`DateTime.now()` real) y la entidad `Stay` (`stay.ts`, timestamps con
`new Date()` real en sus setters) siguen usando el reloj real a
propósito. No se tocan: los tests existentes de esos 2 caminos
(`stay.service.test.ts:287,526`) comparan timestamps de la entidad
contra un `new Date()` real, y cambiarlos rompería esa comparación sin
ninguna necesidad — el guard nuevo no los usa.

**C3 (v6) — cambio de comportamiento declarado: fail-loud en vez de
fail-open silencioso ante un huso horario inválido.** Antes de este
bloque, la línea 274 usaba `DateTime.now().setZone(tz).toISODate()!` —
con un huso inválido, Luxon da `null` y el `!` lo fuerza a pasar el
tipo; el gating de housekeeping quedaba fail-open en silencio (dejaba
pasar el check-in sin haber evaluado el gate). Con
`todayInBusinessTimezone()` (que hace `throw` ante un huso inválido,
J1-TZ), este caso pasa a fallar visible. El riesgo práctico es nulo (la
API ya valida que el huso sea un nombre IANA real,
`request.schemas.ts:549`, y el default de la base es válido) — se
declara igual, por honest-degradation: es mejor un 500 visible que un
gate de housekeeping silenciosamente salteado.

## Matriz de tests (corregida — B3 del gate, la v4 tenía el conteo mal)

**`stay.service.test.ts` — 17 llamadas reales a `service.checkIn(`,
repartidas en 3 describes distintos (NO 24 en uno solo, como decía la
v4), cada uno con su propio constructor de `StayService`:**

| Describe / constructor | Líneas de `checkIn(` | Fixture |
|---|---|---|
| (constructor línea 205) | 229, 240, 258, 280, 304, 312, 326, 341, 378, 399 | `startTime: 2026-08-13T15:00Z`, `endTime: 2026-08-14T11:00Z` |
| (constructor línea 433, housekeeping) | 480, 492, 504, 515, 527 | mismo fixture |
| (constructor línea 563, horario) | 865, 889 | mismo fixture |

Los 3 constructores ganan un reloj congelado DENTRO de la ventana del
fixture, ej. `() => new Date('2026-08-13T20:00:00Z')` (17:00 hora ART
del 13/08 — mismo día calendario que `startTime`, así que el guard
nuevo permite en los 17 casos, ninguno de los cuales prueba el guard en
sí — eso lo hacen los casos nuevos del test plan).

**`seedTaskForToday()` (línea 456 actual, helper del describe de
housekeeping) usa `DateTime.now()` real, no el reloj inyectado** —
tiene que cambiar a `todayInBusinessTimezone(clock(), tz)` con el MISMO
reloj congelado que recibe el constructor de ese describe (pasado como
parámetro al helper, o leído de una variable compartida del describe),
para que la fecha de la tarea de housekeeping siga coincidiendo con
"hoy" según el reloj congelado.

**`src/tests/integration/reservation-deferred-assignment.integration.test.ts`
— cada test usa un día DISTINTO (2030-06-03, -04, -07) y construye el
servicio POR TEST** (`setupLodgingFixture`, **definido en la línea 217**
— corregido, no 231, que es solo un call-site — llama a
`buildStayService` en la línea 142) — **un solo reloj congelado no
alcanza**. **(C4 del gate)** `setupLodgingFixture` gana un parámetro
`now?: () => Date` **opcional, con default real** (mismo criterio que
el propio `StayService` — de los 11 call-sites reales de este helper en
el archivo, **8** nunca llaman a `checkIn()` después, así que no se les
puede exigir el parámetro): el test-local `buildStayService` (línea 142)
lo recibe y lo reenvía al constructor de `StayService`. Los 3 tests que
sí llaman a `checkIn()` (358, 397, 487) pasan su propio reloj congelado,
sincronizado con la fecha de su fixture puntual (2030-06-03, -04, -07
respectivamente).

**`src/tests/integration/reservation-price-adjustment-stay.integration.test.ts`**
— fixture único en `2030-01-01` (`seed.ts:178`, `seedReservation`
default) — un solo reloj congelado alcanza (ej.
`2030-01-01T12:00:00Z`), inyectado en la construcción de la línea 81.

**Sin otros llamadores de `checkIn()` en tests** — confirmado por el
gate: `cancel-order-with-credit-note.integration.test.ts:697` construye
el servicio pero nunca llama a `checkIn()`; `city-ledger`,
`reverse-transfer` y `accounts-receivable` usan `Stay.checkIn()` (la
entidad, no el servicio) — no se ven afectados. **(C5, agregado)** hay
un **4to constructor** de `StayService` en `stay.service.test.ts:829`
(`lockingService`) — tampoco llama a `checkIn()` nunca, así que el
reloj por default alcanza, sin necesitar inyección explícita.

## Test plan (corregido — B1)

1. **(C6, reloj explícito)** `startTime` marca `2026-09-27T00:00Z`, reloj
   `2026-09-27T15:00Z` (mediodía ART del mismo día de negocio) → permite.
   Caso simple, lejos de cualquier límite.
2. **(C6, reloj explícito)** `startTime` marca `2026-09-28T00:00Z`
   (mañana), reloj `2026-09-27T15:00Z` (mismo reloj que el caso 1, un día
   antes de la marca) → `CheckInBeforeArrivalDateError`. Mata: quitar el
   guard de `startDate`.
3. **(C6, reloj explícito — distingue este caso del 1)** `startTime` marca
   `2026-09-27T00:00Z`, reloj `2026-09-28T02:59:59.999Z` (23:59:59.999 ART
   del **mismo** día de negocio 2026-09-27, el instante justo antes de
   cruzar a 2026-09-28) → **permite** (verificado: `todayBusiness` y
   `startDate` dan los dos `'2026-09-27'`). Mata `<` → `<=`
   (`stay.service.ts:126`): con el guard real,
   `'2026-09-27' < '2026-09-27'` es `false` → permite; con el mutante,
   `'2026-09-27' <= '2026-09-27'` es `true` → bloquea. El caso 1 (mediodía)
   también deja `todayBusiness === startDate` y también mata este mismo
   mutante — la diferencia entre los dos no es cuál mata qué, es que el
   caso 1 ejercita un punto cualquiera dentro del día de negocio y el
   caso 3 ejercita específicamente el límite superior (el instante más
   tardío que todavía cae en ese mismo día de negocio) — es el escenario
   que da nombre a "hoy exacto (límite)", no un test redundante con reloj
   sin especificar como estaba antes de C6.
4. **(B1, corregido) Instante real (portal), `startTime = 2026-09-29T01:00Z`**
   (22:00 ART del 28/09) — la fecha de negocio de este instante es
   `2026-09-28` (confirmado con luxon por el gate). Con reloj
   `2026-09-28T15:00Z`, `2026-09-28T23:30Z` o `2026-09-29T01:30Z`
   (los 3 caen en fecha de negocio `2026-09-28`) → **permite en los 3**
   (la v4 esperaba bloqueo en los primeros 2 — estaba mal calculado, el
   guard compara por DÍA calendario, no por hora). Sub-caso que sí
   bloquea: reloj `2026-09-27T15:00Z` (fecha de negocio `2026-09-27`,
   un día antes) → `CheckInBeforeArrivalDateError`.
5. **Caso ambiguo (H1, la marca gana siempre):**
   `startTime = 2026-09-28T00:00:00.000Z` (marca — también podría ser un
   instante real a las 21:00 ART del 27/09). Reloj
   `2026-09-28T02:59:59.999Z` (23:59:59.999 ART del 27/09) →
   `CheckInBeforeArrivalDateError`. Reloj `2026-09-28T03:00:00.000Z`
   (00:00:00 ART del 28/09) → permite. **Corrección del costo real
   (el gate detectó que la v4 lo describía mal en un lugar): el bloqueo
   dura hasta las 00:00 ART del día de la marca — 3 HORAS después de las
   21:00 ART, no ~30 minutos.** Este costo de 3 horas es exactamente el
   que se le presentó al dueño en la pregunta que decidió H1 — no hace
   falta volver a preguntarlo, solo corregir la única mención
   inconsistente que quedó en el documento de diseño.
   **(C7, reloj adicional)** mismo `startTime` (marca), reloj
   `2026-09-28T00:00:00.000Z` (exactamente medianoche UTC — el propio
   reloj es también una marca de fecha calendario) → **bloquea**
   (`todayBusiness` = `2026-09-27` vía `todayInBusinessTimezone`,
   `startDate` = `2026-09-28`, `'2026-09-27' < '2026-09-28'` → throw).
   Mata el mutante que calcula "hoy" con
   `deriveCalendarDate(this.now(), tz)` en vez de
   `todayInBusinessTimezone(this.now(), tz)`: con un reloj cualquiera que
   no sea medianoche UTC exacta, las dos funciones dan el mismo resultado
   (ninguno de los casos 1-4 los distingue); con este reloj exacto,
   `deriveCalendarDate` lo trataría como marca y devolvería `2026-09-28`
   directo en UTC (sin convertir a ART), dando `'2026-09-28' <
   '2026-09-28'` → `false` → permite — distinto del resultado real
   (bloquea).
6. Regresión: `ResourceOccupiedError`/`ResourceNotReadyForCheckInError`/
   `ReservationNotConfirmedError` siguen en su mismo orden de
   precedencia, sin cambios.
7. Los 17+3+2 call-sites existentes de la matriz de arriba, con reloj
   inyectado dentro de ventana — deben seguir pasando sin cambiar su
   aserción.

**Mutation testing:** comentar el guard de `startDate` (mata con 2),
`<` → `<=` (mata con 1 y con 3), forzar "hoy" calculado sin
`todayInBusinessTimezone` — ej. UTC puro — (mata con 5: en huso ART,
siempre negativo, un mutante que calcule "hoy" en UTC puro da un
resultado distinto exactamente en el límite de las 00:00 ART que ese
caso ejercita). **(C7, agregado)** reemplazar
`todayInBusinessTimezone(this.now(), tz)` por
`deriveCalendarDate(this.now(), tz)` (mata con el sub-caso de reloj
`2026-09-28T00:00:00.000Z` del caso 5 — único reloj de toda la matriz
que es a la vez una marca de fecha calendario, el único punto donde las
dos funciones divergen).

## Precedencia actualizada (docblock C-7)

`ResourceOccupiedError` (pre-check sin lock) →
`ResourceNotReadyForCheckInError` (housekeeping, pre-check sin lock) →
bajo lock: `status !== CONFIRMED` → **`CheckInBeforeArrivalDateError`
(nuevo)** → errores de `assignDeferred()`.

## Error middleware

`src/api/middleware/error.middleware.ts` — agregar
`CHECK_IN_BEFORE_ARRIVAL_DATE` al grupo 409 (línea 394 actual, junto a
`RESOURCE_NOT_READY_FOR_CHECKIN`).

## Confirmado por el gate — mensaje de error no rompe el frontend

`estadias/page.tsx:150-153` hace `extractErrorMessage(err)` en un toast
genérico (`src/lib/http.ts:149-164`) — el frontend no bifurca por
`code` en ningún lado para ningún error de check-in. El mensaje puede
cambiar de texto libremente.

## Matriz de impacto (reducida — sin tope superior en este bloque)

| Archivo | Cambio |
|---|---|
| `src/pms-estadias/stay.service.ts` | `CheckInBeforeArrivalDateError`, guard bajo lock (usa `deriveCalendarDate`/`todayInBusinessTimezone` importados de `reservas/reservation-time.utils.js`), parámetro `now` inyectable en el constructor, línea 274 unificada al reloj inyectado, docblock C-7 actualizado |
| `src/api/middleware/error.middleware.ts` | mapear el código nuevo a 409 |
| `src/pms-estadias/stay.service.test.ts` | reloj inyectado en los 3 constructores (líneas 205, 433, 563), `seedTaskForToday()` sincronizado al mismo reloj, casos nuevos del test plan |
| `src/tests/integration/reservation-deferred-assignment.integration.test.ts` | `setupLodgingFixture` recibe el reloj como parámetro, sincronizado por test |
| `src/tests/integration/reservation-price-adjustment-stay.integration.test.ts` | reloj congelado único en la construcción de la línea 81 |

Sin cambios en: `stays.routes.ts`, `stay.schemas.ts`, `stay.ts`,
`stay.repository.ts`, `schema.sql`, `tenant-db.setup.ts`,
`docs/rbac-matriz-endpoints.md`, ninguna cerca de
`src/tests/architecture/`/`src/tests/security/`, `appfrontend-main`.
Sin `reservations.routes.ts::buildStayService()` — el parámetro nuevo
es opcional con default.

## Qué NO se toca (fuera de alcance, declarado)

- **Tope superior (`CheckInAfterDepartureDateError`)** — bloque
  aparte, como operación atómica de no-show (ver decisión del dueño
  arriba). No hay flag, no hay mecanismo preparado en este bloque — se
  diseña de cero cuando se retome, evitando el error de la v4 (un
  mecanismo "preparado pero sin consumidor" que terminó siendo una
  regresión disfrazada).
- **`confirmReservation()`** — sin guard de fecha.
- **`updateReservation()` después del check-in (G9)** — gap
  preexistente, no se resuelve acá.
- **El PUT de adultos/niños antes del check-in** (`estadias/page.tsx:133-135`)
  — residuo preexistente, no se arregla en este bloque.

## Verificación necesaria antes del gate de implementación

1. `npx tsc --noEmit -p .` limpio.
2. Suite completa verde, con la matriz de tests corregida (3
   constructores + `setupLodgingFixture` por test + 1 constructor de
   price-adjustment, todos con reloj inyectado sincronizado).
3. Mutation testing ejecutado de verdad (no afirmado).
4. Confirmar que ninguna cerca de RBAC/arquitectura se mueve (no
   debería — sin ruta nueva, sin `authorize()` nuevo, sin schema).
5. Registrar en el `pendientes-<fecha>` vigente: el tope superior
   (check-in después de que la reserva terminó) como bloque aparte,
   diseñado como operación atómica de no-show.
