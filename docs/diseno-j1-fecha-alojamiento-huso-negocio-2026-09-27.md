# Diseño v5 — J1-TZ: comparar fecha de inicio en huso de negocio para reservas con marca de fecha (27/09/2026)

**Reemplaza la v4. APROBADO CON CONDICIONES en el cuarto gate de
arquitectura** — la regla central, la separación de funciones para
"hoy" (H2) y la ubicación del guard (opción B) quedaron confirmadas sin
cambios. Esta v5 incorpora las 8 condiciones (C1-C8) que quedaron para
cerrar antes de implementar. **Este documento ya está habilitado para
pasar a implementación** una vez aplicadas C1-C8 — no hace falta otra
ronda de diseño de fondo, según el propio gate.

## Contexto (sin cambios respecto a v4)

Al implementar el guard de check-in-anterior-al-inicio (bloqueo duro,
decidido por el dueño), se encontró que el guard J1 existente
(`reservation.service.ts:125,309,638-643`) compara **instantes UTC
crudos** con 5 minutos de tolerancia — correcto para el caso que lo
originó (reservar un turno "ahora mismo"), pero erróneo para la
convención de "medianoche UTC = marca de fecha calendario" que usa el
panel para alojamiento y para servicios `bookingMode='block'`. En
Argentina (UTC-3), esa marca ya es "más de 5 minutos en el pasado" en
términos de instante crudo durante casi todo el día de negocio — J1
rechaza cargar o mover a "hoy" casi siempre. Sin arreglar esto, el guard
de check-in duro (sin excepción) dejaría a un walk-in sin ninguna salida
dentro del sistema.

## Regla final — `qualifiesForDateComparison()` (confirmada, sin cambios en 2 gates seguidos)

```ts
type BookingMode = 'slot' | 'block' | 'event'; // bookable-service.types.ts:27

function qualifiesForDateComparison(isLodging: boolean, bookingMode: BookingMode | undefined, startTime: Date): boolean {
  if (bookingMode === 'slot') return false; // instante real siempre, aunque el recurso sea de alojamiento
  return (isLodging || bookingMode === 'block') && isCalendarDateMarker(startTime);
}
```

| `bookingMode` | ¿Alojamiento? | ¿Manda marca o instante? | ¿Califica? |
|---|---|---|---|
| `slot` | sí o no | instante real | **No** — excluido explícito |
| `block` | no (alquiler de equipo) | marca (`turnos/page.tsx:112`) | **Sí** — decisión del dueño, 27/09/2026 |
| `block` | sí (habitación) | marca | Sí — vía `isLodging` |
| `event` | sí (salón en exclusiva) | marca (`useDateOnlyFields = !isSlotService`, `reservas/page.tsx:139`, incluye `event` y "sin servicio") | Sí — vía `isLodging` |
| `event` | no (mesa reservada) | instante real (`turnos/page.tsx:80,477`) | **No** |
| sin servicio | sí | marca (mismo `useDateOnlyFields`) | Sí — vía `isLodging` |
| sin servicio | no | instante real (formulario libre) | No |

## Caso borde declarado (sin cambios)

Un `datetime-local` elegido a las 21:00 hora Argentina produce
exactamente `00:00:00.000Z` — indistinguible de una marca. Para `slot`
no importa (excluido antes de evaluar si es marca). Para
`block`/alojamiento-sin-slot, un horario real de 21:00 se lee como la
fecha del día siguiente. Deuda conocida — el guard de check-in v3
(próximo bloque) cita esta sección en vez de repetir el análisis.

## H2 — "hoy" separado de la detección de marca (confirmado por el gate, sin cambios de fondo)

