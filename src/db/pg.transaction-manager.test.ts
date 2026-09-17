/**
 * @file pg.transaction-manager.test.ts
 * @description D-11 (17/09/2026, Wave 8 -- F8-01/C6-06) -- prueba unitaria
 * (mock de pg, sin Postgres real) del contrato del camino de excepción de
 * `PgTransactionManager.run()`:
 *   (1) camino feliz -- COMMIT, `release(undefined)`, listener puesto y
 *       sacado exactamente una vez.
 *   (2) `work()` falla y el ROLLBACK SE CONFIRMA -- `release(undefined)`
 *       (NO el error original: Postgres garantiza sesión limpia tras un
 *       ROLLBACK exitoso), el error original re-lanzado sin cambios. Este
 *       es el test que fija cerrado el defecto de la primera versión de
 *       este bloque (liberaba con error SIEMPRE, incluso cuando la
 *       conexión quedaba sana -- 10x de churn de conexiones medido contra
 *       Postgres real en un error de negocio común).
 *   (3) el COMMIT falla Y el ROLLBACK subsiguiente TAMBIÉN falla --
 *       `release(<error del COMMIT>)`, no el del ROLLBACK, y se re-lanza
 *       el del COMMIT. Exactamente el defecto que F8-01 encontró: antes,
 *       un ROLLBACK fallido reemplazaba al error real en vez de solo
 *       logueearse.
 *   (4) BEGIN falla -- el ROLLBACK trivial que le sigue se confirma sin
 *       problema (no hay transacción que revertir), así que
 *       `release(undefined)`; `work()` nunca se llama.
 *   (5) el listener `'error'` se registra y se quita exactamente una vez,
 *       con la MISMA función, en cualquier camino -- si no se quita, se
 *       acumula un listener por transacción sobre la misma conexión
 *       física del pool (medido contra Postgres real:
 *       `MaxListenersExceededWarning` a partir de la transacción 10).
 *
 * Complementa -- no reemplaza -- la prueba de integración con Postgres
 * real prescrita por el plan (`pg_terminate_backend` desde una segunda
 * sesión), agregada en este MISMO commit:
 * `src/tests/integration/pg-transaction-manager-connection-lifecycle.integration.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { PgTransactionManager } from './pg.transaction-manager.js';

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>;

function makeFakeConn(query: QueryFn) {
  return {
    query: vi.fn(query),
    release: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
}

function makeFakePool(conn: ReturnType<typeof makeFakeConn>) {
  return { connect: vi.fn(async () => conn) } as unknown as InstanceType<typeof pg.Pool>;
}

describe('PgTransactionManager.run() -- D-11, ciclo de vida de la conexión en el camino de excepción', () => {
  it('camino feliz: BEGIN, work(), COMMIT, release(undefined) -- una sola vez', async () => {
    const conn = makeFakeConn(async () => ({ rows: [], rowCount: 0 }));
    const tm = new PgTransactionManager(makeFakePool(conn));

    const result = await tm.run(async () => 'ok');

    expect(result).toBe('ok');
    expect(conn.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalledWith(undefined);
  });

  it('work() falla pero el ROLLBACK SE CONFIRMA: release(undefined) -- NO el error original -- re-lanzado sin cambios', async () => {
    const workError = new Error('boom-negocio');
    const conn = makeFakeConn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`query inesperada en este test: ${sql}`);
    });
    const tm = new PgTransactionManager(makeFakePool(conn));

    await expect(
      tm.run(async () => {
        throw workError;
      }),
    ).rejects.toBe(workError);

    expect(conn.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalledWith(undefined);
  });

  it('COMMIT ambiguo Y el ROLLBACK subsiguiente TAMBIÉN falla: release(<error del COMMIT>), se re-lanza el del COMMIT, no el del ROLLBACK (F8-01)', async () => {
    const commitError = new Error('connection terminated -- COMMIT ambiguo');
    const rollbackError = new Error('connection terminated -- ROLLBACK no pudo ejecutarse');
    const conn = makeFakeConn(async (sql) => {
      if (sql === 'BEGIN') return { rows: [] };
      if (sql === 'COMMIT') throw commitError;
      if (sql === 'ROLLBACK') throw rollbackError;
      throw new Error(`query inesperada en este test: ${sql}`);
    });
    const tm = new PgTransactionManager(makeFakePool(conn));

    await expect(tm.run(async () => 'nunca-importa')).rejects.toBe(commitError);

    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalledWith(commitError);
  });

  it('BEGIN falla: no hay COMMIT ni work(); el ROLLBACK trivial se confirma, release(undefined)', async () => {
    const beginError = new Error('no se pudo iniciar la transacción');
    const conn = makeFakeConn(async (sql) => {
      if (sql === 'BEGIN') throw beginError;
      if (sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`query inesperada en este test: ${sql}`);
    });
    const work = vi.fn(async () => 'no-deberia-correr');
    const tm = new PgTransactionManager(makeFakePool(conn));

    await expect(tm.run(work)).rejects.toBe(beginError);

    expect(work).not.toHaveBeenCalled();
    expect(conn.release).toHaveBeenCalledTimes(1);
    expect(conn.release).toHaveBeenCalledWith(undefined);
  });

  it('registra y quita el listener de error exactamente una vez, con la MISMA función, en cualquier camino', async () => {
    const conn = makeFakeConn(async () => ({ rows: [] }));
    const tm = new PgTransactionManager(makeFakePool(conn));

    await tm.run(async () => 'ok');

    expect(conn.on).toHaveBeenCalledTimes(1);
    expect(conn.removeListener).toHaveBeenCalledTimes(1);
    const [onEvent, onFn] = conn.on.mock.calls[0]!;
    const [offEvent, offFn] = conn.removeListener.mock.calls[0]!;
    expect(onEvent).toBe('error');
    expect(offEvent).toBe('error');
    expect(offFn).toBe(onFn);
  });

  it('registra y quita el listener de error también en el camino de excepción (work() falla)', async () => {
    const workError = new Error('boom');
    const conn = makeFakeConn(async (sql) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      throw new Error(`query inesperada en este test: ${sql}`);
    });
    const tm = new PgTransactionManager(makeFakePool(conn));

    await expect(
      tm.run(async () => {
        throw workError;
      }),
    ).rejects.toBe(workError);

    expect(conn.on).toHaveBeenCalledTimes(1);
    expect(conn.removeListener).toHaveBeenCalledTimes(1);
    const [, onFn] = conn.on.mock.calls[0]!;
    const [, offFn] = conn.removeListener.mock.calls[0]!;
    expect(offFn).toBe(onFn);
  });
});
