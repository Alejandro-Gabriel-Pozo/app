import type { SqlClient } from './sql.client.js';
import type { DomainEvent, DomainEventRepository } from './domain-event.repository.js';

interface DomainEventRow {
  id: number;
  event_id: string | null;
  correlation_id: string | null;
  causation_id: string | null;
  version: number;
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
  first_failed_at: Date | null;
  last_failed_at: Date | null;
}

/**
 * Columnas del sobre + del cuerpo, en un solo lugar — las leen `getPending()`
 * y `getDeadLettered()`. Estaban duplicadas literal entre las dos consultas
 * y agregar una columna al sobre (28/08/2026) obligaba a acordarse de tocar
 * las dos: exactamente el modo de falla de "un solo camino por
 * responsabilidad" (docs/DEFENSIVE_DEVELOPING.md).
 */
const EVENT_COLUMNS = `id, event_id, correlation_id, causation_id, version,
              business_id, aggregate_type, aggregate_id,
              event_type, payload, occurred_at, dispatched_at,
              retry_count, failed_at, last_error,
              first_failed_at, last_failed_at`;

function toDomainEvent(row: DomainEventRow): DomainEvent {
  return {
    id:            row.id,
    eventId:       row.event_id,
    correlationId: row.correlation_id,
    causationId:   row.causation_id,
    version:       row.version,
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
    firstFailedAt: row.first_failed_at,
    lastFailedAt:  row.last_failed_at,
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

  /**
   * `event_id` no se pasa: lo genera el DEFAULT de la columna. `version` cae
   * a 1 si el emisor no la manda — el DEFAULT de la base dice lo mismo, pero
   * mandarla explícita deja el valor visible en el INSERT en vez de escondido
   * en el schema.
   */
  async insertWithClient(
    client: SqlClient,
    event: Omit<DomainEvent, 'id' | 'eventId' | 'occurredAt' | 'dispatchedAt'>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO domain_events
         (business_id, aggregate_type, aggregate_id, event_type, payload,
          correlation_id, causation_id, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.businessId,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.correlationId ?? null,
        event.causationId ?? null,
        event.version ?? 1,
      ],
    );
  }

  async getPending(limit = 50): Promise<DomainEvent[]> {
    // ORDER-13 / O5 (07/09/2026) -- `retry_count ASC` primero, no solo `id ASC`:
    // un evento transitorio que falla y falla (y todavía NO llegó a
    // dead-letter) se sienta en la cabeza de la cola y se reintenta antes que
    // los nuevos en cada poll (poison message). Con `retry_count ASC` los que
    // fallan se van al fondo -- patrón `ORDER BY failure_count` de Odoo
    // (ir_cron.py:365). Entre eventos con el mismo retry_count (el caso común:
    // todos en 0) el orden por `id` se conserva. Los handlers NO dependen del
    // orden estricto de procesamiento (inventory.handlers.ts:25-37 lo declara y
    // lo maneja con el casillero compartido).
    //
    // OUTBOX-BACKOFF-01 (schema v48, docs/diseno-outbox-backoff-2026-09-10.md
    // §5) -- backoff real por evento, escalón aprobado por el dueño (patrón
    // `retry_pattern` de OCA queue_job, no exponencial continuo ni intervalo
    // fijo): retry_count 1-2 → 5s, 3-9 → 30s, 10-29 → 120s, ≥30 → 300s.
    // `retry_count = 0` (nunca falló) siempre es elegible. `last_failed_at
    // IS NULL` también es elegible SIN excepción -- cubre una fila que ya
    // existía con retry_count > 0 antes de esta columna (falló bajo el
    // código viejo, nunca tuvo `last_failed_at` seteado): sin esta rama,
    // `retry_count = 0` da false, `NULL <= ...` da NULL (lógica de 3
    // valores de SQL), `false OR NULL` da NULL, y la fila queda EXCLUIDA de
    // getPending() para siempre -- no falla, desaparece (sin dead-letter,
    // sin compensación de A8.7, sin rastro visible). Con esta rama, esa
    // fila se reintenta en el próximo poll y `recordFailure()` le setea
    // `last_failed_at` real -- autocura en un ciclo. Este `ORDER BY` sigue
    // importando ADEMÁS del backoff, no en su lugar: el backoff decide
    // "¿es candidato a reintentarse YA?"; el orden decide en qué secuencia
    // se procesan los que sí lo son.
    const result = await this.sqlClient.query<DomainEventRow>(
      `SELECT ${EVENT_COLUMNS}
       FROM domain_events
       WHERE dispatched_at IS NULL AND failed_at IS NULL
         AND (
           retry_count = 0
           OR last_failed_at IS NULL
           OR last_failed_at <= NOW() - (
             CASE
               WHEN retry_count <= 2  THEN 5
               WHEN retry_count <= 9  THEN 30
               WHEN retry_count <= 29 THEN 120
               ELSE 300
             END || ' seconds')::interval
         )
       ORDER BY retry_count ASC, id ASC
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
   *
   * `first_failed_at` (OUTBOX-RETRY-HIST-01, docs/diseno-outbox-backoff-2026-09-10.md
   * §2/§4): guard idempotente sobre LA COLUMNA MISMA (`IS NULL`), no sobre
   * `retry_count = 0` -- `retryDeadLettered()` resetea `retry_count` a 0 en
   * cada reintento manual, así que un guard sobre `retry_count` pisaría
   * `first_failed_at` con la fecha de HOY en la falla siguiente a un
   * reintento manual, destruyendo el dato que la columna existe para
   * preservar (decisión del dueño: NO se resetea con un reintento manual).
   * `last_failed_at` (OUTBOX-BACKOFF-01) se pisa en CADA falla, sin CASE --
   * la usa el backoff de `getPending()`.
   */
  async recordFailure(id: number, errorCategory: string, maxRetries: number): Promise<boolean> {
    const result = await this.sqlClient.query<{ failed_at: Date | null }>(
      `UPDATE domain_events
       SET retry_count     = retry_count + 1,
           last_error      = $2,
           first_failed_at = CASE WHEN first_failed_at IS NULL THEN NOW() ELSE first_failed_at END,
           last_failed_at  = NOW(),
           failed_at       = CASE WHEN retry_count + 1 >= $3 THEN NOW() ELSE failed_at END
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
      `SELECT ${EVENT_COLUMNS}
       FROM domain_events
       WHERE failed_at IS NOT NULL
       ORDER BY failed_at DESC
       LIMIT $1`,
      [limit],
    );

    return result.rows.map(toDomainEvent);
  }

  async retryDeadLettered(id: number): Promise<void> {
    // ORDER-13 / O5 D1-A (07/09/2026): `failed_at` y `retry_count` SÍ se limpian
    // -- si no, el evento re-dead-lettea en 1-2 polls porque el contador ya está
    // en 60 y el reintento manual es un no-op. Pero `last_error` NO se nulea:
    // destruir el único diagnóstico que el operador tenía al reintentar es el
    // defecto que D1-A corrige. Si el evento vuelve a fallar, `recordFailure`
    // lo sobrescribe con la categoría nueva. (La visibilidad "reintentado N
    // veces" necesita una columna -- follow-up #3 del ADR, era D1-B(B).)
    await this.sqlClient.query(
      `UPDATE domain_events
       SET failed_at = NULL, retry_count = 0
       WHERE id = $1 AND failed_at IS NOT NULL`,
      [id],
    );
  }
}
