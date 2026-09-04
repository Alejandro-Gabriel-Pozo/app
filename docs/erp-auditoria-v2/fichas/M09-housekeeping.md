# M09 · Housekeeping y ventanas de mantenimiento

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

planificación de turno → asignación → ejecución → inspección → cierre →
puesta fuera de servicio

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "planificar, asignar, ejecutar, inspeccionar":** ✅ Completo
- **Flujo "fuera de servicio":** ◇ Parcial — el estado quedó en el `CHECK`
  después de que su mecanismo se retiró
- **Flujo "quién hizo la tarea":** ◇ Parcial

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la inspección, con actor propio.
  `inspected_by` e `inspected_at` son columnas de la tabla `[V]`
  (`src/db/schema.sql:1880`, `:1879`), y el endpoint pide
  `HOUSEKEEPING_AND_MANAGEMENT` (`src/pms-estadias/housekeeping.routes.ts:18`).
- **Primer paso incompleto:** **la ejecución no registra quién**. `assigned_to`
  dice a quién se le asignó (`src/db/schema.sql:1871`), pero `started_at` y
  `completed_at` no tienen columna de actor: si la tarea se reasigna, no queda
  quién la hizo de verdad.

## 4. Severidad máxima

**S2** — no toca plata ni documentos; sí toca la responsabilidad sobre una
habitación entregada.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tablas | `housekeeping_tasks` (`src/db/schema.sql:1867`), `maintenance_windows` (`:3077`) |
| Servicios | `src/pms-estadias/housekeeping.service.ts` (138 líneas), `src/pms-estadias/maintenance-window.service.ts` |
| Rutas | `src/pms-estadias/housekeeping.routes.ts:1` (11), `src/pms-estadias/maintenance-windows.routes.ts` (4) |
| Pantallas | `dashboard/housekeeping`, `dashboard/housekeeping/[id]` |
| Gate | `requireModule(HOUSEKEEPING)` (`src/app.ts:433`, `:447`) |

## 6. Identidad

`[V]` UUID sin identidad operativa. Para una tarea diaria de limpieza es
defendible; se identifica por habitación y turno. ⊃ `A2-T01-002`, severidad
baja.

`[V]` `resource_id` es `ON DELETE CASCADE` (`src/db/schema.sql:1870`) — el único
`CASCADE` de las tablas operativas auditadas. Borrar un recurso borra su
historial de limpieza. Es defendible (la tarea no tiene sentido sin la
habitación) y conviene tenerlo escrito: es una decisión distinta a la del resto
del repo, que usa `RESTRICT`.

## 7. Estados

`[V]` `status IN ('PENDING','ASSIGNED','IN_PROGRESS','DONE','INSPECTED','OUT_OF_SERVICE')`
(`src/db/schema.sql:1873`), con timestamp por transición
(`started_at`, `completed_at`, `inspected_at`).

`[V]` **`OUT_OF_SERVICE` quedó huérfano dentro del enum.** Los endpoints
`POST /:id/out-of-service` y `/:id/reset` se borraron el 25/08/2026 cuando
`maintenance_windows` reemplazó ese mecanismo, y el valor sigue en el `CHECK`
(`src/pms-estadias/housekeeping.routes.ts:21`; `src/db/schema.sql:1873`). Es un
estado alcanzable sólo por filas viejas: no hay camino desde el producto.

`[V]` `shift IN ('MORNING','AFTERNOON','NIGHT')` `NOT NULL`
(`src/db/schema.sql:1875`).

## 8. Documentos y movimientos

No aplica: el módulo no produce documentos ni mueve plata. **Y ahí está la
observación**: una habitación fuera de servicio o un late check-out no generan
ningún efecto económico, aunque los dos lo tienen en el negocio real.
↔ `A2-M15-005`.

## 9. Saldos y reportes

`[V]` Cuatro de los once endpoints de housekeeping no tienen consumidor:
`GET /`, `/late-checkouts`, `/resource/:resourceId`, `/:id`
(`datos/cobertura.csv`). El tablero diario existe como pantalla, así que al
menos parte de eso es falso positivo del cruce — pero `late-checkouts` sí
está sin usar y era la razón de ser del badge que documenta la propia ruta
(`src/pms-estadias/housekeeping.routes.ts:10`).

