/**
 * @file arca-sdk-billing.adapter.ts
 * @description Implementación de `AfipBillingPort` sobre `@arcasdk/core`.
 * El parseo de `FeCabResp`/`FeDetResp` (antes adentro de
 * `InvoiceService.issue()`/`reconcileAfterFailure()`) vive acá ahora -- si
 * el día de mañana se migra de SDK, este es el único archivo que se
 * reemplaza por un adapter equivalente sobre el SDK nuevo.
 *
 * Tipos verificados contra los `.d.ts` reales instalados
 * (`electronic-billing.service.d.ts`, `voucher-result.dto.d.ts`,
 * `electronic-billing.types.d.ts`) -- no copiados de memoria.
 */

import type { Arca } from '@arcasdk/core';
import type { AfipCredentials, AfipCredentialsRepository } from './afip-credentials.repository.js';
import { buildAfipClient } from './afip-client.factory.js';
import type {
  AfipBillingPort,
  CreateVoucherResult,
  IvaReceptorTypeOption,
  LastVoucherResult,
  VoucherInfoResult,
} from './afip-billing.port.js';
import { withAfipTimeout } from './afip-request.timeout.js';

/**
 * D-20 (Wave 9 sub-bloque 3, 17/09/2026 --
 * docs/auditoria-integral-fase15-2026-09-16.md:579-599). El hallazgo
 * original proponía `request: { timeout }` al constructor de `Arca` --
 * ese punto de extensión SÍ existe adentro del SDK
 * (node_modules/@arcasdk/core/lib/infrastructure/soap/soap-client.js:68-78,
 * `request: adapterRequestOptions` -> `createSoapEngine({ requestOptions })`)
 * pero NO está alcanzable desde la superficie pública: `Arca`'s constructor
 * (infrastructure/composition/arca.js) arma `baseRepositoryConfig`/
 * `soapConfig` con solo `authRepository, cuit, production, useHttpsAgent,
 * useSoap12` -- nunca reenvía `request`/`requestOptions` -- y
 * `ElectronicBillingRepository.getClient()`
 * (infrastructure/repositories/electronic-billing/electronic-billing-repository.js)
 * llama `this.createSoapClient(wsdlName)` SIN opciones. Verificado leyendo
 * el código instalado, no asumido de la doc del hallazgo (re-verificado
 * de forma independiente por el gate en la segunda pasada). Parchear el
 * SDK (patch-package, que este repo ya usa para otras deps) para wirearlo
 * de verdad es más invasivo y no fue autorizado en este bloque -- en
 * cambio, `withAfipTimeout()` (`afip-request.timeout.ts`, mecanismo y
 * valor compartidos con `padron.service.ts` -- ver ese archivo para el
 * detalle del timer/log de asentamiento tardío) se aplica en los dos
 * únicos archivos de todo el repo que llaman al SDK real: este adapter
 * (`InvoiceService`) y `padron.service.ts` (autocompletado de padrón).
 * **Gate, primera pasada (HOLD):** la primera versión de este bloque solo
 * cubría este archivo -- las 3 llamadas reales de `padron.service.ts`
 * quedaban sin timeout, mismo riesgo de agotamiento de capacidad que este
 * bloque existe para resolver. Corregido moviendo el mecanismo a un
 * módulo compartido y aplicándolo también ahí.
 *
 * Para `createNextVoucher()` en particular, esto reproduce exactamente la
 * ambigüedad que `InvoiceService.issue()`/`reconcileAfterFailure()` YA
 * sabe resolver (FAILED_UNCERTAIN + afipContacted:true +
 * `getLastVoucher()` antes/después) -- no es una improvisación de este
 * bloque: AFIP mismo documenta ese patrón (consultar para desambiguar, vía
 * FECompConsultar -- acá `getLastVoucher()`/`getVoucherInfo()`) como el
 * camino correcto ante un timeout de WSFEv1
 * (docs/grounding-25-preguntas-2026-09-16.md:225). `InvoiceService` no se
 * modifica en este bloque: ya trata cualquier rechazo de
 * `createNextVoucher()` como ambiguo, timeout incluido. Ver
 * `afip-request.timeout.ts` para el detalle de por qué `createNextVoucher()`
 * es una llamada compuesta y el techo real de `issue()` es ~4x el valor
 * declarado, no 1x.
 *
 * **`getIvaReceptorTypes` -- duplicado sin resolver, documentado a
 * propósito.** Este método existe DOS veces con la misma firma: acá (parte
 * de `AfipBillingPort`) y en `padron.service.ts` (el que sirve
 * `GET /api/customers/padron/iva-receptor-types`, la ruta real). La copia
 * de ESTE archivo **no tiene ningún consumidor real en `src/`** --
 * `InvoiceService` nunca llama `port.getIvaReceptorTypes()` pese a que el
 * docblock de `afip-billing.port.ts` afirmaba que sí (afirmación falsa,
 * corregida en ese archivo en este mismo bloque: `PadronService` jamás
 * pasó por este puerto, siempre le pegó al SDK directo). No se retira acá
 * -- es superficie de `AfipBillingPort` ya pública y retirarla es una
 * decisión de API aparte, no decidida -- pero queda declarado: si el día
 * de mañana esto SÍ gana un consumidor real, ya trae su propio timeout
 * gratis (ya está envuelto), a diferencia de si se agregara un método
 * nuevo sin pasar por `withAfipTimeout()`.
 */

