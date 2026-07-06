/**
 * @file pg.transaction-manager.ts
 * @description Implementación de TransactionManager sobre pg.
 *
 * Este es el único archivo de infraestructura que conoce withTransaction.
 * Los servicios de aplicación reciben TransactionManager por inyección
 * y no importan nada de pg.client.ts directamente.
 */

import { TransactionManager } from './transaction-manager.js';
import { withTransaction }    from './pg.client.js';
import { SqlClient }          from '../repositories/sql.client.js';

export class PgTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    return withTransaction(work);
  }
}
