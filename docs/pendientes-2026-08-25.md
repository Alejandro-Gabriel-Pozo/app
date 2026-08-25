# Pendientes — Martes 25 de Agosto 2026

Arranca a partir de `pendientes-2026-08-24.md`. Sesión de continuidad: la
sesión anterior había quedado cortada por límite de uso con dos ítems a
mitad de camino (fix de `RoomCalendar.tsx` sin probar en navegador, bug de
timezone en `housekeeping/page.tsx::handleCreate` diagnosticado sin
corregir). Esta sesión cierra ambos, encuentra un tercer bug más grande en
el camino (guard de `HousekeepingTask.create()`) y lo corrige también —
confirmado con el dueño vía remote control, con un plan de implementación
puntual que se siguió de cerca (verificado contra el repo real antes de
tocar código: los archivos/líneas que citaba existían tal cual).

---

## RoomCalendar.tsx — rewireo a maintenance_window — ✅ RESUELTO Y VERIFICADO (25/08/2026)

El componente todavía usaba `housekeepingApi.byStatus('OUT_OF_SERVICE')`
(mecanismo viejo) para pintar el rayado "fuera de servicio" en el
calendario de Reservas, sin actualizar cuando `maintenance_window`
reemplazó ese flag el 24/08/2026 (ver sesión anterior) — "Reactivar" en
Housekeeping no tenía ningún efecto visible en el calendario de Reservas.

Reescrito a `maintenanceWindowsApi.listActive()`. A diferencia del flag
viejo (booleano por recurso, sin fecha), una ventana sí tiene fecha — el
bloqueo ahora es por día real (`isUnderMaintenance(resourceId, dayMs)`),
no por toda la fila: una ventana con `endDate` bloquea solo ese rango; una
abierta (`endDate: null`) bloquea desde `startDate` en adelante.

**Verificado en navegador real** (login `admin@demo.com`, contra la base
de producción — hoy con datos de demo, confirmado con el dueño antes de
tocar nada), inspeccionando el DOM directo en vez de confiar en
capturas de pantalla (el rayado usa dos tonos de navy muy parecidos,
casi invisible a simple vista/en screenshot comprimido):
- Ventana cerrada de un día (`Habitación 01`, ya existente en la demo,
  `2026-08-25` a `2026-08-25`): solo la celda de hoy tiene el gradiente
  rayado + `cursor: not-allowed`: el resto de la semana, clickeable.
- Ventana abierta creada de prueba (`Habitación 03`, "sin fecha de fin"):
  los 7 días visibles quedan rayados.
- Reactivar esa misma ventana (cierra con `closeDate` = hoy, default del
  botón): el calendario pasa a mostrar solo HOY bloqueado y el resto de
  la semana libre, sin recargar la página — confirma que "Reactivar"
  ahora sí libera el día en el calendario de Reservas, que era la duda
  pendiente de la sesión anterior.

`tsc --noEmit` y `eslint` limpios antes de probar. Sin commitear todavía
(`git status` en `appfrontend-main` muestra `RoomCalendar.tsx` y
`UpgradePrompt.tsx` modificados sin commit) — pendiente de decidir con el
dueño si se commitea ahora o junto con el fix de `handleCreate` de abajo.

---

## housekeeping/page.tsx::handleCreate — bug de timezone — ✅ RESUELTO (25/08/2026)

Línea 224: `scheduledFor: new Date(date).toISOString()` reintroducía el
mismo bug UTC-vs-local ya corregido en `todayStr()` en la sesión anterior.
`date` es "YYYY-MM-DD" (date-only, de un `<input type=date>`) —
`new Date(date)` a secas lo parsea como medianoche **UTC**, no local. Con
huso detrás de UTC (Argentina, UTC-3) eso corre la tarea un día atrás
apenas el servidor la interpreta en el huso del negocio.

Fix: `new Date(\`${date}T00:00\`).toISOString()` — agregar `T00:00` fuerza
el parseo en hora LOCAL del navegador (quirk de JS: fecha-sin-hora se
parsea UTC, fecha-con-hora se parsea local). A diferencia de `startDate`
de maintenance windows (que via `mwForm.startDate` manda el string crudo
sin pasar por `Date` en ningún momento), acá no alcanza con mandar el
string crudo porque `scheduledFor` exige datetime completo
(`housekeeping.schemas.ts`: `z.string().datetime()`).

`tsc --noEmit` y `eslint` limpios.

**El fix en sí es correcto, pero no se pudo verificar end-to-end
"crear tarea para hoy" en el navegador** — ver el bug de abajo, que
bloquea esa prueba tanto con el código viejo como con el nuevo.

---

## HousekeepingTask.create() rechaza "hoy" después de medianoche local — ✅ RESUELTO (25/08/2026)

Encontrado al verificar el fix de arriba: crear una tarea de housekeeping
para HOY desde la pantalla "Planificar tarea" falla siempre con
`409 — "No se puede planificar una tarea con fecha ya pasada."`, **tanto
con el código viejo como con el fix de hoy** (probado directo contra la
API con ambas construcciones de `scheduledFor` — mismo resultado). No es
algo que este fix haya introducido ni pueda arreglar por sí solo.

