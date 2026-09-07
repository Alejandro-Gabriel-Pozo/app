import type { DomainEvent, DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { ProcessedEventRepository } from '../repositories/processed-event.repository.js';
import { classifyPgSqlState } from '../domain/outbox-error-class.js';
import { logger } from '../logger.js';

export type EventHandler = (event: DomainEvent) => Promise<void>;

/** Opciones de registro de un handler. Ver `OutboxWorker.on()`. */
export interface HandlerOptions {
  /**
   * Identidad estable del handler dentro de `processed_events`. Obligatoria
   * cuando el worker tiene `processedEventRepository` (o sea, en producción).
   * Cambiarla equivale a decir "este handler nunca corrió": todos los eventos
   * pendientes lo volverían a ejecutar. Tratarla como una clave, no como una
   * etiqueta.
   */
  name?: string;
  /**
   * Versión del contrato de payload que este handler entiende (A10.1).
   * Default 1 — todo lo emitido hasta el 28/08/2026 es v1.
   */
  version?: number;
}

interface HandlerRegistration {
  handler: EventHandler;
  name: string | undefined;
  version: number;
}

/**
 * A10.4 — "versión desconocida se rechaza ruidosamente, nunca se asume
 * compatible". Se lanza cuando un evento llega con una `version` para la que
 * hay handlers del mismo `eventType` registrados, pero ninguno de esa
 * versión. NO se lanza cuando no hay ningún handler para el eventType: eso
 * es "a nadie le interesa este evento" y ya tenía su camino (marcar
 * despachado y seguir).
 */
export class UnsupportedEventVersionError extends Error {
  constructor(eventType: string, version: number, supported: number[]) {
    super(
      `No hay handler para ${eventType} v${version}. ` +
      `Versiones registradas: ${supported.join(', ') || 'ninguna'}.`,
    );
    this.name = 'UnsupportedEventVersionError';
  }
}

/**
 * O2 (03/09/2026) — T-01: el CHARGE de la orden todavía no existe porque
 * `financial:order.confirmed` no se procesó. Es dependencia pendiente, no un
 * rechazo: reintentar SÍ la resuelve. Vive acá y no en los handlers porque la
 * política de reintento es responsabilidad del worker.
 */
export class ChargeNotYetCreatedError extends Error {
  constructor(public readonly detalle: Record<string, unknown>) {
    super(`El CHARGE de la orden ${String(detalle['orden'])} todavía no existe (intento ${String(detalle['intento'])}/${String(detalle['umbral'])}).`);
    this.name = 'ChargeNotYetCreatedError';
  }
}

/**
 * O2 — T-01 agotado. Pasado el techo ya no es una carrera de despacho sino una
 * inconsistencia real. El worker lo manda a dead-letter EN EL PRIMER INTENTO,
 * igual que `UnsupportedEventVersionError`: el evento sale de `getPending`
 * (sin loop) y queda con `failed_at`/`last_error` (sin falsa resolución).
 *
 * **Esto no reemplaza a O5.** El dead-letter dice "este evento falló" y la
 * única acción que ofrece el panel es reintentarlo, que para un cargo que
 * nunca se va a crear no resuelve nada.
 */
export class ChargeNeverCreatedError extends Error {
  constructor(public readonly detalle: Record<string, unknown>) {
    super(`El CHARGE de la orden ${String(detalle['orden'])} no se creó tras ${String(detalle['intento'])} intentos.`);
    this.name = 'ChargeNeverCreatedError';
  }
}

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
 *   worker muere entre el handler y el markDispatched, o si OTRO handler del
 *   mismo evento falla y el evento entero se reintenta.
 * - **NO garantiza orden estricto de procesamiento, ni siquiera dentro del
 *   mismo aggregate.** `getPending` ordena por `retry_count ASC, id ASC`
 *   (ORDER-13/O5, 07/09/2026 — los eventos que fallan se desprioritizan para
 *   que un poison message no frene la cola): un `order.confirmed` que ya falló
 *   una vez se procesa DESPUÉS de un `order.completed` posterior del mismo
 *   aggregate. Los handlers ya no dependen del orden — resuelven las
 *   dependencias cruzadas con `DEPENDENCIA_PENDIENTE`/`ChargeNotYetCreatedError`
 *   (`outbox.handlers.ts`) y con el casillero único de `processed_events` /
 *   `stock_movements`, no con el orden de llegada.
 *
 * ## Idempotencia por handler (A10.3, 28/08/2026 — Fase 1 del plan de dominios)
 * Antes de esto, "los handlers deben ser idempotentes" era una instrucción en
 * este docblock, no un mecanismo. Se cumplía handler por handler con una
 * clave natural distinta en cada uno (`idempotencyKey` en los financieros,
 * insert-then-act en los de inventario) y NO se cumplía en el de mail, que lo
 * decía explícitamente en su propio archivo. Como `reservation.confirmed`
 * tiene dos consumidores (financiero + mail), cada fallo del financiero
 * reenviaba el mail de confirmación al huésped.
 *
 * Ahora, si se inyecta `processedEventRepository`, cada handler con nombre
 * reclama su casillero `(domain_event_id, handler_name)` antes de correr y lo
 * libera si falla. Un handler que ya corrió para un evento se saltea; uno que
 * falló se reintenta. Esto NO reemplaza las claves naturales que ya existen
 * — son la defensa de adentro, esto es la de afuera.
 *
 * ## Versionado (A10.1/A10.4)
 * `event.version` (columna, no sufijo en el nombre del evento) se compara
 * contra la versión declarada al registrar el handler (default 1). Si hay
 * handlers para el eventType pero ninguno para esa versión, el evento va a
 * dead-letter EN EL PRIMER INTENTO con `UnsupportedEventVersionError` — nunca
 * se le corre encima un handler de otra versión.
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
  private readonly handlers = new Map<string, HandlerRegistration[]>();
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
    /**
     * Idempotencia por handler (A10.3). Opcional a propósito: los tests
     * unitarios del worker construyen handlers descartables sin BD y no la
     * necesitan. En producción SIEMPRE se inyecta (outbox.registry.ts), y
     * cuando está presente `on()` exige nombre — ver ahí el porqué.
     */
    private readonly processedEventRepository?: ProcessedEventRepository,
  ) {}

  /**
   * Registra un handler para un tipo de evento.
   * Chainable — puede llamarse varias veces para el mismo eventType.
   *
   * ## Por qué `options.name` es obligatorio si hay processedEventRepository
   * Sin nombre no hay casillero que reclamar en `processed_events`, así que
   * el handler correría sin protección de idempotencia. Dejarlo pasar en
   * silencio es exactamente cómo se degrada este tipo de mecanismo: alguien
   * agrega un handler nuevo, no pone nombre, y la red deja de cubrirlo sin
   * que nadie se entere. Falla al arrancar el proceso, no en producción a
   * las tres semanas.
   */
  on(eventType: string, handler: EventHandler, options: HandlerOptions = {}): this {
    if (this.processedEventRepository && !options.name) {
      throw new Error(
        `[OutboxWorker] El handler de "${eventType}" se registró sin options.name. ` +
        'Con idempotencia por handler activa, todo handler necesita un nombre ' +
        'estable para su casillero en processed_events.',
      );
    }

    const existing = this.handlers.get(eventType) ?? [];
    this.handlers.set(eventType, [
      ...existing,
      { handler, name: options.name, version: options.version ?? 1 },
    ]);
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

    // Eventos anteriores a schema v44 no tienen `version` en la fila; son v1
    // por definición (ver el comentario de la columna en schema.sql).
    const version = event.version ?? 1;

    try {
      const matching = handlers.filter((h) => h.version === version);

      if (matching.length === 0) {
        throw new UnsupportedEventVersionError(
          event.eventType,
          version,
          [...new Set(handlers.map((h) => h.version))].sort((a, b) => a - b),
        );
      }

      await Promise.all(matching.map((reg) => this.runHandler(event, reg)));
      await this.eventRepository.markDispatched(event.id!);
    } catch (err) {
      // No marcar dispatched → se reintenta al próximo ciclo, hasta maxRetries.
      logger.error(
        { err, eventId: event.id, eventType: event.eventType },
        '[OutboxWorker] Error despachando evento',
      );

      // Una versión sin handler NUNCA se arregla sola: reintentarla 60 veces
      // (5 min) solo retrasa que alguien la vea. maxRetries=1 la manda a
      // dead-letter en el primer fallo, reusando la MISMA UPDATE atómica que
      // el resto — no un segundo camino de escritura (R14).
      // ORDER-13 / O5 (07/09/2026, docs/diseno-order13-o5-dead-letter-2026-09-07.md):
      // un error PERMANENTE va a dead-letter en el primer intento -- con la
      // MISMA UPDATE atómica, no un segundo camino de escritura (R14). Esto
      // generaliza la lista vieja: `UnsupportedEventVersionError` y
      // `ChargeNeverCreatedError` caen ahora en 'permanent' vía classifyError().
      const maxRetries = classifyError(err) === 'permanent' ? 1 : this.maxRetries;

      const deadLettered = await this.eventRepository.recordFailure(
        event.id!,
        categorizeError(err),
        maxRetries,
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
   * Corre un handler, con el casillero de `processed_events` si corresponde
   * (A10.3).
   *
   * El casillero se RECLAMA antes de correr, no se marca después: reclamar
   * después dejaría abierta la ventana de dos ciclos de poll solapados
   * corriendo el mismo handler a la vez. Y se LIBERA si el handler falla —
   * sin eso, un fallo transitorio (la BD un segundo caída) quedaría marcado
   * como "ya procesado" y el reintento lo saltearía: trabajo perdido en
   * silencio, peor que la duplicación que se quería evitar.
   */
  private async runHandler(event: DomainEvent, reg: HandlerRegistration): Promise<void> {
    const repo = this.processedEventRepository;

    // Sin repo (tests) o sin id persistido: se corre como antes de v44.
    if (!repo || !reg.name || event.id === undefined) {
      await reg.handler(event);
      return;
    }

    const won = await repo.claim(event.id, reg.name);
    if (!won) {
      logger.debug(
        { eventId: event.id, eventType: event.eventType, handler: reg.name },
        '[OutboxWorker] Handler ya procesado para este evento. Salteado.',
      );
      return;
    }

    try {
      await reg.handler(event);
    } catch (err) {
      try {
        await repo.release(event.id, reg.name);
      } catch (releaseErr) {
        // Que falle la liberación no puede tapar el error real del handler:
        // se loguea aparte y se relanza el original. El costo de este caso
        // (el casillero queda tomado sin que el handler haya terminado) es
        // que ese handler no se reintenta para ESE evento — visible en el
        // log, no en silencio.
        logger.error(
          { err: releaseErr, eventId: event.id, handler: reg.name },
          '[OutboxWorker] No se pudo liberar el casillero de processed_events',
        );
      }
      throw err;
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

/**
 * ORDER-13 / O5 (07/09/2026, docs/diseno-order13-o5-dead-letter-2026-09-07.md).
 * Segundo eje al lado de categorizeError(): ¿este fallo se puede reintentar
 * (transitorio) o hay que sacarlo de la cola YA (permanente)? Gobierna el
 * `maxRetries` efectivo (permanente → 1, dead-letter en el primer intento).
 *
 * La clasificación de SQLSTATE vive en `domain/outbox-error-class.ts` (una
 * fuente de verdad, compartida con `describeDeadLetter`). Acá se resuelven
 * además las clases de error de JS que no llegan como `err.code`.
 *
 * DEFAULT = transitorio: un `err.code` clase 'other' (42/22/XX…), o un error
 * sin `code` y sin clase conocida, se reintenta `maxRetries` (60) veces — el
 * comportamiento de hoy. Difiere a propósito del fail-safe "block" de Odoo
 * (account_edi_document.py:11): en bajo volumen, dead-lettear un unknown
 * recuperable en el primer intento (y exigir reintento manual) es peor que
 * esperar 5 minutos. **Nota:** en este worker 'transient' y 'other' coinciden
 * (ambos reintentan) — el set `TRANSIENT_PG_CODES` recién cambia comportamiento
 * en `describeDeadLetter` (transitorio → "falla temporal"), o acá el día que el
 * default se invierta.
 */
function classifyError(err: unknown): 'transient' | 'permanent' {
  const pgCode = (err as NodeJS.ErrnoException)?.code;
  if (typeof pgCode === 'string') {
    return classifyPgSqlState(pgCode) === 'permanent' ? 'permanent' : 'transient';
  }
  if (err instanceof UnsupportedEventVersionError || err instanceof ChargeNeverCreatedError) {
    return 'permanent';
  }
  // Error de programación — reintentarlo 60 veces solo retrasa que alguien lo vea.
  if (err instanceof TypeError || err instanceof RangeError || err instanceof SyntaxError) {
    return 'permanent';
  }
  return 'transient';
}
