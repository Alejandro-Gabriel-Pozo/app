# M08 · Recursos y categorías

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

alta de recurso → categoría → horarios → disponibilidad → asignación → uso →
mantenimiento → baja

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "alta, categorización y horarios":** ✅ Completo
- **Flujo "baja":** ◇ Parcial — hay `DELETE`, y la regla de qué pasa con la
  historia no está uniformada
- **Flujo "mantenimiento":** ✅ Completo (vía `maintenance_windows`)

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la baja **con guardas**. `DELETE /resources/:id`
  rechaza con `409 RESOURCE_LOCKED_BY_SERVICE` si el recurso sigue bloqueado por
  un `bookable_service` activo `[V]`
  (`src/reservas/resources.routes.ts:25`).
- **Primer paso incompleto:** **el efecto de la baja sobre la historia**. La
  guarda mira `resource_locks`, no `reservations` ni `stays`. Y
  `housekeeping_tasks.resource_id` es `ON DELETE CASCADE`
  (`src/db/schema.sql:1870`), mientras `stays.resource_id` es `ON DELETE RESTRICT`
  (`src/db/schema.sql:1810`). Dos tablas que dependen del mismo recurso, dos
  reglas opuestas.

## 4. Severidad máxima

**S2** — no hay pérdida demostrada hoy; hay una inconsistencia de política de
borrado que puede producirla.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tablas | `resources` (`src/db/schema.sql:151`), `resource_categories` (`:86`), `resource_hours` (`:933`), `resource_locks` (`:225`) |
| Rutas | `src/reservas/resources.routes.ts:1` (8), `src/reservas/categories.routes.ts` (5) |
| Pantallas | `dashboard/recursos`, `dashboard/recursos/[id]`, `dashboard/categorias` |

## 6. Identidad

`[V]` UUID; para un maestro es defendible — un recurso se identifica por nombre
("102 · Doble"). ⊃ `A2-T01-002`, severidad baja.

`[V]` `resource_locks` tiene **clave primaria compuesta** `(service_id,
resource_id)` (`src/db/schema.sql:233`), no un UUID sintético. Correcto para una
tabla de relación.

## 7. Estados

`[V]` El recurso no tiene máquina de estados: tiene `active` (soft-delete) y su
disponibilidad se deriva de `resource_hours`, `resource_locks`,
`maintenance_windows` y las reservas vigentes. Es un modelo por composición, no
por estado, y está bien para lo que representa.

`[V]` `booking_mode IN ('slot','block','event')` en `bookable_services`
(`src/db/schema.sql:204`) es lo que define cómo se consume un recurso.

## 8. Documentos y movimientos

No aplica.

## 9. Saldos y reportes

`[V]` `GET /api/reports/occupancy/by-category` y `/underutilized` son los dos
reportes que explotan este módulo, y **los dos tienen panel**
(`datos/cobertura.csv`). Es de los pocos casos donde el dato y la pantalla
existen del mismo lado.

`[V]` `GET /resources/:id` y `GET /resources/:id/hours` figuran sin consumidor
(`datos/cobertura.csv`). Con pantalla de detalle existente
(`dashboard/recursos/[id]`), es probable falso positivo del cruce por query
string. `[H]` — confirmar leyendo `appfrontend-main/src/lib/recursos/api.ts`.

## 10. Permisos y segregación

`[V]` `STAFF` para leer (incluido `HOUSEKEEPING`, que necesita ver las
habitaciones), `MANAGEMENT` para escribir
(`src/reservas/resources.routes.ts:6`). Reparto correcto y con el motivo escrito.

`[V]` `GET /api/categories` va **sin `authorize()` a propósito**, con siete
líneas de comentario explicando que el portal de clientes logueado lo necesita y
advirtiendo que no se cierre sin verificar antes
(`src/reservas/categories.routes.ts:70`). Es un ejemplo de cómo se documenta una
excepción de seguridad para que no la "arregle" alguien de paso.

## 11. Auditoría y trazabilidad

`[V]` **`resources.routes.ts` sí audita**, y lo hace en la propia ruta, con
`diffFields` + `recordFieldChangesWithClient` dentro de transacción
(`src/reservas/resources.routes.ts:46`, `src/reservas/resources.routes.ts:49`). Junto con `customers.routes.ts`
son los dos únicos casos de auditoría escrita en la capa de rutas en vez del
servicio — inconsistencia de arquitectura menor, resultado correcto.

`[V]` `category.service.ts` audita del lado del servicio. Los dos caminos
conviven.

## 12. Errores, idempotencia y fallo parcial

`[V]` `POST`/`PUT` verifican que `categoryId` exista y esté activa antes de
guardar, devolviendo `422 INVALID_CATEGORY` en vez de un `500` por violación de
FK (`src/reservas/resources.routes.ts:22`).

`[V]` El `ZodError` se propaga con `next(err)` al handler central en vez de
manejarse inline, porque la versión inline no llamaba `.flatten()` y el
resaltado de campo del formulario nunca funcionaba
(`src/reservas/resources.routes.ts:13`). Es un bug de contrato entre repos, del
tipo exacto que el `CLAUDE.md` raíz dice que hay que buscar.

## 13. Capacidad ausente

1. **Política de borrado uniforme.** `CASCADE` en housekeeping y `RESTRICT` en
   estadías, sobre el mismo recurso.
2. **Categoría en `resource_locks`.** ↔ ítem "deuda activa" de
   `pendientes-2026-09-01.md`.
3. **Atributos de recurso** (capacidad, amenities, piso, vista) más allá de
   `VisualMetadata`. `[H]` — a confirmar leyendo `resource.entities.ts`.
4. **Historial de estado del recurso.** No se puede reconstruir qué habitaciones
   estuvieron fuera de servicio el mes pasado sin leer `maintenance_windows` a
   mano.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M08-001` | S2 | Política de borrado inconsistente: `CASCADE` en `housekeeping_tasks`, `RESTRICT` en `stays`, sobre el mismo `resource_id`. | `src/db/schema.sql:1870` vs `:1810` | **nuevo** |
| `A2-M08-002` | S3 | La guarda del `DELETE` mira `resource_locks`, no reservas ni estadías. | `src/reservas/resources.routes.ts:25` | **nuevo** |
| `A2-M08-003` | S3 | Sin historial consultable de disponibilidad del recurso. | ausencia de endpoint | **nuevo** |
| `A2-M08-004` | S4 | `resource_locks` sin categoría. | — | ↔ ítem "deuda activa" de `pendientes-2026-09-01.md` |
| `A2-M08-005` | S4 | La auditoría vive en la capa de rutas, no en el servicio, en dos módulos. | `src/reservas/resources.routes.ts:46` | **nuevo** |
| `A2-M08-006` | S4 | Dos endpoints figuran sin consumidor; probable falso positivo del cruce. | `datos/cobertura.csv` | **nuevo** `[H]` |

## 15. Criterios de cierre

- Hay una regla escrita de qué pasa con la historia al borrar un recurso, y las
  FKs la respetan.
- La guarda del `DELETE` cubre todas las tablas con historia.
- Los dos endpoints sin consumidor están confirmados como usados o retirados.
