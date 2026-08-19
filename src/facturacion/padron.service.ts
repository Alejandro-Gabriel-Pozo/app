/**
 * @file padron.service.ts
 * @description Consulta al padrón de ARCA (WS_SR_PADRON_A5/A13) para
 * autocompletar datos fiscales de un cliente — decisión de arquitectura ya
 * tomada en el código (comentarios en `afip-catalog.constants.ts` e
 * `invoice-pdf.service.ts`: "confirmar contra getIvaReceptorTypes() del
 * SDK apenas haya certificado real") pero nunca conectada hasta ahora
 * (19/08/2026, auditoría de producto).
 *
 * Tres consultas, misma orquestación de cliente AFIP que `InvoiceService`
 * (`resolveAfipClient`, afip-client.factory.ts):
 * - `getTaxpayerByCuit(cuit)` — razón social/condición IVA/domicilio de un
 *   CUIT. Usa `registerScopeFiveService` (ws_sr_padron_a5) — el servicio
 *   moderno que cubre tanto Monotributo como Régimen General.
 * - `resolveCuitByDni(dni)` — resuelve el/los CUIT asociados a un DNI
 *   (`registerScopeThirteenService`, ws_sr_padron_a13). Puede haber más de
 *   uno; se toma el primero para autocompletar.
 * - `getIvaReceptorTypes()` — catálogo OFICIAL de condición IVA del
 *   receptor, en vez de la lista hardcodeada de `afip-catalog.constants.ts`
 *   (que documenta explícitamente que había que hacer esto "apenas haya
 *   certificado real").
 *
 * ## Advertencia sobre los tipos del SDK — verificado, no adivinado
 * `@arcasdk/core` declara `TaxpayerDetailsDto.datosGenerales` con un tipo
 * angosto (sin `razonSocial`/`apellido`/`nombre`/`domicilioFiscal`), pero
 * leyendo la implementación real
 * (`base-register-repository.js::mapPersonaReturnToDto()`) ese campo pasa
 * el `persona.datosGenerales` CRUDO de la respuesta SOAP sin proyectarlo —
 * en runtime sí trae esos campos. Mismo patrón que el bug de
 * `Buffer`/`Uint8Array` y `cae_vto` de esta sesión: el `.d.ts` de una
 * dependencia no es garantía de lo que devuelve en runtime. `RawDatosGenerales`
 * abajo tipa lo que realmente llega (persona-service-a5.types.d.ts,
 * `IdatosGenerales`), no lo que el DTO normalizado promete.
 *
 * ## Minimización (A7.3, criterios-negocio.md)
 * El padrón devuelve muchísimo más de lo que hace falta (actividades,
 * régimen previsional, fecha de nacimiento/fallecimiento, etc.) — acá solo
 * se extrae legalName/condición/domicilio, lo mínimo para autocompletar
 * `customer_tax_profiles`. El resto de la respuesta se descarta, nunca se
 * persiste ni se devuelve completo.
 */

import type { TaxpayerDetailsDto } from '@arcasdk/core';
import type { AfipCredentialsRepository } from './afip-credentials.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { resolveAfipClient, buildAfipClient } from './afip-client.factory.js';
import type { AfipClientFactory } from './afip-client.factory.js';

export interface PadronAddress {
  line1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  /** El padrón de ARCA solo cubre contribuyentes argentinos. */
  country: 'AR';
}

export interface TaxpayerLookupResult {
  cuit: string;
  legalName: string | null;
  taxCondition: 'MONOTRIBUTO' | 'REGIMEN_GENERAL' | null;
  address: PadronAddress | null;
}

export interface IvaReceptorTypeOption {
  id: number;
  description: string;
}

/** Ver docblock del archivo — lo que realmente llega, no lo que el SDK declara. */
interface RawDatosGenerales {
  razonSocial?: string;
  apellido?: string;
  nombre?: string;
  domicilioFiscal?: {
    direccion?: string;
    localidad?: string;
    descripcionProvincia?: string;
    codPostal?: string;
  };
}

export class PadronService {
  constructor(
    private readonly businessProfileRepo: BusinessProfileRepository,
    private readonly afipCredentialsRepo: AfipCredentialsRepository,
    private readonly clientFactory: AfipClientFactory = buildAfipClient,
  ) {}

  /** `null` si el CUIT no existe en el padrón (no es un error — CUIT mal tipeado, ej.). */
  async getTaxpayerByCuit(cuit: string): Promise<TaxpayerLookupResult | null> {
    const client = await resolveAfipClient(this.businessProfileRepo, this.afipCredentialsRepo, this.clientFactory);
    const details = await client.registerScopeFiveService.getTaxpayerDetails(Number(cuit));
    if (!details) return null;
    return this.mapTaxpayerDetails(cuit, details);
  }

  /** `null` si el DNI no tiene ningún CUIT/CUIL asociado en el padrón. */
  async resolveCuitByDni(dni: string): Promise<string | null> {
    const client = await resolveAfipClient(this.businessProfileRepo, this.afipCredentialsRepo, this.clientFactory);
    const result = await client.registerScopeThirteenService.getTaxIDByDocument(dni);
    const first = result.idPersona?.[0];
    return first != null ? String(first) : null;
  }

  /** `claseCmp` opcional (mismo parámetro que expone el SDK) -- sin él, ARCA devuelve el catálogo completo. */
  async getIvaReceptorTypes(claseCmp?: string): Promise<IvaReceptorTypeOption[]> {
    const client = await resolveAfipClient(this.businessProfileRepo, this.afipCredentialsRepo, this.clientFactory);
    const result = await client.electronicBillingService.getIvaReceptorTypes(claseCmp);
    return (result.resultGet?.condicionIvaReceptor ?? []).map((t) => ({ id: t.id, description: t.desc }));
  }

  private mapTaxpayerDetails(cuit: string, details: TaxpayerDetailsDto): TaxpayerLookupResult {
    const raw = (details.datosGenerales ?? {}) as unknown as RawDatosGenerales;

    const legalName =
      raw.razonSocial?.trim() ||
      [raw.nombre, raw.apellido].filter(Boolean).join(' ').trim() ||
      null;

    const taxCondition: TaxpayerLookupResult['taxCondition'] = details.datosMonotributo
      ? 'MONOTRIBUTO'
      : details.datosRegimenGeneral
        ? 'REGIMEN_GENERAL'
        : null;

    const dom = raw.domicilioFiscal;
    const address: PadronAddress | null = dom
      ? {
          line1: dom.direccion ?? null,
          city: dom.localidad ?? null,
          state: dom.descripcionProvincia ?? null,
          postalCode: dom.codPostal ?? null,
          country: 'AR',
        }
      : null;

    return { cuit, legalName, taxCondition, address };
  }
}
