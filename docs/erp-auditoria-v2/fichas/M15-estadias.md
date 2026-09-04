# M15 · Estadías y folio

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`
**Módulo nuevo en v2** — v1 lo tenía fundido dentro de M01.

## 1. Flujo auditado

check-in → consumos durante la estadía → folio → check-out → transferencia a
cuenta por cobrar → cierre

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "check-in → check-out":** ✅ Completo
- **Flujo "folio":** ◇ Parcial — es consulta, no documento, y no tiene pantalla
- **Flujo "quién hizo el check-out":** ◇ Parcial — se guarda quién hizo el
  check-in, no quién lo cerró

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la transferencia del saldo a cuenta por cobrar de
  una empresa, con `MANAGEMENT` y actor persistido `[V]`
  (`src/pms-estadias/stays.routes.ts:16`; `src/db/schema.sql:2202`).
- **Primer paso incompleto:** **el folio como entrega**. `GET /stays/:id/folio`
  existe, devuelve saldo y transacciones, y **no tiene consumidor en el panel**
  `[V]` (`datos/cobertura.csv`). El huésped no recibe el detalle de su cuenta.

## 4. Severidad máxima

**S1** — el folio es el documento de cierre de una estadía y no se entrega.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tabla | `stays`, `src/db/schema.sql:1806` |
| Servicio | `src/pms-estadias/stay.service.ts` (474 líneas) |
| Rutas | `src/pms-estadias/stays.routes.ts:1` — 9 endpoints |
| Pantallas | `dashboard/estadias`, `dashboard/estadias/[id]` |
| Gate | `requireModule(ALOJAMIENTO)` (`src/app.ts:466`) |

## 6. Identidad

`[V]` UUID, sin identidad operativa. ⊃ `A2-T01-002`.

`[V]` `assigned_by` guarda la identity de quien hizo el check-in, **sin FK a
`users` a propósito**, con el bug real que lo motivó documentado en el schema:
con la FK, todo check-in fallaba porque ese id vive en la base de plataforma
(`src/db/schema.sql:1817`). Es el mismo criterio que `accounts_receivable.transferred_by`.

`[V]` **No hay `checked_out_by`.** La tabla tiene `checked_out_at` pero no quién
(`src/db/schema.sql:1821`). Se sabe quién abrió la estadía y no quién la cerró —
y el check-out es el momento en que se define la deuda final.

## 7. Estados

`[V]` `status IN ('CHECKED_IN','CHECKED_OUT','NO_SHOW')` (`src/db/schema.sql:1819`),
con timestamp por estado.

`[V]` Índice único parcial: una sola estadía activa por reserva
(`src/db/schema.sql:1828`). Mismo patrón de constraint-como-única-fuente-de-verdad
que usa caja. Correcto.

## 8. Documentos y movimientos

`[V]` `linkStayToReservationCharges()` reasigna los `CHARGE` de la reserva a la
estadía (`src/clientes-finanzas/sql.financial-transaction.repository.ts:405`).
Es lo que hace que el folio pueda existir.

`[V]` El folio es una respuesta JSON, no un documento. ↔ `A2-T04-003`.

## 9. Saldos y reportes

`[V]` El folio calcula saldo + transacciones de la estadía
(`src/pms-estadias/stays.routes.ts:181`). No se congela: si mañana se agrega un
consumo, el folio de ayer cambia.

`[V]` Ningún reporte cubre estadías: los 11 de `/api/reports/*` son ocupación,
cuentas por cobrar, POS y CRM.

## 10. Permisos y segregación

`[V]` Reparto fino y bien pensado: `FRONT_DESK` para la operación, `STAFF` para
consultar ocupación de una habitación, `MANAGEMENT` para transferir a cuenta por
cobrar, y **`overrideHousekeeping: true` exige además `MANAGEMENT`, con 403 si
no** (`src/pms-estadias/stays.routes.ts:13`).

Ese override es el segundo caso de segregación real del sistema, después del
ajuste de precio de reservas. Los dos existen; ninguno se replicó a los módulos
de dinero.

## 11. Auditoría y trazabilidad

`[V]` `stay.service.ts` (474 líneas) no escribe `audit_log` (`grep -c` = `0`).
El actor del check-in queda por `assigned_by`; el del check-out y el del
`NO_SHOW`, no queda en ningún lado.

`[V]` Un `NO_SHOW` es una decisión con consecuencia económica (política de
cancelación, retención de seña) y se registra sin actor y sin motivo.

## 12. Errores, idempotencia y fallo parcial

`[V]` Doble check-in: imposible por índice único (`src/db/schema.sql:1828`).

`[H]` No verificado: qué pasa si el check-out corre mientras se está creando un
consumo de POS contra esa estadía. Se confirmaría con una prueba de integración
concurrente.

## 13. Capacidad ausente

1. **Folio impreso/entregable y congelado al cerrar.**
2. **`checked_out_by` y motivo del `NO_SHOW`.**
3. **Extensión de estadía, cambio de habitación, huéspedes acompañantes.** No
   hay endpoint ni columna.
4. **Registro de huéspedes para la autoridad** (planilla de pasajeros). Para un
   hotel en Argentina es un requisito, no una comodidad. `[H]` — la obligación
   exacta la tiene que confirmar el dueño.
5. **Late check-out con cargo.** Existe el reporte `late-checkouts`
   (`src/pms-estadias/housekeeping.routes.ts:93`) y no hay cargo asociado.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M15-001` | S1 | El folio no se entrega ni se congela: es una consulta sin pantalla. | `datos/cobertura.csv`; `src/pms-estadias/stays.routes.ts:181` | ↔ `A2-T04-003` |
| `A2-M15-002` | S1 | No se registra quién hizo el check-out ni quién marcó `NO_SHOW`. | `src/db/schema.sql:1821`; `grep -c` = 0 | ⊃ `A2-T03-001` |
| `A2-M15-003` | S2 | Sin extensión de estadía ni cambio de habitación. | ausencia de endpoint | **nuevo** |
| `A2-M15-004` | S2 | Sin registro de huéspedes acompañantes ni planilla de pasajeros. | ausencia de tabla | **nuevo** `[H]` (obligación legal a confirmar) |
| `A2-M15-005` | S3 | `late-checkouts` se reporta y no genera cargo. | `src/pms-estadias/housekeeping.routes.ts:93` | **nuevo** |
| `A2-M15-006` | S3 | Sin identidad operativa de la estadía. | `src/db/schema.sql:1807` | ⊃ `A2-T01-002` |
| `A2-M15-007` | S4 | Carrera check-out / consumo de POS no verificada. | ausencia de test | **nuevo** `[H]` |

## 15. Criterios de cierre

- El folio se puede entregar al huésped y queda congelado al cerrar la estadía.
- `checked_out_by` existe y el `NO_SHOW` pide motivo.
- Está decidido si hace falta planilla de pasajeros.
- Extender una estadía o cambiar de habitación tiene camino formal.