```ts
export function isCalendarDateMarker(d: Date): boolean {
  const utc = DateTime.fromJSDate(d, { zone: 'utc' });
  return utc.hour === 0 && utc.minute === 0 && utc.second === 0 && utc.millisecond === 0;
}

export function deriveCalendarDate(startTime: Date, timezone: string): string {
  const dt = isCalendarDateMarker(startTime)
    ? DateTime.fromJSDate(startTime, { zone: 'utc' })
    : DateTime.fromJSDate(startTime, { zone: 'utc' }).setZone(timezone);
  const iso = dt.toISODate();
  if (iso == null) throw new Error(`deriveCalendarDate: huso horario inválido (timezone=${timezone})`);
  return iso;
}

export function todayInBusinessTimezone(now: Date, timezone: string): string {
  const iso = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(timezone).toISODate();
  if (iso == null) throw new Error(`todayInBusinessTimezone: huso horario inválido (timezone=${timezone})`);
  return iso;
}

function isPastStart(startTime: Date, qualifies: boolean, businessTimezone: string, now: () => Date): boolean {
  if (!qualifies) return startTime.getTime() < now().getTime() - PAST_START_TOLERANCE_MS;
  return deriveCalendarDate(startTime, businessTimezone) < todayInBusinessTimezone(now(), businessTimezone);
}
```

**C1 (condición del gate) — dato explícito para el test plan, no
asumido:** `FROZEN_TEST_NOW = () => new Date('2020-01-01T00:00:00Z')`
(`reservation.service.test.ts:116`) es en sí misma una marca. En huso
`America/Argentina/Buenos_Aires` (UTC-3), ese instante es
**2019-12-31T21:00:00 hora local** — así que
`todayInBusinessTimezone(FROZEN_TEST_NOW(), tz)` da **`2019-12-31`**,
NO `2020-01-01`. Cualquier test que use este reloj y quiera probar "hoy"
tiene que comparar contra `2019-12-31`, no asumir que coincide con la
fecha que aparenta el string del reloj. El mutante que reemplace
`todayInBusinessTimezone` por `deriveCalendarDate(now(), tz)` daría
`2020-01-01` en su lugar — por eso hace falta un caso que dependa
exactamente de esta diferencia (caso 10 más abajo, corregido).

## Corrección 1 (sin cambios respecto a v4, ya confirmada) — por qué se descarta la opción (A)

Con (A), J1 dejaría de correr en la rama `assignDeferred()` (`return` en
`:688-690`, confirmado por el gate). Dos comportamientos cambiarían
fuera del alcance de este bloque: (a) reserva `PENDING_ASSIGNMENT` con
`startTime` vencido + `resourceId`, SIN cambiar el valor de `startTime`
— pasaría de rechazar a aceptar; (b) la misma reserva con un
`startTime` distinto — pasaría de `InvalidReservationError` (J1) a
`AssignmentCombinedChangeError` (D-2, `:671`, confirmado), que igual
sigue bloqueando el combo. El motivo real para elegir (B) es contención
de alcance, no pérdida de un guard de seguridad.

## Dónde se resuelve cada dato — pseudocódigo completo

### `createReservation()` — orden explícito, con las 2 condiciones C6

```
1. resourceRepository.getById(resourceId)
2. throw si !resource.active
3. [adelantado] category = categoryRepository.findById(resource.categoryId)   -- YA se buscaba en :313, sin condición
4. [adelantado] service = serviceId ? bookableServiceRepository.findById(serviceId) : null   -- YA se buscaba en :321-323, sin condición
5. [adelantado] businessProfile = businessProfileRepository.get()   -- YA se buscaba en :373, sin condición
6. qualifies = qualifiesForDateComparison(category?.isLodging ?? false, service?.bookingMode, startTime)
7. throw InvalidReservationError si isPastStart(startTime, qualifies, businessProfile.timezone, now)   -- reemplaza el J1 crudo de :309
8. if (category) { validateDetailsAgainstFields(details, category.fields) }   -- se queda en :314-316, CON el if, sin cambio de precedencia (C6: restituido, la v4 lo omitía)
9. throw BookableServiceNotFoundError si serviceId y !service   -- se queda en :337, sin cambio
10. throw LodgingRequiresServiceError si category.isLodging y !service   -- se queda en :351, sin cambio
```

