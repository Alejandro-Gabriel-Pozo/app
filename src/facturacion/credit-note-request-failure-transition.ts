/**
 * @file credit-note-request-failure-transition.ts
 * @description Extraído de `InvoiceService.transitionCreditNoteRequestAfterFailure()`
 * (Bloque 4 del ADR común cancelar-con-NC, 15/09/2026, §6.5 bis) en el Bloque
 * 4 del ADR `docs/diseno-invoice-retry-reverse-window-guard-2026-09-23.md`
 * (23/09/2026, hallazgo `ISSUE-BEFORE-REVERSE-WINDOW-001`) -- ese ADR exige
 * que el `InvoicePendingExpiryWorker` (`src/workers/invoice-pending-expiry.worker.ts`)
 * use "el MISMO método" que ya usan `issue()`/`reconcileAfterFailure()`
 * (`invoice.service.ts`) para escalar `credit_note_request` a
 * `EN_REVISION_MANUAL` -- no una copia paralela de la misma lógica. Como el
 * worker es una clase aparte (sigue la convención de este repo de recibir
 * repositorios directos, no servicios completos -- ver
 * `ReservationHoldExpiryWorker`), y el método original era PRIVADO de
 * `InvoiceService`, se extrae a una función de módulo que las dos partes
 * importan: `InvoiceService` la delega desde su propio método privado
 * (mismo nombre, mismo docblock resumido, para no romper los 3 call-sites
 * internos que ya lo invocan como `this.transitionCreditNoteRequestAfterFailure(...)`
 * -- `issue()` en las líneas de las ramas `REJECTED`/`FAILED_UNCERTAIN` (x2) y
 * `reconcileAfterFailure()` (x1), verificado por nombre de método, no por
 * número de línea, desde SCHEMA-ANCHOR-DRIFT-001),
 * y el worker la llama directo con su propio `creditNoteRequestRepo`
 * inyectado.
 *
 * Mismo criterio que `domain/audit.ts::recordFieldChanges()` -- un helper
 * compartido entre módulos de dominio, no una clase con estado.
 *
 * ## Contrato (sin cambios respecto al método original)
 *
 * SIEMPRE se llama con el `client` de la MISMA transacción que ya escribió
 * la factura a su estado de fallo (`markFailedWithClient()`/el `UPDATE`
 * condicionado del worker, según el caller) -- atomic-state-mutation: un
 * solo commit, nunca dos escrituras sueltas que puedan divergir si una
 * falla a mitad de camino. Ningún caller debe envolver esta llamada en su
 * propia transacción separada.
 *
 * No-op si la factura no tiene una fila `credit_note_request` asociada
 * (camino mayoritario: factura normal, sin escape fiscal de por medio --
 * solo `InvoiceService.buildCreditNote()`, con `tx.type === 'ADJUSTMENT'`,
 * crea una).
 *
 * Tolera `CreditNoteRequestInvalidTransitionError` ÚNICAMENTE cuando
 * `fromState === 'CERRADA'` (terminal, A6.4): un reintento (vía
 * `retryExisting()`, o -- desde este bloque -- el worker expirando una
 * `PENDING` vieja) sobre una factura cuya `credit_note_request` ya cerró en
 * un ciclo anterior no debe abortar el `UPDATE` de `invoices` que la MISMA
 * transacción ya aplicó -- ese `UPDATE` sigue siendo la escritura correcta
 * y autoritativa, no tiene sentido revertirla por un estado de workflow que
 * ya llegó a destino. Cualquier OTRA forma de `CreditNoteRequestInvalidTransitionError`
 * (p. ej. `fromState === 'EN_REVISION_MANUAL'`) SÍ hace fallar toda la
 * transacción -- señalaría un camino no contemplado por este diseño.
 *
 * **Bloque 4 (23/09/2026) -- un caller nuevo, fuera de `InvoiceService`:**
 * hasta este bloque, los únicos 3 call-sites conocidos (`issue()` x2,
 * `reconcileAfterFailure()` x1) llegaban acá SIEMPRE después de que
 * `retryExisting()` ya había bloqueado cualquier intento sobre una factura
 * `PENDING` (el guard `RetryInvoiceInFlightError`, `invoice.service.ts`) --
 * así que una `PENDING` nunca llegaba viva a este método por ESE camino. El
 * `InvoicePendingExpiryWorker` es la primera vía que SÍ le pasa una factura
 * que ACABA de salir de `PENDING` (la que su propio `UPDATE` condicionado
 * movió a `FAILED_UNCERTAIN`, ver `sql.invoice.repository.ts::expirePendingWithClient()`)
 * -- el razonamiento de la tolerancia CERRADA de arriba sigue aplicando
 * igual: si la `credit_note_request` de esa factura ya está `CERRADA`
 * (invariante hoy no confirmado como alcanzable para este caller puntual,
 * pero no descartado -- una fila `credit_note_request` es 1:1 con su
 * factura, así que solo podría llegar `CERRADA` si algo la cerró ANTES de
 * que la factura volviera a estar `PENDING`, lo cual no tiene camino
 * conocido hoy), se tolera igual que para los 3 call-sites automáticos.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { CreditNoteRequestRepository } from './credit-note-request.repository.js';
import type { TransitionCreditNoteRequestInput } from './credit-note-request.entities.js';
import { CreditNoteRequestInvalidTransitionError } from '../domain/errors.js';
import { logger } from '../logger.js';

export type CreditNoteRequestRepoForFailureTransition = Pick<
  CreditNoteRequestRepository,
  'findByInvoiceId' | 'transitionWithClient'
>;

export async function transitionCreditNoteRequestAfterFailure(
  creditNoteRequestRepo: CreditNoteRequestRepoForFailureTransition,
  client: SqlClient,
  invoiceId: string,
  transition: TransitionCreditNoteRequestInput,
): Promise<void> {
  const request = await creditNoteRequestRepo.findByInvoiceId(invoiceId);
  if (!request) return; // camino mayoritario -- sin escape de NC, nada que transicionar.

  try {
    await creditNoteRequestRepo.transitionWithClient(client, request.id, transition);
  } catch (err) {
    if (err instanceof CreditNoteRequestInvalidTransitionError && err.fromState === 'CERRADA') {
      logger.warn(
        {
          creditNoteRequestId: request.id,
          invoiceId,
          attemptedToState: transition.toState,
        },
        '[transitionCreditNoteRequestAfterFailure] credit_note_request ya estaba CERRADA (terminal) -- se tolera el intento de transición ' +
          '(reintento/vencimiento de una factura cuyo workflow de NC ya se había resuelto), no se aborta el UPDATE de invoices ya aplicado en esta misma tx',
      );
      return;
    }
    throw err;
  }
}
