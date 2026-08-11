# Pendientes — Lunes 10 de Agosto 2026

## Fixes de Código

### 1. `resources.routes.ts` — ZodError inline (menor)
`ZodError` se maneja localmente en POST y PUT en lugar de subir por `next(err)` al errorHandler central.
El errorHandler ya lo captura como caso #1. Eliminar el `catch (ZodError)` inline para consistencia total con el resto de las rutas.
- **Archivo:** `src/api/routes/resources.routes.ts`
- **Acción:** Reemplazar los `catch (err instanceof ZodError)` por `next(err)` simple

---

## Diseño de Dominio

### 2. Lógica de recursos compartidos / conflicto de disponibilidad — ✅ RESUELTO
Ver `plan-multirubro.md` (actualizado) — el diseño real terminó siendo distinto al
que describía `logica-recursos-categorias-reservas.md` originalmente.

Implementado vía `resource_locks` (`resources` = recurso físico, `bookable_services`
con `duration_minutes`, tabla `resource_locks` service↔resource). Gestión completa
(CRUD de locks, reserva por duración, `checkAvailability` consciente de locks) agregada
en la sesión del 11/08/2026. Ver `ReservationService.resolveOccupyingReservations()`.

**Deuda pendiente conocida, dejada afuera a propósito:** la disponibilidad del portal
de clientes (`GET /api/customer/:businessSlug/availability`) tiene su propia lógica
ad-hoc que todavía NO consulta `resource_locks` — no está scopeada por `serviceId` hoy
(filtra por categoría), así que no hay forma de resolver los locks sin antes tener una
UI de reserva por servicio en el portal público. Revisar cuando exista esa UI.

---

## Revisión Pendiente

### 3. `domainErrorStatus()` en `error.middleware.ts` — códigos nuevos sin mapeo — ✅ RESUELTO
`OrderNotFoundError`, `OrderNotEditableError`, `InvalidOrderTransitionError`,
`BookableServiceNotFoundError`, `ServiceScheduleNotFoundError` y `ScheduleConflictError`
ahora extienden `DomainError` (antes extendían `Error` a secas, por lo que agregar
el `case` al switch no habría hecho nada — nunca llegaban a `instanceof DomainError`).
Agregados los `case` correspondientes.

### 4. Verificación del fix C1 (categoría borrada → 422)
Confirmar que el flujo completo POST /resources con `categoryId` de categoría soft-deleted retorna 422 y no 500. Hacer un test manual o unitario.

---

## Frontend (`appfrontend`)

### 5. UI de categorías
- Pantalla de gestión de categorías (crear, editar, desactivar)
- Mostrar `fields` como formulario dinámico al crear/editar un recurso de esa categoría
- Pendiente: definir UX para recursos con "recurso físico compartido" (ver punto 2)

### 6. UI de servicios agendables (`bookable-services`) — parcial
- Pantalla de gestión de servicios (`/dashboard/servicios`) + asignación de recursos
  físicos bloqueados agregada en la sesión del 11/08/2026.
- Pendiente: UI de horarios (`service_schedules` — picker de día de semana + rango horario).

---

## Infraestructura

### 7. Migrations pendientes
Verificar que todas las tablas nuevas del audit tienen su migration en Neon:
- `resource_categories` — ¿tiene `active` column? ¿tiene índice en `active`?
- `bookable_services` y `service_schedules` — verificar que existen en ambas DBs (PLATFORM y TENANT)

### 8. Variables de entorno en Render
Confirmar que `CORS_ORIGIN` está seteada apuntando al dominio del frontend en producción. Sin esto, las requests del frontend en prod fallan silenciosamente.
