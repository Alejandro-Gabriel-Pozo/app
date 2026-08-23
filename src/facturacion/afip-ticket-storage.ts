import { AccessTicket, type ITicketStoragePort, type ArcaServiceName } from '@arcasdk/core';
import type { AfipCredentialsRepository } from './afip-credentials.repository.js';

/**
 * `ITicketStoragePort` del SDK (`@arcasdk/core`) respaldado en Postgres
 * (tabla `afip_tickets`, vía `AfipCredentialsRepository`) en vez del
 * filesystem local que usa por default -- este proceso puede correr en
 * cualquier instancia de Render, un ticket en disco no sobrevive un
 * restart ni se comparte entre instancias.
 *
 * `serviceName` SÍ particiona el cache (bug real en producción,
 * 23/08/2026, pendientes-2026-08-23.md): un Ticket de Acceso de WSAA está
 * scoped a un solo servicio de ARCA -- un ticket obtenido para `wsfe` no
 * sirve para `ws_sr_padron_a5`/`ws_sr_padron_a13`, ARCA lo rechaza con un
 * SOAP fault ("Token recibido es para el servicio [wsfe], debería ser
 * para servicio [...]"). La versión anterior de este archivo asumía "solo
 * se usa WSFE en este negocio" y ese supuesto dejó de ser cierto en
 * cuanto `PadronService` empezó a pedir tickets para otros servicios.
 */
export class SqlAfipTicketStorage implements ITicketStoragePort {
  constructor(private readonly credentialsRepo: AfipCredentialsRepository) {}

  async save(ticket: AccessTicket, serviceName: ArcaServiceName): Promise<void> {
    await this.credentialsRepo.saveTicket(
      serviceName,
      JSON.stringify(ticket.toLoginCredentials()),
      ticket.getExpiration(),
    );
  }

  async get(serviceName: ArcaServiceName): Promise<AccessTicket | null> {
    const cached = await this.credentialsRepo.getTicket(serviceName);
    if (!cached) return null;
    const ticket = AccessTicket.create(JSON.parse(cached.credentials));
    // Doble chequeo: además del `isExpired()` propio del ticket (que el
    // SDK ya usa internamente), si por lo que sea el reloj guardado y el
    // real divergen, no hay downside en confiar en isExpired() -- es la
    // misma fuente que usa la librería para decidir si re-autenticar.
    if (ticket.isExpired()) {
      await this.credentialsRepo.clearTicket(serviceName);
      return null;
    }
    return ticket;
  }

  async delete(serviceName: ArcaServiceName): Promise<void> {
    await this.credentialsRepo.clearTicket(serviceName);
  }
}
