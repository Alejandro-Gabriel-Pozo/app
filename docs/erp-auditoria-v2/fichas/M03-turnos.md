# M03 · Turnos y servicios agendables

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

> Turnos no es un módulo separado: es el **mismo motor de reservas** filtrado por
> `is_lodging`. Esta ficha audita lo que le es propio; para el ciclo de vida de
> la reserva, ver `fichas/M01-reservas.md`.

## 1. Flujo auditado

definición del servicio → horarios → disponibilidad → turno → confirmación →
atención → cierre → cancelación / no-show

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "definir servicio y agendar":** ✅ Completo
- **Flujo "atender y cerrar":** ◇ Parcial — se cierra con `COMPLETED`, sin
  registro de la atención
- **Flujo "no-show":** ◌ No existe para turnos

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** la confirmación del turno, que es la misma de M01.
- **Primer paso incompleto:** **el no-show**. `stays` tiene `NO_SHOW`
  (`src/db/schema.sql:1819`); `reservations` no
  (`src/db/schema.sql:434`: `PENDING`, `CONFIRMED`, `CANCELLED`, `COMPLETED`,
  `EXPIRED`). Un turno al que el cliente no vino se registra como `CANCELLED`,
  igual que uno cancelado con aviso — dos hechos con consecuencias comerciales
  distintas, guardados iguales.

## 4. Severidad máxima

**S2** — no hay pérdida de plata directa; hay pérdida de información comercial
que después no se puede reconstruir.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tablas | `bookable_services` (`src/db/schema.sql:197`), `service_schedules` (`:242`), `resource_locks` (`:225`), `rate_plans` (`:273`) |
| Discriminador | `resource_categories.is_lodging` (`src/db/schema.sql:112`) |
| Rutas | `src/reservas/bookable-services.routes.ts:1` — 16 endpoints |
| Pantallas | `dashboard/servicios`, `dashboard/turnos`, `dashboard/turnos/[id]` |

## 6. Identidad

`[V]` El turno **es** una reserva: comparte tabla, `reservation_number` y
prefijo. La pantalla de turnos usa el mismo helper que la de reservas
(`appfrontend-main/src/app/dashboard/turnos/page.tsx:220`).

Consecuencia no resuelta: turnos y reservas de alojamiento **comparten la misma
serie de numeración**. `RES-000123` puede ser una habitación o un turno de
peluquería. `[H]` — si eso molesta al negocio no está decidido en ningún lado.

## 7. Estados

`[V]` Los mismos cinco de `reservations` (`src/db/schema.sql:434`), más
`schedule_approval_status` para el pedido de cambio (`:518`).

`[V]` `booking_mode IN ('slot','block','event')` en el servicio
(`src/db/schema.sql:204`) es lo que distingue un turno de una estadía a nivel
modelo.

`[V]` La separación alojamiento/turnos se resuelve por
`resource_categories.is_lodging` (`src/db/schema.sql:112`), y hay una **decisión
explícita del dueño de NO reutilizar `is_lodging`** para exclusividad de reserva,
aunque hoy coincidan (`src/db/schema.sql:115`). Está bien registrada: es el tipo
de coincidencia que se convierte en bug cuando alguien la toma por definición.

## 8. Documentos y movimientos

Los mismos de M01. Un turno no emite comprobante.

## 9. Saldos y reportes

`[V]` Los cuatro reportes de ocupación no distinguen turnos de alojamiento
`[H]` — no verificado si `by-category` permite filtrar por `is_lodging`. Se
confirmaría leyendo `src/services/report.service.ts`.

`[V]` `GET /api/bookable-services/:id` figura sin consumidor
(`datos/cobertura.csv`); con pantalla de servicios existente es probable falso
positivo del cruce.

## 10. Permisos y segregación

`[V]` `BOOKING` para leer servicios y horarios —el portal del cliente los
necesita— y `MANAGEMENT` para escribir
(`src/reservas/bookable-services.routes.ts:20`).

`[V]` **`resource-locks` es la excepción deliberada**: `STAFF` para leer, no
`BOOKING`, "no es visible para CUSTOMER"
(`src/reservas/bookable-services.routes.ts:16`). Alguien pensó qué ve el cliente
del portal en cada endpoint del router, no en el router entero.

## 11. Auditoría y trazabilidad

`[V]` `bookable-service.service.ts` **sí** audita (aparece en la lista de
`grep -rln "auditLogRepo\|recordFieldChanges"`). El servicio agendable, que es
configuración, deja rastro; el turno, que es la operación, no
(⊃ `A2-M01-002`).

## 12. Errores, idempotencia y fallo parcial

`[V]` Los `DomainError` se propagan a `domainErrorStatus()` en el
`error.middleware.ts` central, y el docblock **prohíbe explícitamente** volver a
poner el mapeo inline en cada handler
(`src/reservas/bookable-services.routes.ts:29`). Un caso de deuda evitada dejada
por escrito.

`[V]` `service_schedules.max_capacity CHECK (>= 1)` y `day_of_week BETWEEN 0 AND 6`
(`src/db/schema.sql:248`, `:246`).

## 13. Capacidad ausente

1. **`NO_SHOW` para turnos.**
2. **Registro de la atención.** No hay "quién atendió" ni "a qué hora empezó de
   verdad": el turno pasa de `CONFIRMED` a `COMPLETED` sin nada en el medio.
3. **Sobreturno / lista de espera.**
4. **Recordatorio al cliente.** El mail existe sólo para confirmación de reserva
   (`src/email/email.sender.ts:3`).
5. **Duración variable por prestador y agenda por profesional.** El recurso es
   físico (`PhysicalResource`); no hay modelo de "profesional" con su propia
   agenda. Para el rubro servicios es la ausencia estructural del módulo.
6. **Serie de numeración separada de alojamiento.**

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-M03-001` | S2 | Sin `NO_SHOW`: un turno al que no vinieron se registra igual que uno cancelado con aviso. | `src/db/schema.sql:434` vs `:1819` | **nuevo** |
| `A2-M03-002` | S2 | No hay modelo de profesional con agenda propia; el recurso es físico. | `src/reservas/resource.entities.ts` (`PhysicalResource`) | **nuevo** |
| `A2-M03-003` | S2 | La atención no deja registro: `CONFIRMED → COMPLETED` sin actor ni horario real. | `src/db/schema.sql:434` | ⊃ `A2-M01-002` |
| `A2-M03-004` | S3 | Sin recordatorio al cliente. | `src/email/email.sender.ts:3` | **nuevo** |
| `A2-M03-005` | S3 | Turnos y alojamiento comparten serie de numeración. | `src/db/schema.sql:2725` | **nuevo** `[H]` |
| `A2-M03-006` | S3 | Sin sobreturno ni lista de espera. | ausencia de tabla | **nuevo** |
| `A2-M03-007` | S4 | No verificado si los reportes de ocupación separan turnos de alojamiento. | — | **nuevo** `[H]` |

## 15. Criterios de cierre

- Un turno se puede marcar `NO_SHOW` y eso se distingue de una cancelación.
- Está decidido si hace falta modelar al profesional como recurso con agenda.
- La atención registra quién y cuándo.
