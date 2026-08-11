# Lógica de Recursos, Categorías y Reservas

> ⚠️ **ACTUALIZACIÓN (11/08/2026):** este documento describe el diseño original
> (Opción A: tablas nuevas `physical_resources` + `resource_physical_locks`,
> endpoints `/resources/:id/physical-locks`). **Nunca se implementó tal cual.**
> La versión real, ya en producción, reutiliza `resources` (ya es el recurso
> físico — la clase de dominio se llama `PhysicalResource`) + `bookable_services`
> (con `duration_minutes`) + una tabla `resource_locks(service_id, resource_id,
> sort_order)`. La lógica de bloqueo vive en
> `ReservationService.resolveLockedResourceIds()` /
> `resolveOccupyingReservations()` (`src/services/reservation.service.ts`).
> Gestión (CRUD de locks) en `ResourceLockService` +
> `PUT /api/bookable-services/:id/resource-locks`. UI en
> `appfrontend/src/app/dashboard/servicios`.
>
> Las respuestas a las "Preguntas abiertas" de este doc siguen siendo válidas
> como decisión de producto (ver más abajo), pero el modelo de datos y los
> nombres de tabla/endpoint descriptos en el resto del documento son historia,
> no lo que hay que construir. No re-derivar Opción A desde cero.

## El problema central: recursos que bloquean recursos

El modelo actual de `bookable_resources` asume que cada recurso es independiente.
Un recurso ocupa un slot de tiempo y ese slot queda bloqueado solo para ese recurso.

Pero en la realidad, múltiples recursos de un negocio comparten un mismo **recurso físico subyacente**. En una peluquería:

| Servicio (recurso lógico) | Duración aprox. | Recurso físico que ocupa |
|---------------------------|-----------------|---------------------------|
| Corte de pelo             | 30 min          | Silla 1 + Estilista A     |
| Tintura                   | 90 min          | Silla 1 + Estilista A     |
| Permanente                | 120 min         | Silla 1 + Estilista A     |

Si "Corte de pelo" está reservado de 10:00 a 10:30, ninguno de los otros dos puede reservarse en ese mismo horario porque **la silla y el estilista ya están ocupados**. Hoy el sistema no sabe esto: trataría los tres como recursos independientes y permitiría la superposición.

---

## Modelo actual (cómo está hoy)

```
resource_categories
  id, name, description, fields[], active

bookable_resources
  id, name, base_price, category_id, capacity, description, visual_data
```

La **categoría** agrupa recursos por tipo semántico (ej. "Servicios de cabello").
El **recurso** es la unidad reservable.
La **reserva** bloquea un recurso en un rango de tiempo.

Lo que falta: ninguna entidad modela que "Corte", "Tintura" y "Permanente" compiten por el mismo recurso físico.

---

## Concepto nuevo: Recurso Físico Compartido (Physical Resource)

Un **recurso físico** (silla, habitación, cancha, estilista) es la unidad real de capacidad limitada.
Un **recurso lógico** (servicio) consume uno o más recursos físicos por su duración.

La relación es:

```
physical_resources          ← entidad nueva
  id, name, description

bookable_resources          ← ya existe
  id, name, ...
  duration_minutes          ← nuevo campo (ver sección de duración)

resource_physical_locks     ← tabla de relación nueva
  resource_id → bookable_resources.id
  physical_resource_id → physical_resources.id
```

Cuando se intenta reservar "Corte de pelo", el sistema busca todos los `physical_resource_id` que ese recurso bloquea, y verifica que ninguno esté ocupado en ese horario por otra reserva activa.

---

## Alternativas de implementación

### Opción A: Tabla `physical_resources` + `resource_physical_locks` (recomendada)
**Ventajas:**
- Modela la realidad con precisión. Un recurso puede bloquear N recursos físicos.
- Extensible: en el futuro un servicio puede bloquear "estilista + cabina + secador".
- La query de disponibilidad es explícita y auditable.
- Permite gestionar recursos físicos desde la UI (agregar sillas, estilistas, etc.).

**Desventajas:**
- Requiere migration nueva, nueva entidad en el dominio, nueva UI para gestionar físicos.
- La query de disponibilidad se complica: hay que hacer JOIN con `resource_physical_locks` y verificar que ningún lock esté bloqueado.

### Opción B: `shared_resource_id` en `bookable_resources`
Agregar un campo `shared_resource_id UUID` (self-referencing FK) que apunta a un "recurso padre" representando el recurso físico.

```
bookable_resources
  id, name, ..., shared_resource_id (nullable, FK → bookable_resources.id)
```

"Corte", "Tintura" y "Permanente" apuntarían todos al mismo `shared_resource_id`.

**Ventajas:** Sin migration de tabla nueva. Más simple de implementar.

