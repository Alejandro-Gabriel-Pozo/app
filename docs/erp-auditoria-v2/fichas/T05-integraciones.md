# T05 · Integraciones, eventos y correo

**Auditado:** 02/09/2026 · **Método:** `00-programa-v2.md`

## 1. Flujo auditado

hecho de negocio → evento en el outbox → despacho → idempotencia → reintento →
dead-letter → reconciliación manual

## 2. Estado

- **Módulo:** ⚠️ Revisado con brechas
- **Flujo "outbox interno" (evento → handler → efecto):** ✅ Completo en el
  mecanismo, ◇ Parcial en la operación (nadie puede ver la dead-letter)
- **Flujo "integración fiscal ARCA":** ⛔ Bloqueado — ver `fichas/M10-facturacion.md`
- **Flujo "correo transaccional":** ◇ Parcial — sin idempotencia, límite declarado

## 3. Último paso confirmado / primer paso incompleto

- **Último paso confirmado:** el reintento manual. `POST
  /api/system/outbox/:id/retry` existe y funciona `[V]`
  (`src/api/routes/system.routes.ts:45`).
- **Primer paso incompleto:** **verlo**. Los dos endpoints de outbox no tienen
  consumidor en el panel `[V]` (`datos/cobertura.csv`,
  `/api/system/outbox/dead-letter` con `consumidores = "-"`). Un evento que
  agota reintentos queda esperando a que alguien lo consulte por `curl`.

## 4. Severidad máxima

**S1** — el outbox es el camino por el que se crean los `CHARGE` de cada reserva
confirmada. Un evento muerto es plata que no se registró, y hoy nada avisa.

## 5. Superficie

| Pieza | Ubicación |
|---|---|
| Tabla de eventos | `src/db/schema.sql` — `domain_events` (8 columnas, con `dispatched_at`) |
| Idempotencia de consumo | `processed_events` |
| Worker | `src/workers/outbox.worker.ts:1`; registro por tenant en `src/workers/outbox.registry.ts` |
| Versionado de payload | `src/workers/outbox.worker.ts:31` (`UnsupportedEventVersionError`) |
| Observabilidad | `src/api/routes/system.routes.ts:26` (dead-letter), `:45` (retry) |
| Correo | `src/email/email.sender.ts:1` |
| ARCA/AFIP | `src/facturacion/invoice.service.ts`, `src/facturacion/padron.service.ts` |

## 6. Identidad

`[V]` `domain_events.id` es `BIGSERIAL` — el único identificador del repo que no
es UUID/VARCHAR. Correcto para un log de eventos: da orden natural de proceso.

`[V]` Los handlers tienen identidad estable en `processed_events` vía
`HandlerOptions.name`, tratada explícitamente como clave y no como etiqueta
(`src/workers/outbox.worker.ts:8`). Es la pieza que hace la idempotencia real.

## 7. Estados

`[V]` Ocho tipos de evento emitidos, todos de dos agregados
(`grep -rn "eventType:\s*'"`): `reservation.confirmed`, `.cancelled`,
`.completed`, `.expired`, `.price_adjusted`, `order.confirmed`, `.cancelled`,
`.completed`.

**Ninguno de dinero.** No hay `payment.recorded`, `refund.confirmed`,
`invoice.issued`, `cash.shift_closed`. Los movimientos financieros nacen como
efecto de un evento de reserva u orden, y no emiten evento propio — así que
nada externo puede suscribirse a "se cobró".

`[V]` La versión de payload se rechaza ruidosamente si no hay handler para ella
(`src/workers/outbox.worker.ts:31`). Es la decisión correcta y está escrita.

## 8. Documentos y movimientos

El outbox es el productor de los `CHARGE` de reserva. Ver
`fichas/M04-cuentas-corrientes.md` §8.

## 9. Saldos y reportes

Ningún reporte cubre salud del outbox. El único dato operativo es el endpoint de
dead-letter, sin panel.

## 10. Permisos y segregación

`[V]` Los dos endpoints exigen `MANAGEMENT` (`src/api/routes/system.routes.ts:28`,
`:47`). Sin `requireModule` a propósito, con el motivo escrito
(`src/api/routes/system.routes.ts:10`): es observabilidad de infraestructura, no
un módulo de negocio. Criterio consistente con `/api/audit-log`.

## 11. Auditoría y trazabilidad

