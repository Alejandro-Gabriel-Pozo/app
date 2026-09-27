# Diseño — Fase 3 de "reserva por tipo de unidad con asignación diferida": "Auto Assign All" (ítem 4.3 del plan de ejecución integral)

- **v3 (27/09/2026) — corrige el HOLD del gate sobre v2.** El gate confirmó
  H1, H3 y C1/C2/C6/C7 de v2 sin hallazgos nuevos, pero encontró dos
  bloqueantes: **B1** — `totalPending`/`processed`/`truncated` se
  contradecían entre §5 y §7.3 (el `LIMIT 200` de SQL corría ANTES del
  filtro JS exacto de capa 2, así que un conteo aproximado podía marcar
  `truncated: true` aunque las filas reales de HOY fueran menos de 200 —
  rompía honest-degradation en el caso común, mandando al staff a
  "volvé a correr" una acción que nunca iba a cambiar nada). **B2** — el
  filtro por "solo llegadas de hoy" (v2) resuelve el hallazgo H2 original
  (reservas futuras) pero deja un caso residual real: un huésped con
  salida hoy que todavía no hizo check-out (o una estadía vencida) puede
  seguir ocupando físicamente una habitación que el fallback greedy elige
  como candidata — el paso 7 de `assignDeferred()` la rechaza con
  `RESOURCE_OCCUPIED` y, sin cambio de diseño, una re-corrida falla
  exactamente igual hasta que ese huésped haga check-out. **Decisión del
  dueño sobre B2 (`AskUserQuestion`, 27/09/2026): aceptar como limitación
  declarada** — mismo comportamiento que el `PUT` manual de reasignación
  ya tiene hoy en producción para este mismo escenario (no es una
  regresión nueva de Fase 3, es un caso preexistente que el batch hereda
  tal cual). B1 se corrige en §2.2/§5/§7 (ítem 3) más abajo; B2 se
  documenta en §2.2 y §10. El gate también registró 3 hallazgos no
  bloqueantes (N1: `recordOccupancy()` no idempotente dentro del mismo
  `try` que el commit; N2: la matriz de impacto §9 omitía 2 archivos que
  sí cambian; N3: faltaban 2 campos en la lista de §7 ítem 4 y una nota
  de RBAC en la matriz) y correcciones al test plan (C4) — todos
  aplicados abajo, en sus secciones respectivas.

- **Fecha:** 2026-09-27
- **Estado:** propuesto, pendiente de gate `architecture-governor`
- **Depende de:** `docs/diseno-reserva-por-tipo-unidad-2026-09-24.md` (Fases 0-2, ya implementadas y en producción — Render `dep-das13mnf3r2c73ahefa0`, 2026-09-26). Este documento NO reabre esas fases; asume `assignmentStatus`/`ASSIGNMENT_STATUS_TRANSITIONS`/`assignDeferred()` como mecanismo ya construido y estable.
- **Precondición de gate ya cumplida:** Fase 2 en producción real — ya no bloquea.
- **Decisión de negocio F3-4, ya tomada por el dueño (27/09/2026, `AskUserQuestion`) — no se reabre acá:** de las tres opciones que el documento base dejaba abiertas en su §6 ("Auto Assign All (solo alojamiento)") y en el fork F3-4 de su §9 — (a) confirmar la provisoria si sigue siendo válida, (b) reoptimizar todas las `PENDING_ASSIGNMENT` de la categoría, (c) dejar el greedy alfabético actual sin tocar — el dueño eligió **(a), acotada**: si la habitación provisoria de una reserva sigue disponible en su propio rango de fechas, se confirma ESA MISMA habitación, sin reoptimizar el conjunto y sin pasar por el criterio greedy alfabético de `findAvailableResourceInCategory()`. Solo para las reservas cuya provisoria YA NO esté disponible se busca una alternativa, y ahí sí aplica `findAvailableResourceInCategory()` (greedy alfabético existente). Esto es una versión MÁS ACOTADA que la opción (a) tal como estaba redactada en el documento base — la opción (b) (reoptimizar terceros) queda explícitamente descartada por esta decisión, no solo "sin elegir".
- **v2 (27/09/2026) — corrige un HOLD real del primer gate de diseño.** La v1 de este documento decidió, por su propia cuenta (sin `AskUserQuestion`), que el batch procesaba "todas las `PENDING_ASSIGNMENT` futuras de la categoría, sin filtro de fecha" — el gate lo marcó como una decisión de negocio escondida e irreversible (`ASSIGNED` es terminal, `Reservation.ts` `ASSIGNMENT_STATUS_TRANSITIONS`) y además encontró que, sin filtro, el chequeo de "¿la Stay activa del candidato es de OTRA reserva?" (paso 7 de `assignDeferred()`, `StayRepository.findActiveByResource()`) **no mira fechas** — rechazaría sistemáticamente una habitación con un huésped alojado HOY aunque la reserva que se estuviera asignando fuera para el mes que viene, sin que reintentar cambie nada. **Decisión real del dueño (`AskUserQuestion`, 27/09/2026): el batch procesa SOLO las llegadas de HOY (fecha de negocio).** Esto resuelve los dos hallazgos a la vez: ya no es una decisión escondida (está explícita, acá) y el chequeo de la Fase 2 vuelve a ser correcto tal cual, sin tocarlo — "¿hay alguien alojado ahora en este recurso?" es exactamente la pregunta correcta cuando todo lo que se procesa son llegadas de hoy.

---

## 1. Qué cambia respecto del sketch del documento base

El §6 del documento base describía el algoritmo como "el batch corre `findAvailableResourceInCategory()` sobre todas las `PENDING_ASSIGNMENT`... y delega la aplicación de cada asignación a `assignDeferred()`" — es decir, SIEMPRE vía la resolución greedy-alfabética de la categoría completa. La decisión F3-4 del dueño cambia esto: `findAvailableResourceInCategory()` deja de ser el ÚNICO mecanismo de resolución de candidato — pasa a ser el mecanismo de **fallback**, invocado solo cuando el chequeo puntual de "¿mi propia provisoria sigue libre?" da negativo. El resto del mecanismo (orden de locks N1, `assignDeferred()` como aplicación única, transacción por reserva, `excludeReservationId`) no cambia — se reutiliza tal cual, verificado contra código real en la sección 3.

---

## 2. Endpoint

### 2.1 Ruta, método, rol

**`POST /api/reservations/auto-assign-all`** — `authorize(Roles.MANAGEMENT)`, `requireModule(container, ModuleKey.ALOJAMIENTO)` (C6, decisión explícita: SÍ lo lleva, mismo criterio que las rutas de `schedule-request` — esta ruta escribe/reasigna reservas reales, a diferencia de `GET /availability-by-category`, de solo lectura, que no lo lleva).

Mismo criterio ya declarado en el documento base (§8 A6.6, verificado ahí, sin cambios): más restrictivo que la reasignación individual (`PUT /reservations/:id`, `Roles.FRONT_DESK`) porque es una operación masiva — mismo criterio de `irreversible-action-gate` (`CLAUDE.md`) que este repo ya aplica en otros lugares para exigir un tier de permiso más alto ante una operación en lote.

Se monta como ruta de nivel superior (mismo patrón que `POST /reservations/search`, verificado en `reservations.routes.ts` — no hay ningún `POST /:id` de un solo segmento en este router, así que no hay riesgo de colisión de orden de montaje con las rutas `/:id/...` existentes; a diferencia de `GET /availability-by-category`, que sí necesita montarse ANTES de `GET /:id` por ser también GET de un solo segmento).

### 2.2 Alcance — solo alojamiento, un categoryId por llamada, SOLO llegadas de HOY (decisión del dueño, v2)

