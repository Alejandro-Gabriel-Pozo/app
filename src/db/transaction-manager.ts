/**
 * @file transaction-manager.ts
 * @description Puerto de aplicación para gestión de transacciones.
 *
 * Al definir TransactionManager como interfaz en la capa de aplicación,
 * los servicios dejan de depender de `pg.client.ts` (infraestructura).
 * La implementación concreta (PgTransactionManager) vive en src/db/
 * y se inyecta desde container.ts.
 */

import { SqlClient } from '../repositories/sql.client.js';

export interface TransactionManager {
  run<T>(work: (client: SqlClient) => Promise<T>): Promise<T>;
}
