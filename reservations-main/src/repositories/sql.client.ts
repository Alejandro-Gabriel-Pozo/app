/**
 * Interfaz genérica para un cliente SQL (adaptador).
 * Funciona con cualquier driver: pg, mysql2, better-sqlite3, etc.
 */
export interface SqlClient {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: unknown[]; rowCount?: number }>;
}