- **Solo alojamiento** (`resource_categories.is_lodging = TRUE`), mismo alcance que TODAS las fases de 4.3 (decisión del dueño ya citada en el documento base, §5 punto 1, fork 1 de los 17 ya resueltos). El handler valida esto ANTES de invocar el service, con el mismo patrón inline que ya usa `GET /reservations/availability-by-category` (404 `NOT_FOUND` si la categoría no existe, 422 `CATEGORY_NOT_LODGING` si `!category.isLodging` — verificado en `reservations.routes.ts`, no se crea una clase de `DomainError` nueva para esto, se replica el patrón existente literal).
- **Un `categoryId` por llamada, no una lista.** Decisión explícita: acota el radio de la operación (mismo criterio `irreversible-action-gate` — preferir scoping chico a "todas las categorías de una", que sería un blast radius mucho mayor sin necesidad real declarada).
- **SOLO llegadas de HOY (fecha de negocio) — decisión del dueño (`AskUserQuestion`, 27/09/2026), reemplaza "sin filtro de fecha" de la v1.** Coincide con el documento base ("el día de llegada") y con el caso de uso real (preparar el día antes de que empiece). Cierra el hallazgo H1 del gate sobre la v1 (ya no es una decisión de negocio escondida) y **reduce, pero no elimina,** el hallazgo H2/B2: acotar a llegadas de hoy hace que el chequeo de "¿la Stay activa del candidato es de OTRA reserva?" (paso 7 de `assignDeferred()`) vuelva a ser la pregunta correcta para el caso general — pero **no** cubre el caso de un huésped con salida HOY que todavía no hizo check-out (o una estadía vencida): esa habitación sigue teniendo una Stay `CHECKED_IN` activa en el momento en que el batch corre, así que el fallback puede elegirla igual y el paso 7 la va a rechazar. **(B2, v3) Decisión del dueño (`AskUserQuestion`, 27/09/2026): aceptar como limitación declarada, ver §10** — mismo comportamiento que el `PUT` manual de reasignación ya tiene hoy para este caso (no es una regresión de Fase 3, el batch hereda el mecanismo de detección tal cual, no lo empeora). **Sin parámetro de fecha en el request** — "hoy" se resuelve del lado del servidor (huso de negocio), no lo elige el staff.
- **Filtrado por fecha — mecanismo de 2 capas, mismo criterio que J1-TZ (SQL aproximado + JS exacto), por la misma razón: `start_time` puede ser una marca de fecha calendario O un instante real, y la comparación exacta necesita `deriveCalendarDate()`/`isCalendarDateMarker()` (`reservas/reservation-time.utils.ts`, ya commiteado en `05542b5`), que no es trivial de replicar en SQL crudo:**
  1. **SQL (capa 1, sobre-inclusiva a propósito):** `getPendingAssignmentByCategory()` filtra `start_time BETWEEN (today_business_date_utc_midnight - interval '1 day') AND (today_business_date_utc_midnight + interval '2 days')` — una ventana de 3 días alrededor de la medianoche UTC de "hoy" (huso de negocio), generosa para cubrir cualquier offset de huso horario real (-12 a +14) sin descartar por SQL ninguna fila que la capa 2 después necesite evaluar con precisión. **(B1, v3) Sin `LIMIT` ajustado al tope de negocio (200) en esta capa** — la ventana de 3 días ya acota el volumen de forma natural (llegadas de un solo día de negocio, más margen), así que no hace falta un `LIMIT` chico que compita con el filtro JS todavía sin aplicar. Como red de seguridad exclusivamente contra un volumen anormal (una categoría con miles de filas en esa ventana, escenario no esperado en producción), la query lleva un `LIMIT` alto y separado (`RESERVATIONS_MAX_LIMIT * 5` = 1000, elegido para que nunca sea el límite operativo real) — si ESTE tope se alcanza, el service lo trata como `truncated: true` de forma conservadora y lo loguea (caso degenerado, no el camino normal).
  2. **JS (capa 2, exacta):** de las filas que trajo el SQL, el service filtra `deriveCalendarDate(r.startTime, businessProfile.timezone) === todayBusinessDate` — la MISMA función que ya usa J1-TZ, sin reimplementar la lógica de marca-vs-instante. **(B1, v3) `totalPending` se calcula DESPUÉS de este filtro** (`filtered.length`), nunca antes — ver §5, ítem 3 más abajo, para el detalle completo de por qué `countPendingAssignmentByCategory()` (v2) se elimina.
  - `todayBusinessDate` se calcula una sola vez por llamada, con `todayInBusinessTimezone(this.now(), businessProfile.timezone)` (mismo patrón que el guard de check-in, `docs/diseno-early-checkin-guard-2026-09-27.md`) — `ReservationService` ya tiene un reloj inyectable (`this.now`, confirmado en su constructor), se reusa, no se agrega uno nuevo.

### 2.3 Request

```
POST /api/reservations/auto-assign-all
{
  "categoryId": "uuid"
}
```

Schema Zod nuevo, mismo archivo que el resto (`src/api/schemas/request.schemas.ts`), mismo patrón que `AvailabilityByCategoryQuerySchema` (verificado ahí):

```ts
export const AutoAssignAllSchema = z.object({
  categoryId: z.string().min(1, 'categoryId es obligatorio'),
});
```

### 2.4 Orden y tope de procesamiento

- Se procesan en orden `start_time ASC, id ASC` (desempate determinístico, mismo criterio que `getFiltered()` ya usa para su propio desempate — verificado, aunque esa query ordena DESC; acá ASC es la elección correcta porque prioriza las llegadas más próximas primero, que es lo que un front desk necesita cuando corre esto para preparar el día).
- Tope de `RESERVATIONS_MAX_LIMIT` (200, constante ya existente en `reservation.repository.ts`, D-14 — reusada, no un número nuevo inventado). Si la categoría tiene más de 200 `PENDING_ASSIGNMENT` vigentes, el batch procesa las primeras 200 (por el orden de arriba) y lo **declara explícitamente en la respuesta** (`totalPending` vs. `processed`, ver 5) — mismo criterio `honest-degradation` que el resto del repo ya aplica (nunca truncar en silencio). El staff puede volver a correr el endpoint para procesar el resto — mismo patrón UX que el documento base ya establece para el aborto individual por cambio de fechas concurrente (§6 Fase 3: "el staff puede volver a correr Auto Assign All para recoger la que quedó sin procesar").

---

## 3. Algoritmo (verificado contra código real, no re-derivado desde cero)

### 3.1 Resolución de candidato — dos pasos, no uno

Para cada `queuedReservation` (la lectura SIN lock del batch, mismo nombre ya establecido en el documento base §6 Fase 3):

**Paso A — optimista, fuera de la transacción, barato.** ¿Sigue disponible su PROPIA provisoria?

```ts
const ownStillFree = await this.availability.checkAvailability(
  queuedReservation.resource.id, queuedReservation.startTime, queuedReservation.endTime,
  queuedReservation.id,                    // excludeReservationId — YA existe en checkAvailability()
  queuedReservation.serviceId ?? undefined,
  queuedReservation.partySize,
);
```

`checkAvailability()` (`reservation-availability.service.ts`) YA acepta `excludeReservationId` hoy — verificado en su firma real: `checkAvailability(resourceId, startTime, endTime, excludeReservationId?, serviceId?, partySize)`. **No necesita ningún cambio para este uso** — el requisito F3-2 (abajo) es SOLO para `findAvailableResourceInCategory()`, el fallback.

**Paso B — solo si A dio `false`.** Buscar alternativa en la categoría, excluyéndose a sí misma:

```ts
const candidate = await this.availability.findAvailableResourceInCategory(
  {
    categoryId,
    startTime: queuedReservation.startTime,
    endTime:   queuedReservation.endTime,
    ...(queuedReservation.serviceId && { serviceId: queuedReservation.serviceId }),
    partySize: queuedReservation.partySize,
  },
  queuedReservation.id,   // excludeReservationId -- NUEVO parámetro, requisito F3-2
);
```

Si `candidate` es `null` → esta reserva puntual se marca `FAILED` con `NO_RESOURCE_AVAILABLE`, **sin abrir ninguna transacción** (no hay nada que lockear todavía). El batch sigue con la siguiente.

**Por qué el Paso A tiene que ser un chequeo puntual (`checkAvailability` de UN recurso) y no simplemente llamar a `findAvailableResourceInCategory()` y comparar el resultado contra el recurso actual:** `findAvailableResourceInCategory()` devuelve el PRIMER libre por `ORDER BY r.name ASC` (`getByCategory()`, `sql.resource.repository.ts` — verificado, `ORDER BY r.name ASC`). Si se llamara siempre a esa función y se aceptara lo que devuelve, una provisoria "105" perfectamente libre se pisaría con "101" solo por orden alfabético — exactamente el comportamiento que F3-4(a) descarta. El chequeo puntual sobre el recurso PROPIO es la única forma de implementar "confirmar la provisoria sin reoptimizar" tal como está redactada la decisión del dueño.

### 3.2 Requisito de implementación F3-2 (ya identificado por el documento base, confirmado acá contra código real)

`findAvailableResourceInCategory()` (`reservation-availability.service.ts`) gana un segundo parámetro:

```ts
async findAvailableResourceInCategory(
  params: { categoryId: string; startTime: Date; endTime?: Date; serviceId?: string; partySize?: number },
  excludeReservationId?: string,
): Promise<PhysicalResource | null> {
  // ...
  const available = await this.checkAvailability(
    resource.id, params.startTime, endTime, excludeReservationId, params.serviceId, params.partySize,
  );
  // ...
}
```

Reenvía `excludeReservationId` al lugar donde hoy pasa `undefined` fijo (verificado, ese literal es el único cambio de esa línea). El call-site de creación (`POST /reservations`, `reservations.routes.ts`) sigue sin pasarlo — comportamiento idéntico a hoy, nada que migrar ahí.

