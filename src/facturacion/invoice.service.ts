/**
 * @file invoice.service.ts
 * @description Orquesta la emisión de un comprobante AFIP a partir de una
 * `FinancialTransaction` ya existente (A3.9 — contrapartida obligatoria,
 * nunca un monto inventado). Fase 2, solo Factura B — ver
 * `afip-catalog.constants.ts` para qué está hardcodeado a propósito
 * (protocolo AFIP) y qué no (política del negocio).
 *
 * ## A8.6 — nunca reintentar una mutación ambigua sola
 * Si la llamada a `createNextInvoice` explota por timeout/red, NO se sabe
 * si AFIP ya asignó el número y el CAE o no — reintentar a ciegas puede
 * saltear un número (mal) o, peor, si el reintento SÍ llega, pedir un CAE
 * duplicado. Antes de decidir, se compara `getLastVoucher()` de ANTES y
 * DESPUÉS del intento: si avanzó, AFIP lo procesó pese al error de red y
 * se recupera el CAE real con `getVoucherInfo()`; si no se puede
 * confirmar, la invoice queda `FAILED_UNCERTAIN` — un humano decide,
 * nunca un reintento automático.
 */

import { randomUUID, createHash } from 'node:crypto';
import type { InvoiceRepository, MarkIssuedInput, ReconciliationSnapshot } from './invoice.repository.js';
import type { Invoice, AfipEnvironment, CreateInvoiceItemInput } from './invoice.entities.js';
import { INVOICE_STATUSES_CONSUMING_CHARGE } from './invoice.entities.js';
import type { AfipCredentials, AfipCredentialsRepository } from './afip-credentials.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { AccountsReceivableRepository, AccountReceivable } from '../clientes-finanzas/accounts-receivable.repository.js';
import { canonicalAccountsReceivableLockOrder } from '../clientes-finanzas/payment-application.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { IOrderRepository } from '../pos-menu/order.repository.js';
import type { OrderItem } from '../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../pos-menu/product.repository.js';
import type { ServiceItemRepository } from '../pos-menu/service-item.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import { ReservationStatus } from '../types/enums.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { buildDefaultAfipBillingPort } from './arca-sdk-billing.adapter.js';
import type { AfipBillingPort, VoucherInfoResult } from './afip-billing.port.js';
import {
  CBTE_TIPO_FACTURA_B,
  CBTE_TIPO_NOTA_CREDITO_B,
  CONCEPTO_SERVICIOS,
  DOC_TIPO_CONSUMIDOR_FINAL,
  CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL,
  resolveIvaAlicuotaId,
} from './afip-catalog.constants.js';
import {
  FinancialTransactionNotFoundError,
  AfipNotConfiguredError,
  AfipRequestUncertainError,
  AfipRequestRejectedError,
  InvoiceNotReversibleError,
  NothingToInvoiceError,
  AccountsReceivableAlreadyInvoicedError,
  InvoiceAlreadyLinkedByOtherPathError,
  OrderCancelledCannotInvoiceError,
  ReservationCancelledCannotInvoiceError,
  AccountsReceivableReversedCannotInvoiceError,
  OrderInvoiceHasNoLinesError,
  CreditNoteCapExceededError,
  CreditNotePairCapExceededError,
  CreditNoteAttributionBlockedError,
  CreditNoteAttributionMismatchError,
  CreditNoteAmbiguousSubjectError,
  ServiceItemNotFoundError,
  CreditNoteRequestInvalidTransitionError,
  CreditNoteRequestNotFoundError,
  InvoiceManualResolutionPreconditionError,
  InvoiceUncertainClearPreconditionError,
  CreditNoteRequestNotInManualReviewError,
  InvoiceResolutionStateConflictError,
  InvoiceResolutionCaeMismatchError,
  InvoiceReconciliationUnexpectedStateError,
  InvoiceAlreadyIssuedError,
  InvoiceIssuedComprobanteMismatchError,
  InvoiceHasOpenCreditNoteRequestError,
  AfipReconciliationUnavailableError,
  AfipVoucherNotFoundError,
  AfipVoucherMismatchError,
  AfipReconciliationPreconditionError,
  InvoiceNotFoundError,
} from '../domain/errors.js';
import { resolveRefundableForPair, type FrozenInvoiceItemShare } from './refund-attribution.js';
import { round2 } from '../domain/money.js';
import { CREDIT_NOTE_COMPENSATION_TOLERANCE, creditNoteLinesFromInvoiceItems, type AccountsReceivableWarningEntry } from './cancel-with-credit-note.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { CreditNoteRequestRepository } from './credit-note-request.repository.js';
import type {
  CreditNoteRequest,
  CreditNoteRequestResolutionOutcome,
  CreditNoteRequestSubject,
  TransitionCreditNoteRequestInput,
} from './credit-note-request.entities.js';
import { logger } from '../logger.js';

const AUDIT_ENTITY = 'invoices';

export interface Buyer {
  docTipo: number;
  docNro: string;
  condicionIvaReceptorId: number;
}

const CONSUMIDOR_FINAL: Buyer = {
  docTipo: DOC_TIPO_CONSUMIDOR_FINAL,
  docNro: '0',
  condicionIvaReceptorId: CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL,
};

/**
 * §9.4 (13/09/2026, gate `architecture-governor`, decisión del dueño --
 * `AskUserQuestion`, "Exponer, no bloquear"): la dirección inversa de §9.1
 * -- la transferencia corre PRIMERO (crea el `PAYMENT` del huésped +
 * `CHARGE` de la empresa + AR), y DESPUÉS alguien pide facturar
 * individualmente ese mismo cargo del huésped. `requestInvoice()` no tiene
 * ningún guard que mire eso -- este campo aditivo (mismo patrón
 * `AccountReceivableMarkCollectedResult`/`accountsReceivableWarning` de
 * §9.2) expone si la estadía del cargo que se está facturando ya tiene un
 * traspaso vivo, para revisión manual de management. NO bloquea nada.
 */
export interface RequestInvoiceResult extends Invoice {
  accountsReceivableWarning?: AccountsReceivableWarningEntry[];
}

export interface RequestInvoiceInput {
  businessId: string;
  financialTransactionId: string;
  /** Sin esto, se factura a Consumidor Final (DocTipo 99, sin CUIT/DNI). */
  buyer?: Buyer;
  /** 1=Productos, 2=Servicios, 3=Ambos. Default Servicios (PMS/reservas). */
  concepto?: number;
  /** I9 (24/08/2026) — quién pidió este comprobante (identity id), para audit_log. Ver docblock de `recordInvoiceAudit()`. */
  changedBy: string;
}

/** C1-Fase C (23/08/2026) — "Facturar ahora": UN comprobante cubriendo TODO lo PENDIENTE_FACTURAR de una empresa en este momento. */
export interface RequestConsolidatedInvoiceInput {
  businessId: string;
  companyCustomerId: string;
  buyer?: Buyer;
  concepto?: number;
  /** I9 (24/08/2026) — ver `RequestInvoiceInput.changedBy`. */
  changedBy: string;
}

/**
 * Bloque 5 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis) — body de
 * `POST /api/credit-note-requests/:id/resolve` ya validado por Zod
 * (`CreditNoteRequestResolveSchema`, `api/schemas/facturacion.schemas.ts`):
 * `cbteNro`/`cae`/`caeVto` llegan garantizados no-undefined cuando
 * `outcome === 'EMITIDA'` (el `.superRefine()` del schema lo exige), pero
 * el tipo acá los deja opcionales porque TS no puede expresar esa
 * correlación sin duplicar el discriminated union del schema — la ruta es
 * la única caller de este método, y ya validó.
 */
export interface ResolveCreditNoteRequestManuallyInput {
  creditNoteRequestId: string;
  outcome: CreditNoteRequestResolutionOutcome;
  /** identity id (JWT sub) del operador que resolvió -- `req.user!.id`. */
  resolvedBy: string;
  note: string | null;
  cbteNro?: number;
  cae?: string;
  caeVto?: string;
}

/**
 * ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.14 (P-1) --
 * body de `POST /api/invoices/:id/reconcile-with-afip` ya validado por Zod
 * (`ReconcileInvoiceWithAfipSchema`). `cbteNro` es un ÍNDICE que el sistema
 * verifica contra AFIP, no el CAE en sí -- ver el docblock de
 * `InvoiceService.reconcileWithAfip()`.
 */
export interface ReconcileInvoiceWithAfipInput {
  invoiceId: string;
  cbteNro: number;
  /** identity id (JWT sub) del operador que disparó la reconciliación -- `req.user!.id`. */
  resolvedBy: string;
}

/** yyyymmdd, el formato que exige WSFEv1 (nunca ISO) — ver referencia-afip-wsfev1.md. Exportada: la reusa InvoicePdfService. */
export function toAfipDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** yyyy-mm-dd a partir de yyyymmdd (para persistir CAEFchVto como DATE). */
function afipDateToIso(afipDate: string): string {
  return `${afipDate.slice(0, 4)}-${afipDate.slice(4, 6)}-${afipDate.slice(6, 8)}`;
}

/** Firma de `buildDefaultAfipBillingPort` — inyectable para testear la orquestación sin pegarle al SDK real (afip-billing.port.ts, R14: un solo puerto, cualquier SDK detrás). */
export type AfipBillingPortFactory = (
  credentials: AfipCredentials,
  taxId: string,
  credentialsRepo: AfipCredentialsRepository,
) => AfipBillingPort;