**2 cambios de precedencia declarados explícitamente (C6 agrega el
segundo, que la v4 no tenía):**

- Alojamiento + marca de "hoy" + **sin `serviceId`**: antes fallaba en
  el paso 7 (J1 crudo, casi siempre rechaza); ahora pasa el paso 7 y
  falla en el paso 10 (`LodgingRequiresServiceError`, más específico).
- Alojamiento + marca de "hoy" + **`serviceId` que no resuelve**: antes
  fallaba en el paso 7 (J1 crudo); ahora `service` queda `null` (mismo
  camino que "sin service"), pasa el paso 7, y falla en el paso 9
  (`BookableServiceNotFoundError`) — un error distinto y más específico
  que antes ni se alcanzaba a ver.

Los dos son mejoras (el error dice la causa real), pero cambian qué
excepción ve el frontend para esos 2 casos puntuales — el test plan los
cubre explícitamente (casos 11 y 15).

### `updateReservation()` — orden explícito, con C5 corregido

```
Antes de transactionManager.run() (junto a preCheck, ~línea 536):
  if (changes.startTime !== undefined) {                                    -- C5: TODO el bloque B condicionado, no solo C y D
    A. j1EffectiveResourceId = changes.resourceId ?? preCheck.resource.id
    B. if (changes.resourceId && changes.resourceId !== preCheck.resource.id) {  -- HAY reasignación
         const newResource = await resourceRepository.getById(j1EffectiveResourceId)
         j1EffectiveCategory = newResource ? await categoryRepository.findById(newResource.categoryId) : null
         -- recurso inexistente -> j1EffectiveCategory = null EXPLÍCITO (nunca se llama findById(undefined))
       } else {                                                              -- NO hay reasignación
         j1EffectiveCategory = await categoryRepository.findById(preCheck.resource.categoryId)
         -- preCheck.resource ya tiene categoryId (BookableResource/PhysicalResource, resource.entities.ts:39,123) -- SIN consulta nueva de recurso
       }
    C. j1Service = preCheck.serviceId ? await bookableServiceRepository.findById(preCheck.serviceId) : null
    D. j1BusinessProfile = await businessProfileRepository.get()
  } else {
    j1EffectiveCategory = null; j1Service = null; j1BusinessProfile = null;  -- no se leen si no hace falta (estadias/page.tsx:135, que solo cambia adultos/ninos, no pasa por acá)
  }

Dentro de la transacción, SIN mover el guard de lugar (línea ~638, después del status check :624-628, antes de ASSIGNMENT_COMBINED_CHANGE :655-691):
  E. if (changes.startTime !== undefined) {
       qualifies = qualifiesForDateComparison(j1EffectiveCategory?.isLodging ?? false, j1Service?.bookingMode, newStartTime)
       throw InvalidReservationError si isPastStart(newStartTime, qualifies, j1BusinessProfile!.timezone, this.now)
     }
```

**Por qué es seguro leer esto ANTES de la transacción (cita explícita,
C5):** el guard de coherencia ya existente en `:611`
(`existing.resource.id !== preCheck.resource.id || existing.serviceId !== preCheck.serviceId`
→ `ReservationConcurrentlyModifiedError`) aborta la transacción entera
si el recurso o el servicio cambiaron entre el pre-check y el lock real
— así que si `j1EffectiveCategory`/`j1Service` quedaron calculados sobre
un `preCheck` que ya quedó obsoleto, la transacción ni llega al guard E,
se corta antes en `:611` y se pide reintento. No hace falta releer nada
adentro de la transacción para este guard puntual.

## Ubicación de los helpers (sin cambios, confirmada 2 veces)

`src/reservas/reservation-time.utils.ts` — precedente:
`src/pms-estadias/maintenance-window.service.ts:21` ya importa
`combineDateAndTime` directo desde `../reservas/reservation-time.utils.js`.
`.dependency-cruiser.cjs` no prohíbe `pms-estadias → reservas` para
utils puros (solo regla real entre dominios: reservas↔pos).

