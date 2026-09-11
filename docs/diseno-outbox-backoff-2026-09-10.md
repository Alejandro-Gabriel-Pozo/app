# Diseño: OUTBOX-RETRY-HIST-01 + OUTBOX-BACKOFF-01

**Fecha:** 2026-09-10. **Gate:** `architecture-governor`, ronda 1 = HOLD.
Último ítem del listado de 8 que el dueño pidió encarar esta sesión.
Bloqueado por A7.6, ya decidida por el dueño: **90 días de retención,
solo sobre eventos resueltos** (`dispatched_at IS NOT NULL OR failed_at
IS NOT NULL`) — la purga en sí queda fuera de este bloque (§5).

## 0. Grounding ERP (reusado, no repetido)

Ya hecho en `docs/diseno-order13-o5-dead-letter-2026-09-07.md` §7 para
este mismo subsistema:
- Odoo `ir_cron.py:122` — `first_failure_date`: columna que se setea UNA
  vez, nunca se pisa. Resuelve "¿hace cuánto que esto falla?" sin perder
  el dato en cada reintento.
- Odoo `ir_cron.py:365` — `ORDER BY failure_count` (ya adoptado como
  `retry_count ASC` en `getPending()`, ORDER-13/O5).
- OCA `queue_job`, `retry_pattern`: backoff como función escalón de
  `retry_count`, no exponencial continuo ni intervalo fijo.

## 1. Decisiones del dueño (obtenidas, no asumidas)

Cuatro preguntas separadas, per la regla de este repo de no bundlear
decisiones de negocio distintas en una sola (`app-main/CLAUDE.md`,
"Preguntas de alcance pueden esconder una decisión de negocio"):

1. **Escalón de backoff**: moderado — `retry_count` 1-2 → 5s, 3-9 → 30s,
   10-29 → 120s, 30-59 → 300s. Peor caso ≈3.5h hasta dead-letter (vs
   ~5min hoy).
2. **`maxRetries`**: se mantiene en 60. El backoff ya reduce la presión
   sobre el downstream; no hace falta acortar también el número de
   intentos.
3. **`first_failed_at` tras reintento manual**: se MANTIENE, no se
   resetea. "Esto viene fallando desde el lunes" sigue siendo cierto
   aunque alguien haya reintentado el miércoles.
4. **Batching de mails O5 D2-C**: la degradación (un dead-letter
   prolongado puede generar varios mails sueltos en vez de un digest) se
   acepta. Bajo volumen de eventos hoy — el digest no aporta tanto si los
   dead-letters ya no convergen en minutos.

## 2. Defecto encontrado por el gate — el guard original hubiera roto la columna

Propuesta original: `first_failed_at = CASE WHEN retry_count = 0 THEN
NOW() ELSE first_failed_at END`. **Incorrecta**:
`retryDeadLettered()` (`sql.domain-event.repository.ts:173-178`) resetea
`retry_count = 0` en cada reintento manual. Con ese guard, la PRÓXIMA
falla después de un reintento manual pisaría `first_failed_at` con la
fecha de hoy — exactamente lo que la decisión 3 de arriba prohíbe. Y
además: cualquier fila que YA esté en `retry_count > 0` en producción
nunca volvería a pasar por `retry_count = 0`, así que jamás recibiría un
`first_failed_at`.

**Guard corregido, idempotente sobre la columna misma:**
```sql
first_failed_at = CASE WHEN first_failed_at IS NULL THEN NOW() ELSE first_failed_at END
```
Se setea la primera vez que la columna es NULL (incluida una fila vieja
en `retry_count > 0` que todavía no tiene el dato) y nunca se pisa
después — ni por más fallas, ni por un reintento manual que resetee
`retry_count`. Coherente con la decisión 3.

## 3. Schema (`domain_events`, tenant `schema.sql`)

```sql
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS first_failed_at TIMESTAMPTZ;
ALTER TABLE domain_events ADD COLUMN IF NOT EXISTS last_failed_at  TIMESTAMPTZ;
```

`CURRENT_SCHEMA_VERSION` (`tenant-db.setup.ts:338`) sube de 47 a 48, con
su comentario `// v48 (fecha): OUTBOX-RETRY-HIST-01/BACKOFF-01...` —
**faltaba en el planteo original, corregido acá** (el gate lo marcó
como ubicación ausente de la matriz).

## 4. `recordFailure()` — misma UPDATE atómica (A8.2 preservado)

