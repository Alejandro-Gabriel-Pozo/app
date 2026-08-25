/**
 * @file pg.client.ts
 * @description Adaptador que conecta el driver `pg` con la interfaz `SqlClient`.
 *
 * ## Variables de entorno
 *
 * | Variable        | Obligatoria | Descripción                                   |
 * |-----------------|-------------|-----------------------------------------------|
 * | DATABASE_URL    | No          | Legado — solo se usa si checkDatabaseHealth()  |
 * |                 |             | se llama sin argumento (tests, scripts)       |
 * | NEON_SSL        | No          | 'true' para forzar SSL con rejectUnauthorized |
 * | DB_POOL_MAX     | No          | Máx conexiones del pool (default: 10)          |
 * | DB_POOL_IDLE_MS | No          | Idle timeout en ms (default: 30 000)          |
 *
 * ## SSL y Neon
 *
 * Neon provee certificados válidos firmados por una CA pública.
 * La URL puede incluir ?sslmode=require — se elimina con stripSslMode()
 * para evitar conflictos con el objeto ssl: del driver `pg`.
 *
 * ## checkDatabaseHealth
 *
 * Acepta un SqlClient opcional. Si se pasa (como en app.ts, donde se
 * pasa platformClient), chequea ese pool. Si no, intenta usar el pool
 * interno de DATABASE_URL (legado, útil en tests y scripts locales).
 */

import pg from 'pg';
import type { SqlClient } from '../repositories/sql.client.js';
import { logger } from '../logger.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Elimina ?sslmode de la URL para que el driver `pg` no lo procese
 * junto al objeto ssl:. De lo contrario Neon emite:
 *   SECURITY WARNING: The SSL modes 'require' are treated as aliases for 'verify-full'
 */
export function stripSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Configuración SSL para el pool — ÚNICA fuente de verdad, usada por todos
 * los pools del proceso (platform, tenant, y este legado): container.ts y
 * platform/tenant.middleware.ts la importan de acá en vez de reimplementarla.
 *
 * - NEON_SSL=true  → rejectUnauthorized: true  (Neon/Supabase — producción)
 * - Sin NEON_SSL   → false                      (Postgres local)
 *
 * Deliberadamente NO existe un estado intermedio "SSL activo mas sin
 * validar certificado" (`{ rejectUnauthorized: false }`): eso habilita SSL
 * sin protección real contra MITM y antes solo lo usaba tenant.middleware.ts,
 * de forma inconsistente con el resto de los pools del proceso pese a que
 * su propio comentario decía ser consistente.
 */
export function sslConfig(): pg.PoolConfig['ssl'] {
  return process.env.NEON_SSL === 'true'
    ? { rejectUnauthorized: true }
    : false;
}

// ---------------------------------------------------------------------------
// Pool lazy (legado — solo se instancia si se llama sin SqlClient)
// ---------------------------------------------------------------------------

let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (_pool) return _pool;

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      '[pg.client] DATABASE_URL no está definida. ' +
      'En producción passá platformClient a checkDatabaseHealth().',
    );
  }

  const connectionString = stripSslMode(rawUrl);

  _pool = new Pool({
    connectionString,
    max:                     parseInt(process.env.DB_POOL_MAX     ?? '10',    10),
    idleTimeoutMillis:       parseInt(process.env.DB_POOL_IDLE_MS ?? '30000', 10),
    connectionTimeoutMillis: 5_000,
    ssl: sslConfig(),
  });

  _pool.on('error', (err) => {
    logger.error({ err: err.message }, '[pg.client] Error inesperado del pool');
  });

  return _pool;
}

// ---------------------------------------------------------------------------
// SqlClient (legado)
// ---------------------------------------------------------------------------

export const pgClient: SqlClient = {
  async query(sql: string, params?: unknown[]) {
    const result = await getPool().query(sql, params);
    const rowCount = result.rowCount ?? undefined;
    return rowCount !== undefined
      ? { rows: result.rows, rowCount }
      : { rows: result.rows };
  },
};

// ---------------------------------------------------------------------------
// Transacciones
// ---------------------------------------------------------------------------

export async function withTransaction<T>(
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const txClient: SqlClient = {
      async query(sql: string, params?: unknown[]) {
        const result = await client.query(sql, params);
        const rowCount = result.rowCount ?? undefined;
        return rowCount !== undefined
          ? { rows: result.rows, rowCount }
          : { rows: result.rows };
      },
    };
    const result = await fn(txClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Health check
//
// Acepta un SqlClient opcional:
//   - Con client (app.ts)  → chequea el pool real de plataforma
//   - Sin client (tests)   → usa el pool interno de DATABASE_URL
// ---------------------------------------------------------------------------

export async function checkDatabaseHealth(client?: SqlClient): Promise<boolean> {
  try {
    if (client) {
      await client.query('SELECT 1');
    } else {
      await getPool().query('SELECT 1');
    }
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabasePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}
