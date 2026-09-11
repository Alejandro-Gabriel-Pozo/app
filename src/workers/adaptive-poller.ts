import { logger } from '../logger.js';

/**
 * @file adaptive-poller.ts
 * @description Scheduler binario activo/idle para workers de polling
 * (docs/diseno-polling-adaptativo-neon-2026-09-10.md). Reemplaza el
 * `setInterval` de intervalo fijo: después de cada poll, el próximo delay
 * se decide según si el poll encontró trabajo (`activeIntervalMs`) o no
 * (`idleIntervalMs`) -- deja que el compute de Neon llegue de verdad a los
 * 5 minutos de inactividad de su scale-to-zero (`idleIntervalMs` tiene que
 * ser mayor a esa ventana, no igual -- un poll exactamente a los 5 min
 * despierta el compute justo cuando se suspende, sin comprar inactividad
 * facturable real).
 *
 * Recibe SOLO una función `() => Promise<boolean>` y números -- nunca un
 * repo, pool ni `SqlClient` (DEFENSIVE_DEVELOPING §3: este helper no puede
 * tocar `req.db`/`getPlatformRawPool()` porque no conoce ninguno de los
 * dos, a propósito).
 *
 * ## Generación, no booleano (gate `architecture-governor`, ronda 1)
 * `stop()` incrementa un contador de generación de forma SÍNCRONA, antes
 * de cualquier `await`. Cada vez que un ciclo de poll termina y va a
 * reprogramar el próximo timeout, compara la generación que capturó al
 * arrancar contra la actual -- si no coinciden, no reprograma. Esto cierra
 * dos carreras:
 * - `stop()` llamado DESDE ADENTRO de la función de poll (el caso real de
 *   `OutboxWorker.handlePollError()` ante una tabla faltante -- ese worker
 *   todavía no usa este helper, pero el contrato tiene que soportarlo
 *   desde el día uno).
 * - `stop()` seguido de un `start()` mientras el poll anterior todavía
 *   está en vuelo -- sin la generación, quedarían DOS cadenas de timers
 *   vivas sobre el mismo worker.
 *
 * ## `wake()` -- best effort, no garantiza el ciclo en curso
 * Dispara el próximo poll de inmediato en vez de esperar el intervalo
 * programado. Si ya hay un poll EN VUELO cuando se llama, `wake()` no
 * hace nada -- el resultado de ese poll decide el próximo delay como
 * siempre. No hay cola de "un wake pendiente": llamarlo varias veces
 * seguidas equivale a llamarlo una vez.
 *
 * **Ventana de wake perdido (C3, gate `architecture-governor`, ronda 3,
 * 10/09/2026), nombrada explícitamente, no solo "puede pasar":** si se
 * encola trabajo nuevo MIENTRAS un poll ya está en vuelo, y ese poll
 * arrancó ANTES de que el trabajo nuevo existiera, `pollFn()` va a
 * devolver `false` (no lo vio) y el próximo intervalo va a ser
 * `idleIntervalMs` completo -- el `wake()` de ese trabajo se pierde sin
 * dejar rastro. Alcanza para el caso de uso actual (§3.1 del diseño,
 * `CompanyCatalogPropagationWorker`, donde perder un wake solo demora
 * hasta 10 min una propagación de catálogo de baja frecuencia). **NO
 * alcanza para un caso que necesite garantía exacta** (el bloque del
 * wake de `OutboxWorker`, todavía en HOLD, donde el dueño pidió
 * justamente evitar la espera de `idleIntervalMs`) -- ese caso necesita
 * encolar el wake pendiente y consumirlo al terminar el poll en curso,
 * no descartarlo. Es una extensión de este archivo, no una reescritura,
 * pero no está hecha todavía.
 */
export class AdaptivePoller {
  private timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private started = false;
  private inFlight = false;

  constructor(
    private readonly pollFn: () => Promise<boolean>,
    private readonly activeIntervalMs: number,
    private readonly idleIntervalMs: number,
  ) {}

  /** Arranca el scheduler. El primer poll corre después de `activeIntervalMs` -- nunca inmediato (ver docblock del archivo, sección de arranque diferido de cada worker). Llamarlo si ya está arrancado es no-op. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.scheduleNext(this.generation, this.activeIntervalMs);
  }

  /**
   * Detiene el scheduler y espera a que el ciclo en curso (si lo hay)
   * termine antes de resolver -- mismo contrato que ya tenían
   * `OutboxWorker`/`ReservationHoldExpiryWorker`. Incrementa la
   * generación ANTES de esperar, así que ninguna reprogramación en vuelo
   * puede sobrevivir a este `stop()`, sin importar cuándo se haya
   * llamado.
   *
   * Un `stop()` llamado mientras OTRO `stop()` ya está en su propio
   * `while (this.inFlight)` es un no-op inmediato (`this.started` ya es
   * `false`) -- no espera al ciclo en curso. El primer `stop()` en
   * llamarse es el que garantiza la espera; el segundo no aporta nada
   * adicional, pero tampoco rompe nada (mismo resultado final: sin
   * timer armado, sin poll en vuelo).
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    this.generation += 1;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = undefined;
    }
    while (this.inFlight) {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }

  /** Ver docblock del archivo, sección `wake()`. */
  wake(): void {
    if (!this.started || this.inFlight || !this.timeoutHandle) return;
    clearTimeout(this.timeoutHandle);
    this.scheduleNext(this.generation, 0);
  }

  private scheduleNext(generation: number, delayMs: number): void {
    this.timeoutHandle = setTimeout(() => { void this.runCycle(generation); }, delayMs);
  }

  private async runCycle(generation: number): Promise<void> {
    // stop() (o un start() nuevo tras un stop()) invalidó esta cadena mientras dormía.
    if (generation !== this.generation) return;

    this.inFlight = true;
    let foundWork = false;
    try {
      foundWork = await this.pollFn();
    } catch (err) {
      // pollFn() no debería tirar (cada worker atrapa sus propios errores en
      // poll()), pero si lo hace, no puede tumbar el scheduler -- se loguea
      // y se trata como "sin trabajo" para el próximo intervalo.
      logger.error({ err }, '[AdaptivePoller] pollFn() lanzó un error inesperado');
    } finally {
      this.inFlight = false;
    }

    // stop() pudo haber corrido MIENTRAS pollFn() estaba en vuelo.
    if (generation !== this.generation) return;

    this.scheduleNext(generation, foundWork ? this.activeIntervalMs : this.idleIntervalMs);
  }
}