## Mensajes de error (sin cambios de texto)

- Alta: `'No se puede crear una reserva con fecha/hora de inicio en el pasado.'`
- Mover: `'No se puede mover una reserva a una fecha/hora de inicio en el pasado.'`

Restricción real: `assignment-errors.ts:66-73` solo matchea 4 substrings
(`desactivado`, `fuera de servicio`, `no tiene cupo`, `no está
disponible`); el mensaje de J1 no contiene ninguno.

## Matriz de impacto completa (C7 — agrega las 3 omisiones que el gate encontró)

| Archivo real | Qué manda | ¿Califica? |
|---|---|---|
| `reservas/page.tsx:173` (alta, alojamiento sin `slot`, incluye `event`/sin servicio) | marca | Sí (`isLodging`) |
| `reservas/[id]/page.tsx:247` (edición, `input type="date"`, SIEMPRE, aunque no cambie) | marca | Sí (`isLodging`) — ver residuo abajo |
| `RoomCalendar.tsx:350` (drag, alojamiento) | marca | Sí (`isLodging`) |
| `turnos/page.tsx:112` (alta, `bookingMode='block'` no-alojamiento) | marca | Sí (`block`, decisión del dueño) |
| `turnos/[id]/page.tsx:107` (edición, `block`, SIEMPRE) | marca | Sí (`block`) — ver residuo abajo |
| `turnos/page.tsx:94-95,477` (alta, `slot`/`event` no-alojamiento) | instante real | No |
| `turnos/[id]/page.tsx:107` (edición, `slot`/`event`) | instante real | No — **(C7, faltaba nombrar)** |
| Portal, `customer.routes.ts:864,922` | instante real | No (salvo caso borde 21:00 ART) |
| `estadias/page.tsx:135` (check-in: cambia adultos/ninos) | **no manda `startTime`** | J1 no aplica — **(C7, faltaba nombrar)** |

**Bug preexistente, distinto de este bloque, registrar en pendientes
(C7):** `reservas/[id]/page.tsx` y `RoomCalendar.tsx` mandan SIEMPRE una
marca de fecha al guardar, incluso cuando la reserva es un servicio
`slot` sobre un recurso de alojamiento (turno con horario real) — ni
la pantalla de detalle ni el drag ramifican por `bookingMode` antes de
truncar a medianoche. Esto ya trunca el horario real de un `slot` HOY,
sin este fix. Con este fix, la salida de J1 para ese caso queda
**idéntica a la actual** (slot se excluye, se compara instante crudo) —
no lo empeora ni lo arregla, así que no reabre el alcance de este
bloque, pero el bug de truncación en sí es un hallazgo aparte.

**Residuo declarado (sin cambios respecto a v4):** las 2 páginas de
edición mandan `startTime` en cada guardado, aunque no haya cambiado —
J1 dispara por presencia del campo, no por cambio de valor. Con este
fix, "hoy" pasa a permitirse; una reserva con inicio en el pasado sigue
rechazándose igual que hoy. Comparar por VALOR es decisión aparte, para
el dueño.

**Pregunta de negocio, no bloqueante, para antes del guard de check-in
duro (nueva del gate, C7 adyacente):** el límite de "hoy" es la
medianoche calendario del huso de negocio — un walk-in a la 01:30 ART no
puede cargarse con check-in "de ayer", que es la práctica real de cierre
nocturno ("night audit") en hotelería. Esto **ya es así hoy**, este
bloque no lo cambia ni lo empeora — se registra para que el dueño lo
decida antes de que el guard de check-in duro (sin excepción) lo vuelva
más visible.

## Test plan v5 (15 casos + 14b + mutant table corregida — C2, C3, C4, C6, C8)

Usa el stub de categoría con `isLodging: true` de
`reservation.service.test.ts:714-730`. Perfil de test con
`America/Argentina/Buenos_Aires` (`:144`). **Por C1: cuando el test use
`FROZEN_TEST_NOW`, "hoy" es `2019-12-31`, no `2020-01-01` — todo caso que
dependa de esto usa la fecha correcta, no el string del reloj.**

