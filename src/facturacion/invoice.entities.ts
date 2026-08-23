/**
 * @file invoice.entities.ts
 * @description Comprobante fiscal AFIP — DOCUMENTO (criterios-datos.md
 * Parte 1): inmutable una vez emitido, numeración correlativa por
 * talonario (negocio + punto de venta + tipo de comprobante).
 */

import type { PaymentMethod } from '../clientes-finanzas/financial-transaction.repository.js';

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
  /** Si createNextVoucher() (WSFEv1) llegó a invocarse antes de una falla —
   * ver docblock de `invoices` en schema.sql. Gobierna si InvoiceService
   * puede reintentar un FAILED_UNCERTAIN solo, o si necesita revisión
   * manual primero (A8.6). */
  afipContacted: boolean;
  /** CUIT de autenticación AFIP congelado al crear (schema v26) — ver docblock en schema.sql. `null` = comprobante emitido antes de este campo. */
  emisorCuit: string | null;
  /**
   * Congelados desde `FinancialTransaction.paymentMethod`/`cardInstallments`
   * al crear el comprobante (schema v28, R9 -- criterios-datos.md: un
   * documento congela lo que necesita de la transacción de origen, nunca
   * la re-consulta después). `null` = la transacción de origen no tenía
   * forma de pago cargada, o comprobante emitido antes de este campo.
   */
  paymentMethod: PaymentMethod | null;
  cardInstallments: number | null;
  afipRequest: unknown;
  afipResponse: unknown;
  errorMessage: string | null;
  createdAt: Date;
  issuedAt: Date | null;
}

/**
 * D8-Nivel B (23/08/2026, docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md)
 * — línea real de un comprobante, congelada al emitir (R9/R12). Exactamente
 * uno de `orderItemId`/`reservationId` (trazabilidad del origen, mismo
 * criterio que `order_items.item_type`). Facturas emitidas antes de este
 * cambio (Nivel A) no tienen ninguna fila acá -- ver
 * `InvoicePdfService.generate()` para el fallback.
 */
export interface InvoiceItem {
  id: string;
  invoiceId: string;
  orderItemId: string | null;
  reservationId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  ivaRate: number;
  unit: string | null;
  arcaUnitCode: number | null;
  createdAt: Date;
}

export type CreateInvoiceItemInput = Omit<InvoiceItem, 'id' | 'invoiceId' | 'createdAt'>;

export interface CreateInvoiceInput {
  id: string;
  businessId: string;
  financialTransactionId: string;
  customerId: string;
  idempotencyKey: string;
  environment: AfipEnvironment;
  ptoVta: number;
  cbteTipo: number;
  emisorCuit: string;
  concepto: number;
  docTipo: number;
  docNro: string;
  condicionIvaReceptorId: number;
  moneda: string;
  impNeto: number;
  impIva: number;
  impTotal: number;
  paymentMethod?: PaymentMethod | null;
  cardInstallments?: number | null;
}
