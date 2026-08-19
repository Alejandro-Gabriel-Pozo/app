/**
 * @file invoice.entities.ts
 * @description Comprobante fiscal AFIP — DOCUMENTO (criterios-datos.md
 * Parte 1): inmutable una vez emitido, numeración correlativa por
 * talonario (negocio + punto de venta + tipo de comprobante).
 */

export type InvoiceStatus = 'PENDING' | 'ISSUED' | 'REJECTED' | 'FAILED_UNCERTAIN';
export type AfipEnvironment = 'homologacion' | 'produccion';

export interface Invoice {
  id: string;
  businessId: string;
  financialTransactionId: string;
  customerId: string;
  idempotencyKey: string;
  environment: AfipEnvironment;
  ptoVta: number;
  cbteTipo: number;
  /** null hasta que AFIP confirma el CAE — nunca se reserva localmente antes. */
  cbteNro: number | null;
  concepto: number;
  docTipo: number;
  docNro: string;
  condicionIvaReceptorId: number;
  moneda: string;
  impNeto: number;
  impIva: number;
  impTotal: number;
  cae: string | null;
  caeVto: string | null;
  status: InvoiceStatus;
  afipRequest: unknown;
  afipResponse: unknown;
  errorMessage: string | null;
  createdAt: Date;
  issuedAt: Date | null;
}

export interface CreateInvoiceInput {
  id: string;
  businessId: string;
  financialTransactionId: string;
  customerId: string;
  idempotencyKey: string;
  environment: AfipEnvironment;
  ptoVta: number;
  cbteTipo: number;
  concepto: number;
  docTipo: number;
  docNro: string;
  condicionIvaReceptorId: number;
  moneda: string;
  impNeto: number;
  impIva: number;
  impTotal: number;
}