**Efecto colateral a propagar:** `ReservationService.findAvailableResourceInCategory()` (el wrapper público, `reservation.service.ts`) delega tal cual a `this.availability.findAvailableResourceInCategory(params)` — hoy sin `partySize` en su firma pública (discrepancia preexistente, no introducida por Fase 3: el wrapper nunca reenvía `partySize`, solo `categoryId/startTime/endTime/serviceId`). Como el batch va a vivir DENTRO de `ReservationService` (ver 3.4) y puede llamar directo a `this.availability.findAvailableResourceInCategory(...)` (sin pasar por el wrapper público), este requisito NO obliga a tocar el wrapper — se deja como deuda preexistente, declarada, fuera de alcance de Fase 3 (el único call-site externo del wrapper, `POST /reservations`, nunca pasó `partySize` y sigue sin hacerlo).

### 3.3 Hallazgo propio — F3-6: `assignDeferred()` no expone `locked`, y el guard de "cambió de fechas" del documento base lo necesita

El documento base (§6 Fase 3, "Rango de fechas del pre-lock") especifica: si `locked.startTime/endTime` (la relectura BAJO lock, dentro de la transacción) difiere de `queuedReservation.startTime/endTime` (la lectura sin lock de antes), abortar con `ReservationConcurrentlyModifiedError(id, 'cambió de fechas')` — el texto exacto del `reason` ya está reservado para este caso (verificado, `domain/errors.ts`, docblock de `ReservationConcurrentlyModifiedError`, y confirmado en el propio documento base: *"el aborto de 'Auto Assign All' usa 'cambió de fechas'"*).

**Problema no resuelto en el documento base, verificado contra código real:** `assignDeferred()` (`reservation.service.ts`) toma su propio lock de fila internamente (`requireReservationWithLock`, su paso 1) pero **devuelve solo `updated` (`Promise<Reservation>`), nunca `locked`** (la entidad pre-mutación). El caller no tiene forma de comparar `locked.startTime/endTime` contra nada — ese dato nunca sale de `assignDeferred()`.

**Por qué no se puede resolver haciendo que el batch relea con lock él mismo, ANTES de llamar a `assignDeferred()`** (el patrón que sí usan `updateReservation()`/`completeReservation()` para su propio guard de coherencia): eso violaría N1 (recurso SIEMPRE antes que fila) — el batch necesita lockear el CANDIDATO primero (paso obligatorio, ya que "Auto Assign All" reclama inventario de verdad, a diferencia de check-in — ver el propio documento base, Hallazgo 2/Ronda 12). Si el batch lockeara la fila de la reserva ANTES del candidato para poder comparar fechas, reabriría exactamente el deadlock ABBA que `UPDATE-RESERVATION-LOCK-ORDER-001` (24/09/2026) ya cerró para `updateReservation()`.

**Resolución propuesta — extensión aditiva de `assignDeferred()`, mismo criterio ya usado en este archivo para `checkAvailability()`/`assertAllResourcesAvailable()` (parámetros opcionales nuevos sin tocar callers existentes):**

```ts
async assignDeferred(
  client: SqlClient,
  reservationId: string,
  resourceId: string,
  businessId: string,
  changedBy: string,
  expectedDateRange?: { startTime: Date; endTime: Date },   // NUEVO, opcional, 6to parámetro
): Promise<Reservation> {
  const locked = await this.requireReservationWithLock(client, reservationId);

  if (locked.assignmentStatus !== 'PENDING_ASSIGNMENT') {
    throw new ReservationAlreadyAssignedError(reservationId);
  }

  // NUEVO — paso 2.5, solo si el caller lo pide. Los otros 3 callers
  // (PUT, check-in, completar) nunca pasan este parámetro -- sin cambio
  // de comportamiento para ellos.
  if (
    expectedDateRange
    && (locked.startTime.getTime() !== expectedDateRange.startTime.getTime()
      || locked.endTime.getTime() !== expectedDateRange.endTime.getTime())
  ) {
    throw new ReservationConcurrentlyModifiedError(reservationId, 'cambió de fechas');
  }

  if (locked.status !== 'PENDING' && locked.status !== 'CONFIRMED') {
    // ... resto sin cambios
```

Se ubica DESPUÉS del re-chequeo de `assignmentStatus` (paso 2) y ANTES del allowlist de `status` (paso 3): si la reserva ya fue asignada por otra operación concurrente, ese es el error más informativo (`ReservationAlreadyAssignedError`) — "cambió de fechas" solo importa si todavía sigue siendo una `PENDING_ASSIGNMENT` genuina.

**Por qué esto es seguro para la rama "confirmar mismo recurso" y por qué, sin este parámetro, el gap real solo aparece ahí (verificado paso a paso):** en la rama de reasignación (`!isSameResource`), el propio paso 8 de `assignDeferred()` YA revalida disponibilidad con `locked.startTime/endTime` (fechas FRESCAS, no las que pasó el caller) — así que un cambio de fechas concurrente en esa rama ya queda blindado por el mecanismo existente, sin necesitar `expectedDateRange`. El gap real está en la rama "confirmar mismo recurso" (`isSameResource`): ahí los pasos 5-8 se saltean POR DISEÑO (documento base, paso 4: "si sí, los pasos 5 a 8 se saltean por completo... no se chequea disponibilidad de rango"), así que la ÚNICA validación de disponibilidad que corre es la explícita del batch (3.1, Paso A + el `assertAllResourcesAvailable` de la sección 3.4) — y esa validación usa `queuedReservation.startTime/endTime` (fechas potencialmente viejas). Sin `expectedDateRange`, un cambio de fechas concurrente (vía `PUT` puro sobre fechas, sin tocar `resourceId`, que la propia reserva sigue permitiendo mientras `PENDING_ASSIGNMENT`) podría dejar pasar una confirmación validada contra un rango que ya no es el vigente. `expectedDateRange` cierra exactamente este hueco, con el mismo texto de error que el documento base ya había reservado para este propósito.

### 3.4 Cuerpo completo por reserva (transacción única, recurso antes que fila — N1 sin excepciones)

```ts
for (const queuedReservation of pendingList) {   // SECUENCIAL, nunca Promise.all — ver 4.1
  try {
    const ownStillFree = await this.availability.checkAvailability(
      queuedReservation.resource.id, queuedReservation.startTime, queuedReservation.endTime,
      queuedReservation.id, queuedReservation.serviceId ?? undefined, queuedReservation.partySize,
    );

    let candidateResourceId: string;
    let outcome: 'CONFIRMED_SAME_RESOURCE' | 'REASSIGNED';

    if (ownStillFree) {
      candidateResourceId = queuedReservation.resource.id;
      outcome = 'CONFIRMED_SAME_RESOURCE';
    } else {
      const candidate = await this.availability.findAvailableResourceInCategory(
        { categoryId, startTime: queuedReservation.startTime, endTime: queuedReservation.endTime,
          ...(queuedReservation.serviceId && { serviceId: queuedReservation.serviceId }),
          partySize: queuedReservation.partySize },
        queuedReservation.id,
      );
      if (!candidate) {
        results.push({ reservationId: queuedReservation.id, outcome: 'FAILED', code: 'NO_RESOURCE_AVAILABLE', ... });
        continue;   // sin abrir transacción -- nada que lockear
      }
      candidateResourceId = candidate.id;
      outcome = 'REASSIGNED';
    }

    let assigned!: Reservation;
    await this.transactionManager.run(async (client: SqlClient) => {
      // PRIMERA sentencia dentro de la transacción -- lockea Y valida el
      // candidato, ANTES de lockear la fila (N1). Necesario incluso en la
      // rama CONFIRMED_SAME_RESOURCE porque assignDeferred() se salta su
      // propia validación cuando isSameResource (documento base, paso 4).
      //
      // C1 (corrección del gate) -- NO alcanza con lockear/validar solo
      // candidateResourceId: si la reserva tiene serviceId, ese servicio
      // puede tener resource_locks (recursos físicos compartidos) que
      // checkAvailability() SÍ valida (Paso A, arriba) pero que un
      // assertAllResourcesAvailable() acotado a un solo id NO cubre. Mismo
      // patrón que updateReservation() (reservation.service.ts, resolución
      // de lockSet antes de lockear): se resuelve el set completo de
      // recursos a lockear con resolveLockedResourceIds(), no un array de
      // un solo elemento.
      const lockSet = await this.availability.resolveLockedResourceIds(
        queuedReservation.serviceId ?? undefined, candidateResourceId,
      );
      await this.availability.assertAllResourcesAvailable(
        client, [...lockSet].sort(), queuedReservation.startTime, queuedReservation.endTime,
        queuedReservation.id, queuedReservation.partySize,
      );

      assigned = await this.assignDeferred(
        client, queuedReservation.id, candidateResourceId, businessId, changedBy,
        { startTime: queuedReservation.startTime, endTime: queuedReservation.endTime },   // F3-6
      );
    });

    // (N1, v3) recordOccupancy() corre en su PROPIO try/catch, fuera del
    // try que rodea la transacción -- si falla acá, la reserva YA quedó
    // ASSIGNED (commit ya ocurrió), así que reportarla FAILED sería
    // mentir: una re-corrida del batch no la vuelve a ver (ya no es
    // PENDING_ASSIGNMENT) y el hueco de ocupación quedaría perdido para
    // siempre sin que nada lo señale. En vez de eso, el outcome real
    // (CONFIRMED_SAME_RESOURCE/REASSIGNED) se reporta igual, con
    // `occupancyRecorded: false` y un log de error -- una reconciliación
    // manual (ya existe la necesidad para otros casos de
    // `recordOccupancy()`, no es un mecanismo nuevo de esta Fase) puede
    // corregir el contador después, sin reprocesar la reserva.
    let occupancyRecorded = true;
    try {
      await this.recordOccupancy(assigned);   // post-commit, mismo patrón que checkIn()
    } catch (err) {
      occupancyRecorded = false;
      logger.error('auto-assign-all: recordOccupancy falló post-commit', { reservationId: queuedReservation.id, err });
    }
    results.push({
      reservationId: queuedReservation.id, outcome,
      previousResourceId: queuedReservation.resource.id, newResourceId: assigned.resource.id,
      ...(!occupancyRecorded && { occupancyRecorded: false }),
    });

  } catch (err) {
    results.push(classifyFailure(queuedReservation.id, queuedReservation.resource.id, err));
    // NO relanza -- sigue con la siguiente reserva del batch (ver 4.2)
  }
}
```

