import type { SqlClient } from './sql.client.js';
import type { DomainEvent, DomainEventRepository } from './domain-event.repository.js';

interface DomainEventRow {
  id: number;
  business_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  dispatched_at: Date | null;
  retry_count: number;
  failed_at: Date | null;
  last_error: string | null;
}

function toDomainEvent(row: DomainEventRow): DomainEvent {
  return {
    id:            row.id,
    businessId:    row.business_id,
    aggregateType: row.aggregate_type,
    aggregateId:   row.aggregate_id,
    eventType:     row.event_type,
    payload:       row.payload,
    occurredAt:    row.occurred_at,
    dispatchedAt:  row.dispatched_at,
    retryCount:    row.retry_count,
    failedAt:      row.failed_at,
    lastError:     row.last_error,
  };
}

/**
 * Implementación SQL del repositorio de eventos de dominio.
 *
 * Recibe SqlClient (no pg.Pool directo) para mantener la inversión
 * de dependencias consistente con el resto de los repositorios.
 *
 * Schema esperado (PostgreSQL) — ver src/db/schema.sql BLOQUE 7 para la
 * versión completa con retry_count/failed_at/last_error (A9.5/A8.7,
 * 15/08/2026).
 */
export class SqlDomainEventRepository implements DomainEventRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async insertWithClient(
    client: SqlClient,
    event: Omit<DomainEvent, 'id' | 'occurredAt' | 'dispatchedAt'>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO domain_events
         (business_id, aggregate_type, aggregate_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        event.businessId,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
      ],
    );
  }

  async getPending(limit = 50): Promise<DomainEvent[]> {
    const result = await this.sqlClient.query<DomainEventRow>(
      `SELECT id, business_id, aggregate_type, aggregate_id,
              event_type, payload, occurred_at, dispatched_at,
              retry_count, failed_at, last_error
       FROM domain_events
       WHERE dispatched_at IS NULL AND failed_at IS NULL
       ORDER BY id ASC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(toDomainEvent);
  }

  async markDispatched(id: number): Promise<void> {
    await this.sqlClient.query(
      `UPDATE domain_events
       SET dispatched_at = NOW()
       WHERE id = $1 AND dispatched_at IS NULL`,
      [id],
    );
  }

  /**
   * UPDATE atómica: el incremento y la decisión de pasar a dead-letter son
   * la misma operación (A8.2 — no SELECT retry_count seguido de un IF en
   * memoria, que dos ciclos de poll solapados podrían leer a la vez).
   */
  async recordFailure(id: number, errorCategory: string, maxRetries: number): Promise<boolean> {
    const result = await this.sqlClient.query<{ failed_at: Date | null }>(
      `UPDATE domain_events
       SET retry_count = retry_count + 1,
           last_error  = $2,
           failed_at   = CASE WHEN retry_count + 1 >= $3 THEN NOW() ELSE failed_at END
       WHERE id = $1
       RETURNING failed_at`,
      [id, errorCategory.slice(0, 255), maxRetries],
    );

    return result.rows[0]?.failed_at != null;
  }

  async countDeadLettered(): Promise<number> {
    const result = await this.sqlClient.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM domain_events WHERE failed_at IS NOT NULL`,
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async getDeadLettered(limit = 50): Promise<DomainEvent[]> {
    const result = await this.sqlClient.query<DomainEventRow>(
      `SELECT id, business_id, aggregate_type, aggregate_id,
              event_type, payload, occurred_at, dispatched_at,
              retry_count, failed_at, last_error
       FROM domain_events
       WHERE failed_at IS NOT NULL
       ORDER BY failed_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(toDomainEvent);
  }

  async retryDeadLettered(id: number): Promise<void> {
    await this.sqlClient.query(
      `UPDATE domain_events
       SET failed_at = NULL, retry_count = 0, last_error = NULL
       WHERE id = $1 AND failed_at IS NOT NULL`,
      [id],
    );
  }
}