export class ArcaSdkBillingAdapter implements AfipBillingPort {
  constructor(private readonly client: Arca) {}

  async getLastVoucher(ptoVta: number, cbteTipo: number): Promise<LastVoucherResult> {
    const result = await withAfipTimeout(this.client.electronicBillingService.getLastVoucher(ptoVta, cbteTipo), 'getLastVoucher');
    return { cbteNro: result.cbteNro };
  }

  async createNextVoucher(request: Record<string, unknown>): Promise<CreateVoucherResult> {
    const result = await withAfipTimeout(this.client.electronicBillingService.createNextVoucher(request as never), 'createNextVoucher');
    const cabResp = result.response.FeCabResp;
    const detResp = result.response.FeDetResp?.FECAEDetResponse?.[0];

    // Mismo criterio que el issue() original: rechazado si CUALQUIERA de
    // los dos dice 'R' (a veces AFIP solo lo marca en el detalle).
    const isRejected = cabResp?.Resultado === 'R' || detResp?.Resultado === 'R';

    const observaciones = isRejected
      ? (detResp?.Observaciones?.Obs ?? []).map((o) => `${o.Code}: ${o.Msg}`).join('; ')
          || (result.response.Errors?.Err ?? []).map((e) => `${e.Code}: ${e.Msg}`).join('; ')
          || 'sin detalle'
      : null;

    return {
      resultado: isRejected ? 'R' : ((cabResp?.Resultado ?? detResp?.Resultado ?? null) as 'A' | 'R' | null),
      cae: result.cae || null,
      caeFchVto: result.caeFchVto || null,
      cbteDesde: detResp?.CbteDesde ?? null,
      observaciones,
      raw: result.response,
    };
  }

  async getVoucherInfo(cbteNro: number, ptoVta: number, cbteTipo: number): Promise<VoucherInfoResult | null> {
    // Nombres en camelCase acá (codAutorizacion/fchVto) -- este DTO del
    // SDK normaliza el XML crudo de AFIP, a diferencia de
    // CreateVoucherResultDto que expone cae/caeFchVto directo.
    const info = await withAfipTimeout(this.client.electronicBillingService.getVoucherInfo(cbteNro, ptoVta, cbteTipo), 'getVoucherInfo');
    if (!info) return null;
    return {
      codAutorizacion: info.codAutorizacion ?? null,
      fchVto: info.fchVto ?? null,
      raw: info,
    };
  }

  async getIvaReceptorTypes(claseCmp?: string): Promise<IvaReceptorTypeOption[]> {
    const result = await withAfipTimeout(this.client.electronicBillingService.getIvaReceptorTypes(claseCmp), 'getIvaReceptorTypes');
    return (result.resultGet?.condicionIvaReceptor ?? []).map((t) => ({ id: t.id, description: t.desc, cmpClase: t.cmp_Clase }));
  }
}

export function buildArcaBillingAdapter(client: Arca): AfipBillingPort {
  return new ArcaSdkBillingAdapter(client);
}

/**
 * Factory por defecto de `InvoiceService` -- arma el cliente `Arca` crudo
 * y lo envuelve en el adapter, en un solo paso. Firma compatible con
 * `AfipBillingPortFactory` (invoice.service.ts).
 */
export function buildDefaultAfipBillingPort(
  credentials: AfipCredentials,
  taxId: string,
  credentialsRepo: AfipCredentialsRepository,
): AfipBillingPort {
  return buildArcaBillingAdapter(buildAfipClient(credentials, taxId, credentialsRepo));
}