1. Alojamiento, marca de "hoy" (huso de negocio) → permite. Mata:
   `deriveCalendarDate` sin la rama de detección de marca (si
   `startTime` se leyera siempre en huso de negocio sin chequear si es
   marca, la marca de medianoche UTC se interpretaría como el día
   anterior en ART y este caso fallaría).
2. Alojamiento, marca de "ayer" → rechaza.
3. Reloj `2026-09-28T01:00Z` (22:00 ART), marca `2026-09-27T00:00Z` →
   permite. Mata: "hoy" calculado en UTC en vez de huso de negocio.
4. Reloj `2026-09-28T01:00Z`, marca `2026-09-28T00:00Z` → permite (forma
   más visible del bug, no mata un mutante adicional — regresión).
5. **(C2, reemplaza el caso 5 anterior)** Alojamiento, servicio
   `block` (NO `slot`), reloj `2020-01-01T00:00:00Z`, `startTime`
   `2019-12-31T23:50:00Z` (NO es marca, mismo día de negocio, 10 min en
   el pasado) → rechaza. Productor real: alojamiento vía portal. Mata:
   quitar `&& isCalendarDateMarker` de `qualifies` (con `block` real y
   sin ser marca, si el guard comparara fecha igual, aceptaría por
   error). El caso viejo con `slot` queda como regresión aparte (caso
   9), no mata este mutante porque `slot` corta antes por su propia
   exclusión.
6. No-alojamiento, SIN servicio (o `event`), marca EXACTA de "hoy" →
   rechaza. Mata: quitar toda la condición `(isLodging || bookingMode
   === 'block')` de una — con eso, cualquier marca calificaría sin
   importar categoría/modo.
7. `bookingMode='block'` no-alojamiento, marca de "hoy" → permite.
8. `bookingMode='slot'` sobre recurso de ALOJAMIENTO, instante real a
   las 21:00 ART, ya pasado, con la fecha UTC de la marca resultante `≥`
   "hoy" en huso de negocio → rechaza. Mata: quitar la exclusión
   explícita de `slot`.
9. No-alojamiento, servicio sin `bookingMode='block'` (turno estándar),
   10 min en el pasado → rechaza (regresión). 2 min en el pasado →
   permite (regresión, tolerancia).
10. **(C3, corregido)** Reloj `2026-09-27T00:00:00.000Z` (el reloj MISMO
    cae justo en una marca exacta), alojamiento + `block`, `startTime`
    `2026-09-26T00:00:00.000Z` → **permite**. Con la regla correcta, "hoy"
    (huso de negocio) es `2026-09-26` (el reloj UTC medianoche del 27
    equivale a las 21:00 ART del 26) — la marca del `startTime` también da
    `2026-09-26` → igual a "hoy", no es anterior, se permite. Mata:
    reemplazar `todayInBusinessTimezone(now(), tz)` por
    `deriveCalendarDate(now(), tz)` — con el mutante, el RELOJ (que
    también cae en `00:00:00.000Z`) se leería como si fuera una marca
    guardada, y "hoy" daría `2026-09-27` (fecha UTC cruda) en vez de
    `2026-09-26` (fecha de negocio real) — la marca del `startTime`
    (`2026-09-26`) pasaría a leerse como anterior a ese "hoy" mutante y
    rechazaría por error.
11. Alojamiento, marca de "hoy", SIN `serviceId` →
    `LodgingRequiresServiceError`, NO `InvalidReservationError`.
12. Alojamiento, marca de "hoy", `serviceId` que NO resuelve →
    `BookableServiceNotFoundError` **(C6, caso nuevo)**.