**Desventajas:**
- Un recurso no puede bloquear múltiples físicos (estilista Y silla son dos físicos distintos).
- El "recurso padre" es un concepto confuso — aparece mezclado con los reservables reales.
- Difícil de extender. No modela bien negocios con recursos físicos múltiples.

### Opción C: Tabla `resource_groups`
Un grupo es un conjunto de recursos que no se pueden reservar simultáneamente.

```
resource_groups         ← entidad nueva
  id, name

resource_group_members  ← relación
  group_id, resource_id
```

**Ventajas:** Simple de entender.

**Desventajas:**
- No escala cuando un recurso pertenece a múltiples grupos con distintas reglas.
- Más difícil modelar "este recurso bloquea solo 1 de los 3 físicos de un grupo".

---

## Recomendación

**Opción A** — `physical_resources` + `resource_physical_locks`.

Es la única que modela correctamente el caso donde un servicio bloquea múltiples recursos físicos independientes (ej. permanente = estilista + cabina). Las otras dos opciones requieren hacks para casos simples y no escalan.

---

## Lógica de duración

Hoy `bookable_resources` no tiene campo de duración. La reserva tiene `start_time` y `end_time`, lo que implica que quien reserva elige la duración libremente. Para servicios con duración predefinida esto no es correcto.

### Campo `duration_minutes` en `bookable_resources`

```sql
ALTER TABLE bookable_resources
  ADD COLUMN duration_minutes INTEGER;  -- nullable: null = el usuario elige
```

**Comportamiento:**
- Si `duration_minutes` está seteado: el frontend lo usa como duración fija y solo pide `start_time`. El `end_time` se calcula automáticamente (`start + duration_minutes`).
- Si `duration_minutes` es null: el frontend muestra picker de inicio y fin (comportamiento actual, para recursos como habitaciones).

**Quién puede editarlo:** MANAGEMENT (OWNER + ADMIN). No RECEPTIONIST ni CUSTOMER.

### Query de disponibilidad futura

Al calcular slots disponibles, hay que verificar que el intervalo `[start, start + duration_minutes]` no colisione con ninguna reserva existente sobre el mismo recurso **ni sobre ningún recurso físico compartido**.

```sql
-- Pseudocódigo de la query de disponibilidad
SELECT r.id
FROM reservations r
  JOIN resource_physical_locks rpl ON rpl.resource_id = r.resource_id
WHERE rpl.physical_resource_id IN (
    SELECT physical_resource_id
    FROM resource_physical_locks
    WHERE resource_id = $target_resource_id
  )
  AND r.status NOT IN ('CANCELLED')
  AND r.start_time < $proposed_end
  AND r.end_time   > $proposed_start
```

Si esta query retorna filas, el slot no está disponible aunque el recurso lógico específico esté libre.

---

## Flujo de configuración (backoffice)

1. **MANAGEMENT crea recursos físicos:** "Silla 1", "Estilista Ana", "Cabina VIP".
2. **MANAGEMENT crea recursos lógicos (servicios):** "Corte", "Tintura", "Permanente", cada uno con su `duration_minutes` y su `base_price`.
3. **MANAGEMENT asigna locks:** "Corte" bloquea [Silla 1, Estilista Ana]. "Tintura" bloquea [Silla 1, Estilista Ana]. Etc.
4. **RECEPTIONIST / CUSTOMER** elige un servicio, el sistema calcula `end_time = start + duration_minutes` y verifica disponibilidad real contra los recursos físicos bloqueados.

---

## Impacto en el codebase actual

| Componente | Cambio |
|---|---|
| DB migration | Nueva tabla `physical_resources`, nueva tabla `resource_physical_locks`, campo `duration_minutes` en `bookable_resources` |
| `sql.resource.repository.ts` | Nuevo método `findPhysicalLocks(resourceId)` |
| `reservation.service.ts` | `checkAvailability()` debe consultar locks físicos |
| `category.service.ts` | Sin cambios — las categorías son semánticas, no de disponibilidad |
| `resources.routes.ts` | Nuevos endpoints: `GET/POST /resources/:id/physical-locks` |
| Frontend | Nueva pantalla de gestión de recursos físicos + asignación de locks |

---

## Preguntas abiertas (decidir antes de codificar)

1. ¿Un negocio sin servicios (ej. hotel con habitaciones) necesita recursos físicos? → Probablemente no. El campo `duration_minutes` y los locks deberían ser opcionales.
2. ¿Los recursos físicos son visibles en el portal del cliente (`/api/customer`)? → No, son configuración interna.
3. ¿Qué pasa si se elimina un recurso físico que tiene locks activos? → Soft-delete del físico + alerta en UI.
4. ¿La duración predefinida puede ser sobreescrita por el cliente en el portal? → Probablemente no, pero el RECEPTIONIST sí debería poder ajustarla al reservar manualmente.
