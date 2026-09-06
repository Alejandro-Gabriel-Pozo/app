import type { SqlClient } from '../repositories/sql.client.js';
import type { Invoice, CreateInvoiceInput, InvoiceStatus, AfipEnvironment, InvoiceItem, CreateInvoiceItemInput } from './invoice.entities.js';
import type { InvoiceRepository, MarkIssuedInput, MarkFailedInput, InvoiceLinkage } from './invoice.repository.js';
import type { PaymentMethod } from '../clientes-finanzas/financial-transaction.repository.js';
import { randomUUID } from 'node:crypto';

interface InvoiceRow {
  id: string;
  business_id: string;
  financial_transaction_id: string | null;
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

  async getOutstandingForUpdate(client: SqlClient, invoiceId: string): Promise<number> {
    // O2-F2 (03/09/2026) -- DOS sentencias separadas, a propósito. Antes
    // era una sola `SELECT ... FOR UPDATE OF i` con el cómputo de saldo
    // (subconsultas correlacionadas contra financial_transactions) en el
    // mismo SELECT que toma el lock. Bajo Postgres real, si esta sentencia
    // tiene que ESPERAR el lock (otra transacción lo tenía tomado) y esa
    // otra transacción no modificó la fila de `invoices` en sí (solo
    // insertó en `financial_transactions`, una tabla DISTINTA -- exactamente
    // el caso de `markCollected()`/`recordPayment()`), Postgres NO
    // re-evalúa las subconsultas correlacionadas con una foto nueva al
    // desbloquear: quedan con la foto de ANTES de esperar, así que "ganan"
    // el lock pero leen un saldo viejo -- sobre-aplicación real bajo
    // concurrencia genuina, no solo hipotética.
    //
    // Reproducido y confirmado contra Postgres real (Neon) el 03/09/2026:
    // dentro de la MISMA transacción, inmediatamente después de esta
    // sentencia, un SELECT plano SÍ ve la fila recién commiteada por la
    // otra transacción -- la sentencia FOR UPDATE bloqueada es la única que
    // queda con la foto vieja. Por eso el fix separa "tomar el lock" (sin
    // subconsultas, nada que pueda quedar stale) de "leer el saldo"
    // (sentencia nueva, ejecuta DESPUÉS de que el lock ya se obtuvo, con
    // una foto tomada en ese momento -- ya no puede quedar vieja).
    //
    // Afecta también al camino de O2-F1 (recordPayment): esa suite pasaba
    // porque su timing no disparaba la espera real por el lock, no porque
    // el mecanismo fuera correcto bajo cualquier orden de llegada -- ver
    // docs/diseno-o2-f2-cierre-completo-2026-09-03.md.
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);

