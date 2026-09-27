# Diseño v2.1 — `reservation-auto-assign-all.integration.test.ts` rompe el contrato B-2 de `occupancy_records`

**v2.1 sobre v2.** El gate aprobó la conclusión de fondo de v2 (se mantiene el contrato B-2, se
corrige el test de Fase 3, no se toca `src/` de producción) pero puso v2 en **HOLD acotado**: la
especificación del §7 (lo que habría que implementar) tenía la mecánica invertida — proponía
cambiar las 5 aserciones existentes de "1 fila" a "0 filas", cuando el fix real es mucho más chico
(confirmar la reserva ANTES del batch, sin tocar esas 5 aserciones). También faltaba nombrar una
segunda capa del contrato (guard B-1, en el servicio, no solo B-2 en el repositorio) y dos
afirmaciones de v2 (§3 y §5) sobrestimaban lo que se podía concluir de la evidencia citada.

**v2 sobre v1.** El gate `architecture-governor` puso v1 en **HOLD**: el diagnóstico mecánico
(causa raíz del "expected +0 to be 1") era correcto, pero la conclusión estaba invertida — v1
proponía ampliar el guard de `recordReservation()` para contar reservas `PENDING`, y eso
**reintroduce un doble conteo que un gate anterior ya cerró a propósito y fijó con tests de
regresión**. v1 nunca buscó si el comportamiento actual ya era una decisión tomada — lo trató como
un guard "viejo y no revisado". Era exactamente lo contrario: es la Condición 3 de un gate del
25/09/2026 (commit `41b1ff9`), con dos tests de integración dedicados a probar que el guard se
comporte así.

## 1. El contrato real (B-2) — fuente de verdad, no v1

`src/tests/integration/reservation-deferred-assignment.integration.test.ts:656-733`, describe
`"Regresión B-2: recordReservation() descarta reservas no CONFIRMED/COMPLETED"` (comentario de
cabecera, líneas 656-665, cita textual):

> La corrección de B-2 (`recordOccupancy()` post-commit del PUT, §8 del diseño) depende de un
> comportamiento que YA existe en `recordReservation()` (tanto `SqlOccupancyRepository` como
> `InMemoryOccupancyRepository`) pero que hasta acá ningún test fijaba: descarta en silencio
> cualquier reserva que NO esté CONFIRMED o COMPLETED (...). Esto es lo que evita el doble conteo
> cuando una reserva sigue PENDING (sin confirmar) pero ya tiene `assignmentStatus: 'ASSIGNED'`.

Dos tests fijan el contrato exacto, verificados en este bloque:

1. `updateReservation()` confirma el recurso vía `assignDeferred()` sobre una reserva todavía
   `PENDING` (sin confirmar) → **0 filas** de ocupación. Confirmar la reserva DESPUÉS →
   **exactamente 1 fila**, con `bookedMinutes` correcto.
2. Mismo punto de partida, pero en vez de confirmar se **cancela** → se queda en **0 filas** (no
   1, no negativo — `cancelReservation()` no llama a `recordOccupancy()`, a diferencia de
   `confirmReservation()`).

