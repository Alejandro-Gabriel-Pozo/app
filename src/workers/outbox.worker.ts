import type { DomainEvent, DomainEventRepository } from '../repositories/domain-event.repository.js';

export type EventHandler = (event: DomainEvent) => Promise<void>;

/**
 * Worker de outbox transaccional.
 *
 * ## Responsabilidades
 * - Leer domain_events WHERE dispatched_at IS NULL cada `pollIntervalMs`.
 * - Invocar todos los handlers registrados para cada eventType.
 * - Marcar el evento como despachado SOLO si todos los handlers tuvieron éxito.
 * - Si algún handler falla, el evento queda pendiente y se reintenta al próximo ciclo.
 *
 * ## Garantas
 * - Entrega at-least-once: un evento puede procesarse más de una vez si el
 *   worker muere entre el handler y el markDispatched. Los handlers deben ser
 *   idempotentes (usar el aggregateId + eventType + occurredAt como clave).
 * - No entrega out-of-order dentro del mismo aggregate: getPending ordena por id ASC.
 *
 * ## Dead-letter (A9.5/A8.7, 15/08/2026)
 * Antes de esto, un evento que fallaba se reintentaba cada `pollIntervalMs`
 * para siempre, en silencio (hallazgo `pendientes-2026-08-15.md` punto 2).
 * Ahora cada fallo cuenta contra `maxRetries`; al agotarlo el evento pasa a
 * dead-letter (`failed_at` seteado en la misma UPDATE que incrementa, ver
 * `SqlDomainEventRepository.recordFailure`) y sale de `getPending` — deja de
 * reintentarse solo. Vuelve a la cola con un reintento manual
 * (`retryDeadLettered`, expuesto en `GET/POST /api/system/outbox/...`).
 *
 * ## Arranque diferido
 * Si la tabla domain_events todavía no existe en la BD (p.ej. primer deploy
 * antes de correr las migraciones), el worker loguea un aviso único y
 * desactiva el polling automáticamente para no llenar los logs de errores.
 * Se reactiva llamando a worker.start() de nuevo una vez que la tabla exista.
 *
 * ## Uso
 * ```ts
 * const worker = new OutboxWorker(domainEventRepository, 5_000);
 *
 * worker
 *   .on('reservation.confirmed', async (event) => { ... })
 *   .on('reservation.completed', async (event) => { ... });
 *
 * worker.start();
 * process.on('SIGTERM', () => worker.stop());
 * ```
 */
export class OutboxWorker {
  private readonly handlers = new Map<string, EventHandler[]>();
  private intervalId: ReturnType<typeof setInterval> | undefined = undefined;
  private polling = false;

  /** true si ya se emitió el aviso de tabla faltante (evita spam en logs) */
  private missingTableWarned = false;

  constructor(
    private readonly eventRepository: DomainEventRepository,
    private readonly pollIntervalMs = 5_000,
    /** ~5 min de fallas seguidas a pollIntervalMs=5s antes de dead-letter. */
    private readonly maxRetries = 60,
  ) {}

  /**
   * Registra un handler para un tipo de evento.
   * Chainable — puede llamarse varias veces para el mismo eventType.
   */
  on(eventType: string, handler: EventHandler): this {
    const existing = this.handlers.get(eventType) ?? [];
    this.handlers.set(eventType, [...existing, handler]);
    return this;
  }

  start(): void {
    if (this.intervalId) return;
    // Resetear el flag al (re)arrancar para que se pueda detectar de nuevo
    this.missingTableWarned = false;
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
    console.log(`[OutboxWorker] Iniciado — polling cada ${this.pollIntervalMs}ms`);
  }

  /**
   * Detiene el worker y espera a que el ciclo de polling activo termine.
   * Es async para que el caller pueda hacer `await worker.stop()` correctamente.
   */
  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    // Esperar a que el ciclo actual termine si está en curso
    while (this.polling) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }

    console.log('[OutboxWorker] Detenido');
  }

  // ---------------------------------------------------------------------------
  // Privados
  // ---------------------------------------------------------------------------

  private async poll(): Promise<void> {
    // Evitar solapamiento si un ciclo tarda más de pollIntervalMs
    if (this.polling) return;
    this.polling = true;

    try {
      const pending = await this.eventRepository.getPending(50);
      if (pending.length === 0) return;

      console.log(`[OutboxWorker] ${pending.length} evento(s) pendiente(s)`);

      for (const event of pending) {
        await this.dispatch(event);
      }
    } catch (err) {
      this.handlePollError(err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Maneja errores del ciclo de polling.
   *
   * - Si la tabla domain_events no existe (42P01), emite un aviso único y
   *   detiene el worker para no llenar los logs. El deploy debería correr
   *   las migraciones y luego llamar a worker.start() de nuevo.
   * - Para cualquier otro error, loguea normalmente (se reintenta al siguiente ciclo).
   */
  private handlePollError(err: unknown): void {
    const pgCode = (err as NodeJS.ErrnoException)?.code;

    if (pgCode === '42P01') {
      // relation does not exist — tabla todavía no creada en la BD
      if (!this.missingTableWarned) {
        this.missingTableWarned = true;
        console.warn(
          '[OutboxWorker] ⚠️  La tabla domain_events no existe en la tenant DB.\n' +
          '               Ejecutá src/db/schema.sql contra esa tenant DB.\n' +
          '               El worker queda en pausa hasta que se llame a worker.start() de nuevo.',
        );
        // Detener polling para no llenar los logs
        void this.stop();
      }
      return;
    }

    console.error('[OutboxWorker] Error leyendo domain_events:', err);
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.eventType) ?? [];

    if (handlers.length === 0) {
      // Evento sin handler registrado → marcar como despachado para no bloquear la cola
      console.warn(
        `[OutboxWorker] Sin handler para '${event.eventType}' (id=${event.id}). Marcando como despachado.`,
      );
      await this.eventRepository.markDispatched(event.id!);
      return;
    }

    try {
      await Promise.all(handlers.map((h) => h(event)));
      await this.eventRepository.markDispatched(event.id!);
    } catch (err) {
      // No marcar dispatched → se reintenta al próximo ciclo, hasta maxRetries.
      console.error(
        `[OutboxWorker] Error despachando evento id=${event.id} (${event.eventType}):`,
        err,
      );

      const deadLettered = await this.eventRepository.recordFailure(
        event.id!,
        categorizeError(err),
        this.maxRetries,
      );

      if (deadLettered) {
        console.error(
          `[OutboxWorker] ⚠️  Evento id=${event.id} (${event.eventType}) pasó a dead-letter ` +
          `tras ${this.maxRetries} intentos. Requiere reintento manual (panel de negocio).`,
        );
      }
    }
  }
}

/**
 * Categoría segura del error para persistir en last_error — nunca el
 * mensaje completo (A7.1: puede traer un dato de cliente adentro, ej.
 * "duplicate key ... email@...").
 */
function categorizeError(err: unknown): string {
  const pgCode = (err as NodeJS.ErrnoException)?.code;
  if (pgCode) return `PG_${pgCode}`;
  if (err instanceof Error) return err.constructor.name;
  return 'UNKNOWN_ERROR';
}