    // Sin el JOIN a `financial_transactions ft ON ft.id = i.financial_transaction_id`
    // que usa `getOutstandingByCustomerId`: acá se busca por `i.id`
    // directo, y ese JOIN excluiría toda factura CONSOLIDADA
    // (`financial_transaction_id IS NULL` a propósito, ver schema.sql:3139) --
    // exactamente el tipo de factura contra la que este método también
    // tiene que poder calcular saldo.
    // ADR común cancelar-con-NC (06/09/2026, N1.b) -- la contribución de una
    // transacción revertidora al "ya revertido" de la factura se toma POR TIPO,
    // no como `SUM(r.amount)` a secas: un `REFUND` lleva `amount` positivo (ese
    // es el monto revertido); el `ADJUSTMENT` compensatorio de una Nota de
    // Crédito lleva `amount` NEGATIVO (convención de `handleReservationPriceAdjusted`,
    // outbox.handlers.ts:169-176), así que su monto revertido es `-r.amount`.
    // Sin este CASE, un `ADJUSTMENT` negativo haría `imp_total - (-monto) =
    // imp_total + monto` y la factura nunca se vería compensada. `ELSE 0`
    // explícito (no `-r.amount` genérico): el schema no impide un tercer
    // `type` con `reversed_invoice_id` (no hay CHECK, schema.sql:2989-2990) --
    // ver la cerca de convención en los tests. Verificado 06/09/2026: 0 filas
    // con `reversed_invoice_id IS NOT NULL` en las dos tenant, así que esto es
    // no-op sobre datos existentes.
    const { rows } = await client.query<{ outstanding: string }>(
      `SELECT
         (i.imp_total
           - COALESCE((SELECT SUM(p.amount) FROM financial_transactions p
                       WHERE p.settled_invoice_id = i.id AND p.status = 'SETTLED'), 0)
           - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                       WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                       ELSE 0 END)
                       FROM financial_transactions r
                       WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0)
         ) AS outstanding
       FROM invoices i
       WHERE i.id = $1`,
      [invoiceId],
    );
    if (rows.length === 0) {
      throw new Error(`getOutstandingForUpdate: factura "${invoiceId}" no existe -- invariante roto, se validó su existencia antes de entrar a la transacción`);
    }
    return parseFloat(rows[0]!.outstanding);
  }

  async getRefundableForUpdate(client: SqlClient, invoiceId: string): Promise<number> {
    // BRECHA-REFUND-01 Fase 3 -- mismo patrón de dos sentencias que
    // getOutstandingForUpdate (§7.1): lock puro primero, sin subconsultas;
    // cómputo después, sentencia nueva, foto fresca.
    await client.query(`SELECT 1 FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);

    // "ya reembolsado" por TIPO -- ver el comentario de N1.b en
    // getOutstandingForUpdate arriba (REFUND: +amount; ADJUSTMENT de NC:
    // -amount; ELSE 0).
    const { rows } = await client.query<{ refundable: string }>(
      `SELECT LEAST(
         -- (A) pagado − ya reembolsado
         COALESCE((SELECT SUM(p.amount) FROM financial_transactions p
                    WHERE p.settled_invoice_id = i.id AND p.status = 'SETTLED'), 0)
           - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                       WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                       ELSE 0 END)
                       FROM financial_transactions r
                       WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0),
         -- (B) valor del comprobante − ya reembolsado
         i.imp_total
           - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                       WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                       ELSE 0 END)
                       FROM financial_transactions r
                       WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0)
       ) AS refundable
       FROM invoices i
       WHERE i.id = $1`,
      [invoiceId],
    );
    if (rows.length === 0) {
      throw new Error(`getRefundableForUpdate: factura "${invoiceId}" no existe -- invariante roto, se validó su existencia antes de entrar a la transacción`);
    }
    return parseFloat(rows[0]!.refundable);
  }

  async getOutstandingByCustomerId(customerId: string): Promise<Array<Invoice & { outstanding: number }>> {
    // O2-F2 (03/09/2026, F2.1) -- el JOIN original exigía
    // `ft.id = i.financial_transaction_id`, lo que excluía TODA factura
    // consolidada (`i.financial_transaction_id IS NULL` a propósito, ver
    // schema.sql:3139) del listado -- una factura consolidada cobrada quedaba
    // invisible para este modal de conciliación aunque tuviera saldo real.
    // Ahora: consolidada (financial_transaction_id IS NULL) siempre pasa --
    // nunca se genera una consolidada para un REFUND, así que no hace falta
    // verificar `type` en ese caso -- o individual con `ft.type = 'CHARGE'`,
    // mismo filtro que antes.
    const { rows } = await this.db.query<InvoiceRow & { outstanding: string }>(
      `SELECT * FROM (
         SELECT i.*,
           (i.imp_total
             - COALESCE((SELECT SUM(p.amount) FROM financial_transactions p
                         WHERE p.settled_invoice_id = i.id AND p.status = 'SETTLED'), 0)
             -- "ya revertido" por TIPO -- ver N1.b en getOutstandingForUpdate.
             - COALESCE((SELECT SUM(CASE WHEN r.type = 'REFUND' THEN r.amount
                                         WHEN r.type = 'ADJUSTMENT' THEN -r.amount
                                         ELSE 0 END)
                         FROM financial_transactions r
                         WHERE r.reversed_invoice_id = i.id AND r.status = 'SETTLED'), 0)
           ) AS outstanding
         FROM invoices i
         LEFT JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
         WHERE i.customer_id = $1 AND i.status = 'ISSUED'
           AND (i.financial_transaction_id IS NULL OR ft.type = 'CHARGE')
       ) sub
       WHERE outstanding > 0
       ORDER BY issued_at ASC NULLS LAST`,
      [customerId],
    );
    return rows.map((row) => ({ ...rowToEntity(row), outstanding: parseFloat(row.outstanding) }));
  }

  async getByCustomerId(customerId: string): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT * FROM invoices WHERE customer_id = $1 ORDER BY created_at DESC`,
      [customerId],
    );
    return rows.map(rowToEntity);
  }

  async resolveInvoiceLinkage(financialTransactionId: string): Promise<InvoiceLinkage> {
    // AR-FACT-NO-ISSUED-01 (05/09/2026) -- reemplaza a
    // getInvoiceIdByFinancialTransactionId(). H2 (architecture-governor,
    // 03/09/2026) sigue aplicando en espíritu (la rama consolidada
    // necesita el mismo tratamiento que la individual), pero SIN filtro de
    // status -- acá se quiere saber el estado real, no solo si es ISSUED.
    // UNION ALL de los dos caminos (individual: invoices.financial_transaction_id
    // directo; consolidado: invoice_charges), sin deduplicar por diseño --
    // el ORDER BY prioriza ISSUED si por algún motivo hubiera más de una
    // fila (no debería, ver el docblock de la interfaz).
    const { rows } = await this.db.query<{ id: string; status: InvoiceStatus; afip_contacted: boolean }>(
      `SELECT id, status, afip_contacted FROM (
         SELECT id, status, afip_contacted FROM invoices WHERE financial_transaction_id = $1
         UNION ALL
         SELECT i.id, i.status, i.afip_contacted FROM invoice_charges ic
         JOIN invoices i ON i.id = ic.invoice_id
         WHERE ic.financial_transaction_id = $1
       ) linked
       ORDER BY (status = 'ISSUED') DESC, id
       LIMIT 1`,
      [financialTransactionId],
    );
    const row = rows[0];
    if (!row) return { kind: 'NONE' };
    if (row.status === 'ISSUED') return { kind: 'ISSUED', invoiceId: row.id };
    return { kind: 'NOT_ISSUED', invoiceId: row.id, status: row.status, afipContacted: row.afip_contacted };
  }

  async getInvoicedFinancialTransactionIds(financialTransactionIds: string[]): Promise<Set<string>> {
    if (financialTransactionIds.length === 0) return new Set();
    const { rows } = await this.db.query<{ financial_transaction_id: string }>(
      `SELECT ic.financial_transaction_id
       FROM invoice_charges ic
       JOIN invoices i ON i.id = ic.invoice_id
       WHERE i.status = 'ISSUED' AND ic.financial_transaction_id = ANY($1::VARCHAR[])`,
      [financialTransactionIds],
    );
    return new Set(rows.map((r) => r.financial_transaction_id));
  }

  async getByReservationId(reservationId: string): Promise<Invoice[]> {
    const { rows } = await this.db.query<InvoiceRow>(
      `SELECT i.* FROM invoices i
       JOIN financial_transactions ft ON ft.id = i.financial_transaction_id
       WHERE ft.reservation_id = $1
       ORDER BY i.created_at ASC`,
      [reservationId],
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
    charges?: { financialTransactionId: string; amount: number }[],
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

    // C1-Fase C (23/08/2026) -- solo facturas consolidadas pasan `charges`.
    for (const charge of charges ?? []) {
      await client.query(
        `INSERT INTO invoice_charges (id, invoice_id, financial_transaction_id, amount)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), input.id, charge.financialTransactionId, charge.amount],
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