`classifyFailure()` distingue `ReservationAlreadyAssignedError` (→ `SKIPPED_ALREADY_ASSIGNED`, no es realmente un "fallo" del batch, es una carrera benigna con otra operación) del resto de `DomainError` (→ `FAILED`, con `code`/`message` del error real) y de un error no tipado (→ `FAILED`, `code: 'INTERNAL_ERROR'`, logueado, sin exponer detalle interno en la respuesta).

### 3.5 Orden de locks — tabla, para consistencia con §8 A6.1 del documento base

| Paso | Qué lockea | Con qué mecanismo |
|---|---|---|
| 1 | Recurso candidato (`candidateResourceId`) | `assertAllResourcesAvailable()` propio del batch — su `lockByIds()` interno (verificado, `reservation-availability.service.ts`) |
| 2 | Fila de la reserva | `assignDeferred()`, su paso 1 (`requireReservationWithLock`) |
| 3 (solo si `!isSameResource`, dentro de `assignDeferred()`) | Recurso candidato, de nuevo | No-op — Postgres permite `FOR UPDATE` repetido sobre la misma fila en la misma transacción, mismo criterio ya documentado para el resto de los 4 callers |

Nunca se lockea la fila antes que el recurso — sin excepción, mismo invariante N1 que ya rige los otros 3 callers.

---

## 4. Transacciones y concurrencia

### 4.1 Una transacción por reserva, SECUENCIAL — no una transacción gigante, no `Promise.all`

Confirma explícitamente lo que el documento base ya decidía ("Cada reserva se procesa en su PROPIA transacción, nunca una transacción gigante para todo el batch") y agrega el motivo de por qué tiene que ser SECUENCIAL (no paralelizado dentro del mismo batch, aunque cada item sea su propia transacción):

1. **Correctitud no depende del orden** — cada transacción revalida bajo lock, así que aunque dos items del batch compitieran por el mismo recurso alternativo, el segundo simplemente fallaría su propia validación (paso 1, sección 3.4) y se reportaría `FAILED`/`InvalidReservationError`, sin corromper nada.
2. **Pero la CALIDAD del resultado sí depende del orden.** Si se resolvieran los candidatos de las N reservas ANTES de abrir cualquier transacción (resolución "por adelantado"), dos reservas que necesitan reasignación (rama fallback) podrían resolver el MISMO alternativo (ambas lecturas sin lock, ambas ven "libre" el mismo recurso) — la segunda fallaría en su propia transacción con un `InvalidReservationError` espurio, aunque hubiera OTRO recurso libre que sí le hubiera servido. Procesando estrictamente secuencial — resolver candidato de la reserva N solo cuando la transacción de la reserva N-1 ya hizo commit (o abortó) — la resolución del fallback para la reserva N ve el estado REAL después de que N-1 ya reclamó lo que reclamó. Esto no es un requisito de correctitud (3.4 sigue siendo seguro sin esto) — es una decisión de **calidad del batch**, para minimizar fallos espurios por auto-competencia dentro de la misma corrida.

### 4.2 Falla de una reserva individual — el batch sigue, no aborta

Explícito, siguiendo el criterio del propio documento base ya citado en 3.4/4.1: cada `catch` por reserva captura el error, lo clasifica, y el `for` continúa con la siguiente. El batch como operación HTTP **siempre responde 200** con un reporte estructurado — nunca propaga el error de un item individual como el error HTTP del endpoint completo (eso sería indistinguible de "todo el batch falló" para el frontend). Los únicos errores que si abortan la llamada completa (antes de tocar cualquier reserva) son los de validación de entrada: `categoryId` inválido (Zod, 400), categoría inexistente (404), categoría no-alojamiento (422) — igual que `GET /availability-by-category`.

### 4.3 Idempotencia natural — reintentar el batch completo es seguro

No hace falta ninguna clave de idempotencia nueva (a diferencia de lo que `docs/pendientes-2026-09-12.md`/D-10 exige para escrituras de dinero vía `TransactionManager.run()`, citado en el docblock de `transaction-manager.ts`): la query de entrada (`getPendingAssignmentByCategory`) siempre refleja el estado ACTUAL de la BD en el momento en que se llama. Una reserva que un batch anterior ya dejó `ASSIGNED` simplemente no aparece en la lista de una corrida posterior — nunca se vuelve a tocar (mismo comportamiento ya declarado en el documento base). Llamar al endpoint dos veces seguidas es seguro por construcción, sin necesitar ningún mecanismo adicional.

### 4.4 Concurrencia contra OTRAS operaciones (fuera del propio batch)

Sin cambios respecto de lo ya declarado por el documento base para `assignDeferred()` en general — se hereda, no se reinventa:
- Contra otro `PUT`/check-in/completar sobre la MISMA reserva: capturado por el re-chequeo de `assignmentStatus` (paso 2 de `assignDeferred()`) → `ReservationAlreadyAssignedError`, clasificado como `SKIPPED_ALREADY_ASSIGNED`.
- Contra un check-in concurrente sobre el recurso candidato (vía `stays`, no `reservations`): **limitación de concurrencia ya declarada y aceptada por el documento base** ("Defensa en profundidad... sin cerrar la carrera contra un check-in concurrente") — Auto Assign All la hereda sin empeorarla (mismo mecanismo, mismo hueco, no uno nuevo).
- Contra otra corrida CONCURRENTE de "Auto Assign All" sobre la MISMA categoría (dos managers apretando el botón a la vez): cada reserva sigue siendo su propia transacción con el mismo orden de locks — Postgres serializa el acceso al recurso candidato compartido; el segundo batch, para cualquier reserva que el primero ya haya tocado, ve `assignmentStatus = 'ASSIGNED'` bajo lock y la reporta `SKIPPED_ALREADY_ASSIGNED`. Sin condición de carrera real, solo trabajo redundante (aceptable, no se optimiza acá).

---

## 4.5 Correcciones del gate de diseño (v2) — C3, C5, C6, C7, H3

**C3 — latencia, tope y timeout, declarados explícitamente.** Con el
alcance acotado a "llegadas de hoy" (v2), el volumen esperado por
categoría es chico en la práctica (las llegadas de un solo día, no todo
el futuro) — el tope de `RESERVATIONS_MAX_LIMIT` (200) sigue existiendo
como red de seguridad, no como límite que se espere alcanzar
normalmente. Cada item del batch hace, como mínimo: 1 `checkAvailability()`
(Paso A) + opcionalmente 1 `findAvailableResourceInCategory()` (Paso B,
que a su vez escanea candidatos de la categoría) + 1 transacción
(`resolveLockedResourceIds` + `assertAllResourcesAvailable` +
`assignDeferred` con su propio lock+read+write) + 1 `recordOccupancy()`
post-commit — varios round-trips a Postgres por item, secuencial (4.1).
**Si el request HTTP hace timeout antes de que el batch termine:** el
servidor sigue procesando la corrida en el `event loop` de Node
(`autoAssignAllForCategory()` no se cancela por un timeout del lado del
cliente/proxy) — el cliente no recibe la respuesta, pero las
transacciones que ya se commitearon quedan commiteadas (4.3, idempotente).
Un segundo click del staff dispara un batch NUEVO y concurrente, que por
4.4 no corrompe nada — trabajo redundante posible, no un bug.

