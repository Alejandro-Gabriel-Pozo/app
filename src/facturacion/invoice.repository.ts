import type { Invoice, CreateInvoiceInput, InvoiceStatus, InvoiceItem, CreateInvoiceItemInput } from './invoice.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';

export interface MarkIssuedInput {
  cbteNro: number;
  cae: string;
  caeVto: string;
  afipResponse: unknown;
}

export interface MarkFailedInput {
  status: 'REJECTED' | 'FAILED_UNCERTAIN';
  errorMessage: string;
  afipResponse?: unknown;
  /** Ver `Invoice.afipContacted` — obligatorio, cada call site de
   * `markFailed()` sabe si createNextVoucher() llegó a invocarse. */
  afipContacted: boolean;
}

export interface InvoiceRepository {
  getById(id: string): Promise<Invoice | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<Invoice | null>;
  getByFinancialTransactionId(financialTransactionId: string): Promise<Invoice[]>;
  /**
   * C2 (23/08/2026, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md)
   * — todas las facturas (cualquier status) de una reserva, resolviendo vía
   * `financial_transactions.reservation_id` (JOIN, no requiere columna
   * nueva en `invoices`). `CancellationRefundService.confirmRefund()` las
   * filtra a `ISSUED` y las ordena por `issuedAt` para el reparto LIFO.
   */
  getByReservationId(reservationId: string): Promise<Invoice[]>;
  /** PENDING inicial — el CAE todavía no se pidió. `afipRequest` se persiste ANTES de llamar a AFIP (auditable incluso si la llamada nunca vuelve). */
  create(input: CreateInvoiceInput, afipRequest: unknown, items: CreateInvoiceItemInput[]): Promise<Invoice>;
  /**
   * D8-Nivel B (23/08/2026) — versión transaccional de `create()`: inserta
   * el comprobante Y sus líneas dentro de la misma transacción
   * (`InvoiceService.requestInvoice()` la envuelve en
   * `transactionManager.run()`) — nunca una factura creada sin ninguna
   * línea por una falla a mitad de camino.
   */
  createWithClient(
    client: SqlClient,
    input: CreateInvoiceInput,
    afipRequest: unknown,
    items: CreateInvoiceItemInput[],
  ): Promise<Invoice>;
  markIssued(id: string, data: MarkIssuedInput): Promise<Invoice>;
  markFailed(id: string, data: MarkFailedInput): Promise<Invoice>;
  /** Solo para reconciliar un FAILED_UNCERTAIN ya resuelto a mano (A8.6) — no un "editar" genérico. */
  getStatus(id: string): Promise<InvoiceStatus | null>;
  /** D8-Nivel B — líneas reales del comprobante (vacío = factura Nivel A, ver InvoicePdfService). */
  getItemsByInvoiceId(invoiceId: string): Promise<InvoiceItem[]>;
}
