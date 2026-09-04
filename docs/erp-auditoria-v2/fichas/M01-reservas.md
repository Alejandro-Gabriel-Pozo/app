# M01 · Reservas (alojamiento y servicios)

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`
**Ver también:** `fichas/M15-estadias.md` (lo que pasa después del check-in) y
`fichas/M03-turnos.md` (el mismo motor, otro rubro).

## 1. Flujo auditado

disponibilidad → reserva → confirmación → cobro de seña → modificación →
cancelación con reembolso → estadía → cierre

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "reservar y confirmar":** ✅ Completo
- **Flujo "cancelar con reembolso":** ◌ Huérfano — el backend está, la pantalla
  no lo usa
- **Flujo "quién hizo qué con la reserva":** ◌ No existe

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la confirmación, con su efecto financiero. El
  evento `reservation.confirmed` dispara el `CHARGE` por el outbox, idempotente
  `[V]` (`src/clientes-finanzas/sql.financial-transaction.repository.ts:105`).
- **Primer paso incompleto:** **la cancelación con reembolso**. Los dos
  endpoints existen (`src/reservas/reservations.routes.ts:453`, `:472`) y **no
  hay una sola referencia a `cancellation-refund` en todo el frontend** `[V]`
  (`grep -rn "cancellation-refund" appfrontend-main/src` → sin resultados).
  Cancelar desde el panel no pasa por el preview/confirm. ↔ `C2`.

## 4. Severidad máxima

**S1** — cancelar sin pasar por el cálculo de reembolso, sobre un módulo cuyo
servicio no audita nada.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tabla | `reservations`, `src/db/schema.sql:426` |
| Líneas | `reservation_lines` |
| Servicio | `src/reservas/reservation.service.ts` (963 líneas) |
| Disponibilidad | `src/reservas/reservation-availability.service.ts` |
| Precios | `src/reservas/reservation-pricing.service.ts` |
| Reembolso | `src/reservas/cancellation-refund.service.ts:81` |
| Rutas | `src/reservas/reservations.routes.ts:1` — 15 endpoints |
| Pantallas | `dashboard/reservas`, `dashboard/reservas/[id]`, `dashboard/` |

## 6. Identidad

`[V]` **Es una de las dos entidades con identidad operativa completa**:
`reservation_number` `NOT NULL` con índice único
(`src/db/schema.sql:2725`, `:2755`), prefijo por tenant (`:2763`) y helper único
en el frontend. Ver `fichas/T01-identidad.md`.

`[V]` **Snapshot correcto**: `customer_name` y `customer_email` se congelan en
la reserva (`src/db/schema.sql:430`, `:431`), igual que `total_price`
(`src/db/schema.sql:439`). Cambiar el cliente después no reescribe la historia.
Es la dimensión de `criterios-datos.md` mejor resuelta del repo.

`[V]` `service_id` es `ON DELETE SET NULL` (`src/db/schema.sql:440`): borrar un
servicio no borra reservas. Correcto.

## 7. Estados

`[V]` `status IN ('PENDING','CONFIRMED','CANCELLED','COMPLETED','EXPIRED')`
(`src/db/schema.sql:434`), espejado en `ReservationStatus`
(`src/types/enums.ts:8`).

`[V]` Máquina de estados secundaria e independiente:
`schedule_approval_status IN ('PENDING','APPROVED','REJECTED')`, nullable con
semántica explícita (`src/db/schema.sql:518`). Cubre el pedido de cambio de
fechas.

`[V]` `EXPIRED` lo produce un worker de expiración de hold
(`src/workers/reservation-hold-expiry.worker.ts`, citado en el `CLAUDE.md` del
repo). Es el único estado que llega por tiempo y no por acción.

## 8. Documentos y movimientos

`[V]` El `CHARGE` no lo crea el servicio: lo crea el handler del outbox a partir
del evento. Eso hace que la reserva y su deuda no compartan transacción — es un
diseño deliberado (outbox), con el costo de que un evento en dead-letter deja la
reserva confirmada sin deuda. ↔ `A2-T05-001`.

`[V]` **La reserva no produce ningún documento para el huésped.** Hay mail de
confirmación (`src/email/email.sender.ts:3`), no comprobante.

`[V]` El reembolso sí produce movimiento inverso, con `confirmedBy` poblado
(`src/reservas/cancellation-refund.service.ts:126`) — pero por el camino que la
UI no usa.

## 9. Saldos y reportes

`[V]` Cuatro reportes de ocupación conectados al panel
(`datos/cobertura.csv`: `occupancy`, `summary`, `by-category`, `underutilized`).
Es el módulo con mejor cobertura de reportes.

`[V]` `GET /api/reservations/:id/price-preview` no tiene consumidor
(`datos/cobertura.csv`). El cálculo de precio se puede consultar antes de
confirmar y la pantalla no lo hace.

## 10. Permisos y segregación

`[V]` **Acá sí hay segregación, y es la única real del sistema**: crear y editar
son `FRONT_DESK`, pero `POST /:id/confirm-price-adjustment` es `MANAGEMENT`,
"a propósito, no `FRONT_DESK` — separa quien edita fechas de quien autoriza la
plata" (`src/reservas/reservations.routes.ts:13`).

Ese es exactamente el patrón que le falta a M04, M05, M06 y M10. Está inventado
adentro del repo; falta aplicarlo.

`[V]` `POST /reservations` pide `BOOKING` para que el cliente del portal pueda
reservar (`src/reservas/reservations.routes.ts:10`).

`[V]` `search` se movió de query string a body porque es PII
(`src/reservas/reservations.routes.ts:7`). Buena decisión, y del tipo que suele
faltar.

## 11. Auditoría y trazabilidad

`[V]` `reservation.service.ts`, con 963 líneas y todo el ciclo de vida de la
entidad central del producto, **no escribe una sola fila de `audit_log`**
(`grep -c "auditLog\|AuditLog"` = `0`).

`[V]` La única excepción es `confirmPriceAdjustment`, que exige
`confirmedByUserId` y lo persiste en el movimiento
(`src/reservas/reservation.service.ts:648`, `:737`) — a pedido explícito, según
el comentario. Confirma que cuando se pidió trazabilidad, se supo hacer.

⊃ `A2-T03-001`.

## 12. Errores, idempotencia y fallo parcial

`[V]` Disponibilidad y creación serializadas con `SELECT ... FOR UPDATE`
(`CLAUDE.md` de `app-main`, sección `concurrency-reasoning`; ver
`docs/conocimiento/playbook-locks-exclusividad.md`).

`[V]` Asignación diferida: si se pide por categoría y no hay recurso libre,
responde `409 NO_RESOURCE_AVAILABLE` en vez de crear la reserva
(`src/reservas/reservations.routes.ts:53`).

`[V]` `POST`/`PUT` validan con Zod y el `id` se genera server-side; antes se
confiaba en `req.body.id` (`src/reservas/reservations.routes.ts:44`).

## 13. Capacidad ausente

1. **Auditoría del ciclo de vida.**
2. **Comprobante de reserva para el huésped.**
3. **Overbooking controlado, lista de espera, bloqueos comerciales.** No hay
   tabla ni endpoint.
4. **Modificación de una reserva ya confirmada con recálculo automático de la
   deuda.** `[H]` — no verificado en esta corrida si `PUT /:id` sobre una
   `CONFIRMED` ajusta el `CHARGE`; se confirmaría leyendo `updateReservation`.
5. **Canales externos** (portales de reserva, motor propio con pago). ↔
   `docs/roadmap-sitios-corporativos-reservas.md`.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M01-001` | S1 | Cancelar desde el panel no usa el preview/confirm de reembolso: los endpoints existen y el frontend no los llama. | `src/reservas/reservations.routes.ts:453`, `:472`; `grep` sin resultados en el frontend | ↔ `C2` |
