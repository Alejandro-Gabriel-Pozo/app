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
 * ## Garantías
 * - Entrega at-least-once: un evento puede procesarse más de una vez si el
 *   worker muere entre el handler y el markDispatched. Los handlers deben ser
 *   idempotentes (usar el aggregateId + eventType + occurredAt como clave).
 * - No entrega out-of-order dentro del mismo aggregate: getPending ordena por id ASC.
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
  private intervalId?: ReturnType<typeof setInterval>;
  private polling = false;

  constructor(
    private readonly eventRepository: DomainEventRepository,
    private readonly pollIntervalMs = 5_000,
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
      console.error('[OutboxWorker] Error leyendo domain_events:', err);
    } finally {
      this.polling = false;
    }
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
      // No marcar → se reintenta al próximo ciclo
      console.error(
        `[OutboxWorker] Error despachando evento id=${event.id} (${event.eventType}):`,
        err,
      );
    }
  }
}
