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
