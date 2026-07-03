import { Pool, PoolClient } from 'pg';

/**
 * Interfaz genérica para un cliente SQL (adaptador).
 * Funciona con cualquier driver: pg, mysql2, better-sqlite3, etc.
 */
export interface SqlClient {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>;

  /**
   * Ejecuta `fn` dentro de una transacción BEGIN/COMMIT/ROLLBACK.
   * Si `fn` lanza, se hace ROLLBACK y el error se re-lanza.
   * El PoolClient no debe usarse fuera del scope de `fn`.
   */
  withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
}
