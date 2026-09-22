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
import { AfipPadronUnavailableError } from '../domain/errors.js';
import { withAfipTimeout } from './afip-request.timeout.js';
import { logger } from '../logger.js';

/**
 * El SDK (`base-register-repository.js::getTaxpayerDetails`,
 * `register-scope-thirteen.repository.js::getTaxIDByDocument`) ya
 * distingue "no encontrado" (`isAfipNotFoundError`: `code === 602` o
 * mensaje con "no existe") y devuelve `null`/`[]` en ese caso -- no hace
 * falta duplicar esa lógica acá. Lo que SÍ hacía falta (bug en
 * producción, 23/08/2026): cualquier OTRA excepción (timeout, fault SOAP
 * con forma que `isAfipNotFoundError` no reconoce, credencial inválida en
 * runtime) se colaba sin envolver hasta el catch-all de
 * `error.middleware.ts` y salía como 500 genérico, sin loguear el detalle
 * real del fault. Esto la traduce a un error de dominio (503, es un
 * problema de infraestructura externa) y deja el error crudo en el log
 * del servidor para poder diagnosticar la próxima vez que pase.
 *
 * D-20 (Wave 9 sub-bloque 3, 17/09/2026, gate `architecture-governor` --
 * HOLD de la primera pasada): las 3 llamadas reales al SDK de este
 * archivo (`getTaxpayerByCuit`/`resolveCuitByDni`/`getIvaReceptorTypes`,
 * las tres detrás de rutas autenticadas de autocompletado,
 * `POST/GET /api/customers/padron/...`) ahora van envueltas en
 * `withAfipTimeout()` (`afip-request.timeout.ts`, mismo mecanismo y valor
 * que `arca-sdk-billing.adapter.ts`) DENTRO del `fn()` que recibe este
 * helper -- así un timeout entra por el mismo `catch` que cualquier otra
 * falla del SDK y sale como `AfipPadronUnavailableError`/503, no como un
 * error genérico. Antes de este bloque, `getIvaReceptorTypes()` ni
 * siquiera pasaba por `callPadron()` (inconsistente con los otros dos
 * métodos) -- corregido acá como efecto colateral necesario para poder
 * envolverlo con el mismo patrón; no había ningún test que fijara su
 * forma de error anterior (era simplemente lo que el SDK tirara crudo).
 */
async function callPadron<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.error({ err: error, operation }, '[PadronService] Falla no esperada');
    const cause = error instanceof Error ? error.message : String(error);
    throw new AfipPadronUnavailableError(operation, cause);
  }
}

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
  /** Clase de comprobante para la que ARCA habilita esta condición (`ClaseCmp` de `FEParamGetCondicionIvaReceptor`) -- Wave 14/P-16, §12.3. */
  cmpClase: string;
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
    const details = await callPadron('getTaxpayerByCuit', () =>
      withAfipTimeout(client.registerScopeFiveService.getTaxpayerDetails(Number(cuit)), 'getTaxpayerByCuit'),
    );
    if (!details) return null;
    return this.mapTaxpayerDetails(cuit, details);
  }

  /** `null` si el DNI no tiene ningún CUIT/CUIL asociado en el padrón. */
  async resolveCuitByDni(dni: string): Promise<string | null> {
    const client = await resolveAfipClient(this.businessProfileRepo, this.afipCredentialsRepo, this.clientFactory);
    const result = await callPadron('resolveCuitByDni', () =>
      withAfipTimeout(client.registerScopeThirteenService.getTaxIDByDocument(dni), 'resolveCuitByDni'),
    );
    const first = result.idPersona?.[0];
    return first != null ? String(first) : null;
  }

  /** `claseCmp` opcional (mismo parámetro que expone el SDK) -- sin él, ARCA devuelve el catálogo completo. */
  async getIvaReceptorTypes(claseCmp?: string): Promise<IvaReceptorTypeOption[]> {
    const client = await resolveAfipClient(this.businessProfileRepo, this.afipCredentialsRepo, this.clientFactory);
    const result = await callPadron('getIvaReceptorTypes', () =>
      withAfipTimeout(client.electronicBillingService.getIvaReceptorTypes(claseCmp), 'getIvaReceptorTypes'),
    );
    return (result.resultGet?.condicionIvaReceptor ?? []).map((t) => ({ id: t.id, description: t.desc, cmpClase: t.cmp_Clase }));
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
