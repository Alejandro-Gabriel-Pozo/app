/**
 * @file pg.client.ts
 * @description Adaptador que conecta el driver `pg` con la interfaz `SqlClient`.
 *
 * ## Por qué un adaptador y no `pg` directo en los repositorios
 *
 * Los repositorios dependen de `SqlClient` (interfaz genérica), no de `pg`
 * (implementación concreta). Esto permite:
 * - Testear repositorios con un mock de `SqlClient` sin levantar Postgres.
 * - Cambiar el driver (pg → mysql2 → better-sqlite3) sin tocar los repositorios.
 * - Este archivo es el único lugar del proyecto que conoce que estamos en `pg`.
 *
 * ## Configuración en Render
 *
 * Render inyecta automáticamente `DATABASE_URL` cuando enlazas un PostgreSQL
 * al servicio. El valor tiene el formato:
 *   postgresql://user:password@host:5432/dbname
 *
 * ## Variables de entorno (Render Dashboard)
 *
 * | Variable        | Obligatoria | Valor de ejemplo                          |
 * |-----------------|-------------|-------------------------------------------|
 * | DATABASE_URL    | ✅ Sí       | postgresql://user:pass@host:5432/db       |
 * | DB_POOL_MAX     | No          | 10 (default: 10)                          |
 * | DB_POOL_IDLE_MS | No          | 30000 (default: 30 000 ms)               |
 *
 * ## SSL y Neon
 *
 * Neon provee certificados firmados por una CA pública. En producción se
 * usa rejectUnauthorized: true para validar el certificado completo.
 * La URL de Neon puede incluir ?sslmode=require — se elimina de la
 * connectionString para evitar conflictos con la opción ssl: del driver.
 */

import pg from 'pg';
import { SqlClient } from '../repositories/sql.client.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Helpers SSL
// ---------------------------------------------------------------------------

/**
 * Elimina el parámetro ?sslmode=... de la URL para evitar conflictos con
 * la opción ssl: del driver. El driver `pg` acepta sslmode en la URL pero
 * puede ignorar el objeto ssl: si ambos están presentes, lo que provoca
 * SELF_SIGNED_CERT_IN_CHAIN en Neon.
 */
function stripSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Configuración SSL ajustada al entorno.
 *
 * - producción : rejectUnauthorized: true  → valida el cert completo de Neon.
 * - desarrollo  : false                    → sin SSL para Postgres local.
 *
 * Nota: tenant.middleware.ts aplica la misma lógica para los pools de tenant.
 * Cualquier cambio aquí debe replicarse allá.
 */
function sslConfig(): pg.PoolConfig['ssl'] {
  return process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: true }
    : false;
}

// ---------------------------------------------------------------------------
// Pool lazy — se crea solo la primera vez que se necesita, no al importar.
// Esto evita que los tests unitarios exploten con
// "DATABASE_URL no está definida" al importar el módulo.
// ---------------------------------------------------------------------------

let _pool: InstanceType<typeof Pool> | null = null;

function getPool(): InstanceType<typeof Pool> {
  if (_pool) return _pool;

  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      '[pg.client] DATABASE_URL no está definida. ' +
      'Configúrala en Render Dashboard → Environment Variables.',
    );
  }

  const connectionString = stripSslMode(rawUrl);

  _pool = new Pool({
    connectionString,
    max: parseInt(process.env.DB_POOL_MAX ?? '10', 10),
    idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS ?? '30000', 10),
    connectionTimeoutMillis: 5_000,
    ssl: sslConfig(),
  });

  _pool.on('error', (err) => {
    console.error('[pg.client] Error inesperado del pool:', err.message);
  });

  return _pool;
}

// ---------------------------------------------------------------------------
// Implementación de SqlClient
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
// Soporte para transacciones
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
// Health check — usado en GET /health
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
