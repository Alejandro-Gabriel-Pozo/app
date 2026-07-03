import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
  TransactionStatus,
  TransactionType,
} from './financial-transaction.repository.js';

interface TransactionRow {
  id: string;
  business_id: string;
  customer_id: string;
  reservation_id: string | null;
  idempotency_key: string | null;
  type: TransactionType;
  amount: string; // DECIMAL llega como string en pg
  currency: string;
  status: TransactionStatus;
  created_at: Date;
}

/**
 * Implementación SQL del ledger financiero.
 *
 * ## Diseño
 * - Nunca se actualiza `amount` in-place. Cada cambio económico es una fila nueva.
 * - `settleByReservationId` y `voidByReservationId` solo cambian `status`.
 * - `getNetBalanceByCustomerId` calcula el balance directamente en SQL.
 * - `create()` con `idempotencyKey`: ON CONFLICT DO NOTHING sobre el UNIQUE index
 *   `idx_ft_idempotency_key`. Permite múltiples CHARGE por reserva (anticipo + saldo)
 *   mientras el outbox worker no crea duplicados en reintentos.
 *
 * Schema esperado: ver `migrations/004_financial_transactions.sql`.
 */
export class SqlFinancialTransactionRepository implements FinancialTransactionRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async create(
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    const id = tx.id ?? randomUUID();
    const idempotencyKey = tx.idempotencyKey ?? null;

    if (idempotencyKey !== null) {
      // Path idempotente: el worker usa esto para evitar duplicados en reintentos.
      // ON CONFLICT DO NOTHING sobre idx_ft_idempotency_key (UNIQUE, WHERE NOT NULL).
      const result = await this.sqlClient.query<TransactionRow>(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, reservation_id, idempotency_key, type, amount, currency, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id,
          tx.businessId,
          tx.customerId,
          tx.reservationId ?? null,
          idempotencyKey,
          tx.type,
          tx.amount,
          tx.currency,
          tx.status,
        ],
      );
      // RETURNING vacío = ON CONFLICT activado = fila ya existía = éxito silencioso.
      return result.rows[0] ? this.rowToEntity(result.rows[0]) : null;
    }

    // Path normal (sin idempotency_key): INSERT estándar, lanza en conflicto de id.
    const result = await this.sqlClient.query<TransactionRow>(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, reservation_id, type, amount, currency, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        id,
        tx.businessId,
        tx.customerId,
        tx.reservationId ?? null,
        tx.type,
        tx.amount,
        tx.currency,
        tx.status,
      ],
    );
    return this.rowToEntity(result.rows[0]);
  }

  async getByReservationId(reservationId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE reservation_id = $1
       ORDER BY created_at ASC`,
      [reservationId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getByCustomerId(customerId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE customer_id = $1
       ORDER BY created_at DESC`,
      [customerId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async settleByReservationId(reservationId: string): Promise<number> {
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET status = 'SETTLED'
       WHERE reservation_id = $1
         AND status = 'PENDING'`,
      [reservationId],
    );
    return result.rowCount ?? 0;
  }

  async voidByReservationId(reservationId: string): Promise<number> {
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET status = 'VOIDED'
       WHERE reservation_id = $1
         AND status IN ('PENDING', 'SETTLED')`,
      [reservationId],
    );
    return result.rowCount ?? 0;
  }

  async getNetBalanceByCustomerId(customerId: string): Promise<number> {
    const result = await this.sqlClient.query<{ net: string }>(
      `SELECT
         COALESCE(
           SUM(
             CASE type
               WHEN 'CHARGE'     THEN  amount
               WHEN 'ADJUSTMENT' THEN  amount
               WHEN 'PAYMENT'    THEN -amount
               WHEN 'REFUND'     THEN -amount
             END
           ), 0
         ) AS net
       FROM financial_transactions
       WHERE customer_id = $1
         AND status = 'SETTLED'`,
      [customerId],
    );
    return parseFloat(result.rows[0]?.net ?? '0');
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  private rowToEntity(row: TransactionRow): FinancialTransaction {
    return {
      id:              row.id,
      businessId:      row.business_id,
      customerId:      row.customer_id,
      reservationId:   row.reservation_id,
      idempotencyKey:  row.idempotency_key,
      type:            row.type,
      amount:          parseFloat(row.amount),
      currency:        row.currency,
      status:          row.status,
      createdAt:       row.created_at,
    };
  }
}