| `A2-M01-002` | S1 | El servicio central del producto no audita ninguna transición. | `grep -c` = 0 sobre 963 líneas | ⊃ `A2-T03-001` |
| `A2-M01-003` | S2 | Una reserva confirmada cuyo evento cae en dead-letter queda sin deuda, y nadie se entera. | `src/clientes-finanzas/sql.financial-transaction.repository.ts:105` + `A2-T05-001` | ⊃ `A2-T05-001` |
| `A2-M01-004` | S2 | `price-preview` existe y la pantalla no lo usa. | `datos/cobertura.csv` | **nuevo** |
| `A2-M01-005` | S2 | Sin comprobante de reserva. | ausencia de endpoint | ↔ `A2-T04-006` |
| `A2-M01-006` | S3 | Sin overbooking, lista de espera ni bloqueo comercial. | ausencia de tabla | **nuevo** |
| `A2-M01-007` | S3 | No verificado si editar una reserva confirmada recalcula la deuda. | — | **nuevo** `[H]` |
| `A2-M01-008` | S4 | `rate_plans` con `service_id NOT NULL`: no reutilizables entre servicios. | — | ↔ ítem "deuda activa" de `pendientes-2026-09-01.md` |

## 15. Criterios de cierre

- Cancelar desde el panel pasa por preview y confirm de reembolso.
- Las transiciones de reserva dejan rastro con actor.
- La reserva emite un comprobante para el huésped, o está escrito que el mail
  alcanza.
- Está verificado y escrito qué pasa con la deuda al editar una reserva
  confirmada.
