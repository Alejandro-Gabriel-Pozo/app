# Diseño — Truncamiento controlado de pagos contra facturas (O2-F1)

Resuelve **O2-F1** (circuito O2 — Order-to-Cash financiero, auditoría
autodirigida del 03/09/2026). Escrito el mismo día que la implementación,
sobre `CustomerAccountService.recordPayment()` con `allocations` (I4,
23/08/2026).

## El problema

`recordPayment({ allocations: [...] })` (conciliación de pagos, I4) creaba
una fila `PAYMENT` por cada factura elegida por el monto pedido, sin
verificar el saldo real de esa factura. No hay un estado `PAID` persistido
(`InvoiceStatus` no lo tiene, decisión reafirmada más abajo) — `outstanding`
siempre se deriva en lectura (`impTotal - pagado(SETTLED) -
acreditado(SETTLED)`), así que nada impedía asignar un pago a una factura
ya saldada o parcialmente saldada por otro pago: la fila se creaba igual,
por el monto pedido, sin capar contra lo que realmente faltaba cobrar. Dos
pagos concurrentes contra la misma factura podían, en teoría, sobre-aplicar
los dos contra el mismo saldo leído antes de que ninguno commiteara.

## Decisión del dueño — Opción B: truncamiento controlado

1. Cada `allocation` se aplica **como máximo hasta el saldo vigente** de
   esa factura al momento de aplicar (nunca más).
2. El monto total recibido se preserva siempre — lo que no entra en
   ninguna factura por estar ya saldada (total o parcialmente) queda como
   una fila `PAYMENT` **sin asociar** (`settledInvoiceId: null`), trazable
   como crédito del cliente. Nunca se pierde, nunca se rechaza el pago
   completo.
3. `outstanding` nunca queda negativo.
4. Sin estado `PAID` persistido — se mantiene la derivación en lectura ya
   existente (`getOutstandingByCustomerId`); la UI deriva
   PENDIENTE/PARCIAL/SALDADA del `outstanding` calculado, no de una
   columna nueva.
5. El saldo se relee **con lock** dentro de la misma transacción que
   aplica el pago (A8.1/A8.2) — dos pagos concurrentes contra la misma
   factura se serializan a nivel fila, nunca aplican los dos contra el
   mismo saldo viejo.

## Implementación

- **`InvoiceRepository.getOutstandingForUpdate(client, invoiceId)`**
  (`src/facturacion/invoice.repository.ts`,
  `src/facturacion/sql.invoice.repository.ts`) — mismo cálculo que
  `getOutstandingByCustomerId` (impTotal - pagado - acreditado, ambos solo
  `SETTLED`) pero acotado a un id, con `SELECT ... FOR UPDATE OF i` sobre
  la fila de `invoices` (el recurso escaso a serializar — no las filas de
  `financial_transactions` que se suman en la subconsulta). Deliberadamente
  **sin** el `JOIN financial_transactions ft ON ft.id =
  i.financial_transaction_id` que usa `getOutstandingByCustomerId`: ese
  JOIN excluye toda factura consolidada (`financial_transaction_id IS
  NULL` a propósito desde C1-Fase C, `schema.sql:3139`) — un gap
  preexistente y adyacente que este método no reintroduce (ver
  "Hallazgo adyacente, no resuelto" más abajo).

- **`CustomerAccountService.recordPayment()`** (rama `allocations`,
  `src/clientes-finanzas/customer-account.service.ts`):
  1. Consolida `allocations` duplicadas a la misma factura en una sola
     (el caller puede mandar la misma factura dos veces en el mismo
     request) y las ordena por `invoiceId` — mismo criterio que
     `ResourceRepository.lockByIds()` para que dos pagos concurrentes que
     tocan las mismas facturas las bloqueen siempre en el mismo orden y
     ninguno espere en deadlock.
  2. Dentro de `transactionManager.run()`, por cada allocation: relee el
     saldo con `getOutstandingForUpdate`, aplica
     `min(allocation, max(saldo, 0))`, acumula el excedente.
  3. El excedente total (remainder de entrada + excedentes por factura) se
     asienta en **una sola** fila `PAYMENT` sin asociar.
  4. Idempotencia (`createPaymentChunkWithClient`): antes de crear
     cualquier fila, busca por `idempotencyKey` si ya existe — un
     reintento tras un commit exitoso devuelve las filas YA creadas, sin
     recalcular contra el saldo (que para entonces ya cambió). Cierra un
     gap que tenía la rama `allocations` desde I4: a diferencia de la
     rama sin `allocations` (que sí hace fallback a
     `getByIdempotencyKey()` cuando `create()` devuelve `null`), la rama
     `allocations` no miraba el retorno `null` de `createWithClient()` en
     absoluto.
  5. Una allocation con `applied = 0` (factura ya saldada) no genera fila
     propia — una fila en cero no documenta ningún movimiento real; su
     monto completo va al excedente.

