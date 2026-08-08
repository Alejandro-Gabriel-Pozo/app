/**
 * @file src/tests/integration/helpers/db.ts
 * @description Lifecycle helper para tests de integración.
 *
 * Crea una base de datos PostgreSQL temporal por suite de tests,
 * aplica el schema completo, y la destruye al finalizar.
 *
 * ## Uso
 *
 * ```ts
 * import { createTestDatabase, dropTestDatabase } from './helpers/db.js';
 * import type { SqlClient } from '../../../repositories/sql.client.js';
 *
 * let db: SqlClient;
 * let dbName: string;
 *
 * beforeAll(async () => ({ db, dbName } = await createTestDatabase()));
 * afterAll(async () => dropTestDatabase(dbName));
 * ```
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL debe apuntar a un servidor PostgreSQL donde el
 * usuario tenga permisos de CREATE DATABASE y DROP DATABASE.
 * Ejemplo: postgres://user:pass@localhost:5432/postgres
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SqlClient } from '../../../repositories/sql.client.js';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

// Lee el schema.sql desde src/db/schema.sql (relativo a este helper)
const SCHEMA_SQL = readFileSync(
  resolve(__dirname, '../../../../db/schema.sql'),
  'utf-8',
);

/**
 * Crea una BD temporal `test_<uuid_sin_guiones>`, aplica schema.sql
 * y devuelve un SqlClient conectado a ella.
 */
export async function createTestDatabase(): Promise<{ db: SqlClient; dbName: string; pool: pg.Pool }> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      'TEST_DATABASE_URL no está definida. ' +
      'Ejemplo: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres',
    );
  }

  const dbName = `test_${randomUUID().replace(/-/g, '')}`;

  // Conectar a la BD de control para poder CREATE DATABASE
  const adminPool = new Pool({ connectionString: baseUrl });
  try {
    await adminPool.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await adminPool.end();
  }

  // Construir la URL para la BD nueva
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  const tenantUrl = url.toString();

  const pool = new Pool({ connectionString: tenantUrl, max: 3 });
  const db = new SqlClient(pool);

  // Aplicar schema completo
  await db.query(SCHEMA_SQL, []);

  return { db, dbName, pool };
}

/**
 * Elimina la BD temporal. Llamar en afterAll().
 * Cierra el pool del tenant antes de hacer DROP.
 */
export async function dropTestDatabase(
  dbName: string,
  pool: pg.Pool,
): Promise<void> {
  await pool.end();

  const baseUrl = process.env.TEST_DATABASE_URL!;
  const adminPool = new Pool({ connectionString: baseUrl });
  try {
    // Forzar desconexión de sesiones activas antes de DROP
    await adminPool.query(
      `SELECT pg_terminate_backend(pid)
       FROM pg_stat_activity
       WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await adminPool.end();
  }
}
