import type { SqlClient } from '../repositories/sql.client.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus, AfipEnvironment, InvoiceItem, CreateInvoiceItemInput } from './invoice.entities.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput } from './invoice.repository.js';
import type { PaymentMethod } from '../clientes-finanzas/financial-transaction.repository.js';
import { randomUUID } from 'node:crypto';

interface InvoiceRow {
  id: string;
  business_id: string;
  financial_transaction_id: string;
  customer_id: string;
  idempotency_key: string;
  environment: AfipEnvironment;
  pto_vta: number;
  cbte_tipo: number;
  cbte_nro: string | null; // BIGINT llega como string en pg
  concepto: number;
  doc_tipo: number;
  doc_nro: string;
  condicion_iva_receptor_id: number;
  moneda: string;
  imp_neto: string;
  imp_iva: string;
  imp_total: string;
  cae: string | null;
  cae_vto: Date | null; // DATE llega como Date en pg, no como string
  status: InvoiceStatus;
  afip_contacted: boolean;
  emisor_cuit: string | null;
  payment_method: PaymentMethod | null;
  card_installments: number | null;
  afip_request: unknown;
  afip_response: unknown;
  error_message: string | null;
  created_at: Date;
  issued_at: Date | null;
}

function rowToEntity(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    businessId: row.business_id,
    financialTransactionId: row.financial_transaction_id,
    customerId: row.customer_id,
    idempotencyKey: row.idempotency_key,
    environment: row.environment,
    ptoVta: row.pto_vta,
    cbteTipo: row.cbte_tipo,
    cbteNro: row.cbte_nro !== null ? Number(row.cbte_nro) : null,
    concepto: row.concepto,
    docTipo: row.doc_tipo,
    docNro: row.doc_nro,
    condicionIvaReceptorId: row.condicion_iva_receptor_id,
    moneda: row.moneda,
    impNeto: parseFloat(row.imp_neto),
    impIva: parseFloat(row.imp_iva),
    impTotal: parseFloat(row.imp_total),
    cae: row.cae,
    caeVto: row.cae_vto ? row.cae_vto.toISOString().split('T')[0]! : null,
    status: row.status,
    afipContacted: row.afip_contacted,
    emisorCuit: row.emisor_cuit,
    paymentMethod: row.payment_method,
    cardInstallments: row.card_installments,
    afipRequest: row.afip_request,
    afipResponse: row.afip_response,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    issuedAt: row.issued_at,
  };
}

export class SqlInvoiceRepository implements InvoiceRepository {
  constructor(private readonly db: SqlClient) {}

  async getById(id: string): Promise<Invoice | null> {
    const { rows } = await this.db.query<InvoiceRow>(`SELECT * FROM invoices WHERE id = $1`, [id]);
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<Invoice | null> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    return rows[0] ? rowToEntity(rows[0]) : null;
  }

  async getByFinancialTransactionId(financialTransactionId: string): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE financial_transaction_id = $1 ORDER BY created_at ASC`,
      [financialTransactionId],
    );
    return rows.map(rowToEntity);
  }

  async create(input: CreateInvoiceInput, afipRequest: unknown, items: CreateInvoiceItemInput[]): Promise<Invoice> {
    return this.createWithClient(this.db, input, afipRequest, items);
  }

  async createWithClient(
    client: SqlClient,
    input: CreateInvoiceInput,
    afipRequest: unknown,
    items: CreateInvoiceItemInput[],
  ): Promise<Invoice> {
    const { rows } = await client.query<InvoiceRow>(
      `INSERT INTO invoices
         (id, business_id, financial_transaction_id, customer_id, idempotency_key, environment,
          pto_vta, cbte_tipo, emisor_cuit, concepto, doc_tipo, doc_nro, condicion_iva_receptor_id, moneda,
          imp_neto, imp_iva, imp_total, payment_method, card_installments, status, afip_request)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, 'PENDING', $20)
       RETURNING *`,
      [
        input.id, input.businessId, input.financialTransactionId, input.customerId,
        input.idempotencyKey, input.environment, input.ptoVta, input.cbteTipo, input.emisorCuit, input.concepto,
        input.docTipo, input.docNro, input.condicionIvaReceptorId, input.moneda,
        input.impNeto, input.impIva, input.impTotal,
        input.paymentMethod ?? null, input.cardInstallments ?? null,
        JSON.stringify(afipRequest),
      ],
    );

    for (const item of items) {
      await client.query(
        `INSERT INTO invoice_items
           (id, invoice_id, order_item_id, reservation_id, description, quantity, unit_price, subtotal, iva_rate, unit, arca_unit_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          randomUUID(), input.id, item.orderItemId, item.reservationId, item.description,
          item.quantity, item.unitPrice, item.subtotal, item.ivaRate, item.unit, item.arcaUnitCode,
        ],
      );
    }

    return rowToEntity(rows[0]!);
  }

  async getItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]> {
    const { rows } = await this.db.query<{
      id: string;
      invoice_id: string;
      order_item_id: string | null;
      reservation_id: string | null;
      description: string;
      quantity: string;
      unit_price: string;
      subtotal: string;
      iva_rate: string;
      unit: string | null;
      arca_unit_code: number | null;
      created_at: Date;
    }>(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY created_at ASC`,
      [invoiceId],
    );

    return rows.map((row) => ({
      id: row.id,
      invoiceId: row.invoice_id,
      orderItemId: row.order_item_id,
      reservationId: row.reservation_id,
      description: row.description,
      quantity: parseFloat(row.quantity),
      unitPrice: parseFloat(row.unit_price),
      subtotal: parseFloat(row.subtotal),
      ivaRate: parseFloat(row.iva_rate),
      unit: row.unit,
      arcaUnitCode: row.arca_unit_code,
      createdAt: row.created_at,
    }));
  }

  async markIssued(id: string, data: MarkIssuedInput): Promise<Invoice> {
    const { rows } = await this.db.query<InvoiceRow>(
      `UPDATE invoices
       SET cbte_nro = $2, cae = $3, cae_vto = $4, afip_response = $5,
           status = 'ISSUED', issued_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, data.cbteNro, data.cae, data.caeVto, JSON.stringify(data.afipResponse)],
    );
    if (!rows[0]) throw new Error(`Invoice ${id} no encontrada al marcar ISSUED`);
    return rowToEntity(rows[0]);
  }

  async markFailed(id: string, data: MarkFailedInput): Promise<Invoice> {
    const { rows } = await this.db.query<InvoiceRow>(
      `UPDATE invoices
       SET status = $2, error_message = $3, afip_response = COALESCE($4, afip_response), afip_contacted = $5
       WHERE id = $1
       RETURNING *`,
      [
        id, data.status, data.errorMessage,
        data.afipResponse != null ? JSON.stringify(data.afipResponse) : null,
        data.afipContacted,
      ],
    );
    if (!rows[0]) throw new Error(`Invoice ${id} no encontrada al marcar ${data.status}`);
    return rowToEntity(rows[0]);
  }

  async getStatus(id: string): Promise<InvoiceStatus | null> {
    const { rows } = await this.db.query<{ status: InvoiceStatus }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [id],
    );
    return rows[0]?.status ?? null;
  }
}
