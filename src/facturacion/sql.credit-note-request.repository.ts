import type { SqlClient } from '../repositories/sql.client.js';
import type {
  CreditNoteRequest,
  CreditNoteRequestState,
  CreditNoteRequestResolutionOutcome,
  CreateCreditNoteRequestInput,
  TransitionCreditNoteRequestInput,
} from './credit-note-request.entities.js';
import { ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS } from './credit-note-request.entities.js';
import type { CreditNoteRequestRepository, ListCreditNoteRequestsByStateOptions } from './credit-note-request.repository.js';
import { CreditNoteRequestInvalidTransitionError } from '../domain/errors.js';

interface CreditNoteRequestRow {
  id: string;
  business_id: string;
  invoice_id: string;
  reversed_invoice_id: string;
  order_id: string | null;
  reservation_id: string | null;
  state: CreditNoteRequestState;
  resolution_outcome: CreditNoteRequestResolutionOutcome | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  resolution_note: string | null;
  sla_alert_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToEntity(row: CreditNoteRequestRow): CreditNoteRequest {
  return {
    id: row.id,
    businessId: row.business_id,
    invoiceId: row.invoice_id,
    reversedInvoiceId: row.reversed_invoice_id,
    orderId: row.order_id,
    reservationId: row.reservation_id,
    state: row.state,
    resolutionOutcome: row.resolution_outcome,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    resolutionNote: row.resolution_note,
    slaAlertSentAt: row.sla_alert_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqlCreditNoteRequestRepository implements CreditNoteRequestRepository {
  constructor(private readonly db: SqlClient) {}

  async createWithClient(client: SqlClient, input: CreateCreditNoteRequestInput): Promise<CreditNoteRequest> {
    const orderId = input.subject.kind === 'ORDER' ? input.subject.id : null;
    const reservationId = input.subject.kind === 'RESERVATION' ? input.subject.id : null;

    const { rows } = await client.query<CreditNoteRequestRow>(
      `INSERT INTO credit_note_request
         (id, business_id, invoice_id, reversed_invoice_id, order_id, reservation_id, state)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDIENTE')
       RETURNING *`,
      [input.id, input.businessId, input.invoiceId, input.reversedInvoiceId, orderId, reservationId],
    );
    return rowToEntity(rows[0]!);
  }

  async findById(id: string): Promise<CreditNoteRequest | null> {
    // R2 -- sin WHERE de estado, nunca filtrar por state acá.
    const { rows } = await this.db.query<CreditNoteRequestRow>(
      `SELECT * FROM credit_note_request WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async findByInvoiceId(invoiceId: string): Promise<CreditNoteRequest | null> {
    // invoice_id es UNIQUE (schema.sql) -- a lo sumo una fila.
    const { rows } = await this.db.query<CreditNoteRequestRow>(
      `SELECT * FROM credit_note_request WHERE invoice_id = $1`,
      [invoiceId],
    );
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async transitionWithClient(
    client: SqlClient,
    id: string,
    transition: TransitionCreditNoteRequestInput,
  ): Promise<CreditNoteRequest> {
    // Lock primero, dos sentencias separadas -- mismo patrón que
    // `getOutstandingForUpdate()`/`getRefundableForUpdate()` de
    // `SqlInvoiceRepository`: evita computar/validar sobre una foto vieja
    // mientras se espera el lock bajo Postgres real.
    const { rows: currentRows } = await client.query<CreditNoteRequestRow>(
      `SELECT * FROM credit_note_request WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const current = currentRows[0];
    if (!current) throw new Error(`CreditNoteRequest ${id} no encontrada al transicionar`);

    const allowed = ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS[current.state];
    if (!allowed.includes(transition.toState)) {
      throw new CreditNoteRequestInvalidTransitionError(id, current.state, transition.toState);
    }

    if (transition.toState === 'EN_REVISION_MANUAL') {
      const { rows } = await client.query<CreditNoteRequestRow>(
        `UPDATE credit_note_request SET state = 'EN_REVISION_MANUAL' WHERE id = $1 RETURNING *`,
        [id],
      );
      return rowToEntity(rows[0]!);
    }

    // toState === 'CERRADA' -- dos caminos, mismos 2 que el CHECK
    // `chk_credit_note_request_resolution_consistency` permite.
    if (transition.resolutionOutcome === null) {
      // Cierre automático -- los 3 campos de resolución quedan NULL.
      const { rows } = await client.query<CreditNoteRequestRow>(
        `UPDATE credit_note_request
         SET state = 'CERRADA', resolution_outcome = NULL, resolved_by = NULL, resolved_at = NULL, resolution_note = NULL
         WHERE id = $1
         RETURNING *`,
        [id],
      );
      return rowToEntity(rows[0]!);
    }

    // Cierre manual -- los 3 campos van poblados juntos. `resolved_at` lo
    // pone NOW() del lado SQL (nunca el reloj de la app).
    const { rows } = await client.query<CreditNoteRequestRow>(
      `UPDATE credit_note_request
       SET state = 'CERRADA', resolution_outcome = $2, resolved_by = $3, resolved_at = NOW(), resolution_note = $4
       WHERE id = $1
       RETURNING *`,
      [id, transition.resolutionOutcome, transition.resolvedBy, transition.resolutionNote],
    );
    return rowToEntity(rows[0]!);
  }

  async findByIdForUpdate(client: SqlClient, id: string): Promise<CreditNoteRequest | null> {
    // ADR `ISSUE-BEFORE-REVERSE-WINDOW-001`, Bloque 3, §3.9, "A-4" -- SIN
    // validar transición (a diferencia de transitionWithClient()), solo
    // lockea y devuelve el estado actual para que el caller reclasifique.
    const { rows } = await client.query<CreditNoteRequestRow>(
      `SELECT * FROM credit_note_request WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async listByState(
    state: CreditNoteRequestState,
    options: ListCreditNoteRequestsByStateOptions = {},
  ): Promise<CreditNoteRequest[]> {
    // ORDER BY created_at ASC -- el más viejo primero (mismo criterio que
    // InvoiceRepository.getByStatus()). Usa el índice parcial
    // idx_credit_note_request_state cuando state = 'EN_REVISION_MANUAL'.
    const params: unknown[] = [state];
    let sql = `SELECT * FROM credit_note_request WHERE state = $1 ORDER BY created_at ASC`;
    if (options.limit !== undefined) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
      sql += ` OFFSET $${params.length}`;
    }
    const { rows } = await this.db.query<CreditNoteRequestRow>(sql, params);
    return rows.map(rowToEntity);
  }

  async listEligibleForSlaAlert(olderThan: Date): Promise<CreditNoteRequest[]> {
    // Cubierta por idx_credit_note_request_state (state, created_at)
    // WHERE state = 'EN_REVISION_MANUAL' -- created_at < $2 y
    // sla_alert_sent_at IS NULL son filtros adicionales sobre ese mismo
    // rango, no un índice nuevo (ver comentario del índice en schema.sql).
    const { rows } = await this.db.query<CreditNoteRequestRow>(
      `SELECT * FROM credit_note_request
       WHERE state = 'EN_REVISION_MANUAL' AND created_at < $1 AND sla_alert_sent_at IS NULL
       ORDER BY created_at ASC`,
      [olderThan],
    );
    return rows.map(rowToEntity);
  }

  async markSlaAlertSent(id: string): Promise<boolean> {
    // Compare-and-swap -- WHERE sla_alert_sent_at IS NULL, no un UPDATE
    // incondicional (ver docblock de la interfaz). rowCount === 0 significa
    // "otra instancia ya la reclamó" (o la fila ya no está en
    // EN_REVISION_MANUAL), no un error. `AND state = 'EN_REVISION_MANUAL'`
    // (26/09/2026, gate `architecture-governor`) evita reclamar una fila que
    // pasó a otro estado (p. ej. `CERRADA` vía `resolveCreditNoteRequestManually()`)
    // entre el listado de `listEligibleForSlaAlert()` y este reclamo.
    const { rowCount } = await this.db.query(
      `UPDATE credit_note_request SET sla_alert_sent_at = NOW()
       WHERE id = $1 AND sla_alert_sent_at IS NULL AND state = 'EN_REVISION_MANUAL'`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
}