**C5 — declarado en la sección 10:** si la provisoria de una reserva
pasó el Paso A (optimista, sin lock) pero resulta tomada al llegar el
lock real (otra transacción la ganó en el medio), el item se reporta
`FAILED` — **no hay fallback dentro de la misma corrida** (no se
reintenta con `findAvailableResourceInCategory()` para esa reserva en
este mismo batch). Consistente con F3-4: la decisión fue "confirmar la
provisoria si sigue libre", no "encontrar como sea una habitación para
cada reserva a cualquier costo". El staff puede volver a correr el
batch — en la corrida siguiente, esa reserva SÍ entra por el Paso B
(su provisoria ya no está libre, el chequeo A da negativo de entrada).
**Dónde loguea `classifyFailure()`:** `ReservationService` no tiene
`logger` inyectado hoy — se agrega `import { logger } from '../logger.js'`
(mismo módulo compartido que ya usan `invoice.service.ts`,
`accounts-receivable.service.ts` y los workers) — sin agregar una
dependencia de constructor nueva, es un import de módulo, no un
parámetro.

**C6 — `requireModule(ModuleKey.ALOJAMIENTO)`, decisión explícita: SÍ.**
Mismo criterio que las rutas de `schedule-request` (que sí lo tienen) —
esta ruta solo tiene sentido para negocios con el módulo de alojamiento
habilitado, y el propio scope de la Fase 3 completa es "solo
alojamiento". `GET /availability-by-category` es la excepción
(no lo tiene) por ser de solo lectura; `POST /auto-assign-all` escribe
y reasigna reservas reales, así que se alinea con el criterio más
estricto de las rutas de escritura del módulo.

**C7 — segundo productor de cambios de fecha concurrentes, agregado a
la matriz de impacto (§9):** además del `PUT /reservations/:id` del
panel, el portal de clientes (`PUT /api/customer/me/reservations/:id`,
`api/routes/customer.routes.ts`) también puede cambiar `startTime`/`endTime`
de una reserva `PENDING_ASSIGNMENT` propia sin tocar `resourceId` — el
guard F3-6 (`expectedDateRange`) lo cubre de forma genérica (no le
importa si el cambio vino del panel o del portal), pero se nombra acá
para que la matriz de impacto no lo omita como si solo existiera un
productor.

**H3 — artefactos manuales que faltaban (corrección completa):**
1. `src/tests/architecture/route-consumer-coverage.test.ts`,
   `NO_CONSUMER_ROUTES` (el 11vo artefacto manual del repo) — agregar
   `/api/reservations/auto-assign-all` con motivo ("Fase 3 de 4.3,
   backend-only en este bloque — sin consumidor en `appfrontend-main`
   todavía, ver sección de alcance más abajo").
2. `docs/rbac-matriz-endpoints.md` — encabezado "222 call-sites, 39
   archivos" → "223 call-sites, 39 archivos" (mismo archivo, no gana un
   archivo nuevo). Bullet nuevo en formato PARSEABLE (backticks,
   requisito de `rbac-matrix-section2-sync.test.ts`), **(N3, agregado)
   con la nota de `requireModule` igual que las filas vecinas de
   `schedule-request`:**
   `` - POST `/auto-assign-all` — `MANAGEMENT` (`requireModule(ALOJAMIENTO)`; Fase 3, docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md — operación masiva, más restrictivo que PUT/:id individual) ``.
3. `/home/user/app/CLAUDE.md` — la cita "17 de 270" (sección Contratos)
   pasa a "17 de 271" **en el mismo commit que produce el delta** (270→271
   de `docs/inventario-rutas.md`), siguiendo la convención ya establecida
   en ese mismo documento para las 7 correcciones anteriores de esta cita.
4. Docblocks desactualizados a corregir en el mismo commit:
   - `reservation.service.ts` (docblock cerca de `assignDeferred()`,
     confirmado por el gate en líneas ~1446-1449 contra HEAD `05542b5`,
     re-verificar la línea real al implementar) — decía "Auto Assign All
     (Fase 3, no implementada)", pasa a listar el método real.
   - `pms-estadias/maintenance-window.service.ts` (docblock que lista
     "los 5 sitios reales" de `assignDeferred()` vía sus 3 callers,
     confirmado por el gate en líneas ~205-217 contra HEAD) — el batch es
     un 4to caller y otro sitio de lock de recurso, hay que agregarlo a
     esa lista.
   - **(N2, agregado) `reservations.routes.ts:35-39`** — el docblock del
     archivo dice que las 3 rutas de `schedule-request` son las únicas de
     este router con `requireModule(...)` ("a diferencia del resto").
     Con esta ruta nueva (C6: SÍ lleva `requireModule(ALOJAMIENTO)`) pasan
     a ser 4 — ese párrafo queda desactualizado apenas se agrega la ruta,
     no es una deuda preexistente: se corrige en el mismo commit.
