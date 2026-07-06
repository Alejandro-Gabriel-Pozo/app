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
}

/**
 * Implementación SQL del repositorio de eventos de dominio.
 *
 * Recibe SqlClient (no pg.Pool directo) para mantener la inversión
 * de dependencias consistente con el resto de los repositorios.
 *
 * Schema esperado (PostgreSQL):
 * ```sql
 * CREATE TABLE domain_events (
 *   id              BIGSERIAL     PRIMARY KEY,
 *   business_id     VARCHAR(255)  NOT NULL REFERENCES businesses(id),
 *   aggregate_type  VARCHAR(50)   NOT NULL,
 *   aggregate_id    VARCHAR(255)  NOT NULL,
 *   event_type      VARCHAR(100)  NOT NULL,
 *   payload         JSONB         NOT NULL,
 *   occurred_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
 *   dispatched_at   TIMESTAMPTZ
 * );
 *
 * CREATE INDEX idx_domain_events_pending
 *   ON domain_events (id)
 *   WHERE dispatched_at IS NULL;
 * ```
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
              event_type, payload, occurred_at, dispatched_at
       FROM domain_events
       WHERE dispatched_at IS NULL
       ORDER BY id ASC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map((row) => ({
      id:            row.id,
      businessId:    row.business_id,
      aggregateType: row.aggregate_type,
      aggregateId:   row.aggregate_id,
      eventType:     row.event_type,
      payload:       row.payload,
      occurredAt:    row.occurred_at,
      dispatchedAt:  row.dispatched_at,
    }));
  }

  async markDispatched(id: number): Promise<void> {
    await this.sqlClient.query(
      `UPDATE domain_events
       SET dispatched_at = NOW()
       WHERE id = $1 AND dispatched_at IS NULL`,
      [id],
    );
  }
}