`[V]` Ningún reporte de productividad: tareas por empleado, tiempo promedio,
tasa de rechazo en inspección. El dato está (tres timestamps por tarea) y no se
explota.

## 10. Permisos y segregación

`[V]` **Es el módulo con el reparto de roles más fino del sistema**, y el único
con segregación explícita entre ejecutar e inspeccionar: `HOUSEKEEPING` inicia y
completa, `HOUSEKEEPING_AND_MANAGEMENT` inspecciona, `MANAGEMENT` planifica y
asigna (`src/pms-estadias/housekeeping.routes.ts:8`).

Vale subrayarlo: **la segregación de funciones existe en el sistema, y está
aplicada a la limpieza de habitaciones, no a la plata.**

## 11. Auditoría y trazabilidad

`[V]` `housekeeping.service.ts` no escribe `audit_log` (`grep -c` = `0`). El
rastro que hay es el de las columnas propias, y es incompleto: `assigned_to` e
`inspected_by`, sin `started_by` ni `completed_by`.

## 12. Errores, idempotencia y fallo parcial

`[V]` El índice por fecha se creó sin cast a `::date` con el motivo escrito:
`timestamptz → date` depende del `TimeZone` de sesión, Postgres lo marca
`STABLE` y rechaza el índice funcional (`src/db/schema.sql:1885`). Es
exactamente el tipo de detalle que el playbook de fechas del repo existe para
conservar (`docs/conocimiento/playbook-fechas-timezone.md`).

`[H]` No verificado: si dos empleados pueden iniciar la misma tarea a la vez.
No hay índice único ni `FOR UPDATE` visible en el schema.

## 13. Capacidad ausente

1. **Actor de la ejecución** (`started_by` / `completed_by`).
2. **Reportes de productividad.**
3. **Limpiar el enum**: `OUT_OF_SERVICE` sin camino.
4. **Consumo de insumos por tarea.** El módulo de inventario tiene
   `CONSUMPTION` como tipo de movimiento (`src/db/schema.sql:1800`) y
   housekeeping no lo usa: limpiar no descuenta amenities.
5. **Checklist por tipo de habitación.** La tarea es una sola unidad; no hay
   ítems.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M09-001` | S2 | No se registra quién ejecutó la tarea, sólo a quién se asignó. | `src/db/schema.sql:1871`; sin `started_by`/`completed_by` | ⊃ `A2-T03-001` |
| `A2-M09-002` | S2 | `late-checkouts` no tiene consumidor: el badge que la ruta documenta no existe. | `datos/cobertura.csv`; `src/pms-estadias/housekeeping.routes.ts:10` | **nuevo** |
| `A2-M09-003` | S3 | `OUT_OF_SERVICE` sigue en el `CHECK` sin camino desde el producto. | `src/db/schema.sql:1873`; `src/pms-estadias/housekeeping.routes.ts:21` | **nuevo** |
| `A2-M09-004` | S3 | Limpiar no descuenta insumos, aunque el tipo de movimiento existe. | `src/db/schema.sql:1800` | **nuevo** |
| `A2-M09-005` | S3 | Sin reportes de productividad, con los datos ya cargados. | `datos/cobertura.csv` | **nuevo** |
| `A2-M09-006` | S3 | `ON DELETE CASCADE` borra el historial de limpieza al borrar el recurso. | `src/db/schema.sql:1870` | **nuevo** |
| `A2-M09-007` | S4 | Sin checklist por tipo de habitación. | ausencia de tabla | **nuevo** |
| `A2-M09-008` | S4 | No verificado si dos empleados pueden iniciar la misma tarea. | ausencia de índice único | **nuevo** `[H]` |

## 15. Criterios de cierre

- La tarea registra quién la inició y quién la completó.
- `OUT_OF_SERVICE` se retira del enum o recupera un camino.
- Hay al menos un reporte de productividad.
- Está decidido si limpiar consume insumos.
