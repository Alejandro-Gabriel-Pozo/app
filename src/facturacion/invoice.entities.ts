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
  /**
   * `null` = factura CONSOLIDADA (C1-Fase C, 23/08/2026) -- cubre N
   * financial_transactions distintos, ver `invoice_charges`. Facturas
   * per-reservation (la inmensa mayoría, incluidas TODAS las emitidas
   * antes de C1-Fase C) siguen con esto poblado, sin cambios.
   */
  financialTransactionId: string | null;
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
  /** `null` para una factura consolidada (C1-Fase C) -- ver `Invoice.financialTransactionId`. */
  financialTransactionId: string | null;
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

/**
 * "Factura viva no conciliada" (10/09/2026, gate `architecture-governor`,
 * bandeja derivada -- NO es `credit_note_request`, esa tabla sigue en
 * HOLD, ver `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`
 * §6.5). Fila de `InvoiceRepository.listUnreconciledLiveInvoices()`:
 * el complemento exacto de `classifyOrderLiveInvoice`/
 * `classifyReservationLiveInvoice` (`'NOT_RECONCILED'`), aplicado sobre
 * dos conjuntos de candidatos distintos, no uno solo:
 *
 * - `motivo: 'TERMINAL_CON_COMPROBANTE_VIVO'` (B1, renombrado 10/09/2026
 *   -- ver nota de gate abajo) -- la entidad ya llegó a un estado
 *   terminal (orden `CANCELLED`, reserva `CANCELLED`/`EXPIRED`) con un
 *   comprobante fiscal vivo que nadie compensó. `sinceAt` =
 *   `invoices.issued_at`. El nombre describe SOLO el predicado B1
 *   (entidad terminal + Factura B viva) -- no afirma ausencia de
 *   reversión: cuando el mismo comprobante también matchea B2 (caso real,
 *   ver `unreconciled-live-invoices.integration.test.ts`, "CANCELLED +
 *   REFUND SETTLED sin NC"), la bandeja emite DOS filas sobre la misma
 *   factura, una con cada `motivo` -- son dos hechos legítimos y
 *   distintos, no un duplicado a deduplicar.
 * - `motivo: 'REVERSION_ABIERTA'` (B2) -- hay una fila `REFUND`/`ADJUSTMENT`
 *   con `reversed_invoice_id` que todavía no cerró (NC sin emitir, o
 *   ledger sin settlear) -- la entidad puede seguir viva, no
 *   necesariamente terminal. `sinceAt` = `created_at` de esa fila
 *   revertidora. Cubre el peor caso del escape: NC `ISSUED`,
 *   `ADJUSTMENT` `PENDING`, entidad que nunca llegó a cancelarse porque
 *   tx2 abortó (`cancel-order-with-credit-note.service.ts` y su gemelo
 *   de reservas documentan este estado explícitamente).
 *
 * Los campos de reversión (`revertingTransactionId`/`revertingType`/
 * `revertingStatus`/`ncInvoiceId`/`ncStatus`/`ncAfipContacted`) solo se
 * completan para `motivo === 'REVERSION_ABIERTA'` -- un candidato B1
 * puro no tiene, todavía, ninguna fila revertidora que describir.
 *
 * **Falso positivo RESUELTO (11/09/2026, 3.3-d residual 1,
 * docs/diseno-33d-residuales-2026-09-11.md)** para el camino RESOLVED de
 * `classifyReservationLiveInvoice`: una cancelación consolidada-parcial ya
 * no da `NOT_RECONCILED` en el camino feliz -- el clasificador pregunta
 * por la PORCIÓN de la reserva, no por la factura entera. **Sigue
 * aplicando, sin cambios, al camino BLOCKED** (facturas Nivel A sin
 * `invoice_items` -- fail-back declarado a F4-por-factura-entera, mismo
 * comportamiento de siempre, por diseño, no por descuido). El residual
 * simétrico del lado ÓRDENES (`classifyOrderLiveInvoice` sigue con F4 por
 * factura entera siempre) queda registrado aparte,
 * `ORDER-CONSOLIDATED-PARTIAL-01` en `docs/pendientes-2026-09-10.md`.
 *
 * **Falso negativo conocido, aceptado, no oculto (C1, gate 10/09/2026)**:
 * el candidato-enumeration de B2 (`sql.invoice.repository.ts`) filtra
 * `reservation_id IS NOT NULL` / `order_id IS NOT NULL` por rama. Una
 * fila `financial_transactions` revertidora con `reversed_invoice_id`
 * seteado pero AMBOS ids en NULL no entraría por ninguna rama y se
 * descartaría en silencio -- justo el silencio que esta bandeja existe
 * para eliminar. Hoy es inalcanzable: todo camino que crea una reversión
 * (`cancellation-refund.service.ts`, los dos escapes con NC) siempre
 * setea uno de los dos ids, y no hay CHECK de schema que lo impida
 * estructuralmente. Mismo criterio de declaración que
 * `classifyOrderLiveInvoice`/`classifyReservationLiveInvoice`.
 */
export interface UnreconciledLiveInvoice {
  entityType: 'ORDER' | 'RESERVATION';
  entityId: string;
  entityStatus: string;
  invoiceId: string;
  ptoVta: number;
  cbteNro: number | null;
  impTotal: number;
  issuedAt: Date | null;
  motivo: 'TERMINAL_CON_COMPROBANTE_VIVO' | 'REVERSION_ABIERTA';
  sinceAt: Date;
  revertingTransactionId: string | null;
  revertingType: 'REFUND' | 'ADJUSTMENT' | null;
  revertingStatus: string | null;
  ncInvoiceId: string | null;
  ncStatus: InvoiceStatus | null;
  ncAfipContacted: boolean | null;
}
