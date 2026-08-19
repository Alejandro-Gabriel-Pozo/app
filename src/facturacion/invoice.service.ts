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
import type { Arca } from '@arcasdk/core';
import type { InvoiceRepository } from './invoice.repository.js';
import type { Invoice, AfipEnvironment } from './invoice.entities.js';
import type { AfipCredentialsRepository } from './afip-credentials.repository.js';
import type { FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { buildAfipClient } from './afip-client.factory.js';
import type { AfipClientFactory } from './afip-client.factory.js';
import {
  CBTE_TIPO_FACTURA_B,
  CONCEPTO_SERVICIOS,
  DOC_TIPO_CONSUMIDOR_FINAL,
  CONDICION_IVA_RECEPTOR_CONSUMIDOR_FINAL,
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

export class InvoiceService {
  constructor(
    private readonly invoiceRepo: InvoiceRepository,
    private readonly financialTransactionRepo: FinancialTransactionRepository,
    private readonly businessProfileRepo: BusinessProfileRepository,
    private readonly afipCredentialsRepo: AfipCredentialsRepository,
    private readonly clientFactory: AfipClientFactory = buildAfipClient,
  ) {}

  /**
   * Desglosa `amount` (el total ya cobrado, `financial_transactions.amount`)
   * en neto + IVA según la config REAL del negocio (A2.9 —
   * `prices_include_iva`/`default_iva_rate`, nunca un supuesto fijo).
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
    const { impNeto, impIva, impTotal } = this.splitAmount(tx.amount, profile.pricesIncludeIva, profile.defaultIvaRate);

    const invoiceId = randomUUID();
    const cbteFch = toAfipDate(new Date());

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
      ...(impIva > 0 && { Iva: [{ Id: 5, BaseImp: impNeto, Importe: impIva }] }), // Id 5 = 21%, ver afip-catalog.constants.ts
    };

    const invoice = await this.invoiceRepo.create(
      {
        id: invoiceId,
        businessId: input.businessId,
        financialTransactionId: input.financialTransactionId,
        customerId: tx.customerId,
        idempotencyKey,
        environment: credentials.environment,
        ptoVta: profile.afipSalesPoint,
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
    );

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
    client: Arca,
    invoice: Invoice,
    afipRequest: Record<string, unknown>,
    environment: AfipEnvironment,
    ptoVta: number,
  ): Promise<Invoice> {
    const billing = client.electronicBillingService;

    let lastVoucherBefore: number;
    try {
      lastVoucherBefore = (await billing.getLastVoucher(ptoVta, invoice.cbteTipo)).cbteNro;
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
      result = await billing.createNextVoucher(afipRequest as never);
    } catch (err) {
      return this.reconcileAfterFailure(client, invoice, ptoVta, lastVoucherBefore, errMessage(err));
    }

    const cabResp = result.response.FeCabResp;
    const detResp = result.response.FeDetResp?.FECAEDetResponse?.[0];

    if (cabResp?.Resultado === 'R' || detResp?.Resultado === 'R') {
      const obs = (detResp?.Observaciones?.Obs ?? []).map((o) => `${o.Code}: ${o.Msg}`).join('; ')
        || (result.response.Errors?.Err ?? []).map((e) => `${e.Code}: ${e.Msg}`).join('; ')
        || 'sin detalle';
      // AFIP evaluó y dijo que no -- confirmado que no quedó nada emitido,
      // reintentable solo una vez corregido lo que haya rechazado.
      await this.invoiceRepo.markFailed(invoice.id, {
        status: 'REJECTED',
        errorMessage: obs,
        afipResponse: result.response,
        afipContacted: true,
      });
      throw new AfipRequestRejectedError(invoice.id, obs);
    }

    if (!detResp?.CbteDesde || !result.cae) {
      const message = `respuesta de AFIP sin CbteDesde/CAE pese a no venir Resultado='R': ${JSON.stringify(result.response)}`;
      // AFIP respondió pero de forma inesperada -- genuinamente ambiguo,
      // requiere revisión manual antes de reintentar (A8.6).
      await this.invoiceRepo.markFailed(invoice.id, { status: 'FAILED_UNCERTAIN', errorMessage: message, afipResponse: result.response, afipContacted: true });
      throw new AfipRequestUncertainError(invoice.id, message);
    }

    return this.invoiceRepo.markIssued(invoice.id, {
      cbteNro: detResp.CbteDesde,
      cae: result.cae,
      caeVto: afipDateToIso(result.caeFchVto),
      afipResponse: result.response,
    });
  }

  /** A8.6 — reconciliación después de una falla ambigua, nunca un reintento directo. */
  private async reconcileAfterFailure(
    client: Arca,
    invoice: Invoice,
    ptoVta: number,
    lastVoucherBefore: number,
    originalErrorMessage: string,
  ): Promise<Invoice> {
    const billing = client.electronicBillingService;
    let lastVoucherAfter: number | null = null;
    try {
      lastVoucherAfter = (await billing.getLastVoucher(ptoVta, invoice.cbteTipo)).cbteNro;
    } catch {
      // no se pudo ni reconciliar -- queda incierto, un humano lo revisa a mano.
    }

    if (lastVoucherAfter !== null && lastVoucherAfter > lastVoucherBefore) {
      // AFIP SÍ procesó el pedido pese al error de red del lado cliente --
      // se recupera el CAE real en vez de perderlo o pedir uno nuevo.
      // Nombres en camelCase acá (codAutorizacion/fchVto) -- este DTO del
      // SDK normaliza el XML crudo de AFIP (CAE/CAEFchVto), a diferencia
      // de CreateVoucherResultDto que sí expone `cae`/`caeFchVto` directo.
      const info = await billing.getVoucherInfo(lastVoucherAfter, ptoVta, invoice.cbteTipo).catch(() => null);
      if (info?.codAutorizacion) {
        return this.invoiceRepo.markIssued(invoice.id, {
          cbteNro: lastVoucherAfter,
          cae: info.codAutorizacion,
          caeVto: info.fchVto ? afipDateToIso(info.fchVto) : afipDateToIso(toAfipDate(new Date())),
          afipResponse: info,
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