```sql
UPDATE domain_events
   SET retry_count     = retry_count + 1,
       last_error      = $2,
       first_failed_at = CASE WHEN first_failed_at IS NULL THEN NOW() ELSE first_failed_at END,
       last_failed_at  = NOW(),
       failed_at       = CASE WHEN retry_count + 1 >= $3 THEN NOW() ELSE failed_at END
 WHERE id = $1
 RETURNING failed_at
```

Sin segundo camino de escritura. `last_failed_at` se pisa en CADA falla
(sin CASE) — es lo que el backoff necesita para calcular la próxima
ventana elegible.

## 5. Backoff en `getPending()`

**Corregido, ronda 2 del gate — condiciones 1, 2 y 4:**

```sql
SELECT ${EVENT_COLUMNS}
  FROM domain_events
 WHERE dispatched_at IS NULL AND failed_at IS NULL
   AND (
     retry_count = 0
     OR last_failed_at IS NULL
     OR last_failed_at <= NOW() - (
       CASE
         WHEN retry_count <= 2  THEN 5
         WHEN retry_count <= 9  THEN 30
         WHEN retry_count <= 29 THEN 120
         ELSE 300
       END || ' seconds')::interval
   )
 ORDER BY retry_count ASC, id ASC
 LIMIT $1
```

**Condición 1 (bloqueante) — el agujero NULL.** Una fila que YA existe
hoy con `retry_count > 0`, `dispatched_at IS NULL`, `failed_at IS NULL`
(pendiente, a mitad de reintento en el momento en que corre la
migración) tiene `last_failed_at IS NULL` porque la columna no existía
cuando esa fila falló. Sin la rama `OR last_failed_at IS NULL`:
`retry_count = 0` → `false`; `NULL <= ...` → `NULL` (lógica de 3
valores de SQL); `false OR NULL` → `NULL` → la fila NO se devuelve.
**Ese evento queda invisible para siempre**: nunca se reintenta, nunca
llega a `maxRetries`, nunca dispara `onDeadLetter` (compensación de
A8.7) -- no falla, desaparece. Es el inverso exacto de
`honest-degradation`. La medición de producción (`max_retry_count=30`
en Demo, aunque hoy con 0 filas pendientes) prueba que esta forma de
fila SÍ ocurre en la operación real de este sistema -- la ventana de
migración es exactamente el momento en que puede no estar vacía.
Test agregado (§6): insertar una fila con `retry_count=5,
last_failed_at=NULL` y confirmar que `getPending()` la devuelve --
autocura en el próximo poll, que le setea `last_failed_at` real.

