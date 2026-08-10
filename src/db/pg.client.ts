/**
 * @file pg.client.ts
 * @description Adaptador que conecta el driver `pg` con la interfaz `SqlClient`.
 *
 * ## Variables de entorno
 *
 * | Variable        | Obligatoria | Descripción                                   |
 * |-----------------|-------------|-----------------------------------------------|
 * | DATABASE_URL    | ✅ Sí       | Connection string de la BD de plataforma      |
 * | NEON_SSL        | No          | 'true' para forzar SSL con rejectUnauthorized |
 * | DB_POOL_MAX     | No          | Máx conexiones del pool (default: 10)          |
 * | DB_POOL_IDLE_MS | No          | Idle timeout en ms (default: 30 000)          |
 *
 * ## SSL y Neon
 *
 * Neon provee certificados válidos firmados por una CA pública.
 * La URL puede incluir ?sslmode=require — se elimina con stripSslMode()
 * para evitar conflictos con el objeto ssl: del driver `pg`, que es lo
 * que provoca el warning:
 *   "SSL modes 'require' are treated as aliases for 'verify-full'"
 *
 * En Render, agregar la variable NEON_SSL=true en Environment Variables
 * para activar la validación completa del certificado.
 * En local (sin NEON_SSL), el pool no usa SSL para conectar a Postgres local.
 */

import pg from 'pg';
import { SqlClient } from '../repositories/sql.client.js';

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
 * Configuración SSL para el pool.
 *
 * - NEON_SSL=true  → rejectUnauthorized: true  (Neon / producción)
 * - Sin NEON_SSL   → false                      (Postgres local)
 *
 * Se prefiere NEON_SSL a NODE_ENV porque en Render ambas variables
 * deben setearse explícitamente y NODE_ENV puede no estar definida.
 */
function sslConfig(): pg.PoolConfig['ssl'] {
  return process.env.NEON_SSL === 'true'
    ? { rejectUnauthorized: true }
    : false;
}

// ---------------------------------------------------------------------------
// Pool lazy
// ---------------------------------------------------------------------------

let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (_pool) return _pool;

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      '[pg.client] DATABASE_URL no está definida. ' +
      'Configurála en Render Dashboard → Environment Variables.',
    );
  }

  const connectionString = stripSslMode(rawUrl);

  _pool = new Pool({
    connectionString,
    max:                    parseInt(process.env.DB_POOL_MAX    ?? '10',    10),
    idleTimeoutMillis:      parseInt(process.env.DB_POOL_IDLE_MS ?? '30000', 10),
    connectionTimeoutMillis: 5_000,
    ssl: sslConfig(),
  });

  _pool.on('error', (err) => {
    console.error('[pg.client] Error inesperado del pool:', err.message);
  });

  return _pool;
}

// ---------------------------------------------------------------------------
// SqlClient
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
// ---------------------------------------------------------------------------

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
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
