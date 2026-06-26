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
 * Render también provee `DATABASE_URL` con SSL requerido internamente.
 * El cliente usa `ssl: { rejectUnauthorized: false }` para conexiones internas
 * de Render — esto es seguro porque la conexión es interna al datacenter.
 * Para conexiones externas (staging, local contra Render DB), usa un certificado
 * real o deshabilita SSL con `PGSSLMODE=disable` en local.
 *
 * ## Variables de entorno (Render Dashboard)
 *
 * | Variable        | Obligatoria | Valor de ejemplo                          |
 * |-----------------|-------------|-------------------------------------------|
 * | DATABASE_URL    | ✅ Sí       | postgresql://user:pass@host:5432/db       |
 * | DB_POOL_MAX     | No          | 10 (default: 10)                          |
 * | DB_POOL_IDLE_MS | No          | 30000 (default: 30 000 ms)               |
 *
 * ## Instalación del driver
 *
 * ```bash
 * npm install pg
 * npm install --save-dev @types/pg
 * ```
 */

import pg from 'pg';
import { SqlClient } from '../repositories/sql.client.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Configuración del pool
// ---------------------------------------------------------------------------

/**
 * Lee y valida la variable DATABASE_URL.
 * Falla en el arranque si no está definida, no en tiempo de request.
 */
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      '[pg.client] DATABASE_URL no está definida. ' +
      'Configúrala en Render Dashboard → Environment Variables.',
    );
  }
  return url;
}

/**
 * Pool de conexiones PostgreSQL.
 *
 * Se inicializa una sola vez al importar el módulo y se reutiliza
 * en toda la vida del proceso. `pg.Pool` maneja reconexiones automáticas.
 *
 * Tamaño del pool:
 * - Render Free tier: max 2-3 (el plan free de Postgres limita conexiones)
 * - Render Starter: max 10-20
 * - Producción: ajustar según `max_connections` de Postgres
 */
const pool = new Pool({
  connectionString: requireDatabaseUrl(),
  max: parseInt(process.env.DB_POOL_MAX ?? '10', 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_MS ?? '30000', 10),
  connectionTimeoutMillis: 5_000,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }  // SSL interno de Render (seguro en datacenter)
    : false,                          // Sin SSL en desarrollo local
});

// Loguear errores del pool que no tienen un caller activo (ej. reconexiones)
pool.on('error', (err) => {
  console.error('[pg.client] Error inesperado del pool:', err.message);
});

// ---------------------------------------------------------------------------
// Implementación de SqlClient
// ---------------------------------------------------------------------------

/**
 * Adaptador `pg.Pool` → `SqlClient`.
 *
 * Adquiere una conexión del pool para cada query y la libera automáticamente.
 * Para transacciones, usa `PgTransactionClient` (ver abajo).
 *
 * @example
 * ```ts
 * import { pgClient } from './db/pg.client.js';
 *
 * const result = await pgClient.query(
 *   'SELECT * FROM reservations WHERE id = $1',
 *   ['res-001'],
 * );
 * ```
 */
export const pgClient: SqlClient = {
  async query(sql: string, params?: unknown[]) {
    const result = await pool.query(sql, params);
    return {
      rows: result.rows,
      rowCount: result.rowCount ?? undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// Soporte para transacciones
// ---------------------------------------------------------------------------

/**
 * Ejecuta una función dentro de una transacción PostgreSQL.
 *
 * La transacción hace COMMIT si la función completa sin error,
 * y ROLLBACK automático si lanza cualquier excepción.
 *
 * @param fn - Función que recibe un `SqlClient` transaccional
 * @returns El valor que retorna `fn`
 *
 * @example
 * ```ts
 * await withTransaction(async (tx) => {
 *   await reservationRepo.saveWithClient(reservation, tx);
 *   await occupancyRepo.recordWithClient(resourceId, ..., tx);
 * });
 * ```
 */
export async function withTransaction<T>(
  fn: (client: SqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const txClient: SqlClient = {
      async query(sql: string, params?: unknown[]) {
        const result = await client.query(sql, params);
        return { rows: result.rows, rowCount: result.rowCount ?? undefined };
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

/**
 * Verifica que la conexión a la base de datos esté activa.
 * Usa un query mínimo para no saturar el pool en health checks frecuentes.
 *
 * @returns `true` si la BD responde, `false` si hay error
 *
 * @example
 * ```ts
 * app.get('/health', async (_req, res) => {
 *   const db = await checkDatabaseHealth();
 *   res.json({ status: 'ok', db: db ? 'connected' : 'error' });
 * });
 * ```
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/**
 * Cierra gracefully el pool de conexiones.
 * Llamar en el shutdown del servidor para no dejar conexiones colgadas.
 *
 * @example
 * ```ts
 * process.on('SIGTERM', async () => {
 *   await closeDatabasePool();
 *   process.exit(0);
 * });
 * ```
 */
export async function closeDatabasePool(): Promise<void> {
  await pool.end();
}