**Condición 2 — los límites del escalón no coincidían con lo que
aprobó el dueño.** El dueño aprobó la tabla: `retry_count` 1-2 → 5s,
3-9 → 30s, 10-29 → 120s, ≥30 → 300s. La versión anterior de este doc
tenía cada límite corrido un reintento antes (`< 2` en vez de `<= 2`,
etc.) -- el total de pared hasta dead-letter casi no cambiaba (~3.31h
vs ~3.23h), pero el nivel que más importaba (5s para que "una falla
transitoria de un ciclo no sienta el cambio") solo cubría el primer
reintento en vez de los dos aprobados. Corregido a `<= 2`/`<= 9`/`<= 29`,
que sí coincide con la tabla aprobada.

**Condición 4 — sin snippet de TypeScript rechazado.** La versión
anterior mostraba una función `backoffSecondsFor()` en TS, la
descartaba en el texto, y dejaba igual el código ejecutable-parecido en
el documento -- exactamente el patrón que ya causó
`SCHEMA-ANCHOR-DRIFT-001` y la claim desactualizada corregida en
`79d43fe` (una segunda fuente de verdad que alguien implementa después
sin saber que ya se había descartado). La lógica del escalón vive
**solo** en el `CASE` del WHERE de arriba -- una sola fuente, sin
alternativa en TypeScript ni en ningún otro lugar.

**Dos mecanismos que cubren la misma preocupación, declarado explícito
(pedido del gate):** `ORDER BY retry_count ASC` (ORDER-13/O5, evita que
un poison message bloquee la cabeza de la cola) y el backoff (excluye
directamente al poison message de `getPending()`) se solapan en gran
parte. Se mantienen los dos: el backoff es la fuente de verdad de "¿este
evento es candidato a reintentarse YA?"; el `ORDER BY` sigue importando
para el orden ENTRE los eventos que sí son elegibles (los que fallan más
se van al fondo igual). No quitar el `ORDER BY` asumiendo que el backoff
lo hace redundante — cubren preguntas distintas.

## 6. Mecanismo de test — decidido ANTES del código (pedido explícito del gate)

Los 3 tests de integración existentes que manejan una secuencia de
reintentos síncrona (`outbox-worker.integration.test.ts:138-147,
~278-300, ~294-312`) van a fallar tal como están: el segundo/tercer poll
de la secuencia encontraría el evento en backoff y no lo re-procesaría.

**Mecanismo elegido: backdatear `last_failed_at` directo por SQL entre
polls, sin abstracción de reloj en el código de producción.** El propio
test de integración ya tiene acceso directo a Postgres (fabrica su
estado con SQL crudo, mismo patrón que
`unreconciled-live-invoices.integration.test.ts`). Entre dos llamadas a
`worker.poll()` que la prueba necesita que corran en secuencia
inmediata, un `UPDATE domain_events SET last_failed_at = NOW() -
INTERVAL '10 minutes' WHERE id = $1` simula "ya pasó tiempo suficiente"
sin tocar el reloj real ni inyectar una dependencia de tiempo en
`SqlDomainEventRepository`. Evita threading un `Clock`/`now: () => Date`
por todo el repositorio para un caso que solo los tests de integración
necesitan.

**Corregido, ronda 2 del gate — condición 3: sin mutation testing de
una función que no existe.** El plan original prometía "mutation-testear
la función de backoff" -- ya no aplica, porque §5 concluyó (correctamente)
que no hay función de TypeScript, el escalón vive solo en el `CASE` SQL.
Reemplazado por **tests de límite contra Postgres real, uno por cada
borde del escalón**, usando el backdateo de §6: para cada borde
(`retry_count` = 2/3, 9/10, 29/30) y para el caso NULL de la condición
1, backdatear `last_failed_at` justo DENTRO y justo FUERA de la ventana
de ese nivel y confirmar inclusión/exclusión en `getPending()`. Seis
bordes × 2 aserciones = doce, más el test de la fila NULL de la
condición 1 (13 en total). Esto -- no mutation testing de una función
inexistente -- es lo que hubiera atrapado la condición 2 (límites
corridos).

## 7. `company_catalog_propagation_queue` — DECISIÓN: fuera de este bloque

El gate encontró que `company.repository.ts` tiene el mismo patrón
retry/dead-letter (`company_catalog_propagation_queue`, BD de
plataforma) sin `retry_count ASC` ni backoff. Confirmado real, **decisión:
queda fuera de este bloque**, con motivo:
- Es una tabla y un worker DISTINTOS (BD de plataforma, no tenant;
  `CompanyCatalogPropagationWorker`, ya migrado a `AdaptivePoller` en el
  bloque anterior).
- Medido hoy: **0 filas en la cola de propagación en producción** (las 2
  tenants) — sin caso vivo que justifique resolverlo en el mismo commit
  que `domain_events`.
- Combinar los dos multiplica la superficie de riesgo de un solo bloque
  (2 schemas, 2 workers, 2 test suites) sin necesidad — el propio
  criterio de este repo es "un bloque chico y reversible por vez".
- **Follow-up registrado** (no queda perdido): `PROPAGATION-QUEUE-BACKOFF-01`,
  mismo mecanismo aplicado a `company_catalog_propagation_queue`, bloque
  aparte, cuando corresponda.

## 8. `retryDeadLettered()` — sin cambios de comportamiento, verificado

Sigue reseteando `retry_count = 0` (decisión 3 de arriba: eso NO
resetea `first_failed_at`, que ahora es idempotente sobre sí mismo). No
requiere tocar esa query.

## 9. Matriz de impacto completa (corregida, ronda 1 del gate)

| Ubicación | Qué cambia | Riesgo |
|---|---|---|
| `src/db/schema.sql:2008-2019` | 2 columnas nuevas | Medio |
| `src/platform/tenant-db.setup.ts:338` | `CURRENT_SCHEMA_VERSION` 47→48 | Medio |
| `src/repositories/sql.domain-event.repository.ts` (`EVENT_COLUMNS`, `DomainEventRow`, `toDomainEvent`, `getPending`, `recordFailure`) | agrega ambas columnas al SELECT/mapping; UPDATE atómica; WHERE de backoff | Alto (query central) |
| `src/repositories/domain-event.repository.ts` (interfaz `DomainEvent`) | 2 campos opcionales nuevos | Bajo (additive) |
| `src/api/routes/system.routes.ts:39-45` | spread automático -- los campos nuevos llegan solos a la API | Bajo |
| `appfrontend-main/src/lib/sistema/types.ts:2-10` (`DeadLetterEvent`) | mirror manual -- declarar en el commit, no descubrir después (mismo defecto que `ROLES-CATALOG-DRIFT-001`) | Bajo, pero debe declararse |
| `src/tests/integration/outbox-worker.integration.test.ts` (3 secuencias) | necesitan backdatear `last_failed_at` entre polls (§6) | Alto si no se ajustan primero |
| `src/workers/outbox.worker.ts` (docblock líneas 178/382/508, ya marcadas stale por el bloque de polling adaptativo) | el "~5 min" pasa a ser aún menos preciso -- reescribir en el mismo commit | Medio |
| `company_catalog_propagation_queue`/`company.repository.ts` | **fuera de este bloque** (§7) | — |
| `docs/diseno-order13-o5-dead-letter-2026-09-07.md` §7 | follow-ups #1 (backoff) y #3 (first_failed_at) quedan resueltos por este bloque -- marcar ahí | Bajo |

## 10. Purga (A7.6) -- diferida, opción (a) rechazada, no solo pospuesta

El gate rechazó (a) (`migrate-tenants.ts`) de fondo: ese script corre
dentro del `buildCommand` de `render.yaml`, y una falla ahí tumba el
deploy completo (R15, fail-loud por diseño) -- atar una purga de datos
a esa ruta significa que un bug de purga puede tirar abajo producción
enteras, no solo fallar en silencio. (b) (endpoint + Render Cron
Job) es la forma correcta, pero no existe infraestructura de cron hoy
en este repo (verificado: `render.yaml` no declara ningún cron
service). Queda como bloque propio, futuro, no bloqueante para que las
columnas existan y el backoff funcione.

**Interacción a tener en cuenta cuando se diseñe la purga** (encontrada
por el gate, registrada para no perderla): purgar solo eventos
RESUELTOS con `occurred_at < 90 días` interactúa con
`retryDeadLettered()` -- un evento purgado y DESPUÉS reintentado
manualmente volvería a `first_failed_at = NULL` y lo recibiría de
nuevo bajo el guard `IS NULL`, silenciosamente reseteando la retención.
No se resuelve acá; se deja escrito para que el bloque de purga lo
decida con el contexto completo.

## 11. Acoplamiento con la futura migración de `OutboxWorker` a `AdaptivePoller` (registrado, ronda 2 del gate)

`OutboxWorker` sigue en `setInterval` fijo hoy (ese bloque quedó en
HOLD -- wake exacto post-commit, ver
`docs/diseno-polling-adaptativo-neon-2026-09-10.md` §3.3). Mientras siga
así, el backoff de este bloque es independiente de la cadencia del
poller: un poll a los 5s simplemente encuentra menos eventos elegibles
si están en backoff.

**Eso deja de ser cierto el día que `OutboxWorker` migre a
`AdaptivePoller`.** El `pollFn()` del helper devuelve `false` cuando
`getPending()` viene vacío -- y "vacío" va a incluir "todo lo pendiente
está en backoff". El poller entonces pasa a `idleIntervalMs`, que el
diseño de polling adaptativo fija DELIBERADAMENTE por encima de la
ventana de 5 minutos del scale-to-zero de Neon. El retraso efectivo de
reintento pasa a ser `max(backoff_seconds(retry_count), idleIntervalMs)`
-- los escalones de 5s/30s/120s de este diseño colapsan a ~10 minutos
para cualquier tenant cuyo único trabajo pendiente esté en backoff. El
escalón de 5s (agregado específicamente para que una falla transitoria
de un ciclo no sienta el cambio, decisión 1 del dueño) deja de existir
en la práctica.

Agravante: el mecanismo `wake()` de `AdaptivePoller` tiene una ventana
de wake perdido conocida (docblock de `adaptive-poller.ts`, hallazgo
C3) y **el vencimiento de un backoff no es, hoy, una fuente de `wake()`**
-- no hay timer que dispare nada cuando el backoff de un evento
específico expira, el próximo poll simplemente lo encuentra elegible
si le toca despertar por su propia cadencia. Esto tiene que quedar
escrito en los dos diseños ahora, mientras los dos siguen abiertos, para
que quien encare la migración de `OutboxWorker` no lo descubra en
producción.
