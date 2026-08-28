import type { SqlClient } from './sql.client.js';

export interface DomainEvent {
  /** Asignado por la BD (BIGSERIAL). Undefined antes de persistir. */
  id?: number;
  /**
   * Identidad GLOBAL del evento (UUID), a diferencia de `id`, que solo es
   * único dentro de esta tenant DB — dos negocios tienen su propio `id = 1`.
   * Lo asigna la base (DEFAULT gen_random_uuid()); es para lo que salga del
   * límite de la base: integraciones, webhooks, read models externos.
   * `null` en las filas anteriores al 28/08/2026 — ver schema.sql BLOQUE 7.
   */
  eventId?: string | null;
  /**
   * A9.2 — el request que originó el evento. Hoy SIEMPRE null: no existe
   * correlationId de request en el backend todavía. La columna existe para
   * que el día que exista sea una línea, no una migración.
   */
  correlationId?: string | null;
  /**
   * El evento que causó este evento (cadena de causalidad). Hoy siempre
   * null: ningún handler emite eventos.
   */
  causationId?: string | null;
  /**
   * Versión del CONTRATO del payload (A10.1). No va en el nombre del evento
   * — los 7 tipos ya emitidos usan el nombre pelado (`reservation.confirmed`,
   * no `reservation.confirmed.v1`) y renombrarlos rompería los handlers
   * registrados. Todo lo emitido hasta hoy es 1 (DEFAULT en la base).
   * Subirlo obliga a registrar un handler para esa versión: el worker
   * rechaza ruidosamente un evento sin handler para su versión (A10.4).
   */
  version?: number;
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
   *
   * `eventId` también queda fuera del input: lo asigna la base
   * (DEFAULT gen_random_uuid()), no el emisor — un solo camino de escritura
   * para la identidad global, mismo criterio que `id`.
   */
  insertWithClient(
    client: SqlClient,
    event: Omit<DomainEvent, 'id' | 'eventId' | 'occurredAt' | 'dispatchedAt'>,
  ): Promise<void>;

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
