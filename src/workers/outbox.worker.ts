import type { DomainEvent, DomainEventRepository } from '../repositories/domain-event.repository.js';
import { logger } from '../logger.js';

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
 * ## Compensación automática al caer en dead-letter (A8.7, 16/08/2026)
 * `onDeadLetter()` registra una acción a correr UNA VEZ, en el mismo ciclo
 * en que `recordFailure()` confirma que el evento agotó `maxRetries` — no
 * un poller ni un TTL de tiempo real aparte. Sirve para el caso de A8.7
 * ("toda reserva provisoria con consolidación asíncrona se libera también
 * si el consolidador falla, no solo si el usuario cancela"): sin esto, un
 * `order.confirmed` que nunca termina de consolidar deja la reserva de
 * stock tomada indefinidamente hasta un reintento manual desde el panel
 * (`pendientes-2026-08-15.md` D1). El handler de dead-letter corre
 * DESPUÉS de que el evento ya quedó marcado dead-letter — su única
 * responsabilidad es la compensación, no decide si el evento pasa o no a
 * dead-letter. Si el propio compensador falla, se loguea y no se
 * relanza — el evento ya está en dead-letter y visible en el panel de
 * todos modos, un reintento manual sigue disponible.
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
  private readonly deadLetterHandlers = new Map<string, EventHandler[]>();
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

  /**
   * Registra una acción compensatoria a correr cuando un evento de este
   * tipo agota `maxRetries` y cae en dead-letter (A8.7). Corre una sola
   * vez por transición a dead-letter — no en cada poll, no en los
   * reintentos normales. Chainable, igual que `on()`.
   */
  onDeadLetter(eventType: string, handler: EventHandler): this {
    const existing = this.deadLetterHandlers.get(eventType) ?? [];
    this.deadLetterHandlers.set(eventType, [...existing, handler]);
    return this;
  }

  start(): void {
    if (this.intervalId) return;
    // Resetear el flag al (re)arrancar para que se pueda detectar de nuevo
    this.missingTableWarned = false;
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
    logger.info({ pollIntervalMs: this.pollIntervalMs }, '[OutboxWorker] Iniciado');
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

    logger.info('[OutboxWorker] Detenido');
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

      logger.debug({ count: pending.length }, '[OutboxWorker] Eventos pendientes');

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
        logger.warn(
          '[OutboxWorker] La tabla domain_events no existe en la tenant DB. ' +
          'Ejecutá src/db/schema.sql contra esa tenant DB. ' +
          'El worker queda en pausa hasta que se llame a worker.start() de nuevo.',
        );
        // Detener polling para no llenar los logs
        void this.stop();
      }
      return;
    }

    logger.error({ err }, '[OutboxWorker] Error leyendo domain_events');
  }

  private async dispatch(event: DomainEvent): Promise<void> {
    const handlers = this.handlers.get(event.eventType) ?? [];

    if (handlers.length === 0) {
      // Evento sin handler registrado → marcar como despachado para no bloquear la cola
      logger.warn(
        { eventId: event.id, eventType: event.eventType },
        '[OutboxWorker] Sin handler registrado. Marcando como despachado.',
      );
      await this.eventRepository.markDispatched(event.id!);
      return;
    }

    try {
      await Promise.all(handlers.map((h) => h(event)));
      await this.eventRepository.markDispatched(event.id!);
    } catch (err) {
      // No marcar dispatched → se reintenta al próximo ciclo, hasta maxRetries.
      logger.error(
        { err, eventId: event.id, eventType: event.eventType },
        '[OutboxWorker] Error despachando evento',
      );

      const deadLettered = await this.eventRepository.recordFailure(
        event.id!,
        categorizeError(err),
        this.maxRetries,
      );

      if (deadLettered) {
        logger.error(
          { eventId: event.id, eventType: event.eventType, maxRetries: this.maxRetries },
          '[OutboxWorker] Evento pasó a dead-letter. Requiere reintento manual (panel de negocio).',
        );
        await this.runDeadLetterHandlers(event);
      }
    }
  }

  /**
   * Corre las acciones compensatorias registradas para este eventType
   * (A8.7). Cada handler se aísla del resto — uno que falle no evita que
   * los demás corran, ni revierte la marca de dead-letter (ya persistida
   * antes de llegar acá).
   */
  private async runDeadLetterHandlers(event: DomainEvent): Promise<void> {
    const handlers = this.deadLetterHandlers.get(event.eventType) ?? [];
    if (handlers.length === 0) return;

    const results = await Promise.allSettled(handlers.map((h) => h(event)));
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error(
          { err: result.reason, eventId: event.id, eventType: event.eventType },
          '[OutboxWorker] Falló la compensación de dead-letter',
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
