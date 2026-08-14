import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
  PaymentInfo,
  PaymentMethod,
  TransactionStatus,
  TransactionType,
} from './financial-transaction.repository.js';

interface TransactionRow {
  id: string;
  business_id: string;
  customer_id: string;
  reservation_id: string | null;
  order_id: string | null;
  stay_id: string | null;
  idempotency_key: string | null;
  type: TransactionType;
  amount: string; // DECIMAL llega como string en pg
  currency: string;
  status: TransactionStatus;
  notes: string | null;
  payment_method: PaymentMethod | null;
  shift_id: string | null;
  card_installments: number | null;
  card_surcharge_amount: string | null; // DECIMAL llega como string en pg
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
    return this.insert(this.sqlClient, tx);
  }

  async createWithClient(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    return this.insert(client, tx);
  }

  private async insert(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    const id = tx.id ?? randomUUID();
    const idempotencyKey = tx.idempotencyKey ?? null;
    const paymentMethod = tx.paymentMethod ?? null;
    const explicitShiftId = tx.shiftId ?? null;
    const cardInstallments = tx.cardInstallments ?? null;
    const cardSurchargeAmount = tx.cardSurchargeAmount ?? null;

    if (idempotencyKey !== null) {
      // Path idempotente: el worker usa esto para evitar duplicados en reintentos.
      // ON CONFLICT DO NOTHING sobre idx_ft_idempotency_key (UNIQUE, WHERE NOT NULL).
      //
      // shift_id: si el caller no lo pasó explícito ($14) y el medio de pago
      // ($13) es 'CASH', se resuelve al turno OPEN del negocio ($2) en la
      // misma sentencia (A8.2 — constraint/subquery, no un SELECT previo en
      // el service). Tarjeta/transferencia o sin turno abierto: queda NULL.
      // card_installments/card_surcharge_amount ($15/$16) son puramente
      // descriptivos (Gap Tango #3) — el CHECK de BD exige payment_method
      // = 'CARD' para que no sean NULL, no hace falta replicar esa lógica acá.
      const result = await client.query<TransactionRow>(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, reservation_id, order_id, stay_id, idempotency_key, type, amount, currency, status, notes, payment_method, shift_id, card_installments, card_surcharge_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
           COALESCE($14, CASE WHEN $13 = 'CASH'
             THEN (SELECT id FROM cash_register_shifts WHERE business_id = $2 AND status = 'OPEN')
             ELSE NULL END), $15, $16)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING *`,
        [
          id,
          tx.businessId,
          tx.customerId,
          tx.reservationId ?? null,
          tx.orderId ?? null,
          tx.stayId ?? null,
          idempotencyKey,
          tx.type,
          tx.amount,
          tx.currency,
          tx.status,
          tx.notes ?? null,
          paymentMethod,
          explicitShiftId,
          cardInstallments,
          cardSurchargeAmount,
        ],
      );
      // RETURNING vacío = ON CONFLICT activado = fila ya existía = éxito silencioso.
      return result.rows[0] ? this.rowToEntity(result.rows[0]) : null;
    }

    // Path normal (sin idempotency_key): INSERT estándar, lanza en conflicto
    // de id. Mismo criterio de shift_id/card_* que el path idempotente (ver arriba).
    const result = await client.query<TransactionRow>(
      `INSERT INTO financial_transactions
         (id, business_id, customer_id, reservation_id, order_id, stay_id, type, amount, currency, status, notes, payment_method, shift_id, card_installments, card_surcharge_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         COALESCE($13, CASE WHEN $12 = 'CASH'
           THEN (SELECT id FROM cash_register_shifts WHERE business_id = $2 AND status = 'OPEN')
           ELSE NULL END), $14, $15)
       RETURNING *`,
      [
        id,
        tx.businessId,
        tx.customerId,
        tx.reservationId ?? null,
        tx.orderId ?? null,
        tx.stayId ?? null,
        tx.type,
        tx.amount,
        tx.currency,
        tx.status,
        tx.notes ?? null,
        paymentMethod,
        explicitShiftId,
        cardInstallments,
        cardSurchargeAmount,
      ],
    );
    return this.rowToEntity(result.rows[0]!);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<FinancialTransaction | undefined> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
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

  async getByOrderId(orderId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE order_id = $1
       ORDER BY created_at ASC`,
      [orderId],
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

  async getByStayId(stayId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE stay_id = $1
       ORDER BY created_at ASC`,
      [stayId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getByShiftId(shiftId: string): Promise<FinancialTransaction[]> {
    const result = await this.sqlClient.query<TransactionRow>(
      `SELECT * FROM financial_transactions
       WHERE shift_id = $1
       ORDER BY created_at ASC`,
      [shiftId],
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

  async settleByOrderId(orderId: string, paymentInfo?: PaymentInfo): Promise<number> {
    const method = paymentInfo?.paymentMethod ?? null;
    const cardInstallments = paymentInfo?.cardInstallments ?? null;
    const cardSurchargeAmount = paymentInfo?.cardSurchargeAmount ?? null;
    // shift_id: mismo criterio que insert() — solo se vincula si el medio de
    // pago es 'CASH' y hay un turno OPEN para el negocio de esta fila
    // (business_id ya está en la fila, no hace falta que el caller lo pase).
    // card_installments/card_surcharge_amount: se persisten tal cual vienen
    // (Gap Tango #3) — el CHECK de BD exige payment_method = 'CARD' cuando
    // no son NULL.
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET status = 'SETTLED',
           payment_method = COALESCE($2, payment_method),
           shift_id = CASE WHEN $2 = 'CASH'
             THEN (SELECT id FROM cash_register_shifts WHERE business_id = financial_transactions.business_id AND status = 'OPEN')
             ELSE shift_id END,
           card_installments = COALESCE($3, card_installments),
           card_surcharge_amount = COALESCE($4, card_surcharge_amount)
       WHERE order_id = $1
         AND status = 'PENDING'`,
      [orderId, method, cardInstallments, cardSurchargeAmount],
    );
    return result.rowCount ?? 0;
  }

  async voidByOrderId(orderId: string): Promise<number> {
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET status = 'VOIDED'
       WHERE order_id = $1
         AND status IN ('PENDING', 'SETTLED')`,
      [orderId],
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

  async linkStayToReservationCharges(stayId: string, reservationId: string): Promise<number> {
    const result = await this.sqlClient.query(
      `UPDATE financial_transactions
       SET stay_id = $1
       WHERE reservation_id = $2
         AND stay_id IS NULL`,
      [stayId, reservationId],
    );
    return result.rowCount ?? 0;
  }

  async getNetBalanceByStayId(stayId: string): Promise<number> {
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
       WHERE stay_id = $1
         AND status = 'SETTLED'`,
      [stayId],
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
      orderId:         row.order_id,
      stayId:          row.stay_id,
      idempotencyKey:  row.idempotency_key,
      type:            row.type,
      amount:          parseFloat(row.amount),
      currency:        row.currency,
      status:          row.status,
      notes:           row.notes,
      paymentMethod:   row.payment_method,
      shiftId:         row.shift_id,
      cardInstallments:    row.card_installments,
      cardSurchargeAmount: row.card_surcharge_amount !== null ? parseFloat(row.card_surcharge_amount) : null,
      createdAt:       row.created_at,
    };
  }
}
