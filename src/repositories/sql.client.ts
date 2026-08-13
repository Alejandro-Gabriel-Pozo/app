import type pg from 'pg';

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
 * instanciar `new PgSqlClient(pool)` directamente.
 *
 * NOTA: el nombre de la clase es distinto al de la interfaz para evitar
 * la colisión que causaba que el campo `pool` privado "filtrara" al tipo
 * de la interfaz (TS2741).
 */
export class PgSqlClient implements SqlClient {
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