**Causa real:** `HousekeepingTask.create()`
(`app-main/src/pms-estadias/housekeeping-task.ts`) compara
`scheduledFor.getTime() < now.getTime()` — instante EXACTO, no día de
negocio. El comentario en el código dice que es una decisión ya
confirmada ("Instante exacto (no día de negocio, decisión confirmada) —
stay.service.ts siempre agenda 'mañana 08:00', así que nunca choca con
este guard" — ver `pendientes-2026-08-23.md`, ítem J2). Esa decisión
asumía que el único caller real programaba siempre para un instante
futuro fijo — no contempló que la pantalla manual "Planificar tarea"
(`housekeeping/page.tsx`) deja elegir la fecha de HOY (`todayStr()` es el
default del selector) y siempre manda medianoche como hora. Resultado:
apenas pasa la medianoche local — es decir, prácticamente todo el
horario de trabajo real — cualquier intento de planificar una tarea
para hoy desde esa pantalla queda rechazado con un mensaje que no explica
la causa real.

**Primera pasada de esta sesión (`AskUserQuestion`, 25/08/2026):** se
armó una segunda opinión externa (traída por el dueño, no generada acá)
con tres caminos posibles — separar `scheduledDate`/`scheduledTime`
(migración de schema), agregar un campo de intención `SCHEDULED`/
`IMMEDIATE`, o un parche táctico sin migrar schema (guard por día de
negocio en vez de instante). Se decidió inicialmente solo documentar, sin
tocar código.

**Retomado en la misma sesión, con un plan de implementación puntual
traído por el dueño vía remote control** (verificado línea por línea
contra el repo real antes de escribir nada — cada archivo/línea que
citaba el plan existía tal cual: `app.ts:361` instanciando
`HousekeepingService`, `app.ts:398` con el mismo patrón de
`businessProfileRepo` para `StayService`, `combineDateAndTime` ya usado
por `maintenance-window.service.ts`/`stay.service.ts`). Se implementó el
**parche táctico sin migrar schema** (el tercer camino de la lista de
arriba), pasando por `criterios-negocio` como exige `app-main/CLAUDE.md`:

- **Clasificación:** `HousekeepingTask` es TRANSACCIÓN
  (`criterios-datos.md` Parte 1). **Reglas aplicadas:** A4.2 (`Business.
  timezone` IANA, nunca offset) y A4.4 (día de negocio ≠ fecha del
  sistema) de `criterios-negocio.md`.
- **`housekeeping-task.ts`** — `create()` recibe un `businessTimezone:
  string` nuevo (obligatorio, no persistido en `HousekeepingTaskProps` —
  es un input efímero del guard, igual que `closedBy`/`closeDate` en
  `MaintenanceWindow.close()`). El guard pasa de
  `scheduledFor.getTime() < now.getTime()` a comparar el **día**
  (`DateTime.fromJSDate(scheduledFor).setZone(tz).startOf('day')` contra
  `DateTime.now().setZone(tz).startOf('day')`, con Luxon — ya dependencia
  del proyecto). `restore()` no se toca (rehidratación no valida, como ya
  documentaba el comentario viejo).
- **`housekeeping.service.ts`** — `HousekeepingService` recibe
  `businessProfileRepository: Pick<BusinessProfileRepository, 'get'>` en
  el constructor (mismo patrón `Pick` que `MaintenanceWindowService`).
  `createTask()` resuelve `profile.timezone` y se lo pasa a
  `HousekeepingTask.create()` — el caller (rutas) no necesita saber nada
  de timezones, sigue mandando el mismo `CreateTaskInput` de siempre.
- **`stay.service.ts`** — el único otro call site de
  `HousekeepingTask.create()` (llamada directa, no vía
  `HousekeepingService`) ya tenía `businessProfile` resuelto ahí mismo
  (para `combineDateAndTime` del `cleaningScheduledFor`) — una línea
  nueva (`businessTimezone: businessProfile.timezone`).
- **`app.ts`** — wiring de `/api/housekeeping` (línea ~361) instancia
  `SqlBusinessProfileRepository(req.db)` y se lo pasa a
  `HousekeepingService`, mismo patrón que `/api/maintenance-windows` y
  `/api/stays` ya usaban.
- **Tests:** `housekeeping-task.test.ts` — todos los `create()` existentes
  actualizados con `businessTimezone`, más 2 tests nuevos con
  `vi.useFakeTimers()`: uno reproduce el bug real (reloj a las 21:18 hora
  Argentina, `scheduledFor` = medianoche de HOY → antes rechazaba, ahora
  acepta) y otro confirma que ayer sigue rechazado aunque sea antes de la
  hora actual de hoy (no se relajó de más). `housekeeping.routes.test.ts`
  — `build()` ahora inyecta un `FakeBusinessProfileRepository` (mismo
  patrón ya usado en `maintenance-window.service.test.ts`).

**Verificado:** `tsc --noEmit` limpio, `eslint` limpio en los 6 archivos
tocados, suite completa **129 archivos / 1468 tests verdes** (0
regresiones). Verificación end-to-end contra el backend real corriendo
(con reloj real ~06:52 hora Argentina, mucho después de medianoche):
`POST /api/housekeeping` para HOY en `Habitación 03` — antes `409`, ahora
`201`, `scheduledFor` correcto (`2026-08-25T03:00:00.000Z` = medianoche
local Argentina).

---

## Housekeeping vs. PMS comercial (Opera/Mews) — gaps de alcance, INFO (25/08/2026)

Segunda opinión externa traída por el dueño, comparando el módulo real
contra el modelo típico de housekeeping en PMS hoteleros (room status:
vacante sucia → limpieza → vacante limpia → inspeccionada → ocupada, con
rama a fuera de servicio). No es un pedido de trabajo, es contexto para
priorizar más adelante — se verificaron los puntos más fuertes contra el
código real antes de anotarlos acá:

- **El modelo real es de TAREA (`HousekeepingTask.status`:
  `PENDING → ASSIGNED → IN_PROGRESS → DONE → INSPECTED`, + rama
  `OUT_OF_SERVICE`), no de estado de habitación.** Son primos, no
  gemelos — el código no distingue "sucia por check-out" de "sucia por
  repaso diario", ambas nacen como tarea nueva. `OUT_OF_SERVICE` sigue
  existiendo como status de tarea, pero **ya no es lo que bloquea
  reservas** — eso lo hace `MaintenanceWindow` desde el 24/08/2026 (ver
  sección `maintenance_window` de `pendientes-2026-08-24.md`). Hoy
  coexisten las dos cosas.
- **Confirmado contra el código (`stay.service.ts::checkIn()`):
  el check-in NO valida el estado de housekeeping.** ✅ **RESUELTO
  (25/08/2026)** — ver sección propia más abajo.
- **Sin verificar en detalle, pero consistentes con leer el código una
  vez:** no hay campo de prioridad (VIP/early check-in), no hay
  checklists, no hay lost & found, no hay integración de minibar (la
  palabra "minibar" solo aparece como comentario de ejemplo en
  `financial-transaction.repository.ts`, sin relación real), no hay
  cálculo de KPIs (tiempo promedio de limpieza, SLA, productividad por
  camarera) aunque los timestamps (`startedAt`/`completedAt`) ya existen
  para construirlos. El dashboard de disponibilidad tiene los datos
  (`findByStatus`, `GET /status/:status`, `GET /` por fecha) pero no un
  endpoint de agregación — habría que armarlo del lado del cliente.

**Resto sin priorizar** — prioridad VIP, checklists, lost & found,
minibar, KPIs y dashboard de agregación quedan como mapa de gaps para más
adelante, sin fecha.

---

## Gating de check-in por limpieza — ✅ RESUELTO (25/08/2026)

El gap de mayor impacto de negocio de la lista de arriba, elegido por el
dueño para encarar esta misma sesión. Antes: `StayService.checkIn()` no
consultaba housekeeping para nada — se podía hacer check-in con la
habitación todavía sucia.

**Decisiones de negocio confirmadas con el dueño (`AskUserQuestion`,
tres preguntas separadas porque cada una escondía una decisión distinta):**
1. Bloqueo por defecto, con override de MANAGEMENT (mismo patrón que
   `OUT_OF_SERVICE → PENDING`) — el override debe dejar rastro: quién,
   cuándo, y el estado de la tarea de housekeeping en ese momento (A6.5).
2. El umbral es `INSPECTED` — `DONE` (limpia, sin inspección de
   supervisor) **no alcanza**.
3. Sin ninguna tarea de limpieza planificada para hoy: **fail-open**
   (no bloquea) — no hay nada que indique que está sucia.

**Clasificación (`criterios-negocio`, obligatorio antes de tocar
`HousekeepingTask`/`Stay`):** `Stay` y `HousekeepingTask` son TRANSACCIÓN
(`criterios-datos.md` Parte 1). **Reglas aplicadas:** A4.2/A4.4 (huso y
día de negocio, mismo criterio que el guard de arriba) y A6.5/A6.6
(toda transición deja rastro; el rol condiciona la transición en el
SERVIDOR, no en el botón oculto del front).

**Implementado:**
- **Schema v41** (`stays`): `housekeeping_override_by`,
  `housekeeping_override_at`, `housekeeping_status_at_override` — sin FK
  a `users` (mismo criterio que `assigned_by`). Migrado contra la BD real
  con `npm run migrate:tenants` (`biz-demo-01` v40 → v41), idempotente.
- **`housekeeping.repository.ts`** — método nuevo `findByResourceAndDate()`
  (tarea de un recurso/fecha SIN filtrar por estado, a diferencia de
  `findActiveByResourceAndDate()` que excluye DONE/INSPECTED a propósito
  — acá hace falta saber si llegó específicamente a INSPECTED).
- **`stay.ts`** — `checkIn()` acepta `housekeepingOverride?: { by,
  taskStatus }` opcional; `Stay` gana 3 campos de solo-lectura
  (`housekeepingOverrideBy/At`, `housekeepingStatusAtOverride`), null si
  no hizo falta overridear.
- **`stay.service.ts`** — antes de crear la `Stay`, resuelve el día de
  negocio de HOY (mismo patrón `businessProfileRepository.get()` +
  `DateTime` que el resto del módulo) y busca la tarea del recurso para
  ese día. Sin tarea → sigue. Con tarea y `status !== 'INSPECTED'`: sin
  `overrideHousekeeping` → `ResourceNotReadyForCheckInError` (409); con
  `overrideHousekeeping` → sigue y estampa el rastro en la `Stay`. Error
  nuevo agregado a `error.middleware.ts` (409).
- **`stays.routes.ts`** — `POST /check-in` acepta `overrideHousekeeping`
  en el body (schema Zod nuevo). A6.6: si viene `true` y el usuario NO
  tiene `MANAGEMENT` en `req.user.permissionGroups`, 403 explícito ANTES
  de llamar al servicio (no se ignora en silencio — eso haría creer al
  front que el override se aplicó cuando no). `docs/rbac-matriz-endpoints.md`
  actualizado (no sumó ningún `authorize(Roles.X)` nuevo — chequeo
  inline — así que `EXPECTED_AUTHORIZE_CALL_SITES` no se tocó).
- **Tests nuevos:** 5 casos en `stay.service.test.ts` (fail-open sin
  tarea, rechaza PENDING, rechaza DONE-sin-INSPECTED, acepta INSPECTED,
  override deja rastro completo) + 2 en `stays.routes.test.ts` (403 sin
  MANAGEMENT, 201 con MANAGEMENT). `tenant-db.setup.test.ts` actualizado
  a v41.

**Verificado:** `tsc --noEmit` y `eslint` limpios (mismo error
pre-existente de siempre en `error.middleware.ts`, no tocado). Suite
completa **129 archivos / 1475 tests verdes**. End-to-end contra el
backend real y `biz-demo-01` ya migrada a v41: reserva de prueba creada
y confirmada en `Habitación 01` (que ya tenía una tarea `PENDING` de hoy
de una prueba anterior de esta misma sesión) — check-in sin override
→ `409 RESOURCE_NOT_READY_FOR_CHECKIN`; con `overrideHousekeeping: true`
→ `201`, con `housekeepingOverrideBy`/`housekeepingStatusAtOverride:
"PENDING"` correctamente persistidos y devueltos.

**Fuera de este alcance, anotado para después:** no se tocó el
frontend — ni un cartel explicando el bloqueo en la pantalla de
check-in, ni un botón de override para MANAGEMENT. El backend ya
devuelve un mensaje de error claro (`"...encargado puede forzar el
check-in igual."`), pero hoy el staff lo vería como un JSON crudo o un
toast genérico hasta que se arme esa pantalla — mismo patrón que el
resto del backlog "backend-only, sin pantalla" de este documento.

---

## Rutas huérfanas de housekeeping — ✅ RESUELTO, se borraron (25/08/2026)

`POST /housekeeping/:id/out-of-service` y `/:id/reset` no tenían ningún
caller real — confirmado por grep tanto en `appfrontend-main` (la pantalla
ya no las llama desde el 24/08, cuando `maintenance_window` reemplazó ese
mecanismo) como en el resto de `app-main` (nada más invocaba
`HousekeepingService.setOutOfService()`/`resetToPending()` que esas dos
rutas). Decisión confirmada con el dueño: borrarlas, no deprecarlas ni
dejarlas inertes.

**Borrado:**
- Las 2 rutas (`housekeeping.routes.ts`) y sus 2 métodos de servicio
  (`housekeeping.service.ts`).
- Los 2 comandos de dominio (`HousekeepingTask.setOutOfService()`/
  `resetToPending()`, `housekeeping-task.ts`). `OUT_OF_SERVICE` sigue
  siendo un valor válido de `HousekeepingStatus` (filas históricas siguen
  legibles, R2) y `assign()` lo sigue rechazando explícitamente — solo se
  sacó el mecanismo para TRANSICIONAR hacia/desde ese status.
  `ALLOWED_TRANSITIONS` actualizado para no advertir esas transiciones en
  `allowedTransitions` (A6.2: el DTO no debe prometer acciones sin código
  que las invoque) — una tarea histórica en `OUT_OF_SERVICE` queda con
  `allowedTransitions: []`.
- `docs/rbac-matriz-endpoints.md` y `EXPECTED_AUTHORIZE_CALL_SITES`
  (198 → 196, se fueron los 2 `authorize(Roles.MANAGEMENT)` de esas rutas).
- Frontend: `housekeepingApi.outOfService`/`.reset` en
  `lib/housekeeping/api.ts` también borrados (dead code apuntando a rutas
  que ya no existen).
- Tests actualizados: `housekeeping-task.test.ts` (transiciones sin
  OUT_OF_SERVICE, nuevo caso "histórico sin transiciones"),
  `housekeeping.routes.test.ts` (los 2 describe de las rutas borradas),
  `in-memory.housekeeping.repository.test.ts` (el caso que llamaba
  `resetToPending()` reescrito sin depender del comando borrado).

**Verificado:** `tsc --noEmit` y `eslint` limpios en ambos repos, suite
completa de `app-main` **129 archivos / 1472 tests verdes**. En vivo
contra el backend real: ambas rutas devuelven `404` ahora, el resto de
Housekeeping (tablero, planificar tarea) sigue funcionando sin cambios.

---

## F2 — flujos de alta/baja de empleados vs. normativa/ERPs reales — ✅ RESUELTO EL HALLAZGO PRINCIPAL (25/08/2026)

F2 llevaba tres sesiones seguidas (13/08, 23/08, 24/08) como "investigación
amplia, sin alcance concreto" — nadie lo había acotado. Confirmado con el
dueño: encarar puntualmente "flujos de alta/baja de empleados" (no
protección de datos personales, que queda para otra sesión si hace falta).

**Investigado contra el código real** (no contra documentación externa —
mismo criterio que el resto de esta sesión):

- **Ya resuelto, no son gaps:** revocación de acceso inmediata al
  desactivar (`isMembershipActive` corre en cada request vía
  `authenticate(undefined, checker)` global en `app.ts` — no espera a que
  expire el JWT) y el login (elegir negocio) ya filtra
  `WHERE active = TRUE` — un empleado dado de baja tampoco puede sacar un
  token nuevo.
- **Gap real y concreto, "flujo ficticio sin aplicabilidad comercial":**
  **no había NINGUNA forma de reincorporar a un empleado dado de baja.**
  Tanto "Crear usuario" (`POST /users`) como "Invitar usuario"
  (`POST /users/invitations`) rechazaban con `409 MEMBERSHIP_ALREADY_EXISTS`
  apenas existía *cualquier* membership previa para esa identity+negocio
  (`findMembership()` no filtra por `active` — correcto, R2 — pero el
  CALLER trataba "existe la fila" y "es miembro activo" como lo mismo), y
  el `UNIQUE(identity_id, business_id)` de la tabla impide insertar una
  fila nueva. Sin ningún `reactivateMembership()` en ningún lado. Cualquier
  negocio real re-contrata gente — no había ningún camino, ni siquiera manual.
- **Gap menor, ya resuelto de paso:** `deactivateMembership()` solo hacía
  `SET active = FALSE`, sin dejar rastro de quién dio de baja a quién ni
  cuándo (A6.5) — la única acción de "sacarle el acceso a alguien" del
  sistema que no lo dejaba, a diferencia de todo lo demás tocado en esta
  sesión (`MaintenanceWindow.closedBy/At`, `Stay.housekeepingOverride*`).

**Implementado:**
- `memberships` (platform DB): 4 columnas nuevas —
  `deactivated_by`/`deactivated_at`/`reactivated_by`/`reactivated_at`, sin
  FK a `users` (mismo criterio que el resto de columnas "quién" de este
  archivo). Un par por dirección (no historial completo), mismo rigor que
  `maintenance_windows.closed_by/closed_at`. `platform.schema.sql` se
  re-aplica solo en cada arranque del server (sin versión propia, a
  diferencia del schema por tenant) — no hizo falta correr ningún script
  de migración aparte.
- `PlatformRepository.reactivateMembership()` nuevo — solo si la
  membership está `active = FALSE` (no pisa una ya activa).
  `deactivateMembership()` ahora recibe `deactivatedBy` y lo graba.
- `POST /users/:id/reactivate` (MANAGEMENT) nuevo — reusa EXACTAMENTE los
  mismos chequeos de plan que `POST /users` (rol todavía permitido en el
  plan actual, asiento libre): reincorporar ocupa un asiento igual que
  crear, no debe saltear el límite. `409 MEMBERSHIP_ALREADY_ACTIVE` si ya
  estaba activa (no es un idempotente silencioso — A6.3).
- `POST /users` y `POST /users/invitations`: cuando la membership existente
  está inactiva, el 409 cambia de `MEMBERSHIP_ALREADY_EXISTS` a
  `MEMBERSHIP_DEACTIVATED` (con `membershipId`) — le dice al caller que
  reactive en vez de dejarlo sin salida con el mismo mensaje genérico.
- `docs/rbac-matriz-endpoints.md` y `EXPECTED_AUTHORIZE_CALL_SITES`
  actualizados (196 → 197, un `authorize(Roles.MANAGEMENT)` nuevo).
- 8 tests nuevos entre `users.routes.test.ts` (reactivar: éxito, 404, 409
  ya activa, 402 asiento, 402 rol no permitido, 422 rol inexistente) y
  `user-invitation.routes.test.ts` (409 `MEMBERSHIP_DEACTIVATED` con
  `membershipId`).

**Verificado:** `tsc --noEmit` y `eslint` limpios, suite completa
**129 archivos / 1479 tests verdes**. End-to-end contra la base real
(`biz-demo-01`): usuario de prueba creado → desactivado → reintento de
alta con el mismo email → `409 MEMBERSHIP_DEACTIVATED` con el
`membershipId` correcto → `POST .../reactivate` → `200` con
`active: true` y `deactivatedBy`/`deactivatedAt`/`reactivatedBy`/
`reactivatedAt` los 4 persistidos correctamente → reintentar reactivar
→ `409 MEMBERSHIP_ALREADY_ACTIVE`. Usuario de prueba desactivado de nuevo
al terminar (no se dejó como asiento activo del demo).

**Fuera de este alcance:** protección de datos personales (Ley 25.326) no
se investigó — es el otro eje que quedó ofrecido y no elegido. Sin
frontend todavía (el 409 `MEMBERSHIP_DEACTIVATED` ya trae el
`membershipId` listo para que una pantalla ofrezca "reactivar" ahí mismo,
pero no se construyó esa UI) — mismo patrón "backend-only, sin pantalla"
del resto del backlog.

---

## Hallazgo menor de UX — "Reactivar" visible en ventana ya cerrada — ✅ RESUELTO (25/08/2026)

La ficha de detalle de Housekeeping seguía mostrando el botón "Reactivar"
para una ventana de mantenimiento que YA tiene `closedAt` seteado (cerrada
antes). Tocarlo de nuevo devolvía `409 MaintenanceWindowAlreadyClosedError`
— un error confuso para el staff, sin explicar nada. El backend hacía lo
correcto (rechaza el doble cierre); era la pantalla la que no ocultaba el
botón cuando ya no aplicaba.

Fix (`housekeeping/page.tsx`): cuando `selectedMaintenanceWindow.closedAt`
está seteado, el botón "Reactivar" se reemplaza por un texto informativo
("Ya se reactivó — sigue bloqueado hasta el final de `endDate`, se libera
solo después"), en vez de dejarlo clickeable hacia un 409. `tsc --noEmit`
y `eslint` limpios. Verificado en navegador contra `Habitación 01` y
`Habitación 03` (las dos ventanas de prueba que quedaron ya cerradas de
la verificación de la sesión) — ambas muestran el texto nuevo, sin botón.

---

## L — reconciliación de asientos al bajar de plan (Etapa 1) — ✅ RESUELTO (25/08/2026)

`PlatformRepository.updateBusinessPlan()` cambiaba el plan de un negocio
sin ninguna reconciliación — si quedaba con más membresías activas de las
que el plan nuevo permite, no pasaba nada (ni bloqueo, ni aviso, ni
desactivación). Decisión de negocio pendiente en 3 sesiones seguidas.

**Propuesta externa traída por el dueño** (confirmada como decisión
comercial correcta, pero con alcance mucho mayor a lo que se encaró hoy):
degradación asistida en 3 etapas — (1) selección obligatoria de a quién
desactivar antes de aplicar el downgrade, (2) fallback de período de
gracia (3-7 días) con desactivación automática LIFO + notificaciones si
nadie elige a mano, (3) un estado "solo lectura" nuevo (no solo activo/
inactivo) con middleware de 403 en cada endpoint de escritura para
usuarios en ese estado. **Confirmado con el dueño: solo la Etapa 1 esta
sesión** — las etapas 2 y 3 son varias sesiones más de trabajo (job de
período de gracia, sistema de notificaciones, un estado de membership
nuevo, enforcement por endpoint) y quedan sin encarar.

**Implementado (Etapa 1 — selección obligatoria, sin bloqueo previo del
downgrade en sí):**
- `PATCH /platform/businesses/:id/plan` acepta `membershipIdsToDeactivate?: string[]`.
  Si el negocio queda con más asientos activos de los que el plan nuevo
  permite (`maxActiveMemberships`), el cambio de plan **no se aplica**
  todavía: responde `409 SEAT_LIMIT_EXCEEDS_NEW_PLAN` con
  `{ newLimit, currentActive, excess, activeMemberships: [{id, fullName,
  email, roleName, createdAt}] }` — la lista completa para que el
  superadmin arme el picker. Reintentando el mismo PATCH con
  `membershipIdsToDeactivate` (suficientes para entrar en el límite)
  desactiva exactamente esas membresías (`deactivateMembership()`, mismo
  mecanismo que `DELETE /users/:id` — deja el rastro A6.5 con
  `req.platformUser.id` como quien lo hizo) y recién ahí aplica el plan.
- **Todo o nada, a propósito:** si la selección no alcanza (ej. elige 1 de
  los 2 que sobran), NO desactiva a nadie todavía — evita el caso raro de
  dejar a alguien sin acceso mientras el superadmin sigue decidiendo el
  resto.
- `PlatformRepository.findActiveStaffMembershipsByBusiness()` nuevo (lista
  con nombre/email/rol, mismo filtro que `countActiveStaffMembershipsByBusiness`
  — excluye OWNER, no ocupa asiento).
- **Alcance acotado a ASIENTOS, no roles** — reconciliar `maxCustomRoles`/
  `allowedRoleNames` (roles que dejan de estar permitidos, o de más, al
  bajar de plan) queda sin resolver: no hay una acción tan directa como
  "elegí a quién desactivar" para un rol con gente asignada (implica
  reasignar personas antes de poder tocar el rol), es un problema
  distinto que no se diseñó hoy.
- 4 tests nuevos en `platform.routes.test.ts` (409 sin selección, 409
  selección insuficiente sin efecto, éxito con selección suficiente, 500
  `PLAN_LIMITS_NOT_CONFIGURED` si el plan destino no tiene fila en
  `plan_limits`).

**Verificado:** `tsc --noEmit` y `eslint` limpios, suite completa
**129 archivos / 1483 tests verdes**. **No verificado en navegador/vivo**
— el backend local no tiene `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD`
configurados en `.env`, así que no hay forma de loguearse como superadmin
sin agregar esas credenciales primero (no se hizo sin confirmarlo aparte).
Queda pendiente de probar en vivo cuando haya esas credenciales a mano.

**Fuera de este alcance:** Etapas 2 (período de gracia + LIFO +
notificaciones) y 3 (estado "solo lectura" + middleware de 403 por
endpoint) de la propuesta original, y la reconciliación de roles/
`maxCustomRoles` — todo documentado acá para retomar si hace falta. Sin
frontend todavía para el picker del superadmin (el 409 ya trae toda la
data lista para renderizarlo).

---

## Datos de prueba dejados en la base real (demo, confirmado con el dueño)

Durante la verificación se creó una `maintenance_window` de prueba sobre
`Habitación 03` (`biz-demo-01`) — abierta primero, después reactivada
(cerrada con `closeDate` = hoy) para probar el ciclo completo. Confirmado
con el dueño antes de tocar nada: la base es de producción pero hoy tiene
datos de demo, "nada que romper". Queda en el mismo estado que la ventana
preexistente de `Habitación 01` (`reason: "prueba E2E maintenance_window"`,
ya cerrada) — consistente con datos de prueba que ya estaban ahí, no se
limpió porque no hay endpoint de borrado (solo `close()`).

---

## Auditoría UX — migración de modales a rutas dedicadas (Clientes, Fase 1) — ✅ RESUELTO (25/08/2026)

Segunda opinión externa traída por el dueño (analista de UX, no generada
acá): el frontend depende demasiado de `<Modal>` para un ERP — 12 archivos
de `dashboard/` lo usan, incluyendo entidades con perfiles extensos
(Clientes, Usuarios, Reservas, Estadías) que deberían tener URL propia en
vez de vivir comprimidas en un overlay de `max-w-md`. Verificado contra el
repo real antes de actuar: `productos/[id]/` existe como carpeta pero sin
`page.tsx` propio (solo `receta/` y `variantes/` adentro), confirmando el
hallazgo central de la auditoría.

Confirmado con el dueño: arrancar la migración ya, por **Clientes** — el
modal más extenso (perfil básico, etiquetas, datos fiscales, tarifas
especiales, ~330 líneas de JSX).

**Decisión técnica tomada sin preguntar aparte** (no es una decisión de
negocio, es un patrón ya establecido en el repo): página única con
secciones editables in-place, sin ruta `/edit` separada — mismo criterio
que `dashboard/ordenes/[id]/page.tsx` ("mejor patrón actual" según la
propia auditoría), no el patrón `[id]` + `[id]/edit` que proponía el
documento externo.

**Implementado:**
- `dashboard/clientes/[id]/page.tsx` nuevo — trasladó el contenido íntegro
  del modal de edición (`openEdit`, `handleSave`, tags, datos fiscales con
  autocompletado ARCA, tarifas especiales) a una página con breadcrumb
  ("← Clientes"), estado `loading`/`notFound` (siguiendo el patrón de
  `ordenes/[id]`) y 4 cards: Información básica, Etiquetas, Datos
  fiscales, Tarifas especiales.
- Detección de 404 vía `isApiError(err) && err.code === 'CUSTOMER_NOT_FOUND'`
  (`lib/apiErrors.ts`) — no `httpStatus`, que es justo lo que ese archivo
  pide no hacer. De paso quedó anotado (sin tocar): `ordenes/[id]/page.tsx`
  sí compara `err.status` para su 404, un campo que no existe en
  `ApiErrorWithStatus` (es `httpStatus`) — ese chequeo nunca es cierto, la
  pantalla "Orden no encontrada" probablemente no se muestra nunca y cae
  al toast de error genérico. No corregido ahora — fuera del alcance de
  esta sesión (es Órdenes, no Clientes), queda anotado para retomar.
- `dashboard/clientes/page.tsx` recortado: se sacó todo el estado y los
  handlers de edición/tags/datos fiscales/tarifas (ya no aplican al
  listado), la fila de la tabla y el botón "Editar" ahora navegan a
  `/dashboard/clientes/${id}` (`router.push` en la fila, `<Link>` en el
  botón, ahora "Ver detalle"). El modal de alta ("Nuevo cliente") se dejó
  intacto — alta mínima de 2 campos, calza con el criterio de la propia
  auditoría de qué sí puede seguir en modal.

**Verificado:** `tsc --noEmit` y `eslint` limpios en ambos archivos. En
navegador real contra `biz-demo-01`: listado → "Ver detalle" en Juan
García → URL propia (`/dashboard/clientes/e7c467db-...`), las 4 secciones
cargan con datos reales (incluye selects de Recurso/Servicio para tarifas
ya poblados). Prueba de escritura real: se agregó la etiqueta
"VIP-prueba-migracion" (persistió, `invalidate()` corrió bien) y se quitó
de nuevo (sin dejar datos de prueba). Botón "← Clientes" vuelve al listado
en `/dashboard/clientes`.

**Fuera de esta sesión, backlog priorizado por la auditoría (orden
sugerido, sin fecha):** Usuarios, Reservas, Estadías, Recursos,
Housekeeping, Productos (página base — hoy solo tiene `receta/` y
`variantes/` sin `[id]/page.tsx` propio), Turnos. Mismo patrón a replicar:
página única con secciones in-place, no `[id]/edit` separado.

**Retomado en la misma sesión — pedido explícito del dueño de dejar esto
como regla, no como hallazgo puntual:**
- `ordenes/[id]/page.tsx` — corregido el bug anotado arriba: comparaba
  `err.status` (campo inexistente en `ApiErrorWithStatus`, que es
  `httpStatus`) para detectar 404, así que "Orden no encontrada" nunca se
  mostraba. Cambiado a `isApiError(err) && err.code === 'ORDER_NOT_FOUND'`
  (mismo criterio que se usó al migrar Clientes). Verificado en navegador
  contra un id inexistente: ahora sí muestra "Orden no encontrada" en vez
  de caer al toast genérico. `tsc`/`eslint` limpios.
- La auditoría completa (inventario, evidencia por dominio, modelo de
  interacción, orden de migración) se guardó como documento vivo en
  `appfrontend-main/docs/auditoria-modales.md`, y la regla de "modal breve
  / panel lateral / ruta dedicada" quedó codificada en
  `appfrontend-main/CLAUDE.md` (sección "Interacción — modal, panel o
  ruta dedicada") — para que la migración de Usuarios, Reservas, etc. (y
  cualquier pantalla nueva que edite una entidad con relaciones o más de
  ~4 campos) siga ese patrón sin tener que redecidirlo cada vez.

---

## Auditoría UX — migración de modales a rutas dedicadas (Usuarios, Fase 2) — ✅ RESUELTO (25/08/2026)

Continuación directa de la Fase 1 (Clientes, sección de arriba) — mismo
orden de prioridad que fija `appfrontend-main/docs/auditoria-modales.md`.
Confirmado con el dueño: seguir con Usuarios.

**Implementado**, mismo patrón que Clientes (página única, secciones
in-place, sin `/edit` separado):
- `dashboard/usuarios/[id]/page.tsx` nuevo — sin `GET /api/users/:id` en
  el backend, así que reusa el mismo criterio que ya tenía el adapter
  `usuarios` de `lib/refine/dataProvider.ts`: `usersApi.list()` + buscar
  por id (si no aparece, "Usuario no encontrado"). Card "Información"
  (nombre, DNI, teléfono, legajo, fecha de ingreso, rol, contraseña o
  "enviar link" según el guard de jerarquía K1 ya existente) y card
  "Acceso" (desactivar — solo visible para el propietario, nunca para
  OWNER, con el mismo texto de antes cuando no corresponde).
- `dashboard/usuarios/page.tsx` recortado: se sacó todo el estado/lógica
  de edición (`editing`, `openEdit`, rama de update de `handleSubmit`,
  `canSetPasswordDirectly`, `handleSendResetLink`) y de borrado
  (`deleteTarget`, `handleDelete`, `useDelete`). El modal "Nuevo usuario"
  se dejó con todos sus campos tal cual estaban — **decisión: no
  reducirlo a alta mínima como se hizo con "Nuevo cliente"**, porque
  achicar qué pide el alta es una decisión de producto (qué es
  obligatorio vs. opcional al crear un empleado), no algo que esta
  migración de UI deba resolver de paso. La fila de la tabla y el botón
  ahora navegan a `/dashboard/usuarios/${id}` en vez de abrir el modal de
  edición. Invitaciones (lista + modal "Invitar por mail") se quedaron en
  el listado sin cambios — no son una membership todavía, no tienen
  detalle propio al que migrar.

**Verificado:** `tsc --noEmit` y `eslint` limpios. En navegador contra
`biz-demo-01`: editar y guardar el nombre completo de un usuario real
(Recepción) persistió y se reflejó en el listado; el diálogo "¿Desactivar
usuario?" abre correctamente con el email correcto — **cancelado a
propósito, sin confirmar**, para no desactivar de verdad una cuenta real
sin forma de reactivarla desde la UI todavía (`POST /users/:id/reactivate`
existe en el backend desde F2, 25/08/2026, pero sigue sin pantalla); "Nuevo
usuario" sigue funcionando igual que antes; `/dashboard/usuarios/<id
inexistente>` muestra "Usuario no encontrado".

**Nota de datos:** quedó un usuario de prueba real (`aleposmc@gmail.com`)
con el nombre "Ale Prueba Migracion" — no se pudo revertir a "sin nombre"
porque el formulario nunca mandó `fullName: null` (limitación preexistente,
no introducida acá: un string vacío se trata como "no cambiar este campo",
no como "vaciarlo" — mismo criterio en el modal viejo). No es dato
sensible, pero queda para quien lo note después.

**Backlog restante del orden de la auditoría, sin fecha:** Reservas,
Estadías, Recursos, Housekeeping, Productos, Turnos.

---

## Auditoría UX — migración de modales a rutas dedicadas (Reservas, Fase 3) — ✅ RESUELTO (25/08/2026)

Continuación directa de las Fases 1 (Clientes) y 2 (Usuarios) — mismo
orden de prioridad de `appfrontend-main/docs/auditoria-modales.md`.
Confirmado con el dueño: seguir con Reservas, la entidad de mayor riesgo
de negocio de la lista (transaccional, consecuencias financieras).

**Implementado**, mismo patrón que las dos fases anteriores (página única,
sin `/edit` separado):
- `dashboard/reservas/[id]/page.tsx` nuevo — usa `reservationsApi.get(id)`
  (GET real, ya existía, a diferencia de Usuarios). Una sola card
  "Detalle de reserva" que alterna vista/edición con un toggle
  (`editingDetail`) en vez de partirse en varias cards siempre-visibles —
  el modal original ya era una sola vista con ese mismo toggle, no varias
  secciones independientes como Clientes. Mantiene todo lo que tenía el
  modal: estado, huéspedes, notas, horario especial (pedir/aprobar/
  rechazar), botón "Facturar", y el preview de ajuste de precio con
  confirmación gateada a MANAGEMENT.
- `dashboard/reservas/page.tsx` recortado: se sacaron ~190 líneas de
  estado/handlers del modal de detalle. El drag-to-move del calendario
  (`handleCalendarUpdate`) se simplificó de paso — ya no necesita
  preguntar si el detalle de esa reserva estaba abierto en esta misma
  página para refrescar el ajuste de precio, porque el detalle ahora vive
  en otra ruta. La fila de la tabla y el click en una barra del calendario
  (`onReservationClick`) navegan a `/dashboard/reservas/${id}` en vez de
  abrir el modal.
- **`hooks/useReservationsScreen.ts` (compartido con Turnos) no se
  tocó** — ya declaraba explícitamente que el formulario de detalle no es
  su responsabilidad, así que esta migración no le afecta.
- "Nueva reserva" se queda en modal, sin tocar — mismo criterio que
  Clientes/Usuarios: reducir el alta a "modal breve" es una decisión de
  producto aparte, no parte de esta migración de UI.

**Verificado:** `tsc --noEmit` y `eslint` limpios. En navegador contra
`biz-demo-01`: reserva de prueba creada por API (PENDING, para no
depender de encontrar una reserva viva en el estado correcto) → abierta
en `/dashboard/reservas/<id>` → "Confirmar" (pasa a CONFIRMED, aparecen
los botones de edición/horario especial) → "Editar horario" cambia el
check-out (persistió, "Facturar" aparece porque ya había un CHARGE real
del confirm) → "Cancelar reserva" al final, sin dejar datos de prueba
activos. `/dashboard/reservas/<id inexistente>` → "Reserva no encontrada"
(código real `NOT_FOUND` del backend). Click en una barra del calendario
navega a la ruta de detalle igual que una fila de la tabla — probado
contra una reserva real ya existente en la demo.

**Backlog restante del orden de la auditoría, sin fecha:** Estadías,
Recursos, Housekeeping, Productos, Turnos.

---

## Auditoría UX — migración de modales a rutas dedicadas (Estadías, Fase 4) — ✅ RESUELTO (25/08/2026)

Continuación de las Fases 1-3. Confirmado con el dueño: seguir con todo el
backlog restante en una sola tanda ("hasta donde puedas, según el
límite").

**Implementado:** `dashboard/estadias/[id]/page.tsx` nuevo — sin
`GET /api/stays/:id`, reusa `staysApi.listActive()` + find por id (mismo
criterio que el adapter `estadias`; una estadía cerrada no aparece, mismo
alcance que ya tenía el listado). 3 cards: "Detalle", "Check-out" (folio
cargado automático al entrar, no al hacer click — la razón de fondo del
hallazgo original) con transferencia a cuenta por cobrar inline, y "No
show" con `ConfirmDialog`. Check-out/no-show navegan de vuelta al listado
al confirmar. `dashboard/estadias/page.tsx` recortado a listar + "Nuevo
check-in" (modal, sin tocar). Reemplazado el modal de no-show hecho a
mano por `ConfirmDialog` — el comentario que lo desaconsejaba
("colores hardcodeados fuera de Bastión") está desactualizado.

**Verificado:** `tsc`/`eslint` limpios. En navegador contra
`biz-demo-01`: la única estadía activa real (huésped real en check-in, no
dato de prueba) carga folio y las 3 cards correctas; diálogo de "No show"
abre bien — **cancelado sin confirmar**, para no cerrarle la estadía a un
huésped real solo para probar la UI. `/dashboard/estadias/<inexistente>`
→ "Estadía no encontrada".

---

## Auditoría UX — migración de modales a rutas dedicadas (Recursos, Fase 5) — ✅ RESUELTO (25/08/2026)

`dashboard/recursos/[id]/page.tsx` nuevo — mismo criterio de list+find que
el adapter `recursos`. Card "Información" (nombre, categoría, precio base
colapsado), card "Horario propio" (franjas + alta/baja) y card "Eliminar"
con `ConfirmDialog` (reemplaza el overlay de borrado hecho a mano).
`dashboard/recursos/page.tsx` recortado a listar + "Nuevo recurso"
(modal). Verificado con `tsc`/`eslint` y en navegador: franja horaria de
prueba agregada y quitada en Habitación 02 (persistió en ambos sentidos),
"Recurso no encontrado" para id inexistente.

---

## Auditoría UX — migración de modales a rutas dedicadas (Housekeeping, Fase 6) — ✅ RESUELTO (25/08/2026)

Caso distinto a Clientes/Usuarios/Reservas/Estadías/Recursos: la ficha del
rack se abre por RECURSO, no por tarea (una tarea es "recurso + fecha",
puede no existir ese día). `dashboard/housekeeping/[id]/page.tsx` — `id`
es el id del recurso, `date` viaja por query string (leída una sola vez
de `window.location.search` al montar, mismo criterio que
`portal/[businessSlug]/cuenta/reservas/page.tsx` para no arrastrar el
requisito de `<Suspense>` de `useSearchParams()`). 2 cards:
"Mantenimiento" (ventana activa + reactivar, o alta inline) y
"Tarea — {fecha}" (estado + acciones inline, o "Planificar tarea" inline
si no hay tarea ese día). El rack en sí no se tocó como entrada — la
auditoría ya lo marcaba como patrón correcto, solo el tile ahora navega
en vez de abrir modal.

**"Mis tareas" no migró a ruta** — es la lista de trabajo del
housekeeper logueado cruzando recursos/fechas distintas, no el detalle
de un recurso. Se quedó con su propio mini-modal de asignar/completar
(alcance recortado: ya no incluye la rama de ventana de mantenimiento,
exclusiva ahora de la ficha de detalle).

**Verificado:** `tsc`/`eslint` limpios. En navegador contra
`biz-demo-01`: click en una ficha del rack navega a
`/dashboard/housekeeping/<id>?date=...` con la fecha correcta ya cargada,
card de Mantenimiento y Tarea mostrando el estado real (INSPECTED, sin
ventana activa).

---

## Auditoría UX — migración de modales a rutas dedicadas (Productos, Fase 7) — ✅ RESUELTO (25/08/2026)

Primera página canónica real del producto (`dashboard/productos/[id]/page.tsx`)
— antes solo existían las subrutas `receta/` y `variantes/`, sin base
(`productsApi.get(id)`, GET real). 3 cards: "Información" (el form
completo de "Editar producto", movido tal cual del modal), "Empresa"
(compartir con la empresa o manejo completo de override de precio/receta
si ya está vinculado — antes `CompanyLinkModal` aparte) y "Eliminar" con
`ConfirmDialog` (antes un `confirm()` de navegador liso). El encabezado
linkea a `/receta` y `/variantes` cuando aplican.

`dashboard/productos/page.tsx` recortado: "Nuevo producto" se queda en
modal, "Merma" y "Producción" también (2-3 campos, no necesitan el
contexto completo). La fila navega a la ruta de detalle.

**Verificado:** `tsc`/`eslint` limpios. En navegador: producto de prueba
creado → cambiado a tipo Compuesto en el detalle (apareció "Armar en vivo
al vender" y el link "Ver receta →", ambos condicionales) → eliminado con
`ConfirmDialog` → vuelta automática al listado. "Producto no encontrado"
para id inexistente.

---

## Auditoría UX — migración de modales a rutas dedicadas (Turnos, Fase 8) — ✅ RESUELTO (25/08/2026)

Última entidad del backlog. `dashboard/turnos/[id]/page.tsx` — clon
recortado de `dashboard/reservas/[id]/page.tsx` (sin calendario, ajuste de
precio, facturación ni horario especial — específicos de alojamiento).
Una sola card con toggle vista/edición. `dashboard/turnos/page.tsx`
recortado, "Nuevo turno" se queda en modal.

**Verificado:** `tsc`/`eslint` limpios. En navegador: un turno real
(Completada) muestra los datos sin botones (correcto, estado terminal);
"Turno no encontrado" para id inexistente.

**Backlog de la auditoría de modales completo — las 8 entidades migradas
hoy: Clientes, Usuarios, Reservas, Estadías, Recursos, Housekeeping,
Productos, Turnos.** Detalle completo de cada fase en las secciones de
arriba y en `appfrontend-main/docs/auditoria-modales.md`.

---

## Pendientes heredados de `pendientes-2026-08-24.md`, todavía abiertos

- **C1-Fase B** — gateway de pago real, hold corto canal web, auto-release.
  Bloqueada hasta que el negocio elija un proveedor de pago (proyecto
  externo). No elegir ninguna opción sin el dueño.
- **Backlog de UI, backend-only sin pantalla:** configurar/cobrar seña
  desde la ficha de reserva (C1-Fase A); preview/confirmar reembolso al
  cancelar (C2); líneas reales de factura en el detalle (C3); número de
  reserva/cliente en listados + prefijo editable (D6); pantalla de
  reportes POS/CRM (D7); carga de IVA/unidad/código ARCA al crear producto
  (D8); verificación server-side de precio para productos en POS
  (D9-Parte 2).
- **Gap conocido de C1-Fase C:** una factura consolidada (`invoices.
  financial_transaction_id = null`) no aparece en `getByReservationId()`
  (nota de crédito, C2) ni en `getOutstandingByCustomerId()` (conciliación
  de pagos, I4) — ambas hacen `JOIN` directo contra esa columna. Aceptado
  a propósito para el recorte de esa sesión, revisar si hace falta más
  adelante.
- **I11 — pendiente de verificar:** correr el build real de Render (o al
  menos `npm run build` local) con Node 22 antes de deployar — no se
  probó el pipeline de deploy completo, solo el fix puntual.
- **Pantalla de reasignación/revisión** para reservas con
  `needsMaintenanceReview = true` — diferida a propósito.