`[V]` El reintento manual **no** deja fila de auditoría; queda en el log del
servidor con actor y evento, y el propio código lo declara como límite conocido
(`src/api/routes/system.routes.ts:60`). Es un caso ejemplar de deuda declarada:
el comentario dice qué falta y por qué. ⊃ `A2-T03-002`.

`[V]` No hay correlación entre el evento y las filas que produjo. `domain_events`
no guarda los ids de los efectos, y `financial_transactions` no guarda el id del
evento. Reconstruir "de qué evento salió este `CHARGE`" es un ejercicio de
inferencia por timestamp.

## 12. Errores, idempotencia y fallo parcial

`[V]` Idempotencia de consumo: `processed_events` + `HandlerOptions.name`.

`[V]` Idempotencia de escritura financiera: índice único parcial sobre
`financial_transactions.idempotency_key`, con el `ON CONFLICT` que repite la
condición del índice parcial — hay un bug real documentado ahí
(`src/clientes-finanzas/sql.financial-transaction.repository.ts:105`).

`[V]` **El correo no tiene idempotencia**, y el propio archivo lo declara: si
otro handler del mismo evento falla y el evento se reintenta, el mail se manda de
nuevo (`src/email/email.sender.ts:27`). Límite conocido, no resuelto.

`[V]` Sin `RESEND_API_KEY` cae a `NoopEmailSender` — fail-open deliberado
(`src/email/email.sender.ts:16`). Coherente con el criterio del repo, pero
significa que en un entorno mal configurado los mails se pierden en silencio y
el flujo de negocio parece exitoso.

`[H]` La prueba E2E del outbox sigue sin correrse (la corre el dueño). ↔ ítem
"prueba E2E del Outbox" de `pendientes-2026-09-01.md`.

## 13. Capacidad ausente

1. **Pantalla de salud del outbox.** Existe el dato, existe el retry, falta el
   lugar donde mirarlo.
2. **Alerta.** Nada avisa que hay eventos en dead-letter. Sin alerta, el
   endpoint sólo sirve si alguien ya sospecha.
3. **Eventos de dinero.** Ningún hecho financiero emite evento propio.
4. **Reintento del correo con control de duplicado.**
5. **Webhooks salientes.** No hay forma de que un sistema externo se entere de
   nada. Para un ERP que aspira a integrarse (canales, pasarelas de pago,
   contabilidad) es una ausencia estructural, no una feature.
6. **Integración de cobro electrónico.** `C1-Fase B` está bloqueada hasta que el
   negocio elija proveedor ↔ `pendientes-2026-09-01.md`.

## 14. Brechas

| ID | Sev | Qué falta | Evidencia | Cruce |
|---|---|---|---|---|
| `A2-T05-001` | S1 | Dead-letter sin pantalla y sin alerta: un `CHARGE` que no se creó no se entera nadie. | `datos/cobertura.csv`; `src/api/routes/system.routes.ts:26` | **nuevo** |
| `A2-T05-002` | S2 | Ningún hecho financiero emite evento; nada puede suscribirse a "se cobró". | `grep -rn "eventType:"` → 8 tipos, ninguno de dinero | **nuevo** |
| `A2-T05-003` | S2 | El reintento manual no deja auditoría. | `src/api/routes/system.routes.ts:60` (declarado en el código) | ⊃ `A2-T03-002` |
| `A2-T05-004` | S2 | Sin correlación evento ↔ efectos producidos. | `domain_events` sin ids de efecto | ⊃ `A2-T03-002` |
| `A2-T05-005` | S2 | El correo se reenvía si el evento se reintenta. | `src/email/email.sender.ts:27` | **nuevo** (declarado en código, no en `pendientes`) |
| `A2-T05-006` | S3 | Sin credenciales de correo el flujo aparenta éxito y no se manda nada. | `src/email/email.sender.ts:16` | **nuevo** |
| `A2-T05-007` | S4 | No hay webhooks salientes ni API de integración para terceros. | ausencia total en `datos/endpoints.csv` | **nuevo** |
| `A2-T05-008` | S4 | E2E del outbox sin correr. | — | ↔ ítem "prueba E2E del Outbox" |

## 15. Criterios de cierre

- Hay una pantalla (aunque sea de `OWNER`) que muestra dead-letter y permite el
  retry, y una alerta cuando el contador pasa de cero.
- Cada `financial_transaction` puede decir de qué evento salió.
- El correo no se duplica al reintentar el evento, o está escrito que se acepta
  que sí.
- Existe al menos un evento de dinero, o está escrito por qué no hace falta.
