# Pendientes — Lunes 10 de Agosto 2026

## Fixes de Código

### 1. `resources.routes.ts` — ZodError inline (menor)
`ZodError` se maneja localmente en POST y PUT en lugar de subir por `next(err)` al errorHandler central.
El errorHandler ya lo captura como caso #1. Eliminar el `catch (ZodError)` inline para consistencia total con el resto de las rutas.
- **Archivo:** `src/api/routes/resources.routes.ts`
- **Acción:** Reemplazar los `catch (err instanceof ZodError)` por `next(err)` simple

---

## Diseño de Dominio

### 2. Lógica de recursos compartidos / conflicto de disponibilidad
Ver documento `logica-recursos-categorias-reservas.md` para el análisis completo.

**Decisión de arquitectura pendiente:**
- ¿Se implementa el concepto de "recurso físico compartido" (silla, estilista) como una entidad nueva, o como una relación entre recursos existentes?
- Opciones: `shared_resource_id` en `bookable_resources`, tabla de `resource_groups`, o tabla de `resource_constraints`.
- Impacto en: query de disponibilidad, lógica de reservas, UI del frontend.

**Antes de codificar:**
- Definir si el tiempo de duración va en el recurso (predefinido) o en la reserva (configurable por caso).
- Definir quién puede ver/editar la duración: solo MANAGEMENT o también RECEPTIONIST.

---

## Revisión Pendiente

### 3. `domainErrorStatus()` en `error.middleware.ts` — códigos nuevos sin mapeo
Los errores de `order.service.ts` (`ORDER_NOT_FOUND`, `ORDER_NOT_EDITABLE`, `INVALID_TRANSITION`) y de `bookable-service.service.ts` (`NOT_FOUND`, `SCHEDULE_CONFLICT`) se capturan localmente en sus rutas. Si alguna ruta nueva olvida capturarlos, caen al default 500.
- **Acción:** Agregar estos códigos al switch de `domainErrorStatus()` como red de seguridad.

### 4. Verificación del fix C1 (categoría borrada → 422)
Confirmar que el flujo completo POST /resources con `categoryId` de categoría soft-deleted retorna 422 y no 500. Hacer un test manual o unitario.

---

## Frontend (`appfrontend`)

### 5. UI de categorías
- Pantalla de gestión de categorías (crear, editar, desactivar)
- Mostrar `fields` como formulario dinámico al crear/editar un recurso de esa categoría
- Pendiente: definir UX para recursos con "recurso físico compartido" (ver punto 2)

### 6. UI de servicios agendables (`bookable-services`)
- Pantalla de gestión de servicios y sus horarios
- Solo visible para MANAGEMENT
- Los horarios (schedules) necesitan un picker de días de semana + rango horario

---

## Infraestructura

### 7. Migrations pendientes
Verificar que todas las tablas nuevas del audit tienen su migration en Neon:
- `resource_categories` — ¿tiene `active` column? ¿tiene índice en `active`?
- `bookable_services` y `service_schedules` — verificar que existen en ambas DBs (PLATFORM y TENANT)

### 8. Variables de entorno en Render
Confirmar que `CORS_ORIGIN` está seteada apuntando al dominio del frontend en producción. Sin esto, las requests del frontend en prod fallan silenciosamente.
