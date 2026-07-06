import type { SqlClient } from './sql.client.js';

export interface DomainEvent {
  /** Asignado por la BD (BIGSERIAL). Undefined antes de persistir. */
  id?: number;
  businessId: string;
  /** 'RESERVATION' | 'CUSTOMER' | 'INVOICE' | ... */
  aggregateType: string;
  aggregateId: string;
  /** 'reservation.confirmed' | 'reservation.completed' | 'customer.created' | ... */
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
  /** NULL hasta que el OutboxWorker lo procese. */
  dispatchedAt?: Date | null;
}

export interface DomainEventRepository {
  /**
   * Inserta el evento usando el SqlClient de una transacción activa.
   * NUNCA abrir una conexión nueva aquí — usar el client recibido.
   */
  insertWithClient(client: SqlClient, event: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>): Promise<void>;

  /** Lee eventos pendientes (dispatched_at IS NULL) ordenados por id ASC. */
  getPending(limit: number): Promise<DomainEvent[]>;

  /** Marca el evento como procesado. Idempotente si ya tiene dispatched_at. */
  markDispatched(id: number): Promise<void>;
}
