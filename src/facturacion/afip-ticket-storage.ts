import { AccessTicket, type ITicketStoragePort, type ArcaServiceName } from '@arcasdk/core';
import type { AfipCredentialsRepository } from './afip-credentials.repository.js';

/**
 * `ITicketStoragePort` del SDK (`@arcasdk/core`) respaldado en Postgres
 * (`business_profile.afip_ticket_*`, vía `AfipCredentialsRepository`) en
 * vez del filesystem local que usa por default -- este proceso puede
 * correr en cualquier instancia de Render, un ticket en disco no
 * sobrevive un restart ni se comparte entre instancias. Solo se usa el
 * servicio WSFE en este negocio, así que `serviceName` no se usa para
 * particionar nada -- un ticket por negocio alcanza (la tabla ya es
 * singleton, `business_profile` = un negocio = una tenant DB).
 */
export class SqlAfipTicketStorage implements ITicketStoragePort {
  constructor(private readonly credentialsRepo: AfipCredentialsRepository) {}

  async save(ticket: AccessTicket, _serviceName: ArcaServiceName): Promise<void> {
    await this.credentialsRepo.saveTicket(
      JSON.stringify(ticket.toLoginCredentials()),
      ticket.getExpiration(),
    );
  }

  async get(_serviceName: ArcaServiceName): Promise<AccessTicket | null> {
    const cached = await this.credentialsRepo.getTicket();
    if (!cached) return null;
    const ticket = AccessTicket.create(JSON.parse(cached.credentials));
    // Doble chequeo: además del `isExpired()` propio del ticket (que el
    // SDK ya usa internamente), si por lo que sea el reloj guardado y el
    // real divergen, no hay downside en confiar en isExpired() -- es la
    // misma fuente que usa la librería para decidir si re-autenticar.
    if (ticket.isExpired()) {
      await this.credentialsRepo.clearTicket();
      return null;
    }
    return ticket;
  }

  async delete(_serviceName: ArcaServiceName): Promise<void> {
    await this.credentialsRepo.clearTicket();
  }
}
