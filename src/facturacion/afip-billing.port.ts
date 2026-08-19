/**
 * @file afip-billing.port.ts
 * @description Frontera entre `InvoiceService` y el SDK de facturación
 * electrónica (hoy `@arcasdk/core`). El `afipRequest` de entrada queda
 * IGUAL sin importar el SDK -- es el protocolo crudo WSFEv1 (ver docblock
 * de `requestInvoice()` en `invoice.service.ts`). Lo que cambia entre
 * SDKs es cómo se llama al método y la forma de la RESPUESTA, así que es
 * eso lo que este puerto normaliza. Migrar a otro SDK = escribir un
 * adapter nuevo que implemente esto; `InvoiceService` no se toca.
 *
 * Solo 4 métodos -- los que `InvoiceService`/`PadronService` realmente
 * invocan de `electronicBillingService`, no todo `@arcasdk/core`. Si este
 * puerto empezara a crecer mucho más allá de eso, sería señal de que se
 * está envolviendo el SDK entero "por las dudas", no el borde real.
 */

export interface LastVoucherResult {
  cbteNro: number;
}

export interface CreateVoucherResult {
  /** 'A' = aprobado, 'R' = rechazado -- ya resuelto (cabResp Y detResp evaluados), no crudo. */
  resultado: 'A' | 'R' | null;
  cae: string | null;
  /** yyyymmdd, mismo formato que CbteFch (ver toAfipDate en invoice.service.ts). */
  caeFchVto: string | null;
  cbteDesde: number | null;
  /** Motivo de rechazo si resultado === 'R', ya formateado "Code: Msg; Code: Msg". null si no hubo rechazo. */
  observaciones: string | null;
  /** Respuesta cruda del SDK -- se persiste tal cual en invoices.afip_response (auditoría, A9.4), no se pierde al normalizar. */
  raw: unknown;
}

export interface VoucherInfoResult {
  codAutorizacion: string | null;
  fchVto: string | null;
  raw: unknown;
}

export interface IvaReceptorTypeOption {
  id: number;
  description: string;
}

export interface AfipBillingPort {
  getLastVoucher(ptoVta: number, cbteTipo: number): Promise<LastVoucherResult>;
  createNextVoucher(request: Record<string, unknown>): Promise<CreateVoucherResult>;
  getVoucherInfo(cbteNro: number, ptoVta: number, cbteTipo: number): Promise<VoucherInfoResult | null>;
  getIvaReceptorTypes(claseCmp?: string): Promise<IvaReceptorTypeOption[]>;
}