13. **(C4, caso nuevo)** Alojamiento, servicio `event`, marca de "hoy"
    → permite (creación/actualización exitosa) — productor real: salón
    en exclusiva. **Mata un mutante DISTINTO al del caso 6** (corrección
    del segundo gate de implementación, 27/09/2026 — la atribución
    anterior, "mismo mutante que el caso 6", era incorrecta y quedaba
    contradicha por la fila ya corregida de la tabla de mutantes más
    abajo): quitar SOLO `isLodging ||` y dejar `bookingMode === 'block'`
    sola. Con ese mutante puntual, alojamiento+`event` (sin
    `bookingMode='block'`) dejaría de calificar y este caso rechazaría
    por error en vez de crear con éxito — sin este caso, ese mutante
    puntual no se distingue del comportamiento correcto usando solo
    casos de rechazo (6, que sí es alojamiento pero sin servicio).

`updateReservation()`:
14. **(C8, wording corregido; caso reescrito en el gate de implementación,
    27/09/2026 — la versión original usaba una marca FUTURA, con la que la
    categoría vieja y la nueva daban el mismo resultado y el caso no
    distinguía nada)** Reasignación de recurso que cambia de alojamiento a
    no-`block` junto con `startTime` marca de "HOY" (huso de negocio) → la
    categoría NUEVA (no-alojamiento, servicio `event`) no califica, cae a
    instante crudo, ya "pasado" → rechaza con el mensaje literal de J1. Con
    la categoría VIEJA (alojamiento) hubiera permitido — la divergencia es
    lo que el caso confirma.
14b. **(agregado en el gate de implementación)** Dirección inversa — de
    no-alojamiento A alojamiento, misma marca de "hoy" → permite (la
    categoría NUEVA, alojamiento, califica). Confirma que 14 no es una
    asimetría accidental de `updateReservation()`, sino específicamente la
    categoría efectiva.
15. `changes.resourceId` apunta a un recurso inexistente →
    `j1EffectiveCategory = null` explícito (`isLodging=false`), J1
    evalúa con la regla de instante, `ResourceNotFoundError` se lanza
    después en su lugar actual (línea citada contra HEAD antes de la
    implementación, `6ab48f1` — desactualizada tras este diff; ver nota
    de citas más abajo). **(C8, corrección de fixture)** La reserva de
    origen tiene que estar `ASSIGNED` (NO `PENDING_ASSIGNMENT`) — si no,
    el caso se va por la rama
    `assignDeferred()` y no prueba lo que dice probar. Servicio de la
    reserva NO `block`/marca (para que la regla de instante decida
    antes de llegar a `ResourceNotFoundError`).

Todos los casos "permite" con servicio válido afirman una creación/
actualización exitosa real — si no, `LodgingRequiresServiceError` o
`BookableServiceNotFoundError` esconden el resultado (salvo los casos 11
y 12, que existen para confirmar esos errores puntuales).

### Tabla de mutantes → caso que lo mata (corregida, C4)

| Mutante | Caso que lo mata |
|---|---|
| Quitar `&& isCalendarDateMarker` de `qualifies` | 5 |
| Quitar la condición completa `(isLodging \|\| bookingMode === 'block')` | 6 (corrección del gate de implementación, 27/09/2026: el caso 13 NO mata este mutante — con él, "cualquier `bookingMode`" sigue calificando y el caso 13, servicio `event`, seguiría dando el mismo resultado de éxito. El caso 13 mata un mutante DISTINTO, no listado acá porque no es uno de los 6 nombrados en este documento: quitar solo `isLodging \|\|` y dejar `bookingMode === 'block'` sola — con ese mutante, alojamiento+`event` (caso 13) dejaría de calificar y rechazaría por error) |
| Quitar la exclusión explícita de `slot` | 8 |
| `todayInBusinessTimezone(now(), tz)` → `deriveCalendarDate(now(), tz)` | 10 |
| `deriveCalendarDate(startTime, tz)` sin la rama `isCalendarDateMarker` | 1 |
| "hoy" calculado en UTC puro (sin `setZone(tz)`) | 3 |

## Medición SQL (sin cambios respecto a v4 — el cuarto gate no pudo re-correrla por falta de tool de Neon en su entorno, solo confirmó la aritmética)

