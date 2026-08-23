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

  /**
   * Un Ticket de Acceso de WSAA está scoped a UN SOLO servicio de ARCA
   * (`wsfe`, `ws_sr_padron_a5`, `ws_sr_padron_a13`, ...) -- `serviceName`
   * particiona el cache por servicio. Bug real en producción (23/08/2026,
   * pendientes-2026-08-23.md): antes de esto había un solo ticket por
   * negocio, así que un ticket obtenido para `wsfe` se reusaba para el
   * padrón y ARCA lo rechazaba con "Token recibido es para el servicio
   * [wsfe], debería ser para servicio [ws_sr_padron_a5,...]".
   */
  getTicket(serviceName: string): Promise<AfipTicketCache | null>;
  saveTicket(serviceName: string, credentialsJson: string, expiresAt: Date): Promise<void>;
  clearTicket(serviceName: string): Promise<void>;
}
