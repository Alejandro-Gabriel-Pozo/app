/**
 * @file pg.transaction-manager.ts
 * @description Implementación de TransactionManager sobre pg.
 *
 * Recibe el Pool del tenant por constructor para garantizar que
 * todas las operaciones transaccionales operen sobre la base de datos
 * correcta. Ya no usa el pool global de DATABASE_URL (fix C1).
 *
 * Los servicios de aplicación reciben TransactionManager por inyección
 * y no importan nada de pg.client.ts directamente.
 *
 * ## D-11 (17/09/2026, Wave 8 -- `docs/auditoria-integral-fase15-2026-09-16.md`,
 * F8-01/C6-06) -- ciclo de vida de la conexión en el camino de excepción
 *
 * Tres correcciones, converge todo en un solo `finally` (segunda pasada
 * del gate `architecture-governor`, 17/09/2026 -- la primera versión de
 * este bloque tenía `release()` repartido entre el `try` y el `catch`,
 * lo que dejaba abierta una doble-liberación si `release()` mismo
 * fallaba, y liberaba con error SIEMPRE, no solo cuando hacía falta):
 *
 * 1. **El ROLLBACK va en su propio try/catch.** Si TAMBIÉN falla (típico
 *    cuando la conexión ya está cortada -- el mismo motivo por el que
 *    pudo fallar el COMMIT), se loguea pero **no reemplaza** el error
 *    original que se re-lanza. Antes, un ROLLBACK fallido se propagaba
 *    en vez del error real, ocultando qué pasó de verdad -- incluido un
 *    `err.code` específico (p. ej. `23505`) que un caller más arriba
 *    matchea (auditado: ningún caller de los 69 call sites de `run()`
 *    matchea por `.message`/`.match`/`String(err).includes`/`.name`, así
 *    que este cambio no puede quebrar un catch existente -- sí puede
 *    EXPONER uno que antes veía el error equivocado. Efecto downstream
 *    declarado: `workers/outbox.worker.ts::categorizeError()` clasifica
 *    por `err.code`/`err.constructor.name` para la política de reintento
 *    -- cuando el ROLLBACK también falla, ahora ve el SQLSTATE ORIGINAL
 *    en vez del error de conexión del ROLLBACK, p. ej. un `23505` que
 *    antes quedaba enmascarado como transitorio ahora puede ir a
 *    dead-letter en el primer intento. Es la dirección correcta y solo
 *    aplica en ese camino doblemente fallido).
 * 2. **`conn.release(err)` SOLO cuando el ROLLBACK no se pudo confirmar**
 *    -- no en cualquier camino de excepción. Si el ROLLBACK vuelve bien,
 *    Postgres garantiza que la sesión quedó limpia (sin `25P02` para
 *    nadie) y la conexión se reusa normal. Pasar el error SIEMPRE (como
 *    hacía la primera versión de este bloque) destruía una conexión sana
 *    en cada error de negocio corriente -- medido contra Postgres real
 *    (script descartable, no commiteado, `pool.on('connect'|'remove')`):
 *    10 fallas de negocio comunes (p. ej. una violación de constraint)
 *    abrían 10 conexiones físicas y destruían las 10 -- **corregido
 *    17/09/2026, gate `architecture-governor`, tercera pasada: la cifra
 *    anterior de esta nota decía "destruían 9", un artefacto de muestrear
 *    el conteo de `remove` antes de que asentara el último evento** --
 *    contra 1 conexión abierta / 0 destruidas con la regla condicional de
 *    este bloque. Los pools de tenant son `max: 5` contra Neon
 *    (`platform/tenant.middleware.ts`) -- ese churn convierte un fix de
 *    corrección en un riesgo de disponibilidad bajo ráfaga de errores.
 *    Verificado contra `pg-pool@3.14.0`, `index.js::_release()`:
 *    `if (err || ...) return this._remove(...)` -- pasar un error truthy
 *    es lo que fuerza el descarte; `undefined` toma el camino normal
 *    **salvo que `pg` ya haya marcado la conexión `!_queryable`** (lo que
 *    hace en `_handleErrorEvent()` ante cualquier error de socket) -- en
 *    ese caso `pg-pool` la descarta IGUAL aunque se le pase `undefined`
 *    (medido: `release(undefined)` sobre una conexión recién matada con
 *    `pg_terminate_backend` también la descarta). La regla condicional de
 *    este punto no depende de ese mecanismo de respaldo para ser segura
 *    -- lo complementa: cubre además el caso donde el socket sigue vivo
 *    pero la sesión quedó en estado de transacción abortada porque el
 *    ROLLBACK no llegó a correr, que `!_queryable` no detecta por sí solo.
 * 3. **Listener `'error'` en la conexión mientras está fuera del pool,
 *    quitado siempre en el `finally`** -- no previsto en el hallazgo
 *    original, encontrado AL ESCRIBIR la prueba de integración con
 *    Postgres real que el propio plan pedía (`pg_terminate_backend`
 *    desde otra sesión mientras `run()` tiene la conexión tomada). `pg`
 *    (`client.js::_handleErrorEvent()`) hace DOS cosas ante un error de
 *    socket, no una: rechaza la query en curso (lo que el `catch` ya
 *    atrapa) Y ADEMÁS emite su propio evento `'error'` en el cliente.
 *    Mientras la conexión está afuera del pool (`pg-pool` le saca su
 *    `idleListener` al entregarla en `_acquireClient()`), nada escucha
 *    ese segundo evento -- y un `EventEmitter` sin listener de `'error'`
 *    lo relanza como excepción NO CAPTURADA del proceso. Medido: la
 *    prueba de integración de este bloque reproducía exactamente eso
 *    (`Uncaught Exception: read ECONNRESET`, `vitest` salía con exit
 *    code 1 pese a que los tests individuales pasaban) hasta agregar
 *    este listener -- un defecto más severo que los dos de arriba, en la
 *    misma ventana de ciclo de vida. **Se quita siempre en el `finally`**
 *    (no queda pegado a la conexión para siempre): dejarlo puesto suma un
 *    listener nuevo por cada `run()` sobre la MISMA conexión física del
 *    pool -- medido: `MaxListenersExceededWarning` a partir de la
 *    transacción 10 sobre la misma conexión.
 *
 * Contrato completo de qué significa una excepción de `run()` (incluida
 * la ambigüedad del COMMIT, y que la conexión puede descartarse cuando el
 * ROLLBACK no se pudo confirmar): docblock de `transaction-manager.ts`.
 */

