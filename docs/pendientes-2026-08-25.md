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
- **F2** — research amplio contra normativa nacional para ABM de usuarios,
  nadie lo pidió puntualmente todavía.
- **L** — reconciliar roles/asientos al bajar de plan (downgrade, sigue
  laxo) — sigue abierto, es una decisión de negocio (¿bloquear el
  downgrade si sobran asientos/roles, desactivar membresías más nuevas
  automático, o algo intermedio?), no se resolvió sin confirmar con el
  dueño.
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