export class InvoiceService {
  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly financialTransactionRepo: FinancialTransactionRepository,
    private readonly businessProfileRepo: BusinessProfileRepository,
    private readonly afipCredentialsRepo: AfipCredentialsRepository,
    /**
     * D8 (22/08/2026) — resuelve `order_items.iva_rate` para agrupar el
     * comprobante por alícuota cuando la orden mezcla productos con
     * distinta tasa. Solo se usa `getById()` (trae `Order.items` inline).
     * D8-Nivel B (23/08/2026) — también arma las líneas reales del
     * comprobante (`invoice_items`), ver `resolveInvoiceItems()`.
     */
    /**
     * ORDER-10 (05/09/2026, architecture-governor) -- `getByIdForUpdate`
     * cierra la ventana TOCTOU entre `cancelOrder()` y `requestInvoice()`:
     * ver el guard al principio de la transacción de `requestInvoice()`.
     */
    private readonly orderRepo: Pick<IOrderRepository, 'getById' | 'getByIdForUpdate'>,
    /** D8-Nivel B — nombre/unidad/código ARCA de cada línea PRODUCT. */
    private readonly productRepo: Pick<IProductRepository, 'getById'>,
    private readonly productVariantRepo: Pick<IProductVariantRepository, 'getById'>,
    /**
     * D8-Nivel B — nombre del recurso/servicio para la línea de una reserva.
     * RESERVA-10 (05/09/2026, architecture-governor) -- `getByIdWithLock`
     * (opcional en la interfaz, mismo criterio que `getByIdForUpdate` de
     * `IOrderRepository`) cierra la ventana TOCTOU entre
     * `cancelReservation()` y `requestInvoice()`: ver el guard en la
     * transacción de `requestInvoice()`.
     */
    private readonly reservationRepo: Pick<ReservationRepository, 'getById' | 'getByIdWithLock'>,
    /** D8-Nivel B — el comprobante y sus líneas se crean en la misma transacción (A8.2/A8.3). */
    private readonly transactionManager: TransactionManager,
    /**
     * C1-Fase C (23/08/2026) — cierra el gap encontrado al diseñar
     * consolidada: hasta ahora, facturar una CHARGE vía este servicio
     * (el mismo camino que usa FacturarButton) no actualizaba
     * `accounts_receivable.status` aunque esa CHARGE viniera de
     * `transferStayBalanceToReceivable()` (F1-Pieza 3) — quedaba
     * PENDIENTE_FACTURAR para siempre pese a tener una factura real.
     * `requestConsolidatedInvoice()` también la usa para encontrar los
     * cargos pendientes de una empresa y para el guard anti double-billing.
     */
    private readonly accountsReceivableRepo: Pick<
      AccountsReceivableRepository,
      | 'getByFinancialTransactionId'
      | 'markInvoiced'
      | 'getPendingByCompanyCustomerId'
      | 'getByStayId'
      /**
       * Wave 12 (18/09/2026, gate `architecture-governor`, §7.2(b)) --
       * `getByIdWithLock`/`getByFinancialTransactionIdWithLock` cierran la
       * ventana que el lock de `reverseTransfer()` sobre `accounts_receivable`
       * NO cubre: ninguno de los dos caminos de emisión tomaba ese lock, así
       * que ninguno se enteraba de una reversa ya commiteada (o, en el
       * camino individual, ni siquiera necesitaba una carrera -- el cargo
       * de la empresa nunca lleva `stayId`, así que `resolveAccountsReceivableWarning()`
       * nunca consultaba `accounts_receivable` para él). Ver el guard dentro
       * de cada `transactionManager.run()` más abajo.
       */
      | 'getByIdWithLock'
      | 'getByFinancialTransactionIdWithLock'
    >,
    /**
     * I9 (24/08/2026, pendientes-2026-08-24.md) — invoices es DOCUMENTO
     * (criterios-datos.md Parte 1): nunca se edita, así que no aplica
     * `recordFieldChanges()` (diff before/after, para MAESTROS). Se audita
     * como evento único al crear la fila -- mismo patrón que
     * `role.service.ts` (alta de rol) -- y cubre tanto una Factura B normal
     * como una Nota de Crédito B (`buildCreditNote()`, C2) y la consolidada
     * (C1-Fase C): las tres pasan por `recordInvoiceAudit()` justo después
     * de `invoiceRepo.createWithClient()`. Un reintento idempotente
     * (`retryExisting()`) NO vuelve a auditar -- no crea una fila nueva.
     */
    private readonly auditLogRepo: AuditLogRepository,
    /**
     * Bloque D de `service_items` (15/09/2026,
     * docs/diseno-factura-borrador-2026-08-31.md §29.6 punto 17, decisión
     * del dueño vía `AskUserQuestion`) -- resuelve nombre/descripción para
     * la línea de factura de un `order_item` `SERVICE`, mismo patrón que
     * `productRepo`/`productVariantRepo`/`reservationRepo`. Antes de este
     * bloque, `resolveOrderItemLine()` no tenía ninguna rama para SERVICE:
     * caía al `else` de PRODUCT/PRODUCT_VARIANT, `product`/`variant`
     * quedaban `null` y la descripción caía al fallback literal
     * `'Producto'` -- antipatrón `honest-degradation` ("plausible y mal"
     * en vez de fallar ruidoso). Ver `resolveOrderItemLine()`.
     */
    private readonly serviceItemRepo: Pick<ServiceItemRepository, 'findById'>,
    /**
     * Bloque 3 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis
     * corregido) -- el INSERT de `credit_note_request` corre DENTRO de la
     * MISMA transacción que `invoiceRepo.createWithClient()` +
     * `recordInvoiceAudit()` en `buildCreditNote()`, gateado por
     * `tx.type === 'ADJUSTMENT'` (nunca para `REFUND`: `CancellationRefundService`
     * también llama a `buildCreditNote()` con `type: 'REFUND'` -- sin el
     * filtro se generarían filas espurias para reembolsos normales de C2).
     * `Pick<..., 'createWithClient'>` -- mínimo necesario, mismo criterio
     * que el resto de repos inyectados acá (bounded contexts).
     *
     * Bloque 4 (15/09/2026, §6.5 bis) -- suma `'findByInvoiceId'` y
     * `'transitionWithClient'`: `transitionCreditNoteRequestAfterFailure()`
     * (más abajo) los usa para enganchar las 3 transiciones automáticas
     * sobre el `markFailedWithClient()` ya atómico del Bloque 2.
     *
     * Bloque 5 (15/09/2026, §6.5 bis) -- suma `'findById'`:
     * `resolveCreditNoteRequestManually()` (más abajo) lo usa para resolver
     * la fila por `id` (el que trae la ruta `POST
     * /api/credit-note-requests/:id/resolve`) antes de transicionarla --
     * `findByInvoiceId` no sirve acá porque el caller solo tiene el id de la
     * SOLICITUD, no el de la factura. Sigue siendo un `Pick` angosto, no el
     * repo completo (`listByState` no hace falta acá — es de la ruta GET de
     * listado, que instancia `SqlCreditNoteRequestRepository` directo, ver
     * `credit-note-requests.routes.ts`).
     *
     * ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.9,
     * "A-4" -- suma `'findByIdForUpdate'`: la reclasificación bajo lock de
     * `resolveCreditNoteRequestManually()` (más abajo) la usa para lockear
     * la solicitud DESPUÉS de la factura, sin re-validar transición.
     */
    private readonly creditNoteRequestRepo: Pick<CreditNoteRequestRepository, 'createWithClient' | 'findByInvoiceId' | 'findById' | 'findByIdForUpdate' | 'transitionWithClient'>,
    private readonly clientFactory: AfipBillingPortFactory = buildDefaultAfipBillingPort,
  ) {}

  /**
   * RBAC paso 2 (27/08/2026, pendientes-2026-08-27.md) — antes corría con
   * `record()` DESPUÉS de cerrar el `transactionManager.run()` que crea la
   * factura, en los tres call sites. Si el INSERT de auditoría fallaba, la
   * factura ya estaba persistida sin su fila de auditoría (A6.5/A8.2). Ahora
   * recibe el `client` de la MISMA transacción y usa `recordWithClient()`: si
   * el commit falla, ni la factura ni la auditoría quedan. Mismo fix que RBAC
   * paso 1 aplicó en los otros call sites.
   */
  private async recordInvoiceAudit(client: SqlClient, invoice: Invoice, changedBy: string): Promise<void> {
    if (!this.auditLogRepo.recordWithClient) {
      throw new Error('AuditLogRepository.recordWithClient no está implementado.');
    }
    await this.auditLogRepo.recordWithClient(client, [{
      entity: AUDIT_ENTITY,
      entityId: invoice.id,
      field: 'cbteTipo',
      oldValue: null,
      newValue: invoice.cbteTipo,
      changedBy,
    }]);
  }

  /**
   * Desglosa `amount` en neto + IVA para UNA tasa (A2.9 — nunca un
   * supuesto fijo). `resolveIvaGroups()` la llama una vez por cada tasa
   * distinta que participó de la venta (D8) — con una sola tasa (el caso
   * de siempre: reservas, o una orden con un solo producto/todos a la
   * misma tasa) el comportamiento es idéntico al de antes de D8.
   */
  private splitAmount(
    amount: number,
    pricesIncludeIva: boolean,
    ivaRatePercent: number,
  ): { impNeto: number; impIva: number; impTotal: number } {
    const rate = ivaRatePercent / 100;
    if (!pricesIncludeIva) {
      const impIva = round2(amount * rate);
      return { impNeto: round2(amount), impIva, impTotal: round2(amount + impIva) };
    }
    const impNeto = round2(amount / (1 + rate));
    const impIva = round2(amount - impNeto);
    return { impNeto, impIva, impTotal: round2(amount) };
  }

  /**
   * D8-Nivel B (23/08/2026, docs/diseno-facturacion-lineas-nivel-b-2026-08-23.md)
   * — arma las líneas reales del comprobante. Reemplaza a `resolveIvaGroups()`
   * (D8) -- el `Iva[]` que se manda a AFIP se deriva ahora de ESTAS MISMAS
   * líneas (agrupadas por `ivaRate`) en vez de leer `order_items` aparte,
   * un solo cómputo (R14).
   *
   * 1. Orden con ítems (`tx.orderId`): una línea POR `order_item`, sin
   *    importar el tipo (PRODUCT/PRODUCT_VARIANT/RESERVATION).
   * 2. Reserva facturada directo (`tx.reservationId`, sin `orderId` — el
   *    camino más común hoy): UNA línea. `unitPrice=subtotal=tx.amount`,
   *    NUNCA `reservation.totalPrice` -- con C1-Fase A una misma reserva
   *    genera dos FinancialTransaction (seña/saldo), cada una con su
   *    propia factura; `tx.amount` es lo que corresponde a ESTE
   *    comprobante puntual. Limitación conocida (documentada en el
   *    diseño): la descripción no distingue "seña" de "saldo".
   * 3. Caso borde sin orden ni reserva asociada: una línea genérica,
   *    mismo fallback que ya existía en Nivel A.
   */
  private async resolveInvoiceItems(
    tx: Pick<FinancialTransaction, 'amount' | 'orderId' | 'reservationId'>,
    profile: Pick<BusinessProfile, 'defaultIvaRate'>,
    concepto: number,
  ): Promise<CreateInvoiceItemInput[]> {
    if (tx.orderId) {
      const order = await this.orderRepo.getById(tx.orderId);
      if (order && order.items.length > 0) {
        return Promise.all(order.items.map((item) => this.resolveOrderItemLine(item, profile)));
      }
    }

    if (tx.reservationId) {
      const reservation = await this.reservationRepo.getById(tx.reservationId);
      return [{
        orderItemId: null,
        reservationId: tx.reservationId,
        description: reservation ? reservation.resource.name : 'Reserva',
        quantity: 1,
        unitPrice: tx.amount,
        subtotal: tx.amount,
        ivaRate: profile.defaultIvaRate,
        unit: null,
        arcaUnitCode: null,
      }];
    }

    return [{
      orderItemId: null,
      reservationId: null,
      description: concepto === 1 ? 'Productos' : 'Servicios',
      quantity: 1,
      unitPrice: tx.amount,
      subtotal: tx.amount,
      ivaRate: profile.defaultIvaRate,
      unit: null,
      arcaUnitCode: null,
    }];
  }

  private async resolveOrderItemLine(
    item: OrderItem,
    profile: Pick<BusinessProfile, 'defaultIvaRate'>,
  ): Promise<CreateInvoiceItemInput> {
    if (item.itemType === 'RESERVATION') {
      const reservation = item.reservationId ? await this.reservationRepo.getById(item.reservationId) : null;
      return {
        orderItemId: item.id,
        // INVOICE-ITEM-ORIGIN-XOR-001 (11/09/2026, gate architecture-governor,
        // reproducido contra Postgres real -- 23514 en chk_invoice_item_origin
        // antes de este fix). Esta línea nace de un order_item -- ESE es su
        // origen documental, no la reserva a la que referencia (un hop más
        // allá). chk_invoice_item_origin exige XOR estricto: setear los dos
        // a la vez violaba el CHECK 100% de las veces que un order_item
        // RESERVATION llegaba hasta acá (chk_order_item_polymorphic ya
        // garantiza reservationId NOT NULL para ese itemType, así que el
        // guard `? ... : null` de arriba nunca tomaba la rama null en una
        // fila real). No se pierde información: order_items.reservation_id
        // sigue siendo recuperable por JOIN, y refund-attribution.ts:151-153
        // ya documenta que un ítem de origen orden cuenta en el denominador
        // del grupo de tasa SIN entrada propia -- exactamente lo que
        // reservationId: null produce acá, alineando el productor con el
        // contrato que el consumidor ya asumía.
        reservationId: null,
        description: reservation ? reservation.resource.name : 'Reserva',
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        // D8 nunca extendió IVA-por-ítem a reservas -- solo productos.
        ivaRate: profile.defaultIvaRate,
        unit: null,
        arcaUnitCode: null,
      };
    }

    if (item.itemType === 'SERVICE') {
      // Bloque D de `service_items` (15/09/2026, §29.6 punto 17). Antes de
      // este fix, un ítem SERVICE no tenía `productId` ni `productVariantId`
      // (chk_order_item_polymorphic ya exige `serviceItemId` NOT NULL para
      // este itemType) -- caía al `else` de abajo, `product`/`variant`
      // quedaban `null`, y la descripción caía al fallback literal
      // `'Producto'`: un bug real, no cosmético (honest-degradation). Si el
      // `service_item` referenciado no existe (dato corrupto/referencia
      // rota), esto falla VISIBLE con `ServiceItemNotFoundError` en vez de
      // repetir el mismo antipatrón con un fallback silencioso distinto.
      const serviceItem = item.serviceItemId ? await this.serviceItemRepo.findById(item.serviceItemId) : null;
      if (!serviceItem) throw new ServiceItemNotFoundError(item.serviceItemId ?? item.id);

      return {
        orderItemId: item.id,
        // Mismo XOR que la rama RESERVATION de arriba y la de PRODUCT/
        // PRODUCT_VARIANT de abajo -- confirmado sin cambios, §29.6 punto 18:
        // un ítem SERVICE factura igual que PRODUCT/PRODUCT_VARIANT (nace de
        // un order_item, ESE es su origen documental).
        reservationId: null,
        description: serviceItem.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        subtotal: item.subtotal,
        ivaRate: item.ivaRate ?? profile.defaultIvaRate,
        // `service_items` no tiene columnas `unit`/`arca_unit_code` propias
        // (Bloque B del schema, `service-item.entities.ts`) -- a diferencia
        // de `products`, no hay equivalente que resolver acá. Explícito en
        // `null`/`null`, no un valor inventado: puede o no ser correcto para
        // AFIP, y ESO no se resuelve en este bloque (§29.6 punto 17,
        // diseño). No reintroduce el bug: el bug era la DESCRIPCIÓN cayendo
        // a `'Producto'`, no estos dos campos, que ya eran `null`/`null`
        // para RESERVATION también (ver arriba).
        unit: null,
        arcaUnitCode: null,
      };
    }

    const product = item.productId ? await this.productRepo.getById(item.productId) : null;
    const variant = item.productVariantId ? await this.productVariantRepo.getById(item.productVariantId) : null;
    const description = variant ? `${product?.name ?? item.productId} (${variant.name})` : (product?.name ?? item.productId ?? 'Producto');

    return {
      orderItemId: item.id,
      reservationId: null,
      description,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      subtotal: item.subtotal,
      // Snapshot ya congelado en D8 -- nunca relee products.iva_rate actual.
      ivaRate: item.ivaRate ?? profile.defaultIvaRate,
      unit: product?.unit ?? null,
      arcaUnitCode: product?.arcaUnitCode ?? null,
    };
  }

  /**
   * §9.4 (13/09/2026, gate `architecture-governor`, decisión del dueño --
   * "Exponer, no bloquear"). Devuelve `undefined` -- nunca `[]` -- si no
   * hay nada que revisar (mismo criterio de normalización que §9.2).
   *
   * Acotado a Factura B normal, a propósito: NO aplica a Nota de Crédito
   * (`tx.type` `REFUND`/`ADJUSTMENT`). **Censo corregido (Wave 13, Zona 2,
   * 21/09/2026, gate `architecture-governor`) -- este comentario decía "los
   * 3 únicos productores de esos tipos en el repo" y daba un argumento de
   * `stayId` que no vale para 2 de los 5 reales: ver el censo completo en
   * docs/diseno-invoice-retry-charge-guard-2026-09-18.md §6 (**5 productores**
   * reales de `type: 'REFUND'|'ADJUSTMENT'` -- esa sección enumera 6 FILAS
   * de código, no 6 productores: 2 de esas filas son las 2 ramas de un
   * mismo productor, `cancellation-refund.service.ts`, ver la nota "6
   * sitios acá vs. 5 productores" de esa misma sección), no repetido acá
   * para no mantener 2 censos que puedan volver a divergir.** Los 2 orquestadores
   * del escape con NC calculan/exponen este mismo warning por su propio
   * camino (`cancel-order-with-credit-note.service.ts:465`,
   * `cancel-reservation-with-credit-note.service.ts:475` -- ancla corregida,
   * la anterior apuntaba a `cancel-with-credit-note.ts:53-61`, que es la
   * interfaz `AccountsReceivableWarningEntry`, no el cómputo; §9.2) --
   * cubrirlo acá también duplicaría el campo en el mismo payload HTTP
   * (`creditNote.accountsReceivableWarning` + el hermano de `result`),
   * rompiendo el contrato "presente si y solo si hay algo que revisar" que
   * §9.2 ya documentó. Los otros productores (C2, `reverseTransfer()`, el
   * ajuste de precio de reserva) nunca llegan a este método -- ninguno
   * pasa por el camino de Factura B individual que lo llama. El hueco
   * angosto que queda (facturar un `ADJUSTMENT` huérfano, nunca facturado
   * por ninguno de los 2 orquestadores, directo por `POST /api/invoices`)
   * es territorio de `docs/diseno-salida-manual-nc-y-reapertura-b3-2026-09-12.md:274`,
   * que ya planea tocar `requestInvoice()` -- no se cierra acá.
   */
  private async resolveAccountsReceivableWarning(tx: FinancialTransaction): Promise<AccountsReceivableWarningEntry[] | undefined> {
    if (tx.type === 'REFUND' || tx.type === 'ADJUSTMENT') return undefined;

    // El `CHARGE` que `transferStayBalanceToReceivable()` crea contra la
    // EMPRESA nunca lleva `stayId` -- a propósito, para no reabrir el
    // folio del huésped (`accounts-receivable.service.ts:292-315`,
    // invariante fijado por test en
    // `accounts-receivable.service.test.ts:320`). Por eso no hace falta
    // filtrar `ar.financialTransactionId !== tx.id` acá: facturar ESE
    // cargo (el camino legítimo, F1-Pieza 3/C1-Fase C) nunca llega con
    // `tx.stayId` no nulo -- este `if` ya lo excluye.
    if (!tx.stayId) return undefined;

    const entries = (await this.accountsReceivableRepo.getByStayId(tx.stayId))
      .filter((ar) => (ar.status as string) !== 'REVERTIDO')
      .map((ar): AccountsReceivableWarningEntry => ({
        accountsReceivableId: ar.id,
        companyCustomerId: ar.companyCustomerId,
        status: ar.status,
        amount: ar.amount,
      }));
    if (entries.length === 0) return undefined;

    // Evento propio, NO reusar `nc_escape_con_ar_viva` (§9.2) -- son dos
    // mecanismos distintos (acá es la Factura B/emisión, no el escape de
    // NC) y las consultas de log tienen que poder separarlos.
    logger.warn(
      { evento: 'factura_con_ar_viva', financialTransactionId: tx.id, stayId: tx.stayId, accountsReceivableWarning: entries },
      '[InvoiceService] requestInvoice(): la estadía de este cargo ya tiene un traspaso vivo a una empresa -- revisar manualmente.',
    );

    return entries;
  }

  async requestInvoice(input: RequestInvoiceInput): Promise<RequestInvoiceResult> {
    // Idempotencia DETERMINÍSTICA por financial_transaction_id (ver
    // docblock de schema.sql en la tabla invoices) — un reintento (doble
    // click, timeout del cliente, o el usuario volviendo a intentar tras
    // arreglar algo del lado de AFIP) siempre pega contra la MISMA fila,
    // nunca dispara un segundo pedido de CAE con una fila nueva.
    const idempotencyKey = `invoice:${input.financialTransactionId}`;
    const existing = await this.invoiceRepo.getByIdempotencyKey(idempotencyKey);
    if (existing) return this.retryExisting(existing);

    // Guard cruzado (INVOICE-CHARGES-GUARD-INDIVIDUAL-01, 11/09/2026, gate
    // `architecture-governor`) -- DESPUÉS de la idempotencia propia de
    // arriba, a propósito: la posición es load-bearing. Cualquier factura
    // que ESTE camino (individual) ya haya creado para este `ftId` tiene
    // clave `invoice:<ftId>` y la atrapa `:333` primero -- este guard solo
    // puede ver un comprobante que vino del OTRO camino (consolidada, vía
    // `invoice_charges`), con OTRA clave de idempotencia
    // (`invoice:consolidated:<hash>`) que nunca va a chocar acá. Si este
    // guard se moviera antes de `:333`, rompería el reintento de los 4
    // call-sites de cancelación-con-NC (`cancel-order-with-credit-note.service.ts`,
    // `cancel-reservation-with-credit-note.service.ts`) -- ver el docblock
    // de `resolveInvoiceLinkage()` y de `INVOICE_STATUSES_CONSUMING_CHARGE`
    // para el resto del razonamiento (por qué NO se reusa el predicado más
    // fino de `retryExisting()`, y por qué `REJECTED` no bloquea).
    const linkage = await this.invoiceRepo.resolveInvoiceLinkage(input.financialTransactionId);
    if (linkage.kind === 'ISSUED') {
      throw new InvoiceAlreadyLinkedByOtherPathError(input.financialTransactionId, linkage.invoiceId);
    }
    if (linkage.kind === 'NOT_ISSUED' && INVOICE_STATUSES_CONSUMING_CHARGE.includes(linkage.status)) {
      throw new InvoiceAlreadyLinkedByOtherPathError(input.financialTransactionId, linkage.invoiceId);
    }

    const tx = await this.financialTransactionRepo.getById(input.financialTransactionId);
    if (!tx) throw new FinancialTransactionNotFoundError(input.financialTransactionId);

    const accountsReceivableWarning = await this.resolveAccountsReceivableWarning(tx);

    const profile = await this.businessProfileRepo.get();
    // afipCuit (schema v25) gana si está cargado -- CUIT con el que
    // AUTENTICA contra AFIP, puede diferir del legal (taxId) en
    // homologación (ver docblock de BusinessProfile.afipCuit).
    const authCuit = profile.afipCuit ?? profile.taxId;
    if (!authCuit) throw new AfipNotConfiguredError('falta cargar el CUIT del negocio en Mi Negocio');
    if (!profile.afipSalesPoint) throw new AfipNotConfiguredError('falta el punto de venta AFIP en Mi Negocio');

    const credentials = await this.afipCredentialsRepo.getDecrypted();
    if (!credentials) throw new AfipNotConfiguredError('falta cargar el certificado AFIP en Mi Negocio');

    // C2 (23/08/2026, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md)
    // -- una FinancialTransaction REFUND arma una Nota de Crédito B, no una
    // Factura B. R14: misma ruta de emisión de CAE (idempotencia, issue(),
    // reconcileAfterFailure(), retryExisting()) para cualquier tipo de
    // transacción -- el branching vive solo acá, en cómo se arma el
    // afipRequest/los ítems.
    //
    // ADR cancelar-con-NC §5 (F2, sub-bloque 3, 07/09/2026) -- el ADJUSTMENT
    // compensatorio del escape de cancelación de orden TAMBIÉN arma una NC,
    // no una Factura B. Sin este `|| 'ADJUSTMENT'` caería al camino de
    // Factura B de abajo y la clave de idempotencia (`invoice:<ftId>`, :325)
    // reanudaría un reintento contra un comprobante del tipo equivocado.
    if (tx.type === 'REFUND' || tx.type === 'ADJUSTMENT') {
      // RBAC paso 2 — la auditoría se graba ADENTRO de la transacción de
      // buildCreditNote (recibe changedBy), no acá afuera con la NC ya creada.
      const invoice = await this.buildCreditNote(tx, input, profile, authCuit, credentials, idempotencyKey, input.changedBy);
      const client = this.clientFactory(credentials, authCuit, this.afipCredentialsRepo);
      return this.issue(client, invoice, invoice.afipRequest as Record<string, unknown>, credentials.environment, profile.afipSalesPoint!);
    }

    const buyer = input.buyer ?? CONSUMIDOR_FINAL;
    const concepto = input.concepto ?? CONCEPTO_SERVICIOS;

    // D8-Nivel B (23/08/2026) -- líneas reales del comprobante. El
    // agrupado por tasa para Iva[] (D8) se deriva de ESTAS líneas, no de
    // una lectura aparte de order_items (R14, un solo cómputo).
    const items = await this.resolveInvoiceItems(tx, profile, concepto);
    const { impNeto, impIva, impTotal, afipRequest } = this.buildIvaBreakdown(items, profile, buyer, concepto);

    const invoiceId = randomUUID();

    // D8-Nivel B -- el comprobante y sus líneas se crean atómicamente
    // (A8.2/A8.3): nunca una factura persistida sin ninguna línea por una
    // falla a mitad de camino.
    let invoice!: Invoice;
    await this.transactionManager.run(async (client: SqlClient) => {
      // Wave 12 (18/09/2026, gate `architecture-governor`, §7.2(b) --
      // orden corregido tras reproducir un DEADLOCK real contra Postgres,
      // ver el bloque gemelo en `requestConsolidatedInvoice()` para el
      // detalle completo del log real) -- guard-espejo de guard 8-bis de
      // `reverseTransfer()` (`accounts-receivable.service.ts`, sección
      // "Guard 8-bis" de su propio docblock -- cita por nombre, no línea,
      // desde SCHEMA-ANCHOR-DRIFT-001, que rechaza revertir un cargo con
      // comprobante vivo/pendiente). Ninguna otra línea de este método consulta
      // `accounts_receivable` para EL cargo que se está facturando --
      // `resolveAccountsReceivableWarning()` (arriba, antes de esta tx)
      // mira la ESTADÍA del cargo, no el cargo mismo, y ni siquiera corre
      // para el CHARGE de una empresa (nunca lleva `stayId`, por diseño de
      // §9.4 -- ver su docblock). Sin este guard, `input.financialTransactionId`
      // podía pertenecer a una AR ya `REVERTIDO` y este método igual pedía
      // un CAE real -- no una carrera: alcanzable en cualquier momento
      // después de la reversa, no solo en una ventana de concurrencia.
      //
      // PRIMERA operación de la transacción a propósito -- no puede ir
      // después de los locks de `orders`/`reservations` de abajo, mismo
      // motivo que en `requestConsolidatedInvoice()`: `reverseTransfer()`
      // ya lockea la AR PRIMERO (O2F2-A) y DESPUÉS inserta las 2 filas
      // `ADJUSTMENT` compensatorias (heredan `reservation_id` del `CHARGE`
      // original), lo que toma un lock `FOR KEY SHARE` IMPLÍCITO sobre esa
      // fila de `reservations` (chequeo de la FK). Si este guard corriera
      // DESPUÉS del lock de `reservations` de RESERVA-10, dos conexiones
      // reales podrían deadlockearse: esta tx sosteniendo
      // `reservations FOR UPDATE` y esperando la AR, mientras
      // `reverseTransfer()` sostiene la AR y espera esa MISMA fila de
      // `reservations`. Lockeando la AR PRIMERO acá también, los dos
      // caminos conviven con el MISMO orden global (AR antes que
      // reservations/orders) -- el que pierde la carrera bloquea solo en
      // la AR, nunca hay ciclo.
      const arForCharge = await this.accountsReceivableRepo.getByFinancialTransactionIdWithLock(
        client,
        input.financialTransactionId,
      );
      if (arForCharge && arForCharge.status === 'REVERTIDO') {
        throw new AccountsReceivableReversedCannotInvoiceError(arForCharge.id);
      }

      // ORDER-10 (05/09/2026, architecture-governor) -- cierre de la
      // ventana TOCTOU con `OrderService.cancelOrder()`. Ambas rutas
      // toman el MISMO lock (`orders`, `FOR UPDATE`) antes de decidir:
      // sin esto, un `cancelOrder()` y un `requestInvoice()` concurrentes
      // sobre la misma orden podían entrelazarse -- la cancelación lee
      // "sin factura todavía" mientras la facturación, un instante
      // después, todavía no vio la orden CANCELLED -- y las dos avanzan.
      // Si la orden ya está CANCELLED, no tiene sentido llegar a crear la
      // fila de `invoices` para después descartarla con el rollback.
      if (tx.orderId != null) {
        const order = await this.orderRepo.getByIdForUpdate(client, tx.orderId);
        if (order && order.status === 'CANCELLED') {
          throw new OrderCancelledCannotInvoiceError(tx.orderId);
        }
      }

      // RESERVA-10 (05/09/2026, architecture-governor) -- mismo cierre de
      // ventana TOCTOU que el bloque de arriba, ahora con
      // `cancelReservation()`. `getByIdWithLock` es opcional en la
      // interfaz (mismo criterio que `requireReservationWithLock` de
      // `ReservationService`): si la implementación no lo tiene (el fake
      // en memoria de los tests), cae a `getById()` sin lock -- no hay
      // transacción real que proteger ahí de todos modos.
      if (tx.reservationId != null) {
        const reservation = this.reservationRepo.getByIdWithLock
          ? await this.reservationRepo.getByIdWithLock(client, tx.reservationId)
          : await this.reservationRepo.getById(tx.reservationId);
        if (reservation && reservation.status === ReservationStatus.CANCELLED) {
          throw new ReservationCancelledCannotInvoiceError(tx.reservationId);
        }
      }

      invoice = await this.invoiceRepo.createWithClient(
        client,
        {
          id: invoiceId,
          businessId: input.businessId,
          financialTransactionId: input.financialTransactionId,
          customerId: tx.customerId,
          idempotencyKey,
          environment: credentials.environment,
          ptoVta: profile.afipSalesPoint!,
          cbteTipo: CBTE_TIPO_FACTURA_B,
          emisorCuit: authCuit,
          concepto,
          docTipo: buyer.docTipo,
          docNro: buyer.docNro,
          condicionIvaReceptorId: buyer.condicionIvaReceptorId,
          moneda: 'PES',
          impNeto,
          impIva,
          impTotal,
          // Congelados desde la FinancialTransaction de origen (R9) -- el
          // comprobante nunca vuelve a consultarla después de esto.
          paymentMethod: tx.paymentMethod ?? null,
          cardInstallments: tx.cardInstallments ?? null,
        },
        afipRequest,
        items,
      );
      await this.recordInvoiceAudit(client, invoice, input.changedBy);
    });

    const client = this.clientFactory(credentials, authCuit, this.afipCredentialsRepo);
    const result = await this.issue(client, invoice, afipRequest, credentials.environment, profile.afipSalesPoint);
    return accountsReceivableWarning ? { ...result, accountsReceivableWarning } : result;
  }

  /**
   * C1-Fase C (23/08/2026) — "Facturar ahora": UN comprobante AFIP
   * cubriendo TODO lo `PENDIENTE_FACTURAR` de una empresa ahora mismo (no
   * espera ningún ciclo). Reusa `resolveInvoiceItems()` por cada
   * `FinancialTransaction` involucrada y concatena las líneas -- mismo
   * cómputo que el camino per-reservation (R14), solo que agrupa IVA sobre
   * el conjunto completo en vez de una sola transacción.
   *
   * FACT-CONSOL-TOCTOU-01 (05/09/2026, architecture-governor -- H3 de la revisión de
   * RESERVA-10) -- hasta acá, este método no tenía NINGÚN guard TOCTOU: a
   * diferencia de `requestInvoice()` (ORDER-10/RESERVA-10), facturaba los N
   * cargos pendientes sin volver a mirar si la orden o la reserva de origen
   * de alguno de ellos se acababa de cancelar. El guard de abajo, dentro de
   * la transacción, generaliza el mismo mecanismo a los N `orderId`/
   * `reservationId` distintos que puede traer el lote -- reusa
   * `OrderCancelledCannotInvoiceError`/`ReservationCancelledCannotInvoiceError`,
   * no inventa un vehículo de rechazo nuevo (R14). Decisión del dueño del
   * producto (AskUserQuestion, 05/09/2026): si CUALQUIERA de las N está
   * CANCELLED, se rechaza el LOTE ENTERO -- misma POLÍTICA de rechazo que ya
   * rige el guard de double-billing de acá abajo ("se rechaza toda la
   * operación, no se arma una factura parcial en silencio"), pero NO el
   * mismo mecanismo: el de double-billing corre ANTES de abrir la
   * transacción (una lectura, sin lock -- cierra una inconsistencia ya
   * ocurrida, no una carrera en curso); este corre DENTRO, con `FOR UPDATE`
   * sobre cada orden/reserva, porque es el que tiene que ganarle a una
   * carrera real con `cancelOrder()`/`cancelReservation()`.
   */
  async requestConsolidatedInvoice(input: RequestConsolidatedInvoiceInput): Promise<Invoice> {
    const pending = await this.accountsReceivableRepo.getPendingByCompanyCustomerId(input.companyCustomerId);
    if (pending.length === 0) {
      throw new NothingToInvoiceError(input.companyCustomerId);
    }
    const financialTransactionIds = pending.map((ar) => ar.financialTransactionId!);

    // Idempotencia PRIMERO, antes del guard anti double-billing (ver
    // abajo) -- a propósito, en ese orden: si un intento anterior emitió
    // la factura pero el paso de marcar accounts_receivable FACTURADO
    // falló a mitad de camino (best-effort, ver el loop más abajo), las
    // filas siguen PENDIENTE_FACTURAR con el mismo `financialTransactionIds`
    // de antes -- eso es exactamente un reintento del mismo pedido, no un
    // caso nuevo de double-billing. Si corriera el guard primero,
    // rechazaría con AccountsReceivableAlreadyInvoicedError un reintento
    // legítimo. Mismo criterio que requestInvoice (idempotencyKey por
    // financialTransactionId), generalizado a N vía hash (join crudo
    // podría superar VARCHAR(255) con muchos cargos).
    const idempotencyKey = `invoice:consolidated:${hashIds(financialTransactionIds)}`;
    const existing = await this.invoiceRepo.getByIdempotencyKey(idempotencyKey);
    if (existing) return this.retryExisting(existing);

    // Guard contra double-billing (ver docblock de
    // getInvoicedFinancialTransactionIds -- predicado corregido 11/09/2026,
    // NO filtra por status): acá ya se descartó que sea un reintento del
    // mismo pedido -- si igual aparece un cargo YA VINCULADO a un
    // comprobante vivo por CUALQUIERA de los 2 caminos (invoice_charges
    // de otra consolidada, o invoices.financial_transaction_id directo
    // de una factura individual -- ver el docblock de
    // getInvoicedFinancialTransactionIds() para la asimetría de status
    // entre las 2 ramas), es un SET distinto de cargos que se solapa con
    // una factura previa (inconsistencia real, no un reintento). Se
    // rechaza toda la operación, no se arma una factura parcial en
    // silencio (R15).
    const alreadyInvoiced = await this.invoiceRepo.getInvoicedFinancialTransactionIds(financialTransactionIds);
    if (alreadyInvoiced.size > 0) {
      throw new AccountsReceivableAlreadyInvoicedError(input.companyCustomerId, [...alreadyInvoiced]);
    }

    const profile = await this.businessProfileRepo.get();
    const authCuit = profile.afipCuit ?? profile.taxId;
    if (!authCuit) throw new AfipNotConfiguredError('falta cargar el CUIT del negocio en Mi Negocio');
    if (!profile.afipSalesPoint) throw new AfipNotConfiguredError('falta el punto de venta AFIP en Mi Negocio');
    const credentials = await this.afipCredentialsRepo.getDecrypted();
    if (!credentials) throw new AfipNotConfiguredError('falta cargar el certificado AFIP en Mi Negocio');

    const buyer = input.buyer ?? CONSUMIDOR_FINAL;
    const concepto = input.concepto ?? CONCEPTO_SERVICIOS;

    const allItems: CreateInvoiceItemInput[] = [];
    const txs: FinancialTransaction[] = [];
    for (const financialTransactionId of financialTransactionIds) {
      const tx = await this.financialTransactionRepo.getById(financialTransactionId);
      if (!tx) throw new FinancialTransactionNotFoundError(financialTransactionId);
      txs.push(tx);
      allItems.push(...(await this.resolveInvoiceItems(tx, profile, concepto)));
    }

    const { impNeto, impIva, impTotal, afipRequest } = this.buildIvaBreakdown(allItems, profile, buyer, concepto);

    // FACT-CONSOL-TOCTOU-01 -- órdenes/reservas distintas involucradas en el lote,
    // deduplicadas y en orden ASCENDENTE de id (A8.1/A8.2, mismo criterio
    // que `ReservationAvailabilityService.assertAllResourcesAvailable()`):
    // dos consolidadas concurrentes que comparten una orden o una reserva
    // lockean siempre en el mismo orden entre sí y nunca se deadlockean.
    const orderIds = [...new Set(txs.map((tx) => tx.orderId).filter((id): id is string => id != null))].sort();
    const reservationIds = [...new Set(txs.map((tx) => tx.reservationId).filter((id): id is string => id != null))].sort();

    const invoiceId = randomUUID();
    let invoice!: Invoice;
    await this.transactionManager.run(async (client: SqlClient) => {
      // Wave 12 (18/09/2026, gate `architecture-governor`, §7.2(b) -- orden
      // corregido tras reproducir un DEADLOCK real contra Postgres, ver
      // abajo) -- guard-espejo de guard 8-bis de `reverseTransfer()`,
      // generalizado al LOTE: `pending` se leyó UNA vez, sin lock, al
      // principio de este método (arriba) -- si `reverseTransfer()`
      // revirtió alguna de esas filas mientras tanto (entre esa lectura y
      // el COMMIT de esta tx), este método igual pedía un CAE real
      // cubriendo un cargo ya revertido, y el `markInvoiced()` best-effort
      // de más abajo fallaba mudo para esa fila sin que nadie se enterara.
      // Re-lockea cada AR del lote por SU id, en orden ascendente (mismo
      // motivo que `orderIds`/`reservationIds` abajo: dos consolidadas
      // concurrentes que compartieran una AR nunca se deadlockean entre
      // sí). Rechaza el LOTE ENTERO ante la primera revertida -- misma
      // política que los guards de abajo y que el guard de double-billing
      // más arriba en este método ("no se arma una factura parcial en
      // silencio", R15). Se chequea específicamente `REVERTIDO` (no
      // "cualquier estado distinto de PENDIENTE_FACTURAR"): FACTURADO/
      // COBRADO ya están excluidos por el guard de double-billing que
      // corrió antes de abrir esta transacción -- REVERTIDO es la única
      // transición nueva alcanzable en esta ventana.
      //
      // PRIMERA operación de la transacción a propósito -- no por
      // simetría con el resto de esta lista, sino porque NO puede ir
      // después del lock de `reservations` de abajo. `reverseTransfer()`
      // ya lockea la AR PRIMERO (O2F2-A, `accounts-receivable.service.ts`
      // ~`:850-852`, "Lock de la AR PRIMERO -- serializa contra un
      // markCollected() o un reverseTransfer() concurrentes") y DESPUÉS
      // inserta las 2 filas `ADJUSTMENT` compensatorias, que heredan
      // `reservation_id` del `CHARGE` original -- ese INSERT toma un lock
      // `FOR KEY SHARE` IMPLÍCITO sobre esa fila de `reservations` (chequeo
      // de la FK). Con el guard de AR corriendo DESPUÉS del lock de
      // `reservations` (versión anterior de este bloque), dos conexiones
      // reales podían deadlockearse de verdad: esta tx sosteniendo
      // `reservations FOR UPDATE` y esperando la AR, mientras
      // `reverseTransfer()` sostenía la AR y esperaba esa MISMA fila de
      // `reservations` (vía el INSERT del ADJUSTMENT) -- reproducido
      // contra Postgres real
      // (`invoice-accounts-receivable-reversed-guard.integration.test.ts`,
      // log real: "Process ... waits for ShareLock ...; blocked by
      // process ...", con el `INSERT INTO financial_transactions` de un
      // lado y el `SELECT ... FOR UPDATE` de `accounts_receivable` del
      // otro). Lockeando la AR PRIMERO acá también, los dos caminos
      // conviven con el MISMO orden global (AR antes que reservations),
      // así que el que pierde la carrera bloquea solo en la AR -- nunca
      // hay ciclo.
      //
      // ACCOUNTS-RECEIVABLE-LOCK-ORDER-001 (Wave 13, Zona 2, 21/09/2026) --
      // `canonicalAccountsReceivableLockOrder()` reemplaza el `.sort()`
      // ad-hoc que este bloque tenía (comportamiento idéntico para UUIDs,
      // ver docblock de la función) -- ahora es el MISMO comparador que usa
      // el guard de retry (`assertChargesStillInvoiceable()`), evitando que
      // las dos copias del orden de locks puedan divergir en el futuro.
      for (const ar of canonicalAccountsReceivableLockOrder(pending, (ar) => ar.id)) {
        const locked = await this.accountsReceivableRepo.getByIdWithLock(client, ar.id);
        if (locked && locked.status === 'REVERTIDO') {
          throw new AccountsReceivableReversedCannotInvoiceError(locked.id);
        }
      }

      // FACT-CONSOL-TOCTOU-01 -- mismo criterio que el guard de
      // `requestInvoice()`: si alguna ya está CANCELLED no tiene sentido
      // llegar a crear la fila de `invoices` para después descartarla con
      // el rollback. Rechaza el LOTE ENTERO ante la primera que falle --
      // ver docblock del método.
      for (const orderId of orderIds) {
        const order = await this.orderRepo.getByIdForUpdate(client, orderId);
        if (order && order.status === 'CANCELLED') {
          throw new OrderCancelledCannotInvoiceError(orderId);
        }
      }
      for (const reservationId of reservationIds) {
        const reservation = this.reservationRepo.getByIdWithLock
          ? await this.reservationRepo.getByIdWithLock(client, reservationId)
          : await this.reservationRepo.getById(reservationId);
        if (reservation && reservation.status === ReservationStatus.CANCELLED) {
          throw new ReservationCancelledCannotInvoiceError(reservationId);
        }
      }

      invoice = await this.invoiceRepo.createWithClient(
        client,
        {
          id: invoiceId,
          businessId: input.businessId,
          financialTransactionId: null,
          customerId: input.companyCustomerId,
          idempotencyKey,
          environment: credentials.environment,
          ptoVta: profile.afipSalesPoint!,
          cbteTipo: CBTE_TIPO_FACTURA_B,
          emisorCuit: authCuit,
          concepto,
          docTipo: buyer.docTipo,
          docNro: buyer.docNro,
          condicionIvaReceptorId: buyer.condicionIvaReceptorId,
          moneda: 'PES',
          impNeto,
          impIva,
          impTotal,
        },
        afipRequest,
        allItems,
        pending.map((ar) => ({ financialTransactionId: ar.financialTransactionId!, amount: ar.amount })),
      );
      await this.recordInvoiceAudit(client, invoice, input.changedBy);
    });

    const client = this.clientFactory(credentials, authCuit, this.afipCredentialsRepo);
    const issued = await this.issue(client, invoice, afipRequest, credentials.environment, profile.afipSalesPoint);

    // A diferencia del camino per-reservation (issue()/finalizeIssued()
    // cierra el gap solo, ver ahí), acá son N filas -- se marcan todas
    // explícitamente. Best-effort (try/catch por fila): un fallo acá no
    // debe hacer parecer que la factura -- ya real, ya con CAE -- falló.
    if (issued.status === 'ISSUED') {
      const invoiceRef = `${String(issued.ptoVta).padStart(4, '0')}-${String(issued.cbteNro).padStart(8, '0')}`;
      for (const ar of pending) {
        try {
          await this.accountsReceivableRepo.markInvoiced(ar.id, invoiceRef);
        } catch (err) {
          logger.error(
            { accountsReceivableId: ar.id, invoiceId: issued.id, err: errMessage(err) },
            '[InvoiceService] no se pudo marcar accounts_receivable como FACTURADO tras emitir la consolidada',
          );
        }
      }
    }

    return issued;
  }

  /** D8-Nivel B, factorizado para C1-Fase C -- mismo cómputo, ahora reusado por requestInvoice() y requestConsolidatedInvoice() (R14). */
  private buildIvaBreakdown(
    items: CreateInvoiceItemInput[],
    profile: Pick<BusinessProfile, 'pricesIncludeIva' | 'afipSalesPoint'>,
    buyer: Buyer,
    concepto: number,
  ): { impNeto: number; impIva: number; impTotal: number; afipRequest: Record<string, unknown> } {
    const groups = new Map<number, number>();
    for (const item of items) {
      groups.set(item.ivaRate, (groups.get(item.ivaRate) ?? 0) + item.subtotal);
    }
    const splits = [...groups.entries()].map(([rate, amount]) => ({
      ...this.splitAmount(amount, profile.pricesIncludeIva, rate),
      rate,
    }));
    const impNeto  = round2(splits.reduce((sum, s) => sum + s.impNeto, 0));
    const impIva   = round2(splits.reduce((sum, s) => sum + s.impIva, 0));
    const impTotal = round2(splits.reduce((sum, s) => sum + s.impTotal, 0));

    const cbteFch = toAfipDate(new Date());

    // AlicIva.Id por grupo con IVA > 0 -- un grupo en 0% no se informa acá
    // (mismo criterio que antes de D8: `Iva[]` completo se omite si
    // impIva=0, ver el comentario 10018/1146 de referencia-afip-wsfev1.md:
    // con ImpIVA=0 solo puede informarse Id=3).
    const ivaEntries = splits
      .filter((s) => s.impIva > 0)
      .map((s) => ({ Id: resolveIvaAlicuotaId(s.rate), BaseImp: s.impNeto, Importe: s.impIva }));

    const afipRequest = {
      CantReg: 1,
      PtoVta: profile.afipSalesPoint,
      CbteTipo: CBTE_TIPO_FACTURA_B,
      Concepto: concepto,
      DocTipo: buyer.docTipo,
      DocNro: Number(buyer.docNro),
      CbteFch: cbteFch,
      ImpTotal: impTotal,
      ImpTotConc: 0,
      ImpNeto: impNeto,
      ImpOpEx: 0,
      ImpIVA: impIva,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      CondicionIVAReceptorId: buyer.condicionIvaReceptorId,
      ...(concepto !== 1 && { FchServDesde: cbteFch, FchServHasta: cbteFch, FchVtoPago: cbteFch }),
      ...(ivaEntries.length > 0 && { Iva: ivaEntries }),
    };

    return { impNeto, impIva, impTotal, afipRequest };
  }

  /**
   * C2 + ADR cancelar-con-NC §3 -- arma (persiste, no emite) la Nota de
   * Crédito B para una `FinancialTransaction` `REFUND` (reserva) o
   * `ADJUSTMENT` (escape de cancelación de orden). `tx.reversedInvoiceId`
   * apunta a la factura ISSUED que corresponde corregir -- sin eso, o si
   * esa factura ya no está ISSUED, o si no es Factura B, no hay documento
   * fiscal válido contra el cual emitir (`InvoiceNotReversibleError`).
   * Maneja **exactamente una** factura origen (N2.a: la cardinalidad NC↔
   * factura es 1:1; el fan-out multi-factura y su guard viven en el
   * orquestador / B-reservas, nunca acá -- `createWithClient` no recibe
   * `charges`).
   *
   * `DocTipo`/`DocNro`/`CondicionIvaReceptorId`/`Concepto` se toman de la
   * factura ORIGINAL (R9 -- ya se congelaron ahí). El importe a revertir es
   * `abs(tx.amount)` (un `ADJUSTMENT` compensatorio lleva `amount` negativo;
   * el signo de la reversión lo pone `CbteTipo = 8`, los `imp_*` van
   * positivos -- `CHECK (imp_total >= 0)`, mismo enfoque que Odoo
   * `out_refund`).
   *
   * **Cuatro ramas según total vs. parcial vs. sujeto (corrección
   * 11/09/2026, gate `architecture-governor`, bloque 1c-ii-b -- este
   * docblock decía "Dos ramas", desactualizado desde 3.3-a):**
   * - **Total** (`abs(tx.amount) == original.impTotal`, tol ±1 centavo) **y**
   *   la factura tiene `invoice_items` → **N3**: la NC COPIA sus líneas desde
   *   `invoice_items` de la original, preservando el back-ref
   *   `order_item_id`/`reservation_id` por línea, y refleja los `imp_*` /
   *   `Iva[]` congelados de la original tal cual (factor = 1). Es la doctrina
   *   de ERPNext/Odoo (copia 1-a-1, impuestos desde las líneas, nunca factor
   *   de cabecera).
   * - **Parcial, `ADJUSTMENT` con `reservationId`** (bloque 3.3-a) → rama
   *   por-par de reserva: re-deriva el monto desde `resolveRefundableForPair()`
   *   (composición fiscal congelada, N4-a) y lo CRUZA contra `abs(tx.amount)`,
   *   copia 1-a-1 solo las líneas de esa reserva.
   * - **Parcial, `ADJUSTMENT` con `orderId`** (bloque 1c-ii-b) → rama
   *   por-par de orden, espejo estructural exacto de la anterior --
   *   `resolveRefundableForPair()` sigue siendo el mismo cálculo puro, la
   *   única diferencia es cómo se resuelve la clave de atribución por ítem
   *   (`getOrderIdsByInvoiceItemId()`, JOIN vía `order_items` porque
   *   `invoice_items` no tiene `order_id` directo).
   * - **Cualquier otro caso** (parcial sin `reservationId` ni `orderId`, o
   *   total contra una factura "Nivel A" sin `invoice_items`) → rama
   *   proporcional heredada: escala el desglose por tasa YA CONGELADO por
   *   `factor = abs(tx.amount) / original.impTotal`, una sola línea
   *   sintética. Un `ADJUSTMENT` NUNCA cae acá con `invoice_items`
   *   presentes Y un sujeto real (una orden se cancela todo-o-nada por
   *   construcción, ADR §5, y las dos ramas por-par de arriba ya capturan
   *   el caso con sujeto); si llega sin líneas se rechaza con
   *   `OrderInvoiceHasNoLinesError` (defensivo -- toda factura de orden es
   *   post-v32).
   */
  private async buildCreditNote(
    tx: FinancialTransaction,
    input: RequestInvoiceInput,
    profile: BusinessProfile,
    authCuit: string,
    credentials: AfipCredentials,
    idempotencyKey: string,
    changedBy: string,
  ): Promise<Invoice> {
    if (!tx.reversedInvoiceId) throw new InvoiceNotReversibleError(tx.id);
    // Capturado en un local -- Bloque 3 lo reusa DENTRO del closure de
    // `transactionManager.run()` más abajo, y una propiedad narrowed de un
    // parámetro no sobrevive de forma confiable el cruce a una función
    // anidada (mismo criterio ya usado en este archivo para `reservationId`/
    // `orderId` en las ramas por-par, unas líneas más abajo).
    const reversedInvoiceId = tx.reversedInvoiceId;
    const original = await this.invoiceRepo.getById(reversedInvoiceId);
    if (!original || original.status !== 'ISSUED' || !original.cbteNro) {
      throw new InvoiceNotReversibleError(tx.id);
    }
    // F-A (05/09/2026, architecture-governor) -- defensa en profundidad,
    // segunda capa además del filtro de CancellationRefundService.confirmRefund().
    // `original` puede ser CUALQUIER factura ISSUED, incluida otra Nota de
    // Crédito (se persisten en esta misma tabla) -- sin este chequeo, una
    // NC apuntando a `reversedInvoiceId` de OTRA NC pasaría igual: el
    // `CbtesAsoc` resultante quedaría con `Tipo: CBTE_TIPO_NOTA_CREDITO_B`
    // en vez de `Tipo: CBTE_TIPO_FACTURA_B`, un comprobante fiscal
    // malformado. Solo Factura B es reversible.
    if (original.cbteTipo !== CBTE_TIPO_FACTURA_B) {
      throw new InvoiceNotReversibleError(tx.id);
    }

    // Un ADJUSTMENT lleva `amount` negativo; el importe de la NC es positivo.
    const amountToReverse = round2(Math.abs(tx.amount));
    const originalItems = await this.invoiceRepo.getItemsByInvoiceId(original.id);
    const isFullReversal =
      Math.abs(round2(amountToReverse - original.impTotal)) <= CREDIT_NOTE_COMPENSATION_TOLERANCE;

    // 1c-ii-b (11/09/2026, gate `architecture-governor`, condición C2,
    // grounding `auditor-circuitos-erp`) -- invariante de LECTURA: rechaza
    // ATRIBUIR una NC a una fila con `order_id` Y `reservation_id`
    // no-nulos a la vez, ANTES de cualquier rama, para no depender de una
    // precedencia de código implícita (¿reserva gana? ¿orden?) ni de que
    // el guard de monto de más abajo (`CreditNoteAttributionMismatchError`)
    // la tape por casualidad cuando los importes coinciden. Sin restringir
    // por `tx.type`/`isFullReversal` a propósito -- es un hecho sobre la
    // FILA, no sobre qué rama la usa.
    // Desde schema v50 (12/09/2026, caso 6 de
    // docs/investigacion-decisiones-bloqueado-2026-09-12.md) la PRODUCCIÓN
    // de esta fila también está cerrada a nivel de BD --
    // `chk_financial_transactions_order_or_reservation` en
    // `financial_transactions` (schema.sql). Este guard de acá NO se
    // retira: el CHECK cubre la escritura, este guard sigue siendo la
    // barrera de lectura -- dos momentos distintos, no la misma regla
    // duplicada.
    if (tx.orderId != null && tx.reservationId != null) {
      throw new CreditNoteAmbiguousSubjectError(tx.id, tx.orderId, tx.reservationId);
    }

    let items: CreateInvoiceItemInput[];
    let ivaEntries: Array<{ Id: number; BaseImp: number; Importe: number }>;
    let impNeto: number;
    let impIva: number;
    let impTotal: number;
    // Bloque 3.3-a (08/09/2026) -- distinto de null solo en la rama nueva de
    // abajo (ADJUSTMENT parcial atribuido a UNA reserva de una consolidada).
    // El tope global (N5) ya corre para TODAS las ramas; este es el tope
    // ADICIONAL por par, que sólo tiene sentido cuando hubo una atribución
    // por reserva que proteger.
    // 1c-ii-a (11/09/2026, gate `architecture-governor`) -- `subject`
    // generalizado de `reservationId: string` a un discriminador cerrado,
    // espejo del que ganó `getInFlightCreditNoteTotalForPairForUpdate()`
    // (`invoice.repository.ts`). 1c-ii-b (11/09/2026) cableó el consumidor
    // de `kind: 'ORDER'` -- dos ramas por-par ahora, reserva y orden, ver
    // más abajo.
    let pairAttribution: { subject: { kind: 'RESERVATION' | 'ORDER'; id: string }; attributedTotal: number } | null = null;

    if (isFullReversal && originalItems.length > 0) {
      // --- N3: reversión total con detalle de líneas -> copiar 1-a-1 ---
      // (función pura compartida con el test de integración -- no divergen).
      items = creditNoteLinesFromInvoiceItems(originalItems);
      // Reversión total -> el desglose congelado de la factura ES el de la NC.
      ivaEntries = (
        (original.afipRequest as { Iva?: Array<{ Id: number; BaseImp: number; Importe: number }> } | null)?.Iva ?? []
      ).map((e) => ({ Id: e.Id, BaseImp: e.BaseImp, Importe: e.Importe }));
      impNeto = original.impNeto;
      impIva = original.impIva;
      impTotal = original.impTotal;
      // Observabilidad (A9): la NC refleja tal cual la cabecera y las líneas
      // YA CONGELADAS de la original -- son consistentes por definición salvo
      // que la factura original ya estuviera descuadrada (líneas editadas
      // aparte de su total, lo que R12 prohíbe). Dos chequeos, warn (no throw:
      // la NC revierte EXACTAMENTE lo facturado; un throw dejaría la orden
      // trabada sobre una corrupción preexistente de la original):
      //  1. Según `pricesIncludeIva` de cuando se facturó, `Σ subtotal` cierra
      //     con `impNeto` (precios netos) o con `impTotal` (precios con IVA);
      //     si no cierra con NINGUNO, síntoma de descuadre en la origen.
      //     (Puede dar falso positivo en facturas de muchas líneas por drift
      //     acumulado de `round2` -- ver runbook.)
      //  2. Si la original tiene `impIva > 0` pero `afipRequest.Iva` vacío/
      //     ausente, la NC saldría a AFIP con `ImpIVA > 0` y sin `Iva[]` --
      //     comprobante malformado.
      const lineSum = round2(items.reduce((s, it) => s + it.subtotal, 0));
      const closesWithNeto = Math.abs(round2(lineSum - impNeto)) <= CREDIT_NOTE_COMPENSATION_TOLERANCE;
      const closesWithTotal = Math.abs(round2(lineSum - impTotal)) <= CREDIT_NOTE_COMPENSATION_TOLERANCE;
      if (!closesWithNeto && !closesWithTotal) {
        logger.warn(
          { invoiceId: original.id, lineSum, impNeto, impTotal, financialTransactionId: tx.id },
          '[buildCreditNote] las líneas de la factura origen no cierran con su neto ni con su total -- posible descuadre en la factura original, la NC lo refleja igual',
        );
      }
      if (impIva !== 0 && ivaEntries.length === 0) {
        logger.warn(
          { invoiceId: original.id, impIva, financialTransactionId: tx.id },
          '[buildCreditNote] la factura origen tiene impIva > 0 pero afipRequest.Iva vacío -- la NC podría salir a AFIP sin desglose de IVA',
        );
      }
    } else if (tx.type === 'ADJUSTMENT' && tx.reservationId != null && originalItems.length > 0) {
      // --- Bloque 3.3-a (08/09/2026, gate `architecture-governor`) ---
      // Reversión PARCIAL de una factura consolidada, atribuida a UNA
      // reserva puntual (subcaso 2 de B-reservas, `resolveRefundableForPair()`
      // / N4-a). Predicado ESTRUCTURAL, no un flag del caller: llega acá
      // solo un ADJUSTMENT con reserva, no total, con líneas. Desde
      // 1c-ii-b, un ADJUSTMENT de ORDEN (sin `reservationId` -- el guard de
      // ambigüedad de más arriba ya descartó que tenga los dos) cae a la
      // rama espejo de abajo, no acá ni a la rama proporcional heredada.
      //
      // El monto NUNCA sale de `tx.amount` hacia un cálculo propio -- se
      // RE-DERIVA acá desde la composición fiscal congelada de la factura
      // (`invoice_items` + `afip_request.Iva[]`, vía N4-a) y `abs(tx.amount)`
      // solo se CRUZA contra ese resultado. Es lo que evita el doble
      // prorrateo que tendría escalar `factor = tx.amount / original.impTotal`
      // (la rama proporcional heredada) sobre un monto que YA es la
      // porción de una reserva: ese factor divide por el total de la
      // FACTURA ENTERA, un segundo denominador distinto del que usó N4-a.
      const reservationId = tx.reservationId;
      const shareItems: FrozenInvoiceItemShare[] = originalItems.map((i) => ({
        attributionKey: i.reservationId, subtotal: i.subtotal, ivaRate: i.ivaRate,
      }));
      const frozenIva = (
        (original.afipRequest as { Iva?: Array<{ Id: number; BaseImp: number; Importe: number }> } | null)?.Iva ?? []
      ).map((e) => ({ id: e.Id, baseImp: e.BaseImp, importe: e.Importe }));
      const attribution = resolveRefundableForPair({
        items: shareItems, frozenIva, alreadyRefunded: 0, attributionKey: reservationId,
      });
      if (attribution.kind === 'BLOCKED') {
        throw new CreditNoteAttributionBlockedError(original.id, reservationId, attribution.reason, attribution.detail);
      }
      if (Math.abs(round2(amountToReverse - attribution.attributedTotal)) > CREDIT_NOTE_COMPENSATION_TOLERANCE) {
        throw new CreditNoteAttributionMismatchError(original.id, reservationId, amountToReverse, attribution.attributedTotal);
      }
      // N3 aplicado a la PORCIÓN -- copia 1-a-1, no una línea sintética.
      items = creditNoteLinesFromInvoiceItems(originalItems.filter((i) => i.reservationId === reservationId));
      ivaEntries = attribution.ivaBreakdown.map((e) => ({ Id: e.id, BaseImp: e.baseImp, Importe: e.importe }));
      impNeto = attribution.attributedNeto;
      impIva = attribution.attributedIva;
      impTotal = attribution.attributedTotal;
      pairAttribution = { subject: { kind: 'RESERVATION', id: reservationId }, attributedTotal: attribution.attributedTotal };
    } else if (tx.type === 'ADJUSTMENT' && tx.orderId != null && originalItems.length > 0) {
      // --- Bloque 1c-ii-b (11/09/2026, gate `architecture-governor`) ---
      // Espejo estructural EXACTO de la rama de reservas de arriba, ahora
      // para órdenes -- mismo predicado (ADJUSTMENT, sujeto no-nulo, con
      // líneas), mismo mecanismo (`resolveRefundableForPair()`, N4-a/1a),
      // mismo cruce de monto, misma copia 1-a-1 de la porción. Lo único
      // que cambia es CÓMO se resuelve la clave de atribución por ítem:
      // `invoice_items` no tiene `order_id` directo (solo
      // `order_item_id`), así que hace falta el JOIN intermedio a
      // `order_items` -- `getOrderIdsByInvoiceItemId()` (condición C1 del
      // gate: lectura inline vía `this.invoiceRepo`, FUERA del lock, igual
      // que `originalItems` ya resuelve arriba -- no
      // `resolveOrderPairAttribution()`, que exige un `client` abierto y
      // queda parkeada, ver su propio docblock).
      //
      // `orderIdMap.get(i.id) ?? null` sobre TODOS los `originalItems` --
      // nunca un `.filter()` antes de mapear: las líneas que NO son de
      // esta orden (otra orden, o una reserva, en la misma consolidada)
      // tienen que seguir apareciendo con clave `null` para el
      // denominador de cada grupo de tasa (`distributeGroupAmount()`) --
      // filtrarlas acá reproduciría, invertido, `REFUND-ATTRIBUTION-RESIDUAL-001`.
      const orderId = tx.orderId;
      const orderIdMap = await this.invoiceRepo.getOrderIdsByInvoiceItemId(original.id);
      const shareItems: FrozenInvoiceItemShare[] = originalItems.map((i) => ({
        attributionKey: orderIdMap.get(i.id) ?? null, subtotal: i.subtotal, ivaRate: i.ivaRate,
      }));
      const frozenIva = (
        (original.afipRequest as { Iva?: Array<{ Id: number; BaseImp: number; Importe: number }> } | null)?.Iva ?? []
      ).map((e) => ({ id: e.Id, baseImp: e.BaseImp, importe: e.Importe }));
      const attribution = resolveRefundableForPair({
        items: shareItems, frozenIva, alreadyRefunded: 0, attributionKey: orderId,
      });
      if (attribution.kind === 'BLOCKED') {
        throw new CreditNoteAttributionBlockedError(original.id, orderId, attribution.reason, attribution.detail);
      }
      if (Math.abs(round2(amountToReverse - attribution.attributedTotal)) > CREDIT_NOTE_COMPENSATION_TOLERANCE) {
        throw new CreditNoteAttributionMismatchError(original.id, orderId, amountToReverse, attribution.attributedTotal);
      }
      // N3 aplicado a la PORCIÓN -- copia 1-a-1, SOLO las líneas de esta orden.
      items = creditNoteLinesFromInvoiceItems(originalItems.filter((i) => orderIdMap.get(i.id) === orderId));
      ivaEntries = attribution.ivaBreakdown.map((e) => ({ Id: e.id, BaseImp: e.baseImp, Importe: e.importe }));
      impNeto = attribution.attributedNeto;
      impIva = attribution.attributedIva;
      impTotal = attribution.attributedTotal;
      pairAttribution = { subject: { kind: 'ORDER', id: orderId }, attributedTotal: attribution.attributedTotal };
    } else {
      // --- Rama proporcional heredada (parcial, o total Nivel A) ---
      if (tx.type === 'ADJUSTMENT') {
        // Una orden (o una reserva, ADR §5/3.3-a) se cancela todo-o-nada
        // salvo que exista atribución por-par -- las dos ramas de arriba
        // (reserva, orden) ya capturan TODO ADJUSTMENT parcial con
        // `originalItems.length > 0` y un sujeto real (`reservationId` o
        // `orderId`, el guard de ambigüedad del tope de la función
        // descarta que tenga los dos). Si un ADJUSTMENT llega ACÁ es
        // porque (a) la factura no tiene `invoice_items` (Nivel A, con
        // CUALQUIER sujeto o sin ninguno -- `OrderInvoiceHasNoLinesError`
        // sigue mal nombrado para el caso reserva, deuda preexistente sin
        // bloque asignado, no introducida por 1c-ii-b), o (b) es parcial
        // Y no tiene NINGÚN sujeto (`orderId`/`reservationId` ambos
        // `null`) -- una fila de ledger anómala, no un caso de negocio
        // esperado.
        if (originalItems.length === 0) {
          throw new OrderInvoiceHasNoLinesError(original.id, tx.id);
        }
        throw new Error(
          `[buildCreditNote] un ADJUSTMENT parcial sin orderId ni reservationId no tiene sujeto de atribución (N1.a); ` +
          `llegó abs(amount)=${amountToReverse} contra impTotal=${original.impTotal}`,
        );
      }
      const factor = original.impTotal > 0 ? amountToReverse / original.impTotal : 0;
      const originalIva =
        (original.afipRequest as { Iva?: Array<{ Id: number; BaseImp: number; Importe: number }> } | null)?.Iva ?? [];
      ivaEntries = originalIva.map((entry) => ({
        Id: entry.Id,
        BaseImp: round2(entry.BaseImp * factor),
        Importe: round2(entry.Importe * factor),
      }));
      impIva = round2(ivaEntries.reduce((sum, entry) => sum + entry.Importe, 0));
      impTotal = round2(amountToReverse);
      impNeto = round2(impTotal - impIva);
      const effectiveIvaRate = impNeto > 0 ? round2((impIva / impNeto) * 100) : 0;
      items = [{
        orderItemId: null,
        reservationId: tx.reservationId ?? null,
        description: 'Nota de crédito -- cancelación de reserva',
        quantity: 1,
        unitPrice: amountToReverse,
        subtotal: amountToReverse,
        ivaRate: effectiveIvaRate,
        unit: null,
        arcaUnitCode: null,
      }];
    }

    const invoiceId = randomUUID();
    const cbteFch = toAfipDate(new Date());

    const afipRequest = {
      CantReg: 1,
      PtoVta: profile.afipSalesPoint,
      CbteTipo: CBTE_TIPO_NOTA_CREDITO_B,
      Concepto: original.concepto,
      DocTipo: original.docTipo,
      DocNro: Number(original.docNro),
      CbteFch: cbteFch,
      ImpTotal: impTotal,
      ImpTotConc: 0,
      ImpNeto: impNeto,
      ImpOpEx: 0,
      ImpIVA: impIva,
      ImpTrib: 0,
      MonId: 'PES',
      MonCotiz: 1,
      CondicionIVAReceptorId: original.condicionIvaReceptorId,
      CbtesAsoc: [{ Tipo: original.cbteTipo, PtoVta: original.ptoVta, Nro: original.cbteNro }],
      ...(original.concepto !== 1 && { FchServDesde: cbteFch, FchServHasta: cbteFch, FchVtoPago: cbteFch }),
      ...(ivaEntries.length > 0 && { Iva: ivaEntries }),
    };

    let invoice!: Invoice;
    await this.transactionManager.run(async (client: SqlClient) => {
      // Bloque 2.4 (tope N5, gate `architecture-governor` 08/09/2026) --
      // lockea `original` (la factura que se está revirtiendo) ANTES de
      // insertar la NC nueva, y suma lo que ya está en vuelo contra ella
      // (ISSUED/PENDING/FAILED_UNCERTAIN, ver docblock del método del
      // repositorio para el bypass declarado de `retryExisting()` -- C1 del
      // gate -- y la nota C3 sobre un duplicado de idempotencia concurrente).
      // Nunca clamp (N5): si excede, se LANZA, no se recorta el monto.
      const inFlight = await this.invoiceRepo.getInFlightCreditNoteTotalForUpdate(client, original.id);
      const projected = round2(inFlight + impTotal);
      if (projected > round2(original.impTotal + CREDIT_NOTE_COMPENSATION_TOLERANCE)) {
        throw new CreditNoteCapExceededError(original.id, tx.id, impTotal, inFlight, original.impTotal);
      }

      // Bloque 3.3-a (08/09/2026) -- tope ADICIONAL por par (invoiceId,
      // reservationId), sólo cuando esta NC es la porción de una reserva
      // dentro de una consolidada (rama nueva de arriba). Convive con el
      // tope global de arriba, no lo reemplaza: una consolidada puede tener
      // cupo global de sobra y aun así dejar que UNA reserva se lleve más
      // de lo que le corresponde. Toma su PROPIO `FOR UPDATE` sobre la
      // MISMA fila que la sentencia de arriba (corrección del gate del
      // 08/09/2026 en sql.invoice.repository.ts, ver docblock ahí -- ya NO
      // depende de que el caller haya lockeado antes). Es un re-lock
      // same-tx: Postgres lo concede de inmediato, sin esperar (LOCK-ORDER-001,
      // gate architecture-governor 09/09/2026 -- por eso este archivo entra
      // a SINGLE_INVOICE_CALLERS, no a MULTI: nunca se sostienen dos filas
      // de invoices PREEXISTENTES distintas a la vez).
      if (pairAttribution) {
        const pairInFlight = await this.invoiceRepo.getInFlightCreditNoteTotalForPairForUpdate(
          client, original.id, pairAttribution.subject,
        );
        const pairProjected = round2(pairInFlight + impTotal);
        if (pairProjected > round2(pairAttribution.attributedTotal + CREDIT_NOTE_COMPENSATION_TOLERANCE)) {
          throw new CreditNotePairCapExceededError(
            original.id, pairAttribution.subject.id, tx.id, impTotal, pairInFlight, pairAttribution.attributedTotal,
          );
        }
      }

      invoice = await this.invoiceRepo.createWithClient(
        client,
        {
          id: invoiceId,
          businessId: input.businessId,
          financialTransactionId: input.financialTransactionId,
          customerId: tx.customerId,
          idempotencyKey,
          environment: credentials.environment,
          ptoVta: profile.afipSalesPoint!,
          cbteTipo: CBTE_TIPO_NOTA_CREDITO_B,
          emisorCuit: authCuit,
          concepto: original.concepto,
          docTipo: original.docTipo,
          docNro: original.docNro,
          condicionIvaReceptorId: original.condicionIvaReceptorId,
          moneda: 'PES',
          impNeto,
          impIva,
          impTotal,
          paymentMethod: tx.paymentMethod ?? null,
          cardInstallments: tx.cardInstallments ?? null,
        },
        afipRequest,
        items,
      );
      await this.recordInvoiceAudit(client, invoice, changedBy);

      // Bloque 3 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis
      // corregido) -- la fila `credit_note_request` nace acá, EN LA MISMA
      // transacción que la factura de arriba (atomic-state-mutation: un
      // solo commit, un fallo a mitad de camino no puede dejar una factura
      // sin su fila de solicitud asociada, ni viceversa). Gateado por
      // `tx.type === 'ADJUSTMENT'` -- NUNCA para `REFUND`
      // (`CancellationRefundService.confirmRefund()` también llega hasta
      // acá con `type: 'REFUND'`, flujo C2 normal, sin escape de por
      // medio; sin este filtro se crearían filas espurias para reembolsos
      // que no son el escape fiscal).
      if (tx.type === 'ADJUSTMENT') {
        // El guard de ambigüedad de más arriba (`tx.orderId != null &&
        // tx.reservationId != null` -> `CreditNoteAmbiguousSubjectError`) ya
        // descartó "los dos". Los dos únicos productores reales de un
        // ADJUSTMENT con `reversedInvoiceId` puesto (los orquestadores del
        // escape, `cancel-order-with-credit-note.service.ts`/
        // `cancel-reservation-with-credit-note.service.ts`) siempre setean
        // exactamente uno -- pero `credit_note_request` tiene su PROPIO
        // CHECK "= 1" (`chk_credit_note_request_order_or_reservation`), más
        // estricto que el "<= 1" de `financial_transactions` (que sí admite
        // los dos en null, ver p.ej. `accounts-receivable.service.ts`
        // reverseTransfer(), que nunca llega hasta acá porque esas filas
        // llevan `reversedInvoiceId: null`). Falla ruidoso acá -- con un
        // error tipado que nombra el `tx.id` -- en vez de dejar que un
        // futuro tercer productor de ADJUSTMENT-con-reversedInvoiceId
        // rebote contra un CHECK de Postgres genérico.
        let subject: CreditNoteRequestSubject;
        if (tx.orderId != null) {
          subject = { kind: 'ORDER', id: tx.orderId };
        } else if (tx.reservationId != null) {
          subject = { kind: 'RESERVATION', id: tx.reservationId };
        } else {
          throw new Error(
            `[buildCreditNote] ADJUSTMENT ${tx.id} sin orderId ni reservationId al crear credit_note_request -- ` +
            `no debería pasar (el guard de ambigüedad y las ramas de arriba ya exigen exactamente un sujeto real).`,
          );
        }
        await this.creditNoteRequestRepo.createWithClient(client, {
          id: randomUUID(),
          businessId: input.businessId,
          invoiceId: invoice.id,
          reversedInvoiceId,
          subject,
        });
      }
    });

    return invoice;
  }

  /**
   * Un `requestInvoice()` que pega contra un comprobante que ya existe
   * (mismo `financial_transaction_id`, misma fila por el idempotency_key
   * determinístico) reintenta o no según qué tan seguro sea:
   *
   * - ISSUED: ya tiene CAE real de AFIP, nunca se vuelve a tocar.
   * - FAILED_UNCERTAIN con `afipContacted=true` y SIN `uncertainClearedAt`:
   *   AFIP fue contactado y no se pudo confirmar qué pasó (A8.6) --
   *   reintentar a ciegas podría duplicar un comprobante fiscal real. Se
   *   devuelve tal cual, requiere revisión manual (contra
   *   FECompUltimoAutorizado/getVoucherInfo) antes de habilitar un
   *   reintento.
   * - FAILED_UNCERTAIN con `afipContacted=true` pero CON `uncertainClearedAt`
   *   poblado: Bloque 5 (15/09/2026, §6.5 bis, pregunta de negocio 1, opción
   *   (b)) -- un operador ya revisó contra AFIP a mano, confirmó
   *   `outcome: 'NO_EMITIDA'` (no hay CAE real) vía `POST
   *   /api/credit-note-requests/:id/resolve`, y `resolveCreditNoteRequestManually()`
   *   desbloqueó la factura (`markUncertainClearedWithClient()`). Esto SÍ
   *   reintenta -- ya no es la misma incertidumbre que el guard de arriba
   *   protege, un humano la resolvió.
   * - El resto (PENDING, REJECTED, o FAILED_UNCERTAIN con
   *   `afipContacted=false`): se sabe con certeza que no quedó nada
   *   emitido, reintento seguro reusando la MISMA fila y el MISMO
   *   `afipRequest` ya persistido (no se recalcula nada del cobro de
   *   nuevo -- ver R12, una transacción confirmada no se edita).
   *
   * `WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001` (23/09/2026, gate
   * `architecture-governor`, ronda 2, `docs/pendientes-2026-09-12.md`) --
   * antes de re-chequear AR-REVERTIDO/orden-o-reserva-CANCELLED
   * (`assertChargesStillInvoiceable()`, más abajo), este método TAMBIÉN
   * re-chequea que ningún OTRO comprobante vivo (por el otro camino de
   * emisión) haya empezado a cubrir el mismo cargo desde la primera vez --
   * `assertNoOtherLiveInvoiceForCharges()`, corre PRIMERO (decisión del
   * dueño, AskUserQuestion, 23/09/2026: "re-chequea y bloquea"). Cierra la
   * cuarta dirección del agujero de doble comprobante: una consolidada
   * `REJECTED` deja un cargo facturable individual (a propósito, ver
   * `INVOICE_STATUSES_CONSUMING_CHARGE`); si mientras tanto ese cargo ya
   * tiene una factura individual PENDING/ISSUED/FAILED_UNCERTAIN, un
   * reintento de la consolidada (que recalcula el mismo hash y entra por
   * acá) no puede seguir de largo y emitir un segundo CAE real sobre el
   * mismo cargo -- y simétricamente para el camino individual.
   *
   * ADR `ISSUE-BEFORE-REVERSE-WINDOW-001`, Bloque 2c, §3.2/§3.16 (23/09/2026,
   * gate `architecture-governor`, ronda 15-bis) -- DESPUÉS de
   * `assertChargesStillInvoiceable()` (cuando `chargeTxs.length > 0`), este
   * método toma la marca "en vuelo" (`invoiceRepo.takeRetryClaimWithClient()`)
   * sobre la PROPIA fila, en la MISMA transacción: es la única protección
   * real contra dos `retryExisting()` concurrentes sobre la misma factura
   * (doble click) -- el `UPDATE ... RETURNING` condicionado es a la vez el
   * lock y la toma, así que el segundo en llegar no encuentra fila para
   * actualizar y se rechaza con `RetryInvoiceInFlightError` (409) sin haber
   * llamado a AFIP.
   *
   * Bloque 5 (§3.11, 23/09/2026, gate `architecture-governor`, ronda 17) --
   * la toma exclusiva también cubre el camino de NC pura (`REFUND`/
   * `ADJUSTMENT`, sin ningún `CHARGE` en el lote): el `else` del
   * `if (chargeTxs.length > 0)` de abajo llama al MISMO
   * `takeRetryClaimWithClient()`, en su propia `transactionManager.run()`,
   * SIN los guards CHARGE-only (`assertNoOtherLiveInvoiceForCharges()`,
   * `assertChargesStillInvoiceable()` -- exención ya congelada por
   * `NC_PRODUCERS_SAFE_FOR_RETRY_TYPE_SHORTCUT`,
   * `docs/diseno-invoice-retry-charge-guard-2026-09-18.md`). Un solo lock
   * (la propia fila `invoices`) por rama -- no hay AR/orden/reserva
   * involucrados en la rama NC, así que no hay ABBA que ordenar ahí (por
   * eso `AR-INVOICE-LOCK-ORDER-001` y `LOCK-ORDER-001` no necesitaron
   * actualizarse para este bloque).
   */
  private async retryExisting(existing: Invoice): Promise<Invoice> {
    if (existing.status === 'ISSUED') return existing;
    if (existing.status === 'FAILED_UNCERTAIN' && existing.afipContacted && !existing.uncertainClearedAt) return existing;

    // CHARGE-STATE-GUARD-001 (Wave 13, Zona 2, 21/09/2026, gate
    // `architecture-governor`, docs/diseno-invoice-retry-charge-guard-2026-09-18.md)
    // -- re-valida, antes de reintentar, que el estado que el guard
    // ORIGINAL de la primera vez protegía (AR-REVERTIDO, orden/reserva
    // CANCELLED) sigue siendo válido. `retryExisting()` nunca corre dentro
    // de la tx de un caller (verificado: los 6 call-sites de producción --
    // `cancel-order-with-credit-note.service.ts:253,565`,
    // `cancel-reservation-with-credit-note.service.ts:299,573`,
    // `invoices.routes.ts:206,231` -- ninguno abre transacción antes de
    // llegar acá), así que el `transactionManager.run()` de abajo es
    // siempre la única transacción de la operación.
    const txs = existing.financialTransactionId
      ? [await this.requireFinancialTransaction(existing.financialTransactionId)]
      : await this.loadChargesForConsolidatedInvoice(existing.id);
    const chargeTxs = txs.filter((tx) => tx.type === 'CHARGE');
    if (chargeTxs.length > 0) {
      // DUPLICATE-CAE-001 -- ANTES de assertChargesStillInvoiceable() a
      // propósito (gate, ronda 2, condición de precedencia): si un cargo
      // tiene A LA VEZ un vínculo vivo en otro comprobante Y su AR está
      // REVERTIDO, el guard nuevo tiene que ganar -- el error correcto acá
      // es "ya facturado por otra vía", no "AR revertida" (los dos son
      // ciertos, pero solo uno describe la causa real de por qué este
      // reintento no puede proceder).
      await this.assertNoOtherLiveInvoiceForCharges(existing, chargeTxs);
      // ADR ISSUE-BEFORE-REVERSE-WINDOW-001, Bloque 2c, §3.2/§3.16 (23/09/2026,
      // gate `architecture-governor`, ronda 15-bis) -- la toma exclusiva de
      // la factura (`takeRetryClaimWithClient()`) corre DENTRO de la MISMA
      // transacción que `assertChargesStillInvoiceable()`, DESPUÉS de ella:
      // cuarto eslabón del orden AR→órdenes→reservas (sin cambios, ya
      // aprobado e implementado dentro de assertChargesStillInvoiceable())
      // →factura-propia. Nunca "adyacente" en una transacción separada --
      // ver §3.2 del ADR para por qué eso dejaría una ventana contra
      // `reverseTransfer()`. El orden de los dos `await` de abajo es
      // load-bearing y está congelado por
      // `AR-INVOICE-LOCK-ORDER-001` (`src/tests/architecture/invoice-ar-cross-lock-order.test.ts`).
      await this.transactionManager.run(async (client) => {
        await this.assertChargesStillInvoiceable(client, chargeTxs);
        await this.invoiceRepo.takeRetryClaimWithClient(client, existing.id);
      });
    } else {
      // Bloque 5 (§3.11) -- NC pura (REFUND/ADJUSTMENT), mismo mecanismo de
      // toma exclusiva, sin los guards CHARGE-only (ver más abajo por qué no
      // aplican acá).
      await this.transactionManager.run((client) => this.invoiceRepo.takeRetryClaimWithClient(client, existing.id));
    }

    const credentials = await this.afipCredentialsRepo.getDecrypted();
    if (!credentials) throw new AfipNotConfiguredError('falta cargar el certificado AFIP en Mi Negocio');
    const profile = await this.businessProfileRepo.get();
    const authCuit = profile.afipCuit ?? profile.taxId;
    if (!authCuit) throw new AfipNotConfiguredError('falta cargar el CUIT del negocio en Mi Negocio');

    const client = this.clientFactory(credentials, authCuit, this.afipCredentialsRepo);
    return this.issue(
      client,
      existing,
      existing.afipRequest as Record<string, unknown>,
      existing.environment,
      existing.ptoVta,
    );
  }

  /**
   * `WAVE13-ZONA2-CONSOLIDATED-RETRY-DUPLICATE-CAE-001` -- ver el docblock
   * de `retryExisting()` de arriba para el porqué y la precedencia. Este
   * helper solo decide QUÉ error tipado lanzar, con la selección exacta
   * verificada por el gate: `existing.financialTransactionId != null`
   * distingue el camino individual (siempre 1 `chargeTx`, id ===
   * `existing.financialTransactionId`) del consolidado (`existing.customerId`
   * es el `companyCustomerId` -- `createWithClient()` lo carga desde
   * `input.companyCustomerId`, campo que no admite `null`). Nunca lanza
   * para una NC (`REFUND`/`ADJUSTMENT`) -- `chargeTxs` ya viene filtrado a
   * `CHARGE` por el caller, y una NC individual nunca entra a este bloque
   * (su `existing.financialTransactionId` apunta al REFUND/ADJUSTMENT que
   * revierte, no a un CHARGE -- `chargeTxs` queda vacío, el caller ni
   * siquiera llama a este método).
   */
  private async assertNoOtherLiveInvoiceForCharges(existing: Invoice, chargeTxs: FinancialTransaction[]): Promise<void> {
    const otherLinks = await this.invoiceRepo.getOtherLiveInvoiceLinksForCharges(
      chargeTxs.map((tx) => tx.id),
      existing.id,
    );
    if (otherLinks.size === 0) return;

    if (existing.financialTransactionId != null) {
      const otherInvoiceId = otherLinks.get(existing.financialTransactionId);
      if (otherInvoiceId) {
        throw new InvoiceAlreadyLinkedByOtherPathError(existing.financialTransactionId, otherInvoiceId);
      }
      return;
    }

    throw new AccountsReceivableAlreadyInvoicedError(existing.customerId, [...otherLinks.keys()]);
  }

  /**
   * Corrección (gate de pre-commit, ronda 2, Wave 13, Zona 2): este
   * docblock decía "extraído porque ahora tiene 2 call-sites (el fresco y
   * `retryExisting()`)" -- falso, los caminos frescos (`requestInvoice()`,
   * `requestConsolidatedInvoice()`) mantienen su propia copia inline del
   * mismo `getById()` + `FinancialTransactionNotFoundError`, a propósito
   * (alcance congelado por el diseño, docs/diseno-invoice-retry-charge-guard-2026-09-18.md
   * §3 -- no refactorizar código ya verificado). Los 2 call-sites reales de
   * este helper son `retryExisting()` y `loadChargesForConsolidatedInvoice()`,
   * ambos nuevos de esta Wave.
   */
  private async requireFinancialTransaction(financialTransactionId: string): Promise<FinancialTransaction> {
    const tx = await this.financialTransactionRepo.getById(financialTransactionId);
    if (!tx) throw new FinancialTransactionNotFoundError(financialTransactionId);
    return tx;
  }

  /**
   * Una consolidada no tiene "la fila" -- `createWithClient()` la crea con
   * `financialTransactionId: null` (ver el bloque de
   * `requestConsolidatedInvoice()` que arma el `CreateInvoiceInput`), sus N
   * cargos viven en `invoice_charges`. Fail-loud si
   * el invariante "toda consolidada tiene ≥1 cargo" se rompe (honest-degradation)
   * -- una consolidada real siempre se crea a partir de ≥1 AR `pending`.
   */
  private async loadChargesForConsolidatedInvoice(invoiceId: string): Promise<FinancialTransaction[]> {
    const chargeIds = await this.invoiceRepo.getChargeIdsForInvoice(invoiceId);
    if (chargeIds.length === 0) {
      throw new Error(
        `retryExisting(): la factura consolidada "${invoiceId}" no tiene ningún cargo en invoice_charges -- invariante roto (toda consolidada se crea con ≥1 AR pendiente).`,
      );
    }
    return Promise.all(chargeIds.map((id) => this.requireFinancialTransaction(id)));
  }

  /**
   * CHARGE-STATE-GUARD-001 -- ver docblock de `retryExisting()`. Re-valida
   * AR-REVERTIDO + ORDER-10/RESERVA-10 para cargos CHARGE (REFUND/ADJUSTMENT
   * quedan exentos a propósito -- ver docs/diseno-invoice-retry-charge-guard-2026-09-18.md
   * §2/§6: la rama NC de `requestInvoice()` retorna antes del bloque
   * transaccional, así que ningún guard fresco corrió nunca sobre esos 2
   * tipos, para ningún productor). `RETRY-EXISTING-NC-PRODUCER-SAFETY-001`
   * (`reversed-invoice-id-convention.test.ts`) es el mecanismo que detecta
   * un productor futuro que rompa esa exención.
   */
  private async assertChargesStillInvoiceable(client: SqlClient, chargeTxs: FinancialTransaction[]): Promise<void> {
    if (chargeTxs.length === 1) {
      // Un solo lock -- no hay ABBA que ordenar. Mismo método que el guard
      // fresco individual, dentro de requestInvoice() (cita por nombre, no
      // línea, desde SCHEMA-ANCHOR-DRIFT-001 -- este archivo ya se movió
      // una vez en esta misma Wave).
      const tx = chargeTxs[0]!;
      const ar = await this.accountsReceivableRepo.getByFinancialTransactionIdWithLock(client, tx.id);
      if (ar && ar.status === 'REVERTIDO') throw new AccountsReceivableReversedCannotInvoiceError(ar.id);
    } else {
      // >1 -- ABBA real si no coincide con el guard fresco consolidado
      // (ACCOUNTS-RECEIVABLE-LOCK-ORDER-001, dentro de
      // requestConsolidatedInvoice() -- cita por nombre, no línea, mismo
      // criterio que arriba). Resolución SIN lock de
      // `ar.id` por cargo -- segura acá (a diferencia del guard fresco
      // INDIVIDUAL, que motivó `getByFinancialTransactionIdWithLock`: ver
      // accounts-receivable.repository.ts:137-151 para esa razón original,
      // que NO transfiere sin más a este camino). Un cargo que llega acá
      // viene de `getChargeIdsForInvoice()` de una factura consolidada YA
      // armada a partir de AR `pending` -- su existencia es un invariante
      // ya establecido (R12, nunca hard-delete), no una carrera contra una
      // creación en curso; lo único que se lee sin lock es `ar.id`, PK
      // inmutable desde el INSERT, nunca stale. El `status`, que sí puede
      // cambiar, se relee bajo FOR UPDATE abajo. Fail-loud si un cargo no
      // tiene AR -- si la existencia es un invariante ya establecido, un
      // `null` acá es esa invariante rota, no un caso normal a saltear en
      // silencio.
      const resolved = await Promise.all(
        chargeTxs.map(async (tx) => {
          const ar = await this.accountsReceivableRepo.getByFinancialTransactionId(tx.id);
          if (!ar) {
            throw new Error(
              `assertChargesStillInvoiceable(): el cargo "${tx.id}" (parte de una factura consolidada) no tiene accounts_receivable -- invariante roto (todo cargo de invoice_charges viene de un AR pending).`,
            );
          }
          return ar;
        }),
      );
      for (const ar of canonicalAccountsReceivableLockOrder(resolved, (a: AccountReceivable) => a.id)) {
        const locked = await this.accountsReceivableRepo.getByIdWithLock(client, ar.id);
        if (locked && locked.status === 'REVERTIDO') throw new AccountsReceivableReversedCannotInvoiceError(locked.id);
      }
    }

    // Residuo declarado (gate de pre-commit, ronda 2, Wave 13, Zona 2): el
    // `.sort()` default de acá es una SEGUNDA copia ad-hoc del mismo orden
    // que ya usan los guards frescos (`requestInvoice()`/`requestConsolidatedInvoice()`,
    // idéntico texto) -- no fenced, mismo patrón que
    // `ACCOUNTS-RECEIVABLE-LOCK-ORDER-001` existe para prevenir, un nivel
    // más abajo (orden/reserva, no AR). Hoy es comportacionalmente idéntico
    // (default `.sort()` de string IDs), así que no es un riesgo de ABBA
    // real -- se deja SIN fence a propósito en este bloque (alcance
    // congelado por el diseño), no un olvido. Ver
    // docs/diseno-invoice-retry-charge-guard-2026-09-18.md §11.
    const orderIds = [...new Set(chargeTxs.map((tx) => tx.orderId).filter((id): id is string => id != null))].sort();
    for (const orderId of orderIds) {
      const order = await this.orderRepo.getByIdForUpdate(client, orderId);
      if (order && order.status === 'CANCELLED') throw new OrderCancelledCannotInvoiceError(orderId);
    }
    const reservationIds = [...new Set(chargeTxs.map((tx) => tx.reservationId).filter((id): id is string => id != null))].sort();
    for (const reservationId of reservationIds) {
      const reservation = this.reservationRepo.getByIdWithLock
        ? await this.reservationRepo.getByIdWithLock(client, reservationId)
        : await this.reservationRepo.getById(reservationId);
      if (reservation && reservation.status === ReservationStatus.CANCELLED) throw new ReservationCancelledCannotInvoiceError(reservationId);
    }
  }

  /**
   * C1-Fase C (23/08/2026) — único lugar que marca una factura ISSUED
   * (`issue()` y `reconcileAfterFailure()` pasan los dos por acá, R14) para
   * poder cerrar, en el mismo paso, el gap encontrado al diseñar
   * consolidada: facturar una CHARGE que vino de
   * `transferStayBalanceToReceivable()` (F1-Pieza 3) por este camino
   * (`FacturarButton`) no actualizaba `accounts_receivable.status` -- la
   * fila quedaba PENDIENTE_FACTURAR para siempre pese a tener una factura
   * real. Solo aplica al camino per-reservation (`financialTransactionId`
   * no nulo) -- una consolidada (`null`) cierra sus N filas aparte, en
   * `requestConsolidatedInvoice()`. Best-effort: si esto falla, la factura
   * YA es real (CAE ya emitido) -- no debe parecer que issue() falló.
   */
  /**
   * ADR ISSUE-BEFORE-REVERSE-WINDOW-001, Bloque 3, §3.9, "P3" -- desde que
   * `markIssued()`/`markIssuedWithClient()` ganan el guard `<> 'ISSUED'`
   * (A-2), este método puede ver la fila ya `ISSUED` (4 caminos alcanzables,
   * ver el ADR: dos reintentos concurrentes, la ventana entre el deploy de
   * 3 y el de 4, una respuesta tardía de AFIP después de una resolución
   * manual, o la resolución manual ganándole la carrera al automático).
   * Política: éxito idempotente si el comprobante coincide con el ya
   * persistido (mismo CAE real llegó por dos caminos, nada que
   * reconciliar); si NO coincide, `InvoiceIssuedComprobanteMismatchError`
   * SIN mapeo amigable (500, honest-degradation) -- acá no hay ningún
   * operador esperando la respuesta HTTP a quien avisarle "pará y revisá".
   */
  private async finalizeIssued(invoiceId: string, data: MarkIssuedInput): Promise<Invoice> {
    let issued: Invoice;
    try {
      issued = await this.invoiceRepo.markIssued(invoiceId, data);
    } catch (err) {
      if (!(err instanceof InvoiceAlreadyIssuedError)) throw err;
      const current = await this.invoiceRepo.getById(invoiceId);
      if (!current) throw err;
      if (current.cbteNro === data.cbteNro && current.cae === data.cae) {
        // Éxito idempotente -- el mismo comprobante real ya está persistido,
        // no hace falta reintentar la escritura.
        await this.closeAccountsReceivableGapBestEffort(current);
        return current;
      }
      logger.error(
        {
          invoiceId,
          attempted: { cbteNro: data.cbteNro, cae: data.cae, caeVto: data.caeVto },
          persisted: { cbteNro: current.cbteNro, cae: current.cae, caeVto: current.caeVto },
        },
        '[InvoiceService] finalizeIssued(): la factura ya está ISSUED con un comprobante distinto al que esta llamada intentaba grabar -- invariante roto, revisión humana.',
      );
      throw new InvoiceIssuedComprobanteMismatchError(invoiceId);
    }
    await this.closeAccountsReceivableGapBestEffort(issued);
    return issued;
  }

  /**
   * Bloque 5 (15/09/2026, §6.5 bis) -- extraído de `finalizeIssued()` para
   * poder reusarlo desde `resolveCreditNoteRequestManually()` (rama
   * `EMITIDA`), que marca ISSUED con `markIssuedWithClient()` DENTRO de la
   * transacción que también transiciona `credit_note_request` (no puede
   * pasar por `finalizeIssued()` tal cual: ese método usa `markIssued()`
   * sin `client`, fuera de la transacción compartida).
   *
   * Decisión de diseño (Bloque 5, chica): en vez de hacer inyectable la
   * parte transaccional de `finalizeIssued()` (que hubiera significado
   * tocar su firma y sus 2 call-sites existentes, `issue()`/
   * `reconcileAfterFailure()`), se extrae SOLO el best-effort de
   * `accounts_receivable` -- que ya era independiente del `client` de la
   * transacción principal (corre DESPUÉS de que el `markIssued()` de
   * `finalizeIssued()` ya resolvió, con su propio try/catch). Mismo
   * criterio que ya usa `finalizeIssued()`: si esto falla, la factura YA es
   * real (CAE ya emitido) -- no debe parecer que la resolución manual falló.
   */
  private async closeAccountsReceivableGapBestEffort(issued: Invoice): Promise<void> {
    if (!issued.financialTransactionId) return;
    try {
      const ar = await this.accountsReceivableRepo.getByFinancialTransactionId(issued.financialTransactionId);
      if (ar && ar.status === 'PENDIENTE_FACTURAR') {
        const invoiceRef = `${String(issued.ptoVta).padStart(4, '0')}-${String(issued.cbteNro).padStart(8, '0')}`;
        await this.accountsReceivableRepo.markInvoiced(ar.id, invoiceRef);
      }
    } catch (err) {
      logger.error(
        { financialTransactionId: issued.financialTransactionId, invoiceId: issued.id, err: errMessage(err) },
        '[InvoiceService] no se pudo cerrar el gap de accounts_receivable',
      );
    }
  }

  private async issue(
    port: AfipBillingPort,
    invoice: Invoice,
    afipRequest: Record<string, unknown>,
    environment: AfipEnvironment,
    ptoVta: number,
  ): Promise<Invoice> {
    let lastVoucherBefore: number;
    try {
      lastVoucherBefore = (await port.getLastVoucher(ptoVta, invoice.cbteTipo)).cbteNro;
    } catch (err) {
      // Ni siquiera se pudo consultar el último comprobante -- sin ese
      // punto de referencia no hay forma de reconciliar después, así que
      // no se intenta el pedido de CAE con esa incertidumbre de entrada.
      const message = `no se pudo consultar FECompUltimoAutorizado antes de pedir el CAE: ${errMessage(err)}`;
      // createNextVoucher() nunca se invocó -- sin ambigüedad posible,
      // reintentable solo (afipContacted: false, ver invoice.entities.ts).
      // Bloque 2 (15/09/2026) -- a propósito SIN transactionManager.run():
      // decisión del dueño (15/09/2026), este 4to call-site no dispara
      // ninguna transición de credit_note_request (se queda en PENDIENTE) y
      // hoy no hay ninguna otra escritura que compartir acá -- envolver un
      // único UPDATE en una transacción explícita no cambia su atomicidad
      // (Postgres ya la garantiza por statement) y sugeriría, a un lector
      // futuro, que hay algo más adentro para lo que no lo hay. Si el
      // Bloque 3 llega a necesitar que ESTE call-site también escriba
      // credit_note_request, se vuelve markFailedWithClient() en ese
      // momento, no antes.
      await this.invoiceRepo.markFailed(invoice.id, { status: 'FAILED_UNCERTAIN', errorMessage: message, afipContacted: false });
      throw new AfipRequestUncertainError(invoice.id, message);
    }

    let result;
    try {
      result = await port.createNextVoucher(afipRequest);
    } catch (err) {
      return this.reconcileAfterFailure(port, invoice, ptoVta, lastVoucherBefore, errMessage(err));
    }

    if (result.resultado === 'R') {
      // AFIP evaluó y dijo que no -- confirmado que no quedó nada emitido,
      // reintentable solo una vez corregido lo que haya rechazado.
      const obs = result.observaciones ?? 'sin detalle';
      // Bloque 2 (15/09/2026) -- transaccionaliza markFailed() (antes UPDATE
      // suelto fuera de cualquier tx). Bloque 4 (15/09/2026) -- ahora sí
      // comparte esta misma tx con la transición de `credit_note_request`.
      await this.transactionManager.run(async (client: SqlClient) => {
        await this.invoiceRepo.markFailedWithClient(client, invoice.id, {
          status: 'REJECTED',
          errorMessage: obs,
          afipResponse: result.raw,
          afipContacted: true,
        });
        // Bloque 4 (15/09/2026, §6.5 bis) -- REJECTED con afipContacted:true
        // es un disparador legítimo de PENDIENTE -> CERRADA (automático,
        // resolution_outcome NULL) para la fila `credit_note_request`
        // asociada, si existe (solo el escape fiscal crea una -- Bloque 3).
        await this.transitionCreditNoteRequestAfterFailure(client, invoice.id, { toState: 'CERRADA', resolutionOutcome: null });
      });
      throw new AfipRequestRejectedError(invoice.id, obs);
    }

    if (!result.cbteDesde || !result.cae) {
      const message = `respuesta de AFIP sin CbteDesde/CAE pese a no venir Resultado='R': ${JSON.stringify(result.raw)}`;
      // AFIP respondió pero de forma inesperada -- genuinamente ambiguo,
      // requiere revisión manual antes de reintentar (A8.6).
      // Bloque 2 (15/09/2026) -- ver nota de la rama REJECTED más arriba.
      // Bloque 4 (15/09/2026) -- ídem, comparte tx con credit_note_request.
      await this.transactionManager.run(async (client: SqlClient) => {
        await this.invoiceRepo.markFailedWithClient(client, invoice.id, { status: 'FAILED_UNCERTAIN', errorMessage: message, afipResponse: result.raw, afipContacted: true });
        // Bloque 4 (15/09/2026, §6.5 bis) -- FAILED_UNCERTAIN con
        // afipContacted:true es ambiguo (AFIP respondió pero sin CbteDesde/
        // CAE) -- escala PENDIENTE -> EN_REVISION_MANUAL si la factura tiene
        // una fila `credit_note_request` asociada.
        await this.transitionCreditNoteRequestAfterFailure(client, invoice.id, { toState: 'EN_REVISION_MANUAL' });
      });
      throw new AfipRequestUncertainError(invoice.id, message);
    }

    return this.finalizeIssued(invoice.id, {
      cbteNro: result.cbteDesde,
      cae: result.cae,
      caeVto: afipDateToIso(result.caeFchVto!),
      afipResponse: result.raw,
    });
  }

  /** A8.6 — reconciliación después de una falla ambigua, nunca un reintento directo. */
  private async reconcileAfterFailure(
    port: AfipBillingPort,
    invoice: Invoice,
    ptoVta: number,
    lastVoucherBefore: number,
    originalErrorMessage: string,
  ): Promise<Invoice> {
    let lastVoucherAfter: number | null = null;
    try {
      lastVoucherAfter = (await port.getLastVoucher(ptoVta, invoice.cbteTipo)).cbteNro;
    } catch {
      // no se pudo ni reconciliar -- queda incierto, un humano lo revisa a mano.
    }

    if (lastVoucherAfter !== null && lastVoucherAfter > lastVoucherBefore) {
      // AFIP SÍ procesó el pedido pese al error de red del lado cliente --
      // se recupera el CAE real en vez de perderlo o pedir uno nuevo.
      const info = await port.getVoucherInfo(lastVoucherAfter, ptoVta, invoice.cbteTipo).catch(() => null);
      if (info?.codAutorizacion) {
        return this.finalizeIssued(invoice.id, {
          cbteNro: lastVoucherAfter,
          cae: info.codAutorizacion,
          caeVto: info.fchVto ? afipDateToIso(info.fchVto) : afipDateToIso(toAfipDate(new Date())),
          afipResponse: info.raw,
        });
      }
    }

    const message = `error de red al pedir el CAE (${originalErrorMessage}) -- FECompUltimoAutorizado no avanzó de forma confirmable, requiere revisión manual antes de reintentar`;
    // createNextVoucher() SÍ se invocó y no se pudo confirmar el resultado --
    // ambiguo por definición (A8.6), no reintentable solo.
    // Bloque 2 (15/09/2026) -- ver nota de la rama REJECTED en issue().
    // Bloque 4 (15/09/2026) -- ídem, comparte tx con credit_note_request.
    await this.transactionManager.run(async (client: SqlClient) => {
      await this.invoiceRepo.markFailedWithClient(client, invoice.id, { status: 'FAILED_UNCERTAIN', errorMessage: message, afipContacted: true });
      // Bloque 4 (15/09/2026, §6.5 bis) -- mismo criterio que la rama
      // FAILED_UNCERTAIN de issue(): ambiguo, escala PENDIENTE ->
      // EN_REVISION_MANUAL si hay fila `credit_note_request` asociada.
      // `reconcileAfterFailure()` tiene un solo call-site de
      // `markFailedWithClient()` -- el camino que SÍ confirma el CAE
      // (arriba, `lastVoucherAfter > lastVoucherBefore` + `codAutorizacion`)
      // vuelve por `finalizeIssued()`/`markIssued()`, no por acá, así que no
      // hay una segunda rama que mapear a CERRADA dentro de este método
      // (ver reporte de Bloque 4 sobre el gap declarado de ese camino).
      await this.transitionCreditNoteRequestAfterFailure(client, invoice.id, { toState: 'EN_REVISION_MANUAL' });
    });
    throw new AfipRequestUncertainError(invoice.id, message);
  }

  /**
   * Bloque 4 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis) --
   * engancha las 3 transiciones automáticas de `credit_note_request`
   * (`:REJECTED`/`:FAILED_UNCERTAIN` de `issue()`, `:FAILED_UNCERTAIN` de
   * `reconcileAfterFailure()`) sobre el `markFailedWithClient()` ya atómico
   * del Bloque 2 -- SIEMPRE se llama con el `client` de la MISMA transacción
   * que hizo ese UPDATE (atomic-state-mutation: un solo commit, nunca dos
   * escrituras sueltas que puedan divergir si una falla a mitad de camino).
   *
   * No-op si la factura no tiene una fila `credit_note_request` asociada
   * (camino mayoritario: factura normal, sin escape fiscal de por medio --
   * solo `buildCreditNote()` con `tx.type === 'ADJUSTMENT'`, Bloque 3, crea
   * una).
   *
   * Tolera `CreditNoteRequestInvalidTransitionError` únicamente cuando
   * `fromState === 'CERRADA'` (terminal, A6.4): `retryExisting()`
   * (`invoice.service.ts`) no bloquea el reintento de una factura
   * `REJECTED` -- solo bloquea `ISSUED` y `FAILED_UNCERTAIN` con
   * `afipContacted:true`. Si un operador reintenta una factura REJECTED
   * cuya `credit_note_request` ya cerró (CERRADA) en el primer intento, y
   * el reintento vuelve a fallar (REJECTED o FAILED_UNCERTAIN otra vez),
   * este método intenta transicionar una fila que ya llegó a su estado
   * terminal -- no es un bug, es la consecuencia esperada de que
   * `retryExisting()` no sabe (ni le compete) que el workflow de NC ya se
   * resolvió. El UPDATE de `invoices` que ya corrió en la misma
   * transacción sigue siendo la escritura correcta y autoritativa de este
   * call-site -- no tiene sentido abortarla por un estado de workflow que
   * ya llegó a destino. Cualquier OTRA forma de `CreditNoteRequestInvalidTransitionError`
   * (p. ej. `fromState === 'EN_REVISION_MANUAL'`, que hoy no debería ser
   * alcanzable desde estos 3 call-sites porque `retryExisting()` ya bloquea
   * el reintento de toda factura `FAILED_UNCERTAIN` con `afipContacted:true`)
   * SÍ hace fallar toda la transacción -- señalaría un camino no
   * contemplado por este diseño, y hay que enterarse, no enmascararlo.
   *
   * **Nota (Wave 13, Zona 2, 21/09/2026, gate `architecture-governor`):**
   * desde `assertChargesStillInvoiceable()` (CHARGE-STATE-GUARD-001),
   * `retryExisting()` tiene una TERCERA forma de fallar, anterior a esta --
   * un reintento sobre un `CHARGE` cuya AR ya está `REVERTIDO` o cuya
   * orden/reserva ya está `CANCELLED` lanza ANTES de llegar a `issue()`, y
   * este método nunca se invoca en ese caso (la fila de `invoices` ni se
   * toca). No cambia el razonamiento de arriba -- ese guard nuevo nunca
   * corre sobre `REFUND`/`ADJUSTMENT` (docs/diseno-invoice-retry-charge-guard-2026-09-18.md
   * §2/§6), así que el workflow de NC de este método sigue viendo
   * exactamente los mismos 2 casos de reintento que describe arriba.
   */
  private async transitionCreditNoteRequestAfterFailure(
    client: SqlClient,
    invoiceId: string,
    transition: TransitionCreditNoteRequestInput,
  ): Promise<void> {
    const request = await this.creditNoteRequestRepo.findByInvoiceId(invoiceId);
    if (!request) return; // camino mayoritario -- sin escape de NC, nada que transicionar.

    try {
      await this.creditNoteRequestRepo.transitionWithClient(client, request.id, transition);
    } catch (err) {
      if (err instanceof CreditNoteRequestInvalidTransitionError && err.fromState === 'CERRADA') {
        logger.warn(
          {
            creditNoteRequestId: request.id,
            invoiceId,
            attemptedToState: transition.toState,
          },
          '[InvoiceService] credit_note_request ya estaba CERRADA (terminal) -- se tolera el intento de transición ' +
            '(reintento de una factura cuyo workflow de NC ya se había resuelto), no se aborta el UPDATE de invoices ya aplicado en esta misma tx',
        );
        return;
      }
      throw err;
    }
  }

  /**
   * Bloque 5 del ADR común cancelar-con-NC (15/09/2026, §6.5 bis) -- la
   * transición MANUAL `EN_REVISION_MANUAL -> CERRADA`, disparada por
   * `POST /api/credit-note-requests/:id/resolve`. A diferencia de las 3
   * transiciones automáticas de `transitionCreditNoteRequestAfterFailure()`
   * (que parten de una factura ya conocida), acá el caller solo tiene el id
   * de la SOLICITUD -- se resuelve primero con `findById()` para conocer
   * `invoiceId` antes de escribir nada.
   *
   * Dos ramas, un solo commit cada una (atomic-state-mutation):
   *  - `EMITIDA` (encontró un CAE real a mano contra AFIP): `markIssuedWithClient()`
   *    + transición a CERRADA con `resolutionOutcome: 'EMITIDA'`, en la
   *    MISMA transacción -- mismo orden que usa el Bloque 4 para las
   *    transiciones automáticas (primero `invoices`, después
   *    `credit_note_request`, porque esta última fila guarda `invoice_id`,
   *    no al revés). El best-effort de `accounts_receivable`
   *    (`closeAccountsReceivableGapBestEffort()`) corre DESPUÉS de cerrar la
   *    transacción principal, igual que ya hace `finalizeIssued()` -- ver su
   *    docblock para la decisión de diseño de por qué se extrajo así en vez
   *    de inyectar la parte transaccional de `finalizeIssued()`.
   *  - `NO_EMITIDA` (confirmó que AFIP no tiene nada): SOLO desbloquea la
   *    factura (`markUncertainClearedWithClient()`) + transición a CERRADA
   *    con `resolutionOutcome: 'NO_EMITIDA'`. Pregunta de negocio 1, opción
   *    (b) YA RESUELTA por el dueño (ADR §6.5 bis) -- el reintento de
   *    `issue()` sigue siendo una acción manual APARTE, esto no lo dispara.
   *
   * `transitionWithClient()` (llamado siempre en 2do lugar, adentro de la
   * misma tx) ya valida contra `ALLOWED_CREDIT_NOTE_REQUEST_TRANSITIONS` y
   * tira `CreditNoteRequestInvalidTransitionError` si la fila no está en
   * `EN_REVISION_MANUAL` -- no se duplica esa validación acá (A6.2/A6.3).
   *
   * **ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.9 --
   * "Resolución de ubicación A":** el camino feliz de arriba (dos escrituras,
   * un commit) sigue igual, pero ahora:
   *  - la rama `EMITIDA` usa `markIssuedFromManualResolutionWithClient()`
   *    (A-2, predicado ESTRICTO) en vez de `markIssuedWithClient()` (que
   *    desde este bloque queda exclusivo del camino automático);
   *  - si CUALQUIERA de las dos escrituras (`markIssuedFromManualResolutionWithClient()`/
   *    `markUncertainClearedWithClient()`) lanza su error de precondición
   *    (la factura ya no está en la ambigüedad esperada -- alguien más ya
   *    decidió su desenlace real), esta transacción reclasifica bajo lock
   *    en vez de propagar el error crudo -- ver `reclassifyManualResolution()`.
   */
  async resolveCreditNoteRequestManually(input: ResolveCreditNoteRequestManuallyInput): Promise<CreditNoteRequest> {
    const request = await this.creditNoteRequestRepo.findById(input.creditNoteRequestId);
    if (!request) throw new CreditNoteRequestNotFoundError(input.creditNoteRequestId);

    let issuedInvoice: Invoice | null = null;
    let updatedRequest!: CreditNoteRequest;

    await this.transactionManager.run(async (client: SqlClient) => {
      try {
        if (input.outcome === 'EMITIDA') {
          // Validado por Zod antes de llegar acá (CreditNoteRequestResolveSchema
          // .superRefine()) -- cbteNro/cae/caeVto son obligatorios cuando
          // outcome === 'EMITIDA'. El `!` documenta esa garantía externa, no
          // la re-valida (la ruta es la única caller de este método).
          issuedInvoice = await this.invoiceRepo.markIssuedFromManualResolutionWithClient(client, request.invoiceId, {
            cbteNro: input.cbteNro!,
            cae: input.cae!,
            caeVto: input.caeVto!,
            // Sin respuesta cruda de AFIP -- esto es una confirmación manual,
            // no una respuesta de `createNextVoucher()`/`getVoucherInfo()`.
            // `manualResolution: true` deja rastro de que este ISSUED nació
            // de la bandeja de reconciliación, no del flujo automático.
            afipResponse: { manualResolution: true, resolvedBy: input.resolvedBy, note: input.note },
          });
        } else {
          await this.invoiceRepo.markUncertainClearedWithClient(client, request.invoiceId, {
            clearedBy: input.resolvedBy,
          });
        }

        updatedRequest = await this.creditNoteRequestRepo.transitionWithClient(client, request.id, {
          toState: 'CERRADA',
          resolutionOutcome: input.outcome,
          resolvedBy: input.resolvedBy,
          resolutionNote: input.note,
        });
      } catch (err) {
        if (err instanceof InvoiceManualResolutionPreconditionError || err instanceof InvoiceUncertainClearPreconditionError) {
          updatedRequest = await this.reclassifyManualResolution(client, request.invoiceId, request.id, input);
          return;
        }
        throw err;
      }
    });

    if (issuedInvoice) {
      await this.closeAccountsReceivableGapBestEffort(issuedInvoice);
    }

    return updatedRequest;
  }

  /**
   * ADR ISSUE-BEFORE-REVERSE-WINDOW-001, Bloque 3, §3.9, "A-4"/"N-2"/"P-2"
   * -- corre DENTRO de la MISMA transacción que `resolveCreditNoteRequestManually()`
   * (el guard estricto de A-2/N6 ya falló, RETURNING vacío). Lockea la
   * factura PRIMERO, la solicitud DESPUÉS (mismo orden que el resto del
   * método -- ver "Por qué P-2 no necesita invertir el orden de locks" en
   * el ADR).
   */
  private async reclassifyManualResolution(
    client: SqlClient,
    invoiceId: string,
    creditNoteRequestId: string,
    input: ResolveCreditNoteRequestManuallyInput,
  ): Promise<CreditNoteRequest> {
    const snapshot = await this.invoiceRepo.getReconciliationSnapshotForUpdate(client, invoiceId);
    if (!snapshot) {
      throw new Error(`resolveCreditNoteRequestManually(): factura "${invoiceId}" no encontrada al reclasificar -- invariante roto.`);
    }

    const lockedRequest = await this.creditNoteRequestRepo.findByIdForUpdate(client, creditNoteRequestId);
    if (!lockedRequest) {
      throw new Error(`resolveCreditNoteRequestManually(): solicitud "${creditNoteRequestId}" no encontrada al reclasificar -- invariante roto.`);
    }

    // P-2 (decisión del dueño, "Exigir EN_REVISION_MANUAL para resolver")
    // -- todavía no llegó a revisión manual, el camino automático ni
    // siquiera falló una vez.
    if (lockedRequest.state === 'PENDIENTE') {
      throw new CreditNoteRequestNotInManualReviewError(lockedRequest.id, lockedRequest.state);
    }

    if (lockedRequest.state === 'CERRADA') {
      // N-2 -- idempotente SOLO si el desenlace grabado coincide con lo
      // declarado (y, para EMITIDA, también el CAE real coincide con el
      // declarado contra la factura ya lockeada arriba).
      const outcomeMatches = lockedRequest.resolutionOutcome === input.outcome;
      const caeMatches = input.outcome !== 'EMITIDA' || (input.cbteNro === snapshot.cbteNro && input.cae === snapshot.cae);
      if (outcomeMatches && caeMatches) return lockedRequest;

      logger.warn(
        {
          creditNoteRequestId: lockedRequest.id,
          invoiceId,
          declaredOutcome: input.outcome,
          recordedOutcome: lockedRequest.resolutionOutcome,
          resolvedBy: input.resolvedBy,
        },
        '[InvoiceService] resolveCreditNoteRequestManually(): la solicitud ya está CERRADA con un desenlace distinto al declarado -- rechaza, no se auto-cierra.',
      );
      throw new InvoiceResolutionStateConflictError(invoiceId, lockedRequest.resolutionOutcome ?? 'CERRADA_SIN_DESENLACE');
    }

    // lockedRequest.state === 'EN_REVISION_MANUAL' -- camino feliz de la
    // reclasificación: clasifica por el estado REAL de la factura contra
    // lo que el operador DECLARÓ.
    return this.classifyManualResolutionOutcome(client, invoiceId, lockedRequest, snapshot, input);
  }

  /**
   * ADR ISSUE-BEFORE-REVERSE-WINDOW-001, Bloque 3, §3.9 -- clasificación de
   * la rama `EN_REVISION_MANUAL` de `reclassifyManualResolution()`. Las dos
   * decisiones de negocio del dueño (encabezado del ADR): conflicto de
   * estado -> rechaza y deja abierta (decisión 1); discrepancia de CAE ->
   * rechaza, queda para revisión fiscal (decisión 2).
   */
  private async classifyManualResolutionOutcome(
    client: SqlClient,
    invoiceId: string,
    lockedRequest: CreditNoteRequest,
    snapshot: ReconciliationSnapshot,
    input: ResolveCreditNoteRequestManuallyInput,
  ): Promise<CreditNoteRequest> {
    if (snapshot.status === 'ISSUED' && input.outcome === 'EMITIDA') {
      if (input.cbteNro === snapshot.cbteNro && input.cae === snapshot.cae) {
        // Idempotente -- mismo CAE real, doble-submit o ya cerrado por otro
        // operador con el mismo dato. Sin volver a escribir la factura.
        return this.creditNoteRequestRepo.transitionWithClient(client, lockedRequest.id, {
          toState: 'CERRADA',
          resolutionOutcome: 'EMITIDA',
          resolvedBy: input.resolvedBy,
          resolutionNote: input.note,
        });
      }
      logger.error(
        {
          creditNoteRequestId: lockedRequest.id,
          invoiceId,
          declared: { cbteNro: input.cbteNro, cae: input.cae },
          real: { cbteNro: snapshot.cbteNro, cae: snapshot.cae },
          resolvedBy: input.resolvedBy,
        },
        '[InvoiceService] resolveCreditNoteRequestManually(): discrepancia de CAE -- el declarado no coincide con el ya emitido, rechaza, queda para revisión fiscal.',
      );
      throw new InvoiceResolutionCaeMismatchError(invoiceId);
    }

    if (snapshot.status === 'ISSUED' && input.outcome === 'NO_EMITIDA') {
      logger.warn(
        { creditNoteRequestId: lockedRequest.id, invoiceId, declaredOutcome: 'NO_EMITIDA', realStatus: 'ISSUED', resolvedBy: input.resolvedBy },
        '[InvoiceService] resolveCreditNoteRequestManually(): conflicto de estado -- la factura ya está ISSUED, rechaza NO_EMITIDA declarado.',
      );
      throw new InvoiceResolutionStateConflictError(invoiceId, 'ISSUED');
    }

    if (snapshot.status === 'FAILED_UNCERTAIN' && snapshot.uncertainClearedAt != null) {
      if (input.outcome === 'NO_EMITIDA') {
        // Idempotente -- mismo desenlace que ya declaró (esta llamada u otra).
        return this.creditNoteRequestRepo.transitionWithClient(client, lockedRequest.id, {
          toState: 'CERRADA',
          resolutionOutcome: 'NO_EMITIDA',
          resolvedBy: input.resolvedBy,
          resolutionNote: input.note,
        });
      }
      logger.warn(
        { creditNoteRequestId: lockedRequest.id, invoiceId, declaredOutcome: 'EMITIDA', realStatus: 'NO_EMITIDA', resolvedBy: input.resolvedBy },
        '[InvoiceService] resolveCreditNoteRequestManually(): conflicto de estado, espejo -- la factura ya se limpió NO_EMITIDA, rechaza EMITIDA declarado.',
      );
      throw new InvoiceResolutionStateConflictError(invoiceId, 'NO_EMITIDA');
    }

    // NUEVO (ronda 11, residuo #2 del veredicto de ronda 10 del gate) --
    // `FAILED_UNCERTAIN && afipContacted && uncertainClearedAt == null` es
    // EXACTAMENTE la ambigüedad que el guard estricto de A-2/N6 esperaba --
    // apareció DESPUÉS de que el UPDATE optimista de ESTA llamada ya falló.
    // Carrera recuperable con un simple reintento de la MISMA llamada, no
    // un invariante roto -- reusa el mismo tipo que el catch-all de abajo
    // (documentado como transitorio/retryable, sin error nuevo).
    //
    // Cualquier otro status (PENDING en vuelo, REJECTED, FAILED_UNCERTAIN
    // con afipContacted=false) -- invariante GENUINAMENTE no contemplado,
    // no se adivina qué pasó -- 500 sin mapear (honest-degradation).
    throw new InvoiceReconciliationUnexpectedStateError(invoiceId, snapshot.status);
  }

  /**
   * ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.9 --
   * bandeja nueva `mark-not-issued`, mismo efecto que
   * `resolveCreditNoteRequestManually()` con `outcome: 'NO_EMITIDA'` pero
   * SIN `credit_note_request` involucrada (CHARGE, o NC con solicitud ya
   * CERRADA -- N-1/A-6). Guard de entrada: rechaza si la factura tiene una
   * `credit_note_request` propia que sigue ABIERTA (esa combinación va por
   * `POST /credit-note-requests/:id/resolve`, no por acá -- hueco B7 del
   * gate, dos salidas para el mismo caso serían dos fuentes de verdad
   * divergentes).
   */
  async markInvoiceNotIssued(input: { invoiceId: string; resolvedBy: string }): Promise<Invoice> {
    const openRequest = await this.creditNoteRequestRepo.findByInvoiceId(input.invoiceId);
    if (openRequest && (openRequest.state === 'PENDIENTE' || openRequest.state === 'EN_REVISION_MANUAL')) {
      throw new InvoiceHasOpenCreditNoteRequestError(input.invoiceId, openRequest.id);
    }

    let invoice!: Invoice;
    await this.transactionManager.run(async (client: SqlClient) => {
      invoice = await this.invoiceRepo.markUncertainClearedWithClient(client, input.invoiceId, {
        clearedBy: input.resolvedBy,
      });
    });
    return invoice;
  }

  /**
   * ADR ISSUE-BEFORE-REVERSE-WINDOW-001 (23/09/2026), Bloque 3, §3.14
   * (P-1, decisión del dueño "Reconciliar contra AFIP") --
   * `POST /api/invoices/:id/reconcile-with-afip`. Consulta el comprobante
   * real contra AFIP (`getVoucherInfo()`) en vez de que el operador tipee
   * un CAE a mano -- el `cbteNro` que aporta es un ÍNDICE que el sistema
   * verifica, no el CAE en sí.
   *
   * Cubre DOS poblaciones con el mismo mecanismo (ver el ADR, "Población
   * objetivo"): nunca limpiada, y ya limpiada `NO_EMITIDA` a mano ("AFIP
   * prevalece" -- ronda 11, decisión del dueño "Prevalece igual, registrar
   * el residuo"). Las dos escriben con `markIssuedFromAfipReconciliationWithClient()`,
   * nunca con el escritor exclusivo del camino puramente manual
   * (`markIssuedFromManualResolutionWithClient()`, A-2) -- corrección de
   * ronda 13 (H2 del veredicto de ronda 12 del gate).
   */
  async reconcileWithAfip(input: ReconcileInvoiceWithAfipInput): Promise<Invoice> {
    const invoice = await this.invoiceRepo.getById(input.invoiceId);
    if (!invoice) throw new InvoiceNotFoundError(input.invoiceId);

    // Guard de entrada -- mismo criterio narrowed que N-1/A-6
    // (mark-not-issued). Corre ANTES de tocar AFIP (barato, sin llamada de
    // red).
    const openRequest = await this.creditNoteRequestRepo.findByInvoiceId(input.invoiceId);
    if (openRequest && (openRequest.state === 'PENDIENTE' || openRequest.state === 'EN_REVISION_MANUAL')) {
      throw new InvoiceHasOpenCreditNoteRequestError(input.invoiceId, openRequest.id);
    }

    const credentials = await this.afipCredentialsRepo.getDecrypted();
    if (!credentials) throw new AfipNotConfiguredError('falta cargar el certificado AFIP en Mi Negocio');
    const profile = await this.businessProfileRepo.get();
    const authCuit = profile.afipCuit ?? profile.taxId;
    if (!authCuit) throw new AfipNotConfiguredError('falta cargar el CUIT del negocio en Mi Negocio');

    const port = this.clientFactory(credentials, authCuit, this.afipCredentialsRepo);

    // Paso 1 -- consulta contra AFIP. A diferencia de reconcileAfterFailure()
    // (`.catch(() => null)`, intento AUTOMÁTICO de background), acá hay un
    // OPERADOR esperando el resultado de un click -- tragar el error en
    // silencio sería indistinguible de "AFIP confirma que no existe ese
    // comprobante".
    let info: VoucherInfoResult | null;
    try {
      info = await port.getVoucherInfo(input.cbteNro, invoice.ptoVta, invoice.cbteTipo);
    } catch (err) {
      throw new AfipReconciliationUnavailableError(input.invoiceId, errMessage(err));
    }

    // Paso 2 -- AFIP responde, pero sin comprobante real. Redacción
    // deliberadamente conservadora (ronda 11) -- NUNCA "no se emitió", solo
    // "no se pudo confirmar" (ver el docblock de AfipVoucherNotFoundError).
    if (!info || !info.codAutorizacion) {
      throw new AfipVoucherNotFoundError(input.invoiceId, input.cbteNro, invoice.ptoVta, invoice.cbteTipo);
    }

    // Paso 3 -- validación cruzada de los 8 campos contra invoice.afipRequest
    // (persistido en PascalCase por createWithClient()/buildCreditNote()).
    // Residuo declarado a propósito (gap 4(a)): dos facturas reales
    // distintas a Consumidor Final, mismo monto/fecha/desglose/concepto/
    // moneda, seguirían pasando esta validación indistinguibles entre sí --
    // es lo máximo que este mecanismo puede dar sin más información.
    const afipRequest = invoice.afipRequest as Record<string, unknown>;
    const crossFieldsMismatch =
      info.docTipo !== afipRequest['DocTipo'] ||
      info.docNro !== afipRequest['DocNro'] ||
      info.impTotal !== afipRequest['ImpTotal'] ||
      info.cbteFch !== afipRequest['CbteFch'] ||
      info.impNeto !== afipRequest['ImpNeto'] ||
      info.impIVA !== afipRequest['ImpIVA'] ||
      info.concepto !== afipRequest['Concepto'] ||
      info.monId !== afipRequest['MonId'];
    if (crossFieldsMismatch) {
      throw new AfipVoucherMismatchError(input.invoiceId, input.cbteNro);
    }

    // Paso 4 -- validación cruzada pasa: escribe SIEMPRE por el escritor
    // exclusivo de este mecanismo, para las DOS ramas de población (ver
    // "AFIP prevalece", corrección de ronda 13).
    const afipResponse = {
      reconciledWithAfip: true,
      requestedCbteNro: input.cbteNro,
      resolvedBy: input.resolvedBy,
      raw: info.raw,
    };
    const caeVto = info.fchVto ? afipDateToIso(info.fchVto) : afipDateToIso(toAfipDate(new Date()));

    let issued!: Invoice;
    await this.transactionManager.run(async (client: SqlClient) => {
      try {
        issued = await this.invoiceRepo.markIssuedFromAfipReconciliationWithClient(client, input.invoiceId, {
          cbteNro: input.cbteNro,
          cae: info!.codAutorizacion!,
          caeVto,
          afipResponse,
        });
      } catch (err) {
        if (!(err instanceof AfipReconciliationPreconditionError)) throw err;
        issued = await this.reclassifyAfipReconciliation(client, input.invoiceId, input.cbteNro, info!.codAutorizacion!);
      }
    });

    await this.closeAccountsReceivableGapBestEffort(issued);
    return issued;
  }

  /**
   * ADR ISSUE-BEFORE-REVERSE-WINDOW-001, Bloque 3, §3.14 -- reclasificación
   * de `reconcileWithAfip()` cuando el guard estricto de
   * `markIssuedFromAfipReconciliationWithClient()` no matchea. A diferencia
   * de `reclassifyManualResolution()`, esta población NUNCA tiene una
   * `credit_note_request` abierta (el guard de entrada ya lo garantiza) --
   * no lockea ni transiciona ninguna. Mismo criterio de idempotencia que P3
   * (`finalizeIssued()`): si el comprobante ya persistido coincide con el
   * que esta llamada intentaba grabar, éxito idempotente; si no, error sin
   * mapeo amigable (invariante roto, revisión humana).
   */
  private async reclassifyAfipReconciliation(
    client: SqlClient,
    invoiceId: string,
    cbteNro: number,
    cae: string,
  ): Promise<Invoice> {
    const snapshot = await this.invoiceRepo.getReconciliationSnapshotForUpdate(client, invoiceId);
    if (!snapshot) {
      throw new Error(`reconcileWithAfip(): factura "${invoiceId}" no encontrada al reclasificar -- invariante roto.`);
    }
    if (snapshot.status === 'ISSUED' && snapshot.cbteNro === cbteNro && snapshot.cae === cae) {
      const current = await this.invoiceRepo.getById(invoiceId);
      if (current) return current;
    }
    throw new InvoiceIssuedComprobanteMismatchError(invoiceId);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** C1-Fase C — idempotencyKey determinística para un SET de financial_transaction_ids (orden no importa, join crudo podría superar VARCHAR(255)). Exportada: la reusa el test de idempotencia. */
export function hashIds(ids: string[]): string {
  return createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 32);
}
