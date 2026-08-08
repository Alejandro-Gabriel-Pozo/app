import pg from 'pg';

/**
 * Interfaz genérica para un cliente SQL (adaptador).
 * Funciona con cualquier driver: pg, mysql2, better-sqlite3, etc.
 */
export interface SqlClient {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>;
}

/**
 * Implementación concreta de SqlClient sobre un pg.Pool.
 * Usada principalmente en tests de integración donde se necesita
 * instanciar `new SqlClient(pool)` directamente.
 */
export class SqlClient implements SqlClient {
  constructor(private readonly pool: InstanceType<typeof pg.Pool>) {}

  async query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }> {
    const result = await this.pool.query(sql, params);
    const rowCount = result.rowCount ?? undefined;
    return rowCount !== undefined
      ? { rows: result.rows as T[], rowCount }
      : { rows: result.rows as T[] };
  }
}
