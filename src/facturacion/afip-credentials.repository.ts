/**
 * @file afip-credentials.repository.ts
 * @description Certificado/clave de AFIP del negocio — SEPARADO de
 * `BusinessProfileRepository` a propósito, aunque viven en la misma tabla
 * (`business_profile`). El resto del perfil fiscal (razón social, CUIT,
 * domicilio) es información pública del negocio que ya viaja entera en
 * `GET /api/business-profile`; el certificado y la clave privada NUNCA
 * deben poder salir por ese mismo camino, ni siquiera cifrados — un
 * repositorio propio, con un método de lectura explícitamente separado
 * para el uso interno del servicio de facturación (`getDecrypted()`) y
 * otro de solo estado para lo que sí es seguro exponer por HTTP
 * (`getStatus()`), hace que "devolver el secreto por error" requiera un
 * cambio deliberado, no un descuido en un mapper compartido.
 */

export type AfipEnvironment = 'homologacion' | 'produccion';

export interface AfipCredentialsStatus {
  configured: boolean;
  environment: AfipEnvironment | null;
}

export interface AfipCredentials {
  cert: string;
  key: string;
  environment: AfipEnvironment;
}

/** Ticket de Acceso de WSAA cacheado — Token+Sign, vencen a las 12hs de emitidos. */
export interface AfipTicketCache {
  credentials: string;
  expiresAt: Date;
}

export interface AfipCredentialsRepository {
  getStatus(): Promise<AfipCredentialsStatus>;
  /** Uso exclusivo del servicio de facturación — nunca exponer por HTTP. */
  getDecrypted(): Promise<AfipCredentials | null>;
  save(cert: string, key: string, environment: AfipEnvironment): Promise<void>;
  clear(): Promise<void>;

  getTicket(): Promise<AfipTicketCache | null>;
  saveTicket(credentialsJson: string, expiresAt: Date): Promise<void>;
  clearTicket(): Promise<void>;
}