```sql
WITH tz AS (SELECT timezone FROM business_profile LIMIT 1),
r AS (
  SELECT r.status, c.is_lodging, bs.booking_mode,
    (r.start_time AT TIME ZONE 'UTC')::time = '00:00:00' AS is_marker,
    r.start_time < now() - interval '5 minutes' AS old_rejects,
    CASE
      WHEN (r.start_time AT TIME ZONE 'UTC')::time = '00:00:00'
           AND bs.booking_mode IS DISTINCT FROM 'slot'
           AND (c.is_lodging OR bs.booking_mode = 'block')
        THEN (r.start_time AT TIME ZONE 'UTC')::date < (now() AT TIME ZONE tz.timezone)::date
      ELSE r.start_time < now() - interval '5 minutes'
    END AS new_rejects
  FROM reservations r
  JOIN resources s ON s.id = r.resource_id
  JOIN resource_categories c ON c.id = s.category_id
  LEFT JOIN bookable_services bs ON bs.id = r.service_id
  CROSS JOIN tz
  WHERE r.status IN ('PENDING','CONFIRMED'))
SELECT status, is_lodging, booking_mode, is_marker, old_rejects, new_rejects, count(*)
FROM r GROUP BY 1,2,3,4,5,6 ORDER BY 1,2,3,4,5,6;
```

(Agrega `AND bs.booking_mode IS DISTINCT FROM 'slot'` al `CASE`, pedido
del cuarto gate — inocuo hoy porque las 5 filas reales son `block`, pero
replica la regla exacta en vez de una aproximación.)

**Demo** (medido `2026-09-27T02:04:05Z`) — 4 filas agrupadas, suman **5
reservas** (1+1+1+2), coincide con "1 CONFIRMED + 4 PENDING = 5" del
diseño del guard de check-in:

| status | is_lodging | booking_mode | is_marker | old_rejects | new_rejects | count |
|---|---|---|---|---|---|---|
| CONFIRMED | true | block | true | false | false | 1 |
| PENDING | true | block | true | false | false | 1 |
| PENDING | true | block | true | true | false | 1 |
| PENDING | true | block | true | true | true | 2 |

**Hotel los Álamos:** 0 filas. Ninguna fila `is_lodging=false` +
`booking_mode='block'` en ningún tenant — extensión correctiva hacia
adelante, sin riesgo de cambiar un resultado ya en producción.

## Verificación necesaria antes del gate de implementación

1. `npx tsc --noEmit -p .` limpio.
2. Suite completa verde, con los 15 casos de arriba.
3. `npm run lint:arch` limpio.
4. **Mutation testing EJECUTADO, no afirmado** (condición explícita del
   cuarto gate): por cada uno de los 6 mutantes de la tabla, aplicar el
   cambio, mostrar qué test(s) quedan en rojo, revertir.
5. Reconciliar `docs/diseno-early-checkin-guard-2026-09-27.md` (v2 → v3,
   próximo bloque) para importar los helpers de acá y corregir su
   párrafo de "probabilidad baja".

## Implementación — correcciones del gate de implementación (27/09/2026)

Código escrito, gateado por `architecture-governor` en modo implementación
(no solo diseño): **APROBADO CON CONDICIONES**, bloqueantes para el commit.
Aplicadas todas antes de pedir autorización de commit:

- **C-a (bloqueante):** el caso 14 original usaba una marca de fecha
  FUTURA para el `startTime` del PUT de reasignación — con una fecha
  futura, la categoría vieja (alojamiento) y la nueva (no-alojamiento)
  daban el MISMO resultado (permite en ambos casos), así que el test no
  distinguía nada: un mutante que ignorara la reasignación y siempre
  usara `preCheck.resource.categoryId` pasaba igual. Reescrito con
  `startTime` = marca de "hoy" (huso de negocio, bajo `FROZEN_TEST_NOW`):
  con la categoría NUEVA (no-alojamiento) el caso rechaza (no califica,
  cae a instante crudo, ya pasado); con la categoría VIEJA (alojamiento)
  hubiera permitido (calificaría, "hoy" == "hoy"). Se agregó el caso 14b
  (dirección inversa: no-alojamiento → alojamiento, misma marca →
  permite) para confirmar que no es una asimetría accidental de
  `updateReservation()`, sino específicamente la categoría efectiva.
