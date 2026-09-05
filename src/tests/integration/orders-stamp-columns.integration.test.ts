import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb, requireTestDatabaseUrl } from './helpers/db.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { PgSqlClient } from '../../repositories/sql.client.js';

/**
 * schema v46 (03/09/2026) — las cuatro columnas de sello de `orders`.
 *
 * Las cuatro (`confirmed_at`, `cancelled_at`, `completed_at`, `served_at`)
 * estaban declaradas SÓLO dentro del `CREATE TABLE IF NOT EXISTS orders`, que
 * es un no-op en una BD donde la tabla ya existe. `served_at` se agregó el
 * 15/08/2026 a un schema que `biz-demo-01` ya tenía creado desde el 09/08: la
 * columna nunca se creó ahí y ningún deploy posterior la creó -- verificado
 * contra los dos tenants el 03/09/2026 (demo 13 columnas, Álamos 14), los dos
 * en v45 aplicada ese mismo día a la misma hora.
 *
 * ## Por qué hace falta un archivo nuevo
 * `schema-redeploy-idempotent.integration.test.ts` re-aplica `schema.sql`
 * sobre una BD **creada por el mismo `schema.sql`**, así que su tabla `orders`
 * siempre nace completa: estructuralmente no puede ver este drift. Lo que
 * faltaba cubrir es el otro escenario -- una tabla que YA existía con forma
 * vieja -- y eso es V46-02.
 */

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const COLUMNAS_DE_SELLO = ['cancelled_at', 'completed_at', 'confirmed_at', 'served_at'] as const;

