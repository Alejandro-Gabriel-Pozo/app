# T03 · Auditoría y trazabilidad

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

> Esta ficha se lee antes que las de módulo. Casi todas responden "ver T03" en
> su sección 11, y el motivo está acá: la limitación no es de cada módulo, es
> del modelo de auditoría.

## 1. Flujo auditado

hecho ocurre → se registra actor → se registra contexto (cuándo, desde dónde,
por qué) → se correlaciona con los demás efectos del mismo hecho → alguien lo
consulta

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "modificación de un campo de un maestro":** ◇ Parcial (registra, no se
  puede consultar de forma útil)
- **Flujo "acción de negocio" (confirmar, cancelar, cobrar, anular):** ◌ No
  existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** el registro del cambio de campo, transaccional
  junto con el `UPDATE` de la entidad `[V]` (`src/domain/audit.ts:95`,
  `recordFieldChangesWithClient`).
- **Primer paso incompleto:** **el registro del hecho de negocio**. `audit_log`
  guarda diferencias de campo, no acciones. Confirmar una reserva, cobrar,
  cancelar, anular un pago o cerrar una caja no dejan ninguna fila.

## 4. Severidad máxima

**S0** — junto con `A2-M04-001` (pago sin reversión gobernada). La combinación
"la plata se puede mover y no queda registro de quién lo hizo" es exactamente el
criterio S0 del programa. Por separado, cada mitad sería S1.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tabla | `src/db/schema.sql:2267` |
| Helper de diff + escritura | `src/domain/audit.ts:31` (`diffFields`), `:64`, `:95`, `:133` |
| Lectura | `src/api/routes/audit-log.routes.ts:31` — único endpoint |
| Pantalla | **ninguna** — cero apariciones de `audit-log` en `appfrontend-main/src` |

## 6. Identidad

`audit_log` tiene PK propia y `entity` + `entity_id` como referencia al objeto
auditado `[V]` (`src/db/schema.sql:2267`). No hay FK: la fila sobrevive al
borrado de la entidad, que para un log es lo correcto. `changed_by` guarda el id
de identity, que vive en **otra base** (la de plataforma), así que no hay JOIN
posible; el nombre se resuelve en la aplicación, en un solo lote `[V]`
(`src/api/routes/audit-log.routes.ts:12`).

## 7. Estados

No aplica — el log es apéndice puro.

## 8. Documentos y movimientos

No aplica.

## 9. Saldos y reportes

`[V]` Ningún reporte lee `audit_log`: `datos/uso-tablas.csv` muestra sus 20 hits
repartidos en `platform`, `clientes-finanzas`, `repositories`, `usuarios-roles`,
`api`, `pos-menu` y `facturacion`, y ninguno en `services/` (donde vive
`report.service.ts`).

## 10. Permisos y segregación

`[V]` La lectura exige `MANAGEMENT` (`src/api/routes/audit-log.routes.ts:33`).
Es el mismo grupo que ejecuta la mayoría de las acciones auditables —123 de 245
endpoints piden `MANAGEMENT` (`datos/endpoints.csv`)—, así que **no hay
segregación**: quien hace es quien lee su propio rastro. Para un log de
auditoría eso es una debilidad de control interno, no un detalle.

`[V]` La escritura no tiene endpoint: sólo entra por los servicios
(`src/api/routes/audit-log.routes.ts:7`). Correcto.

## 11. Auditoría y trazabilidad — las siete preguntas

| Pregunta del checklist | Respuesta | Evidencia |
|---|---|---|
| ¿Quién? | **Sí** | `audit_log.changed_by`, `src/db/schema.sql:2274` |
| ¿Cuándo? | **Parcial** — sólo fecha de registro (`changed_at DEFAULT NOW()`). No hay fecha de negocio. | `src/db/schema.sql:2275` |
| ¿Desde dónde? | **No** — no hay columna de origen (pantalla, API, job, integración). | DDL completo, 8 columnas |
| ¿Antes y después? | **Sí**, para campos. **No** para altas ni bajas. | `src/db/schema.sql:2272` |
| ¿Correlation ID? | **No en la tabla.** Existe `req.id` de `pino-http` en los logs de aplicación `[V]` (`src/app.ts:143`), pero no se persiste en `audit_log`, así que no correlaciona filas entre sí. | — |
| ¿Del efecto al origen? | **No** — con `entity` + `entity_id` obligatorios no se puede preguntar "qué hizo el usuario X hoy". | `src/api/routes/audit-log.routes.ts:36` |
| ¿Sobrevive a cambios de maestros? | **Sí** — `old_value`/`new_value` son `TEXT` copiado, no referencias. | `src/db/schema.sql:2272` |

### Cobertura real por servicio `[V]`

