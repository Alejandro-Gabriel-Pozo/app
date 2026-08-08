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
 * import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
 * import type { SqlClient } from '../../../repositories/sql.client.js';
 *
 * let db: SqlClient;
 * let dbName: string;
 *
 * // Saltear toda la suite si no hay DB disponible (entorno local sin Postgres)
 * describe.skipIf(skipIfNoDb)('Mi suite de integración', () => {
 *   beforeAll(async () => ({ db, dbName } = await createTestDatabase()));
 *   afterAll(async () => dropTestDatabase(dbName, pool));
 * });
 * ```
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL debe apuntar a un servidor PostgreSQL donde el
 * usuario tenga permisos de CREATE DATABASE y DROP DATABASE.
 * Ejemplo: postgres://user:pass@localhost:5432/postgres
 *
 * Si TEST_DATABASE_URL no está definida, skipIfNoDb === true y los tests
 * se saltean sin fallar el pipeline (útil en entornos locales sin Postgres).
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { SqlClient } from '../../../repositories/sql.client.js';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * true cuando TEST_DATABASE_URL no está definida.
 * Usarlo con describe.skipIf(skipIfNoDb) para saltear suites de integración
 * en entornos locales sin PostgreSQL, en lugar de fallar con ENOENT o
 * "TEST_DATABASE_URL no está definida".
 */
export const skipIfNoDb = !process.env.TEST_DATABASE_URL;

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

  // Leer el schema aquí (lazy) en lugar de en el top-level del módulo,
  // para evitar ENOENT al importar el helper cuando el archivo no existe
  // o cuando los tests se saltean con skipIfNoDb.
  const schemaSql = readFileSync(
    resolve(__dirname, '../../../../db/schema.sql'),
    'utf-8',
  );

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
  await db.query(schemaSql, []);

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