Dos tests unitarios más fijan el mismo guard, en las dos implementaciones del repositorio:
`sql.occupancy.repository.test.ts:18` (envía `ReservationStatus.PENDING`, espera 0 filas) y
`in-memory.occupancy.repository.test.ts:30`. `InMemoryOccupancyRepository.recordReservation()`
(`src/reservas/in-memory.occupancy.repository.ts:25-31`, dentro del método que ocupa 16-52 —
corregido, v2 citaba 17-30) tiene el **mismo guard duplicado**, con su propio comentario ("Solo
registrar reservas confirmadas o completadas") — v1 no lo mencionaba.

**Corrección v2.1 — el contrato tiene DOS capas, no una.** v2 solo nombraba B-2 (el guard de
`recordReservation()` sobre `status`). Falta la primera capa, B-1, en el servicio:
`ReservationAvailabilityService.recordOccupancy()` (`reservation-availability.service.ts:427-436`):

```ts
// (B-1, corrección post-gate sobre Fase 2 de 4.3) Mientras la reserva
// sigue PENDING_ASSIGNMENT, reservation.resource es un recurso
// PROVISORIO -- registrar ocupación acá dejaría una fila fantasma que
// occupancy_records (contador agregado, sin resta) no puede
// deshacer cuando assignDeferred() confirme el recurso definitivo.
if (reservation.assignmentStatus === 'PENDING_ASSIGNMENT') {
  return;
}
```

Origen de la decisión: `docs/diseno-reserva-por-tipo-unidad-2026-09-24.md` §6 ítem 6, §6.1, §7
(fila de `recordOccupancy()`) — el propio código lo cita en su comentario. Los dos guards tienen
que pasar para que se escriba una fila: B-1 exige `assignmentStatus !== 'PENDING_ASSIGNMENT'`
(recurso ya confirmado, no provisorio), B-2 exige `status ∈ {CONFIRMED, COMPLETED}` (reserva ya
confirmada). Esto es la base de la corrección de §3 más abajo.

**Por qué el guard existe, en una frase:** `occupancy_records.booked_minutes` es un contador que
solo **suma** (`booked_minutes + $7`, `sql.occupancy.repository.ts:98`, sin resta en ningún
camino) — no es idempotente ni reversible. El único punto seguro para sumar es un estado que no
se puede volver a alcanzar por otro camino distinto sin pasar de nuevo por ahí.

## 2. Por qué H12 es un bug del test de Fase 3, no de producción

`autoAssignAllForCategory()` (Fase 3, commit `4eadded`) reproduce EXACTAMENTE el escenario del
test B-2 arriba: deja una reserva con `assignmentStatus: 'ASSIGNED'` y `status: 'PENDING'` (sin
confirmar), y llama a `recordOccupancy()` post-commit. El guard descarta la fila — comportamiento
correcto, ya contratado. El fixture del test roto,
`createTodayPendingAssignment()` (`reservation-auto-assign-all.integration.test.ts:189-210`),
nunca confirma la reserva y sin embargo el test espera **1 fila** tras el batch — la aserción del
test está mal, no el código de producción. El diseño de Fase 3
(`docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md`, línea ~510, "ocupación registrada
EXACTAMENTE una vez") no especificó el `status` que debía tener el fixture, y el gate de esa Fase
no lo detectó contra el contrato B-2 (que ya existía, del 25/09).

## 3. Corrección de dos afirmaciones erróneas de v1 (y una imprecisión de v2)

- **v1 decía que la opción "solo test" (A) dejaba producción "subcontada en silencio".** Falso.
- **v1 decía que "los 4 call-sites restantes de `recordOccupancy()` no cambian" al tocar el
  guard.** Falso: el call-site de `updateReservation()` (L1001, el PUT que puede llegar con
  `status: PENDING`) es exactamente el caso que el test B-2 ya cubre — v1 no lo había identificado
  como afectado.
- **Corrección v2.1 — v2 reemplazó lo anterior por "toda reserva que se confirma se cuenta
  exactamente una vez, en el momento de confirmarse", y esa frase también es imprecisa, por dos
  lados.** (a) `confirmReservation()` llama a `recordOccupancy()` sin condición, pero ese método
  tiene el guard B-1 (§1): si la reserva todavía está `PENDING_ASSIGNMENT` en el momento de
  confirmarse (alta por categoría, sin resource asignado todavía), no escribe nada — no hay nada
  que "el momento de confirmarse" pueda garantizar por sí solo. (b) tampoco es "exactamente una
  vez" en todos los casos: `completeReservation()` también llama a `recordOccupancy()`, y eso es
  precisamente `OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001` (§4), un hallazgo previo todavía abierto.
  **Formulación correcta:** cada reserva que llega a estar, a la vez, `CONFIRMED`/`COMPLETED`
  (B-2) Y con `assignmentStatus !== 'PENDING_ASSIGNMENT'` (B-1) se cuenta una sola vez, en el
  primer momento en que las dos condiciones se cumplen juntas — sea que la confirmación llegue
  antes o después de la asignación del recurso. La excepción conocida es completar, cubierta por
  el hallazgo ya citado.

## 4. Por qué las opciones B/C de v1 son incorrectas (no solo arriesgadas)

Con cualquiera de las dos, una reserva `PENDING` que pasa por auto-asignación o por el PUT de
`assignDeferred()` se contaría **al asignarse** y **otra vez al confirmarse** (doble conteo) — y si
después se cancela en vez de confirmarse, deja una **fila fantasma** que nada resta (no hay
operación inversa). Esto rompería los 2 tests de integración B-2 y los 2 tests unitarios citados
en §1. Además, `completeReservation()` (L1491) ya tiene un hallazgo previo y **abierto** de doble
conteo sobre `CONFIRMED`→`COMPLETED` (`OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001`,
`docs/pendientes-2026-09-27.md:6785`, hallazgo colateral del gate del 24/09/2026 sobre
`confirmReservation()`+`completeReservation()` llamando ambas a `recordOccupancy()` sobre la misma
reserva) — B/C sumaría un tercer punto de conteo sobre ese mismo problema ya conocido, en vez de
acotarlo.

**Opción C (reusar `blockingStatuses` como fuente única) no es viable tal como estaba descrita en
v1:** `blockingStatuses` (`sql.reservation.repository.ts:366`) es una `const` **local dentro de un
método privado**, no una constante exportable — no hay nada que importar. Y semánticamente son dos
preguntas distintas: "¿qué estados bloquean disponibilidad?" (PENDING+CONFIRMED, sin COMPLETED,
porque una reserva completada ya liberó el recurso) vs. "¿qué estados cuentan como ocupación
confirmada en un reporte?" (CONFIRMED+COMPLETED). Unificarlas acopla dos conceptos que el propio
repo mantiene separados a propósito.

## 5. Clasificación (`criterios-negocio`, corregida)

`Reservation` sigue TRANSACCIÓN, sin cambio — correcto en v1. **Corrección:** `occupancy_records`
en sí no es MAESTRO ni TRANSACCIÓN — es un **dato derivado / contador de reporte (proyección)**
sobre el estado de `Reservation`, no una entidad de negocio con ciclo de vida propio. Es
precisamente esa naturaleza (no idempotente, sin operación inversa) la que invalida B/C: una
proyección construida por suma acumulativa solo puede escribirse desde un punto que no se vuelve a
visitar, nunca desde un estado transitorio que la misma reserva puede atravesar más de una vez o
abandonar sin confirmar.

**Corrección v2.1 (bajado a contexto, no justificación):** A5.2 (`criterios-negocio.md:277-281`)
distingue `Reservation` (intención) de `Stay` (ocupación real) como regla de glosario — da contexto
semántico útil (`occupancy_records` cuenta reservas, no estadías reales), pero no es evidencia de
que `CONFIRMED` sea "el lado correcto" del contrato: una reserva `CONFIRMED` sigue siendo una
intención, no una `Stay`. La justificación real del contrato B-2 es la de §1 (proyección
no-idempotente, contador acumulativo sin resta) y la de §3 (las dos capas de guard), no A5.2.

**Corrección de cita:** v1 decía "verificado (grep): ni `criterios-negocio.md` ni
`criterios-datos.md` mencionan `occupancy_records`" — falso. `criterios-negocio.md:236` sí lo
menciona, como ejemplo de la fila "Fecha de negocio" en la tabla de tipos de tiempo (A4.x) — no es
una decisión sobre el guard de `status`, pero la afirmación de "no hay ninguna mención" no se
sostenía.

**La "regla nueva" que v1 proponía señalar (dos guards que divergen sobre el mismo par de campos)
queda retirada** — una vez entendido que los dos guards (disponibilidad vs. reporte) miden
conceptos distintos a propósito, no hay divergencia que declarar.

## 6. Corrección al log de `warn` (§4 de v1, retirada)

v1 proponía loguear `warn` cada vez que el guard descarta una llamada. Con el contrato B-2
confirmado, ese descarte es el **camino normal esperado** de cualquier PUT o auto-asignación sobre
una reserva sin confirmar — un `warn` ahí sería ruido permanente, no una señal. Se retira. Si en el
futuro se quiere una señal de invariante, la única candidata razonable sería loguear los estados
que **ningún caller debería mandar nunca** (`CANCELLED`/`EXPIRED`) — eso es un bloque aparte, no
parte de esta corrección.

## 7. Resolución — corregir el FIXTURE, no las aserciones (v2.1, reemplaza la opción A2 de v2)

**No es una pregunta abierta para el dueño — es la corrección directa del contrato ya decidido.**

**Corrección v2.1 — v2 tenía la mecánica invertida.** v2 proponía cambiar las 5 aserciones
existentes de "1 fila" a "0 filas". Eso es innecesario y, peor, hace que el test deje de probar lo
que "Auto Assign All" tiene que garantizar en el caso operativo real.

**Corrección de la cuarta ronda de gate (C2) — no hay evidencia de que "confirmar y después
reasignar" sea LA secuencia real que importa en producción**, y esa afirmación se retira; el
diseño de Fase 3 no prioriza ningún orden, y `getPendingAssignmentByCategory()` (§ más abajo)
acepta los dos por igual. La justificación correcta, más chica y verificable, es otra: dado el
contrato B-1+B-2, hay exactamente dos fixtures posibles para un test de `autoAssignAllForCategory()`
— reserva confirmada antes del batch (da 1 fila tras el batch mismo) o reserva sin confirmar antes
del batch (da 0 filas tras el batch, 1 tras confirmar después). Los 5 tests existentes ya afirman
"1 fila tras el batch" — la única forma de que esa aserción sea correcta bajo el contrato es que el
fixture confirme ANTES del batch; (ii), más abajo, cubre la otra rama (fixture sin confirmar) que
los 5 tests existentes no ejercitan.

**Corrección C3 — helper nuevo para (i), el actual sin cambios para (ii) (evita la ambigüedad de
la ronda anterior).** Precedente para el fixture nuevo:
`createConfirmedPendingAssignment()` (`reservation-deferred-assignment.integration.test.ts:248-285`,
Fase 2) — crea por categoría, confirma, y verifica **0 filas** sobre el provisorio (por B-1: sigue
`PENDING_ASSIGNMENT` en ese momento) **antes** de cualquier operación de asignación. El propio
query del batch confirma que ambos status son candidatos reales:
`getPendingAssignmentByCategory()` filtra `r.status IN ('PENDING', 'CONFIRMED')`
(`sql.reservation.repository.ts:704-705`) — una reserva `CONFIRMED` sí puede llegar al batch.

**(i) Caso principal — fix real de los 5 tests rotos, sin tocar sus aserciones de "1 fila":** helper
**nuevo** (ej. `createTodayConfirmedAssignment()`), que crea por categoría, confirma
(`confirmReservation()`) y verifica **0 filas** sobre el provisorio antes de devolver el id — mismo
patrón que `createConfirmedPendingAssignment()` de Fase 2, adaptado a la fecha "hoy" que ya usa
`createTodayPendingAssignment()`. Los 5 tests existentes cambian su llamada de fixture a este
helper nuevo; el resto del test (llamar al batch, afirmar 1 fila) no cambia. Con la reserva ya
`CONFIRMED` cuando el batch corre, `assignDeferred()` deja `assignmentStatus: 'ASSIGNED'` con
`status` ya `CONFIRMED` — las dos capas del contrato (B-1 y B-2, §1) se cumplen juntas en ese
momento, y `recordOccupancy()` escribe la fila. **Las 5 aserciones de "1 fila después del batch" no
cambian** — lo único que cambia es qué helper de fixture las precede.

**(ii) Test nuevo, obligatorio (no "recomendado" como decía v2) — cubre la rama que (i) deja de
ejercitar:** usa `createTodayPendingAssignment()`, el helper **actual, sin ningún cambio** (reserva
sin confirmar), que pasa por el batch → después del batch, `assignmentStatus: 'ASSIGNED'` con
`status` todavía `PENDING` → **0 filas** (B-2 bloquea). Confirmar después
(`confirmReservation()`) → **exactamente 1 fila**, `bookedMinutes === DURATION_MINUTES`. Espejo
exacto del primer test B-2 de §1, aplicado específicamente al batch (los tests de B-2 ya
existentes cubren el PUT, no el batch).

**(iii) Reforzar el test de concurrencia existente (dos batches concurrentes, líneas ~421-470):**
agregar `bookedMinutes === DURATION_MINUTES` a las aserciones de las líneas 455-456 (hoy solo
cuentan filas). Motivo: por el `UNIQUE(resource_id, date)` de `occupancy_records`, un doble conteo
sobre el mismo recurso/día no crea una fila nueva — el `ON CONFLICT DO UPDATE` suma minutos sobre
la fila existente (`sql.occupancy.repository.ts:94-98`). Contar solo filas no detectaría ese caso;
sí lo detecta comparar `bookedMinutes`.

**Alcance:** un solo archivo, `src/tests/integration/reservation-auto-assign-all.integration.test.ts`
— ningún otro archivo de `src/` cambia. **Alcance propuesto, no autorizado todavía por el gate**:
la implementación (el diff del test) necesita su propio gate liviano — ver §9.

## 8. Fuera de alcance de este bloque (declarado, sin cambio respecto de v1)

- `OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001` — hallazgo previo, independiente, sigue sin resolver
  acá.
- Reconciliación de datos ya afectados en `occupancy_records` en tenants reales.
- Cualquier cambio a `checkAvailability()`/disponibilidad — no se toca, no depende de
  `occupancy_records` (verificado en v1, sin corrección necesaria en este punto).
- Un eventual rediseño de producto de `occupancy_records` (registros idempotentes por reserva, o
  recálculo directo desde `reservations` en vez de un contador acumulativo) — **si en algún
  momento se quiere que los reportes de ocupación reflejen reservas `PENDING` con recurso ya
  asignado**, eso es un cambio de producto real, no un ajuste de guard: requiere resolver primero
  `OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001`, reconciliar los datos existentes, y re-decidir el
  contrato B-2 de forma explícita con su propio gate. No es este bloque.

## 9. Gate de implementación (aparte, liviano — requerido, este documento no alcanza)

El gate de diseño (v2.1) no autoriza tocar el archivo de test — solo aprueba QUÉ hay que cambiar.
La implementación necesita su propio gate corto, con este reporte:

1. Diff limitado a `src/tests/integration/reservation-auto-assign-all.integration.test.ts` — ningún
   otro archivo. El commit de este diff **no** arrastra los 3 docs (`pendientes-2026-09-27.md`,
   `linea-base-refactor-2026-09-27.md`, `indice-conocimiento.md`) ni este documento de diseño —
   esos van en un commit de docs aparte. Mensaje de commit con la sección 2 de
   `DEFENSIVE_DEVELOPING.md` (genérica, cambio de código sin PR).
2. Salida real de `vitest run` de ese archivo y del de Fase 2
   (`reservation-deferred-assignment.integration.test.ts`, para confirmar que no se rompió nada
   compartido) contra Postgres real, con **tests ejecutados, no salteados** (`skipIfNoDb` saltea en
   verde — un log que solo muestre "skipped" no cuenta como evidencia). Dos fuentes válidas: local
   con `TEST_DATABASE_URL`, o CI (el job `integration` de `ci.yml:283-315`, que sí levanta Postgres
   como service) — pero la fuente CI implica push, y push necesita autorización explícita del
   dueño, aparte de la del commit.
3. **Prueba de mutación real (no afirmada), con mapeo explícito mutante → test que se pone en
   rojo — no alcanza con "(ii) o (iii)" genérico:**
   - **M1** (comentar el guard B-1 en `recordOccupancy()`): tiene que poner en rojo la
     precondición de 0 filas del helper nuevo de (i) (`createTodayConfirmedAssignment()`), el
     test 2 (0 filas sobre el provisorio) y (iii).
   - **M2** (duplicar la llamada a `recordOccupancy()` dentro del batch): tiene que poner en rojo
     `bookedMinutes` del test 1 y de (iii).
   - **M3** (ampliar el guard de `SqlOccupancyRepository.recordReservation()` para aceptar
     `PENDING`): tiene que poner en rojo (ii) Y los 2 tests de "Regresión B-2"
     (`reservation-deferred-assignment.integration.test.ts:656-733`) — M3 es exactamente la
     regresión que este diseño entero existe para prevenir (las opciones B/C de v1); si (ii) no la
     detecta, (ii) está mal escrito.
   - Los 3 mutantes se revierten después de confirmar el rojo — no se commitea ningún mutante.
4. Confirmación explícita (`git status`) de que nada fuera de
   `src/tests/integration/reservation-auto-assign-all.integration.test.ts` cambió en ese commit.
5. Plan de rollback: `git revert` del commit del test (sin dependencias de schema, RBAC ni
   contrato — nada más se ve afectado).
6. Al cerrar H12: cortarlo de `docs/pendientes-2026-09-27.md` a `docs/resuelto.md` con el hash del
   commit, siguiendo la convención vigente del repo (`CLAUDE.md` raíz, corte-y-pega en el mismo
   commit). Si la evidencia del punto 2 es solo local (sin push todavía), el residuo de
   confirmación en CI real queda en `## 🔍 Verificaciones pendientes`, no se da por cerrado.

No hace falta `multitenant-governor` para este bloque (no toca `src/api/routes/`, `container.ts`,
`src/platform/` ni `src/workers/`).