import type pg from 'pg';
import type { TransactionManager } from './transaction-manager.js';
import type { SqlClient }          from '../repositories/sql.client.js';
import { logger }                  from '../logger.js';

type PgPool = InstanceType<typeof pg.Pool>;

export class PgTransactionManager implements TransactionManager {
  constructor(private readonly pool: PgPool) {}

  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
    // No-op a propósito: absorbe la segunda emisión de 'error' que `pg`
    // hace sobre el cliente además de rechazar la query en curso (ver
    // docblock del archivo, punto 3). Función nombrada (no una lambda
    // anónima inline) para poder sacarla con `removeListener` en el
    // `finally` -- sin eso, se acumula un listener por transacción sobre
    // la misma conexión del pool.
    const swallowSocketError = (): void => {};
    conn.on('error', swallowSocketError);

    // Solo se llena si el ROLLBACK (o la propia query que falló) dejó la
    // conexión en estado dudoso -- ver docblock, punto 2. `undefined` en
    // cualquier otro camino: el pool reusa la conexión normal.
    let releaseErr: Error | undefined;

    try {
      await conn.query('BEGIN');
      const tx: SqlClient = {
        async query(sql: string, params?: unknown[]) {
          const r = await conn.query(sql, params as unknown[]);
          const rowCount = r.rowCount ?? undefined;
          return rowCount !== undefined
            ? { rows: r.rows, rowCount }
            : { rows: r.rows };
        },
      };
      const result = await work(tx);
      await conn.query('COMMIT');
      return result;
    } catch (err) {
      try {
        await conn.query('ROLLBACK');
      } catch (rollbackErr) {
        releaseErr = err instanceof Error ? err : new Error(String(err));
        logger.error(
          { err: rollbackErr, originalErrorMessage: err instanceof Error ? err.message : String(err) },
          '[PgTransactionManager] ROLLBACK falló tras un error en la transacción -- se descarta la conexión y se re-lanza el error original (originalErrorMessage), no el del ROLLBACK',
        );
      }
      throw err;
    } finally {
      conn.removeListener('error', swallowSocketError);
      conn.release(releaseErr);
    }
  }
}
