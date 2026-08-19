import { Arca } from '@arcasdk/core';
import type { AfipCredentials } from './afip-credentials.repository.js';
import { SqlAfipTicketStorage } from './afip-ticket-storage.js';
import type { AfipCredentialsRepository } from './afip-credentials.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { AfipNotConfiguredError } from '../domain/errors.js';

/**
 * Arma el cliente del SDK a partir del certificado/clave YA
 * desencriptados (`AfipCredentialsRepository.getDecrypted()`) y del CUIT
 * del propio negocio (`business_profile.taxId`) -- WSAA autentica "como"
 * ese CUIT, tiene que ser el mismo que emitió el certificado.
 */
export function buildAfipClient(
  credentials: AfipCredentials,
  taxId: string,
  credentialsRepo: AfipCredentialsRepository,
): Arca {
  return new Arca({
    cuit: Number(taxId),
    cert: credentials.cert,
    key: credentials.key,
    production: credentials.environment === 'produccion',
    ticketStorage: new SqlAfipTicketStorage(credentialsRepo),
  });
}

/** Firma de `buildAfipClient` — inyectable para poder testear la orquestación sin pegarle al SDK real. */
export type AfipClientFactory = (
  credentials: AfipCredentials,
  taxId: string,
  credentialsRepo: AfipCredentialsRepository,
) => Arca;

/**
 * Resuelve credenciales + CUIT de autenticación y arma el cliente `Arca`
 * ya autenticado -- mismo camino que usa `InvoiceService` (requestInvoice/
 * retryExisting), factorizado acá (19/08/2026) para que `PadronService`
 * (consulta al padrón de ARCA) no repita esta orquestación. R14
 * (criterios-datos.md): un solo camino para resolver el cliente AFIP, no
 * una copia por servicio.
 */
export async function resolveAfipClient(
  businessProfileRepo: BusinessProfileRepository,
  afipCredentialsRepo: AfipCredentialsRepository,
  clientFactory: AfipClientFactory = buildAfipClient,
): Promise<Arca> {
  const profile = await businessProfileRepo.get();
  // afipCuit (schema v25) gana si está cargado -- CUIT de AUTENTICACIÓN,
  // puede diferir del legal (taxId) en homologación.
  const authCuit = profile.afipCuit ?? profile.taxId;
  if (!authCuit) throw new AfipNotConfiguredError('falta cargar el CUIT del negocio en Mi Negocio');

  const credentials = await afipCredentialsRepo.getDecrypted();
  if (!credentials) throw new AfipNotConfiguredError('falta cargar el certificado AFIP en Mi Negocio');

  return clientFactory(credentials, authCuit, afipCredentialsRepo);
}