/** Las columnas de sello presentes en `orders`, ordenadas por nombre. */
async function columnasDeSello(db: SqlClient): Promise<string[]> {
  const { rows } = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'orders'
        AND column_name = ANY($1::text[])
      ORDER BY column_name`,
    [[...COLUMNAS_DE_SELLO]],
  );
  return rows.map((r) => r.column_name);
}

describe.skipIf(skipIfNoDb)('schema v46 — columnas de sello de orders (integración)', () => {

  // ── V46-01: base limpia ───────────────────────────────────────────────────

  describe('V46-01 — base limpia', () => {
    let db: SqlClient;
    let dbName: string;
    let pool: pg.Pool;

    beforeAll(async () => { ({ db, dbName, pool } = await createTestDatabase()); }, 60_000);
    afterAll(async () => { await dropTestDatabase(dbName, pool); });

    it('aplicar schema.sql a una base limpia crea las cuatro columnas de sello', async () => {
      expect(await columnasDeSello(db)).toEqual([...COLUMNAS_DE_SELLO]);
    });

    it('las cuatro son TIMESTAMPTZ nullable y sin default — el sello lo escribe la transición, no la BD', async () => {
      const { rows } = await db.query<{
        column_name: string; data_type: string; is_nullable: string; column_default: string | null;
      }>(
        `SELECT column_name, data_type, is_nullable, column_default
           FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'orders'
            AND column_name = ANY($1::text[])`,
        [[...COLUMNAS_DE_SELLO]],
      );

      expect(rows).toHaveLength(4);
      for (const columna of rows) {
        expect(columna.data_type).toBe('timestamp with time zone');
        expect(columna.is_nullable).toBe('YES');
        // Un DEFAULT NOW() sellaría la orden al crearla, que es justo lo que
        // ninguna de las cuatro significa.
        expect(columna.column_default).toBeNull();
      }
    });
  });

  // ── V46-02: base que YA existía con la forma vieja ────────────────────────

  describe('V46-02 — tabla orders preexistente sin la columna', () => {
    let dbName: string;
    let pool: pg.Pool;

    afterAll(async () => {
      if (!pool) return;
      await pool.end();
      const adminPool = new Pool({ connectionString: requireTestDatabaseUrl() });
      try {
        await adminPool.query(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
          [dbName],
        );
        await adminPool.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      } finally {
        await adminPool.end();
      }
    });

    it('el re-deploy agrega served_at a una tabla que ya existía, deja la fila intacta y no hace backfill', async () => {
      const baseUrl   = requireTestDatabaseUrl();
      const schemaSql = readFileSync(resolve(__dirname, '../../db/schema.sql'), 'utf-8');

      dbName = `test_v46_${randomUUID().replace(/-/g, '')}`;
      const adminPool = new Pool({ connectionString: baseUrl });
      try {
        await adminPool.query(`CREATE DATABASE "${dbName}"`);
      } finally {
        await adminPool.end();
      }

      const url = new URL(baseUrl);
      url.pathname = `/${dbName}`;
      pool = new Pool({ connectionString: url.toString(), max: 5 });
      const db = new PgSqlClient(pool);

      // 1) Deploy inicial.
      await db.query(schemaSql, []);

      // 2) Se reproduce el tenant drifteado: `orders` como estaba ANTES del
      //    15/08/2026, sin `served_at`. Es la forma exacta que tenía
      //    `biz-demo-01` el 03/09 (13 columnas) y la que ningún
      //    `CREATE TABLE IF NOT EXISTS` puede corregir.
      await db.query(`ALTER TABLE orders DROP COLUMN served_at`, []);
      expect(await columnasDeSello(db)).toEqual(['cancelled_at', 'completed_at', 'confirmed_at']);

      // 3) La causa raíz del 500, como hecho ejecutable y no como hipótesis:
      //    con la columna ausente, el UPDATE que emite `markServed()` no
      //    falla por regla de negocio sino con 42703 (undefined_column), que
      //    no es DomainError y sale por el 500 genérico del errorHandler.
      let codigo: string | undefined;
      try {
        await db.query(`UPDATE orders SET served_at = NOW() WHERE id = 'no-importa'`, []);
      } catch (e) {
        codigo = (e as { code?: string }).code;
      }
      expect(codigo).toBe('42703');

      // 4) Con datos reales cargados: una orden ya cobrada, como la del
      //    incidente. `loc-default` lo siembra el propio schema.sql.
      const ORD = 'ord-v46-preexistente';
      await db.query(
        `INSERT INTO orders (id, business_id, status, total_amount, confirmed_at, completed_at, location_id)
         VALUES ($1, 'biz-v46', 'COMPLETED', 60000, '2026-09-03T11:48:24.292Z', '2026-09-03T11:48:35.446Z', 'loc-default')`,
        [ORD],
      );
      // Tupla explícita, MISMO orden de columnas en las dos lecturas -- no
      // `o::text`: `ADD COLUMN` mete `served_at` al final de la posición
      // física de la tabla, así que el `::text` de la fila entera antes y
      // después del ALTER no son comparables (columnas en distinto orden),
      // aunque el dato no haya cambiado. Un hash sobre dos serializaciones
      // distintas de la misma fila da falso negativo, no un hallazgo real.
      const COLUMNAS_SIN_SELLO_NUEVO = `id, business_id, customer_id, status, notes, total_amount,
                     confirmed_at, cancelled_at, completed_at, created_at, updated_at,
                     stay_id, location_id`;
      const { rows: antes } = await db.query<{ fila: string }>(
        `SELECT md5((${COLUMNAS_SIN_SELLO_NUEVO})::text) AS fila FROM orders WHERE id = $1`, [ORD]);

      // 5) El re-deploy. Antes de v46 esto NO agregaba la columna: corría
      //    entero, registraba la versión nueva y dejaba la tabla igual.
      await db.query(schemaSql, []);

      // La columna aparece...
      expect(await columnasDeSello(db)).toEqual([...COLUMNAS_DE_SELLO]);

      // ...la fila sigue ahí, sin un solo campo tocado (mismo hash sobre las
      // columnas que ya existían: ni backfill, ni bump de `updated_at` por el
      // trigger)...
      const { rows: despues } = await db.query<{ fila: string; served_at: string | null; status: string }>(
        `SELECT md5((${COLUMNAS_SIN_SELLO_NUEVO})::text) AS fila,
                served_at, status
           FROM orders WHERE id = $1`,
        [ORD],
      );
      expect(despues[0]!.fila).toBe(antes[0]!.fila);
      expect(despues[0]!.status).toBe('COMPLETED');

      // ...y `served_at` queda NULL. Eso NO significa "no se sirvió": mientras
      // la columna no existió no hubo forma de registrar el hecho. Inventar un
      // timestamp acá sería fabricar un hecho físico que nadie observó.
      expect(despues[0]!.served_at).toBeNull();

      // 6) Y ahora el sello funciona: el mismo UPDATE que daba 42703.
      await expect(
        db.query(`UPDATE orders SET served_at = NOW() WHERE id = $1`, [ORD]),
      ).resolves.not.toThrow();

      // 7) Idempotente: una pasada más de schema.sql no cambia nada, y no
      //    pisa el sello que se acaba de escribir.
      await expect(db.query(schemaSql, [])).resolves.not.toThrow();
      expect(await columnasDeSello(db)).toEqual([...COLUMNAS_DE_SELLO]);
      const { rows: tercera } = await db.query<{ served_at: string | null }>(
        `SELECT served_at FROM orders WHERE id = $1`, [ORD]);
      expect(tercera[0]!.served_at).not.toBeNull();
    }, 120_000);
  });
});
