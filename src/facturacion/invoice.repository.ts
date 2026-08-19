import type { Invoice, CreateInvoiceInput, InvoiceStatus } from './invoice.entities.js';

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
}

export interface InvoiceRepository {
  getById(id: string): Promise<Invoice | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<Invoice | null>;
  getByFinancialTransactionId(financialTransactionId: string): Promise<Invoice[]>;
  /** PENDING inicial — el CAE todavía no se pidió. `afipRequest` se persiste ANTES de llamar a AFIP (auditable incluso si la llamada nunca vuelve). */
  create(input: CreateInvoiceInput, afipRequest: unknown): Promise<Invoice>;
  markIssued(id: string, data: MarkIssuedInput): Promise<Invoice>;
  markFailed(id: string, data: MarkFailedInput): Promise<Invoice>;
  /** Solo para reconciliar un FAILED_UNCERTAIN ya resuelto a mano (A8.6) — no un "editar" genérico. */
  getStatus(id: string): Promise<InvoiceStatus | null>;
}
