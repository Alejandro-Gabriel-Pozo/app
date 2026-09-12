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
  /**
   * OUTBOX-RETRY-HIST-01 (schema v48, docs/diseno-outbox-backoff-2026-09-10.md).
   * Seteada UNA sola vez, en el primer fallo -- nunca se pisa después,
   * NI SIQUIERA por un reintento manual que resetea `retryCount` (decisión
   * del dueño: "esto viene fallando desde el lunes" sigue siendo cierto
   * aunque alguien haya reintentado el miércoles). `null` en eventos que
   * nunca fallaron, y en filas anteriores al 10/09/2026 hasta su próximo
   * fallo (autocura solo, ver `recordFailure()`).
   */
  firstFailedAt?: Date | null;
  /**
   * OUTBOX-BACKOFF-01 (schema v48). Se pisa en CADA fallo -- `getPending()`
   * la usa para calcular si ya pasó suficiente backoff antes de reintentar
   * de nuevo este evento puntual.
   */
  lastFailedAt?: Date | null;
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

  /**
   * Lee eventos pendientes (dispatched_at IS NULL, failed_at IS NULL) ordenados
   * por `retry_count ASC, id ASC` — los que fallan se desprioritizan para que un
   * poison message no frene la cabeza de la cola (ORDER-13/O5, 07/09/2026). El
   * orden por `id` se conserva entre eventos con el mismo retry_count.
   */
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

  /**
   * Reintento manual: vuelve el evento a PENDING (failed_at NULL, retry_count 0).
   * `last_error` se CONSERVA (D1-A, 07/09/2026) — el diagnóstico del último
   * fallo no se destruye al reintentar; `recordFailure` lo sobrescribe recién si
   * el evento vuelve a fallar.
   */
  retryDeadLettered(id: number): Promise<void>;

  /**
   * Caso 1 (12/09/2026, docs/investigacion-decisiones-bloqueado-2026-09-12.md).
   * Borra eventos "resueltos" (`dispatched_at IS NOT NULL OR failed_at IS
   * NOT NULL` — decisión del dueño ya tomada el 10/09/2026, A7.6,
   * docs/diseno-outbox-backoff-2026-09-10.md) con `occurred_at` más viejo
   * que `retentionDays`. Un evento reintentado manualmente
   * (`retryDeadLettered()`) vuelve a `failed_at IS NULL` y sale del filtro
   * de "resuelto" hasta que despache o vuelva a fallar de nuevo — no hay
   * ventana en la que un evento activo se purgue por error.
   * `processed_events` se borra por `ON DELETE CASCADE` (schema.sql,
   * BLOQUE 7), no hace falta un segundo DELETE.
   * @returns cantidad de filas borradas.
   */
  purgeResolved(retentionDays: number): Promise<number>;
}
