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

import { randomUUID } from 'node:crypto';
import type { InvoiceRepository } from './invoice.repository.js';
import type { Invoice, AfipEnvironment, CreateInvoiceItemInput } from './invoice.entities.js';
import type { AfipCredentials, AfipCredentialsRepository } from './afip-credentials.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { IOrderRepository } from '../pos-menu/order.repository.js';
import type { OrderItem } from '../pos-menu/order.entities.js';
import type { IProductRepository, IProductVariantRepository } from '../pos-menu/product.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { buildDefaultAfipBillingPort } from './arca-sdk-billing.adapter.js';
import type { AfipBillingPort } from './afip-billing.port.js';
import {
  CBTE_TIPO_FACTURA_B,
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
} from '../domain/errors.js';

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
    private readonly orderRepo: Pick<IOrderRepository, 'getById'>,
    /** D8-Nivel B — nombre/unidad/código ARCA de cada línea PRODUCT. */
    private readonly productRepo: Pick<IProductRepository, 'getById'>,
    private readonly productVariantRepo: Pick<IProductVariantRepository, 'getById'>,
    /** D8-Nivel B — nombre del recurso/servicio para la línea de una reserva. */
    private readonly reservationRepo: Pick<ReservationRepository, 'getById'>,
    /** D8-Nivel B — el comprobante y sus líneas se crean en la misma transacción (A8.2/A8.3). */
    private readonly transactionManager: TransactionManager,
    private readonly clientFactory: AfipBillingPortFactory = buildDefaultAfipBillingPort,
  ) {}

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
        reservationId: item.reservationId,
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

    const buyer = input.buyer ?? CONSUMIDOR_FINAL;
    const concepto = input.concepto ?? CONCEPTO_SERVICIOS;

    // D8-Nivel B (23/08/2026) -- líneas reales del comprobante. El
    // agrupado por tasa para Iva[] (D8) se deriva de ESTAS líneas, no de
    // una lectura aparte de order_items (R14, un solo cómputo).
    const items = await this.resolveInvoiceItems(tx, profile, concepto);
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

    const invoiceId = randomUUID();
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

    // D8-Nivel B -- el comprobante y sus líneas se crean atómicamente
    // (A8.2/A8.3): nunca una factura persistida sin ninguna línea por una
    // falla a mitad de camino.
    let invoice!: Invoice;
    await this.transactionManager.run(async (client: SqlClient) => {
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
    });

    const client = this.clientFactory(credentials, authCuit, this.afipCredentialsRepo);
    return this.issue(client, invoice, afipRequest, credentials.environment, profile.afipSalesPoint);
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

    return this.invoiceRepo.markIssued(invoice.id, {
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
        return this.invoiceRepo.markIssued(invoice.id, {
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
