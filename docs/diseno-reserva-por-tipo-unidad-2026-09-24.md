# Diseño — Reserva por tipo de unidad con asignación diferida (4.3)

**Fecha:** 2026-09-24 (consolidado en la séptima ronda de edición,
corregido en la octava, la novena, la décima, la onceava, la doceava, la
decimotercera y la decimocuarta el mismo día 24/09/2026, y en la
decimoquinta, la decimosexta, la decimoséptima, la decimoctava y la
decimonovena el 25/09/2026 — **corregido, condición menor
del gate 18:** una versión anterior de este encabezado decía "mismo día"
para las nueve, lo que era falso para las últimas dos (la decimoquinta y
la decimosexta, 25/09/2026, no 24/09/2026 como el resto); ver Anexo,
entradas "Ronda 15" a "Ronda 19", para la evidencia de fecha de cada una
— **agregadas la decimoséptima y la decimoctava, ronda de correcciones
sobre el gate 19; agregada la decimonovena, ronda de correcciones sobre
el gate 20**)
**Origen:** Wave 14 de `docs/plan-ejecucion-integral-2026-09-16.md` (`4.3`,
citado desde `docs/pendientes-2026-09-12.md:2825` y
`docs/plan-integral-sistemico-2026-09-16.md:120`). Decisión de producto ya
tomada en `docs/decisiones-plan-integral-2026-09-16.md:217-224` — *"sí,
planificar la migración del modelo"*, sin gatillo de revisión. Grounding ya
corrido y suficiente — `docs/grounding-25-preguntas-2026-09-16.md:290-308`
(Cloudbeds, QloApps, OPERA), más un grounding ERP adicional post-gate
(Cloudbeds, QloApps, OCA/pms de Odoo) — por eso este documento no vuelve a
invocar `auditor-circuitos-erp`.

**Estado de este documento:** especificación normativa, con Fase 1 y
Fase 2 aprobadas con condiciones por el gate `architecture-governor`
(las condiciones remanentes de Fase 2 son de implementación — ver el pie
de este documento, entrada "Ronda 19", que registra el veredicto final
del gate 20) y Fase 3 en HOLD (precondición de Fase 2 en producción,
§6, más F3-4 abierta a propósito). **Corregido (gate 20, Ronda 19):**
una versión anterior de este párrafo decía "Fases 2/3 en HOLD" — Fase 2
dejó de estar en HOLD en el gate 19 (25/09/2026), que aprobó su DISEÑO
con condiciones; este párrafo no se había actualizado para reflejarlo.
Los
17 forks de negocio de Fases 0-2 (enumerados en §9 —
corregido en la Ronda 10, faltaba contar N4; corregido de nuevo en la
Ronda 14, sumó D-1/D-2) están resueltos vía `AskUserQuestion` con el
dueño. **Corregido (condición menor del gate 18) — ya no es "ningún fork
de negocio queda abierto" sin excepción:** el gate 18 encontró, en Fase 3,
UN fork nuevo (F3-4, §6/§9) que sí queda abierto a propósito — no se
resuelve todavía porque Fase 3 no se puede aprobar de todas formas hasta
que Fase 2 esté en producción. Lo que sigue abierto, aparte de F3-4, es
exclusivamente implementación, enumerado también en §9.

**Nota sobre esta versión del documento:** el documento pasó por
diecinueve rondas de escritura/gate (contadas contra el Anexo, incluida
esta — corregido de "dieciocho" a "diecinueve", ronda de correcciones
sobre el gate 20: sumaba la Ronda 18 pero no esta misma Ronda 19 sin que
el conteo se hubiera actualizado; antes de eso el conteo había pasado de
"dieciséis" a "dieciocho", C-5 de la ronda de correcciones sobre el gate
19, porque sumaban la Ronda 17 y la Ronda 18 sin actualizarse; el
encabezado decía "doce" antes de eso, ya desactualizado desde la Ronda
16). Las primeras seis
apilaban cada corrección como
un párrafo "Actualización N-ésima ronda" encima del texto anterior — eso
funcionó para que cada hallazgo quedara trazado, pero terminó produciendo
contradicciones nuevas en rondas sucesivas (una sección corregida en la
ronda N asumía algo que otra sección, no tocada esa ronda, seguía
contradiciendo). La Ronda 7 reescribió el cuerpo (§1-§9) como una
especificación única y consistente, sin ese historial incrustado. La
Ronda 8 corrigió, sobre ese mismo cuerpo ya reescrito, 5 contradicciones
textuales locales y 4 correcciones técnicas obligatorias que el gate de la
Ronda 7 encontró (T1-T5/B1-B4, más 6 condiciones menores C1-C6) — sin
volver a apilar un párrafo de actualización. La Ronda 9 encontró que el
propio mecanismo de locks que la Ronda 8/B1 había agregado
(`currentResourceIdHint`) traía su propio deadlock ABBA — parchar
agregando piezas en vez de fijar un invariante — y lo reemplazó por un
invariante único, más simple (N1-N4, C-a a C-d), aplicado in-place sobre
las mismas secciones. La Ronda 10 dio Fase 0 por APROBADA CON
CONDICIONES — la primera fase lista para implementarse — y corrigió, sobre
el mismo invariante de la Ronda 9, dos hallazgos técnicos acotados al
check-in (H1: el discriminador `ASSIGNED`/`PENDING_ASSIGNMENT` faltaba;
H2: el `INSERT` de `Stay` toma un lock de FK implícito que la tabla de
locks no contemplaba), más varios hallazgos menores — incluido sacar
del alcance de 4.3 el arreglo general de `updateReservation()` (C-b), que
pasa a resolverse aparte. La Ronda 11 (gate) encontró que la conclusión de
la Ronda 10 sobre "completar" — que quedaba como la única fila sin ningún
lock de recurso — era, verificado contra Postgres real, falsa (Hallazgo 1:
la optimización de FK que saltea el chequeo en un `UPDATE` que no cambia
el valor no aplica cuando la MISMA transacción ya escribió esa fila antes,
y `assignDeferred()` seguido del `UPDATE` propio de `completeReservation()`
hace exactamente eso), y que el pre-lock de check-in especificado en la
Ronda 10 validaba de más (Hallazgo 2: usaba `assertAllResourcesAvailable()`,
que además de lockear VALIDA disponibilidad completa, agregando rechazos
nuevos a todo check-in de una reserva `ASSIGNED` — contradiciendo H1 de la
propia Ronda 10). La Ronda 12 aplicó las dos correcciones —
"completar" pasa a lockear el recurso antes que la fila cuando la reserva
sigue `PENDING_ASSIGNMENT` (con lo que la tabla de locks de §8 A6.1 queda,
por fin, sin ninguna fila de excepción), y el pre-lock de check-in pasa a
ser un lock puro, sin validación — más varias correcciones menores
(afirmaciones desactualizadas sobre `createWindow()`/`recordOccupancy()`,
citas de línea de `completeReservation()` movidas por el fix en curso de
`updateReservation()`). **La Ronda 13 re-ancló §6/§8 al fix REAL de
`updateReservation()`, ya commiteado (`6178d70`) — el mecanismo que las
Rondas 7-12 describían (comparación optimista de 8 campos, precio
resuelto fuera de la transacción) no es el que ese commit implementa
(B-1); corrigió también que `StayService` no tiene ninguna dependencia a
`this.availability` ni a `ReservationService` hoy, así que `checkIn()` no
puede llamar a `recordOccupancy()` directo como las rondas anteriores
asumían (B-2); y retiró una afirmación falsa sobre `completeReservation()`
("lee sin lock hoy" — nunca fue así) además de corregir que la decisión de
invocar `assignDeferred()` tiene que tomarse con la lectura bajo lock, no
con la lectura previa (B-3). **La Ronda 15 reemplazó el mecanismo
de congelamiento de precio por un diseño real** — el dueño eligió
"congelamiento real" (D-1', persistir QUÉ RECURSO se usó para cotizar, no
un booleano) sobre la decisión de la Ronda 14, y el gate corrigió el
mecanismo de comparación estructural de `details` (B-3 de esta ronda, no
confundir con el B-3 de la Ronda 13), el punto exacto donde se toma el
lock de "completar" (primera sentencia DENTRO de la transacción, nunca
antes de abrirla), la semántica de `ON DELETE SET NULL`, y revirtió la
decisión de la Ronda 14 sobre el cuarto sitio de wiring de
`ReservationService` (se exporta y reusa `buildStayService()`, en vez de
agregar un composition root manual — la justificación de la Ronda 14 leía
mal el docblock D-10). **La Ronda 16 (gate 17, decimoséptimo — el propio
Anexo salta de "decimoquinto" (Ronda 15) a "decimoséptimo" sin registrar
un "decimosexto": es un hueco real en la numeración externa de gates de
este repo, no un error de este documento, ver el bullet C-4 más abajo)
encontró que la columna de
D-1' es matemáticamente redundante con `resource_id`** (combinando
"congelar de verdad" con "actualizar en cada reasignación", la columna
nunca guarda un valor distinto de `resource_id` — no protege nada), más 2
bugs propios de esa columna (T-1: falta un cuarto punto de escritura en
`assignConcreteResource()`, que hubiera roto el test de preservación de
campos de A6.1; T-2: la garantía de "falla visible si falta la columna"
era falsa) — el dueño eligió no construir la columna, solo un test de
regresión (D-1, no-op estructural, §8). Corrigió también el mismo bug de
timing de lock que "completar" ya tenía hasta la Ronda 15, ahora en "Auto
Assign All" (F3-1: el candidato se lockea/valida como primera sentencia
DENTRO de la transacción, nunca antes de abrirla) y un bug real en
`findAvailableResourceInCategory()` que hace que una reserva
`PENDING_ASSIGNMENT` choque contra su propio recurso provisorio en "Auto
Assign All" (F3-2, no preexistente en producción hoy — ver el Anexo).
**Un gate posterior y DISTINTO del de la Ronda 16 (gate 18 — no "ese
mismo gate": una versión anterior de este párrafo los conflaba en uno
solo; su veredicto está registrado en la entrada "Ronda 17" del Anexo, y
coincide con el mensaje del commit `94d3a68`, "en el estado tras el 18º
gate")** aprobó Fase 1 CON CONDICIONES (agregando G-1) y dejó
Fase 2/3 en HOLD con 3 hallazgos puramente técnicos más (G-1, G-2, G-3) y
2 sobre Fase 3 (F3-3 técnico, F3-4 decisión de negocio abierta). La Ronda
17 — ronda de EDICIÓN, no un gate propio, mismo criterio que las Rondas
2/7/8/9/12 — hizo el trabajo de cierre de G-1/G-2/G-3/F3-3, en respuesta
al gate 18. La Ronda 18 refleja el gate 19, que revisó ese cierre y
encontró 3 anclas
falsas (una por G-1, una por F3-3/F3-5, una por cómo estaba planteada
F3-4) más 1 defecto técnico nuevo introducido por la propia corrección de
F3-3 (F3-5) — los 4 corregidos en esa ronda (C-1 a C-5, más C-6/C-7 sobre
otros documentos). **La Ronda 19 (esta) refleja el gate 20, que verificó
el cierre de C-1 a C-7 (Ronda 18) y encontró 4 problemas de bookkeeping
de este documento (P-1 a P-4: la numeración de gates que este mismo
párrafo corrige, el título y veredicto de la entrada "Ronda 18", el
registro del propio veredicto del gate 20, y 2 anclas de línea volátiles
en `pendientes-2026-09-12.md`) más 1 condición menor de implementación
(P-5, ubicación del test de `Reservation`) — ninguno cambia el diseño — y
dio el veredicto final: el diseño de Fase 2 queda APROBADO CON
CONDICIONES. Ver Anexo, "Ronda 19".**
El historial completo — qué encontró cada
ronda de gate, qué se decidió, por quién — vive en el **Anexo**, al final
del documento.

---

## 1. Hallazgo que revisa el encuadre del plan — hay más construido de lo que Wave 14 asume

La fila de Wave 14 dice *"diseño técnico todavía sin escribir"* para los 4
ítems por igual. Para `4.3` eso es **parcialmente falso** — verificado
contra el código vivo, no contra el plan:

- `POST /api/reservations` ya acepta **`categoryId` como alternativa a
  `resourceId`** (`src/reservas/reservations.routes.ts`, bloque
  `POST /` — ver docblock *"Asignación diferida (auditoría de deuda
  estructural, item #4)"*). Si no hay `resourceId`, resuelve el primer
  recurso libre de la categoría vía
  `ReservationService.findAvailableResourceInCategory()` y responde `409
  NO_RESOURCE_AVAILABLE` si ninguno está libre.
- `bookable_services` ya está modelado **por categoría, no por recurso**
  (`schema.sql:214-227`, `category_id NOT NULL`) — el objeto que se vende
  (el "tipo") ya es una entidad de primera clase para servicios/turnos.
- Reasignar el recurso de una reserva existente **ya es una operación
  soportada**: `PUT /reservations/:id` con `resourceId` distinto
  (`reservation.service.ts::updateReservation()`, resolución del recurso
  nuevo en líneas 547-557, `reassigned = changes.resourceId !==
  existing.resource.id` en línea 568 — re-verificado post-commit
  `6178d70`, C-2).
- La carrera entre "elegir candidato fuera de transacción" (route handler) y
  "confirmar disponibilidad" está cerrada correctamente: `createReservation()`
  vuelve a verificar disponibilidad **dentro** de la transacción
  (`assertAllResourcesAvailable()`, con lock) antes de persistir — dos
  reservas concurrentes por la misma categoría no pueden terminar
  pisándose el mismo recurso; en el peor caso, una de las dos falla en vez
  de reasignarse al siguiente candidato (gap de UX, no de integridad).

**Consecuencia práctica:** este no es un diseño desde cero. Es una extensión
de algo que ya funciona a nivel de API — la deuda real está en qué falta
para llegar al modelo de referencia (§3), no en construir el concepto de
"tipo" desde cero.

---

## 2. Modelo actual — verificado

- `reservations.resource_id` es `NOT NULL REFERENCES resources(id)`
  (`schema.sql:443-479`) — toda reserva, sin excepción, termina con una
  unidad física concreta asignada **en el momento de crearse**, aunque haya
  entrado por `categoryId`.
- `resources.category_id NOT NULL REFERENCES resource_categories(id)`
  (`schema.sql:168-180`) — cada recurso pertenece a exactamente una
  categoría; `resource_categories.is_lodging` (Backlog E1, 18/08/2026) ya
  distingue alojamiento de "turnos" (sillas, mesas, canchas).
- `findAvailableResourceInCategory()` hace un **scan lineal** de
  `getByCategory()` y devuelve el primer candidato disponible — no hay
  concepto de "cupo restante de la categoría" ni de reserva que quede
  **sin** recurso asignado.
- No existe ninguna cola de "reservas sin asignar", ni un endpoint de
  reasignación masiva, ni un reporte de disponibilidad por tipo (solo por
  recurso puntual, vía `checkAvailability(resourceId, ...)`).
- Ítems adyacentes de la misma auditoría (`docs/pendientes-2026-09-12.md`,
  Tabla resumen, `:2823`/`:2824`), fuera de alcance de este bloque:
  - **4.1** — `reservations` no tiene `location_id`; reasignar recurso
    reescribe historia (sin snapshot de "qué unidad tuvo en qué momento").
  - **4.2** — `reservations` no snapshotea el nombre del recurso al
    momento de la reserva.

---

## 3. Brecha real contra el modelo de referencia (grounding 4.3)

El grounding (`grounding-25-preguntas-2026-09-16.md:290-303`) describe un
modelo con estas piezas, comparadas contra lo que hay:

| Pieza del modelo de referencia | ¿Existe hoy? |
|---|---|
| Vender por tipo (categoría), no por unidad concreta | Sí, parcial — solo en el alta (`categoryId` en `POST`), no en disponibilidad reportada al exterior |
| Reserva puede quedar **sin** unidad asignada ("Unassigned"/"N/A") | **No** — `resource_id` es `NOT NULL`, toda reserva sale con una unidad concreta al crearse |
| Cola/vista de reservas sin asignar + asignación manual posterior | **No** |
| "Auto Assign All" (asignación masiva diferida, ej. el día de llegada) | **No** — solo hay asignación automática **inmediata**, en el momento del alta |
| Reasignar a otra unidad sin perder la reserva | Sí — `PUT` con `resourceId` nuevo ya lo soporta |
| Disponibilidad por tipo para integraciones externas (channel manager) | **No** — no hay endpoint que devuelva "cupo restante de la categoría X en el rango Y", solo "dame un recurso libre" |
| Registro histórico de qué unidad tuvo la reserva en cada momento | **No** (mismo hallazgo que 4.1/4.2) |

La pieza estructural que falta de verdad es una sola, y es la que más
cuesta: **que una reserva pueda existir sin `resource_id`** (o con un
`resource_id` que se resuelve recién en otro momento del ciclo de vida, no
al crearse). Todo lo demás (cola de sin-asignar, auto-assign masivo,
reporte de cupo por tipo) es construcción posterior sobre esa base.

---

## 4. Opciones de modelo de datos

### Opción A — `resource_id` nullable + `category_id` propio en `reservations`

- `reservations.resource_id` pasa a `NULL`able; se agrega
  `reservations.category_id NOT NULL` (server-derivado siempre).
- Estado "sin asignar" = `resource_id IS NULL`.
- Disponibilidad por tipo = nueva consulta agregada (hoy no existe nada
  parecido, todo el cálculo de `checkAvailability()` está anclado a un
  `resourceId` puntual).
- **Ventaja:** modelo más fiel al de los referentes.
- **Costo:** todo lector de `reservation.resource`/`resource.id` en el
  dominio (pricing, housekeeping, PDF, reportes, stays) tiene que aprender a
  manejar "sin asignar" — superficie amplia (§7).

### Opción B — `resource_id` sigue NOT NULL; "sin asignar" es un recurso placeholder por categoría

**Rechazada.** La justificación real está en `docs/criterios-datos.md`
PARTE 1 (clasificación maestro/transacción/documento): un
`PhysicalResource` es MAESTRO precisamente porque "existe con
independencia de lo que pase" — un recurso placeholder que solo existe
para representar el ESTADO de una reserva viola esa definición en la
raíz: su razón de ser SÍ depende de que existan reservas sin asignar en
un momento dado. Hacerlo convivir en la misma tabla que `PhysicalResource`
real le hace jugar a una fila de un MAESTRO un rol que le corresponde a un
ESTADO de una TRANSACCIÓN (`Reservation`). Razón secundaria: contamina
cualquier reporte que cuente `resources` reales por categoría con una fila
que no es una unidad física vendible.

### Opción C — Mantener `resource_id NOT NULL`, resolver "sin asignar" como un estado de `Reservation`

**Elegida.** Se agrega `reservations.assignment_status` (`ASSIGNED` /
`PENDING_ASSIGNMENT`) y se permite que `resource_id` apunte a una
asignación **provisoria** (el primer candidato encontrado, igual que hoy)
mientras `assignment_status = 'PENDING_ASSIGNMENT'` marca que esa
asignación es reoptimizable, no definitiva.

- **Transición a definitiva:** en el momento en que una reserva
  `PENDING_ASSIGNMENT` recibe un recurso concreto — por reasignación
  manual (`PUT /reservations/:id`), por "Auto Assign All" (Fase 3, §6),
  por check-in, o al completarse — pasa a `assignment_status = 'ASSIGNED'`
  y desde ahí se comporta **exactamente como cualquier reserva de hoy**.
  La transición es de **una sola vía** — `PENDING_ASSIGNMENT → ASSIGNED` —
  no hay camino de vuelta (no hay caso de negocio que lo pida). El análisis
  de esta máquina de estados contra `docs/criterios-negocio.md` §6 está en
  §8.
- **Alcance:** `assignment_status` solo aplica a reservas cuya categoría
  resuelta tiene `is_lodging = TRUE`. Para turnos (`is_lodging = FALSE`) el
  comportamiento de hoy no cambia — `findAvailableResourceInCategory()`
  sigue resolviendo de forma inmediata y definitiva, sin estado
  `PENDING_ASSIGNMENT` ni cola de pendientes.
- **Ventaja sobre A:** cero cambios de NOT NULL, ningún lector existente
  del dominio se rompe con un `resource.id` inesperadamente ausente — la
  brecha se cierra por arriba (un flag + un flujo de reasignación masiva),
  no por abajo (el schema).
- **Costo:** no resuelve "vender por tipo sin comprometer NINGUNA unidad
  concreta hasta que haga falta" — sigue reservando una unidad física al
  crear. Es un paso intermedio, no el modelo final.

### Recomendación

**Opción C primero, Opción A como Fase 4 explícita, evaluada aparte.**
Motivo: C reutiliza el 90% de lo que ya existe, no rompe ningún NOT NULL
ni contrato existente, y ya resuelve el problema de negocio más citado en
el grounding. Channel manager no está en el roadmap actual
(`docs/roadmap-pms-multirubro.md`, sección "Channel Manager": ❌) —
proyectar el modelo completo (Opción A) para un consumidor que no existe
todavía es sobre-ingeniería hoy.

---

## 5. Forks de decisión de negocio de alcance — resueltos

Dos preguntas que, una vez que "sí, planificar la migración" ya estaba
decidido, se abrían en más de una dirección razonable cada una (regla de
`CLAUDE.md`, "Preguntas de alcance pueden esconder una decisión de
negocio"). Resueltas vía `AskUserQuestion` con el dueño:

1. **¿Aplica solo a alojamiento o también a "turnos"?** El grounding
   sugiere que el mismo patrón cubre un turno "con cualquier profesional
   disponible" (`grounding-25-preguntas-2026-09-16.md:300`), pero
   `bookable_services` con `booking_mode = 'slot'` ya resuelve una versión
   más simple del mismo problema. **Resuelto: solo alojamiento.** Turnos
   queda explícitamente fuera de alcance de 4.3; si se encara después, es
   su propia unidad de trabajo con su propio costo/beneficio.
2. **¿Qué pasa con `4.1`/`4.2`?** Son hallazgos de la MISMA auditoría,
   sobre las MISMAS tablas, y cualquier flujo de reasignación los toca.
   **Resuelto: quedan en el backlog normal, fuera de este bloque.** 4.3
   sigue siendo su propio bloque acotado — `4.1`/`4.2` no se pliegan
   adentro, con ancla real en `docs/pendientes-2026-09-12.md:2823`/`:2824`.

---

## 6. Fases de implementación

**Alcance: todas las fases de abajo aplican únicamente a reservas cuya
categoría es `is_lodging = TRUE`.** Turnos no entra en ninguna fase —
sigue con la resolución inmediata de hoy, sin `assignment_status`, sin
cola de pendientes y sin "Auto Assign All". Cada fase es su propio commit
chico y reversible, con su propio gate — mismo criterio que el split de
`docs/diseno-fiscal-profile-resolver-2026-09-01.md` §12.13.

**Hallazgo sacado del alcance de 4.3 (C-b, corregido en la Ronda 10) — ya
resuelto y COMMITEADO (Ronda 13, B-1, `6178d70`).** Una versión anterior de
este documento describía acá el lock de fila + comparación optimista de 8
campos de `updateReservation()` (§8, "`updateReservation()` en relación
con `assignDeferred()`") como un cambio universal — aplicado a TODA
reserva que pase por `PUT /reservations/:id`, incluidas las de
turnos/servicios — y lo llamaba "efecto colateral aceptado" del arreglo de
un deadlock/actualización perdida real y preexistente en
`updateReservation()`, dando a entender que la implementación de 4.3 era
quien lo entregaba. Un gate distinto confirmó ese hallazgo como bug de
producción real y preexistente (`UPDATE-RESERVATION-LOST-STATUS-001`:
`updateReservation()` armaba lo que graba a partir de una lectura sin
lock, `existing`, leída ANTES de abrir la transacción) y el dueño lo
resolvió como su propio arreglo, fuera de este documento — commiteado el
24/09/2026 en `6178d70` ("fix(reservas): updateReservation() lost-update
bajo concurrencia + orden de locks correcto"), incluyendo en el MISMO
commit la corrección de orden de locks post-gate
(`UPDATE-RESERVATION-LOCK-ORDER-001`, ver `docs/pendientes-2026-09-12.md`).

**El mecanismo real que ese commit implementa NO es el que las Rondas 1-12
de este documento describían acá — no hay comparación de 8 campos ni un
lock de fila "agregado" sobre un método que antes no lockeaba nada.**
Verificado línea por línea contra `reservation.service.ts` post-commit
(re-derivado con `grep -n`/`sed -n`, no asumido — C-2):

1. `preCheck = this.requireReservation(id)` (línea 439) — SIN lock, fuera
   de la transacción: 404 barato, mismo criterio que el `preCheck` de
   `confirmReservation()`. **Corregido (C-8, Ronda 14) — la comparación
   era con el documento equivocado.** No es "a diferencia de la versión
   pre-fix": la versión PRE-FIX (el bug original,
   `UPDATE-RESERVATION-LOST-STATUS-001`) usaba la lectura sin lock para
   TODO — la construía directo, sin volver a leer nada bajo lock — así
   que ahí no había nada que "descartar", se usaba tal cual, sin
   protección. Lo que sí descartaba este resultado (releyendo todo desde
   cero bajo lock, sin reusar `preCheck` para nada) era la PRIMERA VERSIÓN
   DEL FIX, la que el gate post-commit corrigió con
   `UPDATE-RESERVATION-LOCK-ORDER-001` por el orden de locks invertido —
   esa versión intermedia sí descartaba `preCheck` por completo. La
   versión REAL, final, de `6178d70` (la que este documento describe acá)
   es la que sí reusa el resultado (no lo descarta) para decidir qué
   recurso lockear en el paso siguiente.
2. `effectiveResourceId = changes.resourceId ?? preCheck.resource.id` →
   `lockSet` (`this.availability.resolveLockedResourceIds(...)`) →
   `this.resourceRepository.lockByIds(client, [...lockSet].sort())`
   (líneas 463-468) — el recurso candidato (el nuevo si hay reasignación,
   el mismo de siempre si no) se lockea PRIMERO, dentro de la transacción,
   ANTES que la fila — mismo orden que `createReservation()`.
3. `existing = this.requireReservationWithLock(client, id)` (línea 493) —
   lock de la fila, SEGUNDO paso, nunca antes que el paso 2 (invertirlo
   abre el deadlock ABBA que `UPDATE-RESERVATION-LOCK-ORDER-001` corrigió
   sobre la primera versión del fix).
4. **Guard de coherencia — SOLO 2 campos, no 8:**
   `existing.resource.id !== preCheck.resource.id || existing.serviceId
   !== preCheck.serviceId` → `ReservationConcurrentlyModifiedError`
   (líneas 505-507). Cierra la única ventana real que el orden de arriba
   deja abierta: que `preCheck` (leído sin lock, paso 1) haya quedado
   desactualizado para decidir `lockSet` en el paso 2 — si el recurso o el
   servicio cambiaron en paralelo entre esa lectura y el lock de la fila,
   se aborta y se pide reintento, en vez de seguir con un `lockSet`
   parcial o equivocado.
5. Desde acá en más, TODO se recalcula desde `existing` (la lectura BAJO
   lock) — nunca desde `preCheck`: fechas, resolución del recurso si hay
   reasignación (líneas 547-557), categoría, `lockedResourceIds`, y —
   distinto de lo que este documento asumía hasta la Ronda 12 — **también
   el precio**: `resolvePrice()` corre DENTRO de la transacción (líneas
   597-606), solo si `existing.status === 'PENDING'` (línea 593), con el
   `resource` ya resuelto bajo lock. No queda ningún "precio candidato"
   calculado afuera de la transacción que proteger con una comparación
   posterior — se calcula una sola vez, ya bajo lock, sobre datos que el
   guard del paso 4 ya certificó como no obsoletos.
6. `assertAllResourcesAvailable(...)` (líneas 622-629) corre DESPUÉS de
   resolver el precio — re-lockea el mismo recurso que el paso 2 ya
   lockeó (no-op: Postgres permite `FOR UPDATE` repetido sobre la misma
   fila dentro de la misma transacción) y valida overlap/mantenimiento
   contra las fechas ya vigentes.
7. `Reservation.restore()` (línea 631) construye la entidad a persistir a
   partir de `existing` + `changes`; `saveWithClient()` (línea 702) cierra
   la transacción.

**4.3 no implementa ni se atribuye ese arreglo — pero su propia
composición (el discriminador de §8, más abajo) sí depende de que esté
vigente para ser segura.** El commit existe (verificable con `git log
6178d70 -1`); si ya está pusheado/deployado a producción en el momento en
que se implemente Fase 2 no se deja constancia fija acá — se verifica en
el momento con `git log origin/main --oneline | grep 6178d70`, mismo
criterio que ya establece el `CLAUDE.md` de este repo para no registrar un
estado de push como un hecho estable del texto. Turnos puede recibir el
error `409` de conflicto concurrente (`ReservationConcurrentlyModifiedError`)
por este mismo mecanismo, ya que `updateReservation()` no distingue
turnos de alojamiento — comportamiento ya existente, no una entrega de
4.3.

### Fase 0 — instrumentación, sin cambio de comportamiento

Endpoint de solo lectura `GET /reservations/availability-by-category`
(cupo restante de una categoría `is_lodging = TRUE` en un rango) — hoy no
existe nada parecido; sirve también para validar el modelo antes de tocar
el flujo de alta.

**Parámetro `serviceId` (opcional), agregado al contrato en la Ronda 14
(C-5, gate `architecture-governor`) — condición nueva sobre Fase 0, ya
"aprobada con condiciones".** El alta por categoría
(`POST /reservations`, bloque `POST /`, `reservations.routes.ts`) ya le
pasa `body.serviceId` a `findAvailableResourceInCategory()` cuando viene
en el body (verificado en código — el parámetro ya es opcional en la
firma real, `reservation-availability.service.ts:234-260`:
`serviceId?: string`). Si el servicio de alojamiento tiene
`resource_locks` propios (bloquea, además del recurso principal, otros
recursos — `resolveLockedResourceIds()`, ver §7, fila de
`resource-lock.service.ts`), el conteo de "cupo restante" puede diferir
según se pida CON o SIN `serviceId` — sin él, `checkAvailability()` no
excluye los recursos que ese servicio bloquea, así que el endpoint podría
contar como libre una unidad que el alta real, con `serviceId`, después
rechazaría. Dado que N4 ya estableció que la precisión de este número
importa (el dueño eligió la opción más precisa, "rango completo", no la
más simple), y que Fase 0 todavía no se implementó — corregir su contrato
ahora es un cambio de documento, no rompe nada ya construido — se agrega
`serviceId` como parámetro opcional del endpoint, mismo nombre y mismo
comportamiento-por-omisión que ya tiene `findAvailableResourceInCategory()`
(sin él, el conteo no filtra por servicio, igual que hoy sin este
parámetro). Reenviarlo tal cual a la misma consulta de conteo equivalente
descrita abajo — sin lógica nueva, solo un parámetro más que pasa a la
misma función/consulta que ya lo soporta.

**Precisión de qué cuenta "cupo restante" (N4, decisión del dueño vía
`AskUserQuestion`, 24/09/2026).** El endpoint cuenta cuántas unidades de la
categoría quedan libres las noches COMPLETAS del rango pedido — la MISMA
noción de "disponible" que ya usa `findAvailableResourceInCategory()`
(`reservation-availability.service.ts:234-260`) para elegir el primer
candidato al crear una reserva por categoría: esa función recorre
`getByCategory()` y, para cada candidato, llama a
`checkAvailability(resource.id, startTime, endTime, ...)`
(`reservation-availability.service.ts:157`), que evalúa el RANGO COMPLETO
`[startTime, endTime)` de una sola vez (mantenimiento + solapamiento con
`reservations`/cupo compartido) — no hay ningún cálculo de "mínimo por
noche" en el código real, verificado. Fase 0 reusa esa MISMA noción de
disponibilidad — no necesariamente llamando a `findAvailableResourceInCategory()`
tal cual (que devuelve el PRIMER candidato y se detiene, no cuenta), sino
con una consulta de conteo equivalente: recorrer los recursos de la
categoría y contar cuántos pasarían el mismo `checkAvailability()` para el
rango completo pedido, en vez de devolverse en el primero. Esta
equivalencia semántica es la garantía que le importa al negocio — que el
número que este endpoint devuelve nunca "mienta" respecto de si el alta
por categoría (`POST /reservations` con `categoryId`) va a poder resolver
un recurso — no el detalle de implementación (loop explícito vs. una
consulta SQL agregada), que queda a criterio de quien construya la fase.

**Nota de implementación, obligatoria para quien construya esta fase**
(no resuelta acá, declarada para que no aparezca de sorpresa): esta ruta
hoy no tiene grupo RBAC asignado, ni fila en
`docs/rbac-matriz-endpoints.md`, ni está contada en
`EXPECTED_AUTHORIZE_CALL_SITES` (`rbac-matrix-sync.test.ts`), ni en
`docs/inventario-rutas.md`, ni en `NO_CONSUMER_ROUTES`
(`route-consumer-coverage.test.ts`) — las cinco cercas de RBAC/contrato de
`app-main/CLAUDE.md` la van a marcar como faltante en cuanto se implemente,
y hay que actualizar las cinco en el mismo cambio. Recomendación de grupo:
`Roles.FRONT_DESK` — mismo grupo que ya usan las otras dos rutas de
solo-lectura de reservas (`GET /reservations` y `GET /reservations/:id`,
ambas `authorize(Roles.FRONT_DESK)` en `reservations.routes.ts`).
**Orden de montaje obligatorio:** tiene que registrarse ANTES de
`GET /reservations/:id` en `reservations.routes.ts` — verificado en
código, el archivo monta `GET /` primero, `POST /search` segundo y
`GET /:id` tercero; Express matchea rutas en el orden en que se declaran,
así que `GET /availability-by-category` montada después de `GET /:id`
quedaría tapada por ella (Express la interpretaría como un `:id` literal
`"availability-by-category"`).

### Fase 1 — infraestructura, cero cambio de comportamiento de asignación

Se crea todo lo que Fase 2 va a necesitar, pero **ninguna reserva nace
`PENDING_ASSIGNMENT` todavía**:

- Columna `reservations.assignment_status` (default `'ASSIGNED'` en
  Postgres, para el backfill de lo existente y de lo que sigue entrando
  por `resourceId` explícito o por turnos). **DDL explícito (C-4, Ronda
  13, declarado obligatorio para Fase 1, ya aprobada con condiciones):**
  - `NOT NULL` en la columna — no puede ser opcional: el mismo motivo por
    el que `ReservationProps.assignmentStatus` es obligatorio sin default
    en TypeScript (bullet siguiente) aplica al schema — un valor ausente
    reintroduciría el bug en el punto de mayor superficie (§8 A6.1, fila
    de `buildReservation()`).
  - `CHECK (assignment_status IN ('ASSIGNED', 'PENDING_ASSIGNMENT'))` —
    espejo en SQL de `ASSIGNMENT_STATUS_TRANSITIONS` (§8 A6.1): el schema
    no debe aceptar un tercer valor que la entidad TypeScript rechazaría.
  - **Patrón DDL idempotente, mismo precedente que
    `chk_reservations_adultos`** (`src/db/schema.sql:510` — `ALTER TABLE
    reservations ADD COLUMN IF NOT EXISTS adultos INTEGER;` — y
    `:513-519`, el bloque `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM
    pg_constraint WHERE conname = 'chk_reservations_adultos') THEN ALTER
    TABLE reservations ADD CONSTRAINT chk_reservations_adultos CHECK
    (...); END IF; END $$;` — verificado en código, re-derivado con
    `grep -n`/`sed -n`, no asumido): `assignment_status` sigue el mismo
    patrón —
    `ADD COLUMN IF NOT EXISTS assignment_status VARCHAR(20) NOT NULL
    DEFAULT 'ASSIGNED'` (la migración se re-aplica en cada deploy vía
    `npm run migrate:tenants`, `schema.sql` es idempotente por diseño —
    ver `app-main/CLAUDE.md`, sección Contratos/pipeline-trust), más un
    bloque `DO $$ ... END $$` análogo para el `CHECK`, con el mismo
    `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...')`
    para no fallar en un re-run.
  - **Backup antes de `migrate:tenants` en producción, obligatorio** —
    mismo criterio que cualquier migración de este repo
    (`docs/conocimiento/runbook-deploy-render.md`): esta columna se
    aplica a TODAS las tenant DB en el mismo deploy (el `buildCommand` de
    `render.yaml` encadena `migrate:tenants` después del build,
    `pipeline-trust`), así que un backup reciente tiene que existir antes
    de correr el deploy que introduce Fase 1, no después de un incidente.
- `assignmentStatus` en `ReservationProps`/`Reservation.restore()` pasa a
  ser **obligatorio, sin default** en TypeScript (mismo patrón que
  `reservationNumber`, `Reservation.ts:136-151`, "obligatorio y sin
  default a propósito" — ver §8 A6.1 para el detalle de por qué el default
  de la columna de Postgres y el default del parámetro de TypeScript son
  dos cosas distintas, y por qué el segundo no puede existir).
- **`baseSelect()` (`sql.reservation.repository.ts`, método privado que
  arma el `SELECT` reusado por `getById()`/`getByIdWithLock()`/etc. —
  hoy termina en `FROM reservations r`, sin `assignment_status` en su
  lista de columnas, verificado con `grep -n` contra el archivo real)
  agrega `r.assignment_status` a esa lista.** Condición nueva de Fase 1
  (G-1, gate 18 — no estaba especificado explícitamente en versiones
  anteriores de este documento, que solo mencionaban `buildReservation()`
  como consumidor, no la función que arma el `SELECT` que `buildReservation()`
  recibe como fila). Sin este bullet, `row.assignment_status` en
  `buildReservation()` sería siempre `undefined` — ver el punto siguiente
  para por qué eso deja de ser silencioso.
- **Validación en runtime del valor, no solo del tipo declarado (G-1, gate
  18) — distinta de, y adicional a, la validación de la TRANSICIÓN que ya
  hace `assignConcreteResource()` (§8 A6.1).** El constructor de
  `Reservation` (y, por lo tanto, `Reservation.restore()`, que lo invoca
  internamente) valida `assignmentStatus` contra
  `Object.keys(ASSIGNMENT_STATUS_TRANSITIONS)` (§8 A6.1) y lanza
  `InvalidReservationError` si el valor no es exactamente `'ASSIGNED'` o
  `'PENDING_ASSIGNMENT'` — incluido el caso `undefined` (un `SELECT` que
  se olvide de `r.assignment_status`, el bullet de arriba, o cualquier
  otro caller que no reenvíe el campo). **Mismo mecanismo que ya usa
  `reservationNumber` en este constructor — el precedente correcto
  (corregido, C-1 de la ronda de correcciones sobre el gate 19: una
  versión anterior de este párrafo citaba `id`/`partySize` como "los
  demás campos obligatorios sin default del constructor", y los dos
  ejemplos eran falsos — `id` sin valor tira `TypeError` de `.trim()`
  (`Reservation.ts:272`), no un error de dominio; `partySize` SÍ tiene
  default `= 1` en la destructuración (`Reservation.ts:250`), así que un
  valor `undefined` nunca llega a fallar `partySize < 1`
  (`Reservation.ts:276`) — pasa a valer 1 en silencio).** `reservationNumber`
  no tiene default en la destructuración (`Reservation.ts:265`) y se
  valida por VALOR: `!Number.isInteger(reservationNumber) ||
  reservationNumber < 1` (`Reservation.ts:273-275`) lanza
  `InvalidReservationError` para `undefined` (`Number.isInteger(undefined)
  === false`) igual que para cualquier otro valor inválido — mismo patrón
  que Fase 1 ya declara para `assignmentStatus` (`Reservation.ts:136-151`,
  "obligatorio y sin default a propósito", ver §6). Ver también T-2 en el
  Anexo, Ronda 16: la garantía de "columna faltante = falla visible" que
  D-1' prometía para `priced_with_resource_id` sin este mecanismo real
  resultó falsa — `buildReservation()` no tiene ningún guard propio; acá
  el guard vive en el constructor de la entidad, no en el repositorio, por
  eso protege a los 3 call-sites de `restore()` por igual, no solo a
  `buildReservation()`. **Test obligatorio, parte del diseño, alcance de
  implementación de Fase 1 — archivo nuevo, `src/tests/domain/reservation.test.ts`
  (corregido, C-1 de la ronda de correcciones sobre el gate 19: una
  versión anterior de este párrafo decía "mismo patrón que los tests
  existentes de validación de constructor de esta entidad ... no un
  archivo nuevo" — el gate verificó que esos tests NO EXISTEN: no hay
  ningún `Reservation.test.ts` hoy, y ningún test de este repo construye
  un `Reservation`/`Reservation.restore()` con `partySize`/`totalPrice`
  inválidos a propósito — `grep -rlnE "new Reservation\(|Reservation\.restore\("`
  contra `src/**/*.test.ts` (corregido, P-5 de la ronda de correcciones
  sobre el gate 20: una versión anterior de este comando citaba el segundo
  patrón como si fuera un argumento de ruta aparte —
  `grep -rln "new Reservation(" "Reservation.restore("` —, en vez de
  combinarlo con el primero vía `-E`/alternancia) solo encuentra usos de
  setup en `stay.service.test.ts`, `reservation-availability.service.test.ts`,
  `api/mappers/reservation.mapper.test.ts`,
  `in-memory.reservation.repository.test.ts`, `reservation.service.test.ts`,
  `cancellation-refund.service.test.ts` y
  `reservation-hold-expiry.worker.test.ts` — ninguno dedicado al
  constructor de la entidad. Mismo argumento ya usado para G-2: sin
  ningún bloque existente que pruebe el constructor/`restore()` de
  `Reservation` en aislamiento, no hay "archivo existente" al que
  sumarle este test — nace uno nuevo. Ubicación corregida (P-5, ronda de
  correcciones sobre el gate 20): no "mismo directorio que el resto del
  módulo" — `src/tests/domain/` es la convención real para tests de
  ENTIDADES de dominio en este repo (constructor/invariantes), distinta
  de la de servicios (que sí se co-ubican junto a su archivo fuente,
  `reservation.service.test.ts` junto a `reservation.service.ts`).
  Precedente directo, del MISMO módulo `reservas/`:
  `src/tests/domain/resource.entities.test.ts` prueba `PhysicalResource`
  (`reservas/resource.entities.ts`) sin vivir junto a ella; también
  `src/tests/domain/customer.test.ts` prueba `Customer`
  (`clientes-finanzas/customer.entities.ts`) con `InvalidCustomerError`,
  mismo patrón que `InvalidReservationError` acá. Verificado con `ls
  src/tests/domain/`):** un test unitario en ese archivo nuevo, de
  `Reservation.restore()`/`new Reservation(...)`, que pase un
  `assignmentStatus` inválido (ej. `undefined as unknown as AssignmentStatus`,
  o el string `'FOO'`) sobre props por lo demás válidas, y verifique que
  lanza `InvalidReservationError`.
- `assignmentStatus` se agrega a `ReservationDto` (`reservation.mapper.ts`)
  — visible en el path de staff (`GET /reservations`, `GET /:id`), y
  filtrado explícitamente de las 4 respuestas del portal de clientes
  (`api/routes/customer.routes.ts` — `GET /me/reservations`,
  `POST /me/reservations`, `PATCH /me/reservations/:id`,
  `POST /me/reservations/:id/cancel`; citadas por símbolo, no por línea,
  C-c: el archivo recibió cambios de otro bloque, ya commiteados
  (`061e1ed`, "feat(auth): TTL de sesión configurable por negocio +
  revocación real vía token_version", Wave 15 ítems 1+2 — corregido, C-3,
  Ronda 14: el hash citado hasta la Ronda 13 era `5e6d4a8`, que no es el
  último commit real que toca `customer.routes.ts` — verificado con `git
  log --oneline -- src/api/routes/customer.routes.ts`, `061e1ed` es el
  más reciente) — se mantiene la cita por símbolo porque el
  archivo puede seguir moviéndose con cambios futuros no relacionados, no
  porque siga habiendo algo sin commitear) — el huésped
  no debe ver "tu unidad todavía no está asignada definitivamente" como un
  estado nuevo en su experiencia. Las reservas creadas desde el portal
  siempre entran por `resourceId` explícito, así que nacen `ASSIGNED` de
  entrada — el caso real a filtrar es una reserva creada por STAFF a
  nombre de un cliente.
- Cambio de mail de confirmación: el payload de `reservation.confirmed`
  (`reservation.service.ts`, bloque de `confirmReservation()`) agrega
  `categoryName: category?.name` (el método ya resuelve `category` antes
  de ese bloque, para `isLodging`). `email.handlers.ts` elige, según
  `isLodging`, qué nombre mostrar: `isLodging ? (categoryName ??
  resourceName) : resourceName` — el `?? resourceName` es compatibilidad
  con eventos viejos del outbox reprocesados que no traen `categoryName`.
  **Solo para alojamiento** — turnos siguen mostrando `resourceName` sin
  cambios. `templates.ts:44` no cambia (sigue recibiendo un solo parámetro
  `resourceName: string`, la plantilla ya usa la etiqueta genérica
  "Recurso/Servicio").
- El alta de reservas **sigue asignando recurso de forma inmediata, como
  hoy**, grabando `assignment_status = 'ASSIGNED'` directo — el
  `categoryId` del alta se sigue resolviendo a un recurso concreto en el
  mismo request, sin pasar por ninguna cola.

**Por qué Fase 1 no marca nada todavía:** si el marcado (nacer
`PENDING_ASSIGNMENT`) saliera en Fase 1 y el resto del mecanismo
(`assignDeferred()`, la cola, "Auto Assign All", el salteo de
`recordOccupancy()`) recién en Fase 2, cualquier reserva que se confirme,
haga check-in o se complete en la ventana entre ambos deploys lo haría con
código VIEJO — sin `assignDeferred()`, sin el salteo de ocupación —
dejando ocupación fantasma y una necesidad real de backfill. Con Fase 1
sola nunca creando ninguna fila `PENDING_ASSIGNMENT`, esa ventana no
existe: **nunca hay backfill que hacer**, no porque se resuelva, sino
porque nunca hay nada que backfillear.

### Fase 2 — el mecanismo completo, en un solo deploy

Todo lo de abajo se activa **junto**, en el mismo deploy — no hay
subconjunto deployable por separado sin reabrir la ventana de riesgo que
Fase 1 evita a propósito:

1. **Activación real del marcado — contrato explícito ruta ↔ servicio
   (B2).** Hoy `reservations.routes.ts` (bloque `POST /`, líneas 385-400)
   resuelve category→resource del lado de la ruta (para tener un
   `resourceId` con qué llamar a `createReservation()`), pero
   `createReservation()` (`reservation.service.ts:210`, construye la
   entidad con `new Reservation(...)` en la línea 368 — re-verificadas
   post-commit `6178d70`, C-2 — el CUARTO sitio de
   construcción de `ReservationProps`, sumado a los 3 call-sites de
   `Reservation.restore()` de la fila de §7) nunca se entera de que la
   reserva entró por categoría en vez de por `resourceId` explícito. La
   ruta pasa una señal nueva, `enteredByCategory: boolean`
   (`!body.resourceId && !!body.categoryId` — mismo booleano que ya decide
   la rama de `findAvailableResourceInCategory()` en el bloque
   385-400, reenviado sin recalcular) al `params` de `createReservation()`.
   `createReservation()` usa esa señal para decidir el valor inicial de
   `assignmentStatus` que pasa a `new Reservation(...)`:
   `enteredByCategory && category?.isLodging ? 'PENDING_ASSIGNMENT' :
   'ASSIGNED'` — el alta por `categoryId` de una categoría `is_lodging =
   TRUE` empieza a marcar la reserva nueva como `assignment_status =
   'PENDING_ASSIGNMENT'` (en vez de resolver y grabar `'ASSIGNED'` directo,
   como hacía Fase 1).
2. **`ReservationService.assignDeferred()` existe** — la operación única
   de aplicación que confirma una asignación provisoria (§8 A6.1). Todos
   los caminos de abajo la invocan; ninguno reimplementa sus pasos.
3. **`PUT /reservations/:id` (`updateReservation()`) la invoca** cuando
   corresponde — sobre el mecanismo de lock/relectura bajo lock que
   `updateReservation()` ya tiene desde el fix commiteado `6178d70`
   (guard de coherencia de `resource.id`/`serviceId`, no un precio
   precalculado que proteger — ver §8, "`updateReservation()` en relación
   con `assignDeferred()`", reescrita en la Ronda 13).
4. **Check-in confirma la asignación** (`stay.service.ts::checkIn()`) —
   ver más abajo, "Sub-alcance: check-in".
5. **Completar confirma la asignación** (`reservation.service.ts::completeReservation()`)
   — ver más abajo, "Sub-alcance: completar".
6. **`recordOccupancy()` se saltea mientras `PENDING_ASSIGNMENT`** — ya no
   es una decisión de timing de deploy (a diferencia de lo que una versión
   anterior de este documento discutía): como Fase 1 nunca crea ninguna
   fila `PENDING_ASSIGNMENT`, no hay ninguna ventana en la que esta regla
   pueda dejar ocupación sin registrar para siempre. Es simplemente parte
   del mismo cambio que activa el marcado.
7. **`approveScheduleChange()` rechaza evaluar contra una reserva
   `PENDING_ASSIGNMENT`** — ver §7, fila de `approveScheduleChange()`.
8. **Mapeo de errores nuevos en `error.middleware.ts` (C2), alcance de
   implementación obligatorio de esta fase, mismo commit que introduce cada
   error.** **Corregido (N-3, Ronda 14, gate `architecture-governor`) — son
   4 errores nuevos, no 5.** Los tipados que Fase 2 agrega de verdad —
   `AssignmentCategoryMismatchError`, `AssignmentCombinedChangeError`,
   `ReservationAlreadyAssignedError` y `ScheduleChangeAssignmentPendingError`
   — no tienen entrada propia en `error.middleware.ts` hasta que se
   agreguen: sin mapeo, caen al `default:` y responden 500 en vez del
   código HTTP que les corresponde (409 para los 3 de
   conflicto/concurrencia — `AssignmentCategoryMismatchError`,
   `AssignmentCombinedChangeError`, `ReservationAlreadyAssignedError` —
   mismo grupo que `RESOURCE_OCCUPIED`/`SCHEDULE_CONFLICT` de
   `error.middleware.ts`, el bloque de `case` que termina en `return
   409;`; `ScheduleChangeAssignmentPendingError` también 409, mismo grupo,
   por ser una precondición de estado no cumplida). **`ResourceOccupiedError`
   y `ReservationConcurrentlyModifiedError` YA están mapeados hoy — ninguno
   de los dos es "nuevo de Fase 2", ninguno necesita entrada nueva:**
   `ResourceOccupiedError` en `error.middleware.ts::case
   'RESOURCE_OCCUPIED':` (ya lo estaba antes de este diseño; solo hace
   falta confirmarlo tras la relocación de A6.1); `ReservationConcurrentlyModifiedError`
   en `error.middleware.ts::case 'RESERVATION_CONCURRENTLY_MODIFIED':`
   (grupo 409, verificado en código) — el fix `6178d70` de
   `updateReservation()` YA agregó esa clase a `domain/errors.ts` y ese
   `case` al middleware (verificado con `git show 6178d70 --stat` y
   `grep -n` contra los dos archivos reales), así que a esta altura del
   documento ya no es "un error que Fase 2 va a introducir" — es un error
   preexistente que Fase 2 REUSA (mismo criterio que
   `ResourceOccupiedError`). Una versión anterior de este bullet (hasta la
   Ronda 13) seguía listándolo entre los "tipados nuevos... sin mapeo...
   500" — falso, y contradecía la propia nota de citas por símbolo de este
   mismo bullet (más abajo), que ya reconocía que `6178d70` "agrega el
   mapeo de `ReservationConcurrentlyModifiedError`". Sin el mapeo de los 4
   errores genuinamente nuevos, el frontend no puede distinguir estos
   casos entre sí ni de un error real de servidor, y cada ocurrencia se
   loguea como 500 cuando no lo es.
   **Mensaje parametrizado, obligación de implementación de esta fase
   (Ronda 15, corrección sobre el gate 15).** El mensaje fijo de
   `ReservationConcurrentlyModifiedError` (`domain/errors.ts:1007-1014`,
   re-derivado con `grep -n`: constructor en 1008, mensaje en 1010 —
   *"cambió de recurso o de servicio en paralelo..."*) describe con
   precisión el ÚNICO caso que la clase cubre hoy (el guard de
   `updateReservation()`, `resource.id`/`serviceId`) pero deja de ser
   preciso para los usos nuevos que 4.3 le agrega — el guard de
   "completar" (§8, "completar", tabla de 6 casos) puede dispararse por un
   cambio de `assignmentStatus`, no de recurso; el aborto de "Auto Assign
   All" por rango de fechas (§6 Fase 3) es sobre fechas, no sobre recurso
   ni servicio. **Opción elegida — la más simple: parametrizar el mensaje,
   no un error tipado nuevo ni un segundo código HTTP.** El constructor
   gana un segundo parámetro opcional, con el texto actual como default —
   así el único call-site real que ya existe hoy (`updateReservation()`,
   dentro de `6178d70`) no necesita tocarse:
   ```
   constructor(reservationId: string, reason: string = 'cambió de recurso o de servicio') {
     super(`La reserva "${reservationId}" ${reason} en paralelo antes de poder tomar su lock -- reintentá la operación con el estado actual.`, 'RESERVATION_CONCURRENTLY_MODIFIED');
   }
   ```
   Mismo código de error (`RESERVATION_CONCURRENTLY_MODIFIED`), mismo
   `case` de `error.middleware.ts` — sin mapeo nuevo que agregar. Los 2
   call-sites nuevos de 4.3 pasan su propio `reason`: el guard de
   "completar" usa `'cambió de estado de asignación o de recurso
   candidato'` (cubre las 2 filas del guard, §8 sección "completar" —
   ambas ramas del `||` son, en los dos casos, una pérdida de coherencia
   entre lo que `preCheck` vio y lo que `locked` confirma, no vale la pena
   dos textos distintos para una sola condición compuesta); el aborto de
   "Auto Assign All" usa `'cambió de fechas'` (§6 Fase 3).
   **Nota sobre estas citas (C-c):** se citan por SÍMBOLO (nombre de
   `case`), no por número de línea — `error.middleware.ts` ya recibió
   cambios de otro bloque (Wave 15/D-05) y, más recientemente, del propio
   fix `6178d70` de `updateReservation()` (que agrega el mapeo de
   `ReservationConcurrentlyModifiedError`, ver `git show 6178d70 --stat`);
   ambos ya están commiteados, pero el archivo puede seguir moviéndose con
   cambios futuros no relacionados antes de que este bloque se implemente
   — la cita por símbolo se mantiene por eso, no por nada pendiente de
   commitear.
9. **D-1 — no-op estructural, cerrado sin construir columna (Ronda 16,
   revierte D-1'); D-2, rechazo del combo `resourceId` +
   `details`/`adultos`/`ninos` (decisión del dueño, Ronda 14), sigue
   vigente sin cambios — ver §8, subsección "D-1", y el discriminador de
   `updateReservation()` en "`updateReservation()` en relación con
   `assignDeferred()`" para el detalle completo.** El precio de
   alojamiento no depende hoy de qué recurso puntual se le asigna a la
   reserva (verificado tres veces — corregido, condición menor del gate
   18, contaba "dos veces" y se saltaba la reconfirmación de la Ronda 15:
   Ronda 14, la reconfirmación de la Ronda 15/B-2 ("confirmado de nuevo",
   ver Anexo), y el gate de la Ronda 16) —
   no hay ninguna columna nueva que agregar. Lo que Fase 2 sí agrega,
   como parte de su propio alcance de implementación, es el test de
   regresión que el dueño pidió en vez de la columna — diseño completo en
   §8, "D-1". D-2 es independiente de esta decisión (es una regla de
   rechazo sobre `updateReservation()`, no depende de ninguna columna
   nueva) y no cambia.

**Runbook de rollback de Fase 2, parte obligatoria del deploy, no una nota
al pie (B3, corregido C-d en la Ronda 9).** Si Fase 2 se revierte (rollback
de deploy) con filas ya marcadas `assignment_status = 'PENDING_ASSIGNMENT'`
en la BD, el código de Fase 1 (que no conoce `assignDeferred()`) seguiría
registrando ocupación al confirmar esas reservas (Fase 1 no saltea
`recordOccupancy()`, ese salteo es parte de Fase 2) pero nunca resolvería
el estado `PENDING_ASSIGNMENT` — quedan colgadas. Si Fase 2 se vuelve a
deployar más tarde, `assignDeferred()` las procesaría de nuevo y podría
contar ocupación dos veces (una vez bajo el código de Fase 1 post-rollback,
otra al reasignarse bajo Fase 2 redeployada). Por eso, un rollback de
Fase 2 exige un paso de datos:

```sql
UPDATE reservations SET assignment_status = 'ASSIGNED'
WHERE assignment_status = 'PENDING_ASSIGNMENT';
```

(o el mecanismo equivalente). **Corrección de timing (C-d):** este `UPDATE`
tiene que correr DESPUÉS de que el código de rollback ya esté sirviendo
tráfico — no antes. Corriéndolo ANTES (como decía una versión anterior de
este documento) deja una ventana donde Fase 2 sigue vigente y sigue
marcando reservas NUEVAS como `PENDING_ASSIGNMENT` mientras el `UPDATE` ya
corrió, así que esas filas nuevas quedan sin tocar. El `UPDATE` es
idempotente (`WHERE assignment_status = 'PENDING_ASSIGNMENT'` — correrlo
dos veces no hace daño), así que la forma más simple de cubrir la ventana
completa es correrlo UNA VEZ, inmediatamente después de que el código de
rollback esté sirviendo tráfico (no antes, no dos veces) — a partir de ese
momento no se crean más `PENDING_ASSIGNMENT` nuevas (el código vigente ya
es el de Fase 1), así que una sola corrida alcanza para vaciar la cola que
haya quedado. Este paso es parte obligatoria del runbook de deploy/rollback
de Fase 2, no algo a improvisar en el momento del incidente.

**Subconteo temporal aceptado (C-d).** Las reservas `CONFIRMED` que este
`UPDATE` pasa de `PENDING_ASSIGNMENT` a `ASSIGNED` quedan SIN ocupación
registrada — el mecanismo que la registra es `recordOccupancy()`, llamado
por los callers de `assignDeferred()` (§7), y el `UPDATE` de rollback no
pasa por `assignDeferred()` ni por `recordOccupancy()`, escribe la columna
directo. Esa ocupación queda faltante hasta que esas reservas se
completen (`completeReservation()` sigue llamando a `recordOccupancy()`
siempre, con o sin `assignDeferred()` de por medio — §6, sub-alcance
"completar"). Esto es un subconteo temporal ACEPTADO, no un bug a arreglar
en el runbook — consistente con que un rollback es un evento excepcional,
no el camino normal de esta operación.

Cada regla de negocio individual (restricción de categoría, no-recotización,
filtro de `Stay` activa) vive DENTRO de `assignDeferred()` — los 3 callers
de Fase 2 (PUT, check-in, completar) la heredan gratis, sin reimplementarla.

**"La cola" es un concepto diferido, no un entregable de Fase 2 (C5,
declarado explícitamente).** El documento usa "la cola" varias veces como
atajo verbal para "el conjunto de reservas `PENDING_ASSIGNMENT`" — pero
ninguna fase entrega un endpoint o mecanismo concreto de "ver todas las
pendientes": no está en la tabla §6.1, no tiene fila en
`docs/rbac-matriz-endpoints.md`, y no hay ítem de implementación que la
mencione como entregable. Fase 2 trae únicamente la CAPACIDAD de asignar
manualmente una reserva puntual (`PUT /reservations/:id`, ya existente,
solo reforzado con `assignDeferred()`) — no una UI ni un endpoint dedicado
de listado/filtro de pendientes. Eso queda para una fase futura, no
numerada, no decidida todavía. "Auto Assign All" (Fase 3) tampoco necesita
ese endpoint: procesa TODAS las `PENDING_ASSIGNMENT` de una fecha
directamente contra la BD (`WHERE assignment_status = 'PENDING_ASSIGNMENT'
AND ...`), no contra un listado que el staff haya visto antes.

#### Sub-alcance: check-in confirma la asignación

**Discriminador explícito, primero de todo (H1, corrección obligatoria de
la Ronda 10).** Una versión anterior de esta sección resolvía "¿está
`PENDING_ASSIGNMENT`?" recién DENTRO de `assignDeferred()` — pero el paso
2 de esa operación (`ReservationAlreadyAssignedError`, §8 A6.1) lanza
precisamente si la reserva NO está `PENDING_ASSIGNMENT`. Leído
literalmente, todo check-in de HOY sobre una reserva `ASSIGNED` — el 100%
de los check-ins reales hasta que Fase 2 empiece a producir
`PENDING_ASSIGNMENT` (y ni siquiera todas las reservas de alojamiento la
van a tener) — habría empezado a fallar con ese error. Corregido:
`checkIn()` lee `assignmentStatus` de la reserva PRIMERO, bajo el mismo
lock de fila que el resto del método toma (ver el orden de locks más
abajo, H2), y decide en base a eso ANTES de considerar invocar
`assignDeferred()`:

- **Si `locked.assignmentStatus === 'ASSIGNED'`** (el caso de HOY): el
  check-in sigue funcionando EXACTAMENTE como hoy, sin ningún cambio de
  comportamiento — el staff puede hacer check-in en cualquier
  `resourceId` que elija, incluso distinto del de la reserva (ya
  documentado, "puede diferir del recurso reservado"). **No se invoca
  `assignDeferred()` en absoluto**: sin la restricción de categoría (esa
  restricción SOLO aplica al camino de asignación diferida — una reserva
  ya `ASSIGNED` no pasa por ahí) y sin el guard de `Stay`s activas que
  trae `assignDeferred()` como paso propio (§8 A6.1, paso 7) — el check-in
  de una reserva `ASSIGNED` no gana ninguna validación nueva de 4.3. (El
  guard de `Stay` activa que `checkIn()` YA tiene HOY —
  `findActiveByResource()` contra el propio `input.resourceId`,
  independiente de 4.3 — sigue corriendo igual, para las dos ramas.)
- **Si `locked.assignmentStatus === 'PENDING_ASSIGNMENT'`**: `checkIn()`
  invoca `assignDeferred()` — el mecanismo diseñado más abajo, sin
  cambios.

El mecanismo nuevo de 4.3 es, en consecuencia, estrictamente ADITIVO sobre
el check-in de hoy: solo se activa para el subconjunto nuevo de reservas
`PENDING_ASSIGNMENT` que Fase 2 empieza a producir. Cruce de módulos, para
el camino que SÍ invoca `assignDeferred()`: `pms-estadias` (dueño de
`checkIn()`) → `reservas` (dueño de `assignDeferred()`); ver §8 A6.1 para
la resolución del riesgo de ciclo de imports que esto introduce.

**Si el recurso elegido es de otra categoría** que la reserva original
(upgrade real en el mostrador) — aplica solo al camino
`PENDING_ASSIGNMENT` de arriba, es `assignDeferred()` quien lo evalúa —
el check-in rechaza con `AssignmentCategoryMismatchError` — mismo criterio
que PUT y "Auto Assign All": un cambio real de tipo de unidad queda fuera
de alcance de 4.3. El staff que necesite un upgrade real lo resuelve por
otra vía (ej. cambiar la categoría de la reserva antes del check-in, si
ese flujo existe). Una reserva `ASSIGNED` (la otra rama del discriminador)
no tiene esta restricción — sigue permitiendo cambiar de categoría al
check-in como hoy, porque no pasa por `assignDeferred()`.

**Requisitos de implementación, declarados con precisión** (alcance de
implementación de Fase 2, no resuelto en detalle acá):

- `checkIn()` hoy **no corre dentro de ninguna transacción** — verificado
  en código, no hay `transactionManager.run()` en el método (a diferencia
  de `requestScheduleChange()`/`rejectScheduleChange()`/
  `approveScheduleChange()` de este mismo archivo, que sí la usan). Tiene
  que pasar a usar `TransactionManager.run()`; el orden exacto de los
  locks dentro de esa transacción (recurso, fila, lectura de
  `assignmentStatus` para el discriminador de H1) se especifica en el
  bullet siguiente (H2) — acá alcanza con la firma de la operación de
  aplicación que compone cuando corresponde:
  `ReservationService.assignDeferred(client, reservationId, resourceId,
  businessId, changedBy)` (firma con `businessId`, C1 — ver §8 A6.1).
  **Agregado explícitamente (C-7, Ronda 14, gate `architecture-governor`)
  — el chequeo de `status === 'CONFIRMED'` se mueve CON el resto del
  método a la lectura bajo lock.** Hoy (`stay.service.ts:186`) ese
  chequeo corre sobre `reservation.status`, la lectura SIN lock
  (`reservationRepository.getById()`, línea 180-182, fuera de cualquier
  transacción) — mismo patrón que el resto de este diseño ya corrige en
  otros métodos (H1, B-3). Con `checkIn()` movido a
  `TransactionManager.run()`, este chequeo pasa a evaluarse sobre
  `locked.status !== 'CONFIRMED'` (la lectura BAJO lock,
  `requireReservationWithLock()` o equivalente) → lanza
  `ReservationNotConfirmedError`, mismo error de hoy, mismo mensaje — solo
  cambia CUÁL lectura decide. Mismo criterio que H1 (el discriminador de
  `assignmentStatus` también se lee bajo lock, no antes): la decisión de
  si el check-in procede se toma SIEMPRE con el dato fresco, nunca con una
  lectura que pudo quedar obsoleta mientras la transacción tomaba sus
  locks. Sin este movimiento, quedaría una inconsistencia: el
  discriminador de asignación (H1) decidiría con datos frescos bajo lock,
  pero la precondición de status seguiría decidiéndose con datos
  potencialmente viejos — mismo tipo de brecha que motivó B-3 sobre
  "completar".
- **Orden de locks — un único invariante, sin excepciones (H2, corrección
  obligatoria de la Ronda 10 — reemplaza el mecanismo condicional de la
  Ronda 9/N1, que dependía de si el recurso coincidía con el actual).** El
  gate de la Ronda 10 encontró que `stays.resource_id REFERENCES
  resources(id)` (`schema.sql:2115`) hace que TODO `INSERT INTO stays`
  tome, automáticamente, un lock implícito `FOR KEY SHARE` sobre la fila
  de `resources` referenciada — comportamiento estándar de Postgres para
  toda FK, no algo que el código controle ni pueda saltear. La fila
  "check-in mismo recurso: cero locks de recurso" de la tabla de la Ronda
  9 era, en consecuencia, falsa en la práctica: el `INSERT` de `Stay` que
  `checkIn()` hace siempre toma ese lock, coincida o no `input.resourceId`
  con el recurso que la reserva tenía. Esto es distinto de
  `updateReservation()`/"Auto Assign All", cuyo único lock de recurso
  protege un `UPDATE` de `reservations` — y Postgres **omite** el
  chequeo/lock de una FK en un `UPDATE` cuando el valor de la columna
  referenciante no cambia (no hay esa optimización para un `INSERT`: no
  existe una fila vieja contra la cual comparar). La regla que corrige
  esto es una sola, sin excepción, incluso cuando el recurso "no cambia":
  **toda transacción que va a escribir algo con una FK hacia `resources`
  (un `UPDATE` de `reservations.resource_id`, o un `INSERT` de
  `stays.resource_id`) tiene que tomar el lock EXPLÍCITO del recurso
  referenciado ANTES de tomar el lock de la fila de la reserva.** Mismo
  principio que ya usa `updateReservation()` hoy (lockear el recurso ANTES
  que la reserva) — no es una regla nueva, es aplicar la MISMA regla ya
  establecida también al camino de check-in, que antes tenía una excepción
  injustificada.

  **Corrección obligatoria (Hallazgo 1, Ronda 12 — la regla de arriba
  estaba incompleta).** El gate de la Ronda 11 encontró, verificado contra
  Postgres real (sonda descartable, reprodujo `55P03`/`40P01`), que la
  optimización de "el `UPDATE` no cambia el valor de la columna, así que
  Postgres saltea el chequeo de FK" tiene una condición adicional, no
  declarada hasta esta ronda: esa optimización **no aplica** si la MISMA
  fila ya fue escrita por la MISMA transacción antes — aunque sea con el
  mismo valor. Un segundo `UPDATE` sobre una fila que la propia transacción
  ya tocó SÍ dispara el chequeo/lock de FK, sin excepción. La regla
  corregida, completa, es: **toda transacción que va a escribir algo con
  una FK hacia `resources` — un `INSERT` de `stays.resource_id`, un
  `UPDATE` de `reservations.resource_id` que CAMBIE ese valor, O CUALQUIER
  `UPDATE` sobre una fila de `reservations` que esa misma transacción ya
  haya escrito antes (incluso si el valor de `resource_id` no cambia) —
  tiene que tomar el lock EXPLÍCITO del recurso referenciado ANTES de
  tomar el lock de la fila de la reserva.** Esto es lo que hace que
  "completar" (`completeReservation()`) deje de ser una excepción — ver
  §6, sub-alcance "completar confirma la asignación", más abajo, y la
  tabla de §8 A6.1.

  En consecuencia, `checkIn()` SIEMPRE — coincida o no `input.resourceId`
  con el recurso que la reserva tiene actualmente — lockea el candidato
  PRIMERO. **Corregido (Hallazgo 2, Ronda 12 — una versión anterior de
  este documento especificaba acá `this.availability.assertAllResourcesAvailable(
  client, [input.resourceId], ...)`, que además de lockear VALIDA
  disponibilidad completa: rechaza si hay superposición con otra reserva,
  ventana de mantenimiento activa, o recurso inactivo).** Usar esa función
  como pre-lock, tal como decía la Ronda 10, hacía pasar a TODO check-in
  — incluidos los de una reserva `ASSIGNED`, el 100% de los de hoy — por
  esa validación completa, contradiciendo directamente H1 (arriba: "el
  check-in de una reserva `ASSIGNED` queda IDÉNTICO a hoy, sin ninguna
  validación nueva"): una reserva `ASSIGNED` podía empezar a rechazarse
  por detectarse a sí misma como "superpuesta" (el pre-lock no pasa
  `excludeReservationId`) o por una ventana de mantenimiento que hoy no
  bloquea el check-in. El pre-lock corregido es un lock PURO, sin
  validación: `resourceRepository.lockByIds(client, [input.resourceId])`
  (mismo método que ya usa `assertAllResourcesAvailable()` internamente,
  `reservation-availability.service.ts:308`, pero sin el resto de esa
  función). La validación de disponibilidad (superposición, mantenimiento,
  recurso activo) sigue existiendo — pero SOLO dentro de `assignDeferred()`
  (su paso 8, con las fechas leídas bajo lock), y SOLO para el camino
  `PENDING_ASSIGNMENT` (el único que invoca `assignDeferred()`, H1). Para
  el camino `ASSIGNED`, que no invoca `assignDeferred()`, no hay ninguna
  validación nueva — ahora sí, consistente con lo que H1 declara.

  `checkIn()` lockea la fila de la reserva DESPUÉS (`locked =
  requireReservationWithLock(client, reservationId)`, ahí se lee
  `assignmentStatus` para H1), y RECIÉN DESPUÉS compone el resto de la
  transacción — el `INSERT` de `Stay` (que a esta altura ya encuentra el
  recurso lockeado por esta misma transacción; su propio lock implícito de
  FK es un no-op) y, si corresponde, la invocación de `assignDeferred()`.
  **No hay ningún camino de check-in con "cero locks de recurso"** — ver
  la fila única de check-in en la tabla de §8 A6.1. La restricción de
  categoría (`AssignmentCategoryMismatchError`, arriba) se evalúa DESPUÉS
  de que los dos locks (recurso y fila) ya estén tomados — dentro de
  `assignDeferred()`, su paso 6 — no antes.

  **Rango de fechas del pre-lock — regla retirada (Hallazgo 2, Ronda 12).**
  Una versión anterior de esta sección (Ronda 10) exigía abortar con
  `ReservationConcurrentlyModifiedError` si el rango de fechas usado para
  pre-lockear (de la lectura inicial sin lock) difería de
  `locked.startTime`/`locked.endTime` una vez tomado el lock de la fila.
  Esa regla dependía de que el pre-lock VALIDARA disponibilidad contra un
  rango de fechas — con el pre-lock corregido arriba (lock puro de
  `input.resourceId`, sin fechas de por medio), no queda ningún cálculo
  hecho con fechas potencialmente obsoletas que proteger: la lectura
  inicial sin lock (`this.reservationRepository.getById(...)`) pasa a
  usarse, de acá en más, únicamente para el chequeo barato de existencia —
  mismo idioma que el paso 1 de `updateReservation()` ("solo para un 404
  barato... nunca se usa para construir lo que se guarda", §8) — y la
  única validación real de fechas, dentro de `assignDeferred()` (su paso
  8, solo si `!isSameResource`), ya lee `locked.startTime`/`locked.endTime`
  bajo lock, nunca la lectura inicial. No queda ningún dato derivado de la
  lectura sin lock que sobreviva hasta después de tomar el lock de fila,
  así que no hay ninguna ventana de staleness que cerrar acá. (Distinto de
  "Auto Assign All", Fase 3 más abajo, cuyo pre-lock SÍ sigue validando
  disponibilidad con un rango de fechas — y por eso conserva esta misma
  regla, con la misma justificación que tenía antes.)

  Con este cambio, la reconciliación en dos ramas que describía la Ronda 9
  (comparación optimista previa vs. relectura bajo lock, para decidir si
  hacía falta lockear un recurso que el caller "pensó que no hacía falta")
  **deja de existir**: `checkIn()` ya no decide condicionalmente si
  lockea el recurso — lo lockea siempre, así que no hay ningún escenario
  en el que "el caller no lockeó pero debería haber lockeado". El
  discriminador que decide si `checkIn()` invoca `assignDeferred()` (H1,
  arriba) ya se resolvió con la fila bajo lock en el paso de arriba —
  `assignDeferred()`, si se invoca, no necesita volver a leer nada para
  eso (su propio paso 1 relockea la misma fila, no-op).
- `checkIn()` hace además una TERCERA escritura,
  `financialRepository.linkStayToReservationCharges(...)`, ya existente
  hoy, que también tiene que entrar en la misma transacción — las tres
  (INSERT de `Stay`, transición de `Reservation` vía `assignDeferred()`
  cuando corresponde, y `linkStayToReservationCharges()`) quedan en una
  sola operación atómica (`atomic-state-mutation`). Esto requiere sumar
  métodos `WithClient` a `StayRepository` (hoy solo tiene `save()`, sin
  `saveWithClient()`) y a `FinancialTransactionRepository`
  (`linkStayToReservationCharges()` usa `this.sqlClient` directo,
  `sql.financial-transaction.repository.ts:975`, sin variante con
  `client`).
- Después de que esa transacción haga commit, y **SOLO** si el camino
  `PENDING_ASSIGNMENT` corrió (H1), `checkIn()` llama a
  `this.reservationService.recordOccupancy(assigned)` — **`assigned` es,
  explícitamente, la entidad que DEVOLVIÓ `assignDeferred()` dentro de la
  transacción (su propio paso 10, la que ya tiene el recurso definitivo y
  `assignmentStatus = 'ASSIGNED'`), nunca la variable `reservation` de la
  lectura inicial sin lock (`stay.service.ts:180`, `const reservation =
  await this.reservationRepository.getById(...)`, verificado en código).**
  Corregido (G-3, gate 18) — una versión anterior de este bullet escribía
  literalmente `recordOccupancy(reservation)`, y `reservation` es,
  precisamente, el nombre de esa variable sin lock en el código real de
  `checkIn()`: pasarle ESA entidad a `recordOccupancy()` la dejaría
  todavía en `PENDING_ASSIGNMENT` desde el punto de vista del guard de
  salteo (§7, fila de `recordOccupancy()`) — que la ignoraría SIN error
  visible, dejando la ocupación sin registrar hasta que la reserva se
  complete, en silencio (mismo patrón de bug que B4 de rondas muy
  anteriores). Mismo patrón que ya usan los otros 3 callers de
  `assignDeferred()` (PUT, "Auto Assign All", completar, §8): siempre la
  entidad que devuelve `assignDeferred()`, nunca una lectura previa.
  **Corrección obligatoria (B-2, Ronda 13) — `StayService` no tiene,
  ni va a tener, ningún `this.availability`.** Verificado en código
  (`pms-estadias/stay.service.ts`, constructor de `StayService`): recibe
  `stayRepository`, `reservationRepository`, `housekeepingRepository`,
  `financialRepository`, `businessProfileRepository` y
  `transactionManager` — ninguna instancia de
  `ReservationAvailabilityService` (donde vive `recordOccupancy()`,
  privada dentro de `ReservationService`:
  `private readonly availability: ReservationAvailabilityService;`,
  `reservation.service.ts:114`) ni de `ReservationService` mismo. Las
  versiones de este documento hasta la Ronda 12 asumían que `checkIn()`
  podía llamar a `this.availability.recordOccupancy(...)` directo — no hay
  ningún `this.availability` al que `StayService` pueda llamar; ese campo
  no existe en la clase, hoy ni en ninguna versión anterior de este
  diseño. **Corrección:** `ReservationService` gana un método PÚBLICO
  nuevo, `recordOccupancy(reservation: Reservation): Promise<void>`, que
  delega internamente a su `availability` privada (`return
  this.availability.recordOccupancy(reservation);`) — mismo patrón que ya
  usan `confirmReservation()`/`completeReservation()` desde DENTRO de la
  clase, ahora expuesto para un caller externo. `checkIn()` llama a
  `this.reservationService.recordOccupancy(assigned)` (la entidad de
  `assignDeferred()`, nunca la lectura sin lock — ver el bullet de arriba,
  G-3) sobre la dependencia `ReservationService` que `StayService` YA
  necesita agregar
  para `assignDeferred()` (ítem siguiente) — dentro de `StayService` no
  hace falta ningún wiring adicional más allá de ese. **Corregido (N-1,
  Ronda 14, gate `architecture-governor`; resolución revisada en la Ronda
  15, ver §7 ítem 12) — esto era cierto para `StayService`, pero falso
  para el `ReservationService` que `StayService` necesita recibir: la
  frase daba a entender que conseguir esa instancia era gratis, y no lo es
  en el ÚNICO lugar donde `StayService` se construye sin pasar por
  `reservations.routes.ts::buildStayService()` (`app.ts:485-519`, montaje
  por closure de `/api/stays`, con `new StayService(` en la línea 500 —
  re-verificado con `grep -n` contra el archivo real) — ver el análisis
  completo en §7, ítem 12 de "Resumen de lo que hay que tocar".**
  **Corrección menor #1 (Ronda 12) — afirmación falsa retirada.**
  Una versión anterior de este documento decía acá que, si la reserva ya
  estaba `ASSIGNED`, "este llamado sigue existiendo igual que hoy" —
  falso, verificado con `grep -n "recordOccupancy" src/reservas/reservation.service.ts
  src/pms-estadias/stay.service.ts`: los únicos 2 call-sites reales de
  `recordOccupancy()` (antes de este método público nuevo) son
  `confirmReservation()` y `completeReservation()`
  (`reservation.service.ts`); `stay.service.ts` no tiene ninguno, ni hoy
  ni en este diseño. La ocupación de una reserva `ASSIGNED` que hace
  check-in ya se registró antes, al confirmarse (`confirmReservation()`)
  — check-in no llama, ni debe llamar, a `recordOccupancy()` para ese
  camino. **Advertencia explícita para la implementación:** si en el
  futuro se agrega un llamado a `recordOccupancy()` en la rama `ASSIGNED`
  de `checkIn()`, contaría ocupación dos veces (una al confirmarse, otra
  al hacer check-in) — no agregarlo.
- `StayService` se construye en 2 lugares — **verificado, son los ÚNICOS
  2 call-sites reales de `new StayService(` en `src/`, grep confirmado**:
  `reservations.routes.ts::buildStayService()` (línea 234) y `app.ts`
  (línea 500, montaje por closure — `CLOSURE_MOUNTS` de
  `app-main/CLAUDE.md`) — agregarle las dependencias nuevas toca los 2; un
  solo lugar actualizado y el otro con la referencia vieja construiría un
  `StayService` incompleto en producción. **Corregido (Hallazgo 2, Ronda
  12; corregido de nuevo en la Ronda 13/B-2).** `StayService` gana DOS
  dependencias nuevas — **ninguna de las dos existe hoy en su
  constructor, verificado; no es "sin cambios respecto de rondas
  anteriores" como decía la Ronda 12**: (1) `ReservationService` (para
  `assignDeferred()` Y el método público nuevo `recordOccupancy()`, arriba
  — una sola dependencia nueva sirve para las dos cosas); (2) una
  dependencia más chica, directa a `ResourceRepository` (o
  `Pick<ResourceRepository, 'lockByIds'>`) para el pre-lock puro de
  `checkIn()` — una versión anterior de este documento asumía que el
  pre-lock pasaba por `this.availability.assertAllResourcesAvailable()`,
  lo que hubiera bastado con una dependencia a
  `ReservationAvailabilityService`; con el pre-lock corregido (lock puro,
  sin validación), esa dependencia no alcanza — hace falta el
  `ResourceRepository` directo. `StayService` **no** necesita, y no gana,
  ninguna dependencia directa a `ReservationAvailabilityService` — todo lo
  que las Rondas anteriores describían como "`this.availability` de
  `StayService`" pasa, en el mecanismo corregido, por el método público de
  `ReservationService` de arriba.
- Consecuencia esperada, no una regresión oculta, **acotada al camino
  `PENDING_ASSIGNMENT` (H1)**: el check-in de una reserva
  `PENDING_ASSIGNMENT` pasa a rechazar TAMBIÉN si hay otra RESERVA (no
  solo otra `Stay`) superpuesta en la habitación elegida — vía el
  re-chequeo de disponibilidad de rango que `assignDeferred()` hace en su
  paso 8. El check-in de una reserva `ASSIGNED` no gana este chequeo —
  sigue mirando solo `Stay`s activas, como hoy.

#### Sub-alcance: completar confirma la asignación

**Corrección obligatoria (Hallazgo 1, Ronda 12 — reemplaza el análisis N2
de las Rondas 9/10, que resultó falso).** Una versión anterior de este
documento sostenía que "completar" (`completeReservation()`) era el único
camino sin ningún lock de recurso, porque no inserta ninguna `Stay` ni
cambia el VALOR de `resource_id` en su propio `UPDATE`. El gate de la
Ronda 11 verificó esa conclusión contra Postgres real (sonda descartable)
y la encontró falsa: la optimización de Postgres que saltea el chequeo de
FK en un `UPDATE` que no cambia el valor de la columna no aplica cuando la
MISMA transacción ya escribió esa fila antes — y eso es exactamente lo que
pasa acá. El paso 10 de `assignDeferred()` (su UPSERT de la reserva, con
el mismo `resource_id`) es la PRIMERA escritura de la fila en esta
transacción; el `.complete()` + `saveWithClient()` propio de
`completeReservation()`, que corre DESPUÉS, es la SEGUNDA escritura de la
MISMA fila en la MISMA transacción — y esa segunda escritura SÍ dispara el
chequeo de FK, tomando `FOR KEY SHARE` sobre `resources`. Sonda real del
gate: "Solo lock de la fila: sin lock sobre recursos. Primer UPSERT con el
mismo `resource_id`: sin lock. SEGUNDO UPSERT en la misma transacción:
`55P03 could not obtain lock on row in relation resources`" — y el
escenario de deadlock completo (completar contra check-in, o completar
contra un `PUT`) reproducido como `40P01`. Ver la regla H2 corregida más
arriba (sub-alcance "check-in"), que ahora cubre este caso explícitamente.

**Mecanismo corregido — dos hallazgos de la Ronda 13 (B-3), sobre el
mismo patrón que el resto de los caminos, sin excepción.**

**(a) Hecho falso corregido: la lectura previa sin lock NO es "como hace
hoy" — es un patrón NUEVO.** Una versión anterior de este documento (hasta
la Ronda 12) decía que "`completeReservation()` sigue leyendo la reserva
SIN lock primero... exactamente como hace hoy" — falso, verificado en
código (`reservation.service.ts::completeReservation()`): el método entra
DIRECTO a `requireReservationWithLock()`, DENTRO de
`transactionManager.run()`, sin ningún `preCheck` previo — ni en HEAD ni
en ninguna versión anterior verificable de este archivo. La lectura previa
que "completar" necesita agregar para decidir qué recurso lockear (antes
del lock de la fila, para cumplir el mismo invariante N1 que el resto de
los caminos) es un patrón NUEVO — análogo al `preCheck` que
`updateReservation()` ya usa desde el fix commiteado `6178d70` (§8), no
algo que "completar" ya hiciera.

`completeReservation()` gana, entonces, un `preCheck = await
this.requireReservation(id)` SIN lock, ANTES de abrir la transacción —
usado ÚNICAMENTE para decidir qué recurso lockear (el mismo que la reserva
ya tiene: "completar" nunca reasigna). **Corregido (C-4, Ronda 15) — el
lock tiene que ser la PRIMERA sentencia DENTRO de la transacción, nunca
antes de abrirla.** Una versión anterior de este documento decía "ANTES de
entrar a la transacción existente" — contradictorio con el mecanismo real:
`resourceRepository.lockByIds(client, ...)` recibe el `client`
transaccional (`SqlClient`) como primer parámetro (`resource.repository.ts`,
verificado — la interfaz no tiene ninguna variante sin `client`), y ese
`client` no existe hasta que `transactionManager.run(async (client) =>
{...})` abre la transacción — no hay forma de tomar este lock "antes" de
eso. El mecanismo real: `transactionManager.run()` abre la transacción;
si `preCheck.assignmentStatus === 'PENDING_ASSIGNMENT'`, la PRIMERA
sentencia dentro de ese callback toma el lock EXPLÍCITO del recurso —
`resourceRepository.lockByIds(client, [preCheck.resource.id])` — **antes**
de `requireReservationWithLock()` (mismo patrón que el resto de Fase 2 ya
usa: recurso primero, fila después, N1). Si `preCheck` ya ve `ASSIGNED`,
el callback no lockea ningún recurso nuevo y entra directo a
`requireReservationWithLock()`: sigue exactamente como hoy, sin cambio de
comportamiento.

**(b) Decisión corregida: la DECISIÓN de invocar `assignDeferred()` se
toma con la lectura BAJO LOCK, nunca con `preCheck`.** Usar `preCheck`
para decidir puede producir un `409` espurio: si `preCheck` ve
`PENDING_ASSIGNMENT`, pero un check-in o un `PUT` concurrente ya asignó la
reserva — incluso al MISMO recurso — antes de que "completar" tomara su
propio lock de fila, bajo lock la reserva ya está `ASSIGNED`, e invocar
`assignDeferred()` igual lanzaría `ReservationAlreadyAssignedError` (paso
2, §8 A6.1) innecesariamente. Mismo criterio que ya usa el check-in (H1) y
el discriminador del PUT (§8): la decisión de invocar SIEMPRE se toma con
el dato leído bajo lock (`locked.assignmentStatus`), la lectura sin lock
solo decide qué pre-lockear.

- Si `locked.assignmentStatus === 'PENDING_ASSIGNMENT'`:

  **Guard acotado, reintroducido en la Ronda 14 (N-2, gate
  `architecture-governor`) — ver el Anexo para por qué la Ronda 13 lo
  había sacado sin registrar el motivo, y la tabla de 6 casos completa más
  abajo (la 6ª fila, agregada en la Ronda 15, cubre el caso que la tabla
  de 5 dejaba como "N/A" sin explicarlo).** Antes de invocar
  `assignDeferred()`, se verifica:
  `preCheck.assignmentStatus !== 'PENDING_ASSIGNMENT' ||
  locked.resource.id !== preCheck.resource.id`. Si esa condición es
  verdadera, **no** se invoca `assignDeferred()` — se aborta con
  `ReservationConcurrentlyModifiedError(id, 'cambió de estado de
  asignación o de recurso candidato')` (409, mensaje parametrizado —
  Ronda 15, ver §6 Fase 2 ítem 8). Motivo: el pre-lock de
  arriba solo tomó el lock de `preCheck.resource.id` — si bajo lock el
  recurso candidato real resultó otro (`locked.resource.id` distinto), o
  si `preCheck` ni siquiera vio la reserva como `PENDING_ASSIGNMENT` (caso
  en el que el mecanismo de arriba NO pre-lockeó ningún recurso), invocar
  `assignDeferred()` acá violaría el invariante N1 (recurso SIEMPRE
  lockeado ANTES que la fila) — la fila ya está lockeada en este punto, así
  que lockear el recurso correcto ahora reabriría el mismo patrón de
  deadlock ABBA que H2 cerró. Aborta y pide reintento — no hay pérdida de
  datos: quien reintente va a ver el estado real (`locked` de esa segunda
  pasada) y va a pre-lockear el recurso correcto desde el principio.

  Si la condición NO se cumple (el caso normal: `preCheck` ya vio
  `PENDING_ASSIGNMENT` Y el recurso bajo lock coincide con el que
  `preCheck` vio), invoca
  `assignDeferred(client, id, locked.resource.id, businessId, changedBy)`
  — el mismo recurso que ya tenía (`isSameResource` siempre verdadero en
  esta rama, por construcción: "completar" nunca reasigna). El recurso ya
  está lockeado desde el paso de arriba, así que el paso 1 de
  `assignDeferred()` (lock de fila) es un no-op y sus pasos 5-8 se
  saltean por completo (`isSameResource`, §8 A6.1 paso 4).
- Si `locked.assignmentStatus === 'ASSIGNED'` — **incluido el caso de
  carrera de arriba, donde `preCheck` vio `PENDING_ASSIGNMENT` pero otra
  operación ya asignó la reserva (al MISMO recurso o a otro distinto)
  antes de que "completar" tomara su lock de fila** — NO invoca
  `assignDeferred()`: sigue por la rama `ASSIGNED` normal, exactamente
  como hoy, **sin ningún error de conflicto.** El lock del recurso tomado
  de más (por haber decidido pre-lockear con `preCheck`) es inocuo:
  simplemente no se usa para nada — no genera ningún problema de orden,
  se libera solo al terminar la transacción. "Completar" nunca escribe
  `resourceId` por su cuenta — o invoca `assignDeferred()` con el recurso
  que la reserva YA tiene bajo lock, o no lo toca en absoluto. **Corregido
  (N-2, Ronda 14): esta rama (`locked.assignmentStatus === 'ASSIGNED'`)
  nunca necesitó guard de coherencia — el guard nuevo de arriba vive en la
  otra rama (`locked.assignmentStatus === 'PENDING_ASSIGNMENT'`), no
  acá.** Una versión anterior de este documento (hasta la Ronda 13)
  afirmaba que "completar" no necesitaba NINGÚN guard de coherencia en
  absoluto — cierto para ESTA rama, pero incompleto: no cubría el caso en
  que `locked` sigue `PENDING_ASSIGNMENT` con un recurso distinto al que
  `preCheck` pre-lockeó (tabla completa abajo).

**Tabla de casos completa (N-2, Ronda 14 — 6ª fila agregada en la Ronda
15) — las 4 combinaciones `preCheck.assignmentStatus` ×
`locked.assignmentStatus`, con el sub-caso de recurso dentro de
PENDIENTE×PENDIENTE Y dentro de PENDIENTE×ASSIGNED (este último, agregado
en la Ronda 15 — condición del gate 15 sobre N-2, ya cerrado con
condiciones).** Reemplaza cualquier prosa dispersa sobre "qué pasa según
lo que vio `preCheck`" — esta tabla es la fuente única.

| # | `preCheck` | `locked` | Recurso (`locked.resource.id` vs. `preCheck.resource.id`) | Qué hace "completar" |
|---|---|---|---|---|
| 1 | `ASSIGNED` | `ASSIGNED` | N/A | Camino de HOY, sin cambios: no invoca `assignDeferred()`, sin error. Ningún recurso se pre-lockeó (correcto: no hacía falta). |
| 2 | `ASSIGNED` | `PENDING_ASSIGNMENT` | N/A (ningún recurso se pre-lockeó) | **Caso 1 de N-2, nuevo.** El guard dispara (`preCheck.assignmentStatus !== 'PENDING_ASSIGNMENT'`) → `ReservationConcurrentlyModifiedError(id, 'cambió de estado de asignación o de recurso candidato')` (409). Sin el guard: `assignDeferred()` se invocaría sin ningún recurso pre-lockeado, reabriendo el riesgo de deadlock que H2 cerró — o, si no se invocara, la reserva quedaría `COMPLETED` + `PENDING_ASSIGNMENT` para siempre (viola A6.2). |
| 3 | `PENDING_ASSIGNMENT` | `ASSIGNED` | MISMO recurso (`locked.resource.id === preCheck.resource.id`) | Camino ya resuelto por B-3 (Ronda 13): no invoca `assignDeferred()`, sin error — el lock del recurso pre-lockeado con `preCheck` (que sí se tomó, ya que `preCheck` vio `PENDING_ASSIGNMENT`) queda inocuo, sin usarse. El guard de arriba NO dispara acá (solo mira `locked`, que es `ASSIGNED`). |
| 4 | `PENDING_ASSIGNMENT` | `ASSIGNED` | DISTINTO recurso (`locked.resource.id !== preCheck.resource.id`) | **Agregada en la Ronda 15 (condición del gate 15 sobre N-2) — una versión anterior de esta tabla marcaba este caso "N/A" sin explicarlo; el gate lo verificó y es SEGURO, sin guard ni error, mismo camino que la fila 3.** No invoca `assignDeferred()` (misma razón que la fila 3: `locked.assignmentStatus === 'ASSIGNED'`, el guard ni se alcanza). Es seguro aunque el recurso pre-lockeado (`preCheck.resource.id`, sea X) ya no coincida con el recurso real de la fila (`locked.resource.id`, sea Y — otra operación reasignó la reserva entre `preCheck` y el lock de fila): (a) es la ÚNICA escritura de esta fila en esta transacción — no se invoca `assignDeferred()`, así que no hay "segunda escritura" que dispare el chequeo de FK que sí aplica en la fila de "completar" de la tabla de locks de §8 A6.1 (Hallazgo 1/Ronda 12); (b) el `UPDATE` propio de `completeReservation()` nunca toca `resource_id` (N2 sigue vigente para eso) — el valor de la columna no cambia respecto de la fila REAL (Y), así que Postgres saltea el chequeo/lock de FK de ese `UPDATE`; (c) el lock tomado de más (sobre X, el recurso viejo que `preCheck` vio) queda inocuo — no genera contención sobre Y (la fila real), no genera deadlock, se libera al terminar la transacción. |
| 5 | `PENDING_ASSIGNMENT` | `PENDING_ASSIGNMENT` | MISMO recurso | Caso normal — invoca `assignDeferred()` con `locked.resource.id`, `isSameResource` verdadero, transiciona a `ASSIGNED`. El guard NO dispara (las dos condiciones del OR son falsas). |
| 6 | `PENDING_ASSIGNMENT` | `PENDING_ASSIGNMENT` | DISTINTO recurso | **Caso 2 de N-2, nuevo.** El guard dispara (`locked.resource.id !== preCheck.resource.id`) → `ReservationConcurrentlyModifiedError(id, 'cambió de estado de asignación o de recurso candidato')` (409). El recurso pre-lockeado (el que vio `preCheck`) es el equivocado — el candidato real (`locked.resource.id`) nunca se lockeó, así que invocar `assignDeferred()` con él violaría el mismo invariante que el caso 2. |

**Confirmado: el guard NUNCA dispara en el caso feliz (filas 3 y 4, las que B-3
y la Ronda 15 resolvieron).** Las dos condiciones del OR
(`preCheck.assignmentStatus !== 'PENDING_ASSIGNMENT'` y
`locked.resource.id !== preCheck.resource.id`) solo se evalúan cuando
`locked.assignmentStatus === 'PENDING_ASSIGNMENT'` — las filas 3 y 4
tienen `locked === 'ASSIGNED'`, así que el guard ni siquiera se alcanza
para esos casos (está anidado dentro del bloque `if
(locked.assignmentStatus === 'PENDING_ASSIGNMENT')`, ver el mecanismo de
arriba) — la diferencia entre la fila 3 y la 4 (mismo recurso vs. distinto)
no cambia esto en nada, porque el guard ni siquiera mira el recurso cuando
`locked` ya es `ASSIGNED`. No reabre el `409` espurio que B-3 vino a
evitar.

**Registrado en el Anexo (obligación de esta ronda):** el guard de la
Ronda 12 se había sacado en la Ronda 13 sin justificarlo — ver "Ronda 14"
en el Anexo para el detalle completo de qué se encontró y por qué se
reintroduce, ahora en versión acotada (2 campos: `assignmentStatus` +
`resource.id` de `preCheck`, no los 8 campos que rondas anteriores del PUT
ya habían descartado).

**Sin dependencia nueva que wirear:** `resourceRepository` ya está
inyectado en `ReservationService` (mismo repositorio que ya usan
`createReservation()`/`updateReservation()`), así que este lock
condicional no agrega ningún sitio de wiring nuevo — a diferencia del
pre-lock de check-in (Hallazgo 2, arriba), que sí necesita una dependencia
nueva en `StayService`.

**Residuo aceptado, declarado sin resolver (C-1, Ronda 13).** La segunda
escritura de la misma fila dentro de la misma transacción — el patrón que
"completar" usa acá (invoca `assignDeferred()`, que hace su propio UPSERT,
seguido del `.complete()`/`saveWithClient()` propio de
`completeReservation()`), y el mismo patrón que un `PUT` con `resourceId`
Y otros cambios (`details`/`adultos`/`ninos`) produce al componer
`assignDeferred()` seguido de un segundo `Reservation.restore()`/
`saveWithClient()` (§8) — vuelve a chequear TODAS las FKs de
`reservations`, no solo la de `resource_id`: `customer_id` (`NOT NULL
REFERENCES customers(id)`, `schema.sql:446`, sin `ON DELETE` — bloquea el
`DELETE`, mismo efecto práctico que `RESTRICT`), `service_id` (`ON DELETE
SET NULL`, `schema.sql:473`) y `rate_plan_id` (`ON DELETE RESTRICT`,
`schema.sql:537`). Un `DELETE` concurrente del cliente, el servicio o el
plan de tarifa referenciado por la MISMA fila que esta transacción ya
escribió antes podría terminar en un deadlock (`40P01`) por esa FK, en vez
de solo el de `resources` que este documento ya analiza (H2). **Corregido
(C-4, Ronda 14) — la premisa de la frase anterior era falsa.** No es que
"en alojamiento `service_id` suele ser `NULL`": es exactamente lo
contrario — `service_id` está **SIEMPRE** presente en una reserva de
alojamiento, sin excepción (`LodgingRequiresServiceError`,
`reservation.service.ts:287` — toda reserva cuya categoría es `is_lodging
= TRUE` sin `serviceId` se rechaza al crearse, verificado en código). El
residuo de FK sobre `service_id` no es un caso raro para alojamiento — es
el caso NORMAL, siempre presente. **Corregido de nuevo (C-4, Ronda 15) —
la semántica de `ON DELETE SET NULL` que daba la Ronda 14 era incorrecta.**
`ON DELETE SET NULL` NO bloquea el `DELETE` de la fila padre — al
contrario, lo permite: Postgres borra la fila de `bookable_services` y
pone `NULL` en `reservations.service_id` de cualquier fila que la
referenciaba, sin violación de FK y sin error. La conclusión de "residuo
benigno" se sostiene igual, pero por otra razón, verificada en código: los
servicios de este repo solo se dan de baja lógica —
`sql.bookable-service.repository.ts:149`, `UPDATE bookable_services SET
active = FALSE WHERE id = $1` — no hay ningún `DELETE FROM
bookable_services` real en `src/` (`grep -rn "DELETE FROM
bookable_services" src/`, sin resultados). El riesgo de deadlock
(`40P01`) de este residuo depende de que exista, en la práctica, un
`DELETE` concurrente contra esa fila — y ese `DELETE` no lo dispara
ningún camino de código de este repo, solo podría originarse por una
operación manual directa contra la BD, fuera del alcance de cualquier
diseño de aplicación. Verificado también: no hay ningún `FOR UPDATE`
sobre `bookable_services` en el repo (`grep -rn "FOR UPDATE"
src/reservas src/pms-estadias`, sin resultados para esa tabla) — nada
agrava este residuo con un lock adicional que no exista ya. Sigue siendo
un residuo real y no resuelto en este diseño — si algún día se agrega un
hard-delete de `bookable_services`, este análisis hay que rehacerlo —,
pero la razón de por qué es benigno HOY es la ausencia de ese `DELETE` en
el código, no la semántica de la FK.

`completeReservation()` invoca `assignDeferred()` con el MISMO
`resourceId` que ya tiene, DENTRO de su transacción ya existente, ANTES de
`reservation.complete()`. Como el `resourceId` no cambia, los chequeos de
categoría/disponibilidad/`Stay` activa de `assignDeferred()` se saltean
por completo (mismo recurso, ver §8 A6.1 paso 4 — "¿Es la MISMA unidad?")
— no hace falta releerlos, nada nuevo se está reclamando. **Citas de línea
de `completeReservation()`:** desde la Ronda 12 se citan por SÍMBOLO, no
por número de línea (corrección menor #5, ver el Anexo) — el archivo se
movió una vez por el fix de `updateReservation()`, ya commiteado
(`6178d70`, C-2), y puede seguir moviéndose por cambios futuros no
relacionados.

**B4 — encadenamiento obligatorio, para no pisar lo que `assignDeferred()`
acaba de escribir.** `completeReservation()` construye/guarda su propia
entidad dentro del método (`reservation`, la variable que el método
reasigna tras tomar el lock de fila). Si, tras invocar `assignDeferred()`,
el método siguiera llamando a `.complete()`/`saveWithClient()` sobre la
entidad VIEJA (la leída ANTES de invocar `assignDeferred()`) en vez de
sobre la entidad NUEVA que `assignDeferred()` devuelve, el UPSERT final
volvería a escribir `PENDING_ASSIGNMENT` — pisando la transición recién
hecha — y `recordOccupancy()` recibiría la entidad vieja también,
salteándose por completo (su guard depende de `assignmentStatus`, §7). Por
eso el método tiene que encadenar así: si la reserva sigue
`PENDING_ASSIGNMENT`, **primero** toma el lock del recurso y de la fila
(mecanismo de arriba), **después** invoca `assignDeferred()` y usa la
entidad que ESA operación devuelve como base para el resto del método
(`.complete()`, `saveWithClient()`, y — post-commit — `recordOccupancy()`)
— nunca la entidad leída al principio del método. Mismo patrón que el
documento ya exige para `updateReservation()` ("siempre desde `updated`",
nunca desde `locked`/`existing` directamente una vez que `assignDeferred()`
corrió). **Corrección a la cifra de "13 callers" de §8 (precisión de
implementación):** decir que la escritura de `assignment_status` es un
no-op semántico "para los otros 12" es correcto para 11 de ellos, pero
**falso para `completeReservation()` específicamente cuando pasa por
`assignDeferred()`** — en ese caso el valor SÍ cambia (vía la entidad que
`assignDeferred()` devuelve), aunque `completeReservation()` en sí no
invoque `assignConcreteResource()` directamente.

Tras el commit, `completeReservation()` sigue llamando a
`recordOccupancy()` — sobre la entidad que efectivamente transicionó (la
que devolvió `assignDeferred()` si corrió, la leída al principio si no) —
es la única vía por la que una reserva así llega a tener ocupación
registrada.

**Prerrequisito adicional de Fase 2 (N3, Ronda 9 — hallazgo preexistente,
NO introducido por 4.3).** `maintenance-window.service.ts::createWindow()`
lee reservas SIN lock y FUERA de cualquier transacción
(`getActiveForResourceInRange()`, líneas 107/125/134/142) y después las
guarda de vuelta con un UPSERT completo dentro de una transacción
(`reservationRepository.saveWithClient(client, reservation)`, línea 164) —
si ese UPSERT hace commit después de que otra operación concurrente ya
cambió esa misma reserva (recurso, `assignment_status`), lo pisa con el
snapshot viejo. Este bug YA EXISTE hoy, independiente de 4.3 (ver la fila
nueva en §7 y el hallazgo registrado en `docs/pendientes-2026-09-12.md`) —
4.3 lo agrava porque las ventanas `PENDING_ASSIGNMENT` hacen más frecuente
el escenario de "la reserva cambió mientras este código la tenía leída sin
lock". **No se arregla en este diseño** (releer con lock dentro de una
transacción es cambio de código fuera del alcance actual de 4.3) — antes
de activar Fase 2 (el marcado real de `PENDING_ASSIGNMENT`), alguien tiene
que: arreglar `maintenance-window.service.ts` para que relea la reserva
con lock dentro de una transacción inmediatamente antes de guardarla
(mismo patrón que los otros 12 escritores de `reservations`, §7), o
aceptar explícitamente el riesgo ya documentado acá.

**Nota de orden de locks para quien implemente ese arreglo (agregada en la
Ronda 12 — no rediseña el arreglo, solo señala el orden correcto, mismo
tipo de hallazgo que el Hallazgo 1/H2 de arriba).**
`maintenanceWindowRepository.saveWithClient(client, window)` (el `INSERT`
de `maintenance_windows`) ya corre ANTES del loop que guarda las reservas
afectadas, dentro de la misma transacción — y, por la misma mecánica de FK
que corrigió el Hallazgo 1/H2 (`maintenance_windows.resource_id NOT NULL
REFERENCES resources(id)`, `schema.sql:3713`), ese `INSERT` toma un lock
implícito `FOR KEY SHARE` sobre el recurso. El orden ACTUAL del método ya
es, por construcción, "recurso primero" — el re-lock explícito de cada
reserva que este arreglo tiene que agregar (dentro del loop, inmediatamente
antes de su propio `saveWithClient()`) tiene que seguir yendo DESPUÉS de
ese `INSERT`, nunca antes: si alguien reordena el método (por ejemplo,
moviendo el re-lock de reservas al principio de la transacción, antes de
crear la ventana, por prolijidad o para batchear los locks), invierte el
orden y reabre el mismo patrón de deadlock ABBA que el Hallazgo 1/H2
acaba de cerrar para "completar" y check-in.

**Prerrequisito RESUELTO (25/09/2026, `MAINTENANCE-WINDOW-STALE-SAVE-001`,
gate `architecture-governor`, introducido en este mismo commit — buscar
el hash con `git log --oneline --grep "MAINTENANCE-WINDOW-STALE-SAVE-001"`.**
`createWindow()` ahora relee el tramo incierto DENTRO de la
transacción, con `getActiveForResourceInRangeWithLock()` (`SELECT ... FOR
UPDATE`), DESPUÉS de `maintenanceWindowRepository.saveWithClient(client,
window)` — exactamente el orden que la nota de arriba exige (recurso
primero, vía el `FOR KEY SHARE` implícito del `INSERT` de la ventana;
relock de reservas después). El tramo cierto (líneas ~107/125, el chequeo
que lanza `MaintenanceWindowConflictError`) queda sin tocar a propósito —
sigue siendo una carrera adyacente pero distinta (check-then-insert, clase
A8.3), registrada aparte en `docs/pendientes-2026-09-12.md` (o el
`pendientes-<fecha>` vigente al momento de leer esto), no resuelta por
este fix. Relock por RANGO, no por id: una reserva que salió del tramo
incierto o se canceló entre el cálculo del rango y el relock simplemente
no vuelve a aparecer en el resultado, sin lanzar
`ReservationConcurrentlyModifiedError` (decisión del dueño). Cobertura:
unitario (`maintenance-window.service.test.ts`, orden y `client`
transaccional del relock) + integración contra Postgres real
(`src/tests/integration/maintenance-window-stale-save.integration.test.ts`,
reproduce el escenario de esta nota con dos conexiones reales — falla
contra el código previo a este fix, pasa con él). Fase 2 de 4.3 queda, en
consecuencia, sin este bloqueo para activarse.

### Fase 3 — "Auto Assign All" (solo alojamiento)

Endpoint nuevo, `authorize(Roles.MANAGEMENT)` — más restrictivo que la
reasignación individual (`Roles.FRONT_DESK`, sin cambios), porque es una
operación masiva (reasigna N reservas de una fecha en un solo request);
mismo criterio que este repo ya aplica para exigir un tier de permiso más
alto ante una operación en lote (`irreversible-action-gate`, `CLAUDE.md`).

El batch corre `findAvailableResourceInCategory()` sobre todas las
`PENDING_ASSIGNMENT` de una fecha y delega la aplicación de cada
asignación a `assignDeferred()`. **Cada reserva se procesa en su PROPIA
transacción, nunca una transacción gigante para todo el batch** — y,
después de que la transacción de CADA reserva haga commit, el batch llama
a `recordOccupancy()` para esa reserva puntual, **sobre la entidad que
devolvió `assignDeferred()` para esa reserva (nunca sobre el candidato
resuelto sin lock por `findAvailableResourceInCategory()` antes de abrir
la transacción, ni sobre ninguna lectura previa) — mismo criterio que
check-in (G-3, gate 18, §6 sub-alcance "check-in")** — antes de seguir con
la siguiente. Una reserva que ya quedó `ASSIGNED` en una corrida anterior no
se vuelve a tocar en una corrida posterior el mismo día — solo procesa las
que sigan `PENDING_ASSIGNMENT`.

**Precondición de gate:** Fase 2 completa (con sus 3 sub-alcances) tiene
que estar ya en producción antes de que Fase 3 se apruebe o implemente —
sin `assignDeferred()`, el check-in y "completar" ya resolviendo su propio
recurso, "Auto Assign All" podría reasignar la habitación real de un
huésped que ya hizo check-in.

**Orden de locks (N1, Ronda 9 — corregido F3-1, Ronda 16: el lock y la
validación no pueden correr "antes de abrir la transacción", mismo bug de
timing que tenía "completar" hasta que la Ronda 15/C-4 lo corrigió ahí).**
Dos pasos distintos, que una versión anterior de esta sección confundía en
uno solo: (1) la RESOLUCIÓN del candidato — `findAvailableResourceInCategory()`,
una lectura SIN lock — sí corre ANTES de abrir la transacción de esa
reserva puntual (mismo criterio que "el candidato siempre es un dato de
ENTRADA" de §8 A6.1); (2) el LOCK y la VALIDACIÓN de ese candidato
(`assertAllResourcesAvailable(client, ...)`) **no pueden** correr antes de
abrir la transacción — la función recibe `client` como primer parámetro
(`SqlClient`, `reservation-availability.service.ts:293`, sin ninguna
variante sin `client`), y ese `client` no existe hasta que
`transactionManager.run()` abre la transacción de esa reserva puntual. El
mecanismo real: se abre la transacción de la reserva; el lock+validación
del candidato (`assertAllResourcesAvailable()`) es la PRIMERA sentencia
DENTRO de ese callback — antes de lockear la fila de la reserva, nunca
después — mismo patrón que "completar" ya usa en §6 (C-4, Ronda 15).
**Corregido (F3-3, gate 18) — la llamada DENTRO de la transacción también
tiene que pasar `excludeReservationId = id`, el id de la propia reserva
que se está evaluando.** Sin este parámetro, el mismo bug que F3-2
corrige en la RESOLUCIÓN del candidato (fuera de la transacción)
reaparece una capa más abajo, en la VALIDACIÓN dentro de la transacción:
si el candidato que `findAvailableResourceInCategory()` resolvió (ya
excluyéndose a sí misma, F3-2) resulta ser la misma habitación
provisoria que esta reserva YA tiene, `assertAllResourcesAvailable()` la
compararía contra las reservas solapadas SIN excluirse, y chocaría
contra su propia fila — mismo `excludeReservationId` que F3-2 ya pasa en
la resolución previa, acá reenviado a la validación real.

**Corregido de nuevo (F3-5, gate 19) — la llamada literal que la propia
corrección de F3-3 agregó tenía 2 defectos propios, encontrados por el
gate 19, ninguno relacionado con `excludeReservationId` (eso seguía
bien):**

- **F3-5a — `locked` no existe todavía en este punto.** La versión
  anterior de esta corrección escribía la llamada como
  `assertAllResourcesAvailable(client, [resourceId], locked.startTime,
  locked.endTime, id)` — pero el párrafo de arriba (F3-1, Ronda 16) es
  explícito: el lock+validación del candidato es la PRIMERA sentencia
  DENTRO de la transacción, **antes de lockear la fila de la reserva**.
  `locked` (la lectura BAJO lock de esa fila) recién existe DESPUÉS de
  este paso, no antes — usarlo acá es una referencia a un dato que
  todavía no se leyó. Corregido: la llamada usa las fechas de
  `queuedReservation` — la MISMA lectura SIN lock que el batch ya hizo al
  armar la lista de `PENDING_ASSIGNMENT` de la fecha (nombrada así de
  acá en más; ver "Rango de fechas del pre-lock", más abajo, que ya
  describía esta fuente en prosa sin darle nombre).
- **F3-5b — faltaba `partySize`.** Sin este argumento, la llamada toma el
  default `1` (`reservation-availability.service.ts:292-298`, `partySize
  = 1`) — subestimando, en cualquier recurso no exclusivo, la capacidad
  que esta reserva realmente ocupa, y dejando falsa la frase "validación
  completa, mismo mecanismo que `updateReservation()`" (que sí reenvía
  `existing.partySize`, `reservation.service.ts:628`, verificado).
  Corregido: `queuedReservation.partySize`, la misma lectura de arriba.
  A diferencia de las fechas, `partySize` no necesita compararse después
  contra `locked.partySize` para detectar un cambio concurrente —
  `updateReservation()` no lo recalcula ni lo deja modificar
  (`reservation.service.ts:617-620`, comentario "Bug 1, 25/08/2026":
  "permanece congelado desde la creación"), así que el valor que
  `queuedReservation` trae y el que `locked` traería más tarde son
  siempre el mismo, por construcción — no hay ventana de staleness que
  cerrar para este campo.

**Llamada corregida (F3-5, gate 19):**
`assertAllResourcesAvailable(client, [resourceId],
queuedReservation.startTime, queuedReservation.endTime, id,
queuedReservation.partySize)` (firma real,
`reservation-availability.service.ts:292-298`: `(client, resourceIds,
startTime, endTime, excludeReservationId?, partySize?)`).

**Corregido
(Hallazgo 2, Ronda 12): ya no es "el mismo mecanismo que check-in"** —
desde esa ronda, el pre-lock de check-in es un lock puro
(`lockByIds()`, sin validación, ver §6), mientras que "Auto Assign All"
SÍ necesita la validación completa acá: a diferencia de check-in (que
puede simplemente confirmar un recurso ya `ASSIGNED` sin reclamar nada
nuevo), TODA reserva que "Auto Assign All" procesa está `PENDING_ASSIGNMENT`
— genuinamente reclamando inventario, igual que una reasignación real de
`updateReservation()`. El batch lockea y valida el candidato ANTES de
lockear la fila de la reserva correspondiente, nunca al revés — ver la
tabla de §8 A6.1 (corregida en la misma ronda, mismo motivo).

**Rango de fechas del pre-lock — condición explícita (hallazgo menor de la
Ronda 10; la lectura sin lock queda nombrada `queuedReservation` desde el
gate 19/F3-5, ver arriba).** El rango de fechas
contra el que el batch pre-lockea y valida el candidato sale de
`queuedReservation` — la lectura SIN lock que el batch ya hizo al armar
la lista de `PENDING_ASSIGNMENT` de la fecha — no hay otra fuente
disponible antes de abrir la transacción de esa reserva puntual. Si, una
vez que esa transacción toma el lock de la fila, `locked.startTime`/
`locked.endTime` DIFIEREN de `queuedReservation.startTime`/
`queuedReservation.endTime` (alguien cambió las fechas de esa reserva
puntual mientras el batch corría, vía un `PUT` concurrente), la operación
aborta con `ReservationConcurrentlyModifiedError` — mismo error, mismo
criterio que el resto de este documento — **para esa reserva puntual
únicamente**; el batch sigue procesando el resto de la lista, no aborta
completo (cada reserva es su propia transacción, arriba). El staff puede
volver a correr "Auto Assign All" para recoger la que quedó sin procesar.
`queuedReservation.partySize` no participa de esta comparación — ver F3-5b
arriba para por qué ese campo no puede quedar desactualizado.

**Defensa en profundidad, dentro de `assignDeferred()`, no como
pre-filtro aparte — pero sin cerrar la carrera contra un check-in
concurrente (T1, corregido).** El chequeo de disponibilidad de reservas
(`reservation-availability.service.ts`) solo mira `reservations`, nunca
`stays` — una habitación con un huésped en check-in (de CUALQUIER
reserva, no solo de la que "Auto Assign All" está procesando) queda
invisible para ese chequeo. Por eso `assignDeferred()` incluye, como paso
propio (§8 A6.1, paso 7), un filtro contra `Stay`s activas en el recurso
candidato — "Auto Assign All" lo hereda gratis por invocar la misma
operación, no lo reimplementa. Corre DENTRO de la transacción de cada
reserva, pero la lectura en sí (`findActiveByResource()`,
`stay.repository.ts:118-125`) usa `this.db` — el pool inyectado por
constructor, no el `client` transaccional del caller — así que **no**
corre bajo el lock/la conexión de esa transacción. Un pre-filtro fuera del
lock sería estrictamente peor, pero "dentro de la transacción" acá no
equivale a "serializado contra `stays`": la ventana de carrera contra un
check-in concurrente sobre el mismo recurso candidato queda abierta —
limitación conocida y aceptada, declarada sin resolver (mismo hallazgo que
§8 A6.1, "Limitación de concurrencia declarada, no resuelta").

**Bug real en `findAvailableResourceInCategory()` — nunca excluye a la
propia reserva (F3-2, Ronda 16).** Verificado en código
(`reservation-availability.service.ts:234-260`, no en
`reservations.routes.ts`): la función arma su `params` sin ningún campo
`excludeReservationId` y llama a `this.checkAvailability(resource.id,
params.startTime, endTime, undefined, params.serviceId, params.partySize)`
(línea 253 — el `undefined` fijo es el parámetro `excludeReservationId` de
`checkAvailability()`) — nunca excluye ninguna reserva de la comparación
de solapamiento. **No es un bug preexistente de producción hoy** —
verificado con `grep -rn "findAvailableResourceInCategory" src/`: el único
call-site real es `reservations.routes.ts` (bloque `POST /`, alta de una
reserva NUEVA), donde no existe todavía ninguna reserva que excluir —
pasar `undefined` es correcto para ese caso, y `PUT /reservations/:id` no
acepta `categoryId` (solo `resourceId`, `UpdateReservationSchema`,
verificado), así que hoy no hay ningún segundo call-site que reutilice
esta función contra una reserva ya existente. El bug es específico de
cómo "Auto Assign All" planea REUSAR esta misma función para una reserva
que YA EXISTE y ya tiene un recurso provisorio asignado
(`PENDING_ASSIGNMENT`): sin excluirse a sí misma, esa reserva choca contra
SU PROPIO recurso provisorio en el chequeo de solapamiento — "Auto Assign
All" nunca podría confirmar la habitación provisoria como definitiva
(siempre movería al huésped a otra unidad aunque la provisoria fuera
válida), y si la categoría está llena, el proceso fallaría aunque la
asignación provisoria ya fuera correcta. **Requisito de implementación de
Fase 3, no resuelto en detalle acá:** `findAvailableResourceInCategory()`
gana un parámetro nuevo, `excludeReservationId?: string` (mismo nombre que
ya usa `checkAvailability()`), reenviado tal cual en el lugar de la línea
253 de arriba — "Auto Assign All" lo pasa con el id de la reserva que está
evaluando; el call-site de creación (`reservations.routes.ts`, que nunca
tiene una reserva propia que excluir) sigue sin pasarlo, comportamiento
idéntico a hoy. **No se registra aparte en `docs/pendientes-2026-09-12.md`**
— eso solo aplicaría si fuera un bug preexistente de producción, y no lo
es (ver arriba); queda especificado acá como requisito de implementación
de esta fase.

**Pregunta de negocio ABIERTA, NO resuelta acá (F3-4, gate 18) — "confirmar
la provisoria" vs. "reoptimizar" vs. "dejar el comportamiento actual"
(greedy alfabético).** Incluso con F3-2/F3-3 ya
corregidos (la reserva no choca contra su propio recurso provisorio),
`getByCategory()` (`sql.resource.repository.ts:141`, `ORDER BY r.name
ASC`, verificado) hace que `findAvailableResourceInCategory()` siempre
devuelva el PRIMER candidato libre por orden alfabético — no
necesariamente la habitación que la reserva ya tiene asignada como
provisoria, aunque esa provisoria siga siendo perfectamente válida. Efecto
práctico: "Auto Assign All" mueve sistemáticamente al huésped de su
habitación provisoria (ej. "105") a la primera libre por alfabeto (ej.
"101"), aunque "105" siguiera disponible.

**Corregido (C-3, ronda de correcciones sobre el gate 19) — se retira la
afirmación de que esto contradice "la lectura más natural" del
documento: esta pregunta no tiene una inclinación correcta que el texto
deba imponerle al dueño.** §4 Opción C (citado por texto, no por línea —
mismo criterio que SCHEMA-ANCHOR-DRIFT-001, la línea 254 citada en rondas
anteriores cae dentro de Opción A, no de Opción C) ya declara
explícitamente que la asignación provisoria "es reoptimizable, no
definitiva" — así que "reoptimizar" es una lectura tan legítima de este
mismo diseño como "confirmar la provisoria sin tocarla". Hay TRES
comportamientos igual de razonables y este documento NO elige entre
ellos:

(a) **Confirmar la provisoria** si sigue siendo válida, evitando mover
huéspedes sin necesidad.

(b) **Reoptimizar las reservas `PENDING_ASSIGNMENT` de la categoría**
— nunca las que ya están `ASSIGNED` — moviendo el candidato provisorio
de OTRAS reservas todavía sin confirmar a un mejor acomodo global
(efecto de mayor alcance que (a), y potencialmente deseable para un
operador que quiere maximizar ocupación contigua). **Acotada a
`PENDING_ASSIGNMENT` (corregido, C-3): una versión anterior de esta
opción decía "mover reservas YA CONFIRMADAS", sin distinguir `ASSIGNED`
de `PENDING_ASSIGNMENT`.** Mover una reserva ya `ASSIGNED` chocaría
contra A6.4 (`ASSIGNED: []` es terminal, transición de una sola vía, §8
A6.1) — `assignDeferred()` exige `locked.assignmentStatus ===
'PENDING_ASSIGNMENT'` (paso 2, si no `ReservationAlreadyAssignedError`)
para poder tocar nada, así que "mover una reserva `ASSIGNED`" no es una
variante menor de esta opción: es una operación distinta, que REABRIRÍA
A6.4 (una transición `ASSIGNED → PENDING_ASSIGNMENT` que hoy no existe)
y sería, en sí misma, otra decisión de negocio aparte, más grande, que
este documento tampoco resuelve.

(c) **Dejar el comportamiento tal como está especificado hoy** — greedy
alfabético, sin cambio de código adicional (`getByCategory()`/`ORDER BY
r.name ASC`, arriba): "Auto Assign All" simplemente confirma lo que
`findAvailableResourceInCategory()` resuelva, sea o no la provisoria.
**Agregada (C-3, ronda de correcciones sobre el gate 19)** — es lo que
pasa si nadie decide nada, y por eso es una tercera opción real, no la
mera ausencia de las otras dos: queda documentada acá para que sea una
de las opciones que se le presenten al dueño en el `AskUserQuestion`
real, no una omisión.

Siguiendo el criterio
ya declarado en este repo ("Preguntas de alcance pueden esconder una
decisión de negocio", `CLAUDE.md`): **esta pregunta se deja anotada,
pendiente de `AskUserQuestion` al dueño CUANDO se retome el diseño
completo de Fase 3** — no ahora, porque Fase 3 no se puede aprobar de
todas formas hasta que Fase 2 esté en producción (precondición de gate, ya
declarada más arriba). No se inventa una respuesta acá — sigue,
íntegramente, sin resolver.

### Fase 4 (evaluar aparte, después de medir el costo real)

Opción A, si channel manager u otro consumidor externo lo justifica.
Sigue acotada a alojamiento salvo que una fase futura, evaluada aparte,
decida extender el modelo a turnos.

### 6.1 Tabla regla × fase

| Regla | Fase |
|---|---|
| Columna `assignment_status` existe (default `ASSIGNED`) | Fase 1 |
| `restore()`/`ReservationProps.assignmentStatus` obligatorio, sin default + hidratación en `buildReservation()` | Fase 1 |
| Campo `assignmentStatus` en el DTO de staff; filtrado en las 4 respuestas del portal | Fase 1 |
| Mail de confirmación: `categoryName` en vez de `resourceName`, solo alojamiento | Fase 1 |
| Marcado real de `PENDING_ASSIGNMENT` al crear (alojamiento por categoría) | Fase 2 |
| `assignDeferred()` existe; `PUT` lo invoca vía el discriminador bajo lock (§8, reescrita Ronda 13 sobre el fix `6178d70`) | Fase 2 |
| Restricción de categoría (dentro de `assignDeferred()`) | Fase 2 |
| No-recotización del componente de precio por recurso (dentro de `assignDeferred()`) | Fase 2 |
| Filtro de `Stay` activa + atajo de "mismo recurso" (dentro de `assignDeferred()`) | Fase 2 |
| Check-in confirma la asignación | Fase 2 |
| Completar confirma la asignación | Fase 2 |
| `recordOccupancy()` se saltea mientras `PENDING_ASSIGNMENT` | Fase 2 (trivialmente seguro — nunca existe una `PENDING_ASSIGNMENT` antes de Fase 2) |
| `approveScheduleChange()` rechaza evaluar contra `PENDING_ASSIGNMENT` | Fase 2 |
| Test de regresión de D-1 (`resolveUnitPrice()` no depende de `resourceId` para alojamiento) — reemplaza la columna `priced_with_resource_id` descartada en la Ronda 16, ver §8 "D-1" | Fase 2 |
| `PUT` con `resourceId` combinado con `details`/`adultos`/`ninos` sobre `PENDING_ASSIGNMENT` se rechaza (`AssignmentCombinedChangeError`, D-2, decisión del dueño, Ronda 14, ver §8) | Fase 2 |
| "Auto Assign All" | Fase 3 |

---

## 7. Matriz de impacto — `resource.id`/`resourceId` en `reservas`, `pms-estadias`, `facturacion`

Punto de partida: `grep -rn "\.resource\.\|resourceId" src/reservas
src/pms-estadias src/facturacion` (excluidos `*.test.ts`). La inmensa
mayoría son el propio código dueño del dato — ahí el cambio es el propio
mecanismo que diseñan §6/§8, no "impacto" sobre un tercero. Lo que sigue
es la caminata de cada call-site de OTRO módulo (o de una función del
mismo módulo que hace una suposición no obvia) que lee
`reservation.resource.id` o depende de que sea el recurso final.

**Encuadre que cambia toda la matriz:** bajo la Opción C,
`reservations.resource_id` sigue siendo `NOT NULL` en todo momento — una
reserva `PENDING_ASSIGNMENT` igual tiene un `resource_id` concreto (el
primer candidato encontrado, provisorio). Ningún lector existente puede
recibir un `resource.id` null o undefined por este cambio. El riesgo real
no es "null pointer": es código que lee `reservation.resource.id`/`.name`
asumiendo que es el recurso **final** cuando, durante la ventana
`PENDING_ASSIGNMENT`, puede ser reemplazado más tarde.

| Archivo / call-site | Qué asume hoy | Rompe / se comporta mal / hay que actualizar |
|---|---|---|
| `src/pms-estadias/stay.service.ts::checkIn()` (`CheckInInput.resourceId`, línea 105; método, líneas 179-241) | El `resourceId` del check-in es un input explícito del staff, no `reservation.resource.id` | Ver §6, sub-alcance "check-in confirma la asignación", para el detalle completo (transacción nueva, `assignDeferred()`, orden de locks, tercera escritura). |
| `src/pms-estadias/stay.service.ts::checkOut()` (línea ~287) | Usa `stay.resourceId` (el recurso real del check-in), no `reservation.resource.id` | **No rompe.** El checkout ya trabaja sobre el recurso concreto de la `Stay`. |
| `src/pms-estadias/stay.service.ts::approveScheduleChange()` (línea 428; conflicto de late-checkout vía `findNextReservationOnResource()`, línea 437; ajuste de tarea de housekeeping vía `findActiveByResourceAndDate()`, línea 481) | Evalúa el conflicto de late-checkout y ajusta una tarea de housekeeping EXISTENTE contra `reservation.resource.id`, asumiendo que es el recurso final | **Se comporta mal, en silencio, si la reserva todavía está `PENDING_ASSIGNMENT`:** el chequeo corre contra el recurso PROVISORIO — puede aprobar un late-checkout que en el recurso FINAL sí tendría conflicto, o ajustar una tarea de housekeeping en el recurso equivocado. **Resuelto, condicionado a `requestedCheckOutTime` (C3, corregido).** El método ya distingue las dos ramas por ese campo — verificado en código: el chequeo de conflicto corre `if (preCheck.requestedCheckOutTime)` (línea 436, `findNextReservationOnResource()` lee `reservation.resource.id` en su línea 560) y el ajuste de housekeeping corre `if (reservation.requestedCheckOutTime)` (línea 479) — las dos ramas dependientes del recurso son EXACTAMENTE las que ya están condicionadas a `requestedCheckOutTime`; la rama de check-in temprano (`requestedCheckInTime` sin `requestedCheckOutTime`) no evalúa ningún conflicto de recurso hoy. El guard nuevo va DENTRO del `if (preCheck.requestedCheckOutTime)` existente (línea 436), no antes ni sin condición — si se pusiera sin condición bloquearía también la aprobación de un pedido de check-in temprano puro, que no depende del recurso final en absoluto y no tiene nada que ver con esta corrección. Lanza `ScheduleChangeAssignmentPendingError` (o nombre equivalente, mismo patrón que `AssignmentCategoryMismatchError`) si `preCheck.assignmentStatus === 'PENDING_ASSIGNMENT'`, antes de `findNextReservationOnResource()` — un solo guard, en ese punto, cierra la rama de conflicto Y la de ajuste de housekeeping (ambas dependen de la MISMA condición `requestedCheckOutTime`, así que si el guard la corta ninguna de las dos corre). Leer `assignmentStatus` para este guard es seguro sin tomar lock — la transición `PENDING_ASSIGNMENT → ASSIGNED` es de una sola vía, así que en el peor caso (dato levemente viejo) el guard rechaza de más, nunca aprueba de menos. No se degrada a "advertir y seguir": la garantía que este método da hoy (conflicto evaluado contra el recurso correcto) deja de tener sentido para una reserva cuyo recurso todavía puede cambiar, así que se rechaza en firme, consistente con A6.3 ("toda transición/operación inválida sobre un estado que no la soporta lanza error tipado, nunca se ignora en silencio"). |
| `src/reservas/reservation-availability.service.ts::recordOccupancy()`, llamado desde `confirmReservation()`, `completeReservation()`, y — desde Fase 2 — desde `updateReservation()`, el batch de "Auto Assign All" y `checkIn()`, cada uno de estos 3 últimos DESPUÉS de que su propia transacción haga commit | Escribe una fila en `occupancy_records` (`resource_id`, `resource_name`, `category_id`, `category_name`, fechas) keyed al `reservation.resource.id` vigente EN ESE MOMENTO | **Resuelto: "diferir", no "reemplazar".** `occupancy_records` es un CONTADOR AGREGADO (`UNIQUE (resource_id, date)`, `booked_minutes = booked_minutes + $N`, sin `reservation_id`, sin API para restar — `schema.sql:2361-2377`/`:2391-2392`, `sql.occupancy.repository.ts`) — no hay forma de "reemplazar" un registro ya escrito. `recordOccupancy()` se SALTEA mientras `assignment_status === 'PENDING_ASSIGNMENT'`. **Por qué esto no produce triple conteo** (investigado y descartado como problema real en esta ronda de gate): `SqlOccupancyRepository.recordReservation()` ya trae, desde antes de este diseño, un guard propio que hace no-op fuera de `CONFIRMED`/`COMPLETED` (`sql.occupancy.repository.ts:77-82` — `if (status !== ReservationStatus.CONFIRMED && status !== ReservationStatus.COMPLETED) { return; }`) — esa guarda es la que sostiene que este mecanismo sea seguro: aunque un caller llame a `recordOccupancy()` de más (ej. sobre una reserva `PENDING`), el repositorio la ignora sin escribir nada. El documento no la citaba explícitamente hasta esta corrección. `assignDeferred()` en sí **no** escribe ocupación — `SqlOccupancyRepository` recibe su `sqlClient` por constructor y `recordReservation()` no acepta un `client` de transacción, así que no hay forma de escribirlo dentro de la transacción de `assignDeferred()` sin que el incremento sobreviva a un rollback posterior. En cambio, cada uno de los 4 callers de `assignDeferred()` (PUT, "Auto Assign All", check-in, completar) llama a `recordOccupancy()` con el recurso ya confirmado, DESPUÉS de que su propia transacción haga commit — mismo patrón que ya usaban `confirmReservation()`/`completeReservation()`. Si la reserva nunca llega a `assignDeferred()` (se cancela estando `PENDING_ASSIGNMENT`), nunca se escribe ocupación — correcto, nunca hubo ocupación real. **Hallazgo colateral, fuera de alcance de 4.3:** `confirmReservation()` y `completeReservation()` llaman AMBAS a `recordOccupancy()`, y como `COMPLETED` solo se alcanza desde `CONFIRMED`, toda reserva completada suma ocupación DOS veces hoy — bug preexistente, independiente de 4.3, registrado en `docs/pendientes-2026-09-12.md` (`OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001`). |
| `reservation.service.ts::completeReservation()` | Hasta este diseño, una reserva `CONFIRMED` + `PENDING_ASSIGNMENT` que se completaba sin haber pasado nunca por una asignación definitiva quedaba `PENDING_ASSIGNMENT` para siempre, sin ocupación registrada | **Resuelto** — ver §6, sub-alcance "completar confirma la asignación". |
| `src/pms-estadias/maintenance-window.service.ts::createWindow()` — lee reservas vía `getActiveForResourceInRange()` (líneas 107/125/134/142, SIN lock, `this.sqlClient` directo, FUERA de la transacción que recién abre en la línea 160) y las guarda de vuelta enteras vía `reservationRepository.saveWithClient(client, reservation)` (línea 164, DENTRO de esa transacción) | **Corrección de caracterización (N3, Ronda 9; re-caracterizado en la Ronda 13/B-1 tras el commit `6178d70`).** Hasta el 24/09/2026 este `saveWithClient()` compartía el patrón "lee sin lock, fuera de transacción, antes de un UPSERT completo" con `updateReservation()` (el bug `UPDATE-RESERVATION-LOST-STATUS-001`) — **eso ya no es así: `updateReservation()` se arregló y commiteó en `6178d70`**, y ahora releé con `requireReservationWithLock()` DENTRO de la transacción antes de decidir qué escribir, igual que los otros escritores que ya siguen ese patrón — **corregido (C-8, Ronda 14): esta lista nombra 9, no 12** (recontado a mano: `confirmReservation()`, `completeReservation()`, `cancelReservation()`, `confirmPriceAdjustment()`, `requestScheduleChange()`, `rejectScheduleChange()`, `approveScheduleChange()`, `reservation-cancel-for-credit-note.ts:94/109`, `reservation-hold-expiry.worker.ts:104-106/122` — 9 entradas. Los 3 que faltan para llegar a 12 son `createReservation()` (no aplica: es un `INSERT` nuevo, no relee nada antes de escribir), `updateReservation()` (ya mencionado por separado en esta misma oración, es quien se arregló) y `assignDeferred()` (todavía no existe). "13 callers reales de `saveWithClient()`" es la cifra total de §8 A6.1 — estos 9 nombrados + `createReservation()` + `updateReservation()` + `assignDeferred()` (una vez que exista) = 12, más `createWindow()` mismo = 13). **`createWindow()` queda, en consecuencia, como el ÚNICO escritor real de `reservations` que sigue leyendo sin lock y fuera de transacción antes de un UPSERT completo** — no forma parte del alcance de 4.3 ni de este commit, sigue sin arreglarse acá (ver la columna de la derecha). | **Ya es un bug hoy, independiente de 4.3, no corregido en este diseño.** Si el UPSERT de la línea 164 hace commit en la ventana entre que `createWindow()` leyó la reserva (sin lock) y que otra operación concurrente (`assignDeferred()`, un `PUT` normal, cualquier otro escritor de esta lista) cambió esa misma fila y ya hizo commit, este UPSERT pisa esos cambios con el snapshot viejo — incluido `resource_id`/`assignment_status`, violando la transición de una sola vía (A6.4) y produciendo doble conteo de ocupación. Con 4.3, las ventanas `PENDING_ASSIGNMENT` (Fase 2) hacen más frecuente el escenario de "la reserva cambió mientras este código la tenía leída sin lock" — pero el bug YA EXISTE hoy (puede revertir un drag-to-move normal). No se arregla en este diseño — ver el prerrequisito nuevo de Fase 2 en §6, y el hallazgo registrado por separado en `docs/pendientes-2026-09-12.md`. |
| `src/facturacion/invoice.service.ts` (líneas 406, 453) — `description: reservation.resource.name` | El nombre de línea de la factura se resuelve en vivo desde el recurso referenciado por `resource_id` al momento de facturar — `Reservation` no snapshotea el nombre del recurso (gap `4.2`, fuera de alcance) | **No rompe, pero amplifica un gap ya registrado.** Con 4.3, "recurso provisorio distinto del final" pasa a ser el camino NORMAL (no la excepción) durante la ventana `PENDING_ASSIGNMENT` para toda reserva de alojamiento por categoría. Si se factura mientras la reserva sigue `PENDING_ASSIGNMENT`, el nombre de línea (documento — `docs/criterios-datos.md` Parte 1: "jamás se edita") queda fijado al recurso provisorio para siempre. No se resuelve acá (depende de `4.2`) — se deja señalado como argumento para que la implementación considere bloquear o advertir la facturación anticipada de una reserva `PENDING_ASSIGNMENT`, si el flujo de negocio lo permite hoy. |
| `reservation-pricing.service.ts` (cascada de `customer_rates`, incluye tarifas scoped a `resource_id` puntual) + `reservation.service.ts::updateReservation()` (recotiza si `existing.status === 'PENDING'`, línea 593 — re-verificada post-commit `6178d70`, C-2; congelado si `CONFIRMED`, A3.9) | `resolvePrice()` (`reservation-pricing.service.ts:117`) recibe `resourceId` como parámetro independiente de `startTime`/`endTime`/`ratePlanId` — el componente de precio por recurso ES técnicamente separable del de fechas/plan | Ver §8, "`updateReservation()` en relación con `assignDeferred()`" — la no-recotización se describe ahí junto con el resto del algoritmo, para no repetir el discriminador dos veces. |
| `src/reservas/resource-lock.service.ts`/`resource-lock.repository.ts` (`resource_locks`) | `resolveLockedResourceIds()` solo aporta algo si `serviceId` está seteado | **Impacto nulo — corregida la justificación (C-4, Ronda 14): la premisa anterior era falsa.** No es que una reserva de alojamiento "normalmente no lleve `serviceId`" — SIEMPRE lo lleva (`LodgingRequiresServiceError`, `reservation.service.ts:287`, verificado), así que `resolveLockedResourceIds()` nunca es un no-op para alojamiento. **El paso 8 de `assignDeferred()` (§8 A6.1) valida solo `[resourceId]`** — declarado explícitamente: `assertAllResourcesAvailable(client, [resourceId], ...)` recibe un array de UN elemento (el candidato puntual), no el resultado de `resolveLockedResourceIds()` — verificado en `reservation-availability.service.ts`: `assertAllResourcesAvailable()` no llama a `resolveLockedResourceIds()` en absoluto, toma `resourceIds: string[]` tal cual se lo pasan. Impacto nulo, entonces, no porque `assignDeferred()` revalide el conjunto completo, sino porque no hace falta: `resolveLockedResourceIds(serviceId, primaryResourceId)` (`reservation-availability.service.ts:268-282`) arma el conjunto adicional de recursos bloqueados A PARTIR DE `serviceId` únicamente (`resourceLockRepository.getByServiceId(serviceId)`) — `primaryResourceId` solo se agrega a ESE mismo conjunto, no cambia CUÁLES otros recursos bloquea el servicio. Como `assignDeferred()` nunca cambia `serviceId` (la categoría, y por lo tanto el servicio, no varían dentro de una asignación diferida — solo la unidad puntual dentro de esa categoría) ni cambia fechas, el conjunto de recursos adicionales que el servicio bloquea es EXACTAMENTE el mismo que `createReservation()` ya validó/lockeó al crear la reserva (con el candidato provisorio) — no hay nada nuevo que reclamar. |
| Los tres call-sites reales de `Reservation.restore()`: `src/reservas/sql.reservation.repository.ts::buildReservation()` (línea 559 — la llamada a `Reservation.restore(` en sí, mismo criterio que las otras dos citas de esta fila; la función se DECLARA en la línea 541, corregido C-2, Ronda 14: la Ronda 13 había cambiado esta cita de 559→541 con la justificación "estaba desactualizado", que era falsa — 559 sigue siendo la línea real de la llamada — hidratación de TODA lectura de una reserva desde la BD), y `src/reservas/reservation.service.ts::updateReservation()` (línea 631) / `::confirmPriceAdjustment()` (línea 826) — re-verificadas post-commit `6178d70`, C-2 — **corregido (T5): los dos últimos están en `reservation.service.ts`, NO en `sql.reservation.repository.ts`** — solo `buildReservation()` vive en el repositorio | Reconstruyen la entidad desde una fila de Postgres o desde una lectura previa | `assignmentStatus` en `ReservationProps` pasa a ser OBLIGATORIO, sin default, en los tres — mismo patrón que `reservationNumber`. **Corregido (condición menor del gate 18) — la versión anterior de esta fila decía "a diferencia de los demás campos de esa función (que usan `??` sobre la fila)", falso: `buildReservation()` ya carga hoy `reservationNumber: row.reservation_number` y `appliedCustomerRateId: row.applied_customer_rate_id` sin `??` (verificado con `grep -n`/`sed -n` contra `sql.reservation.repository.ts`) — no son la excepción, son el precedente.** En `buildReservation()`, igual que esos dos, `assignment_status` **no puede** tener un `?? 'ASSIGNED'` — un `SELECT` que por algún motivo no traiga la columna reintroduciría el bug en el punto de mayor superficie (toda lectura de cualquier reserva); a diferencia de `reservationNumber`/`appliedCustomerRateId` (que solo quedan `undefined` en runtime si la columna falta, sin guard propio), `assignmentStatus` además queda protegido por la validación nueva del constructor/`restore()` de `Reservation` (G-1, ver §8 A6.1) — un valor `undefined` o inválido lanza en vez de persistir en silencio. Los otros dos call-sites (`updateReservation()`/`confirmPriceAdjustment()`) reenvían `locked.assignmentStatus`/el valor ya leído, nunca lo infieren. Ver §8 A6.1. |
| `src/api/mappers/reservation.mapper.ts` (`toReservationDto()`) — dos consumidores: `GET /reservations`/`GET /:id` de staff (`reservations.routes.ts`, líneas 287/341) y el portal de clientes (`api/routes/customer.routes.ts`, 4 call-sites por símbolo — C-c: `GET /me/reservations`, `POST /me/reservations`, `PATCH /me/reservations/:id`, `POST /me/reservations/:id/cancel`) | No tiene campo para distinguir "recurso provisorio vs. definitivo" | `ReservationDto` agrega `assignmentStatus` para el path de staff — se filtra de las 4 respuestas del portal (el huésped no ve el estado provisorio como algo nuevo en su experiencia). Ver §6 Fase 1. |
| `src/pms-estadias/maintenance-window*.ts`, `reservation-availability.service.ts` (bloqueo por mantenimiento) | Ya excluyen recursos bloqueados al resolver `findAvailableResourceInCategory()`/`assertAllResourcesAvailable()` | **Impacto nulo.** Agnóstico de si la asignación es provisoria o definitiva. |
| `GET /reservations/:id/price-preview` / `POST /reservations/:id/confirm-price-adjustment` (`Roles.MANAGEMENT`, ya existentes) | Ofrecen ajuste manual de precio sin distinguir si la reserva pasó por asignación diferida | **Confirmado, sin cambio de código.** Después de una asignación diferida a un recurso con otro precio, esta salida manual sigue disponible — el staff decide caso por caso. Coincide con el principio ya declarado en este repo: la app no le dice al negocio cómo trabajar, le da una salida. |
| `appfrontend/src/components/RoomCalendar.tsx` (líneas ~297-302, construcción de `changes` al soltar el drag) → `dashboard/reservas/page.tsx::handleCalendarUpdate()` (línea 236) → `PUT /reservations/:id` | El drag-to-move/resize arma `changes` con cualquier combinación de `startTime`/`endTime`/`resourceId` y llama al mismo `PUT` que la pantalla de detalle | El drag-to-move normal (reserva YA `ASSIGNED`) sigue sin pasar por `assignDeferred()`. Comportamiento por caso una vez implementada Fase 2: (1) arrastrar una `PENDING_ASSIGNMENT` solo de fila (mismo rango, otro `resourceId`) → confirma vía `assignDeferred()`; (2) arrastrarla en diagonal (`resourceId` Y fechas a la vez) → rechazo tipado (`AssignmentCombinedChangeError`) — regresión de UX real respecto de hoy, aceptada; (3) arrastrarla a un recurso de otra categoría → rechazo tipado (`AssignmentCategoryMismatchError`). El frontend necesita distinguir estos casos en su manejo de error — alcance de implementación de Fase 2. |
| `src/api/routes/customer.routes.ts::PATCH /me/reservations/:id` → `updateReservation()` — `UpdateCustomerReservationSchema` (citas por símbolo, no por línea — C-c: `startTime`/`endTime`/`details`, sin `resourceId`) | El portal deja al huésped cambiar fechas/detalles de SU reserva mientras sigue `PENDING`; nunca puede mandar `resourceId` | El portal nunca puede confirmar ni combinar una reasignación (no manda `resourceId`). Puede quedar afectado indirectamente: si una reserva creada por STAFF a nombre de un cliente (la única forma real de que una reserva de portal esté `PENDING_ASSIGNMENT`) cambia fechas desde el portal, `updateReservation()` corre la disponibilidad contra el recurso PROVISORIO puntual, no contra "cualquier recurso libre de la categoría". **Limitación de UX conocida, aceptada:** puede devolver `409` por falta de disponibilidad del recurso provisorio aunque la categoría tenga lugar de sobra en otra unidad — resolverlo excede el alcance de 4.3 (tocaría el chequeo de disponibilidad general, no solo el camino de asignación diferida). |

**Resumen de lo que hay que tocar, más allá del propio módulo `reservas`
(que ya está en alcance de las Fases 1-3):**

1. `reservas/Reservation.ts` — `ASSIGNMENT_STATUS_TRANSITIONS`, `toProps()`,
   `assignConcreteResource()` (§8 A6.1).
2. `reservas/reservation.service.ts` — `assignDeferred()`, el método
   público nuevo `recordOccupancy(reservation: Reservation): Promise<void>`
   (delega a `this.availability.recordOccupancy(reservation)`, B-2, Ronda
   13 — necesario porque `StayService` no tiene, ni va a tener, acceso
   directo a `this.availability`, ver §6 sub-alcance "check-in"), la
   dependencia nueva a `StayRepository` (§8 A6.1), el cuarto sitio de construcción de
   `ReservationProps` (`createReservation()`, `new Reservation(...)`,
   línea 368 — re-verificada post-commit `6178d70`, C-2) recibiendo la
   señal `enteredByCategory` (B2), y el discriminador de
   `updateReservation()` que invoca `assignDeferred()` cuando corresponde
   — ver §8 para el mecanismo real, re-anclado en la Ronda 13 al fix ya
   commiteado (`6178d70`): el lock de `resources` antes que el de la
   reserva y el guard de coherencia de 2 campos
   (`resource.id`/`serviceId`) **ya existen en el código real** — no son
   un "arreglo aparte" pendiente, son el mecanismo que `updateReservation()`
   ya tiene; 4.3 solo agrega el discriminador que decide cuándo desviarse
   hacia `assignDeferred()`. **Agregado en la Ronda 12 (Hallazgo 1):** el
   nuevo lock condicional de recurso de
   `completeReservation()` (§6, sub-alcance "completar") también vive en
   este archivo — usa `resourceRepository`, ya inyectado en la clase, sin
   dependencia nueva que wirear (a diferencia del ítem 6/12 de abajo, que
   sí necesita wiring nuevo para check-in).
3. `reservas/reservations.routes.ts` — bloque `POST /` (líneas 385-400):
   pasar `enteredByCategory` a `createReservation()` (B2, contrato
   ruta↔servicio).
4. `domain/errors.ts` — **corregido (N-3, Ronda 14): 4 clases nuevas, no
   5** — `AssignmentCategoryMismatchError`, `AssignmentCombinedChangeError`,
   `ReservationAlreadyAssignedError`, `ScheduleChangeAssignmentPendingError`
   (nuevas); `ReservationConcurrentlyModifiedError` **ya existe** en este
   archivo (agregada por el fix `6178d70` de `updateReservation()`,
   verificado — no es una clase que Fase 2 tenga que crear); y **relocar
   `ResourceOccupiedError`** desde `pms-estadias/stay.service.ts` a este
   archivo (§8 A6.1, riesgo de ciclo de imports) — el resto de los ~100
   errores de dominio del repo ya vive acá, esto solo lo alinea con la
   convención existente.
   **`reservas/sql.occupancy.repository.ts` NO se toca** — `assignDeferred()`
   no escribe ocupación (ver fila de `recordOccupancy()` arriba); no hay
   ningún cambio que hacerle a ese repositorio.
5. `api/middleware/error.middleware.ts` — **corregido (N-3, Ronda 14):
   mapear los 4 errores tipados genuinamente nuevos** al código HTTP que
   corresponde (409 para los 4, mismo commit que cada uno se introduce —
   C2, §6 Fase 2 ítem 8). `ResourceOccupiedError` no necesita entrada
   nueva (ya mapeado, `case 'RESOURCE_OCCUPIED':` — cita por símbolo, no
   por línea, C-c); tampoco `ReservationConcurrentlyModifiedError` (ya
   mapeado desde `6178d70`, `case 'RESERVATION_CONCURRENTLY_MODIFIED':` —
   cita por símbolo, no por línea, C-c).
6. `pms-estadias/stay.service.ts::checkIn()` — transacción nueva,
   discriminador `ASSIGNED`/`PENDING_ASSIGNMENT` leído bajo lock (H1),
   pre-lock INCONDICIONAL del recurso candidato antes de la fila (H2 — ya
   no depende de una lectura previa sin lock, ver §6) — **corregido,
   Hallazgo 2, Ronda 12: ese pre-lock es un lock PURO** (`resourceRepository.lockByIds()`),
   sin la validación completa que traía `assertAllResourcesAvailable()` en
   una versión anterior de este documento —, composición de
   `assignDeferred()` solo cuando `PENDING_ASSIGNMENT`, tercera escritura
   (`linkStayToReservationCharges()`) dentro de la misma transacción, y el
   `import` de `ResourceOccupiedError` pasa a venir de `domain/errors.ts`
   en vez de definirse localmente (§6, §8).
7. `pms-estadias/stay.service.ts::approveScheduleChange()` — guard nuevo
   contra `PENDING_ASSIGNMENT`, condicionado a `requestedCheckOutTime`
   (C3), `ScheduleChangeAssignmentPendingError` (fila de arriba).
8. `pms-estadias/stay.repository.ts` — `saveWithClient()` nueva (para
   check-in transaccional).
9. `pms-estadias/stay.service.test.ts` — el `import` de
   `ResourceOccupiedError` (línea 2, hoy `from './stay.service.js'`) pasa
   a venir de `domain/errors.ts` una vez relocado (mismo cambio que el
   ítem 4/6) — sin esto el archivo de test queda con un import roto.
10. `clientes-finanzas/sql.financial-transaction.repository.ts` —
    `linkStayToReservationCharges()` necesita variante `WithClient`.
11. `src/api/mappers/reservation.mapper.ts::toReservationDto()` — **corregido
    (condición menor del gate 18): el path real es `src/api/mappers/`, no
    `reservas/` — verificado con `ls`, ver también la fila de este mismo
    archivo en §7** — agregar
    `assignmentStatus`, filtrarlo de las 4 respuestas de `customer.routes.ts`.
12. **Los 3 sitios de wiring EXISTENTES de `ReservationService`**
    (`reservations.routes.ts::buildReservationService()`,
    `bookable-services.routes.ts::buildReservationService()`,
    `customer.routes.ts` — los mismos 3 que nombra el docblock D-10 de
    `reservation.service.ts`, verificado con `grep -rn "new ReservationService("
    src/`: son exactamente esos 3, más ningún otro) necesitan pasar la
    dependencia nueva a `StayRepository` (§8 A6.1, paso 7) — **y son los
    ÚNICOS 3 que la necesitan, sin agregarse un cuarto (ver más abajo).**
    Hallazgo original, sigue vigente (N-1, Ronda 14, gate
    `architecture-governor`) — falta un lugar donde `StayService` obtenga
    un `ReservationService`. **La resolución cambió en la Ronda 15 — la
    de la Ronda 14 partía de una lectura incorrecta del docblock D-10 (ver
    abajo).**

    `StayService` se construye en 2 sitios
    (`reservations.routes.ts::buildStayService()` y `app.ts`, montaje por
    closure de `/api/stays`, líneas 485-519, con `new StayService(` en la
    línea 500 — re-verificado con `grep -n` contra el archivo real, no
    497-525 como decían rondas anteriores) y, con este diseño, gana dos
    dependencias nuevas: `ReservationService` completo (para
    `assignDeferred()` y `recordOccupancy()`, ítem 2 arriba) y
    `ResourceRepository` (o el `Pick<ResourceRepository, 'lockByIds'>`
    equivalente, para el pre-lock puro de `checkIn()`, Hallazgo 2/Ronda
    12, ver §6). El primer sitio no tiene problema con ninguna de las dos:
    `reservations.routes.ts::buildStayService()` (línea 223) ya construye
    `resourceRepo` localmente (línea 226, reusado ahí mismo para
    `reservationRepo`) — la segunda dependencia ya está en su scope, sin
    ningún wiring nuevo — y `reservations.routes.ts` YA tiene
    `buildReservationService()` en el mismo archivo (línea 122), así que
    `buildStayService()` puede llamarla directo para la primera. **El
    segundo sitio (`app.ts:485-519`) hoy no tiene NINGUNA referencia a
    `ReservationService`** — verificado, 0 ocurrencias.

    **Decisión (corregida en la Ronda 15 — la Ronda 14 la había resuelto
    mal): exportar `buildStayService()` y que `app.ts` la llame, en vez de
    agregar un cuarto composition root manual de `ReservationService`.**

    **Por qué la Ronda 14 se equivocó — el docblock D-10 no dice lo que la
    Ronda 14 le hacía decir.** La justificación de la Ronda 14 leía el
    docblock D-10 de `reservation.service.ts` (línea 163 en adelante —
    *"un parámetro nuevo con default no rompe `tsc --noEmit` si alguno de
    los 3 composition roots... se olvida de actualizarse; requerido, el
    compilador los obliga a los tres"*) como un argumento CONTRA compartir
    un builder entre sitios de wiring. **No lo es.** D-10 argumenta
    específicamente CONTRA un parámetro de constructor CON default — no
    dice nada sobre si esos sitios deberían compartir código. Si los 3
    sitios llamaran a un builder ÚNICO (en vez de repetir `new
    ReservationService(...)` cada uno por su cuenta), el compilador
    seguiría obligando a corregir un parámetro nuevo sin default
    exactamente igual — solo que en UN lugar (donde vive el `new
    ReservationService(...)` real) en vez de en cada caller de ese
    builder. Compartir un builder no debilita la garantía que D-10
    describe — la debilitaría un DEFAULT en el constructor, no un builder
    compartido. La Ronda 14 confundió "cada sitio construye la instancia
    de forma independiente" (cierto hoy, por los 3 composition roots
    reales, verificado con `grep -rn "new ReservationService(" src/`) con
    "cada sitio TIENE que construir la instancia de forma independiente"
    (no se sigue de D-10).

    **Con la justificación corregida, exportar y reusar es la opción
    correcta.** `buildStayService()` no necesita ningún builder nuevo:
    llama a `buildReservationService(req)` — función YA existente en el
    MISMO archivo (`reservations.routes.ts:122`), sin necesidad de
    exportarla para que `buildStayService()` la use (ambas viven en el
    mismo módulo). Lo único que hace falta exportar es `buildStayService()`
    misma (agregarle `export` a su declaración, línea 223), para que
    `app.ts` la importe — mismo criterio que la "alternativa descartada"
    que la propia Ronda 14 ya había evaluado como técnicamente viable:
    `app.ts` ya importa `createReservationsRouter` del mismo archivo
    (línea 48), así que no se abre ningún ciclo de imports nuevo, y
    ninguna dependencia de `buildStayService()`/`buildReservationService()`
    es exclusiva del contexto de `/api/reservations` (son repositorios
    `Sql*` construidos desde `req.db`, disponibles igual en el closure de
    `/api/stays`).

    **Consecuencia práctica — el segundo composition root de `app.ts`
    (líneas 485-519) deja de construir `StayService` a mano.** El closure
    de `/api/stays` pasa de reconstruir manualmente `stayRepo`/
    `resourceRepo`/`reservationRepo`/`housekeepingRepo`/`financialRepo`/
    `businessProfileRepo` (6 instancias, línea por línea idénticas a las
    que `buildStayService()` ya construye en `reservations.routes.ts`) a
    llamar directamente `buildStayService(req)` — que ya hace ese trabajo,
    ahora con las 2 dependencias nuevas incluidas. `arService` (construido
    en las líneas siguientes del mismo closure, para `/api/accounts-receivable`
    compartiendo `/api/stays`) sigue necesitando sus propias instancias de
    `stayRepo`/`financialRepo`/`reservationRepo`/`businessProfileRepo` —
    como `buildStayService()` no expone sus instancias internas, `app.ts`
    construye sus PROPIAS copias para `arService` (mismo patrón que ya usa
    hoy). Son wrappers sin estado sobre `req.db` (`buildTenantTransactionManager(req)`
    también — envuelve el pool ya cacheado del tenant, verificado en
    `db/tenant-context.ts:75-85`): dos instancias en vez de una compartida
    no cambia ningún comportamiento, solo repite una construcción barata.

    **Con esto, la matriz de impacto sigue contando 3 sitios de
    construcción DIRECTA de `new ReservationService(` — los mismos de
    siempre (`reservations.routes.ts`, `bookable-services.routes.ts`,
    `customer.routes.ts`) — no 4.** El docblock D-10 de
    `reservation.service.ts` y el comentario de `bookable-services.routes.ts`
    que dicen "3 composition roots" **siguen siendo correctos, sin que
    haga falta actualizarlos** — a diferencia de lo que la Ronda 14 daba
    por hecho (que un cuarto sitio de construcción directa los iba a dejar
    desactualizados). `app.ts` consume `ReservationService`
    INDIRECTAMENTE, a través de `buildStayService()` → `buildReservationService()`
    — nunca llama `new ReservationService(...)` por su cuenta. **Conteo
    de dependencias corregido (condición de la Ronda 15 sobre N-1):** son
    **18 dependencias obligatorias + 1 reloj opcional con default**
    (`now: () => Date = () => new Date()`, `reservation.service.ts:117-185`,
    recontado a mano contra el constructor real) — no "19 (20 con
    `StayRepository`)" como decían rondas anteriores. El total de
    parámetros de la firma actual es 19 (18 obligatorios + 1 opcional);
    `StayRepository` no es una dependencia de `ReservationService` en este
    diseño (es una dependencia nueva de `assignDeferred()`, §8 A6.1 paso
    7, agregada al mismo constructor) — pasaría a ser el 20º parámetro,
    obligatorio y sin default, mismo criterio que `auditLogRepo`.

    Los 2 sitios de wiring de `StayService` — verificados como los únicos
    2 call-sites reales de `new StayService(` en `src/`
    (`reservations.routes.ts::buildStayService()`, `app.ts`, ahora vía la
    llamada a `buildStayService(req)` importada) — necesitan pasar las
    dependencias nuevas: `ReservationService` (para `assignDeferred()` Y
    el método público nuevo `recordOccupancy()`, ítem 2 arriba — B-2,
    Ronda 13: ninguna de las dos existe hoy en el constructor de
    `StayService`, verificado) y, agregada en el Hallazgo 2/Ronda 12,
    `ResourceRepository` (o el `Pick<ResourceRepository, 'lockByIds'>`
    equivalente) — las dos se resuelven DENTRO de `buildStayService()`
    (arriba), así que este cambio vive en un solo lugar
    (`reservations.routes.ts`), no en los 2 call-sites por separado. El
    nuevo lock condicional de `completeReservation()` (Hallazgo 1, ítem 2
    de arriba) NO agrega ningún sitio de wiring — usa `resourceRepository`,
    ya inyectado en `ReservationService`. Los tests que construyen estas
    piezas a mano también necesitan el mock nuevo (no se cuentan uno por
    uno acá).

    **Si en el futuro aparece un QUINTO sitio que necesite
    `ReservationService` completo por su cuenta (no a través de
    `StayService`), en ese momento sí vale la pena reconsiderar si
    `buildReservationService()` se exporta directamente** — hoy no hace
    falta: solo `buildStayService()`, que vive en el mismo archivo, la
    necesita (`decision-record-discipline`).
13. `src/workers/email.handlers.ts` — **corregido (condición menor del gate
    18): el path real es `src/workers/`, no `email/workers/` — verificado
    con `ls`** — destructurar `categoryName` del
    payload, elegir el nombre según `isLodging`.
14. `appfrontend/src/components/RoomCalendar.tsx`/`dashboard/reservas/page.tsx`
    — distinguir los 3 casos de una reserva `PENDING_ASSIGNMENT` al
    manejar el error del `PUT` del drag-to-move.
15. `docs/rbac-matriz-endpoints.md` + las cinco cercas RBAC/contrato
    citadas en la nota de Fase 0 (§6) — al agregar `GET
    /reservations/availability-by-category` y `POST` de "Auto Assign All".

---

## 8. Análisis de máquina de estados — `docs/criterios-negocio.md` §6 (A6.1-A6.6)

`assignment_status` (`PENDING_ASSIGNMENT` → `ASSIGNED`) es una máquina de
estados nueva y genuina sobre `Reservation` — distinta e independiente del
`status` que ya existe (`PENDING`/`CONFIRMED`/`CANCELLED`/`COMPLETED`/
`EXPIRED`, `Reservation.ts:78-87`). Las dos máquinas conviven en la misma
entidad sin acoplarse entre sí, salvo en el punto de precio (ver más abajo,
"`updateReservation()` en relación con `assignDeferred()`"), donde la
convivencia está resuelta por una regla explícita, no dejada como residuo.
Requerido por `CLAUDE.md` de este repo antes de que cualquier código toque
un estado nuevo — análisis, no implementación.

### A6.1 — La máquina se declara una sola vez, como dato

La transición completa es trivial: dos estados, una sola arista permitida.
Una constante `ASSIGNMENT_STATUS_TRANSITIONS: Record<AssignmentStatus,
AssignmentStatus[]>` (`{ PENDING_ASSIGNMENT: ['ASSIGNED'], ASSIGNED: [] }`)
vive en `reservas/Reservation.ts`, junto a `ALLOWED_TRANSITIONS` (línea 78)
— convención ya establecida en ese archivo. `ASSIGNED: []` hace que **A6.4
("los estados terminales no se reabren")** sea estructural, no solo
convencional: no existe ninguna arista de salida de `ASSIGNED`, así que no
hace falta un guard aparte para impedir el regreso.

**Validación de VALOR, distinta de la validación de TRANSICIÓN de más
abajo (G-1, gate 18).** La falla de T-2 (Anexo, Ronda 16 — la garantía de
"columna faltante = falla visible" resultó falsa para el campo que D-1'
proponía) aplica igual a `assignment_status`, y con radio mayor: no es una
columna opcional de cara a futuro, es un campo que CADA lectura de
CUALQUIER reserva hidrata (`buildReservation()`, los tres call-sites de
`restore()`, §7). Si `baseSelect()` se olvida de `r.assignment_status`
(bullet nuevo de Fase 1, §6), o cualquier otro caller construye
`ReservationProps` sin el campo, un valor `undefined` sin guard haría que
`=== 'ASSIGNED'`/`=== 'PENDING_ASSIGNMENT'` den los dos falso en
silencio, y el siguiente `UPSERT` grabaría `NULL` — violando el `NOT NULL`
de la columna (Fase 1) en CUALQUIER guardado de CUALQUIER reserva, no solo
las diferidas. El constructor de `Reservation` (invocado tanto por `new
Reservation(...)` como, internamente, por `Reservation.restore()`) valida
`assignmentStatus` contra `Object.keys(ASSIGNMENT_STATUS_TRANSITIONS)` —
mismo objeto que declara las transiciones, una sola fuente de verdad para
"qué valores son válidos" y "qué transición es válida" — y lanza
`InvalidReservationError` si el valor no es una de las dos claves,
incluido `undefined`. Es una validación de FORMA (¿es uno de los dos
valores permitidos?), no de FLUJO (¿puede pasar de este valor a otro?) —
esa segunda pregunta es la que resuelve `assignConcreteResource()`, más
abajo, que asume que el valor de entrada ya es válido porque el
constructor no deja construir la entidad si no lo es. Test obligatorio,
alcance de Fase 1: ver §6, bullet de `baseSelect()`/validación runtime.

Un solo método de la entidad, `Reservation.assignConcreteResource(resource,
isExclusiveResource)`, es el único punto de escritura que aplica la
transición dentro de la entidad — ni el service ni las rutas escriben
`assignment_status` directo.

**Contrato del método, para no repetir el bug ya conocido 4 veces en este
archivo** (`requestedCheckInTime`/`isExclusiveResource`/
`needsMaintenanceReview`/`cancellationPolicySnapshot`, comentarios fechados
en `reservation.service.ts`, líneas ~648-689/~852-868 (re-derivadas con
`grep -n`/`sed -n` en la Ronda 14, C-1 — decían `~571-603/~774`, ya
desactualizadas): cualquier reconstrucción
de la entidad que no reenvíe explícitamente un campo existente lo pisa en
silencio con su default) — nunca listar cada campo a mano: la entidad
agrega un método privado `toProps(): ReservationProps` que serializa TODOS
sus campos actuales a un objeto plano (mismo espíritu que `toSnapshot()`,
que ya existe pero es parcial — id/resourceId/startTime/endTime/status/
serviceId/partySize/orderItemId, insuficiente acá), y
`assignConcreteResource()` construye la instancia nueva a partir de ESE
objeto, sobrescribiendo solo `resource`, `isExclusiveResource` y
`assignmentStatus`:

```
assignConcreteResource(resource: BookableResource, isExclusiveResource: boolean): Reservation {
  // valida la arista contra ASSIGNMENT_STATUS_TRANSITIONS
  // (lanza si this._assignmentStatus no permite pasar a 'ASSIGNED')
  return Reservation.restore({
    ...this.toProps(),
    resource,
    isExclusiveResource,
    assignmentStatus: 'ASSIGNED',
  });
}
```

Reusar `Reservation.restore()` internamente (en vez de `new Reservation()`
directo) valida `partySize` contra `resource.capacity` gratis — mismo
chequeo que ya hace el constructor (`Reservation.ts:277-281`).

**Test obligatorio, parte del diseño (para que quien implemente Fase 1/2 lo
haga):** un test de preservación de propiedades — construir una reserva con
TODOS los campos seteados a valores no-default, pasarla por
`assignConcreteResource()`, y verificar que TODOS los campos excepto
`resource`/`isExclusiveResource`/`assignmentStatus` quedaron IGUALES. Este
test es lo que previene que un `toProps()` roto en el futuro reintroduzca
la misma familia de bug en silencio.

### A6.1 (cont.) — `assignDeferred()`, la operación de aplicación

`assignConcreteResource()` de la entidad no alcanza por sí solo: reasignar
una `PENDING_ASSIGNMENT` necesita, además, lock, re-chequeo de
concurrencia, validación del recurso nuevo, restricción de categoría,
verificación de que el recurso candidato no está ocupado por un huésped en
check-in, re-chequeo de disponibilidad del rango, y auditoría — todo eso
vive en una sola operación de servicio, propiedad del módulo `reservas`,
que los CUATRO caminos (PUT, "Auto Assign All", check-in, completar)
invocan en vez de reimplementarlo cada uno por su lado:

```
ReservationService.assignDeferred(
  client: SqlClient,
  reservationId: string,
  resourceId: string,
  businessId: string,
  changedBy: string,
): Promise<Reservation>
```

`changedBy: string` (no un objeto `actor`) es la convención real que ya
usa este módulo (`confirmReservation()`, `completeReservation()`,
`recordFieldChangesWithClient()`). Recibe el `client` de la transacción
del CALLER — no abre su propia transacción, porque `checkIn()` y
`updateReservation()` necesitan componerla dentro de la suya.
`businessId: string` es un parámetro nuevo respecto de las rondas
anteriores (**C1**): el paso del filtro de `Stay`s activas necesita
`findActiveByResource(resourceId, businessId)` (firma real, verificada en
código — `stay.repository.ts:118`) y `Reservation` no trae `businessId`
como campo propio (verificado: no hay ningún campo `businessId` en
`Reservation.ts`) — no hay forma de derivarlo de `locked`, así que el
caller tiene que proveerlo explícitamente.

**Tabla única de orden de locks (N1, Ronda 9 — corregida en la Ronda 10/H2,
y en la Ronda 12/Hallazgo 1).** Reemplaza la prosa dispersa que había en
cada sección (check-in, "Auto Assign All", `updateReservation()`,
"completar"). En toda fila que tome algún lock de recurso, el orden es
SIEMPRE recurso (candidato o efectivo, según corresponda) → fila de la
reserva, nunca al revés, y nunca dos veces el mismo recurso salvo el
re-lock interno (no-op) de `assignDeferred()` sobre un recurso que su
caller ya lockeó. **Corrección de la Ronda 10:** las dos filas separadas
de check-in que tenía la Ronda 9 ("mismo recurso" con "cero locks",
"cambio de recurso" con lock) se reemplazan por una sola — el
`INSERT INTO stays` (`stays.resource_id REFERENCES resources(id)`,
`schema.sql:2115`) toma SIEMPRE un lock implícito `FOR KEY SHARE` sobre el
recurso referenciado, sin la optimización de "no cambió el valor" que sí
existe para un `UPDATE`. **Corrección de la Ronda 12 (Hallazgo 1):** esa
optimización de "`UPDATE` que no cambia el valor" tampoco protegía a
"completar" como se pensaba — el gate de la Ronda 11 encontró, verificado
contra Postgres real, que la optimización NO aplica cuando la MISMA
transacción ya escribió la fila antes (aunque sea con el mismo valor): el
UPSERT de `assignDeferred()` (primera escritura) seguido del `UPDATE`
propio de `completeReservation()` (segunda escritura, misma fila, misma
transacción) SÍ dispara el chequeo de FK. Con esto, **la tabla queda,
finalmente, sin ninguna fila de excepción**: todo camino que pueda
invocar `assignDeferred()` con la reserva `PENDING_ASSIGNMENT` lockea
recurso-primero-fila-después; el camino `ASSIGNED` de cada uno (que no
invoca `assignDeferred()`) no lockea ningún recurso, pero eso no es una
excepción al invariante — es, simplemente, que esa rama no escribe nada
con FK hacia `resources`:

| Caller / Camino | Orden de adquisición de locks |
|---|---|
| `PUT /reservations/:id` (`updateReservation()`), sin reasignación (`isSameResource`, incluye solo cambiar fechas/detalles) | Recurso EFECTIVO (el mismo que ya tenía — `updateReservation()` lo lockea igual, para revalidar el rango de fechas aunque el recurso no cambie) → fila de la reserva. |
| `PUT /reservations/:id` (`updateReservation()`), con reasignación (`!isSameResource`) | Recurso CANDIDATO (el nuevo) → fila de la reserva → (dentro de la misma transacción, ambos ya lockeados) `assignDeferred()` compuesta, sin locks nuevos. |
| Check-in, cualquier `resourceId` (H2, Ronda 10 — reemplaza las dos filas de la Ronda 9) | Recurso (`input.resourceId`, dato de ENTRADA del check-in — el mismo con el que se va a hacer el `INSERT` de `Stay`, sea el provisorio u otro elegido por el staff; lock PURO vía `lockByIds()`, sin validación — Hallazgo 2, Ronda 12, ver §6) → fila de la reserva. La restricción de categoría (`AssignmentCategoryMismatchError`, si `!isSameResource`) se evalúa DESPUÉS de que los dos locks ya están tomados, dentro de `assignDeferred()` (su paso 6) — no antes. |
| Completar (`completeReservation()`) — **ya no es una excepción (Hallazgo 1, Ronda 12 — corrige N2/Rondas 9-10, que resultó falso, ver §6); decisión corregida en la Ronda 13/B-3; guard acotado reintroducido en la Ronda 14/N-2** | `preCheck` sin lock (patrón NUEVO que este diseño agrega — `completeReservation()` hoy no tiene ninguna lectura previa, ver §6) decide SOLO qué recurso lockear: si `preCheck.assignmentStatus === 'PENDING_ASSIGNMENT'`, lockea `preCheck.resource.id`; si no, no lockea ningún recurso. Fila de la reserva SIEMPRE después. **La decisión de invocar `assignDeferred()` — y el guard de coherencia — se toman SIEMPRE con `locked` (la lectura BAJO lock), nunca con `preCheck` (§6(b), sin excepción):** si `locked.assignmentStatus === 'ASSIGNED'` (haya visto `preCheck` lo que haya visto) → no invoca `assignDeferred()`, sigue por la rama `ASSIGNED` normal, **sin error** — cualquier lock de recurso tomado de más (porque `preCheck` vio `PENDING_ASSIGNMENT` y `locked` ya no) es inocuo. Si `locked.assignmentStatus === 'PENDING_ASSIGNMENT'` → guard: `preCheck.assignmentStatus !== 'PENDING_ASSIGNMENT' || locked.resource.id !== preCheck.resource.id` → si es verdadero, **no** invoca `assignDeferred()`, aborta con `ReservationConcurrentlyModifiedError(id, 'cambió de estado de asignación o de recurso candidato')` (409, mensaje parametrizado, Ronda 15) — el recurso correcto (`locked.resource.id`) nunca se pre-lockeó, invocar acá violaría N1; si es falso (`preCheck` vio el MISMO recurso que `locked`), `assignDeferred()` compuesta, sin locks nuevos (`isSameResource` siempre verdadero, "completar" nunca reasigna). Tabla completa de 6 casos (Ronda 15) en §6, sub-alcance "completar". |
| Auto Assign All (Fase 3) | Recurso CANDIDATO (`findAvailableResourceInCategory()`, RESUELTO — lectura sin lock, con `excludeReservationId = id` (F3-2) — ANTES de abrir la transacción de esa reserva puntual; LOCKEADO y VALIDADO con `assertAllResourcesAvailable(client, [resourceId], queuedReservation.startTime, queuedReservation.endTime, id, queuedReservation.partySize)` como PRIMERA sentencia DENTRO de esa transacción, nunca antes de abrirla — corregido F3-1, Ronda 16, mismo patrón que "completar", C-4/Ronda 15 — con validación completa, mismo mecanismo que `updateReservation()`, ver §6 Fase 3; **corregido (F3-3, gate 18): la llamada DENTRO de la transacción también pasa `excludeReservationId = id` — sin esto, un candidato que resulte ser la propia habitación provisoria de la reserva chocaría contra sí misma en la validación, aunque F3-2 ya la haya excluido en la resolución previa; corregido de nuevo (F3-5, gate 19): la llamada usa `queuedReservation` (la lectura SIN lock del batch), no `locked` (que todavía no existe en este punto), y suma `partySize` — ver §6 Fase 3 para el detalle de los 2 defectos**) → fila de la reserva. Cada reserva del batch es su propia transacción — el orden se repite por reserva, nunca se comparte lock entre dos reservas del mismo batch. |

**Pasos, en este orden (sin dependencias hacia adelante — ningún paso usa
un dato que un paso posterior todavía no calculó). Orden de locks —
invariante único (N1, Ronda 9 — reemplaza TODO el mecanismo de locks de
B1/Ronda 8: se saca el hint, se saca el lock de dos recursos, menos
piezas, no más):**

> Nunca se toma el lock de un recurso mientras ya se tiene tomada una fila
> de `reservations`. El único recurso que se bloquea en toda esta
> operación es el CANDIDATO (`resourceId`, el parámetro) — el recurso
> provisorio/actual de la reserva nunca se bloquea: o coincide con el
> candidato (`isSameResource`, cero locks de recurso NUEVOS dentro de
> `assignDeferred()` misma) o queda fuera de la operación por completo.

`assignDeferred()` no decide el orden por su cuenta — lo hereda del
CALLER, que siempre sabe, ANTES de invocarla, si tiene o no que lockear un
recurso (ver la tabla de arriba para el detalle por caller). **Corregido
en la Ronda 10:** una versión anterior de esta sección hacía depender esa
decisión de una lectura previa SIN lock que el caller comparaba contra la
relectura bajo lock de más abajo ("¿el recurso coincide o no?") — eso ya
no es así. H2 estableció que la decisión de lockear o no depende de un
hecho ESTRUCTURAL (¿esta operación va a escribir algo con FK hacia
`resources`?), no de un dato que pueda quedar desactualizado entre una
lectura y la siguiente:

- `updateReservation()` (con o sin reasignación) y "Auto Assign All"
  SIEMPRE lockean un recurso (el efectivo o el candidato, según
  corresponda) — protegen un `UPDATE` de `reservations.resource_id` que SÍ
  puede cambiar ese valor.
- Check-in SIEMPRE lockea `input.resourceId` (H2) — protege, además, el
  `INSERT` de `stays.resource_id`, que toma lock implícito de FK sin
  excepción.
- Completar (`completeReservation()`) lockea el recurso SOLO SI la lectura
  `preCheck` (SIN lock, patrón NUEVO — ver §6, corregido B-3/Ronda 13:
  `completeReservation()` no tiene hoy ninguna lectura previa a
  `requireReservationWithLock()`) encuentra la reserva
  `PENDING_ASSIGNMENT` (Hallazgo 1, Ronda 12 — corrige N2/Rondas 9-10, que
  decía "NUNCA") — no porque cambie el VALOR de `resource_id` en su propio
  `UPDATE` (nunca lo cambia, N2 seguía siendo cierto para eso), sino
  porque protege la SEGUNDA escritura de la misma fila dentro de la misma
  transacción (la de `assignDeferred()`, seguida de la propia de
  `completeReservation()`), y esa segunda escritura SÍ dispara el chequeo
  de FK aunque el valor no cambie (ver la regla de H2 corregida más
  arriba). La DECISIÓN de invocar `assignDeferred()` se toma con la
  lectura BAJO LOCK, no con `preCheck` (B-3, ver §6) — si `preCheck` ya ve
  `ASSIGNED`, no lockea ningún recurso, sin cambios.

Con esto, la reconciliación en dos ramas que describía la Ronda 9 (previa
optimista sin lock vs. relectura bajo lock, para decidir si un caller que
"pensó que no hacía falta lockear" tenía razón) **deja de ser un mecanismo
GENERAL** — la decisión de lockear ya no depende de ningún dato que pueda
estar desactualizado, así que no hay escenario en el que "el caller no
lockeó pero debería haber lockeado". Lo que SÍ sigue haciendo falta,
acotado a cada camino que específicamente lo necesita, es comparar el
RECURSO/SERVICIO contra el que un caller pre-lockeó (que si viene de una
lectura sin lock, sí puede estar desactualizado) contra la fila ya bajo
lock — `updateReservation()` ya resuelve exactamente esto con su guard de
coherencia (`resource.id`/`serviceId`, 2 campos, no 8 — re-anclado en la
Ronda 13/B-1 al mecanismo real del commit `6178d70`, ver §8) — y el rango
de fechas de "Auto Assign All" (§6, Fase 3) resuelve el caso análogo para
su propio pre-lock, cada uno declarado explícitamente en su propia
sección, sin repetir el mecanismo acá. **El caso de check-in se retiró de
esta lista en el Hallazgo 2/Ronda 12** (ver §6, sub-alcance "check-in"):
su pre-lock corregido ya no valida fechas, así que no queda ningún cálculo
hecho con datos potencialmente obsoletos que proteger con esta
comparación.

1. **Lock de la reserva** (`FOR UPDATE`, dentro de la transacción del
   caller — no-op si el caller ya la tenía lockeada, mismo mecanismo que
   `requireReservationWithLock()`). Esta lectura — `locked` — es la única
   fuente de verdad para el resto de los pasos: el `resourceId`/
   `categoryId` que la reserva tenía antes de esta operación, su
   `status`, y su `assignment_status` actual.
2. **Re-chequeo de estado bajo lock:** `locked.assignmentStatus ===
   'PENDING_ASSIGNMENT'` — si no (alguien más ya la asignó entre que se
   armó la cola/se abrió el `PUT` y que esta operación tomó el lock),
   `ReservationAlreadyAssignedError`. Este es el chequeo de concurrencia
   real: sin él, dos llamadas concurrentes sobre la misma reserva podrían
   ejecutar el resto de los pasos dos veces.
3. **Allowlist de status:** `locked.status ∈ {PENDING, CONFIRMED}` — si no
   (`CANCELLED`/`COMPLETED`/`EXPIRED`), `InvalidReservationError`.
4. **¿Es la MISMA unidad, bajo lock?** `isSameResource = resourceId ===
   locked.resource.id` — la relectura autoritativa de `assignDeferred()`
   (recalculada acá, no asumida). Para `updateReservation()`/"Auto Assign
   All", que resuelven `!isSameResource` de una lectura sin lock ANTES de
   pre-lockear (§8/§6), esta es la reconciliación con esa lectura
   optimista; para check-in, que ya lockea la fila él mismo antes de
   decidir si invoca esta operación (H2, §6), esta relectura es
   simplemente redundante con lo que el caller ya tenía — no cambia el
   resultado, solo confirma. Si **sí**
   — este es el caso más común: confirmar la habitación provisoria tal
   cual, sin cambiarla — **los pasos 5 a 8 se saltean por completo**: no
   se relee el recurso del repositorio (se usa `locked.resource` directo),
   no se valida categoría (trivialmente la misma), no se chequea `Stay`
   activa ni disponibilidad de rango (no se está reclamando inventario
   nuevo — ya se validó cuando la reserva se creó o se reasignó por
   última vez), y `isExclusiveResourceValue = locked.isExclusiveResource`
   sin recalcular. Si **no**, sigue por los pasos 5-8.
5. **(Solo si `!isSameResource`) Carga y validación del recurso nuevo:**
   `resourceRepository.getById(resourceId)` → `ResourceNotFoundError` si
   no existe, `InvalidReservationError` si `!newResource.active` (mismo
   chequeo que ya hace `updateReservation()` hoy). Carga también
   `newCategory = categoryRepository.findById(newResource.categoryId)`.
   El recurso YA está lockeado — por el pre-lock que el caller tomó antes
   de invocar esta operación (contrato de arriba) — así que esta carga es
   una lectura normal sobre una fila que la propia transacción ya tiene
   tomada.
6. **(Solo si `!isSameResource`) Restricción de categoría:**
   `newResource.categoryId !== locked.resource.categoryId` →
   `AssignmentCategoryMismatchError`. La categoría "original" se deriva
   EN VIVO de `locked.resource.categoryId` — si alguien cambia la
   categoría del recurso provisorio después de que la reserva ya lo tiene
   (`PUT /resources`), esta restricción compara contra la categoría
   ACTUAL del recurso, no la que tenía al crearse la reserva. No se
   resuelve con un snapshot nuevo acá — asunción declarada, no un bug.
   Un cambio real de categoría (upgrade/downgrade) queda explícitamente
   fuera de alcance de 4.3.
7. **(Solo si `!isSameResource`) Filtro de `Stay` activa en el recurso
   candidato.** La tabla `stays` **no tiene columnas de rango de fechas**
   (solo `checked_in_at`/`checked_out_at`/`status`, `schema.sql:2111-2131`)
   — "una `Stay` cuyo rango se superpone" no es un predicado que el
   schema soporte. Se usa, en cambio, el predicado que el check-in YA usa
   hoy para este mismo propósito:
   `stayRepository.findActiveByResource(resourceId, businessId)`
   (`stay.repository.ts:118-125` — `status = 'CHECKED_IN'`, sin filtro de
   fechas, `LIMIT 1`). Si devuelve una `Stay` y esa `Stay` no pertenece a
   la propia reserva que se está asignando (`stay.reservationId !==
   locked.id` — exclusión explícita, para no rechazar una reserva contra
   su propio check-in ya existente), rechaza con `ResourceOccupiedError`
   — el error que **ya existe** para este propósito
   (`pms-estadias/stay.service.ts:71`, código `RESOURCE_OCCUPIED`, hoy
   usado por `checkIn()`); no se inventa uno nuevo.

   **Dependencia nueva que esto introduce:** el módulo `reservas` (donde
   vive `assignDeferred()`) pasa a necesitar `StayRepository`. Esto **ya
   tiene precedente en este mismo archivo**: `reservation.service.ts`
   línea 83 (corregido, C-1, Ronda 14 — decía "82") ya importa
   `MaintenanceWindowRepository` desde
   `'../pms-estadias/maintenance-window.repository.js'`, y ese archivo no
   importa nada de `reservas` — mismo patrón, sin ciclo. Verificado en
   código: `stay.repository.ts` importa solo `sql.client.js` y `stay.js`;
   `stay.js` importa solo `node:crypto`, `domain/errors.js` y
   `housekeeping-task.js` — ninguno de los dos importa nada de `reservas`.
   Inyectar `StayRepository` (la interfaz, acotada con `Pick<StayRepository,
   'findActiveByResource'>`, mismo patrón ya usado en
   `reservation-cancel-for-credit-note.ts`) en `ReservationService` no crea
   un ciclo, porque no pasa por `stay.service.ts`.

   **Riesgo de ciclo real que SÍ existe, y que este documento no puede
   resolver reusando el error tal cual está hoy:** `ResourceOccupiedError`
   está definido DENTRO de `pms-estadias/stay.service.ts` (línea 71), no en
   `domain/errors.ts`. Si `assignDeferred()` importara ese error
   directamente de `stay.service.ts`, se formaría el ciclo que este mismo
   punto busca evitar: `stay.service.ts` ya importa
   `reservas/reservation.service.js` (línea 46, `combineDateAndTime`), así
   que `reservation.service.ts → stay.service.ts → reservation.service.ts`
   cerraría el ciclo, bloqueado por la regla `no-circular` de
   `.dependency-cruiser.cjs` (línea 44, `tsPreCompilationDeps: true`, línea
   139). **Resolución:** relocar `ResourceOccupiedError` de
   `stay.service.ts` a `domain/errors.ts` — donde ya viven los ~100 errores
   de dominio de este repo (`InvalidReservationError`,
   `ReservationNotFoundError`, etc.) — y que `stay.service.ts` lo importe
   de ahí en vez de definirlo localmente. Es un cambio chico (mover una
   clase, actualizar un import) y alinea `ResourceOccupiedError` con la
   convención que el resto del repo ya sigue; no es una decisión de
   diseño nueva, es remover la única excepción a un patrón ya establecido.

   **Limitación de concurrencia declarada, no resuelta.** El pre-lock que
   el caller toma (contrato de arriba, N1) SÍ cierra la carrera contra
   otra operación que también pase por el mismo protocolo
   (`assignDeferred()`/`createReservation()`, que también lockean el
   recurso candidato antes que su fila). Lo que **no** cierra es la
   carrera contra un check-in CONCURRENTE de OTRA reserva sobre el MISMO
   recurso candidato: la lectura de este mismo paso (`findActiveByResource()`)
   corre por `this.db` — el pool inyectado por constructor de
   `SqlStayRepository`, no el `client` transaccional (`stay.repository.ts:118-125`,
   verificado en código) — así que no está bajo el lock/la conexión de
   esta transacción, y bloquear la fila de `resources` no bloquea ni
   serializa contra la tabla `stays` (son tablas distintas, sin relación
   de lock entre ellas). Ventana de carrera conocida y aceptada (baja
   probabilidad en la práctica) — no se resuelve con un lock más amplio
   ni haciendo que el check-in tome el mismo lock por sí solo alcanzaría
   (el `INSERT` en `stays` seguiría sin pasar por una lectura que
   `assignDeferred()` pueda ver bajo el mismo lock); ampliar esto excede
   el alcance de 4.3.
8. **(Solo si `!isSameResource`) Re-chequeo de disponibilidad + snapshot
   condicional.** `assertAllResourcesAvailable(client, [resourceId],
   locked.startTime, locked.endTime, locked.id, locked.partySize)` —
   `locked.id` como `excludeReservationId` (firma ya existente,
   `reservation-availability.service.ts:297`) excluye la propia reserva de
   la comparación, para que no "choque contra sí misma". Esta llamada
   vuelve a lockear `resourceId` vía su propio `lockByIds()` interno — el
   MISMO recurso que el pre-lock del caller ya lockeó (contrato de arriba)
   — o, si por algún motivo llegó sin ese pre-lock, lo lockea acá por
   primera vez, sin diferencia funcional. Postgres permite tomar `FOR
   UPDATE` dos veces sobre la misma fila dentro de la misma transacción
   sin esperar (no-op, no genera deadlock — mismo criterio que el lock
   doble de la fila de la reserva entre `updateReservation()` y
   `assignDeferred()`, ver más abajo). Si pasa, se calcula
   `isExclusiveResourceValue = newCategory?.isExclusive ?? false` y se
   marca que el paso 10 debe llamar `clearNeedsMaintenanceReview()`
   sobre la entidad resultante (D-03: "se apaga SOLO cuando la reserva se
   reasigna a OTRO recurso" — cumplido, este paso solo corre cuando
   `!isSameResource`).
9. **No-recotización:** paso puramente declarativo, no hay ningún cálculo
   de precio que hacer ni saltear acá. Si la llamada intentó combinar
   fechas/`ratePlanId` con la confirmación, eso ya se rechazó ANTES de
   llegar a invocar `assignDeferred()` (responsabilidad del caller — ver
   "`updateReservation()` en relación con `assignDeferred()`" más abajo).
10. **La escritura real:** `locked.assignConcreteResource(resource,
    isExclusiveResourceValue)` — donde `resource` es `locked.resource` si
    `isSameResource`, o `newResource` (cargado en el paso 5) si no — → `updated`.
    Si el paso 8 corrió y determinó reasignación real, `updated.clearNeedsMaintenanceReview()`
    ANTES de guardar. `this.reservationRepository.saveWithClient(client, updated)`
    — el mismo método `WithClient` que ya usa `updateReservation()`. Este
    es el único punto donde `assignment_status` cambia de valor de verdad.
11. **Auditoría de la transición** (A6.5 más abajo) —
    `recordFieldChangesWithClient()` dentro de la misma transacción, con
    `{ field: 'assignmentStatus', oldValue: 'PENDING_ASSIGNMENT', newValue:
    'ASSIGNED' }` y, en el mismo `changes[]`, `resourceId` viejo
    (`locked.resource.id`) → nuevo (`updated.resource.id`).

**Registro de ocupación — declarado explícitamente afuera de esta lista.**
`assignDeferred()` **no** llama a `recordOccupancy()` (motivo completo en
la fila de `recordOccupancy()` en §7: `SqlOccupancyRepository` no tiene
variante `WithClient`). Cada uno de sus 4 callers lo hace por su
cuenta, DESPUÉS de que su propia transacción (la que envuelve la llamada a
`assignDeferred()`) haga commit exitosamente. Este documento no lo cuenta
como "paso 12" a propósito, para no sugerir que es parte de la operación
transaccional — es, deliberadamente, responsabilidad del caller.

**Esta operación no emite ningún evento de dominio** — a diferencia de
`confirmReservation()`/`cancelReservation()`/`completeReservation()`, que sí
insertan en `domain_events` dentro de la misma transacción. Si esto es una
omisión real que valga la pena resolver queda señalado como hallazgo aparte
para una ronda futura — no se resuelve ni se diseña acá.

**Precisión de implementación — qué SQL toca este cambio, qué no.**
`sql.reservation.repository.ts::saveWithClient()` usa un único `INSERT ...
ON CONFLICT (id) DO UPDATE SET` compartido por TODOS los callers. La
columna `assignment_status` va a aparecer en ese `SET`, igual que el resto
de las columnas — no se la excluye del SQL. Lo que garantiza que "el UPSERT
normal nunca la cambia" no es una columna ausente del SQL: es que el VALOR
que se escribe es el mismo que ya estaba. De los 13 callers reales de
`saveWithClient()` sobre `reservations`
(`createReservation()`/`updateReservation()`/`confirmReservation()`/
`confirmPriceAdjustment()`, `assignDeferred()` una vez que exista, y otros
8 verificados con grep — `cancelReservation()`, `completeReservation()`,
`stay.service.ts::requestScheduleChange()`/`rejectScheduleChange()`/
`approveScheduleChange()`, `maintenance-window.service.ts:164`,
`reservation-cancel-for-credit-note.ts:109`,
`reservation-hold-expiry.worker.ts:122`), **el único que cambia
`assignmentStatus` en memoria antes de guardar es `assignDeferred()`**, vía
`assignConcreteResource()` (paso 10). Los otros 12 leen la entidad ya
hidratada (que a su vez pasó una sola vez por `restore()`, al leer) y solo
mutan otro campo (`.cancel()`, `.complete()`, etc.) antes de
`saveWithClient()` — nunca tocan `assignmentStatus`, así que PARA EL VALOR
QUE ESCRIBEN, la escritura de esa columna es un no-op semántico.
**Excepción declarada (B4, corregido):** esto es cierto para 11 de esos 12
— para `completeReservation()` específicamente, cuando la reserva sigue
`PENDING_ASSIGNMENT` al completarse, el método SÍ termina guardando una
entidad con `assignmentStatus` ya cambiado — pero porque usa la entidad
que le devuelve `assignDeferred()` (que ella sí pasó por
`assignConcreteResource()`), no porque `completeReservation()` la mute
directamente. Ver §6, sub-alcance "completar confirma la asignación".
**Segunda excepción, distinta, declarada (N3, Ronda 9 — re-caracterizada en
la Ronda 13/B-1 tras el commit `6178d70`):** "no-op semántico" describe el
VALOR escrito, no la SEGURIDAD de la escritura — `maintenance-window.service.ts::createWindow()`
es, de estos 12, el que lee la fila SIN lock y FUERA de cualquier
transacción antes de este UPSERT — así que puede pisar una transición
concurrente ajena con un snapshot viejo aunque el VALOR de
`assignmentStatus` que reescribe sea, en sí, el mismo que leyó. **Entre la
Ronda 10 y el 24/09/2026 esto se describía como "uno de, al menos, dos"
(el otro era `updateReservation()`, con el mismo patrón, hallazgo
`UPDATE-RESERVATION-LOST-STATUS-001`) — ya no es así: ese hallazgo se
resolvió y commiteó en `6178d70`, así que `createWindow()` vuelve a ser el
único escritor real de `reservations` con este patrón** (ver la fila de §7
y el prerrequisito de Fase 2 en §6, ambos actualizados en esta misma
ronda).

### A6.2 — `allowedTransitions[]` en el DTO

`Reservation.status` ya expone `ALLOWED_TRANSITIONS`
(`Reservation.ts:78`/`:361`) y `ReservationDto.allowedTransitions`
(`reservation.mapper.ts`, ~línea 121) ya lo sirve, consumido por el
frontend. Para `assignment_status` — una máquina de dos estados con una
sola arista (`PENDING_ASSIGNMENT → ['ASSIGNED']`, `ASSIGNED → []`) — el
frontend no necesita preguntarle al backend qué transiciones existen: es
**N/A justificado**, con dos condiciones que si dejan de cumplirse
invalidan el N/A: (1) si se agrega un tercer estado, revisar esta
decisión; (2) el equivalente de "mostrar el botón Asignar" no vale para
una reserva con `status` terminal — la cola de Fase 2 y "Auto Assign All"
de Fase 3 solo miran reservas con `status IN ('PENDING', 'CONFIRMED')`
(allowlist, no denylist — mismo criterio que `updateReservation()`), y
`assignDeferred()` (paso 3) lanza error tipado fuera de ese conjunto. **Una
reserva `CANCELLED` o `EXPIRED` puede quedar con `assignment_status =
'PENDING_ASSIGNMENT'` para siempre, sin que eso dispare ninguna acción —
es inocuo, esa reserva nunca reclamó ni va a reclamar inventario real.
Una reserva `COMPLETED` no puede: `completeReservation()` siempre resuelve
la `PENDING_ASSIGNMENT` antes de completar (§6, sub-alcance "completar").**
Si en el futuro se implementa `allowedTransitions[]` para esta máquina,
necesita un nombre propio (`assignmentAllowedTransitions` o similar) — el
nombre ya está tomado por la de `status` en el mismo DTO.

### A6.3 — Toda transición inválida lanza error tipado

Dos caminos posibles para reasignar una reserva que YA está `ASSIGNED`:
(a) el `PUT` de reasignación normal (drag-to-move,
`reservation.service.ts::updateReservation()`, líneas 547-557/568 —
re-verificado post-commit `6178d70`, C-2) sigue funcionando igual que
hoy — no pasa por el camino de asignación diferida en absoluto; (b) lo que SÍ debe
fallar con error tipado es específicamente el camino de asignación
diferida — `ReservationAlreadyAssignedError` (paso 2 de `assignDeferred()`)
si, entre que se armó la cola/se abrió el `PUT` y que la operación tomó el
lock, alguien ya asignó la reserva.

**Restricción de categoría.** Segundo caso: reasignar una reserva
`PENDING_ASSIGNMENT` — por cualquiera de los 4 caminos — a un recurso que
NO pertenece a la MISMA categoría, rechaza con
`AssignmentCategoryMismatchError` (paso 6 de `assignDeferred()`, heredado
por los 4 caminos sin repetirla). Un cambio real de categoría
(upgrade/downgrade) queda explícitamente fuera de alcance de 4.3. La
reasignación normal de una reserva que YA está `ASSIGNED` (caso (a), fuera
del mecanismo de asignación diferida) **no** tiene esta restricción — sigue
permitiendo cambiar de categoría como hoy.

### `updateReservation()` en relación con `assignDeferred()`

**Reescrita por completo en la Ronda 13 (B-1) — la versión anterior de
esta sección describía un mecanismo que el commit real (`6178d70`) no
implementa.** Lo que sigue es el mecanismo REAL de `updateReservation()`
post-commit (re-derivado con `grep -n`/`sed -n`, no asumido — C-2), con el
punto exacto donde compone 4.3.

`updateReservation()` (PUT) es el único de los 4 callers de
`assignDeferred()` que también puede traer cambios AJENOS a la asignación
(`details`/`adultos`/`ninos`, o fechas/`ratePlanId` cuando no vienen
combinados con `resourceId`). Por eso necesita su propio algoritmo, no
solo "invocar `assignDeferred()` y listo":

**Requisito de implementación, consecuencia directa de C1:**
`updateReservation(id, changes)` no recibe `businessId` hoy (verificado en
código: la firma empieza en `reservation.service.ts:406`) — a diferencia
de `confirmReservation()`/`completeReservation()`, que sí lo reciben. Para
poder llamar a `assignDeferred(client, id, changes.resourceId, businessId,
changedBy)` en el discriminador de abajo, `updateReservation()` gana un
parámetro `businessId: string` nuevo en su firma, sourceado en la ruta
desde `req.user!.businessId` — mismo patrón que ya usa el bloque de
`confirmReservation()` en `reservations.routes.ts` (línea 492). El PUT del
portal de clientes (`customer.routes.ts::PATCH /me/reservations/:id` —
cita por símbolo, no por línea, C-c) también necesita pasarlo, desde el
`businessId` que ya resuelve para sus otras llamadas de este mismo archivo
(mismo patrón que ya usa `POST /me/reservations/:id/cancel`,
`const businessId = req.user!.businessId!;`, también citado por símbolo).

**El mecanismo real, tal como existe hoy (sin nada de 4.3 todavía), en 7
pasos — mismo detalle ya establecido en §6, repetido acá porque esta
sección es donde se ancla el punto de composición:**

1. `preCheck = this.requireReservation(id)` (línea 439) — SIN lock, 404
   barato; su resultado se reusa para decidir `effectiveResourceId`.
2. `effectiveResourceId = changes.resourceId ?? preCheck.resource.id` →
   `lockSet` → `resourceRepository.lockByIds(...)` (líneas 463-468) — lock
   del recurso candidato, PRIMERO.
3. `existing = requireReservationWithLock(client, id)` (línea 493) — lock
   de la fila, SEGUNDO.
4. Guard de coherencia — `existing.resource.id !== preCheck.resource.id
   || existing.serviceId !== preCheck.serviceId` →
   `ReservationConcurrentlyModifiedError` (líneas 505-507) — SOLO 2
   campos.
5. Guard de status — `existing.status ∈ {PENDING, CONFIRMED}` (líneas
   518-522).
6. Resolución del recurso efectivo (reasignación manual, líneas 547-557),
   categoría (559-562), `reassigned`/`isExclusiveResource` (564-571),
   `lockedResourceIds` (573-578), `resolvePrice()` DENTRO de la
   transacción si `existing.status === 'PENDING'` (líneas 593/597-606),
   `assertAllResourcesAvailable()` como re-lock + validación de overlap
   (líneas 622-629).
7. `Reservation.restore()` (línea 631), `clearNeedsMaintenanceReview()` si
   `reassigned` (698-700), `saveWithClient()` (línea 702).

**Discriminador de 4.3 — se inserta ENTRE el paso 5 (guard de status) y el
paso 6 (resolución de recurso/categoría/precio), en el mismo punto donde
el código real hoy empieza `let resource = existing.resource; if
(changes.resourceId && changes.resourceId !== existing.resource.id) {
... }` (línea 547).** A diferencia del mecanismo que este documento
describía hasta la Ronda 12, acá no hay ningún "precio candidato"
calculado todavía — el paso 6 real (que incluye `resolvePrice()`) corre
DESPUÉS del punto de inserción, así que no hay nada que descartar si el
discriminador decide desviarse:

- Si `existing.assignmentStatus === 'PENDING_ASSIGNMENT'` Y
  `changes.resourceId` fue provisto Y hay un cambio real de fechas,
  `ratePlanId`, **`details`, `adultos` o `ninos` (D-2, Ronda 14, decisión
  del dueño vía `AskUserQuestion` — extiende este mismo rechazo, mismo
  error, mismo criterio de detección, a estos 3 campos)**
  (`changes.startTime`/`changes.endTime`/`changes.ratePlanId`/`changes.details`/
  `changes.adultos`/`changes.ninos`, cuando vienen en el body, DIFIEREN por
  VALOR de `existing.startTime`/`existing.endTime`/`existing.ratePlanId`/
  `existing.details`/`existing.adultos`/`existing.ninos` — no por mera
  presencia del campo.

  **Corregida (B-3, Ronda 15) — la premisa "el formulario de staff manda
  estos campos en cada `PUT`" era falsa, verificado por el gate contra
  `appfrontend`:** `reservas/[id]/page.tsx::handleUpdateDetail` manda
  `startTime`/`endTime`/`adultos`/`ninos` SIN `details` ni `resourceId`;
  el arrastre del calendario manda `startTime`/`endTime`/`resourceId` SIN
  `details`. La razón real para comparar por VALOR y no por presencia no
  depende de qué mande este frontend en particular — es más simple y
  general: un campo AUSENTE del body (`undefined`) nunca puede ser, por
  definición, un "cambio real" que rechazar, porque no hay ningún valor
  nuevo que comparar contra `existing`. Comparar por presencia rechazaría
  cualquier `PUT` que reenvíe un campo sin cambiarlo, sea cual sea el
  caller — el criterio por VALOR es la única forma correcta de detectar
  "¿este campo realmente cambió?", con cualquier frontend presente o
  futuro.

  **Semántica `null` vs. `undefined`, declarada explícitamente (B-3,
  Ronda 15).** `adultos`/`ninos`/`ratePlanId` son `T | null | undefined`
  en la firma real de `changes` (`reservation.service.ts:406-417`,
  re-derivado con `grep -n` contra el archivo real) — `undefined`
  significa "el campo no vino en el body, no evaluar" (se excluye de la
  comparación, mismo criterio que `diffFields()` excluye `newValue ===
  undefined`, `domain/audit.ts:41`); `null` EXPLÍCITO significa "el body
  pide limpiar este campo" y SÍ participa de la comparación — si
  `existing.adultos !== null` y `changes.adultos === null`, es un cambio
  real (limpiar un valor ya cargado), cuenta para el rechazo.
  `startTime`/`endTime`/`details` son `T | undefined` (sin `null` en el
  tipo, verificado) — solo `undefined` (ausente) vs. presente aplica, no
  hay caso `null` que distinguir para estos tres.

  **Comparación estructural, NO `JSON.stringify()` (B-3, Ronda 15 —
  corrige a la Ronda 13/14, que proponía `JSON.stringify()`).** `details`
  es `JSONB` (`schema.sql:470`, re-verificado con `grep -n` — no `:469`
  como se había citado antes de re-derivarlo) y Postgres puede reordenar
  las claves al persistir — `JSON.stringify(a) !== JSON.stringify(b)`
  puede dar un falso positivo (dos objetos estructuralmente idénticos,
  con las claves en otro orden, se leen como "distintos") y rechazar con
  `AssignmentCombinedChangeError` una edición que en realidad no cambia
  nada. **`diffFields()` (`domain/audit.ts:44`) comparte exactamente esta
  misma fragilidad — no es un precedente seguro para copiar acá tal
  cual:** usa el mismo `JSON.stringify(oldValue) === JSON.stringify(newValue)`
  (`domain/audit.ts:44`, verificado), así que hereda el mismo riesgo de
  falso positivo contra un `details` reordenado por Postgres — corregirlo
  ahí queda fuera del alcance de 4.3 (afecta a `diffFields()` en general,
  no solo a este discriminador), señalado acá como hallazgo colateral, no
  resuelto. Para el discriminador de 4.3, la comparación de `details` usa
  una función de igualdad estructural nueva, local a este punto (no existe
  ningún `deepEqual` ya compartido en el repo, verificado — `grep -rn
  "deepEqual\|isEqual(" src/`, sin resultados), insensible al orden de
  claves en cualquier nivel de anidamiento: serializar cada valor con las
  claves de cada objeto ORDENADAS alfabéticamente antes de comparar
  (`stableStringify()`, recursivo sobre objetos/arrays/primitivos) — dos
  objetos con las mismas claves/valores en cualquier orden serializan
  IGUAL, sin depender de qué orden haya elegido Postgres al persistir.
  `startTime`/`endTime` comparan con `.getTime()` — nunca por referencia
  de objeto `Date` (siempre distinta entre dos instancias) ni por
  `.toString()`/`.toISOString()` (formato variable entre husos/locales).
  `adultos`/`ninos`/`ratePlanId` (valores primitivos u `null`) comparan
  con `!==` directo, sin necesidad de serializar nada.

  → `AssignmentCombinedChangeError`. **Por qué se
  extiende al MISMO error, no uno nuevo:** el dueño ya había resuelto el
  caso fecha/`ratePlanId` con este criterio (rechazar, forzar dos
  operaciones separadas) — combinar `resourceId` con un cambio real de
  `details`/`adultos`/`ninos` es la MISMA pregunta de negocio con la MISMA
  respuesta ("no combinar la confirmación de una asignación diferida con
  ningún otro cambio de la reserva"), no una decisión distinta que
  necesite su propio tipo de error.
  Rechazo total e inmediato, sin ejecutar el paso 6 en absoluto — ningún
  cálculo de precio llegó a hacerse todavía, así que no hay nada que
  deshacer (a diferencia de la Ronda 12, que necesitaba descartar
  explícitamente un precio ya calculado afuera de la transacción). Se hace
  en dos pasos separados (primero cambiar fechas/tarifa/detalles/huéspedes
  con el recurso provisorio — recotiza normalmente si `PENDING`, con su
  propia recotización de una llamada `PUT` distinta —, después confirmar
  la asignación sin más cambios). **Callejón sin salida, declarado y
  aceptado:** si el recurso provisorio está ocupado en las fechas nuevas y
  el recurso destino no está libre en las fechas viejas, ningún camino de
  dos pasos funciona por separado — el staff cancela y recrea la reserva.
- Si `existing.assignmentStatus === 'PENDING_ASSIGNMENT'` Y
  `changes.resourceId` fue provisto (sin el combo de arriba) → `updated =
  await this.assignDeferred(client, id, changes.resourceId, businessId,
  changedBy)`, **en vez de** la resolución manual de recurso de la línea
  547 — mismo `resourceId` que ya tiene (confirma tal cual) o distinto
  (reasigna), ambos casos los resuelve `assignDeferred()` (su propio paso
  4, `isSameResource`). El recurso candidato YA está lockeado desde el
  paso 2 real (`effectiveResourceId` es exactamente `changes.resourceId`
  en esta rama), así que `assignDeferred()` no necesita ningún pre-lock
  propio acá — su paso 1 (lock de la fila) y, si corresponde reasignación
  real, su paso 8 (re-chequeo de disponibilidad, que re-lockea el recurso)
  son no-ops sobre locks que esta transacción ya tiene desde los pasos 2-3
  reales de arriba, sin deadlock. `assignDeferred()` ya persistió esta
  reserva (su propio paso 10). **Corregido (D-2, Ronda 14) — la única
  forma de llegar acá con OTROS campos en el body es que ninguno haya
  cambiado por VALOR** (el bullet de arriba ya rechazó cualquier
  combinación con un cambio real): si el `PUT` no traía ningún otro campo,
  o los traía pero sin diferir de `existing` (reenvío no-op, mismo
  criterio que el resto del documento), el resto del método (pasos 6-7
  reales, líneas 559-702) se saltea por completo — **antes de esta ronda,
  este bullet describía un camino donde "otros cambios" SÍ podían llegar
  acá y seguir el pipeline normal; ese camino ya no existe: D-2 lo
  intercepta en el bullet de arriba.** No queda ningún caso real en que
  `updated` (la entidad que devolvió `assignDeferred()`) necesite servir
  de base para un recálculo posterior de categoría/precio/disponibilidad
  dentro de este mismo `PUT` — si tal recálculo hiciera falta, la entidad
  correcta a partir de la cual construirlo seguiría siendo `updated`, no
  `existing`/`preCheck` (mismo criterio que "completar", B4, §6), pero en
  la práctica esa rama queda inalcanzable tras D-2.
- En cualquier otro caso (reserva ya `ASSIGNED`, o `PENDING_ASSIGNMENT`
  sin `resourceId` en el `PUT`) → el camino de hoy, sin cambios: los pasos
  6-7 reales (líneas 547-702) corren tal cual, con
  `existing.assignmentStatus` reenviado sin tocar (`Reservation.restore()`
  lo recibe como campo obligatorio, sin default, Fase 1).

**Después de que la transacción haga commit:** `recordOccupancy()` se
llama **solo** en la rama que invocó `assignDeferred()` y que efectivamente
transicionó `PENDING_ASSIGNMENT → ASSIGNED` en esta operación — nunca en
la rama normal (un drag-to-move de una reserva que ya estaba `ASSIGNED` no
tiene que volver a sumar ocupación).

### D-1 — Congelar el componente de precio del recurso: cerrado como no-op estructural, con test de regresión (Ronda 16, revierte D-1')

**Decisión final del dueño (vía `AskUserQuestion`, 25/09/2026, sobre la
contradicción que encontró el gate de la Ronda 16): "No construir nada
aún, solo un test de regresión."** Revierte D-1' (Ronda 15 — persistir
`priced_with_resource_id`) y, con ella, también D-1 original (Ronda 14 —
el booleano `resource_price_frozen`, ya descartado desde la Ronda 15).
Ninguna de las dos versiones se construye. Esta subsección reemplaza por
completo a la "D-1'" de la Ronda 15 — no queda ningún DDL, ningún punto de
escritura, ni ninguna columna nueva de este diseño.

**Por qué se revierte — la columna de D-1' era matemáticamente redundante
con `resource_id` (hallazgo del gate de la Ronda 16).** Combinando las
dos decisiones previas del dueño sobre D-1' — (a) "congelamiento real
ahora" (persistir el recurso, Ronda 15) y (b) la sub-pregunta resuelta en
el mismo turno, "se actualiza en cada reasignación posterior" (punto 4 de
la versión de la Ronda 15 de esta misma subsección, ver Anexo) — la
columna terminaba SIEMPRE igual a `resource_id`: se seteaba al mismo valor
que `resource.id` en el momento de `assignConcreteResource()` y, de ahí en
más, cualquier cambio de `resource_id` (la única vía real, la reasignación
normal de `updateReservation()`, caso (a) de A6.3) la actualizaba AL
MISMO VALOR nuevo en el mismo movimiento. Un campo que se mueve en
lockstep con el que supuestamente "congela" no puede, por construcción,
quedar nunca desincronizado de él — nunca guarda un valor DISTINTO del
`resource_id` vigente, así que no protege nada que `resource_id` no
exponga ya. El propósito original de "congelar" — preservar CUÁL fue el
recurso con el que se cotizó, distinto del que la reserva pueda tener más
tarde — quedaba, en la práctica, anulado por la propia regla de
actualización que el dueño había pedido para la misma decisión.

**Dos bugs adicionales que el gate encontró en el diseño de la columna
(T-1, T-2) — quedan sin resolver, porque la columna no se construye.**
Registrados acá solo para que no se pierdan si esta decisión se revisita
en el futuro: **T-1** — el pseudocódigo normativo de A6.1 (paso 10,
`assignConcreteResource()`) no contemplaba un cuarto punto de escritura
para la primera asignación — la versión de la Ronda 15 lo agregaba por
fuera de ese pseudocódigo, sin que el test de preservación de campos de
A6.1 lo hubiera cubierto; correrlo tal cual estaba habría roto ese test.
**T-2** — la garantía "falla visible si falta la columna" (versión de la
Ronda 15, "sin `??`, columna faltante = error de tipo/mapeo") era falsa en
la práctica: `buildReservation()` no tiene ningún guard real que convierta
una columna ausente en un error — sin la columna, `row.priced_with_resource_id`
es simplemente `undefined` en runtime, y que el tipo declarado sea
`string | null` sin `?` no lo rechaza en tiempo de ejecución. Ninguno de
los dos se arregla acá — no hace falta, la columna no se construye.

**Verificación, tres veces (Ronda 14, la reconfirmación de la Ronda 15/B-2
y este gate — corregido, condición menor del gate 18: decía "dos veces",
omitiendo la reconfirmación de la Ronda 15, ver Anexo) — el hallazgo de
fondo no cambió, y no es casualidad del código actual: es una DECISIÓN DE
PRODUCTO
ya tomada (G-2.1, gate 18).** `docs/diseno-precio-servicio-vs-recurso-2026-08-27.md`
es la decisión de origen del dueño (27/08/2026): *"Te cobro la estadía, no
la habitación"* — el recurso HABILITA, el servicio es lo que se vende y lo
que se cobra; el recurso puede tener noción de costo, nunca de precio de
venta. Esa decisión es la que `reservation.service.ts:287`
(`LodgingRequiresServiceError`, verificado) hace cumplir estructuralmente
— toda reserva de alojamiento entra con `serviceId`, sin excepción, por
eso mismo motivo, no por casualidad de cómo quedó escrito
`resolveUnitPrice()`. D-1 no es un no-op porque el código de hoy no
produzca una divergencia (aunque, medido, tampoco la produce) — es un
no-op porque el dueño ya decidió que el recurso NUNCA debe fijar precio de
alojamiento, así que "congelar qué recurso se usó para cotizar" estaría
protegiendo algo que la regla de negocio prohíbe que exista en primer
lugar. El test de regresión de abajo existe para blindar ESA decisión, no
solo el estado actual del código.

Verificado contra
`reservation-pricing.service.ts::resolveUnitPrice()` (líneas 159-242, no
148-240 como decía la Ronda 14 — la función se corrió ~11 líneas por
cambios de otro bloque): toda reserva de alojamiento **SIEMPRE** tiene
`serviceId` así que SIEMPRE entra por la rama
`if (params.serviceId)` (línea 169, no 168 — re-derivado con `grep -n`) —
y esa rama tiene **3 sub-ramas, cada una con su propio `return`**
(re-derivadas con `grep -n`/`sed -n` contra el código real, gate 18):
(i) tarifa especial cliente+servicio (`findActiveForCustomerAndService()`,
línea 175, `% aplicado contra requireServicePrice()`, línea 190); (ii)
tarifa elegida `ratePlanId` (línea 194, `findRatePlanById()` +
`resolveSeasonalPrice()`); (iii) precio de catálogo del servicio (línea
222, `params.service.price`) — sin llegar NUNCA al fallback (líneas
228-241), que es el único tramo de la función que lee
`resourceId`/`resource.basePrice`. Consecuencia verificada: para una
reserva de alojamiento, `resolvePrice()` devuelve el mismo
`totalPrice`/`lines` sin importar CUÁL recurso puntual, dentro de la MISMA
categoría y con el MISMO `serviceId`, se le pase como `resourceId` — el
precio vive enteramente en el servicio, no en la unidad física. El
parámetro `resourceId` de `resolvePrice()` sigue existiendo porque la
función también sirve a TURNOS (categorías sin `is_lodging`, donde
`serviceId` puede faltar y el fallback SÍ aplica) — mismo `resolvePrice()`,
dos usos con comportamiento distinto según el rubro. No hay, hoy, ningún
valor que "congelar" — no porque no importe conceptualmente, sino porque
el código real no produce ninguna divergencia que proteger.

**Lo que se agrega en su lugar: un test de regresión, alcance de
implementación de Fase 2 (no de Fase 1) — mismo punto del documento que
antes agregaba la columna (§6, Fase 2, ítem 9).**

Objetivo del test: que falle el día que `resolveUnitPrice()` (o el método
que en ese momento resuelva el componente de precio de una reserva de
alojamiento con servicio) empiece a leer `resourceId`/`resource.basePrice`
para ese cálculo — forzando, en ese momento, a retomar el diseño de
"congelar qué recurso se usó para cotizar" en vez de dejarlo pasar en
silencio.

**Dónde vive el test — archivo nuevo, no extensión del bloque existente
(G-2.2, gate 18, decisión justificada).** `reservation.service.test.ts`
YA tiene dos tests que actúan como cerca parcial de este mismo hallazgo
(`:1932` y `:1990` en versiones anteriores de este archivo — re-derivar
con `grep -n "D9-Parte 1"` antes de citar línea, el archivo se mueve con
cada bloque; los 19 tests de ese `describe` pasan hoy, verificado por el
gate), pero los dos construyen un `ReservationService` COMPLETO a mano
(18 dependencias — el test `:1932` incluso instancia una SEGUNDA copia
completa del servicio, `lodgingService`, solo para tener un
`ICategoryRepository` con `isLodging: true`) y cotizan pasando por
`createReservation()` entero — locks, `TransactionManager`,
disponibilidad, persistencia in-memory. Ninguno de los dos aísla
`ReservationPricingService`, y ninguno varía el `resourceId` manteniendo
todo lo demás fijo (que es, específicamente, lo que este test necesita
probar). Extender ese bloque para agregar la variación por recurso
significaría instanciar una TERCERA copia del `ReservationService`
completo (o reusar `lodgingService`) solo para leer `reservation.totalPrice`
al final — máximo aislamiento necesario, mínimo aprovechado.
`ReservationPricingService` en cambio tiene 3-4 dependencias por
constructor (`ICustomerRateRepository`, `IBookableServiceRepository`,
`ICategoryRepository`, `IDepositPolicyRepository` opcional — verificado
contra la clase real) y su `resolvePrice()` no toca locks ni transacción:
construirlo y llamarlo directo es estrictamente más simple para EXACTAMENTE
lo que este test necesita (variar `resourceId`/`resource` manteniendo el
resto constante), sin sacrificar cobertura — los 19 tests existentes
siguen siendo la cerca de "el precio de alojamiento entra por la rama de
servicio" a nivel `ReservationService`; este test nuevo es la cerca de "el
precio de alojamiento NO varía por `resourceId`" a nivel
`ReservationPricingService`, una capa más abajo y más barata de correr.
Archivo nuevo: `src/reservas/reservation-pricing.service.test.ts` (no
existe hoy — verificado con `find`/`grep`, ningún test unitario está
dedicado a esta clase todavía, pese a que su propio docblock menciona
"tests unitarios de la cascada de precio"; este sería el primero).

Fixtures — mismo tipo de fixtures in-memory que ya usa
`reservation.service.test.ts` para sus propios repos:
`InMemoryCustomerRateRepository`, **`InMemoryBookableServiceRepository`
(agregado, G-2.5, gate 18 — la versión anterior de este diseño no la
listaba; hace falta para sembrar el `RatePlan` de la sub-rama (ii) vía su
método real `seedRatePlan()`, verificado contra la clase)**, un
`ICategoryRepository` mínimo con `isLodging: true`, un objeto
`BookableService` armado a mano.

**Parametrizado sobre las 3 sub-ramas reales (G-2.3, gate 18) — la versión
anterior de este diseño solo cubría la sub-rama (iii).** La regresión más
probable que esa versión NO detectaba: una tarifa especial cliente+servicio
con % de descuento (sub-rama (i)) que empezara a calcular su porcentaje
sobre `resource.basePrice` en vez de sobre `requireServicePrice()` (línea
real ~190) — bug que la sub-rama (iii), sin ninguna `CustomerRate`
sembrada, nunca ejercita. Tres casos (`it.each` o tres `it` separados,
mismo criterio, lo que sea más legible para quien lo escriba):

1. **Sub-rama (iii), precio de catálogo** — sin ninguna `CustomerRate`
   sembrada (`findActiveForCustomerAndService()`/
   `findActiveForCustomerAndResource()` devuelven `null`) y sin
   `ratePlanId` en los params — cae al precio de catálogo del servicio.
   Precio esperado por línea: `service.price`.
2. **Sub-rama (i), tarifa cliente+servicio con % de descuento** — sembrar
   una `CustomerRate` con `serviceId` seteado, `resourceId: null`,
   `discountPercentage` (ej. 25% sobre un `service.price` de 80 → 60 por
   línea) — mismo patrón que el test `D5` ya existente en
   `reservation.service.test.ts` (`discountPercentage: 25` sobre un
   catálogo de 40 → 30). Precio esperado por línea: el monto descontado
   sobre `service.price`, NUNCA sobre `resource.basePrice`.
3. **Sub-rama (ii), `ratePlanId`** — sembrar un `RatePlan` con
   `bookableServiceRepo.seedRatePlan(...)` (`serviceId` del servicio de
   prueba, `active: true`) y pasarlo como `params.ratePlanId`. Precio
   esperado por línea: el precio resuelto por `resolveSeasonalPrice()`
   para ese plan (fijar el rango de fechas del test para que no cruce
   temporada, o sembrar una sola fila de temporada que cubra todo el
   rango, para que el precio esperado sea un único valor conocido).

**Cada uno de los 3 casos corre dos veces (recurso A / recurso B), mismo
mecanismo:** dos `PhysicalResource`/`BookableResource` en la MISMA
categoría (`is_lodging = TRUE`) con `basePrice` deliberadamente DISTINTO
entre sí (ej. 100 y 500 — la diferencia es la que haría fallar el test si
el precio empezara a depender del recurso), llamando
`pricingService.resolvePrice({ ...params, resourceId: resourceA.id, resource: resourceA })`
y, por separado, con `resourceB`/`resourceB.id` — mismo
`customerId`/`serviceId`/`ratePlanId`/fechas, solo cambia el recurso.

**Aserción — por LÍNEA, no contra `totalPrice` (G-2.4, gate 18, corrige un
falso-rojo latente).** `bookingMode: 'block'` (el modo real de un servicio
de alojamiento) cotiza por NOCHE (`units = calculateNights(...)`,
`resolvePrice()` línea ~139) — con más de una noche, `totalPrice = noches
× precio de la línea`, así que comparar `totalPrice` directo contra el
precio esperado de UNA noche daría un falso-rojo si el test usara más
de 1 noche. Fijar el rango del test en exactamente 1 noche evita el
problema pero lo hace fráchil ante un cambio futuro del rango; en cambio,
afirmar `lines.every(l => l.price === <precio esperado de la sub-rama>)`
(además de comparar el resultado de recurso A contra recurso B, línea por
línea, `lines.length` incluido) es correcto sin importar cuántas noches
tenga el rango del test — y sigue siendo el assert que realmente detecta
la regresión (no solo "A y B dan lo mismo": ambos tienen que ser IGUALES
al precio esperado de la sub-rama, no a ningún `basePrice` de recurso ni a
un promedio/valor constante ajeno que por casualidad coincidiera entre A y
B).

**Caso adicional — demuestra que el escalón de tarifa cliente+RECURSO
queda inalcanzable para alojamiento (G-2.3, gate 18).** Sembrar una
`CustomerRate` con `resourceId: resourceA.id` (`serviceId: null`) — el
escalón que `resolveUnitPrice()` evalúa DESPUÉS del `if (params.serviceId)`
(línea 229, `findActiveForCustomerAndResource()`), fuera del bloque que
siempre retorna antes para alojamiento. Llamar `resolvePrice()` con
`resourceId: resourceA.id`/`resource: resourceA` (el recurso que la tarifa
apunta) y, por separado, con `resourceB` — **el precio tiene que ser
IDÉNTICO en los dos casos, e igual al de la sub-rama (iii)/(i)/(ii) que
esté activa** (la tarifa de recurso se ignora incluso cuando el recurso
consultado es exactamente el que la tarifa apunta) — documentando
explícitamente, con un test, que para alojamiento este escalón es
inalcanzable por diseño (mismo hallazgo que el comentario del test `D9-Parte 1`
de `reservation.service.test.ts` ya documenta para el escalón de BUCKET).

Comentario obligatorio en el test (para quien lo encuentre roto en el
futuro):

```
// Si este test se rompe, el precio de alojamiento con servicio empezó a
// depender del recurso puntual asignado — retomar el diseño de "congelar
// qué recurso se usó para cotizar" antes de seguir
// (docs/diseno-reserva-por-tipo-unidad-2026-09-24.md, §8 "D-1", Ronda 16,
// 25/09/2026 — reemplaza D-1'/D-1, descartadas por redundancia con
// resource_id; decisión de origen: docs/diseno-precio-servicio-vs-recurso-2026-08-27.md).
```

**Fase.** Fase 2 (§6, ítem 9) — mismo punto donde la columna hubiera ido;
no depende de que exista `assignDeferred()` ni de ningún schema nuevo, así
que técnicamente podría escribirse antes, pero se agrupa con el resto de
Fase 2 para no introducir un commit separado solo para esto.

**D-2 no cambia — es independiente de esta reversión.** El rechazo del
combo `resourceId` + `details`/`adultos`/`ninos` (decisión del dueño,
Ronda 14) no depende de ninguna columna: es una regla sobre el
discriminador de `updateReservation()`, ver "`updateReservation()` en
relación con `assignDeferred()`" arriba — sigue vigente, sin cambios de
esta ronda.

### A6.5 — Auditoría de la transición

El bloque `reassigned` de `updateReservation()` (líneas 698-700 —
corregido, C-1, Ronda 14: decía `~619-621`) **no**
audita hoy un cambio de `resourceId` — solo apaga `needsMaintenanceReview`
(D-03). Esta transición nueva **sí** necesita su propio registro — no
reutiliza ese hueco, lo cierra para este caso puntual: `assignment_status`
no es un campo cosmético, es la diferencia entre "el sistema todavía puede
reoptimizar esto" y "esto ya es definitivo", y A6.5 exige rastro de
quién/cuándo/desde-qué-estado para cualquier transición.

Mecanismo: paso 11 de `assignDeferred()` (arriba) — `diffFields()` +
`recordFieldChangesWithClient()` (no la variante suelta: esta escritura sí
comparte pool/transacción con el UPDATE de la reserva) dentro de la misma
transacción del caller. Como los 4 caminos (PUT, "Auto Assign All",
check-in, completar) invocan `assignDeferred()`, los 4 disparan este mismo
registro sin reimplementarlo — es un efecto del paso 11, no algo que cada
caller repita. Extender la auditoría a TODA reasignación de recurso,
incluso fuera del camino de asignación diferida, es una decisión más
amplia que este documento no toma.

### A6.6 — Rol que ejecuta la transición

- **Reasignación manual (`PUT /reservations/:id`)** — ya exige
  `authorize(Roles.FRONT_DESK)` hoy; sin cambios, hereda la autorización
  del endpoint existente.
- **"Auto Assign All" (Fase 3)** — endpoint nuevo, `authorize(Roles.MANAGEMENT)`.
  Más restrictivo que la individual, por ser una operación masiva (mismo
  criterio de `irreversible-action-gate` que ya usa este repo). Al
  implementarse, necesita entrada en `docs/rbac-matriz-endpoints.md`
  (secciones 2 y 4) y suma un `authorize()` call-site nuevo a
  `EXPECTED_AUTHORIZE_CALL_SITES`.
- **Check-in / completar** — no exponen ningún endpoint nuevo; heredan la
  autorización de sus propios endpoints existentes (`POST
  /stays/check-in`, el flujo de completar reserva), sin cambios de RBAC
  propios de este diseño.

---

## 9. Lo que este documento NO hace

- **No dimensiona el costo de la Fase 4 (Opción A)** más allá de
  "significativamente mayor que C" — no se justifica medirlo hoy sin un
  consumidor real (channel manager) que lo requiera.
- **La matriz de impacto (§7) no cubre código fuera de** `src/reservas`,
  `src/pms-estadias` y `src/facturacion` — si aparece un consumidor nuevo
  de `resource.id` en otro módulo, no está caminado acá.
- **No toca código.** Cero cambios en `src/`, cero migraciones, cero
  commits — este documento es la especificación, no la implementación.
- **Los 17 forks de alcance de Fases 0-2 no quedan abiertos — hay, además,
  UN fork nuevo de Fase 3 (F3-4) que sí queda abierto a propósito, ver más
  abajo (corregido, condición menor del gate 18 — una versión anterior de
  este bullet afirmaba, sin excepción, "no quedan decisiones de negocio
  abiertas").** Los 17 forks que este diseño levantó en Fases 0-2 en total
  (corregido en la Ronda 10 — una versión anterior
  decía "14" sin contar N4; corregido de nuevo en la Ronda 14 — sumó D-1 y
  D-2, los 2 forks que el gate de la Ronda 13 devolvió al dueño vía
  `AskUserQuestion`, recontados de punta a punta contra cada mención de
  `AskUserQuestion`/"resuelto por el dueño" del documento),
  todos resueltos vía `AskUserQuestion` con el dueño — la mayoría el
  24/09/2026, y el fork 16 (D-1, en su forma final) recién el 25/09/2026,
  tras pasar por D-1' el mismo día — **corregido (condición menor del gate
  18): una versión anterior de este bullet decía, sin excepción, "el
  24/09/2026" — falso para el fork 16, ver Anexo, entradas "Ronda 15"/
  "Ronda 16" para la fecha real de cada resolución** (el
  historial de en qué ronda se encontró y resolvió cada uno vive en el
  Anexo):
  1. Alcance: solo alojamiento (`is_lodging = TRUE`); turnos queda fuera
     de 4.3 (§5.1).
  2. `4.1`/`4.2` quedan en el backlog normal, fuera del bloque de 4.3
     (§5.2).
  3. La transición `PENDING_ASSIGNMENT → ASSIGNED` es de una sola vía,
     sin camino de vuelta (§4 Opción C).
  4. RBAC de "Auto Assign All": `Roles.MANAGEMENT` (§8 A6.6).
  5. Residuo de precio `CONFIRMED`+`PENDING_ASSIGNMENT` — cerrado por el
     fork 6.
  6. No-recotización en asignación diferida, acotada al componente de
     precio por recurso — combinada con cambio de fechas/tarifa se
     rechaza con error tipado (§8, "`updateReservation()` en relación con
     `assignDeferred()`").
  7. El check-in confirma la asignación, vía `assignDeferred()` (§6,
     sub-alcance "check-in").
  8. Restricción de categoría en asignación diferida, aplica a los 4
     caminos (§8 A6.3).
  9. Filtrado de `assignmentStatus` en las 4 respuestas del portal de
     clientes (§7, fila del mapper).
  10. El ajuste manual de precio queda disponible sin cambios de código
      después de una asignación diferida (§7).
  11. El mail de confirmación muestra la categoría, no la habitación
      específica — solo para alojamiento; turnos siguen mostrando el
      recurso sin cambios (§6 Fase 1).
  12. `completeReservation()` confirma automáticamente el recurso
      provisorio de una reserva `PENDING_ASSIGNMENT` al completarse, vía
      `assignDeferred()` (§6, sub-alcance "completar").
  13. Si el recurso elegido al check-in es de OTRA categoría (upgrade en
      el mostrador), el check-in rechaza con
      `AssignmentCategoryMismatchError` — mismo criterio que PUT y "Auto
      Assign All" (§6, sub-alcance "check-in").
  14. `approveScheduleChange()` (late-checkout) sobre una reserva todavía
      `PENDING_ASSIGNMENT` se niega a evaluar el conflicto, con error
      tipado, en vez de evaluar contra el recurso provisorio (§7, fila de
      `approveScheduleChange()`).
  15. Fase 0 cuenta disponibilidad de RANGO COMPLETO del período pedido —
      la MISMA noción que ya usa `findAvailableResourceInCategory()`/
      `checkAvailability()` — y no un mínimo por noche (N4, Ronda 9, §6
      Fase 0).
  16. **(Ronda 14, reemplazada por D-1' en la Ronda 15, revertida a no-op
      en la Ronda 16 — "no construir nada aún, solo un test de
      regresión")** D-1 queda cerrado como no-op estructural: el precio
      de alojamiento no depende hoy del recurso puntual asignado
      (verificado tres veces — Ronda 14, la reconfirmación de la Ronda
      15/B-2 y el gate de la Ronda 16, ver Anexo) — no se
      agrega ninguna columna (la de D-1' resultó matemáticamente
      redundante con `resource_id`, ver §8 "D-1"). En su lugar, un test de
      regresión (alcance de Fase 2) que fuerza a retomar el diseño de
      congelamiento si el pricing de alojamiento alguna vez empieza a
      depender del recurso (§8, "D-1").
  17. **(Ronda 14)** El combo `resourceId` + `details`/`adultos`/`ninos`
      sobre `PENDING_ASSIGNMENT` se rechaza, mismo criterio que el combo
      fecha+reasignación (D-2, §8, "`updateReservation()` en relación con
      `assignDeferred()`").

  **F3-4 — excepción explícita, es una decisión de negocio y queda
  ABIERTA a propósito (gate 18, agregada después de los 17 de arriba, no
  renumerada como "18" porque no es de Fases 0-2 ni fue resuelta —
  numerar como fork "resuelto" algo que no lo es contradiría el propio
  título de esta lista).** "Auto Assign All" (Fase 3), aun con F3-2/F3-3
  corregidos, ¿debe CONFIRMAR la asignación provisoria de una reserva si
  sigue siendo válida, REOPTIMIZAR las demás reservas `PENDING_ASSIGNMENT`
  de la categoría (nunca las ya `ASSIGNED` — ver §6, Fase 3, para por qué
  eso reabriría A6.4), o dejar el comportamiento greedy alfabético
  actual sin tocarlo — **corregido (C-3, ronda de correcciones sobre el
  gate 19): son tres opciones, no dos, ninguna con más peso que las
  otras** (ver §6, Fase 3, para el detalle completo de las tres)? No se
  resuelve acá — Fase 3 no se puede aprobar de
  todas formas hasta que Fase 2 esté en producción (precondición de gate,
  §6), así que preguntarle al dueño ahora no desbloquea nada; queda
  anotada para cuando se retome el diseño completo de esa fase.

  Lo que sigue abierto es exclusivamente de implementación: Fase 4/Opción
  A sin dimensionar; la matriz de impacto acotada a los tres módulos
  caminados; los requisitos de implementación del check-in
  (`TransactionManager`, métodos `WithClient` nuevos en `StayRepository`
  y `FinancialTransactionRepository`); la relocación de
  `ResourceOccupiedError` a `domain/errors.ts`; la limitación declarada de
  la "categoría original" derivada en vivo (A6.1 paso 6); la limitación
  declarada de que el filtro de `Stay` activa no serializa contra un
  check-in concurrente sobre el mismo recurso candidato (A6.1 paso 7); el
  hallazgo colateral de doble conteo de ocupación (fuera de alcance de
  4.3, `OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001`); y si la ausencia de
  evento de dominio en `assignDeferred()` vale la pena resolverse — no de
  negocio.

---

## Anexo — Historial de rondas de gate

Traza de decisiones, no el detalle completo de cada ronda — para el
razonamiento línea por línea de un hallazgo puntual, este historial dice
en qué ronda buscar si hiciera falta reconstruirlo desde el control de
versiones del documento.

**Ronda 1 — versión original + primer gate.** El documento original
dejaba dos forks de negocio explícitamente sin resolver (alcance
alojamiento/turnos, qué hacer con 4.1/4.2 — §5) y proponía la Opción C. El
gate `architecture-governor` devolvió "aprobado con condiciones": corregir
la cita de rechazo de la Opción B (R2/R11 de `criterios-datos.md`, la cita
correcta está en la Parte 1); cerrar la matriz de impacto (hasta entonces
una promesa, no una tabla real); resolver explícitamente la transición
`PENDING_ASSIGNMENT → ASSIGNED`; y agregar el análisis de máquina de
estados contra `docs/criterios-negocio.md` §6. Esa misma ronda encontró,
además, dos preguntas nuevas que no resolvía por su cuenta: qué política
de precio aplica si una reserva `CONFIRMED` se reasigna estando
`PENDING_ASSIGNMENT`, y qué grupo de `authorize()` exige "Auto Assign
All". Los dos forks originales y estos dos nuevos se resolvieron vía
`AskUserQuestion` con el dueño, el mismo día: alojamiento primero (turnos
fuera de alcance); 4.1/4.2 quedan en el backlog normal; RBAC de "Auto
Assign All" = `Roles.MANAGEMENT`; el residuo de precio quedó "aceptado, no
se corrige" en esta ronda (resolución que una ronda posterior reemplazó).

**Ronda 2 — grounding ERP adicional, post-gate.** Un grounding hecho
DESPUÉS del gate de la Ronda 1 (Cloudbeds, QloApps, OCA/pms de Odoo, no el
grounding original de las 25 preguntas) trajo tres decisiones nuevas,
resueltas vía `AskUserQuestion`: (1) la no-recotización deja de estar
"aceptada" y pasa a ser una regla explícita — ninguna reasignación pura de
recurso por el camino de asignación diferida recotiza el componente de
precio por recurso, sea `PENDING` o `CONFIRMED`; (2) el check-in confirma
la asignación (cruce `pms-estadias → reservas`); (3) la asignación
diferida rechaza un cambio de categoría con error tipado.

**Ronda 3 — gate `HOLD`, hallazgos H1-H6.** El gate encontró que "una sola
operación de aplicación" (H2) era necesaria porque el sub-alcance de
check-in, tal como estaba descrito, era demasiado liviano (no re-chequeaba
disponibilidad, no tomaba lock, no snapshoteaba) — nace acá
`ReservationService.assignDeferred()` como diseño explícito. También: el
discriminador de no-recotización era demasiado amplio y podía tragarse
cambios de fecha/tarifa (H3); el orden de fases necesitaba ser una
precondición de gate, no solo prosa (H4); varias citas cruzadas estaban
desactualizadas (H5); y dos limitaciones se declararon sin resolver (H6:
categoría derivada en vivo, justificación de precio-por-tipo
simplificada). H1 (único fork de negocio de esta ronda: el check-in
también rechaza un upgrade de categoría) se resolvió vía
`AskUserQuestion`.

**Ronda 4 — gate `HOLD`, hallazgos N1-N7.** N1: el paso de "re-emitir
`occupancy_records`" no se podía implementar tal como estaba escrito
(contador agregado, sin API para restar) — resuelto como "diferir", no
"reemplazar". N2: `Reservation.restore()` necesitaba `assignmentStatus`
obligatorio, sin default, para no repetir la misma familia de bug ya
documentada 4 veces en `reservation.service.ts`. N3 y N4 (parte 1) fueron
forks de negocio nuevos, resueltos vía `AskUserQuestion`: el ajuste manual
de precio sigue disponible sin cambios; el mail de confirmación muestra la
categoría, no la habitación. N4 (resto), N6 y N7 fueron
correcciones/declaraciones obligatorias sin fork: el drag-to-move del
calendario es consumidor del mismo `PUT`; `StayService` se construye en 2
lugares; `checkIn()` hace una tercera escritura
(`linkStayToReservationCharges()`); la lista de pasos de `assignDeferred()`
se completó; y se agregó la nota de backfill en Fase 3 (superada por la
Ronda 6/R2, ver abajo). N5 ratificó el rechazo de combinar reasignación
diferida con cambio de fechas, pero corrigió la justificación: es
separable técnicamente, se rechaza por simplicidad.

**Ronda 5 — gate `HOLD`, hallazgos bloqueantes B1-B8 y correcciones
menores C1-C8.** B4 (completar confirma automáticamente) y B8 (el mail
solo cambia para alojamiento) fueron forks de negocio, resueltos vía
`AskUserQuestion`. B1-B3, B5-B7 fueron correcciones técnicas sin fork: el
mecanismo de reconstrucción de la entidad necesitaba recibir el
`BookableResource` completo, no un id (B1); los snapshots debían
condicionarse a que hubiera reasignación real (B2); el registro de
ocupación no podía ser un paso transaccional de `assignDeferred()`
(`SqlOccupancyRepository` sin variante `WithClient`) y se movió a cada
caller, post-commit (B3); se agregó la tabla regla × fase (B5); la
condición de carrera de `updateReservation()` (relectura bajo lock como
primer paso de la transacción, no la lectura sin lock de más arriba) fue
la corrección más importante de esta ronda (B6); el filtro de `Stay`s
activas, hasta entonces solo mencionado en prosa, se formalizó como paso
real (B7). C1-C8 corrigieron citas/redacciones: el tercer caller real de
`restore()` (`buildReservation()`, no solo `updateReservation()`/
`confirmPriceAdjustment()`); la lista completa de 12 escritores del UPSERT
(cifra que la Ronda 7 corrigió a 13, ver abajo); referencias cruzadas
desactualizadas; `linkStayToReservationCharges()` sin variante
`WithClient`; comparación por valor (no presencia) en el rechazo de
cambio combinado; y la nota de conexión en `docs/pendientes-2026-09-12.md`
sobre el doble conteo de ocupación (que la Ronda 7 también amplió, ver
abajo).

**Ronda 6 — gate `HOLD`, hallazgos R1-R7.** El gate confirmó que "el
modelo de fondo está bien" — lo que quedaba eran detalles de
implementación — y recomendó, además, reescribir el documento como
especificación única en vez de seguir apilando "Actualización N-ésima
ronda" (la causa raíz de que las Rondas 3-5 hubieran introducido
contradicciones nuevas cada una). Hallazgos
técnicos obligatorios: **R1** — la comparación optimista bajo lock de
`updateReservation()` protegía `resource_id`/`assignment_status` (Ronda
5/B6) pero dejaba el precio recotizando sobre datos potencialmente
obsoletos; se agregó la comparación de 7 campos que aborta con
`ReservationConcurrentlyModifiedError` si algo cambió. **R2** — Fase 1
marcaba reservas como `PENDING_ASSIGNMENT` antes de que existiera el
mecanismo para resolverlas (`assignDeferred()`, recién en Fase 2),
dejando una ventana real de backfill; se resolvió separando "crear la
infraestructura" (Fase 1) de "activar el marcado" (Fase 2, junto con todo
lo demás) — el backfill de la Ronda 4/N7 desaparece por construcción, no
por resolución. **R3** — el filtro de `Stay`s activas, tal como estaba
descrito, no se podía implementar contra el schema real (sin columnas de
rango de fechas) ni necesitaba un error nuevo (`ResourceOccupiedError` ya
existe); se resolvió reusando el predicado y el error reales del check-in
de hoy, y se identificó — verificado en código, con precedente ya
existente en el propio archivo (`MaintenanceWindowRepository`) — que la
dependencia nueva a `StayRepository` no crea ciclo, pero que reusar
`ResourceOccupiedError` tal cual (definido en `stay.service.ts`) sí lo
crearía, así que se agregó relocarlo a `domain/errors.ts`. **R4** — al
confirmar el mismo recurso provisorio (el caso más común), ya no se
vuelven a validar disponibilidad/recurso-activo/mantenimiento/estadías
activas — no se está reclamando inventario nuevo; como efecto colateral,
esto también evita que completar una reserva falle por una ventana de
mantenimiento abierta después de crearse. **R5** — el contrato de
`assignConcreteResource()` (Ronda 5/B1) seguía siendo peligroso si alguien
olvidaba reenviar un campo al reconstruir la entidad; se resolvió con un
método `toProps()` que serializa todos los campos, más un test de
preservación de propiedades obligatorio. **R6** — ocho contradicciones
mecánicas puntuales (citas a `existing` donde debía decir `locked`; la
descripción de `assignDeferred()` todavía mencionando "re-emisión de
`occupancy_records`" pese a que la Ronda 5/B3 ya lo había sacado; una
afirmación de que una reserva completada podía quedar `PENDING_ASSIGNMENT`
para siempre, que ya no es cierta desde la Ronda 5/B4; la cifra de "12
callers" corregida a 13; `sql.occupancy.repository.ts` listado como
archivo a tocar cuando la Ronda 5/B3 decidió explícitamente no tocarlo; y
otras dos). **R7** — decisión del dueño: `approveScheduleChange()` sobre
una reserva `PENDING_ASSIGNMENT` se niega a evaluar el conflicto de
late-checkout, en vez de evaluarlo contra el recurso provisorio —
consistente con los demás rechazos ya decididos en este diseño. Esta ronda
también amplió la nota de conexión de
`OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001` en
`docs/pendientes-2026-09-12.md`, que solo mencionaba 2 de los 4 puntos de
entrada que ahora pueden sumar ocupación.

**Ronda 7 — la reescritura normativa, entrada propia (corregido: el título
de esta entrada decía "Ronda 6 (esta)" y mezclaba las dos rondas — ya no).**
Siguiendo la recomendación de la Ronda 6, el cuerpo (§1-§9) se reescribió
como especificación única y consistente, retirando el patrón de
"Actualización N-ésima ronda" apilada que venía desde la Ronda 1. Esta
ronda no agrega hallazgos técnicos nuevos propios — consolida los de las
Rondas 1-6 en un texto sin las contradicciones que ese apilado había ido
dejando (citas a `existing` donde correspondía `locked`, secciones que
asumían una decisión que otra sección, no tocada esa ronda, seguía
contradiciendo). El gate de esta ronda devolvió `HOLD`: encontró 5
contradicciones textuales locales (T1-T5) y 4 correcciones técnicas
obligatorias sin fork de negocio (B1-B4), más 6 condiciones menores
(C1-C6) — ninguna de las 15 requería una decisión nueva del dueño, todas
eran correcciones técnicas o de precisión sobre el texto ya reescrito.

**Ronda 8 — checklist de los 15 ítems de la Ronda 7, sin relectura desde
cero.** Aplicó los 4 bloqueantes: **B1** — el orden de locks de
`assignDeferred()`/`updateReservation()` estaba invertido (reserva antes
que `resources`) respecto del único orden seguro que ya sigue
`createReservation()` — patrón ABBA de deadlock real; corregido moviendo
el lock de `resources` al primer paso de las dos operaciones, universal
para toda reserva (incluidos turnos, efecto colateral aceptado). **B2** —
faltaba el productor real de `PENDING_ASSIGNMENT`: se especificó el
contrato `enteredByCategory` entre `reservations.routes.ts` y
`createReservation()`, y se sumó el cuarto sitio de construcción de
`ReservationProps` a la lista ya llevada. **B3** — se agregó el paso de
datos obligatorio (`UPDATE ... SET assignment_status = 'ASSIGNED'`) al
runbook de rollback de Fase 2. **B4** — se declaró el encadenamiento
obligatorio de `completeReservation()` con la entidad que devuelve
`assignDeferred()`, y se corrigió la cifra de "13 callers" para esa
excepción. C1-C6 y T1-T5 se aplicaron sobre el texto ya reescrito
(detalle en cada sección correspondiente, no repetido acá).

**Ronda 9 — simplificar: el mecanismo de locks de B1 traía su propio
deadlock ABBA.** El gate encontró que el hint de B1
(`currentResourceIdHint`, una lectura sin lock para saber qué recurso
lockear antes de lockear la reserva) era exactamente el patrón que el
propio documento advierte contra en otros lados: parchar agregando piezas
en vez de fijar un invariante — el hint mismo podía formar un ciclo ABBA
(intercambio de habitaciones, "Auto Assign All" contra un `PUT`,
`createReservation()` superpuesta). El modelo de negocio se dio por
convergido (14 decisiones, sin contradicciones nuevas) — el único trabajo
de esta ronda fue de protocolo de concurrencia. **N1** (la corrección más
importante): se retiró el hint y el lock de dos recursos; un solo
invariante gobierna `assignDeferred()`, `updateReservation()` y check-in
(nunca se lockea un recurso con una fila de `reservations` ya tomada; el
único recurso que se lockea es el candidato; el camino `isSameResource` no
lockea ningún recurso) — `assignDeferred()` pasa de 12 a 11 pasos, y la
decisión de qué lockear se le devuelve al CALLER (que siempre la tiene de
una lectura previa que de todos modos ya hacía), reemplazando la prosa
dispersa de locks (check-in, `updateReservation()`, "Auto Assign All") por
una tabla única en §8 A6.1. **N2** — declarado explícitamente que
`completeReservation()` es seguro con este invariante porque su llamada a
`assignDeferred()` siempre cae en `isSameResource`. **N3** — corregida la
caracterización de `maintenance-window.service.ts::createWindow()`: no es
un "no-op semántico" más — es el único de los 13 escritores de
`reservations` que lee sin lock y fuera de transacción antes de un UPSERT
completo; bug preexistente (no introducido por 4.3), declarado como
prerrequisito de Fase 2 y registrado aparte en
`docs/pendientes-2026-09-12.md`. **N4** — resuelto por el dueño vía
`AskUserQuestion`: el endpoint de Fase 0 cuenta disponibilidad de RANGO
COMPLETO (misma noción que `findAvailableResourceInCategory()`/
`checkAvailability()`), no un mínimo por noche. C-a a C-d: corregido el
conteo "3"→"4" de errores de conflicto/concurrencia; citadas por símbolo
(no por línea) las referencias a `error.middleware.ts` y
`customer.routes.ts` (archivos con cambios sin commitear de otro bloque);
declarado en el cuerpo de §6 (no solo en este Anexo) que el arreglo de
concurrencia de `updateReservation()` es universal, incluidos turnos
(**superado por la Ronda 10/C-b, ver abajo** — ese arreglo general se
sacó del alcance de 4.3); corregido el timing del `UPDATE` del runbook de
rollback de Fase 2 (corre DESPUÉS de que el código de rollback esté
sirviendo tráfico, no antes) y declarado el subconteo de ocupación
resultante como aceptado.

**Ronda 10 — gate `HOLD`, hallazgos H1-H2 y hallazgos menores, sobre la
Fase 0 ya aprobada con condiciones.** El gate confirmó que el mecanismo SÍ
se había simplificado (salió el hint, quedó una sola tabla de locks) y dio
**Fase 0 por APROBADA CON CONDICIONES** — la primera fase que este
documento deja lista para implementarse. El resto quedó en `HOLD` por 2
hallazgos técnicos, los dos acotados a la sección de check-in, ninguno
requería al dueño. **H1** — la sección de check-in resolvía "¿está
`PENDING_ASSIGNMENT`?" recién DENTRO de `assignDeferred()`, cuyo paso 2
lanza `ReservationAlreadyAssignedError` si la reserva NO está
`PENDING_ASSIGNMENT` — leído literalmente, todo check-in de HOY sobre una
reserva `ASSIGNED` (el 100% de los check-ins reales) habría empezado a
fallar; corregido con un discriminador explícito, leído bajo lock, ANTES
de considerar invocar `assignDeferred()` — una reserva `ASSIGNED` no
cambia en nada respecto de hoy. **H2** — `stays.resource_id REFERENCES
resources(id)` (`schema.sql:2115`) hace que todo `INSERT INTO stays` tome
un lock implícito `FOR KEY SHARE` sobre el recurso referenciado, sin
excepción — la fila "check-in mismo recurso: cero locks" de la tabla de
la Ronda 9 era falsa en la práctica y podía formar un ciclo de deadlock
(T1 con la fila lockeada pidiendo `KEY SHARE` sobre el recurso vía el
`INSERT` de `Stay`, T2 con el recurso en `FOR UPDATE` pidiendo la fila);
corregido con una regla única, sin excepción: toda transacción que
escribe algo con FK hacia `resources` (`UPDATE` de
`reservations.resource_id` que cambia el valor, o `INSERT` de
`stays.resource_id`) lockea el recurso ANTES que la fila — la misma regla
que `updateReservation()` ya sigue hoy, extendida a check-in. Como
consecuencia, "completar" (`completeReservation()`) queda como el ÚNICO
camino sin ningún lock de recurso — verificado que no inserta ninguna
`Stay` ni cambia `resource_id` en su `UPDATE`. Esto también simplificó la
prosa general de §8 A6.1: la reconciliación en dos ramas de la Ronda 9
(previa optimista sin lock vs. relectura bajo lock) dejó de ser un
mecanismo general — ya no depende de un dato que pueda estar
desactualizado, sino de un hecho estructural (¿esta operación escribe algo
con FK hacia `resources`?).

**Hallazgos menores de la misma ronda, todos aplicados:** **C-b** — el
hallazgo que el documento venía llamando "actualización perdida en
`updateReservation()`" se confirmó, por un gate distinto, como bug de
producción real y preexistente; el dueño lo separó como su propio arreglo,
en curso en paralelo, fuera de este documento — 4.3 dejó de atribuírselo
como entrega propia (§6, §8). **`MAINTENANCE-WINDOW-STALE-SAVE-001`**
(`docs/pendientes-2026-09-12.md`) tenía dos imprecisiones: decía que
`createWindow()` era "el ÚNICO" escritor que lee sin lock — falso,
`updateReservation()` (el hallazgo de C-b) tiene el mismo patrón hoy —
corregido con referencia cruzada, sin duplicar el detalle; y decía "3
call-sites" listando 4 líneas — corregido a 4, de las cuales solo 2
(las que asignan a `toFlag`) alimentan el UPSERT final, verificado con
`grep -n`/`sed -n` contra el archivo real. La fila de la tabla de locks de
"check-in con cambio de recurso, misma categoría" decía que el rechazo de
categoría ocurría "antes de llegar a este orden" — falso, ocurre DENTRO de
`assignDeferred()` (su paso 6), con los locks ya tomados — corregido, y la
fila en sí se fusionó con la de "mismo recurso" (H2, arriba). El conteo de
§9 decía "14 forks, todos resueltos" sin contar N4 (Ronda 9, la decisión
del dueño sobre Fase 0) — recontados de punta a punta, corregido a 15. El
rango de fechas del pre-lock de check-in y "Auto Assign All" no estaba
especificado — declarado explícitamente: si difiere del rango bajo lock
(`locked.startTime`/`locked.endTime`), la operación aborta con
`ReservationConcurrentlyModifiedError` en vez de proceder con datos
potencialmente obsoletos.

**Ronda 11 — gate `architecture-governor`, 2 hallazgos técnicos, ninguno
requería al dueño, sobre la Fase 0 ya aprobada.** El gate confirmó que el
arreglo aparte de `updateReservation()` (`UPDATE-RESERVATION-LOCK-ORDER-001`,
C-b) — que corre en paralelo, fuera de este documento — termina con el
orden recurso → fila, exactamente lo que el paso 6 de `assignDeferred()`
(§8) daba por supuesto; ese punto queda resuelto y confirmado, sin ninguna
decisión nueva pendiente sobre él. Encontró, además, 2 hallazgos técnicos
obligatorios: **Hallazgo 1** — la conclusión de las Rondas 9/10 (N2:
"completar es el único camino sin ningún lock de recurso") es falsa,
verificado contra Postgres real (sonda descartable): la optimización de
Postgres que saltea el chequeo de FK en un `UPDATE` que no cambia el valor
de la columna NO aplica si la MISMA transacción ya escribió esa fila
antes — y el UPSERT de `assignDeferred()` (paso 10) seguido del `UPDATE`
propio de `completeReservation()`, ambos sobre la misma fila en la misma
transacción, hace exactamente eso; reproducido `55P03` (lock request) y
`40P01` (deadlock completo, completar contra check-in o contra un `PUT`).
**Hallazgo 2** — el pre-lock de check-in especificado en la Ronda 10
(`assertAllResourcesAvailable()`) no solo lockea, también VALIDA
disponibilidad completa (superposición, mantenimiento, recurso inactivo);
usarlo como pre-lock incondicional, antes del discriminador `ASSIGNED`/
`PENDING_ASSIGNMENT` de H1, habría agregado esos rechazos a TODO check-in
— incluidos los de una reserva `ASSIGNED`, el 100% de los de hoy —
contradiciendo directamente H1 ("el check-in de una reserva `ASSIGNED`
queda IDÉNTICO a hoy"). Hallazgos menores adicionales: una afirmación
falsa de que `checkIn()` "ya llama a `recordOccupancy()` hoy" para el
camino `ASSIGNED` (verificado con grep: 0 call-sites reales en
`stay.service.ts`); 2 lugares del documento que seguían llamando "ÚNICO"
a `createWindow()` como escritor sin lock, pese a que
`docs/pendientes-2026-09-12.md` ya lo había corregido; imprecisiones en la
entrada `MAINTENANCE-WINDOW-STALE-SAVE-001` de `pendientes.md` (describía
el arreglo aparte como "lock + comparación optimista [de varios campos]",
que no es lo que hace; y usaba la palabra "todavía", con fecha de
vencimiento); y citas de línea de `completeReservation()` desactualizadas
por el fix en curso de `updateReservation()`, que movió código antes en el
mismo archivo.

**Ronda 12 — aplicó las 2 correcciones obligatorias y las menores
de la Ronda 11, sin relectura desde cero (mismo criterio que la Ronda 8
sobre los hallazgos de la Ronda 7).** **Hallazgo 1:** se reescribió por
completo el sub-alcance "completar" (§6) — ahora lockea el recurso ANTES
que la fila cuando la lectura inicial encuentra la reserva
`PENDING_ASSIGNMENT` (mismo invariante que el resto de los caminos), con
re-chequeo de `resource.id` bajo lock y aborto con
`ReservationConcurrentlyModifiedError` si cambió; sin dependencia nueva
que wirear (`resourceRepository` ya está inyectado en `ReservationService`).
La regla H2 (qué operaciones disparan el lock de FK) se amplió para cubrir
el caso de "segunda escritura de la misma fila en la misma transacción".
La tabla de locks de §8 A6.1 queda, en consecuencia, sin ninguna fila de
excepción. **Hallazgo 2:** el pre-lock de check-in pasa a ser un lock puro
(`resourceRepository.lockByIds()`), sin la validación completa que traía
`assertAllResourcesAvailable()`; la regla de "abortar si el rango de
fechas del pre-lock difiere" se retiró para check-in (dependía
específicamente de que el pre-lock validara fechas, ya no lo hace) pero se
mantiene, con su misma justificación, para "Auto Assign All" (su pre-lock
sigue validando disponibilidad completa, igual que `updateReservation()`);
`StayService` gana una dependencia nueva, más chica, a `ResourceRepository`
(o el `Pick` equivalente), separada y adicional a la que ya necesitaba a
`ReservationService`. Correcciones menores, todas aplicadas: retirada la
afirmación falsa sobre `checkIn()`/`recordOccupancy()`, con una advertencia
explícita agregada para la implementación; corregidos los 2 lugares que
llamaban "ÚNICO" a `createWindow()`, alineados con `pendientes.md` ("uno
de, al menos, dos"); agregada una nota de orden de locks para el futuro
arreglo de `maintenance-window.service.ts` (el re-lock de reservas tiene
que ir DESPUÉS del `INSERT` de `maintenance_windows`, que ya toma `KEY
SHARE` sobre el recurso); y las citas a `completeReservation()` pasan a
hacerse por símbolo, no por número de línea, en todo el documento. La
entrada `MAINTENANCE-WINDOW-STALE-SAVE-001` de `docs/pendientes-2026-09-12.md`
se corrigió en el mismo cambio: deja de describir el arreglo aparte como
"lock + comparación optimista [de varios campos]" (es una relectura bajo
lock, con una comparación acotada al guard de coherencia
`resource.id`/`serviceId`, no una comparación optimista general), saca la
palabra "todavía", y cita los dos hallazgos por su nombre real —
`UPDATE-RESERVATION-LOST-STATUS-001` (el bug original) y
`UPDATE-RESERVATION-LOCK-ORDER-001` (la corrección de orden de locks, ya
resuelta y aprobada con condiciones por su propio gate) — con una nota de
que el segundo ya no está pendiente de decidir el orden de locks.

**Ronda 13 — el fix de `updateReservation()` que las Rondas 1-12
daban por "en curso en paralelo" SE COMMITEÓ (`6178d70`), y el mecanismo
real que implementa NO es el que este documento venía describiendo desde
la Ronda 7 (B-1).** Verificado línea por línea contra
`reservation.service.ts` post-commit (`grep -n`/`sed -n`, C-2): no hay
comparación optimista de 8 campos, no hay precio candidato resuelto fuera
de la transacción que proteger — el mecanismo real es `preCheck` sin lock
(paso 1) → lock del recurso candidato (paso 2) → lock de la fila (paso 3)
→ guard de coherencia de SOLO 2 campos, `resource.id`/`serviceId` (paso
4) → TODO lo demás, incluido `resolvePrice()`, recalculado bajo lock
(pasos 5-7). Se reescribieron por completo §6 (la nota "C-b", ahora
"resuelta y commiteada") y §8 ("`updateReservation()` en relación con
`assignDeferred()`"), con el discriminador de 4.3 re-anclado al punto
exacto del código real donde compone (entre el guard de status y la
resolución de recurso, línea 547) — más simple que lo que las Rondas
1-12 asumían, porque no queda ningún precio calculado afuera de la
transacción que descartar. Como consecuencia directa, `createWindow()`
(`maintenance-window.service.ts`) vuelve a ser el ÚNICO escritor real de
`reservations` que lee sin lock y fuera de transacción antes de un UPSERT
completo — dejó de ser "uno de, al menos, dos" (el otro, `updateReservation()`,
ya no tiene ese patrón).

**Hallazgo nuevo, no reportado por ninguna ronda anterior (B-2):**
`StayService` no tiene, ni tuvo nunca, ninguna dependencia a
`this.availability`/`ReservationAvailabilityService` ni a
`ReservationService` — verificado en su constructor real y en sus 2
únicos call-sites de construcción (`reservations.routes.ts::buildStayService()`,
`app.ts`). La sección de check-in de este documento asumía, desde varias
rondas atrás, que `checkIn()` podía llamar a
`this.availability.recordOccupancy(...)` directo — ese campo no existe.
Corregido con un método PÚBLICO nuevo, `ReservationService.recordOccupancy()`,
que delega a la `availability` privada, y que `checkIn()` invoca sobre la
dependencia `ReservationService` que `StayService` ya necesitaba agregar
para `assignDeferred()` — sin wiring adicional más allá de ese DENTRO de
`StayService`. **Esta última frase quedó incompleta — corregido en la
Ronda 14 (N-1):** no dice de DÓNDE sale esa instancia de
`ReservationService` en el ÚNICO sitio donde `StayService` se construye
sin pasar por `reservations.routes.ts` (`app.ts`, closure de
`/api/stays`) — ahí no existía, ni existe, ninguna referencia a
`ReservationService` antes de esta ronda. Ver §7, ítem 12, para el
análisis y la decisión (cuarto composition root manual, no un builder
compartido) — **corregido (condición menor del gate 18): esta era la
decisión de la Ronda 13/N-1, luego REVISADA en la Ronda 15 (ver esa
entrada, más abajo) — el resultado final no es un cuarto composition root
manual, es exportar y reusar `buildStayService()`. §7, ítem 12, refleja
hoy la versión final revisada, no la de este párrafo.**

**Hallazgo nuevo, corrección de un hecho falso (B-3).** La sección de
"completar" decía que `completeReservation()` "sigue leyendo la reserva
SIN lock primero... exactamente como hace hoy" — falso, verificado en
código: el método entra DIRECTO a `requireReservationWithLock()`, sin
ningún `preCheck` previo, ni en HEAD ni en ninguna versión anterior
verificable. La lectura previa que "completar" necesita para decidir qué
recurso lockear es un patrón NUEVO, análogo al `preCheck` de
`updateReservation()` — no algo que ya existiera. Corregido además un
segundo problema: el mecanismo hasta la Ronda 12 decidía si invocar
`assignDeferred()` con esa lectura SIN lock, lo que podía producir un
`409` espurio (`ReservationAlreadyAssignedError`) si la reserva se asignó
en paralelo (incluso al mismo recurso) antes de que "completar" tomara su
lock de fila. Corregido: la decisión se toma con la lectura BAJO lock; si
en ese punto ya está `ASSIGNED`, "completar" sigue por la rama normal, sin
invocar `assignDeferred()` y sin ningún error — el lock del recurso
tomado de más (por haber pre-lockeado con la lectura sin lock) es inocuo.

**Condiciones menores C-1 a C-5, todas aplicadas:** **C-1** — declarado,
sin resolver, que la segunda escritura de la misma fila dentro de la
misma transacción (patrón de "completar" y del PUT con cambios
combinados) re-chequea TODAS las FKs de `reservations` (`customer_id`,
`service_id`, `rate_plan_id`), no solo la de `resource_id` — riesgo de
deadlock benigno, no arreglado acá. **C-2** — re-verificadas contra el
código real post-commit TODAS las citas de línea de
`reservation.service.ts` que este documento tenía (§1, §6, §7, §8):
`createReservation()` 209→210, `new Reservation(...)` 367→368,
`updateReservation()` 405→406, reasignación de recurso 466-486→547-557/568,
recotización 511→593, `restore()` de `updateReservation()` 552→631, de
`confirmPriceAdjustment()` 747→826, `buildReservation()` 559→541 (este
último en `sql.reservation.repository.ts`, no tocado por el commit pero
también estaba desactualizado — **corregido en la Ronda 14, C-2: este
cambio de la Ronda 13 estaba mal.** La línea 541 es donde se DECLARA
`buildReservation()`; la 559 es la llamada real a `Reservation.restore(`
dentro de ella — el mismo tipo de cita que ya se usa para
`updateReservation()`/`confirmPriceAdjustment()` en esta misma lista (por
la llamada a `restore(`, no por la declaración del método contenedor). La
Ronda 13 cambió la cita de 559 a 541 creyendo que estaba desactualizada;
no lo estaba — se revierte a 559). **C-3** — corregida la entrada
`MAINTENANCE-WINDOW-STALE-SAVE-001` de `docs/pendientes-2026-09-12.md`:
ya no dice "aprobado con condiciones, commit pendiente" — dice "resuelto y
commiteado en `6178d70`", con el hash real. **C-4** — declarado en Fase 1
el DDL explícito (`NOT NULL`, `CHECK`, patrón idempotente
`ADD COLUMN IF NOT EXISTS` + `DO $$ ... END $$`, mismo precedente que
`chk_reservations_adultos`, `schema.sql:510/513-519`) y la necesidad de
backup antes de `migrate:tenants` en producción. **C-5** — grep de
"UPDATE-RESERVATION" en `pendientes-2026-09-12.md`: las 4 menciones
encontradas viven todas dentro de la misma entrada
(`MAINTENANCE-WINDOW-STALE-SAVE-001`), ya corregida por C-3 — no había
ninguna otra entrada suelta que actualizar.

**Ronda 14 — 3 hallazgos técnicos bloqueantes (N-1, N-2, N-3), 8
condiciones menores (C-1 a C-8) y 2 decisiones de negocio nuevas del
dueño (D-1, D-2), gate `architecture-governor` sobre la Ronda 13.**

**N-1 — falta un lugar donde `StayService` obtenga un `ReservationService`.**
`StayService` se construye en 2 sitios; el segundo (`app.ts:497-525` en
esa versión del archivo, corregido a `485-519` en la Ronda 15, montaje por
closure de `/api/stays`) no tenía, ni tiene hoy, ninguna referencia a
`ReservationService` — y con este diseño necesita una, para
`assignDeferred()`/`recordOccupancy()`. Verificado que los 3 composition
roots existentes de `ReservationService` (`reservations.routes.ts`,
`bookable-services.routes.ts`, `customer.routes.ts` — los mismos que
nombra el docblock D-10 de `reservation.service.ts`) **no comparten
ningún builder entre sí** — cada uno arma las dependencias a mano, patrón
deliberado según ese mismo docblock (fuerza al compilador a validar cada
sitio por separado). Decisión de esta ronda: cuarto composition root
manual, dentro del mismo closure de `app.ts`, replicando la construcción
de `buildReservationService()` — no un builder compartido, para no romper
el patrón que el repo ya eligió 3 veces. Exportar y reusar SÍ es viable
técnicamente (sin ciclo de imports: `app.ts` ya importa de
`reservations.routes.ts`) pero se descarta por consistencia; revisar esta
decisión si aparece un quinto sitio. Se corrigió la matriz de impacto
(§7, ítem 12) y se sacó la afirmación falsa "sin wiring adicional más
allá de ese" de los 2 lugares donde aparecía (§6 sub-alcance check-in, y
el Anexo Ronda 13/B-2). **Revertido en la Ronda 15 — ver esa entrada más
abajo.** La justificación de arriba ("patrón deliberado según ese mismo
docblock... para que el compilador... valide cada sitio por separado")
resultó ser una lectura incorrecta de D-10: ese docblock argumenta contra
un parámetro de constructor CON default, no contra compartir un builder
entre callers — un builder único seguiría forzando al compilador a
corregir un parámetro nuevo sin default, solo que en un único lugar. La
Ronda 15 revirtió esta decisión: se exporta y reusa `buildStayService()`
en vez de agregar un cuarto sitio de construcción directa de
`ReservationService` — con esto, el docblock D-10 y el comentario de
`bookable-services.routes.ts` ("3 composition roots") NO quedan
desactualizados, a diferencia de lo que este párrafo daba por hecho.

**N-2 — guard de "completar" reintroducido, acotado, con la tabla de 5
casos completa.** La Ronda 13 había sacado, sin registrarlo en este
Anexo, el guard de coherencia que la Ronda 12 traía para "completar"
— reabriendo 2 casos borde: `preCheck` ve `ASSIGNED` pero `locked` ve
`PENDING_ASSIGNMENT` (ningún recurso pre-lockeado); y `preCheck`/`locked`
ambos `PENDING_ASSIGNMENT` pero con recurso DISTINTO (el recurso
pre-lockeado es el equivocado). En los dos, invocar `assignDeferred()`
violaría el invariante N1 (recurso lockeado ANTES que la fila, sin
excepción). Guard reintroducido, acotado a estos 2 casos —
`ReservationConcurrentlyModifiedError` en vez de proceder — con la
tabla de 5 casos completa en §6, sub-alcance "completar" (ampliada a 6
casos en la Ronda 15 — ver esa entrada más abajo, cubre el caso que esta
tabla dejaba marcado "N/A" sin explicarlo), y la fila de
locks de §8 A6.1 actualizada para reflejarlo. Confirmado que el guard NO
dispara en el caso feliz que B-3 (Ronda 13) ya había resuelto (`preCheck`
`PENDING_ASSIGNMENT` / `locked` `ASSIGNED`) — ese caso ni siquiera entra
al bloque donde el guard vive (`locked.assignmentStatus ===
'PENDING_ASSIGNMENT'`).

**N-3 — el conteo de errores nuevos de Fase 2 es 4, no 5.**
`ReservationConcurrentlyModifiedError` seguía listado como "tipado nuevo
que Fase 2 agrega... sin mapeo... 500" en 2 lugares (§6 ítem 8, §7 ítem
4/5) pese a que el propio commit `6178d70` ya lo agregó a
`domain/errors.ts` y a `error.middleware.ts` (`case
'RESERVATION_CONCURRENTLY_MODIFIED': ... return 409;`, verificado con
`grep -n`) — mismo caso que `ResourceOccupiedError` (ya mapeado, reusado,
no nuevo). Corregido en los 2 lugares: son 4 errores genuinamente nuevos
(`AssignmentCategoryMismatchError`, `AssignmentCombinedChangeError`,
`ReservationAlreadyAssignedError`, `ScheduleChangeAssignmentPendingError`),
no 5.

**C-1 a C-8, todas aplicadas** — re-derivadas con `grep -n`/`sed -n`
contra el código real, no copiadas de la ronda anterior: **C-1** 3 citas
de línea desactualizadas (`~571-603/~774`→`~648-689/~852-868`; "línea
82"→83; `~619-621`→698-700). **C-2** la cita de `buildReservation()` en
`sql.reservation.repository.ts` vuelve a 559 (la llamada a
`Reservation.restore(`) — la Ronda 13 la había cambiado a 541 (la
declaración del método) con una justificación falsa. **C-3** el hash de
la corrección "fuera de alcance" sobre `customer.routes.ts` corregido de
`5e6d4a8` a `061e1ed` (verificado con `git log -- src/api/routes/customer.routes.ts`).
**C-4** `service_id` está SIEMPRE presente en alojamiento
(`LodgingRequiresServiceError`), nunca "suele ser NULL" — corregidas las
2 afirmaciones que decían lo contrario (residuo de FK del ítem C-1/Ronda
13, y la fila de `resource-lock.service.ts` en §7), con la justificación
correcta de "impacto nulo" para esta última (el conjunto de recursos que
bloquea el servicio depende solo de `serviceId`, no del `resourceId`
puntual, y `assignDeferred()` no cambia ni `serviceId` ni fechas).
Verificado que no hay ningún `FOR UPDATE` sobre `bookable_services` en el
repo. **C-5** agregado `serviceId` (opcional) al contrato de Fase 0 —
condición nueva sobre una fase ya "aprobada con condiciones", justificada
porque Fase 0 todavía no se implementó y N4 ya estableció que la
precisión de este número importa. **C-6** en `pendientes-2026-09-12.md`:
`MAINTENANCE-WINDOW-STALE-SAVE-001` corregido de "uno de, al menos, DOS"
a "vuelve a ser el único" (cierto desde `6178d70`); citas de línea de
`OCCUPANCY-DOUBLE-COUNT-ON-COMPLETE-001` corregidas (834/930→913/1009,
1010/1042→1089/1121); citas de `SCHEMA-ANCHOR-DRIFT-001` corregidas
(:638→:1222, :1291-1294→:1973-1976, "14 forks"→"15 forks" — re-corregido
de nuevo a "17 forks" en esta misma ronda por D-1/D-2, ver más abajo).
**C-7** el chequeo `status === 'CONFIRMED'` de `checkIn()` (hoy sobre la
lectura sin lock) se declara explícitamente movido a la lectura bajo lock,
junto con el resto del método. **C-8** "a diferencia de la versión
pre-fix" corregido — la comparación real es con la PRIMERA VERSIÓN DEL
FIX, no con el bug pre-fix (que usaba la lectura sin lock para TODO, sin
nada que descartar); "los otros 12 escritores" corregido a 9 (los
nombrados), con la aritmética completa hasta 13 explicada.

**D-1 — congelar el componente de precio del recurso (decisión del
dueño).** Verificado contra `reservation-pricing.service.ts` que, para
alojamiento (`serviceId` siempre presente, `LodgingRequiresServiceError`),
`resolvePrice()` NUNCA llega a las 2 ramas que dependen de `resourceId`
(las 3 sub-ramas de `if (params.serviceId)` siempre retornan antes) — el
precio de una reserva de alojamiento no varía hoy según qué unidad
puntual de la categoría se le asigne. El mecanismo se diseña igual
(columna `reservations.resource_price_frozen` — corregido, Ronda 15: esta
cita decía `resources.resource_price_frozen`, la tabla equivocada; la
columna vive en `reservations`, nunca existió en `resources`, marcada por
`assignConcreteResource()`), declarado explícitamente como garantía
estructural/de cara a futuro — no como la corrección de un número que hoy
sale mal, porque hoy no hay ningún número que varíe. Ortogonal a
`confirmPriceAdjustment()`/`previewPriceAdjustment()` (ajuste manual
explícito, sin cambios). Fase 2, DDL idempotente igual que
`assignment_status`. **Reemplazado por D-1' en la Ronda 15** — el booleano
que este párrafo describe se descartó: no decía QUÉ recurso se usó para
cotizar, solo SI la reserva pasó por asignación diferida. Ver la entrada
"Ronda 15" más abajo para el mecanismo que se diseñó en esa ronda (columna
`priced_with_resource_id`, nullable, FK a `resources`) — **revertido por
completo en la Ronda 16** (ver esa entrada y §8 "D-1"): la columna
resultó matemáticamente redundante con `resource_id`.

**D-2 — rechazo del combo `resourceId` + `details`/`adultos`/`ninos`
(decisión del dueño).** Mismo mecanismo que el combo fecha/`ratePlanId`
ya diseñado: mismo error (`AssignmentCombinedChangeError`), mismo
criterio de detección (comparación por VALOR contra `existing`, no por
presencia del campo — la justificación de "el formulario de staff
reenvía estos campos en cada `PUT`" era falsa, corregido en la Ronda 15
(B-3): verificado contra `appfrontend`, `handleUpdateDetail` y el
arrastre del calendario mandan subconjuntos distintos de campos, nunca
todos juntos — el criterio por VALOR es correcto igual, por una razón más
simple y sin depender de ningún caller: un campo ausente no puede ser,
por definición, un cambio real que rechazar). Se extendió el discriminador
existente en vez de agregar un chequeo aparte — la segunda rama del
discriminador ("si SÍ traía otros cambios, sigue el pipeline normal") se
declaró efectivamente inalcanzable tras esta extensión, y el texto se
corrigió para decir eso en vez de describir un camino que ya no existe.

Con D-1/D-2 el conteo total de forks de negocio pasa de 15 a **17**
(§9, Anexo, encabezado del documento y la cita de `SCHEMA-ANCHOR-DRIFT-001`
en `pendientes-2026-09-12.md`, todos actualizados en el mismo cambio).

**Ronda 15 — gate `architecture-governor` (decimoquinto gate) dio
`HOLD` de nuevo sobre Fase 2/3, con 3 hallazgos bloqueantes (B-1, B-2, B-3
de esta ronda — numeración nueva, no confundir con los B-1/B-2/B-3 de
rondas anteriores) + condiciones sobre N-1/N-2 (cerrados con condiciones)
+ correcciones menores, más 1 decisión de negocio nueva del dueño (D-1',
reemplaza D-1) con una sub-pregunta resuelta en el mismo turno.** El
conteo total de forks de negocio NO cambia (sigue en 17) — D-1' reemplaza
a D-1, no agrega un fork nuevo; la sub-pregunta sobre reasignación se
resolvió junto con D-1', no por separado.

**D-1' — el dueño reemplazó "congelar con un booleano" (D-1, Ronda 14)
por "congelamiento real ahora": persistir QUÉ RECURSO se usó para
cotizar, no un booleano — decidido vía `AskUserQuestion` (25/09/2026),
junto con la sub-pregunta de que la marca se actualiza en cada
reasignación posterior, no queda fija en la de la primera asignación.
**Puntero corregido (condición menor del gate 18): §8 ya NO tiene una
subsección "D-1'" — se revirtió a "D-1" en la Ronda 16 (ver esa entrada,
más abajo), y ese es el nombre vigente de la sección hoy; lo que sigue acá
es la descripción HISTÓRICA del mecanismo que D-1' proponía en su
momento, no una referencia a contenido que siga existiendo con ese
nombre.** Mecanismo (histórico, revertido) descrito para memoria: columna nueva
`reservations.priced_with_resource_id` (`VARCHAR(255) REFERENCES
resources(id) ON DELETE SET NULL`, nullable a propósito — a diferencia
del booleano descartado, `NULL` es un valor legítimo, no solo el default
de arranque), seteada dentro de `Reservation.assignConcreteResource()`
(igual que `assignmentStatus: 'ASSIGNED'`) y actualizada en la
reasignación normal de `updateReservation()` (caso (a) de A6.3) cuando ya
venía rastreándose. **Revertida por completo en la Ronda 16** — ver esa
entrada y §8 "D-1": la combinación de "congelar de verdad" con "actualizar
en cada reasignación" (la sub-pregunta de este mismo párrafo) hacía que la
columna nunca guardara un valor distinto de `resource_id` —
matemáticamente redundante, no protegía nada.

**B-1 — el campo nuevo sigue el mismo contrato que `assignmentStatus`, no
el que tenía `resourcePriceFrozen`.** Obligatorio, sin default, en los 3
sitios reales de `Reservation.restore()` (`sql.reservation.repository.ts::buildReservation()`,
`reservation.service.ts::updateReservation()`/`::confirmPriceAdjustment()`)
y cargado sin `??` en `buildReservation()` — el precedente exacto no es
`reservationNumber` (nunca `null`) sino `appliedCustomerRateId`
(`Reservation.ts:163/235/266/329` — nullable Y obligatorio a la vez, sin
default, con el mismo motivo: "aunque el valor típico sea `null`, sin
esto un `restore()` que se olvide de reenviarlo pierde la trazabilidad en
silencio"). Agregado al `UPSERT` de `saveWithClient()`, igual que el
resto de las columnas. **Moot desde la Ronda 16** — la columna que este
contrato describe no se construye (revertida, ver arriba y §8 "D-1").

**B-2 — el mecanismo se diseñó de cero, declarando explícitamente que hoy
no tiene efecto observable en el precio.** Confirmado de nuevo contra
`reservation-pricing.service.ts::resolveUnitPrice()` (cita de línea
corregida: 159-242, no 148-240 — la función se corrió ~11 líneas por
cambios de otro bloque desde la Ronda 14) que, para alojamiento,
`resolvePrice()` siempre retorna dentro de la rama `serviceId` sin llegar
al fallback que lee `resourceId`/`resource.basePrice` — el sub-caso
`if (params.service)` con `service` null es, en la práctica, inalcanzable:
verificado que los servicios de este repo solo se dan de baja lógica
(`sql.bookable-service.repository.ts:149`, `active = FALSE`), nunca hay
un `DELETE FROM bookable_services` real en `src/` (`grep -rn` sin
resultados). El campo queda declarado como garantía estructural/de cara a
futuro (referencia histórica — la sección que en ese momento describía
esto vivía bajo "D-1'"; §8 se revirtió a "D-1" en la Ronda 16, puntero
corregido, condición menor del gate 18) — nada en Fase 2 lo lee para calcular un
precio. **Este mismo hallazgo es, sin cambios, la base de la reversión de
la Ronda 16** — verificado por tercera vez (Ronda 14, esta ronda, y el
gate de la Ronda 16), el precio de alojamiento nunca depende del
recurso puntual; la Ronda 16 lo usa para cerrar D-1 como no-op con un
test de regresión, en vez de seguir prometiendo un campo "de cara a
futuro" sin ningún consumidor (§8, "D-1").

**B-3 — comparación de `details` (JSONB): estructural, no `JSON.stringify`.**
`details` es `JSONB` (`schema.sql:470`) y Postgres puede reordenar las
claves al persistir — `JSON.stringify(a) !== JSON.stringify(b)` puede dar
un falso positivo. Corregido: comparación estructural insensible al orden
de claves (`stableStringify()`, claves ordenadas alfabéticamente en cada
nivel), fechas por `.getTime()`, semántica `null` (cuenta como cambio si
`existing` no era `null`) vs. `undefined` (se excluye, campo no
evaluado) declarada explícitamente. Señalado, sin resolver, que
`diffFields()` (`domain/audit.ts:44`) comparte la misma fragilidad —
fuera de alcance de 4.3. Corregida también la premisa falsa "el
formulario de staff manda estos campos en cada `PUT`" (verificado por el
gate contra `appfrontend`: `handleUpdateDetail` y el arrastre del
calendario mandan subconjuntos distintos, nunca todos los campos juntos)
— la razón real para comparar por VALOR no depende de qué mande un
frontend en particular.

**Condiciones sobre N-1 (cerrado, Ronda 14) — la resolución se revirtió.**
Cita real de `app.ts`: `485-519`, con `new StayService(` en la línea 500
(no `497-525` como decían rondas anteriores). Conteo de dependencias de
`ReservationService` corregido: 18 obligatorias + 1 reloj opcional con
default (no "19 (20)"). El docblock D-10 de `reservation.service.ts`
argumenta CONTRA un parámetro de constructor CON default — NO contra
compartir un builder entre callers; la Ronda 14 lo había leído mal para
justificar un cuarto composition root manual. Corregido: se exporta
`buildStayService()` (`reservations.routes.ts:223`, que ya construye
`resourceRepo` localmente y ya puede llamar a la `buildReservationService()`
del mismo archivo) y `app.ts` la importa, en vez de reconstruir
`StayService` a mano — con esto, `app.ts` sigue sin llamar `new
ReservationService(...)` directamente, así que la matriz de impacto sigue
contando 3 composition roots de `ReservationService`, no 4, y los 2
comentarios que dicen "3 composition roots" (D-10, `bookable-services.routes.ts`)
NO quedan desactualizados. Ver §7, ítem 12, para el mecanismo completo.

**Condiciones sobre N-2 (cerrado, Ronda 14) — tabla ampliada a 6 casos.**
El caso "`locked` en `ASSIGNED` con recurso distinto al de `preCheck`"
(fila que la tabla de 5 casos dejaba como "N/A" sin explicarlo) es
SEGURO, verificado por el gate: una sola escritura en la transacción
(`completeReservation()` no invoca `assignDeferred()` en esa rama),
`resource_id` no cambia respecto de la fila real, Postgres saltea el
chequeo de FK, y el lock tomado sobre el recurso viejo (el que vio
`preCheck`) no genera contención ni deadlock — queda inocuo. Agregado como
fila 4 de la tabla ahora-de-6-casos (§6, sub-alcance "completar"). También
corregido: el lock del recurso de "completar" tiene que ser la PRIMERA
sentencia DENTRO de la transacción (no antes de abrirla, como decía una
versión anterior — `lockByIds(client, ...)` necesita el `client`
transaccional, que no existe hasta que `transactionManager.run()` abre la
transacción). El mensaje fijo de `ReservationConcurrentlyModifiedError`
("cambió de recurso o de servicio") pasa a ser parametrizado (`reason`
opcional, con el texto actual como default — el único call-site real
existente no necesita tocarse) para cubrir con precisión el guard de
"completar" (sobre `assignmentStatus`, no recurso) y el aborto de "Auto
Assign All" por fechas — mismo código de error
(`RESERVATION_CONCURRENTLY_MODIFIED`), sin mapeo nuevo en
`error.middleware.ts`.

**C-4 (Ronda 15) — semántica de `ON DELETE SET NULL` corregida.**
`ON DELETE SET NULL` NO bloquea el `DELETE` de la fila padre — al
contrario, lo permite (Postgres pone `NULL` en la columna referenciante).
La conclusión de "residuo benigno" (§6, sub-alcance "completar",
"Residuo aceptado") se sostiene igual, pero por otra razón: los servicios
de este repo solo se dan de baja lógica, nunca hay un `DELETE FROM
bookable_services` real en `src/` — es esa ausencia, no la semántica de
la FK, la que hace el residuo benigno hoy.

**Anexo — typo corregido de paso.** La entrada "D-1" de la Ronda 14 (más
arriba en este mismo Anexo) citaba `resources.resource_price_frozen` — la
tabla equivocada; la columna descartada vivía en `reservations`, corregido
ahí mismo.

**Ronda 16 — gate `architecture-governor` (decimoséptimo gate —
**corregido de nuevo (P-1, ronda de correcciones sobre el gate 20): la
ronda de correcciones sobre el gate 19 había "restaurado" esto a "gate
18", creyendo que ese era el ordinal real — pero eso conflaba DOS gates
distintos bajo un mismo número: el que produjo los 4 hallazgos de esta
entrada (T-1, T-2, F3-1, F3-2) con el gate posterior que aprobó Fase 1
CON CONDICIONES y fijó G-1 a F3-4 (registrado en la entrada "Ronda 17"
más abajo, "Veredicto textual del gate 18" — ese sí es, correctamente,
"gate 18"). `git show 94d3a68:docs/diseno-reserva-por-tipo-unidad-2026-09-24.md`
confirma que esta entrada decía, en el commit real, "decimoséptimo
gate" — restaurado ahora. El historial completo de las 3 renumeraciones
de este ordinal (decimoséptimo → decimosexto → gate 18 → decimoséptimo
de nuevo) vive en el bullet C-4 de la entrada "Ronda 18" de este mismo
Anexo.**) dio
`HOLD` de nuevo sobre Fase 2/3, con 1 hallazgo de redundancia + 2 bugs
menores sobre D-1' (T-1, T-2), 1 corrección de timing de lock sobre Fase 3
(F3-1, mismo patrón que ya se había corregido para "completar") y 1 bug de
diseño en la reutilización de `findAvailableResourceInCategory()` (F3-2),
más varias condiciones menores (líneas/rondas duplicadas en el
encabezado y el Anexo, citas de línea).**

**El "decimosexto gate" (16º, según la numeración externa de esta
serie, entre el decimoquinto de la Ronda 15 y el decimoséptimo de esta
entrada) no tiene entrada propia registrada en este Anexo. No hay ningún
registro versionado de qué revisó — no se le atribuye contenido ni
origen (no se afirma que sea "de otro documento" ni de qué se trató). Se
deja constancia del hueco de numeración sin llenarlo con una suposición.**

**Redundancia de D-1' con `resource_id` — el hallazgo principal.**
Combinando las dos decisiones del dueño sobre D-1' (Ronda 15) — congelar
el recurso de verdad, Y actualizarlo en cada reasignación posterior — la
columna `priced_with_resource_id` terminaba SIEMPRE igual a `resource_id`:
nunca guardaba un valor distinto, así que no protegía nada. El dueño, vía
`AskUserQuestion` (25/09/2026), resolvió: "no construir nada aún, solo un
test de regresión" — D-1 queda cerrado como no-op estructural, verificado
dos veces (Ronda 14 y este gate); se agrega, como parte del alcance de
Fase 2, un test que falla si `resolveUnitPrice()` alguna vez empieza a
depender de `resourceId` para el componente de precio de una reserva de
alojamiento con servicio. Se revierte por completo el DDL, los puntos de
escritura y el discriminador de `updateReservation()`/`confirmPriceAdjustment()`
que D-1' había agregado — ver §6 (Fase 2, ítem 9), §6.1 (tabla), §8
("D-1", reemplaza a "D-1'") para el resultado. D-2 (rechazo del combo
`resourceId` + `details`/`adultos`/`ninos`) es independiente de D-1'/D-1
y no cambia.

**T-1/T-2 — 2 bugs adicionales en el diseño de la columna, registrados sin
resolver (la columna no se construye).** T-1: el pseudocódigo normativo de
A6.1 (paso 10) no contemplaba el cuarto punto de escritura que D-1' exigía
en la primera asignación — hubiera roto el test de preservación de campos
de A6.1. T-2: la garantía de "falla visible si falta la columna" (D-1',
punto 5) era falsa — `buildReservation()` no tiene ningún guard real, sin
la columna el campo simplemente queda `undefined` en silencio. Ver §8
"D-1" para el detalle completo de por qué esta ronda no los arregla (no
hace falta: no se construye lo que los tenía).

**F3-1 — mismo bug de timing de lock que tenía "completar" hasta la Ronda
15, ahora en "Auto Assign All".** El texto de Fase 3 (§6) y la fila de
Auto Assign All en la tabla de locks de §8 A6.1 decían que el candidato se
bloquea y valida "ANTES de abrir la transacción" — imposible:
`assertAllResourcesAvailable(client, ...)` recibe el `client` transaccional
como primer parámetro, que no existe hasta que `transactionManager.run()`
abre la transacción. Corregido con el mismo patrón que ya usa "completar"
(C-4, Ronda 15): la RESOLUCIÓN del candidato (lectura sin lock) sí corre
antes de abrir la transacción; el LOCK+VALIDACIÓN es la PRIMERA sentencia
DENTRO de la transacción de esa reserva puntual, antes de lockear su fila.

**F3-2 — bug real en `findAvailableResourceInCategory()`
(`reservation-availability.service.ts:234-260`, no en
`reservations.routes.ts` como sugería el pedido original de esta ronda —
re-verificado con `grep -n`/`sed -n`).** La función pasa `undefined` fijo
como `excludeReservationId` a `checkAvailability()` (línea 253) — nunca
excluye ninguna reserva de la comparación de solapamiento. **No es un bug
preexistente de producción hoy:** el único call-site real
(`reservations.routes.ts`, alta de una reserva NUEVA) nunca tiene una
reserva propia que excluir, así que `undefined` es correcto ahí — el bug
es específico de cómo Fase 3 planea REUSAR esta función para una reserva
`PENDING_ASSIGNMENT` YA EXISTENTE con un recurso provisorio: sin
excluirse a sí misma, choca contra su propio recurso provisorio, y "Auto
Assign All" nunca podría confirmarlo como definitivo. No se registra
aparte en `docs/pendientes-2026-09-12.md` (condicionado, en el pedido de
esta ronda, a que fuera preexistente — no lo es) — queda especificado como
requisito de implementación de Fase 3 en §6: `findAvailableResourceInCategory()`
gana un parámetro `excludeReservationId?: string`, reenviado tal cual al
lugar de la línea 253.

**Condiciones menores, todas aplicadas.** Encabezado corregido de "doce
rondas" a "dieciséis" (contadas contra el Anexo, incluida esta — ya
estaba desactualizado antes de esta ronda, no solo por esta ronda). Las
dos marcas "(esta)" duplicadas del encabezado (Rondas 13 y 15) y las 4 del
Anexo (Rondas 12-15) se sacaron — solo esta ronda las lleva. §7: la fila
de `restore()` no menciona `pricedWithResourceId` — confirmado que no
hacía falta agregar nada ahí, ya que la columna se cae. Constructor de
`ReservationService`: corregido de `117-181` a `117-185` (línea real del
`) {` de cierre). La exclusión de `undefined` en `diffFields()` corregida
de `audit.ts:39` a `audit.ts:41`. `if (params.serviceId)` de
`reservation-pricing.service.ts` corregido de la línea 168 a la 169 (en
el texto nuevo de §8 "D-1"; la cita vieja desapareció junto con el resto
de la sección D-1' que se reemplazó). Ninguna mención de "regla H2" o del
orden de parámetros de `StayRepository` dependía de D-1'/la columna
descartada — verificado con `grep -n`, ambos temas son independientes de
la columna, no hacía falta tocarlos.

**Ronda 17 — ronda de EDICIÓN, no un gate propio (mismo criterio que las
Rondas 2/7/8/9/12, ver la corrección de la entrada "Ronda 16" más arriba)
— aplicó las condiciones del gate 18.**

**Veredicto textual del gate 18 (gate DISTINTO del decimoséptimo que
generó la entrada "Ronda 16" de arriba — ver la corrección de esa
entrada, más el bullet C-4 más abajo, para el porqué de la distinción —
separado acá, C-5 de la ronda de correcciones sobre el gate 19, de lo que
sigue: un gate revisa y falla, nunca edita texto — la entidad que hizo el
cierre de cada hallazgo de abajo fue esta misma Ronda 17, EN TANTO ronda
de edición, no el gate):** Aprobó Fase 1 CON CONDICIONES (agregando G-1
como condición nueva sobre esa fase), dejó Fase 2 en HOLD acotado con 3
hallazgos puramente técnicos (G-1, G-2, G-3 — ninguno requiere decisión
del dueño) y mantuvo Fase 3 en HOLD (ya lo exigía el propio documento —
Fase 2 en producción es precondición de gate, §6 — más 1 hallazgo
técnico, F3-3, y 1 decisión de negocio anotada sin resolver, F3-4).

**Cierre escrito por la Ronda 17 en respuesta a cada hallazgo — sin
verificar por ningún gate hasta acá.** Lo que sigue (G-1 a F3-4) es el
texto que esta ronda de edición escribió para responder a cada hallazgo
del gate 18; en su momento no había pasado por ninguna revisión. Recién
el gate 19 (Ronda 18, más abajo) lo verificó, y encontró 3 anclas falsas
entre estos cierres (marcadas en el punto que corresponde, con el enlace
a la corrección real) más 1 defecto técnico nuevo que el propio cierre de
F3-3 introdujo sin querer (F3-5) — los 4 corregidos recién en la Ronda
18, no acá:

**G-1 — la falla de T-2 (Ronda 16) aplica igual a `assignment_status`, la
columna de Fase 1, no solo a la de Fase 2 descartada.** `buildReservation()`
no valida nada en runtime; `reservationNumber`/`appliedCustomerRateId` ya
se cargan sin `??` (precedente real, no la excepción que una versión
anterior de §7 decía). Cerrado agregando, a Fase 1: `r.assignment_status`
explícito en la lista de columnas de `baseSelect()` (no estaba
especificado); validación en el CONSTRUCTOR/`restore()` de `Reservation`
contra `Object.keys(ASSIGNMENT_STATUS_TRANSITIONS)` (§8 A6.1, distinta de
la validación de TRANSICIÓN que ya hacía `assignConcreteResource()`); un
test unitario de `Reservation.restore()` con un valor inválido/`undefined`
que verifique que lanza. **Ancla falsa encontrada acá por el gate 19,
corregida en la Ronda 18 (C-1):** el texto de este cierre citaba `id`/
`partySize` como precedente de "campo obligatorio sin default" (falso
para los dos) y decía "no un archivo nuevo" para el test (falso — no hay
ningún test hoy del constructor de `Reservation` en aislamiento). Ver §6
(Fase 1) y §8 A6.1 para el texto ya corregido.

**G-2 — el test de regresión de D-1 no cubría 2 cosas que ya existen.**
(1) Le faltaba citar `docs/diseno-precio-servicio-vs-recurso-2026-08-27.md`
como la decisión de origen del dueño — D-1 es un no-op por DECISIÓN DE
PRODUCTO, no por casualidad del código actual. (2) No decidía
explícitamente si el test extendía `reservation.service.test.ts`
(`:1932`/`:1990`, 19 tests en verde) o iba en un archivo nuevo — se
justificó archivo nuevo (`reservation-pricing.service.test.ts`,
construcción directa de `ReservationPricingService`, más liviana que
instanciar `ReservationService` completo). (3) El test diseñado solo
cubría 1 de las 3 sub-ramas de `if (params.serviceId)` — se parametrizó
sobre las 3, más un caso que demuestra que la tarifa cliente+RECURSO queda
inalcanzable para alojamiento. (4) La aserción contra `totalPrice` directo
daba falso-rojo con más de 1 noche en modo `block` — corregido a afirmar
por LÍNEA. (5) Se agregó `InMemoryBookableServiceRepository` a la lista de
fixtures (hacía falta para sembrar el `RatePlan` de la sub-rama (ii)). El
gate 19 no encontró ninguna ancla falsa acá — cierre confirmado tal cual.
Ver §8 "D-1".

**G-3 — check-in (y el batch de Fase 3) le pasarían la entidad EQUIVOCADA
a `recordOccupancy()`.** El texto decía literalmente
`recordOccupancy(reservation)` — y `reservation` es, en el código real de
`checkIn()` (`stay.service.ts:180`), el nombre de la lectura SIN LOCK
previa, todavía `PENDING_ASSIGNMENT` en ese punto. Pasarle esa entidad
haría que el guard de salteo por `PENDING_ASSIGNMENT` (§7) la ignorara SIN
error visible — ocupación sin registrar en silencio, mismo patrón que B4
de rondas muy anteriores. Corregido para especificar explícitamente que se
pasa la entidad que DEVUELVE `assignDeferred()`, nunca la lectura sin
lock — en check-in y, por el mismo patrón, en el batch de "Auto Assign
All". El gate 19 no encontró ninguna ancla falsa acá — cierre confirmado
tal cual. Ver §6, sub-alcance "check-in", y Fase 3.

**F3-3 — mismo bug que F3-2, una capa más abajo.** La validación DENTRO de
la transacción de "Auto Assign All" (`assertAllResourcesAvailable()`) no
decía explícitamente que recibe `excludeReservationId = id` — sin eso, un
candidato que resultara ser la propia habitación provisoria de la reserva
chocaría contra sí misma en la validación, aunque F3-2 ya la hubiera
excluido en la resolución previa (fuera de la transacción). Corregido en
§6 (Fase 3) y en la tabla de §8 A6.1. **El `excludeReservationId` que este
cierre agregó era correcto — pero la llamada literal que lo llevaba tenía
2 defectos propios, encontrados por el gate 19 (F3-5) y corregidos en la
Ronda 18 (C-2):** usaba `locked.startTime`/`locked.endTime` en un punto
donde `locked` todavía no existe (F3-5a), y omitía `partySize` (F3-5b).
Ver §6 (Fase 3) para el texto ya corregido.

**F3-4 — pregunta de negocio nueva, dejada ABIERTA a propósito, no
resuelta.** Aun con F3-2/F3-3 corregidos, `getByCategory()`
(`sql.resource.repository.ts:141`, `ORDER BY r.name ASC`) hace que "Auto
Assign All" mueva sistemáticamente al huésped de su habitación provisoria
a la primera libre por orden alfabético, aunque la provisoria siguiera
siendo válida. ¿"Auto Assign All" debe
CONFIRMAR la provisoria si sigue siendo válida, o REOPTIMIZAR toda la
ocupación (pudiendo mover reservas ya confirmadas)? Dos respuestas
igualmente razonables — se deja anotada para `AskUserQuestion` al dueño
cuando se retome el diseño completo de Fase 3, no ahora (Fase 3 no se
puede aprobar de todas formas hasta que Fase 2 esté en producción). Ver
§6 (Fase 3) y §9 (fork nuevo, fuera del conteo de 17 de Fases 0-2). **Esta
manera de plantearla tenía 3 problemas, encontrados por el gate 19 y
corregidos en la Ronda 18 (C-3):** (1) "dos respuestas igualmente
razonables" ya era, en rigor, una inclinación implícita — la versión de
§6 llegó a decir explícitamente "la lectura más natural", que CONTRADICE
§4 Opción C (citado por texto, no por línea — ver la corrección de esta
misma cita más arriba, en la nota "C-3": la asignación provisoria "es
reoptimizable, no definitiva"); (2) "reoptimizar... pudiendo mover reservas ya confirmadas"
no distinguía `PENDING_ASSIGNMENT` de `ASSIGNED` — mover una `ASSIGNED`
chocaría contra A6.4; (3) faltaba el comportamiento actual (greedy
alfabético) como tercera opción real. Ver §6 (Fase 3) para el texto ya
corregido, con las tres opciones (a)/(b)/(c).

**Condiciones menores, todas aplicadas (por la Ronda 17).** Encabezado:
"mismo día" para las nueve rondas 8ª-16ª corregido — las Rondas 15/16
fueron 25/09/2026, no el mismo día que las anteriores (24/09/2026). §9:
"todos resueltos el 24/09/2026" corregido — el fork 16 (D-1, forma final)
se resolvió el 25/09/2026. Contradicción "verificado dos veces" (D-1,
cuerpo del documento) vs. "tercera vez" (Anexo, entrada "Ronda 15"/B-2)
reconciliada a "tres veces" — la reconfirmación de la Ronda 15/B-2
("confirmado de nuevo") es una verificación real, distinta de la de
Ronda 14 y la de este gate, que las 3 menciones de "dos veces" del cuerpo
del documento omitían. La expresión ambigua "gate de la Ronda 16/17" (5
apariciones) desambiguada a "gate de la Ronda 16" en todas. §7, ítem 11:
corregido `reservas/reservation.mapper.ts` → `src/api/mappers/reservation.mapper.ts`
(path real, verificado con `ls`). §7, ítem 13: corregido `email/workers/
email.handlers.ts` → `src/workers/email.handlers.ts` (path real,
verificado con `ls`). Tres punteros colgados del Anexo a una §8 "D-1'" que
ya no existe (se revirtió a "D-1" en la Ronda 16) corregidos — dos con una
nota aclarando que describen el mecanismo HISTÓRICO que D-1' proponía, no
contenido vigente; uno (dentro de la entrada de Ronda 13/N-1, "cuarto
composition root manual") corregido para apuntar a la decisión FINAL,
revisada en la Ronda 15 (exportar y reusar `buildStayService()`, no un
composition root nuevo). **Una condición menor más de esta misma ronda
resultó, en sí misma, incorrecta — no cuenta como "aplicada" sin
reservas:** el intento de resolver "el Anexo saltaba del decimoquinto
gate (Ronda 15) al decimoséptimo (Ronda 16) sin registrar un
decimosexto" renumerando la entrada de Ronda 16 a "decimosexto gate"
imponía una correspondencia 1:1 Ronda↔gate que el propio Anexo no
sostiene — corregido en la Ronda 18 (C-4), revirtiendo esa renumeración.
**Esa corrección, a su vez, también resultó incorrecta** (revirtió a
"gate 18", conflando dos gates distintos — ver el bullet C-4 de la
entrada "Ronda 18" y P-1 de la entrada "Ronda 19", ambos más abajo, para
la corrección real: "decimoséptimo gate"/gate 17, y el "decimosexto
gate" (16º) declarado sin entrada propia en este Anexo, no un error de
este documento). El salto de numeración descrito en este párrafo SÍ
existe, entonces — no era una ambigüedad a resolver renumerando, era un
hueco real de la numeración externa.

---

**Ronda 18 — ronda de edición que aplica las condiciones del gate 19
(corregido, P-2 de la ronda de correcciones sobre el gate 20: una
versión anterior de esta entrada se titulaba "gate `architecture-governor`
(gate 19 de esta serie)", como si esta misma entrada FUERA el gate — un
gate revisa, nunca edita, mismo criterio ya aplicado a la entrada "Ronda
17"/C-5 de arriba; el gate 19 real es el que revisó, encontró los 4
defectos de abajo, y dio verdicto — esta entrada es el trabajo de cierre
que respondió a ese verdicto, no el gate en sí).** El gate 19 revisó el
cierre que la Ronda 17 escribió para G-1/G-2/G-3/F3-3
(gate 18) y la corrección de numeración que esa misma ronda había
intentado — encontró 3 anclas falsas entre esos cierres, 1 defecto
técnico nuevo introducido por el propio cierre de F3-3, y la
renumeración de gate incorrecta, y con eso **aprobó el DISEÑO de Fase 2
CON CONDICIONES** (corregido, P-2: una versión anterior de esta entrada
decía que el gate 19 dejaba "a Fase 2/3 en el mismo HOLD que ya tenían"
— incorrecto, Fase 2 dejó el HOLD en este mismo gate; las condiciones
son C-1 a C-7 de abajo, todas aplicadas en esta ronda de edición).
Mantiene a Fase 1 aprobada con
condiciones (G-1 ahora cerrado de verdad — precedente correcto,
`reservationNumber`, y archivo de test nombrado,
`src/tests/domain/reservation.test.ts` — corregido, P-5, ver §6 para
la justificación completa) y deja a Fase 3 en HOLD, como ya lo exigía el
propio documento (G-2/G-3 sin hallazgos nuevos; F3-3/F3-5 ahora cerrado
de verdad; F3-4 sigue exactamente igual de abierta — solo mejor
planteada, con sus tres opciones). Todos los hallazgos y sus correcciones
están anotados inline, en el punto que corresponde de la entrada "Ronda
17" de arriba, y en el cuerpo del documento (§6 Fase 1, §6 Fase 3, §9).
Detalle de cada uno:

- **C-1 (cierra G-1).** El texto de G-1 citaba `id`/`partySize` como el
  precedente de "campo obligatorio sin default del constructor" — los dos
  ejemplos eran falsos (`id` sin valor tira `TypeError` de `.trim()`, no
  un error de dominio; `partySize` SÍ tiene default `= 1`). El precedente
  correcto es `reservationNumber` (`Reservation.ts:265`, sin default;
  `:273-275`, valida por VALOR — `undefined` lanza). El texto también
  decía "no un archivo nuevo" para el test — falso: no existe hoy ningún
  `Reservation.test.ts`, ni ningún test de este repo que construya un
  `Reservation`/`Reservation.restore()` con valores inválidos a propósito
  (verificado, `grep -rl "new Reservation(\|Reservation\.restore("
  src --include="*.test.ts"` — 7 archivos, ninguno dedicado al
  constructor). **Ubicación corregida (P-5, ronda de correcciones sobre
  el gate 20):** archivo nombrado `src/tests/domain/reservation.test.ts`
  (minúscula), no `src/reservas/Reservation.test.ts` — `src/tests/domain/`
  es el directorio real donde viven los tests de ENTIDADES de dominio de
  este repo (constructor/invariantes), no de servicios: `customer.test.ts`
  prueba `Customer` (`clientes-finanzas/customer.entities.ts`, con
  `InvalidCustomerError`) y `resource.entities.test.ts` prueba
  `PhysicalResource` — la entidad del MISMO módulo `reservas/` que
  `Reservation`, verificado con `ls src/tests/domain/` — ninguna de las
  dos vive junto a su archivo fuente. Los tests co-ubicados junto al
  código (`reservation.service.test.ts`, `reservation-availability.service.test.ts`)
  son todos de SERVICIOS, no de entidades — patrón distinto, no aplica acá.
  Ver §6 (Fase 1) y §7 para el texto ya corregido.
- **C-2 (cierra F3-5, hallazgo nuevo del gate 19).** La llamada literal
  que el cierre de F3-3 agregó tenía 2 defectos: usaba `locked.startTime`/
  `locked.endTime` en el punto donde el candidato se lockea+valida
  ANTES de lockear la fila de la reserva — `locked` todavía no existe ahí
  (F3-5a); y omitía `partySize`, tomando el default `1` de
  `assertAllResourcesAvailable()` (F3-5b). Corregido: la llamada usa
  `queuedReservation` (nombre nuevo para la lectura SIN lock que el batch
  ya hacía, antes sin nombre propio) — `queuedReservation.startTime`/
  `queuedReservation.endTime`/`queuedReservation.partySize` — y compara
  `locked.startTime`/`locked.endTime` contra esos mismos valores DESPUÉS
  de lockear la fila (mecanismo que "Rango de fechas del pre-lock", §6
  Fase 3, ya describía en prosa sin nombrar la fuente). `partySize` no
  necesita esa comparación — es inmutable post-creación
  (`reservation.service.ts:617-620`).
- **C-3 (refina F3-4, sin resolverla).** Tres correcciones a cómo está
  planteada la pregunta, ninguna a la respuesta (sigue sin responderse):
  se retira "la lectura más natural" (contradecía §4 Opción C, "es
  reoptimizable, no definitiva"); la opción "reoptimizar" se acota a reservas `PENDING_ASSIGNMENT`
  (nunca `ASSIGNED` — A6.4); se agrega el comportamiento greedy
  alfabético actual como tercera opción real, (c). Ver §6 Fase 3 y §9.
- **C-4 (numeración de gates) — corregida OTRA VEZ por el gate 20, esta
  vez se había aplicado mal.** Esta ronda (Ronda 18) revirtió la
  renumeración previa de "Ronda 16" (que decía "decimosexto gate") — eso
  sí estaba mal, no se sostenía (el propio Anexo tiene 5 rondas sin gate
  propio: 2, 7, 8, 9, 12). Pero el destino elegido acá, "gate 18", era
  TAMBIÉN incorrecto: conflaba el gate que generó la entrada "Ronda 16"
  (T-1, T-2, F3-1, F3-2) con el gate posterior, distinto, que aprobó
  Fase 1 CON CONDICIONES y fijó G-1 a F3-4 (registrado en "Veredicto
  textual del gate 18" de la entrada "Ronda 17" de arriba — ese sí es
  "gate 18"). `git show 94d3a68:docs/diseno-reserva-por-tipo-unidad-2026-09-24.md`
  confirma que la entrada "Ronda 16", en el commit real, decía
  "decimoséptimo gate" — no "gate 18". Corregido de verdad en la Ronda 19
  (P-1): "Ronda 16" vuelve a "decimoséptimo gate"/gate 17, distinto del
  "gate 18" de "Ronda 17"; declarado también que el "decimosexto gate"
  (16º) no tiene entrada propia en este Anexo — es un hueco real de la
  numeración externa, no un error de este documento (ver la entrada
  "Ronda 16" de arriba).
- **C-5 (separa veredicto de cierre).** La entrada "Ronda 17" mezclaba el
  veredicto textual del gate 18 con el trabajo de cierre que esa misma
  ronda de EDICIÓN hizo, presentado sin distinguir que un gate revisa y
  falla, no edita texto. Separados en la entrada de arriba: veredicto
  primero, cierre después, con nota de que el cierre quedó sin verificar
  hasta este mismo gate 19. Las marcas "(esta)" que apuntaban a la Ronda
  16 se movieron acá.
- **C-6 (pendientes-2026-09-12.md).** Ver el párrafo agregado en ese
  documento, corregido en el mismo commit que esta ronda — atribución de
  las ediciones de texto a "la Ronda 17 (ronda de edición posterior al
  gate 18)", no al gate 18 mismo, y las 2 anclas re-derivadas contra el
  estado final de este documento (post C-1 a C-5).
- **C-7.** No se tocaron `docs/decisiones-plan-integral-2026-09-16.md` ni
  los 2 archivos sin trackear de otras waves (`docs/diseno-ui-caja-contrato-2026-09-24.md`,
  `docs/perfil-fiscal-anchor-refresh-2026-09-24.md`).

---

**Ronda 19 (esta) — ronda de edición que aplica las condiciones del gate
20.** El gate 20 verificó el cierre que la Ronda 18 escribió para C-1 a
C-7 (arriba) — sin encontrar ningún problema en el DISEÑO en sí — y
encontró 4 problemas de bookkeeping del documento (P-1 a P-4, ninguno
cambia el diseño) más 1 condición menor de implementación (P-5). Con
eso, dio el **veredicto final: el diseño de Fase 2 queda APROBADO CON
CONDICIONES** (las condiciones remanentes son de implementación: test y
guard de G-1, test de regresión de G-2, `recordOccupancy(assigned)` de
G-3, el arreglo previo de `createWindow()`, el mensaje parametrizado de
`ReservationConcurrentlyModifiedError`). Fase 3 sigue HOLD (precondición
de Fase 2 en producción + F3-4 abierta a propósito, ambas sin cambios).
Fase 0 y Fase 1 sin cambios de alcance — Fase 1 sigue aprobada con
condiciones, su único cambio en esta ronda fue el texto de la propia
condición G-1 (P-5, ubicación del test). Detalle de cada hallazgo:

- **P-1 (numeración de gates, corregida OTRA VEZ).** La ronda de
  correcciones sobre el gate 19 había "restaurado" la entrada "Ronda 16"
  a "gate 18" creyendo eso era el ordinal real — pero conflaba dos gates
  distintos bajo un mismo número (el que generó "Ronda 16", T-1/T-2/F3-1/
  F3-2, con el que generó "Ronda 17", G-1 a F3-4). `git show
  94d3a68:docs/diseno-reserva-por-tipo-unidad-2026-09-24.md` confirma que
  en el commit real esa entrada decía "decimoséptimo gate". Corregido:
  "Ronda 16" vuelve a "decimoséptimo gate"/gate 17; "gate 18" queda
  reservado exclusivamente para el gate distinto de "Ronda 17"; declarado
  explícitamente que el "decimosexto gate" (16º) no tiene entrada propia
  en este Anexo — hueco real de la numeración externa, no un error de
  este documento. Verificado con
  `grep -n "decimo\|gate 1[5-9]\|gate 20" docs/diseno-reserva-por-tipo-unidad-2026-09-24.md`
  que cada ordinal nombra a un único gate real. Ver también el bullet C-4
  de la entrada "Ronda 18" (corregido acá por segunda vez) y el párrafo
  de `pendientes-2026-09-12.md` sobre el "salto de numeración" (P-4,
  abajo).
- **P-2 (la entrada "Ronda 18" se titulaba como si fuera un gate).** Un
  gate revisa, nunca edita — pero la entrada que aplica C-1 a C-7 se
  titulaba "gate `architecture-governor` (gate 19 de esta serie)", como
  si ESA ENTRADA fuera el gate 19 en sí. Retitulada "ronda de edición que
  aplica las condiciones del gate 19". Esa misma entrada registraba
  además el veredicto del gate 19 como "Fase 2/3 en el mismo HOLD que ya
  tenían" — incorrecto: el gate 19 aprobó el DISEÑO de Fase 2 CON
  CONDICIONES (C-1 a C-7), no la dejó en HOLD sin más. Corregido en esa
  misma entrada.
- **P-3 (veredicto del gate 20 sin registrar).** Esta misma entrada
  ("Ronda 19") es la corrección — antes de esta ronda, el veredicto final
  del gate 20 (arriba) no estaba escrito en ningún lado del documento.
- **P-4 (anclas de línea de `pendientes-2026-09-12.md` vueltas a mover
  por esta misma ronda).** Ver la corrección en ese documento — las 2
  anclas de línea (fila de pricing en §7, bullet 6 de forks en §9) se
  reemplazan por anclas de texto/sección, con la línea como referencia
  adicional entre paréntesis, para que sobrevivan a la PRÓXIMA ronda de
  edición sin quedar stale (van 11 correcciones previas de
  `SCHEMA-ANCHOR-DRIFT-001` por este mismo motivo sobre esas 2 anclas).
- **P-5 (ubicación del test de `Reservation`).** Ver §6 y el bullet
  C-1 de la entrada "Ronda 18", ya corregidos: `src/tests/domain/reservation.test.ts`,
  no `src/reservas/Reservation.test.ts` — `src/tests/domain/` es la
  convención real para tests de entidades de dominio de este repo
  (`customer.test.ts`, `resource.entities.test.ts` — este último del
  MISMO módulo `reservas/` que `Reservation`), verificado con `ls
  src/tests/domain/`. También corregido el grep mal formado de §6 (el
  segundo patrón de `new Reservation(`/`Reservation.restore(` aparecía
  como si fuera un argumento de ruta aparte en vez de una alternancia del
  mismo patrón).

**No se tocó `src/` en esta ronda — solo documentación.** No se tocaron
`docs/decisiones-plan-integral-2026-09-16.md` ni los 2 archivos sin
trackear de otras waves (mismo alcance que C-7 de la Ronda 18).
