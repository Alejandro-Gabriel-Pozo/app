/**
 * Interfaz genérica para un cliente SQL (adaptador).
 * Funciona con cualquier driver: pg, mysql2, better-sqlite3, etc.
 *
 * withTransaction fue eliminado de esta interfaz porque pg.client.ts
 * no lo implementaba en el objeto pgClient. Para orquestar transacciones
 * usar withTransaction() exportada desde db/pg.client.ts directamente.
 */
export interface SqlClient {
  query<T = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }>;
}
