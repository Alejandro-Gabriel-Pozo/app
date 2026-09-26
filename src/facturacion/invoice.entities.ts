/**
 * @file invoice.entities.ts
 * @description Comprobante fiscal AFIP — DOCUMENTO (criterios-datos.md
 * Parte 1): inmutable una vez emitido, numeración correlativa por
 * talonario (negocio + punto de venta + tipo de comprobante).
 */

import type { PaymentMethod } from '../clientes-finanzas/financial-transaction.repository.js';

export type InvoiceStatus = 'PENDING' | 'ISSUED' | 'REJECTED' | 'FAILED_UNCERTAIN';
export type AfipEnvironment = 'homologacion' | 'produccion';

/**
 * Complemento exacto de `REJECTED` sobre los 4 valores de `InvoiceStatus`
 * -- "¿este comprobante consume el recurso que protege, incluso sin estar
 * `ISSUED` todavía?". `REJECTED` queda afuera SIEMPRE con este predicado:
 * AFIP confirmó que el comprobante no existe, no consume nada (mismo
 * criterio en los 7 sitios que lo usan hoy -- 6 en `sql.invoice.repository.ts`
 * más `invoice.service.ts`, conteo real, no estimado -- ver la corrección de
 * ronda 3 más abajo, que sumó uno de esos 6). Extraída 11/09/2026
 * (`INVOICE-CHARGES-GUARD-INDIVIDUAL-01`, gate `architecture-governor`)
 * de un literal duplicado en `getInFlightCreditNoteTotalForUpdate()`/
 * `ForPair` (`sql.invoice.repository.ts`) -- usada también por el guard
 * cruzado individual-vs-consolidada de `InvoiceService.requestInvoice()`.
 *
 * **NO es el mismo predicado que `retryExisting()`** (`invoice.service.ts`),
 * que es más fino (`ISSUED` + `FAILED_UNCERTAIN` con `afipContacted`) porque
 * ahí se puede reintentar la MISMA fila. Esta constante es para los casos
 * donde NO se puede reintentar el otro documento -- otro comprobante, con
 * su propia idempotencia -- así que hay que ser conservador con cualquier
 * estado no resuelto (`PENDING`/`FAILED_UNCERTAIN`), no solo con `ISSUED`.
 * No unificar con el predicado de `retryExisting()` sin re-derivar por qué.
 *
 * Corrección (`WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001`,
 * 23/09/2026, gate `architecture-governor`, ronda 2): desde ese bloque,
 * `retryExisting()` SÍ usa esta constante -- pero nunca sobre la fila que
 * se está reintentando (esa sigue con el predicado más fino de arriba,
 * `ISSUED`/`FAILED_UNCERTAIN` con `afipContacted`), sino sobre los OTROS
 * comprobantes vinculados al mismo cargo (`getOtherLiveInvoiceLinksForCharges()`,
 * `invoice.repository.ts`) -- el guard nuevo que cierra la cuarta dirección
 * del agujero de doble comprobante (dos CAE reales sobre el mismo cargo,
 * uno por la vía individual y otro por la consolidada). Los dos usos
 * conviven sin contradecirse: éste sigue siendo el predicado para "otro
 * documento, con su propia idempotencia".
 *
 * `FAILED_UNCERTAIN` en esta lista es una decisión LOCAL de este repo, sin
 * análogo en ERPNext/Odoo -- ninguno de los dos modela "no se sabe si el
 * fisco lo emitió" (esta integración con AFIP es la única fuente de esa
 * ambigüedad). El resto del predicado (excluir el estado "cancelado/
 * rechazado") sí replica el estándar verificado contra código real:
 * `sale_order_line._prepare_qty_invoiced()` (Odoo, excluye
 * `move_id.state == 'cancel'`) y `BillingValidationService` (ERPNext,
 * excluye `docstatus == 2`).
 */
