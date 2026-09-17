/**
 * @file pg-transaction-manager-connection-lifecycle.integration.test.ts
 * @description D-11 (17/09/2026, Wave 8 -- F8-01/C6-06), prueba de integración
 * con Postgres real prescrita por el plan
 * (`docs/auditoria-integral-fase15-2026-09-16.md:348`,
 * `docs/plan-ejecucion-integral-2026-09-16.md`, Etapa 4):
 *
 *   (a) matar la conexión que `PgTransactionManager.run()` tiene abierta
 *       DESDE OTRA SESIÓN mientras corre `work()` (`pg_terminate_backend`),
 *       y afirmar que el error que sale de `run()` es el de `work()` -- no
 *       uno distinto emitido por el ROLLBACK que `run()` intenta después
 *       (ese era el defecto real: antes, un ROLLBACK fallido reemplazaba
 *       al error original en vez de solo logueearse).
 *   (b) tras ese fallo, tomar N conexiones más del MISMO pool (`max: 1`,
 *       para forzar que sea literalmente la misma conexión física la que
 *       se reutilice si el fix no la descarta) y afirmar que ninguna
 *       falla -- ningún caller AJENO hereda una sesión rota o abortada.
 *
 * **Corrección 17/09/2026 (gate `architecture-governor`, tercera pasada)
 * sobre qué garantiza (b) y por qué.** La primera versión de este
 * docblock decía que sin pasarle el error a `release()` "la conexión
 * muerta vuelve al pool sana" -- medido y es falso: `pg-pool@3.14.0`
 * (`index.js::_release()`) descarta la conexión igual si
 * `!client._queryable` (que `pg` ya puso en `false` dentro de
 * `_handleErrorEvent()` al recibir el error de socket), sin importar el
 * argumento de `release()`. Probado con un script descartable:
 * `release(undefined)` sobre una conexión recién matada con
 * `pg_terminate_backend` también la descarta (`{opened:1, removed:1}`,
 * el siguiente caller recibe una conexión sana). Lo que (b) prueba de
 * verdad no es "el argumento de `release()` importa" -- es más general y
 * más débil: "ningún caller posterior hereda una sesión rota", por
 * CUALQUIER mecanismo (el de `pg-pool` o el de D-11). El caso donde SÍ
 * hace falta el argumento explícito -- una conexión que sigue
 * `_queryable` pero quedó en estado de transacción abortada porque el
 * ROLLBACK no llegó a correr -- no lo ejercita este test con Postgres
 * real, solo los tests unitarios de `pg.transaction-manager.test.ts`
 * (mock).
 *
 * `pg-pool` desconecta su propio listener de auto-eviction (`idleListener`)
 * mientras el cliente está afuera del pool (`_acquireClient()`, llama
 * `client.removeListener('error', idleListener)` al entregarlo) -- así que
 * un error que ocurre MIENTRAS `run()` tiene la conexión tomada (como el de
 * este test) no lo evita `pg-pool` por su cuenta para el listener de
 * `'error'` del proceso (ver punto 3 del docblock de
 * `pg.transaction-manager.ts`) -- eso sí depende enteramente de que
 * `PgTransactionManager` ponga y saque su propio listener.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createTestDatabase, dropTestDatabase, requireTestDatabaseUrl, skipIfNoDb } from './helpers/db.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';

const { Pool } = pg;

describe.skipIf(skipIfNoDb)('PgTransactionManager -- D-11, integración con Postgres real (pg_terminate_backend)', () => {
  let dbName: string;
  let schemaPool: pg.Pool; // el que createTestDatabase() devuelve -- solo para el ciclo de vida de la BD temporal
  let txPool: pg.Pool; // max: 1 -- fuerza que la MISMA conexión física se reutilice si el fix falla
  let killerPool: pg.Pool; // "otra sesión", separada, para pg_terminate_backend

  beforeAll(async () => {
    const created = await createTestDatabase();
    dbName = created.dbName;
    schemaPool = created.pool;

    const url = new URL(requireTestDatabaseUrl());
    url.pathname = `/${dbName}`;
    txPool = new Pool({ connectionString: url.toString(), max: 1 });
    killerPool = new Pool({ connectionString: url.toString(), max: 2 });
  });

  afterAll(async () => {
    await txPool.end();
    await killerPool.end();
    await dropTestDatabase(dbName, schemaPool);
  });

  it('el error que sale de run() es el de work() (la conexión cortada por administrador), NO el ECONNRESET que tira el ROLLBACK posterior', async () => {
    // Discriminante real (condición C4 del gate, segunda pasada,
    // 17/09/2026): `.rejects.toThrow()` a secas pasa con CUALQUIER error,
    // incluido el del ROLLBACK -- no prueba nada sobre CUÁL de los dos
    // errores sale. `pg_terminate_backend` deja al `work()` fallar con
    // "terminating connection due to administrator command" (el mensaje
    // que Postgres pone en la propia query rota) y al ROLLBACK posterior
    // fallar por separado con `ECONNRESET` (el socket ya está muerto) --
    // dos mensajes DISTINTOS del mismo incidente, y son exactamente lo
    // que el fix tiene que distinguir.
    const tm = new PgTransactionManager(txPool);
    let capturedPid: number | undefined;

    await expect(
      tm.run(async (client) => {
        const pidResult = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        capturedPid = Number(pidResult.rows[0]!.pid);

        // "Otra sesión" mata la conexión que run() tiene abierta AHORA
        // MISMO, mientras la tiene tomada -- exactamente la ventana en la
        // que pg-pool no puede auto-evitar por su cuenta (ver docblock).
        await killerPool.query('SELECT pg_terminate_backend($1)', [capturedPid]);

        // Cualquier query subsiguiente en esta misma conexión ahora
        // revienta -- ESTE es el error de "work()" que run() debe re-lanzar,
        // sin que el ROLLBACK que run() intenta después lo reemplace.
        await client.query('SELECT 1');
        return 'no-deberia-llegar-aca';
      }),
    ).rejects.toThrow(/terminating connection due to administrator command/);

    expect(capturedPid).toBeDefined();
  });

  it('tras el fallo de arriba, N conexiones más del mismo pool (max: 1) no heredan una sesión rota o abortada', async () => {
    // El pool tiene max: 1 -- si el fix no descartó la conexión muerta del
    // test anterior, esta es la ÚNICA conexión que pg-pool puede ofrecer,
    // y su primera query revienta para un caller que no tiene nada que ver.
    for (let i = 0; i < 5; i++) {
      const client = await txPool.connect();
      try {
        const result = await client.query('SELECT 1 AS ok');
        expect(result.rows[0]).toEqual({ ok: 1 });
      } finally {
        client.release();
      }
    }
  });
});
