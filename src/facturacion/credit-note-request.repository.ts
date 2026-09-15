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
}
