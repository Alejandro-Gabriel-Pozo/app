import type { SqlClient } from '../repositories/sql.client.js';
import type {
  AccountReceivable,
  AccountsReceivableRepository,
  AccountsReceivableReportRow,
  AccountsReceivableStatus,
} from './accounts-receivable.repository.js';

interface AccountsReceivableRow {
  id: string;
  business_id: string;
  stay_id: string;
  company_customer_id: string;
  amount: string; // DECIMAL llega como string en pg
  currency: string;
  status: AccountsReceivableStatus;
  transferred_by: string;
  notes: string | null;
  created_at: Date;
  invoiced_at: Date | null;
  collected_at: Date | null;
  invoice_ref: string | null;
  financial_transaction_id: string | null;
  guest_payment_transaction_id: string | null;
  reversed_by: string | null;
  reversed_at: Date | null;
  reversed_reason: string | null;
  replaces_ar_id: string | null;
}

export class SqlAccountsReceivableRepository implements AccountsReceivableRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async createWithClient(
    client: SqlClient,
    ar: Omit<AccountReceivable, 'createdAt' | 'invoicedAt' | 'collectedAt'>,
  ): Promise<AccountReceivable> {
    const result = await client.query<AccountsReceivableRow>(
      `INSERT INTO accounts_receivable
         (id, business_id, stay_id, company_customer_id, amount, currency, status, transferred_by, notes, financial_transaction_id, guest_payment_transaction_id, replaces_ar_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        ar.id,
        ar.businessId,
        ar.stayId,
        ar.companyCustomerId,
        ar.amount,
        ar.currency,
        ar.status,
        ar.transferredBy,
        ar.notes ?? null,
        ar.financialTransactionId ?? null,
        ar.guestPaymentTransactionId ?? null,
        ar.replacesArId ?? null,
      ],
    );
    return this.rowToEntity(result.rows[0]!);
  }

  async getById(id: string): Promise<AccountReceivable | undefined> {
    const result = await this.sqlClient.query<AccountsReceivableRow>(
      `SELECT * FROM accounts_receivable WHERE id = $1`,
      [id],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async getByStayId(stayId: string): Promise<AccountReceivable[]> {
    const result = await this.sqlClient.query<AccountsReceivableRow>(
      `SELECT * FROM accounts_receivable
       WHERE stay_id = $1
       ORDER BY created_at ASC`,
      [stayId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getByCompanyCustomerId(companyCustomerId: string): Promise<AccountReceivable[]> {
    const result = await this.sqlClient.query<AccountsReceivableRow>(
      `SELECT * FROM accounts_receivable
       WHERE company_customer_id = $1
       ORDER BY created_at DESC`,
      [companyCustomerId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getPendingByCompanyCustomerId(companyCustomerId: string): Promise<AccountReceivable[]> {
    const result = await this.sqlClient.query<AccountsReceivableRow>(
      `SELECT * FROM accounts_receivable
       WHERE company_customer_id = $1 AND status = 'PENDIENTE_FACTURAR' AND financial_transaction_id IS NOT NULL
       ORDER BY created_at ASC`,
      [companyCustomerId],
    );
    return result.rows.map((r) => this.rowToEntity(r));
  }

  async getByFinancialTransactionId(financialTransactionId: string): Promise<AccountReceivable | undefined> {
    const result = await this.sqlClient.query<AccountsReceivableRow>(
      `SELECT * FROM accounts_receivable WHERE financial_transaction_id = $1`,
      [financialTransactionId],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async markInvoiced(id: string, invoiceRef?: string | null): Promise<AccountReceivable | undefined> {
    const result = await this.sqlClient.query<AccountsReceivableRow>(
      `UPDATE accounts_receivable
       SET status = 'FACTURADO', invoiced_at = NOW(), invoice_ref = $2
       WHERE id = $1 AND status = 'PENDIENTE_FACTURAR'
       RETURNING *`,
      [id, invoiceRef ?? null],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async markCollected(id: string): Promise<AccountReceivable | undefined> {
    return this.doMarkCollected(this.sqlClient, id);
  }

  async markCollectedWithClient(client: SqlClient, id: string): Promise<AccountReceivable | undefined> {
    return this.doMarkCollected(client, id);
  }

  async getByIdWithLock(client: SqlClient, id: string): Promise<AccountReceivable | undefined> {
    const result = await client.query<AccountsReceivableRow>(
      `SELECT * FROM accounts_receivable WHERE id = $1 FOR UPDATE`,
      [id],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async markRevertedWithClient(
    client: SqlClient,
    id: string,
    params: { reversedBy: string; reason: string },
  ): Promise<AccountReceivable | undefined> {
    const result = await client.query<AccountsReceivableRow>(
      `UPDATE accounts_receivable
       SET status = 'REVERTIDO', reversed_by = $2, reversed_at = NOW(), reversed_reason = $3
       WHERE id = $1 AND status = 'PENDIENTE_FACTURAR'
       RETURNING *`,
      [id, params.reversedBy, params.reason],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  private async doMarkCollected(client: SqlClient, id: string): Promise<AccountReceivable | undefined> {
    const result = await client.query<AccountsReceivableRow>(
      `UPDATE accounts_receivable
       SET status = 'COBRADO', collected_at = NOW()
       WHERE id = $1 AND status = 'FACTURADO'
       RETURNING *`,
      [id],
    );
    return result.rows[0] ? this.rowToEntity(result.rows[0]) : undefined;
  }

  async getReportByPeriod(from: Date, to: Date): Promise<AccountsReceivableReportRow[]> {
    const result = await this.sqlClient.query<{
      company_customer_id: string;
      company_name: string;
      count: string;
      total_amount: string;
      pending_amount: string;
      invoiced_amount: string;
      collected_amount: string;
      reverted_amount: string;
    }>(
      `SELECT
         ar.company_customer_id,
         c.display_name AS company_name,
         COUNT(*) AS count,
         SUM(ar.amount) AS total_amount,
         SUM(ar.amount) FILTER (WHERE ar.status = 'PENDIENTE_FACTURAR') AS pending_amount,
         SUM(ar.amount) FILTER (WHERE ar.status = 'FACTURADO')          AS invoiced_amount,
         SUM(ar.amount) FILTER (WHERE ar.status = 'COBRADO')            AS collected_amount,
         SUM(ar.amount) FILTER (WHERE ar.status = 'REVERTIDO')          AS reverted_amount
       FROM accounts_receivable ar
       JOIN customers c ON c.id = ar.company_customer_id
       WHERE ar.created_at >= $1 AND ar.created_at <= $2
       GROUP BY ar.company_customer_id, c.display_name
       ORDER BY total_amount DESC`,
      [from, to],
    );

    return result.rows.map((row) => ({
      companyCustomerId: row.company_customer_id,
      companyName:       row.company_name,
      count:              parseInt(row.count, 10),
      totalAmount:        parseFloat(row.total_amount),
      pendingAmount:      parseFloat(row.pending_amount ?? '0'),
      invoicedAmount:     parseFloat(row.invoiced_amount ?? '0'),
      collectedAmount:    parseFloat(row.collected_amount ?? '0'),
      revertedAmount:     parseFloat(row.reverted_amount ?? '0'),
    }));
  }

  private rowToEntity(row: AccountsReceivableRow): AccountReceivable {
    return {
      id:                 row.id,
      businessId:         row.business_id,
      stayId:             row.stay_id,
      companyCustomerId:  row.company_customer_id,
      amount:             parseFloat(row.amount),
      currency:           row.currency,
      status:             row.status,
      transferredBy:      row.transferred_by,
      notes:              row.notes,
      createdAt:          row.created_at,
      invoicedAt:         row.invoiced_at,
      collectedAt:        row.collected_at,
      invoiceRef:         row.invoice_ref,
      financialTransactionId: row.financial_transaction_id,
      guestPaymentTransactionId: row.guest_payment_transaction_id,
      reversedBy:         row.reversed_by,
      reversedAt:         row.reversed_at,
      reversedReason:     row.reversed_reason,
      replacesArId:       row.replaces_ar_id,
    };
  }
}
