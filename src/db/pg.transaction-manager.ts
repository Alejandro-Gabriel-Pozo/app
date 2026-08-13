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
 */

import type pg from 'pg';
import type { TransactionManager } from './transaction-manager.js';
import type { SqlClient }          from '../repositories/sql.client.js';

type PgPool = InstanceType<typeof pg.Pool>;

export class PgTransactionManager implements TransactionManager {
  constructor(private readonly pool: PgPool) {}

  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
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
      await conn.query('ROLLBACK');
      throw err;
    } finally {
      conn.release();
    }
  }
}
