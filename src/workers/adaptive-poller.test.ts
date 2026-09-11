import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AdaptivePoller } from './adaptive-poller.js';

describe('AdaptivePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('el primer poll corre después de activeIntervalMs -- nunca inmediato', async () => {
    const pollFn = vi.fn(async () => false);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    expect(pollFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(999);
    expect(pollFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(pollFn).toHaveBeenCalledTimes(1);

    await poller.stop();
  });

  it('si el poll encuentra trabajo (true), el próximo delay es activeIntervalMs', async () => {
    const pollFn = vi.fn(async () => true);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // poll #1
    expect(pollFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(pollFn).toHaveBeenCalledTimes(1); // todavía no -- si esto fallara, el mutante "usar idle siempre" no se detectaría
    await vi.advanceTimersByTimeAsync(1);
    expect(pollFn).toHaveBeenCalledTimes(2); // poll #2, a los 1000ms de nuevo

    await poller.stop();
  });

  it('si el poll NO encuentra trabajo (false), el próximo delay es idleIntervalMs', async () => {
    const pollFn = vi.fn(async () => false);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // poll #1 -- vacío
    expect(pollFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // si el mutante invirtiera el booleano (usar active en vez de idle), esto ya dispararía el poll #2
    expect(pollFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9000); // completa los 10_000ms de idle
    expect(pollFn).toHaveBeenCalledTimes(2);

    await poller.stop();
  });

  it('alterna correctamente: encuentra trabajo, después no encuentra, después sí de nuevo', async () => {
    const results = [true, false, true];
    let call = 0;
    const pollFn = vi.fn(async () => results[call++]!);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // poll #1 -- true -> próximo en 1000ms
    expect(pollFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000); // poll #2 -- false -> próximo en 10_000ms
    expect(pollFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000); // NO alcanza -- sigue en idle
    expect(pollFn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(9000); // completa el idle -> poll #3 -- true
    expect(pollFn).toHaveBeenCalledTimes(3);

    await poller.stop();
  });

  it('un stop() llamado DESDE ADENTRO de un poll en curso no deja un timer huérfano vivo (Hallazgo 3 del gate)', async () => {
    let resolvePoll!: (v: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolvePoll = resolve; });
    let selfStopCalled = false;
    let stopPromise: Promise<void> = Promise.resolve();

    const poller = new AdaptivePoller(
      async () => {
        // Simula OutboxWorker.handlePollError(): el propio poll llama a
        // stop() sobre sí mismo, sin esperarlo (fire-and-forget), antes
        // de resolver.
        if (!selfStopCalled) {
          selfStopCalled = true;
          stopPromise = poller.stop();
        }
        return pending;
      },
      1000,
      10_000,
    );

    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // dispara el poll, que llama a stop() adentro

    resolvePoll(false); // deja que el poll (y el stop() que espera inFlight) terminen
    await vi.advanceTimersByTimeAsync(50); // stop() espera inFlight en steps de 50ms
    await stopPromise; // stop() ya resolvió acá

    // El chequeo de generación posterior al await es lo único que evita
    // reprogramar con la generación vieja acá. Sin él, quedaría un timer
    // huérfano armado hasta idleIntervalMs (10_000ms) DESPUÉS de que
    // stop() ya resolvió -- inofensivo para el resultado de pollFn (el
    // chequeo del tope de runCycle lo neutraliza cuando por fin dispara),
    // pero puede mantener vivo un shutdown que espera a que el event loop
    // se vacíe. Se mide acá, inmediatamente después de stop(), no después
    // de dejarlo disparar y autolimpiarse.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('start() después de un stop() previo arranca una cadena nueva y limpia (sin cadenas duplicadas)', async () => {
    const pollFn = vi.fn(async () => false);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    await poller.stop();

    poller.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pollFn).toHaveBeenCalledTimes(1); // no 2 -- si hubiera dos cadenas vivas, sería 2

    await poller.stop();
  });

  it('stop() antes de start() no rompe', async () => {
    const pollFn = vi.fn(async () => false);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);
    await expect(poller.stop()).resolves.not.toThrow();
  });

  it('start() llamado dos veces no duplica la cadena de timers', async () => {
    const pollFn = vi.fn(async () => false);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    poller.start(); // no-op

    await vi.advanceTimersByTimeAsync(1000);
    expect(pollFn).toHaveBeenCalledTimes(1);

    await poller.stop();
  });

  it('wake() dispara el próximo poll de inmediato en vez de esperar el intervalo programado', async () => {
    const pollFn = vi.fn(async () => false);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    // Todavía no pasó nada del primer activeIntervalMs -- wake() lo adelanta.
    poller.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(pollFn).toHaveBeenCalledTimes(1);

    await poller.stop();
  });

  it('wake() mientras hay un poll en vuelo no hace nada (no encola un segundo)', async () => {
    let resolvePoll!: (v: boolean) => void;
    const pending = new Promise<boolean>((resolve) => { resolvePoll = resolve; });
    const pollFn = vi.fn(() => pending);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // poll en vuelo, todavía no resuelve

    poller.wake(); // no debería programar nada mientras inFlight

    resolvePoll(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(pollFn).toHaveBeenCalledTimes(1); // el wake no sumó una llamada extra

    await poller.stop();
  });

  it('wake() sin haber arrancado no rompe', () => {
    const pollFn = vi.fn(async () => false);
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);
    expect(() => poller.wake()).not.toThrow();
  });

  it('si pollFn() lanza, se loguea y se trata como "sin trabajo" (no tumba el scheduler)', async () => {
    let call = 0;
    const pollFn = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('boom');
      return false;
    });
    const poller = new AdaptivePoller(pollFn, 1000, 10_000);

    poller.start();
    await vi.advanceTimersByTimeAsync(1000); // poll #1 -- tira
    expect(pollFn).toHaveBeenCalledTimes(1);

    // Tratado como "sin trabajo" -> próximo poll a los 10_000ms, no a los 1000ms.
    await vi.advanceTimersByTimeAsync(1000);
    expect(pollFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9000);
    expect(pollFn).toHaveBeenCalledTimes(2);

    await poller.stop();
  });
});
