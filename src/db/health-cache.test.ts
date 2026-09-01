import { describe, it, expect, vi } from 'vitest';
import { CachedDbHealth } from './health-cache.js';

/**
 * Estos tests cuentan **consultas reales a la base**. No afirman un porcentaje
 * de ahorro —eso depende de la frecuencia del ping, que todavía no medimos—:
 * afirman hechos verificables sobre el mecanismo (cuántas veces se invoca la
 * sonda bajo condiciones dadas).
 *
 * El reloj se inyecta para que no haya timers reales ni tests que dependan de
 * esperar 30 segundos.
 */

/** Reloj manual — avanza solo cuando el test lo dice. */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('CachedDbHealth', () => {
  it('la primera llamada consulta la base', async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const health = new CachedDbHealth(probe, { now: fakeClock().now });

    const snap = await health.get();

    expect(probe).toHaveBeenCalledTimes(1);
    expect(snap).toMatchObject({ ok: true, cached: false, ageMs: 0 });
  });

  it('N llamadas dentro del TTL consultan la base UNA sola vez', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValue(true);
    const health = new CachedDbHealth(probe, { okTtlMs: 30_000, now: clock.now });

    await health.get();
    for (let i = 0; i < 20; i++) {
      clock.advance(1_000);          // 20 pings repartidos en 20 s
      await health.get();
    }

    // 21 requests -> 1 consulta. Es el ahorro, medido en consultas, no estimado.
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('vencido el TTL vuelve a consultar', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValue(true);
    const health = new CachedDbHealth(probe, { okTtlMs: 30_000, now: clock.now });

    await health.get();
    clock.advance(29_999);
    await health.get();
    expect(probe).toHaveBeenCalledTimes(1);

    clock.advance(2);
    const snap = await health.get();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(snap.cached).toBe(false);
  });

  it('expone la antigüedad del valor cacheado — un OK viejo no se disfraza de fresco', async () => {
    const clock = fakeClock();
    const health = new CachedDbHealth(vi.fn().mockResolvedValue(true), {
      okTtlMs: 30_000, now: clock.now,
    });

    await health.get();
    clock.advance(12_000);
    const snap = await health.get();

    expect(snap).toMatchObject({ ok: true, cached: true, ageMs: 12_000 });
  });

  it('un fallo se re-chequea antes que un OK (TTL asimétrico)', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValue(false);
    const health = new CachedDbHealth(probe, {
      okTtlMs: 30_000, failTtlMs: 5_000, now: clock.now,
    });

    await health.get();
    clock.advance(6_000);            // pasó el TTL de fallo, no el de OK
    await health.get();

    // Si se hubiera aplicado el TTL de OK, seguiría en 1: ahorrar consultas
    // no puede retrasar la deteccion de una caida.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('`fresh` saltea la caché — la salida de escape para deploys e incidentes', async () => {
    const clock = fakeClock();
    const probe = vi.fn().mockResolvedValue(true);
    const health = new CachedDbHealth(probe, { okTtlMs: 30_000, now: clock.now });

    await health.get();
    await health.get({ fresh: true });
    await health.get({ fresh: true });

    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('single-flight: 10 requests concurrentes disparan UNA sola consulta', async () => {
    let resolveProbe!: (v: boolean) => void;
    const probe = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveProbe = resolve; }),
    );
    const health = new CachedDbHealth(probe, { now: fakeClock().now });

    const pending = Array.from({ length: 10 }, () => health.get());
    resolveProbe(true);
    const snaps = await Promise.all(pending);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(snaps.every((s) => s.ok)).toBe(true);
  });

  it('`fresh` con una sonda YA en vuelo se suma a esa sonda, no abre otra', async () => {
    // Comportamiento declarado a propósito en el docblock del módulo: la sonda
    // que está corriendo también es fresca. Sin este test, invertir la decisión
    // deja la suite en verde — el governor lo detectó con un mutante que
    // sobrevivía.
    let resolveProbe!: (v: boolean) => void;
    const probe = vi.fn().mockImplementation(
      () => new Promise<boolean>((resolve) => { resolveProbe = resolve; }),
    );
    const health = new CachedDbHealth(probe, { now: fakeClock().now });

    const primera = health.get();                 // arranca la sonda
    const conFresh = health.get({ fresh: true }); // llega con la sonda en vuelo
    resolveProbe(true);
    await Promise.all([primera, conFresh]);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('una sonda que tira se trata como fallo, no propaga la excepción', async () => {
    const probe = vi.fn().mockRejectedValue(new Error('pool agotado'));
    const health = new CachedDbHealth(probe, { now: fakeClock().now });

    const snap = await health.get();

    expect(snap.ok).toBe(false);
    expect(snap.cached).toBe(false);
  });

  it('tras un fallo, una recuperación se refleja al vencer el TTL corto', async () => {
    const clock = fakeClock();
    const probe = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const health = new CachedDbHealth(probe, {
      okTtlMs: 30_000, failTtlMs: 5_000, now: clock.now,
    });

    expect((await health.get()).ok).toBe(false);
    clock.advance(5_001);
    expect((await health.get()).ok).toBe(true);
  });
});
