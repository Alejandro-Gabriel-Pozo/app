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
 *
 * ## Dónde vive el schema
 * - Canónico: src/db/schema.sql  ← este helper siempre usa este path
 * - No existe db/schema.sql en la raíz del proyecto; no crearlo.
 *
 * ## Regla crítica — readFileSync lazy
 * El readFileSync del schema está DENTRO de createTestDatabase(), no en
 * el top-level del módulo. Esto es intencional:
 *
 *   ❌ MAL — explota al importar el módulo, antes de que skipIfNoDb actúe:
 *      const SCHEMA = readFileSync(path, 'utf-8');   // top-level
 *
 *   ✅ BIEN — solo se ejecuta cuando se llama createTestDatabase():
 *      async function createTestDatabase() {
 *        const schema = readFileSync(path, 'utf-8'); // lazy, dentro de la función
 *      }
 *
 * NUNCA mover el readFileSync al top-level. Si el archivo no existe o
 * TEST_DATABASE_URL no está definida, la suite debe saltear (skip), no explotar.
 *
 * ## SqlClient vs PgSqlClient
 * SqlClient es una INTERFAZ (no se puede instanciar con `new`).
 * PgSqlClient es la clase concreta que implementa SqlClient sobre pg.Pool.
 * Siempre usar `new PgSqlClient(pool)` aquí.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { SqlClient } from '../../../repositories/sql.client.js';
import { PgSqlClient } from '../../../repositories/sql.client.js';

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
 *
 * El schema se lee de src/db/schema.sql (relativo a este helper:
 * ../../../db/schema.sql). La lectura es lazy (dentro de esta función)
 * para no explotar al importar el módulo cuando TEST_DATABASE_URL no
 * está definida.
 */
export async function createTestDatabase(): Promise<{ db: SqlClient; dbName: string; pool: pg.Pool }> {
  const baseUrl = process.env.TEST_DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      'TEST_DATABASE_URL no está definida. ' +
      'Ejemplo: TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres',
    );
  }

  // Leer el schema LAZY aquí (no en el top-level del módulo).
  // src/tests/integration/helpers/ → ../../../db/schema.sql = src/db/schema.sql
  const schemaSql = readFileSync(
    resolve(__dirname, '../../../db/schema.sql'),
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

  // max: 3 (valor original) hacía que tests con varias operaciones
  // concurrentes (ej. Bug 2, 10 createReservation() en paralelo, cada uno
  // con ~15-20 queries antes/fuera de la sección lockeada) encolaran casi
  // todo detrás de solo 3 conexiones -- contra un TEST_DATABASE_URL remoto
  // (latencia de red real, no localhost) eso alcanzaba a superar el
  // testTimeout sin que hubiera ningún bug real, solo cola. Encontrado
  // 25/08/2026 verificando Bug 2.
  const pool = new Pool({ connectionString: tenantUrl, max: 15 });
  // PgSqlClient es la clase concreta; SqlClient es solo la interfaz.
  const db = new PgSqlClient(pool);

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