Escriben auditoría del tenant (13 archivos de `src/`, sin contar el helper `domain/audit.ts`, los dos de `platform/` y `workers/outbox.registry.ts`; `grep -rln "auditLogRepo\|auditLogRepository\|recordFieldChanges" --include="*.ts" src`):
`customers.routes.ts`, `rate-catalog.service.ts`, `business-profile.service.ts`,
`invoice.service.ts`, `consumption-destination.service.ts`, `order.service.ts`,
`product.service.ts`, `waste-reason.service.ts`, `bookable-service.service.ts`,
`cancellation-policy.service.ts`, `category.service.ts`, `resources.routes.ts`,
`role.service.ts`.

**No escriben ninguna** (verificado con `grep -c "auditLog\|AuditLog"`, resultado
`0` en los ocho):

| Servicio | Líneas | Qué hace sin dejar rastro |
|---|---|---|
| `src/reservas/reservation.service.ts` | 963 | crear, confirmar, cancelar, completar reservas |
| `src/clientes-finanzas/customer-account.service.ts` | 226 | **registrar pagos** |
| `src/clientes-finanzas/cash-register.service.ts` | 125 | abrir y cerrar caja |
| `src/clientes-finanzas/accounts-receivable.service.ts` | 226 | marcar facturado / cobrado |
| `src/reservas/cancellation-refund.service.ts` | 134 | **confirmar reembolsos** |
| `src/pms-estadias/stay.service.ts` | 474 | check-in, checkout, folio |
| `src/pms-estadias/housekeeping.service.ts` | 138 | asignar y cerrar tareas |
| `src/usuarios-roles/users.routes.ts` | 475 | alta, baja y reactivación de usuarios |

El patrón salta a la vista: **lo que se audita son los maestros; lo que no se
audita es la plata y la operación diaria.** Es exactamente al revés de lo que
pide el control interno.

## 12. Errores, idempotencia y fallo parcial

`[V]` La escritura de auditoría va en la misma transacción que el `UPDATE`
desde el fix del 25/08/2026 (`src/domain/audit.ts:95`; ver también
`docs/conocimiento/playbook-audit-log-transaccional.md`). El único caso
deliberadamente fuera de transacción es `RoleService.updatePermissionGroups()`,
porque el rol vive en la base de plataforma y la auditoría en la del tenant —
dos pools, una sola transacción imposible `[V]` (`src/domain/audit.ts:53`).

`[H]` No verificado: qué pasa con ese caso cross-DB si la segunda escritura
falla. Se confirmaría con una prueba de integración que corte la conexión del
tenant entre las dos escrituras.

## 13. Capacidad ausente

1. **Eventos de acción.** No existe "se confirmó la reserva X" como fila. El
   modelo sólo sabe expresar "el campo Y pasó de A a B".
2. **Motivo.** Ninguna acción privilegiada pide motivo, y no hay dónde
   guardarlo. El programa lo exige en §6.6 para anulaciones y reversiones.
3. **Consulta por actor y por rango de fechas.** Sin esto no se puede responder
   "¿qué tocó este cajero el martes?", que es la pregunta que se hace cuando
   falta plata.
4. **Pantalla.** Cero. El dato existe y nadie puede verlo sin una consulta SQL.
5. **Retención y exportación.** No hay política de retención ni exportación
   firmada del log.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-T03-001` | S0 | Ocho servicios que mueven plata y operación no escriben una sola fila de auditoría. | los ocho `grep -c` en `0`, §11 | **nuevo** |
| `A2-T03-002` | S1 | `audit_log` no puede representar una acción: no tiene `action`, ni `reason`, ni `origin`, ni `correlation_id`. Es un diff de campos, no un log de hechos. | `src/db/schema.sql:2267` (8 columnas) | **nuevo** |
| `A2-T03-003` | S1 | La única lectura exige `entity` + `entityId`. No hay consulta por actor, por fecha ni por tipo de acción. | `src/api/routes/audit-log.routes.ts:36` | **nuevo** |
| `A2-T03-004` | S2 | Ninguna pantalla muestra el log. | cero apariciones de `audit-log` en `appfrontend-main/src` | **nuevo** |
| `A2-T03-005` | S2 | Sin segregación: `MANAGEMENT` escribe y lee su propio rastro. | `src/api/routes/audit-log.routes.ts:33` | ↔ `RBAC-OWN-001` (mismo hueco de control interno, otra superficie) |
| `A2-T03-006` | S3 | `req.id` existe como correlación en los logs de `pino` y no se persiste en ningún lado. | `src/app.ts:143` | **nuevo** |

## 15. Criterios de cierre

- `audit_log` (o una tabla hermana de eventos) admite una acción con `action`,
  `reason`, `origin` y `correlation_id`.
- Los ocho servicios de §11 escriben al menos el hecho principal de su flujo.
- Existe una consulta por actor + rango de fechas, con permiso separado del de
  quien ejecuta las acciones.
- Hay una pantalla, aunque sea sólo para `OWNER`.
- Está escrito qué se retiene y por cuánto tiempo.