- **C-b (bloqueante):** mutante nuevo (usar SIEMPRE
  `preCheck.resource.categoryId`, ignorando la reasignación) ejecutado de
  verdad contra el caso 14 reescrito — confirmado en rojo, revertido.
- **C-c (bloqueante):** la cita `reservation.service.ts:1103-1111` (en el
  docblock de `isCalendarDateMarker()` y en el comentario de J1-TZ de
  `createReservation()`) ya estaba desactualizada al escribirse — el
  diff de este mismo bloque movió el comentario real (E1, fechas de
  alojamiento en el email) a otra línea. Corregido a cita por nombre
  (`el comentario E1 de confirmReservation()`), no por número —
  `SCHEMA-ANCHOR-DRIFT-001`.
- **C-d (recomendada, aplicada):** los casos de rechazo (2, 5, 6, 8, 9a)
  ahora afirman el mensaje literal de J1-TZ, no solo la clase
  `InvalidReservationError` (que se lanza por muchos motivos distintos
  en este archivo).
- **C-e (aplicada):** "14 casos" → "15 casos" en el título del test plan;
  la fila de la tabla de mutantes de "quitar la condición completa" ya
  no dice "6 y 13" (13 no mata ese mutante — mata uno distinto, no
  numerado entre los 6 de este documento: quitar solo `isLodging ||`);
  reescrito el texto confuso del caso 10; corregido el título engañoso
  del test 4 en el archivo de tests ("mismo día de negocio" era
  incorrecto — la marca es el día de negocio SIGUIENTE, una fecha
  futura, por eso permite).

Verificación re-corrida después de aplicar C-a a C-e: `tsc` limpio,
suite completa verde — 187 archivos + 1 saltado, 2753 tests + 1 todo —,
`lint:arch` sin violaciones (317 módulos, 1587 dependencias).

**Segundo gate de implementación (ronda de cierre, 27/09/2026):**
APROBADO CON CONDICIONES — C-a/C-b/C-c confirmados en el código; quedaba
una contradicción de texto (caso 13 decía "mata el mismo mutante que el
caso 6", contradiciendo la fila ya corregida de la tabla) — corregida en
este mismo documento (sección del caso 13 más arriba) y en el comentario
gemelo de `reservation.service.test.ts`. Push y deploy siguen sin
autorizar — eso es del dueño.

**Nota de citas por línea (declarada, no se corrige retroactivamente):**
las citas de línea de este documento (ej. `reservation.service.test.ts:714-730`,
`:698-705`) apuntan contra el código en `6ab48f1` (antes de esta
implementación) — el diff real corrido este bloque las movió. Mismo
criterio que `SCHEMA-ANCHOR-DRIFT-001`: no se persiguen números de línea
que van a seguir moviéndose: al citar este documento más adelante,
re-verificar contra el archivo vivo, no asumir la línea.

**Hallazgo adyacente, fuera de alcance de este bloque (registrar en
pendientes, no acá):** el caso 14 reasigna una reserva cuyo servicio
pertenece a `cat-lodging` a un recurso de `cat-table`, y
`updateReservation()` lo acepta — no hay ningún chequeo de
servicio-vs-categoría del recurso en una reasignación normal. Preexistente,
J1-TZ no lo introduce ni lo agrava. No verificado si es intencional.

**Verificación de entorno real, todavía pendiente (no bloquea el commit,
sí bloquea marcar esto "resuelto" en `resuelto.md`):** después del
deploy, alguien tiene que crear o mover una reserva de alojamiento a
"hoy" después de las 21:00 ART en un tenant real y confirmar que se
acepta — evidencia de runtime real, no solo tests.
