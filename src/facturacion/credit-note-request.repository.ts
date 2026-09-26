import type { SqlClient } from '../repositories/sql.client.js';
import type {
  CreditNoteRequest,
  CreditNoteRequestState,
  CreateCreditNoteRequestInput,
  TransitionCreditNoteRequestInput,
} from './credit-note-request.entities.js';

export interface ListCreditNoteRequestsByStateOptions {
  /** Default: sin techo -- el índice parcial `idx_credit_note_request_state` ya acota a la bandeja. */
  limit?: number;
  offset?: number;
}

export interface CreditNoteRequestRepository {
  /**
   * El INSERT corre DENTRO de la transacción de `buildCreditNote()` cuando
   * se cablee (Bloque 3, fuera de este alcance) -- por eso recibe `client`
   * desde el día uno, mismo patrón que
   * `InvoiceRepository.createWithClient()`. Estado inicial siempre
   * `PENDIENTE` (default de columna, schema.sql) -- no se recibe por input.
   */
  createWithClient(client: SqlClient, input: CreateCreditNoteRequestInput): Promise<CreditNoteRequest>;

  /** R2 -- sin filtro de estado. Devuelve la fila en CUALQUIER estado, o null. */
  findById(id: string): Promise<CreditNoteRequest | null>;

  /**
   * `invoice_id` es UNIQUE (schema.sql) -- a lo sumo una fila. Necesario
   * para que `markFailed()` (Bloque 2, fuera de este alcance) pueda
   * resolver "¿esta invoice ya tiene una fila de solicitud asociada?"
   * antes de decidir si escala a revisión manual.
   */
  findByInvoiceId(invoiceId: string): Promise<CreditNoteRequest | null>;

  /**
   * Las 3 transiciones válidas (A6.2, ver `ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS`
   * en `credit-note-request.entities.ts`). Lockea la fila (`FOR UPDATE`)
   * dentro de la transacción del caller antes de validar -- mismo criterio
   * que `getOutstandingForUpdate()`/`getRefundableForUpdate()` de
   * `InvoiceRepository`, necesario porque el mismo `buildCreditNote()`
   * puede transicionar esta fila más de una vez en la vida del feature.
   *
   * Lanza `CreditNoteRequestInvalidTransitionError` (A6.3,
   * `src/domain/errors.ts`) si `transition.toState` no figura entre las
   * transiciones permitidas desde el estado actual -- nunca un UPDATE
   * silencioso que deje la fila en un estado no declarado.
   */
  transitionWithClient(
    client: SqlClient,
    id: string,
    transition: TransitionCreditNoteRequestInput,
  ): Promise<CreditNoteRequest>;

  /**
   * Para la bandeja de revisión manual (B3, todavía sin pantalla en este
   * bloque) -- usa el índice parcial `idx_credit_note_request_state`
   * (`WHERE state = 'EN_REVISION_MANUAL'`, ordenado por `created_at`).
   * Orden `created_at ASC` -- el más viejo primero, mismo criterio que
   * `InvoiceRepository.getByStatus()` (distinguir "trabado hace 3 minutos"
   * de "trabado hace 3 días").
   */
  listByState(state: CreditNoteRequestState, options?: ListCreditNoteRequestsByStateOptions): Promise<CreditNoteRequest[]>;
  /**
   * ADR `ISSUE-BEFORE-REVERSE-WINDOW-001` (23/09/2026), Bloque 3, §3.9,
   * "A-4" -- lockea la fila (`SELECT ... FOR UPDATE`) SIN validar contra
   * `ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS` (a diferencia de
   * `transitionWithClient()`, que sí valida): `resolveCreditNoteRequestManually()`
   * la usa dentro de su reclasificación para LEER el estado actual bajo
   * lock (incluido `PENDIENTE`, que `transitionWithClient()` rechazaría de
   * entrada para `toState: 'CERRADA'` sin pasar por `EN_REVISION_MANUAL` --
   * ver P-2, `CreditNoteRequestNotInManualReviewError`), no para
   * transicionar todavía. Mismo orden de lock que el resto del método
   * (factura primero, solicitud después). `null` si el id no existe --
   * invariante roto real (mismo criterio que `getReconciliationSnapshotForUpdate()`
   * de `InvoiceRepository`).
   */
  findByIdForUpdate(client: SqlClient, id: string): Promise<CreditNoteRequest | null>;

  /**
   * Bloque 6 (§6.5 bis, pregunta 2) -- poll de `CreditNoteReviewSlaWorker`.
   * Reusa el índice parcial `idx_credit_note_request_state` (`WHERE state =
   * 'EN_REVISION_MANUAL'`): `created_at` es el proxy de antigüedad en
   * revisión (única transición de entrada, sin camino de vuelta a
   * `PENDIENTE` -- ver el comentario del índice en `schema.sql`).
   * `olderThan` ya viene resuelto por el caller (`now - SLA`) -- este
   * método no conoce el valor del SLA. Orden `created_at ASC`, mismo
   * criterio que `listByState()`.
   */
  listEligibleForSlaAlert(olderThan: Date): Promise<CreditNoteRequest[]>;

  /**
   * Bloque 6 -- marca `sla_alert_sent_at = NOW()` como compare-and-swap
   * (`WHERE sla_alert_sent_at IS NULL AND state = 'EN_REVISION_MANUAL'`), no
   * un UPDATE incondicional: sin el primer filtro, dos instancias del
   * proceso (o dos ciclos de poll solapados) podrían mandar el aviso dos
   * veces para la misma fila antes de que cualquiera de las dos termine de
   * escribir; sin el segundo (26/09/2026, gate `architecture-governor`), se
   * podría reclamar una fila que pasó a otro estado (p. ej. `CERRADA`) entre
   * el `listEligibleForSlaAlert()` del caller y este reclamo. Devuelve
   * `true` solo si ESTA llamada fue la que reclamó la fila (0 filas
   * afectadas -> ya estaba marcada o ya no está en `EN_REVISION_MANUAL`,
   * `false`) -- el caller usa el resultado para decidir si de verdad tiene
   * que mandar el mail.
   */
  markSlaAlertSent(id: string): Promise<boolean>;
}
