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

export class ArcaSdkBillingAdapter implements AfipBillingPort {
  constructor(private readonly client: Arca) {}

  async getLastVoucher(ptoVta: number, cbteTipo: number): Promise<LastVoucherResult> {
    const result = await this.client.electronicBillingService.getLastVoucher(ptoVta, cbteTipo);
    return { cbteNro: result.cbteNro };
  }

  async createNextVoucher(request: Record<string, unknown>): Promise<CreateVoucherResult> {
    const result = await this.client.electronicBillingService.createNextVoucher(request as never);
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
    const info = await this.client.electronicBillingService.getVoucherInfo(cbteNro, ptoVta, cbteTipo);
    if (!info) return null;
    return {
      codAutorizacion: info.codAutorizacion ?? null,
      fchVto: info.fchVto ?? null,
      raw: info,
    };
  }

  async getIvaReceptorTypes(claseCmp?: string): Promise<IvaReceptorTypeOption[]> {
    const result = await this.client.electronicBillingService.getIvaReceptorTypes(claseCmp);
    return (result.resultGet?.condicionIvaReceptor ?? []).map((t) => ({ id: t.id, description: t.desc }));
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
