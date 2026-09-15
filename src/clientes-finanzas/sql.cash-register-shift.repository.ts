import type { SqlClient } from '../repositories/sql.client.js';
import type {
  CashRegisterShift,
  CashRegisterShiftRepository,
  CloseShiftInput,
  OpenShiftInput,
  ShiftStatus,
} from './cash-register-shift.repository.js';

interface ShiftRow {
  id: string;
  business_id: string;
  opened_by: string;
  opened_at: Date;
  opening_amount: string; // DECIMAL llega como string en pg
  currency: string;
  status: ShiftStatus;
  closed_by: string | null;
  closed_at: Date | null;
  closing_amount_counted: string | null;
  expected_cash_amount: string | null;
  variance: string | null;
  notes: string | null;
}

/**
 * Implementación SQL de turnos de caja.
 *
 * Ver BLOQUE 11 de schema.sql para el razonamiento de diseño (TRANSACCIÓN,
 * A8.2, A6.5). `open()` no hace un SELECT-antes-de-INSERT para chequear que
 * no haya otro turno OPEN — el índice único parcial `uq_cash_shift_one_open_per_business`
 * es quien lo garantiza; el service traduce la violación (código 23505) a
 * un error de dominio.
 */
export class SqlCashRegisterShiftRepository implements CashRegisterShiftRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async getOpenShift(businessId: string): Promise<CashRegisterShift | undefined> {
    const result = await this.sqlClient.query<ShiftRow>(
      `SELECT * FROM cash_register_shifts WHERE business_id = $1 AND status = 'OPEN'`,
      [businessId],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<CashRegisterShift | undefined> {
    const result = await this.sqlClient.query<ShiftRow>(
      `SELECT * FROM cash_register_shifts WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async open(input: OpenShiftInput): Promise<CashRegisterShift> {
    const result = await this.sqlClient.query<ShiftRow>(
      `INSERT INTO cash_register_shifts (id, business_id, opened_by, opening_amount, currency, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.id, input.businessId, input.openedBy, input.openingAmount, input.currency, input.notes ?? null],
    );
    return this.rowToEntity(result.rows[0]!);
  }

  async getCashMovementsTotal(shiftId: string): Promise<number> {
    const result = await this.sqlClient.query<{ total: string }>(
      `SELECT
         COALESCE(
           SUM(
             CASE type
               WHEN 'PAYMENT' THEN  amount
               WHEN 'CHARGE'  THEN  amount
               WHEN 'REFUND'  THEN -amount
               ELSE 0
             END
           ), 0
         ) AS total
       FROM financial_transactions
       WHERE shift_id = $1
         AND payment_method = 'CASH'
         AND status = 'SETTLED'`,
      [shiftId],
    );
    return parseFloat(result.rows[0]?.total ?? '0');
  }

  async close(id: string, input: CloseShiftInput): Promise<CashRegisterShift> {
    const result = await this.sqlClient.query<ShiftRow>(
      `UPDATE cash_register_shifts
       SET status = 'CLOSED',
           closed_by = $2,
           closed_at = NOW(),
           closing_amount_counted = $3,
           expected_cash_amount = $4,
           variance = $5,
           notes = COALESCE($6, notes)
       WHERE id = $1
         AND status = 'OPEN'
       RETURNING *`,
      [
        id,
        input.closedBy,
        input.closingAmountCounted,
        input.expectedCashAmount,
        input.variance,
        input.notes ?? null,
      ],
    );
    if (!result.rows[0]) {
      throw new Error(`cash_register_shifts ${id} no está OPEN — no se puede cerrar.`);
    }
    return this.rowToEntity(result.rows[0]);
  }

  async list(businessId: string, filter?: { limit?: number; offset?: number }): Promise<CashRegisterShift[]> {
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;
    // Desempate explícito (D-14, 15/09/2026,
    // docs/decisiones-auditoria-fase2-2026-09-15.md #12, `, id DESC`) --
    // sin él, dos turnos con el mismo opened_at pueden aparecer duplicados
    // o faltar entre páginas.
    const result = await this.sqlClient.query<ShiftRow>(
      `SELECT * FROM cash_register_shifts
       WHERE business_id = $1
       ORDER BY opened_at DESC, id DESC
       LIMIT $2 OFFSET $3`,
      [businessId, limit, offset],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  private rowToEntity(row: ShiftRow): CashRegisterShift {
    return {
      id:                    row.id,
      businessId:            row.business_id,
      openedBy:              row.opened_by,
      openedAt:              row.opened_at,
      openingAmount:         parseFloat(row.opening_amount),
      currency:              row.currency,
      status:                row.status,
      closedBy:              row.closed_by,
      closedAt:              row.closed_at,
      closingAmountCounted:  row.closing_amount_counted  !== null ? parseFloat(row.closing_amount_counted)  : null,
      expectedCashAmount:    row.expected_cash_amount     !== null ? parseFloat(row.expected_cash_amount)    : null,
      variance:              row.variance                 !== null ? parseFloat(row.variance)                : null,
      notes:                 row.notes,
    };
  }
}