## Verificación

- **Unitarios** (`customer-account.service.test.ts`): 7 tests preexistentes
  de la rama `allocations` sin cambios de comportamiento (siguen pasando
  contra un `FakeInvoiceRepository` cuyo `outstanding` por default es
  `impTotal`, replicando el comportamiento previo cuando no hay saldo
  parcial). 6 tests nuevos: truncamiento simple (ejemplo del dueño:
  saldo 250, allocation 400 → aplica 250, 150 sin asignar), factura ya
  saldada (aplica 0, 100% al excedente), pago exacto sin excedente,
  consolidación de allocations duplicadas, reintento idempotente con saldo
  ya cambiado entre medio, truncamiento independiente por factura en un
  pago multi-factura.
- **Integración PostgreSQL real**
  (`src/tests/integration/customer-account-payment.integration.test.ts`,
  4 tests, `TEST_DATABASE_URL`): truncamiento contra Postgres real;
  **concurrencia real** — dos `CustomerAccountService.recordPayment()`
  concurrentes (dos pools/transacciones separadas) contra la misma
  factura de 1000, pagando 600 cada uno (ejemplo exacto del dueño):
  aplicado total exactamente 1000 (nunca menos, nunca más), excedente
  exactamente 200, saldo final 0 (nunca negativo); reintento idempotente
  tras commit exitoso (no duplica filas, no recalcula); consolidación de
  allocations duplicadas contra Postgres real.

`criterios-negocio.md`: A3.1 (NUMERIC, `round2()` en cada paso), A3.10
(todo movimiento con contrapartida — la fila sin asignar es la
contrapartida explícita del excedente), A8.1/A8.2 (lock a nivel fila sobre
el recurso escaso, check-and-write en la misma transacción), idempotencia
de mutación (regla de concurrencia).

## Alcance — qué NO resuelve esta implementación

- **Frontend.** El plan autorizado por el dueño incluye actualizar la UI
  para mostrar recibido/aplicado/sin-asignar/crédito. No hay repositorio
  de frontend adjunto a esta sesión — queda fuera de alcance acá, sin
  implementar. La respuesta del backend (`POST /:id/payments`, array de
  `FinancialTransaction[]`) ya expone `amount` + `settledInvoiceId` por
  fila, suficiente para que el frontend arme esa vista sin cambios de
  contrato adicionales.

## Hallazgo adyacente, no resuelto (fuera de alcance de O2-F1)

`getOutstandingByCustomerId()` (`sql.invoice.repository.ts`) hace `JOIN
financial_transactions ft ON ft.id = i.financial_transaction_id` —
excluye estructuralmente **toda** factura consolidada
(`financial_transaction_id IS NULL` desde C1-Fase C) de la lista de
"facturas con saldo pendiente" que alimenta el modal de conciliación de
"Registrar Pago". Una factura consolidada con saldo real pendiente nunca
aparece ahí para que el operador la elija en `allocations` — sigue
existiendo y `getOutstandingForUpdate` (este documento) sí calcula bien su
saldo si se le pasa el id directo, pero el operador no tiene forma de
descubrir ese id desde el modal. No se corrige acá: O2-F1 autorizó
específicamente el comportamiento de sobre-aplicación de
`recordPayment()`, no este gap distinto (visibilidad, no aplicación).
Queda registrado para una decisión separada del dueño.
