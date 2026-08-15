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
  /** Intentos de despacho fallidos consecutivos. */
  retryCount?: number;
  /** NULL mientras está pendiente/despachado. Set → dead-letter (A9.5/A8.7). */
  failedAt?: Date | null;
  /** Categoría del último error (código Postgres o nombre de excepción).
   *  NUNCA el mensaje completo — puede traer PII del cliente (A7.1). */
  lastError?: string | null;
}

export interface DomainEventRepository {
  /**
   * Inserta el evento usando el SqlClient de una transacción activa.
   * NUNCA abrir una conexión nueva aquí — usar el client recibido.
   */
  insertWithClient(client: SqlClient, event: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>): Promise<void>;

  /** Lee eventos pendientes (dispatched_at IS NULL, failed_at IS NULL) ordenados por id ASC. */
  getPending(limit: number): Promise<DomainEvent[]>;

  /** Marca el evento como procesado. Idempotente si ya tiene dispatched_at. */
  markDispatched(id: number): Promise<void>;

  /**
   * Registra un intento de despacho fallido (incremento atómico, misma
   * UPDATE que decide si pasa a dead-letter — no es un SELECT+UPDATE, A8.2).
   * Si retry_count alcanza maxRetries, setea failed_at y el evento sale de
   * getPending hasta un retryDeadLettered() manual.
   * @returns true si este intento lo dejó en dead-letter.
   */
  recordFailure(id: number, errorCategory: string, maxRetries: number): Promise<boolean>;

  /** Cuenta eventos en dead-letter (failed_at IS NOT NULL). Para el aviso del dashboard. */
  countDeadLettered(): Promise<number>;

  /** Lista eventos en dead-letter, más recientes primero. */
  getDeadLettered(limit: number): Promise<DomainEvent[]>;

  /** Reintento manual: vuelve el evento a PENDING (failed_at NULL, retry_count 0). */
  retryDeadLettered(id: number): Promise<void>;
}