5. **Backend-only, declarado explícitamente:** este bloque NO agrega
   ningún consumidor en `appfrontend-main` — ninguna pantalla llama
   todavía a este endpoint. Conectarlo a una acción real de UI ("Auto
   Assign All" como botón en la pantalla de reservas/categoría) es un
   bloque de producto aparte, no decidido ni diseñado acá.

---

## 5. Respuesta del endpoint

```ts
export interface AutoAssignAllItemResult {
  reservationId: string;
  previousResourceId: string;
  outcome: 'CONFIRMED_SAME_RESOURCE' | 'REASSIGNED' | 'SKIPPED_ALREADY_ASSIGNED' | 'FAILED';
  newResourceId?: string;     // presente si CONFIRMED_SAME_RESOURCE (== previousResourceId) o REASSIGNED
  code?: string;              // presente si SKIPPED_ALREADY_ASSIGNED o FAILED -- el `code` del DomainError real
  message?: string;           // idem -- nunca datos de cliente (mismo criterio de logging que error.middleware.ts, A7.1)
  occupancyRecorded?: false;  // (N1, v3) presente y en `false` SOLO si la transacción hizo commit pero recordOccupancy() post-commit falló -- nunca aparece en `true` (el caso normal no necesita el campo), nunca aparece junto con FAILED/SKIPPED_ALREADY_ASSIGNED
}

export interface AutoAssignAllResult {
  categoryId: string;
  categoryName: string;
  totalPending: number;               // (B1, v3) filtered.length -- cuántas filas pasaron el filtro EXACTO de capa 2 (deriveCalendarDate === hoy), NUNCA el conteo aproximado de SQL
  processed: number;                  // min(totalPending, RESERVATIONS_MAX_LIMIT) -- sobre el totalPending ya exacto
  truncated: boolean;                 // true si totalPending > processed, o si el LIMIT de seguridad de la capa SQL (1000) se alcanzó -- honest-degradation, nunca implícito
  confirmedSameResource: number;
  reassigned: number;
  skippedAlreadyAssigned: number;
  failed: number;
  items: AutoAssignAllItemResult[];
}
```

**(B1, v3) `countPendingAssignmentByCategory()` se elimina de este diseño** (existía en v2, §7 ítem 3) — con `totalPending` derivado de `filtered.length` (las filas ya exactas de capa 2), un conteo SQL aproximado separado queda redundante y era la fuente directa de la contradicción que encontró el gate: un conteo aproximado (capa 1, sobre-inclusivo por diseño) no puede servir de base para `truncated` sin mentir en el caso común de "mañana tiene PENDING_ASSIGNMENT pero hoy no llega a 200". Ver §7 ítem 3 para el detalle de qué reemplaza al método eliminado.

`res.status(200).json(result)` siempre — los contadores/`items[]` son los que le dicen al frontend qué pasó. El frontend puede mostrar un resumen ("18 confirmadas en su misma habitación, 3 reasignadas, 1 sin habitación disponible") y, si `truncated`, un aviso de "quedan N reservas más — volvé a correr esta acción para procesarlas".

---

## 6. RBAC — actualización de los artefactos manuales (mismo criterio que el resto del repo, `CLAUDE.md`)

1. **`docs/rbac-matriz-endpoints.md`, sección 2** — agregar bullet bajo `reservations.routes.ts`, en formato PARSEABLE (backticks, requisito real de `rbac-matrix-section2-sync.test.ts` — la v1 de este documento tenía el bullet sin backticks, corregido), **(N3, agregado) con la nota de `requireModule`:**
   `` - POST `/auto-assign-all` — `MANAGEMENT` (`requireModule(ALOJAMIENTO)`; Fase 3, docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md — operación masiva de asignación diferida, más restrictivo que PUT/:id individual por ser irreversible-action-gate) ``
   y actualizar el encabezado "222 call-sites, 39 archivos" → "223 call-sites, 39 archivos" (mismo archivo, no gana uno nuevo).
2. **`src/tests/security/rbac-matrix-sync.test.ts`** — `EXPECTED_AUTHORIZE_CALL_SITES` pasa de 222 a 223 (un `authorize()` call-site nuevo, verificado: hoy es 222 según el propio encabezado de la matriz).
3. **`src/tests/architecture/rbac-matrix-section2-sync.test.ts`** — no requiere cambio manual (usa enumeración real de rutas contra bullets parseables; `reservations.routes.ts` no está en `EXCLUDED_FILES`, así que el bullet nuevo de (1), YA en formato parseable, es obligatorio para que esta cerca siga verde).
4. **`docs/inventario-rutas.md`** — regenerar (`npm run docs:routes`): +1 ruta nueva en el árbol vivo (no es un `CLOSURE_MOUNTS`, `reservations.routes.ts` monta con `app.use(prefix, routerFn(...))` normal) — 270 → 271, mismo criterio que las 7 correcciones anteriores documentadas en `CLAUDE.md`.
5. **`/home/user/app/CLAUDE.md`** — la cita "17 de 270" (sección Contratos) → "17 de 271", en el MISMO commit que produce el delta de (4) — condición H3 del gate, la v1 de este documento no lo incluía en el checklist.
6. **`src/tests/architecture/route-consumer-coverage.test.ts`** — agregar `/api/reservations/auto-assign-all` a `NO_CONSUMER_ROUTES` (el 11vo artefacto manual), motivo: backend-only en este bloque, sin consumidor en `appfrontend-main` todavía (§4.5, punto 5).
7. **`src/openapi/spec.ts`** — no se toca. Mismo criterio que `GET /availability-by-category` (Fase 0): no se agrega a los 17/271 documentados, el numerador no se mueve.
8. **`docs/rbac-matriz-endpoints.md` — verificación cruzada obligatoria antes de commitear:** correr `EXPECTED_AUTHORIZE_CALL_SITES` y confirmar que el conteo real de `authorize(Roles.X)` en el árbol coincide, y que `rbac-route-coverage.test.ts` no necesita un allowlist nuevo (la ruta SÍ tiene `authorize()` propio, no cae en `PUBLIC_ROUTES`).

No hace falta tocar `PRE_AUTH_API_MOUNTS`, `OWNERSHIP_EXEMPT`, `ESCAPE_ROUTES`, `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT`, ni ningún otro allowlist de los 13 artefactos manuales del repo — esta ruta no es pública, no es parte del escape de Nota de Crédito, no toca facturación.

---

## 7. Cambios de código — checklist de implementación (orden sugerido)

1. `src/reservas/reservation-availability.service.ts` — `findAvailableResourceInCategory()` gana `excludeReservationId?: string` (F3-2, §3.2).
2. `src/reservas/reservation.service.ts` — `assignDeferred()` gana `expectedDateRange?: { startTime: Date; endTime: Date }` (F3-6, §3.3), sin tocar los 3 callers existentes (parámetro opcional, comportamiento idéntico si se omite).
3. `src/reservas/reservation.repository.ts` (interfaz) + `sql.reservation.repository.ts` (implementación) + `in-memory.reservation.repository.ts` (para paridad de tests) — **un** método nuevo (**B1, v3: `countPendingAssignmentByCategory()` de v2 se elimina, ver más abajo**):
   - `getPendingAssignmentByCategory(categoryId: string, todayWindow: { from: Date; to: Date }, safetyLimit: number): Promise<Reservation[]>` — `WHERE r.assignment_status = 'PENDING_ASSIGNMENT' AND r.status IN ('PENDING', 'CONFIRMED') AND r.start_time BETWEEN $2 AND $3 AND EXISTS (SELECT 1 FROM resources res WHERE res.id = r.resource_id AND res.category_id = $1) ORDER BY r.start_time ASC, r.id ASC LIMIT $4` — mismo patrón EXISTS ya usado por `buildWhereClause()` para el filtro `isLodging` (reusa el idioma, no inventa uno nuevo). `todayWindow` es la ventana SQL sobre-inclusiva de 3 días de §2.2 (capa 1) — el filtrado exacto por fecha de negocio (capa 2, `deriveCalendarDate()`) corre después, en el service, no en el repositorio. **`safetyLimit` (B1, v3) es `RESERVATIONS_MAX_LIMIT * 5` = 1000, NO el tope operativo de 200** — es una red de seguridad contra un volumen anormal en la ventana de 3 días, no el límite que separa "procesado" de "truncado" (eso se calcula en el service, después del filtro exacto de capa 2, sobre `filtered.length`).
   - **C2 (corrección del gate):** el mapeo de filas usa `rowsToReservations()` (el mapper batch, D-17, ya existente) — **no** `rowToReservation()` fila por fila, que con hasta 1000 resultados dispararía cientos de queries adicionales (N+1). Mismo criterio de performance ya aplicado en el resto del repositorio para listados.
   - **(B1, v3) `countPendingAssignmentByCategory()` (v2) se elimina.** Era un conteo SQL aproximado (capa 1, sin el filtro exacto de capa 2) que el service usaba para dimensionar `totalPending`/`truncated` — el gate encontró que esto contradecía directamente la definición de esos campos en §5 (que ya decían "exacto, post-filtro-JS") y que, usado tal cual, producía `truncated: true` cada vez que HOY tenía menos de 200 pero MAÑANA (dentro de la ventana de 3 días) tenía alguna — un falso positivo en el caso común. `totalPending` se deriva ahora directo de `filtered.length` (§5), sin ningún método de conteo separado — no hace falta un segundo round-trip a Postgres para esto, la única fuente es la lista que `getPendingAssignmentByCategory()` ya trajo.
   - Se agrega como método de propósito específico en la interfaz (mismo criterio que `getApprovedLateCheckoutsForDate()`/`getPendingWithExpiredDeposit()`, ya existentes ahí) — NO se fuerza a `ReservationFilters`/`getFiltered()`, porque ese contrato solo admite un `status` singular, no `IN (...)`.
4. `src/reservas/reservation.service.ts` — método público nuevo `autoAssignAllForCategory(categoryId: string, businessId: string, changedBy: string): Promise<AutoAssignAllResult>` (§3.4/§5), usando `this.reservationRepository`, `this.availability`, `this.transactionManager`, `this.assignDeferred()`, **(N3, agregado) `this.businessProfileRepository`** (resuelve `businessProfile.timezone` para `todayInBusinessTimezone()`/`deriveCalendarDate()`, §2.2) **y `this.categoryRepository`** (resuelve `categoryName` para la respuesta, §5 — el mismo repositorio que el handler ya usa para el 404/422 de §2.2, reenviado al service en vez de resuelto dos veces) — todos ya son campos existentes de la clase, **sin ningún cambio de constructor ni de wiring en `container.ts`/`reservations.routes.ts::buildReservationService()`** (verificado: no se agrega ninguna dependencia nueva).
5. `src/api/schemas/request.schemas.ts` — `AutoAssignAllSchema` (§2.3).
6. `src/reservas/reservations.routes.ts` — ruta nueva `POST /auto-assign-all` (§2), + actualizar el docblock de permisos del archivo (líneas 4-33, mismo patrón que cada endpoint nuevo ya documenta ahí) **+ el párrafo de líneas ~35-39 (N2: "3 rutas module-gated" → 4, ver §4.5 H3 punto 4)** + `docs/rbac-matriz-endpoints.md` (§6).
7. `src/tests/security/rbac-matrix-sync.test.ts` — `EXPECTED_AUTHORIZE_CALL_SITES` 222 → 223.
8. Regenerar `docs/inventario-rutas.md` (`npm run docs:routes`) — 270 → 271.
9. Tests (§8).

---

## 8. Test plan

### 8.1 Unit — `reservation.service.test.ts` (mocks)

- `autoAssignAllForCategory()`: reserva con provisoria libre → `checkAvailability()` llamado con `excludeReservationId`, `findAvailableResourceInCategory()` **NO** llamado, `assignDeferred()` llamado con el MISMO `resourceId`.
- Reserva con provisoria ocupada → `findAvailableResourceInCategory()` llamado con `excludeReservationId`, `assignDeferred()` llamado con el candidato alternativo.
- `findAvailableResourceInCategory()` devuelve `null` → item `FAILED`/`NO_RESOURCE_AVAILABLE`, sin llamar a `transactionManager.run()` para ese item.
- Reserva ya `ASSIGNED` (carrera con otra operación) → `assignDeferred()` lanza `ReservationAlreadyAssignedError` → item `SKIPPED_ALREADY_ASSIGNED`, el batch sigue con la siguiente (verificar que se llama `transactionManager.run()` para el ítem SIGUIENTE de la lista).
- `expectedDateRange` mismatch (mock de `assignDeferred` simulado, o test directo del método) → `ReservationConcurrentlyModifiedError('cambió de fechas')` → item `FAILED`.
- `totalPending` > `RESERVATIONS_MAX_LIMIT` → `truncated: true`, `processed === RESERVATIONS_MAX_LIMIT`.
- Categoría sin ninguna `PENDING_ASSIGNMENT` → `processed: 0`, `items: []`, sin ningún error.
- **(C4) `assignDeferred()` — test directo del guard F3-6**, en el describe ya existente de este método (`reservation.service.test.ts`, sección "Fase 2 — asignación diferida"): con `expectedDateRange` que NO coincide con `locked.startTime/endTime` → `ReservationConcurrentlyModifiedError('cambió de fechas')`. Sin pasar el parámetro (como hacen los 3 callers existentes) → comportamiento idéntico a hoy (regresión). `ALREADY_ASSIGNED` gana precedencia sobre "cambió de fechas" cuando ambas condiciones se dan a la vez (paso 2 corre antes que 2.5).

### 8.2 Unit — `reservation-availability.service.test.ts`

- `findAvailableResourceInCategory({categoryId, ...}, excludeReservationId)` — la propia reserva excluida no bloquea su propio candidato (regresión directa de F3-2, mismo caso que motivó el fix).
- Sin `excludeReservationId` (call-site de creación) — comportamiento IDÉNTICO al actual (regresión, ningún cambio para `POST /reservations`).

### 8.3 Integración — nuevo archivo `src/tests/integration/reservation-auto-assign-all.integration.test.ts` (mismo patrón que `reservation-deferred-assignment.integration.test.ts`, 2 clientes Postgres reales donde haga falta)

- **Confirma la misma provisoria:** categoría con 1 `PENDING_ASSIGNMENT` cuya provisoria sigue libre → tras el batch, `assignmentStatus = 'ASSIGNED'`, `resource_id` SIN CAMBIAR, ocupación registrada EXACTAMENTE una vez (mismo assert de "ocupación EXACTA" que ya usa el archivo de Fase 2).
- **Reasigna cuando la provisoria se ocupó:** dos reservas de la misma categoría, la primera confirma su recurso (vía `PUT` o `assignDeferred` directo) sobre lo que era la provisoria de la segunda → correr el batch sobre la segunda → termina en OTRO recurso de la categoría, ocupación exacta en el nuevo, cero en el viejo.
- **(C4, corregido) Batch con una reserva que falla no aborta las demás:** 3 reservas `PENDING_ASSIGNMENT`. La lista de entrada (`getPendingAssignmentByCategory`) se lee PRIMERO; recién DESPUÉS de esa lectura se cancela la reserva del medio (para que SÍ entre en `pendingList` y el batch la procese y falle contra ella, en vez de desaparecer de la lista antes de empezar — la v1 de este test estaba mal: cancelar ANTES de correr el batch hace que esa reserva nunca aparezca, así que `processed` no cuenta 3). **Mecanismo concreto para "cancelar DESPUÉS de la lectura, ANTES de que el batch la procese" (faltaba en v2):** un spy de Vitest envolviendo `reservationRepository.getPendingAssignmentByCategory` con `mockImplementationOnce` que, tras llamar a la implementación real y obtener las 3 filas, ejecuta el `UPDATE reservations SET status='CANCELLED'` de la reserva del medio (cliente Postgres directo, commiteado) antes de devolver el array al caller — así el `for` de 3.4 ve la reserva en `pendingList` pero, al abrir su transacción y relockearla en `assignDeferred()`, la encuentra `CANCELLED` (`status !== 'PENDING'/'CONFIRMED'`, guard de paso 3) y falla con `InvalidReservationError`. Con la reserva ya `CANCELLED` en el momento en que el batch la procesa → la 1 y la 3 terminan `ASSIGNED`, la 2 aparece `FAILED` en `items[]`, `processed` cuenta las 3.
- **(C4, corregido) `expectedDateRange`/F3-6 — cambio de fechas concurrente durante el batch.** La v2 tenía los pasos en un orden que no podía ocurrir en la práctica (el `PUT` real esperaría el lock del recurso que el batch ya tiene, nunca llegaría a la ventana). Dos formas correctas, cualquiera de las dos alcanza:
  - **(a) Mismo mecanismo de spy que el caso anterior:** envolver `getPendingAssignmentByCategory` para, tras leer las filas, ejecutar un `PUT` real (vía el service, panel o portal — C7) que cambia `startTime`/`endTime` de esa reserva puntual SIN tocar `resourceId`, commiteado, ANTES de devolver el array — el batch procesa esa reserva con datos ya viejos en `queuedReservation`, abre su transacción, relockea, y encuentra `locked.startTime/endTime` distinto de lo que traía → `RESERVATION_CONCURRENTLY_MODIFIED`/`'cambió de fechas'`.
  - **(b) Patrón determinístico de bloqueo real** (`reservation-deferred-assignment.integration.test.ts:505-580`, `connA` + `BEGIN` manual + `waitUntilBlockedBy(pid)`): `connA` ejecuta un `UPDATE reservations SET start_time/end_time WHERE id = ...` SIN COMMIT y mantiene la fila lockeada; el batch, al llegar a `assignDeferred()` → `requireReservationWithLock()` para esa reserva, queda bloqueado esperando el lock (`waitUntilBlockedBy(pidDeConnA)`); recién ahí `connA` hace `COMMIT`; el batch se desbloquea, relee bajo su propio lock, encuentra el `startTime/endTime` que `connA` ya commiteó, distinto del que traía en `queuedReservation` → mismo resultado que (a).
  - Cualquiera de las dos: las demás reservas del batch no se ven afectadas (siguen su propio `for`, sección 4.2).
- **(C4, corregido) Concurrencia — dos batches simultáneos sobre la misma categoría**, con el patrón determinístico ya usado por la Fase 2 (`reservation-deferred-assignment.integration.test.ts:505-580`: `connA` + `BEGIN` manual + `waitUntilBlockedBy(pid)`), no un simple `Promise.all` de dos llamadas al service (no determinístico, puede no ejercitar la carrera real). **Invariantes corregidas (v2 tenía 2 mal — el gate las marcó falsas):**
  1. Al terminar los dos batches, la BD queda con exactamente 1 fila de ocupación por reserva procesada (nunca 0 ni 2) — invariante sobre el ESTADO FINAL, no sobre los reportes.
  2. A lo sumo un resultado de ÉXITO (`CONFIRMED_SAME_RESOURCE`/`REASSIGNED`) por reserva, contando los dos reportes combinados — **no** "exactamente un resultado" (v2, falso: si los dos batches leyeron la lista antes de que cualquiera hiciera commit, la misma reserva puede aparecer en los dos reportes — una vez como éxito y otra como `SKIPPED_ALREADY_ASSIGNED` — eso es esperado, no un bug).
  3. Cero ítems con `code: 'INTERNAL_ERROR'` en cualquiera de los dos reportes — **no** "sin ningún `40P01` en los logs de Postgres" (v2, no verificable desde el test: un deadlock real, si ocurriera, lo captura `classifyFailure()` como `FAILED`/`INTERNAL_ERROR` sin relanzar, así que la señal correcta y verificable es que ese código nunca aparezca, no inspeccionar logs del servidor).
- **Cap de 200 (`truncated`):** crear 201 reservas `PENDING_ASSIGNMENT` de la misma categoría (fixture pesado, puede correr con un límite bajado vía inyección de constante en el test si el repo ya tiene ese patrón — si no, documentarlo como test manual/QA, no bloqueante para el gate) → `processed = 200`, `truncated = true`.

### 8.4 Rutas — `reservations.routes.test.ts`

- `POST /auto-assign-all` sin `Roles.MANAGEMENT` → 403 (mismo patrón que el resto de rutas `MANAGEMENT`-only).
- `categoryId` faltante → 400 (Zod).
- Categoría inexistente → 404. Categoría no-lodging → 422 `CATEGORY_NOT_LODGING` (mismo patrón que `availability-by-category.routes.test.ts`, si existe, o el describe correspondiente en `reservations.routes.test.ts`).
- Happy path → 200, shape de `AutoAssignAllResult` completo.

### 8.5 Cercas de arquitectura/RBAC — correr, no escribir nuevas

`rbac-matrix-sync.test.ts`, `rbac-route-coverage.test.ts`, `rbac-matrix-section2-sync.test.ts`, `rbac-matrix-public-routes-sync.test.ts`, `openapi-spec-route-sync.test.ts` — ninguna necesita un allowlist nuevo para esta ruta (no es pública, no es parte de ningún escape fiscal, no está en ningún `EXCLUDED_FILES`); alcanza con que sigan verdes tras el cambio de (6)/(7) de la sección 7.

---

## 9. Matriz de impacto

| Archivo / call-site | Qué asume hoy | Impacto de Fase 3 |
|---|---|---|
| `reservation-availability.service.ts::findAvailableResourceInCategory()` | `excludeReservationId` fijo en `undefined` | Gana parámetro opcional (F3-2) — el único call-site existente (creación) no cambia comportamiento |
| `reservation.service.ts::assignDeferred()` | 5 parámetros, sin acceso externo a `locked` | Gana 6to parámetro opcional `expectedDateRange` (F3-6) — los 3 callers existentes (PUT, check-in, completar) no lo pasan, comportamiento idéntico |
| `reservation.repository.ts` (interfaz) + 2 implementaciones (`sql.`/`in-memory.`) | Sin ningún finder por `categoryId + assignmentStatus` | 1 método nuevo (`getPendingAssignmentByCategory`), puramente aditivo — (B1, v3) `countPendingAssignmentByCategory` de v2 se eliminó, ver §7 ítem 3 |
| `reservations.routes.ts` | 17 rutas documentadas en su docblock | +1 ruta, +1 `authorize()` call-site |
| `docs/rbac-matriz-endpoints.md`, `EXPECTED_AUTHORIZE_CALL_SITES`, `docs/inventario-rutas.md` | 222 / 222 / 270 | 223 / 223 / 271 |
| `container.ts`, `buildReservationService()` | Wiring actual de `ReservationService` | **Sin cambios** — ninguna dependencia nueva en el constructor |
| `src/pms-estadias/maintenance-window.service.ts` | (N2, corregido — v2 decía "sin impacto") Docblock lista "los 5 sitios reales" que lockean el recurso vía `assignDeferred()`, contando 3 callers | (H3 punto 4) El batch es un 4to caller — se agrega a esa lista. Sin cambio de código, solo del docblock. `src/pms-estadias/` en general (código, no docs) sigue sin ningún call-site nuevo — hereda el que `assignDeferred()` ya tiene (`StayRepository.findActiveByResource`, paso 7, solo en la rama `!isSameResource`) |
| `src/facturacion/` | — | **Sin impacto** — sin cambios de ningún tipo, ni de código ni de docs |
| `src/tests/architecture/route-consumer-coverage.test.ts` | (N2, agregado — faltaba en v2) `NO_CONSUMER_ROUTES` sin esta ruta | +1 entrada (H3 punto 1, §4.5/§6.6) |
| `/home/user/app/CLAUDE.md` | (N2, agregado — faltaba en v2) cita "17 de 270" | "17 de 270" → "17 de 271" en el mismo commit del delta (H3 punto 3, §4.5/§6.5) |
| `src/openapi/spec.ts` | 17/270 documentados | Sin cambios (mismo criterio que Fase 0) |

---

## 10. Casos borde declarados, no bugs

- **Candidato del fallback coincide, por casualidad, con el recurso actual** (la provisoria se liberó de nuevo entre el Paso A y el Paso B, ambos sin lock): `assignDeferred()` lo trata como `isSameResource=true` internamente — resultado idéntico a `CONFIRMED_SAME_RESOURCE`, sin error. Se reporta igual como `outcome: 'REASSIGNED'` en la respuesta (porque el batch decidió por esa rama), aunque el recurso final sea el mismo — cosmético, no un bug; se documenta para que no sorprenda en un test.
- **Check-in concurrente sobre el candidato** (vía `stays`, invisible a `checkAvailability()`/`assertAllResourcesAvailable()`): limitación heredada del documento base (§6 Fase 3, "Defensa en profundidad... sin cerrar la carrera contra un check-in concurrente"), no ampliada ni resuelta acá.
- **`partySize` nunca se compara contra staleness** — mismo motivo ya declarado en el documento base (F3-5b): `updateReservation()` nunca lo modifica, así que `queuedReservation.partySize` y cualquier lectura posterior son siempre el mismo valor, por construcción.
- **(B2, v3) Huésped con salida HOY sin check-out hecho, o estadía vencida, ocupando un candidato.** Acotar a "solo llegadas de hoy" (v2) resuelve el caso de una reserva futura chocando contra una Stay de hoy (H2 original), pero no cubre este: una habitación con una Stay `CHECKED_IN` activa de OTRA reserva (huésped que debía salir hoy y todavía no hizo check-out, o una estadía que venció sin que nadie la cerrara) sigue teniendo esa Stay activa en el momento exacto en que el batch corre — `findAvailableResourceInCategory()` (el fallback) no la excluye de entrada (no mira `stays`, solo `reservations`), así que puede elegirla como candidata; recién el paso 7 de `assignDeferred()` la rechaza con `RESOURCE_OCCUPIED`. El ítem se reporta `FAILED`/`RESOURCE_OCCUPIED` y, sin que nada cambie del lado del huésped, una re-corrida del batch vuelve a elegir la MISMA habitación (greedy alfabético determinístico) y vuelve a fallar — hasta que ese huésped haga check-out. **Decisión del dueño (`AskUserQuestion`, 27/09/2026): aceptar como limitación declarada, sin cambio de diseño.** Justificación: este es exactamente el mismo riesgo que el `PUT` manual de reasignación (`RoomCalendar`, panel) ya tiene hoy en producción para este escenario — un front desk arrastrando una reserva a mano sobre una habitación con un huésped sin check-out también choca contra el mismo paso 7 y recibe el mismo error. El batch no crea un riesgo nuevo, hereda uno preexistente sin empeorarlo (mismo criterio que el check-in concurrente, ítem anterior). El front desk resuelve esto en la práctica registrando el check-out (o el no-show/late-checkout, según corresponda) antes de correr el batch, o simplemente volviendo a correrlo después.

---

## 11. Qué queda explícitamente fuera de alcance

- **Turnos (no-alojamiento).** Confirmado: el documento base fija "solo alojamiento" como alcance de TODAS las fases de 4.3 (§5 punto 1, fork 1 ya resuelto) — este diseño no lo reabre. La validación 422 `CATEGORY_NOT_LODGING` en el handler es la única barrera de código para esto, mismo mecanismo que Fase 0.
- **Reoptimizar reservas de TERCEROS** (la opción (b) de F3-4) — descartada explícitamente por la decisión del dueño citada en el encabezado. Ninguna reserva que ya tiene su provisoria libre se mueve, aunque exista un acomodo "mejor" para el conjunto.
- **Tocar reservas `ASSIGNED`** — nunca entran en el universo que este batch procesa (la query de entrada filtra `assignment_status = 'PENDING_ASSIGNMENT'`); mover una reserva ya `ASSIGNED` reabriría A6.4 (transición `ASSIGNED → PENDING_ASSIGNMENT`, que hoy no existe) — mismo límite ya declarado por el documento base para la opción (b).
- **Rango de fechas como parámetro del endpoint** — decisión explícita, justificada en §2.2.
- **Multi-categoría en una sola llamada** — decisión explícita, justificada en §2.2.
- **Paralelizar el procesamiento del batch** — decisión explícita, justificada en §4.1 (secuencial, por calidad del resultado, no por corrección).
- **Fase 4 (Opción A, channel manager)** — sin dimensionar, mismo criterio que el documento base.
- **Modificar `docs/diseno-reserva-por-tipo-unidad-2026-09-24.md`** — este documento no lo edita; es un documento nuevo y autocontenido para Fase 3. Si se aprueba, ese documento base debería actualizar su tabla §6.1 ("Auto Assign All | Fase 3") para apuntar acá, pero esa edición queda fuera de esta entrega.

---

## Anexo — verificación de código (SCHEMA-ANCHOR-DRIFT-001: por nombre, no por línea, salvo donde se indica "verificado" con línea puntual de esta sesión)

- `assignDeferred()` — firma real de 5 parámetros, `reservation.service.ts`, confirmada leyendo el método completo en esta sesión.
- `findAvailableResourceInCategory()` — `undefined` fijo como `excludeReservationId`, `reservation-availability.service.ts`, confirmado leyendo el método completo.
- `checkAvailability()` — YA tiene `excludeReservationId` como 4to parámetro, confirmado.
- `assertAllResourcesAvailable()` — lockea internamente (`resourceRepository.lockByIds`) antes de validar, confirmado leyendo el método completo.
- `getByCategory()` — `ORDER BY r.name ASC`, `sql.resource.repository.ts`, confirmado.
- `EXPECTED_AUTHORIZE_CALL_SITES = 222`, `docs/rbac-matriz-endpoints.md` con encabezado "270" en `inventario-rutas.md`'s cita más reciente — confirmados en esta sesión.
- `error.middleware.ts` — `RESERVATION_ALREADY_ASSIGNED`, `ASSIGNMENT_CATEGORY_MISMATCH`, `RESERVATION_CONCURRENTLY_MODIFIED`, `RESOURCE_OCCUPIED` → 409; `INVALID_RESERVATION` → 400 — confirmados.
- `checkIn()` (`stay.service.ts`) — patrón real de `recordOccupancy()` post-commit, confirmado leyendo el método completo (usado como precedente directo para el mismo patrón en el batch).
