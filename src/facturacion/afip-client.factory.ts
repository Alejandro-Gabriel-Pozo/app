import { Arca } from '@arcasdk/core';
import type { AfipCredentials } from './afip-credentials.repository.js';
import { SqlAfipTicketStorage } from './afip-ticket-storage.js';
import type { AfipCredentialsRepository } from './afip-credentials.repository.js';

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
