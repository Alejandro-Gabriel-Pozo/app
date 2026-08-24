# Housekeeping — Ventana de mantenimiento / fuera de servicio

> **Sin implementar (24/08/2026).** Documento traído por el dueño desde una
> carpeta externa a este repo — diseño de otra sesión, movido acá como
> referencia. Ver `pendientes-2026-08-24.md`. El dueño eligió encarar I11
> primero; esto queda para retomar en una sesión aparte. Antes de tocar
> código: pasa por `criterios-negocio` (entidad nueva, `maintenance_window`)
> y confirmar el diseño con el dueño — es un documento de otra sesión, no
> una decisión ya cerrada con él en esta.

## 1. Bug que originó esto

Una habitación quedó en `OUT_OF_SERVICE` sin forma clara de destrabarla desde la vista normal del día.

**Causa raíz:** el modelo actual mezcla dos cosas que deberían ser independientes:
- La tarea diaria de limpieza (`housekeeping_tasks`, creada por `StayService` post-checkout).
- El estado "fuera de servicio", que hoy es solo un valor más de `status` en esa misma tarea puntual.

Consecuencias del bug puntual:
- `isOutOfService()` (en `reservation-availability.service.ts`) mira la tarea más reciente por `scheduled_for`, sin importar el día — correctamente sigue bloqueando.
- El tablero diario (`GET /housekeeping?date=hoy`) filtra estrictamente por fecha — si no se generó tarea nueva "hoy" (porque el recurso está fuera de servicio y nadie hace checkout ahí), **la tarea que bloquea no aparece en la vista del día**, así que no hay forma visible de encontrarla para resetearla (`POST /housekeeping/:id/reset`).
- Vía de escape existente pero poco visible: `GET /housekeeping/status/OUT_OF_SERVICE` lista todas las tareas en ese estado sin filtrar por fecha.
- Nota aparte: `ReportService.filterOutOfService` usa `findByStatus('OUT_OF_SERVICE')` (todas las filas históricas), mientras que el bloqueo real usa "la más reciente" — son dos criterios distintos que conviene unificar cuando se rediseñe.

**Conclusión:** el bug es síntoma de un problema de modelo, no un fix puntual. Hace falta una entidad separada de la tarea de limpieza.

## 2. Decisión de producto: "fuera de servicio" funciona como una estadía

En vez de un flag sobre una tarea puntual, debe ser una entidad con **inicio y fin**, igual que una reserva/estadía.

### Entidad nueva: `maintenance_window`

- `resourceId`
- `startDate`
- `endDate` — **nullable**. Si es null, la ventana está abierta ("hasta nuevo aviso") y se va renovando día a día en vez de expirar sola.
- `businessId` (scoping multi-tenant, como el resto del sistema)

Cerrar la ventana (poner `endDate`) es la única forma de liberar el recurso — reemplaza al `reset` actual sobre la tarea de limpieza, y es mucho más visible/explícito que buscar una tarea vieja.

## 3. Comportamiento según `endDate`

### Con `endDate` definido
Simple: cualquier reserva que se solape con `[startDate, endDate]` se rechaza. Después de `endDate` el recurso se libera solo. Igual que un bloqueo de fechas fijo.

### Sin `endDate` (abierta, "hasta nuevo aviso")

Decisión tomada: **bloqueo con horizonte configurable por negocio** (no un valor fijo hardcodeado — cada negocio define cuántos días de anticipación quiere bloquear).

- Reserva pedida dentro de `hoy + horizonDays` → **rechazada**, recurso no disponible.
- Reserva pedida más allá del horizonte → **se acepta**, pero queda marcada (`needsMaintenanceReview: true` o similar) para revisión.

**Punto resuelto en esa sesión — qué hacer con la marca de revisión:**

No hace falta escalada automática por fecha (ej. "avisar más fuerte cuando falten 15 días"). En su lugar:

- La reasignación se resuelve reutilizando `findAvailableResourceInCategory()` (la misma función ya usada para el checkbox "cualquier recurso disponible" de K4 en Reservas/Turnos).
- En la pantalla donde se listan las reservas marcadas para revisión, correr esa búsqueda al mostrarlas: si hay otro recurso de la misma categoría libre para esas fechas, ofrecer reasignar con un click.
- Si se reasigna, la reserva deja de depender del recurso en mantenimiento y la marca se cierra sola.
- Si no hay alternativa disponible (categoría completa esos días), queda a criterio humano decidir si esperar y re-chequear más cerca de la fecha, o avisarle al cliente.

Este chequeo se puede correr cada vez que alguien entra a la pantalla de revisión — se va resolviendo naturalmente antes de que sea urgente, sin necesidad de un job/cron de escalada.

**Caso sin resolver todavía:** categoría de un solo recurso (sin alternativa posible por definición). Ahí no hay reasignación disponible nunca — habría que pensar si esas reservas se marcan distinto o se comunican distinto al cliente desde el vamos.

## 4. Fuera de scope de esta ventana (features separadas, anotadas para más adelante)

- **Tablero en vivo para maestranza:** estados que el equipo de limpieza pueda controlar en tiempo real (tomar tarea, marcar en progreso, completar), independiente de si el disparador fue un checkout. Pensado idealmente para manejarse desde celular/app. No forma parte de este spec, queda como feature aparte.
- **Asignación de tareas / late check-out:** separar "qué generó la necesidad de limpieza" (hoy: checkout) de "cómo la gestiona maestranza" — el `notBefore` actual seguiría existiendo como restricción de cuándo puede arrancar una tarea, no como único disparador de que exista.

## 5. Archivos relevantes del código actual (para ubicarse rápido)

- `src/pms-estadias/housekeeping-task.ts` — dominio de la tarea de limpieza (estados, transiciones, `isOutOfService`)
- `src/pms-estadias/housekeeping.repository.ts` — queries SQL (incluye el fix de J3: `scheduled_for <= NOW() ORDER BY scheduled_for DESC, updated_at DESC LIMIT 1`)
- `src/pms-estadias/in-memory.housekeeping.repository.ts` — espejo in-memory, mismo fix aplicado
- `src/pms-estadias/housekeeping.service.ts` / `housekeeping.routes.ts` — capa de servicio y endpoints (incluye `POST /:id/reset` y `GET /status/:status`)
- `src/services/report.service.ts` — `filterOutOfService`, usa `findByStatus` (criterio distinto al de bloqueo, revisar al unificar)
- Función a reutilizar para reasignación: `findAvailableResourceInCategory()` (K4, Reservas/Turnos)