export const INVOICE_STATUSES_CONSUMING_CHARGE: readonly InvoiceStatus[] = ['ISSUED', 'PENDING', 'FAILED_UNCERTAIN'];

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
  /**
   * Bloque 2a (23/09/2026, `docs/diseno-invoice-retry-reverse-window-guard-
   * 2026-09-23.md` §3.6) — marcador único de "en vuelo": poblado con
   * `NOW()` mientras `status === 'PENDING'`, `NULL` en cualquier otro
   * status. Lo escriben el camino fresco (`createWithClient()`) y, desde el
   * Bloque 2c (§3.2/§3.16, ya implementado), `takeRetryClaimWithClient()` —
   * la toma exclusiva de `retryExisting()` vuelve a poner `PENDING`. Lo
   * limpian `markIssuedWithClient()`, `markFailedWithClient()` y, desde el
   * Bloque 4 (§3.3), `expirePendingWithClient()` (vencimiento del worker).
   * `updateIssuedFromReconciliation()` (usado por
   * `markIssuedFromManualResolutionWithClient()`/
   * `markIssuedFromAfipReconciliationWithClient()`) también lo limpia, pero
   * es redundante en la práctica: parte de `FAILED_UNCERTAIN`, donde ya vale
   * `NULL`. Lista de escritores/limpiadores no necesariamente exhaustiva.
   * El CHECK `chk_invoices_pending_since` está en `schema.sql` desde el
   * Bloque 2b (`2c9b423`) — la consistencia
   * `(status = 'PENDING') = (pending_since IS NOT NULL)` ya no depende solo
   * de que estos escritores se mantengan disciplinados.
   */
  pendingSince: Date | null;
  /**
   * Bloque 5 del ADR común cancelar-con-NC (schema v58, §6.5 bis, pregunta
   * de negocio 1, opción (b)) — `NULL` hasta que un operador resuelve una
   * `credit_note_request` asociada con `outcome: 'NO_EMITIDA'`
   * (`POST /api/credit-note-requests/:id/resolve`). Desde ahí, poblado,
   * `retryExisting()` (invoice.service.ts) deja de negarse a reintentar esta
   * factura pese a `status === 'FAILED_UNCERTAIN' && afipContacted`.
   */
  uncertainClearedAt: Date | null;
  /** `identity_id` (JWT sub) de quien limpió el estado ambiguo — ver `uncertainClearedAt`. Sin FK a `users`, mismo criterio que `credit_note_request.resolvedBy`. */
  uncertainClearedBy: string | null;
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
 * **Bloque 6 del ADR `ISSUE-BEFORE-REVERSE-WINDOW-001` (23/09/2026, §3.10,
 * gate `architecture-governor`, ronda 18) -- dos motivos más, mismo
 * contrato de salida, sin endpoint separado:**
 * - `motivo: 'AR_REVERTED_INVOICE_LIVE'` -- el `CHARGE` de una
 *   `accounts_receivable` ya `REVERTIDO` (`reverseTransfer()`,
 *   `accounts-receivable.service.ts`) sigue teniendo una factura viva sin
 *   reconciliar (`INVOICE_STATUSES_CONSUMING_CHARGE`) sobre el mismo
 *   `financial_transaction_id` -- la ventana TOCTOU que el propio docblock
 *   de `reverseTransfer()` declara como residuo (su guard 8-bis no toma
 *   lock cruzado AR↔factura). `entityType: 'ACCOUNTS_RECEIVABLE'`
 *   (decisión del dueño, `AskUserQuestion`, 23/09/2026 -- ni `'ORDER'` ni
 *   `'RESERVATION'` describen bien a una AR revertida: la reserva de la
 *   que nace el `CHARGE` puede seguir perfectamente viva), `entityId: ar.id`,
 *   `entityStatus: 'REVERTIDO'`. `sinceAt = ar.reversed_at`. No deduplica
 *   contra B1/B2 sobre la misma reserva -- mismo criterio que B1 vs. B2
 *   entre sí (arriba): la AR y la reserva son hechos distintos.
 * - `motivo: 'MANUAL_RESOLUTION_STATE_MISMATCH'` -- una `credit_note_request`
 *   sigue `EN_REVISION_MANUAL` pero su propia factura (`cnr.invoice_id`,
 *   la NC en revisión, no `reversed_invoice_id`) ya alcanzó un desenlace
 *   real que la solicitud todavía no refleja (`ISSUED`, o
 *   `FAILED_UNCERTAIN` con `uncertain_cleared_at` poblado). Sin acción
 *   nueva -- `POST /api/credit-note-requests/:id/resolve` ya maneja los
 *   dos casos de forma idempotente (§3.10); esta fila es pura visibilidad.
 *   `entityType`/`entityId` resuelven por `chk_credit_note_request_order_or_reservation`
 *   (CHECK: exactamente uno de `order_id`/`reservation_id` no-nulo).
 *   `creditNoteRequestId` (único campo nuevo del tipo, ver abajo) puebla
 *   `cnr.id`.
 *
 * Los dos motivos nuevos son consultas SQL directas en
 * `listUnreconciledLiveInvoices()`, sin pasar por
 * `classifyOrderLiveInvoice()`/`classifyReservationLiveInvoice()` -- esos
 * dos resuelven la doctrina de compensación de órdenes/reservas, que no
 * aplica acá (el predicado de cada uno es autocontenido, sin estado de
 * orden/reserva de por medio para `AR_REVERTED_INVOICE_LIVE`, y sin
 * doctrina de compensación para `MANUAL_RESOLUTION_STATE_MISMATCH`).
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
  entityType: 'ORDER' | 'RESERVATION' | 'ACCOUNTS_RECEIVABLE';
  entityId: string;
  entityStatus: string;
  invoiceId: string;
  ptoVta: number;
  cbteNro: number | null;
  impTotal: number;
  issuedAt: Date | null;
  motivo: 'TERMINAL_CON_COMPROBANTE_VIVO' | 'REVERSION_ABIERTA' | 'AR_REVERTED_INVOICE_LIVE' | 'MANUAL_RESOLUTION_STATE_MISMATCH';
  sinceAt: Date;
  revertingTransactionId: string | null;
  revertingType: 'REFUND' | 'ADJUSTMENT' | null;
  revertingStatus: string | null;
  ncInvoiceId: string | null;
  ncStatus: InvoiceStatus | null;
  ncAfipContacted: boolean | null;
  /**
   * Bloque 6 (§3.10) -- id de la `credit_note_request` en revisión, poblado
   * SOLO para `motivo === 'MANUAL_RESOLUTION_STATE_MISMATCH'` (es el id que
   * el frontend necesita para accionar `POST /credit-note-requests/:id/resolve`).
   * `null` para los otros tres motivos -- mismo criterio que los campos de
   * reversión, exclusivos de `REVERSION_ABIERTA`.
   */
  creditNoteRequestId: string | null;
}
