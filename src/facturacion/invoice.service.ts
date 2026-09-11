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
import type { InvoiceRepository, MarkIssuedInput } from './invoice.repository.js';
import type { Invoice, AfipEnvironment, CreateInvoiceItemInput } from './invoice.entities.js';
import { INVOICE_STATUSES_CONSUMING_CHARGE } from './invoice.entities.js';
import type { AfipCredentials, AfipCredentialsRepository } from './afip-credentials.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { AccountsReceivableRepository } from '../clientes-finanzas/accounts-receivable.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { IOrderRepository } from '../pos-menu/order.repository.js';
import type { OrderItem } from '../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../pos-menu/product.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import { ReservationStatus } from '../types/enums.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { buildDefaultAfipBillingPort } from './arca-sdk-billing.adapter.js';
import type { AfipBillingPort } from './afip-billing.port.js';
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
  OrderInvoiceHasNoLinesError,
  CreditNoteCapExceededError,
  CreditNotePairCapExceededError,
  CreditNoteAttributionBlockedError,
  CreditNoteAttributionMismatchError,
  CreditNoteAmbiguousSubjectError,
} from '../domain/errors.js';
import { resolveRefundableForPair, type FrozenInvoiceItemShare } from './refund-attribution.js';
import { round2 } from '../domain/money.js';
import { CREDIT_NOTE_COMPENSATION_TOLERANCE, creditNoteLinesFromInvoiceItems } from './cancel-with-credit-note.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
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
      'getByFinancialTransactionId' | 'markInvoiced' | 'getPendingByCompanyCustomerId'
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

  async requestInvoice(input: RequestInvoiceInput): Promise<Invoice> {
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
      // ORDER-10 (05/09/2026, architecture-governor) -- cierre de la
      // ventana TOCTOU con `OrderService.cancelOrder()`. Ambas rutas
      // toman el MISMO lock (`orders`, `FOR UPDATE`) antes de decidir:
      // sin esto, un `cancelOrder()` y un `requestInvoice()` concurrentes
      // sobre la misma orden podían entrelazarse -- la cancelación lee
      // "sin factura todavía" mientras la facturación, un instante
      // después, todavía no vio la orden CANCELLED -- y las dos avanzan.
      // Primera operación de la transacción a propósito: si la orden ya
      // está CANCELLED, no tiene sentido llegar a crear la fila de
      // `invoices` para después descartarla con el rollback.
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
    return this.issue(client, invoice, afipRequest, credentials.environment, profile.afipSalesPoint);
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
      // FACT-CONSOL-TOCTOU-01 -- primera operación de la transacción a propósito, mismo
      // criterio que el guard de `requestInvoice()`: si alguna ya está
      // CANCELLED no tiene sentido llegar a crear la fila de `invoices`
      // para después descartarla con el rollback. Rechaza el LOTE ENTERO
      // ante la primera que falle -- ver docblock del método.
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
    const original = await this.invoiceRepo.getById(tx.reversedInvoiceId);
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
    // grounding `auditor-circuitos-erp`) -- invariante de APLICACIÓN, no de
    // schema: `financial_transactions` no tiene CHECK que impida
    // `order_id` Y `reservation_id` no-nulos a la vez (solo disciplina de
    // los dos creadores del escape). Fail-loud ACÁ, antes de cualquier
    // rama, para no depender de una precedencia de código implícita
    // (¿reserva gana? ¿orden?) ni de que el guard de monto de más abajo
    // (`CreditNoteAttributionMismatchError`) la tape por casualidad cuando
    // los importes coinciden. Sin restringir por `tx.type`/`isFullReversal`
    // a propósito -- es un hecho sobre la FILA, no sobre qué rama la usa.
    // El CHECK real de schema que cerraría la PRODUCCIÓN de esta fila
    // (recomendado por el mismo grounding) queda como bloque de migración
    // aparte -- nada de schema en este commit.
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
    });

    return invoice;
  }

  /**
   * Un `requestInvoice()` que pega contra un comprobante que ya existe
   * (mismo `financial_transaction_id`, misma fila por el idempotency_key
   * determinístico) reintenta o no según qué tan seguro sea:
   *
   * - ISSUED: ya tiene CAE real de AFIP, nunca se vuelve a tocar.
   * - FAILED_UNCERTAIN con `afipContacted=true`: AFIP fue contactado y no
   *   se pudo confirmar qué pasó (A8.6) -- reintentar a ciegas podría
   *   duplicar un comprobante fiscal real. Se devuelve tal cual, requiere
   *   revisión manual (contra FECompUltimoAutorizado/getVoucherInfo)
   *   antes de habilitar un reintento.
   * - El resto (PENDING, REJECTED, o FAILED_UNCERTAIN con
   *   `afipContacted=false`): se sabe con certeza que no quedó nada
   *   emitido, reintento seguro reusando la MISMA fila y el MISMO
   *   `afipRequest` ya persistido (no se recalcula nada del cobro de
   *   nuevo -- ver R12, una transacción confirmada no se edita).
   */
  private async retryExisting(existing: Invoice): Promise<Invoice> {
    if (existing.status === 'ISSUED') return existing;
    if (existing.status === 'FAILED_UNCERTAIN' && existing.afipContacted) return existing;

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
  private async finalizeIssued(invoiceId: string, data: MarkIssuedInput): Promise<Invoice> {
    const issued = await this.invoiceRepo.markIssued(invoiceId, data);
    if (issued.financialTransactionId) {
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
    return issued;
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
      await this.invoiceRepo.markFailed(invoice.id, {
        status: 'REJECTED',
        errorMessage: obs,
        afipResponse: result.raw,
        afipContacted: true,
      });
      throw new AfipRequestRejectedError(invoice.id, obs);
    }

    if (!result.cbteDesde || !result.cae) {
      const message = `respuesta de AFIP sin CbteDesde/CAE pese a no venir Resultado='R': ${JSON.stringify(result.raw)}`;
      // AFIP respondió pero de forma inesperada -- genuinamente ambiguo,
      // requiere revisión manual antes de reintentar (A8.6).
      await this.invoiceRepo.markFailed(invoice.id, { status: 'FAILED_UNCERTAIN', errorMessage: message, afipResponse: result.raw, afipContacted: true });
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
    await this.invoiceRepo.markFailed(invoice.id, { status: 'FAILED_UNCERTAIN', errorMessage: message, afipContacted: true });
    throw new AfipRequestUncertainError(invoice.id, message);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** C1-Fase C — idempotencyKey determinística para un SET de financial_transaction_ids (orden no importa, join crudo podría superar VARCHAR(255)). Exportada: la reusa el test de idempotencia. */
export function hashIds(ids: string[]): string {
  return createHash('sha256').update([...ids].sort().join(',')).digest('hex').slice(0, 32);
}
