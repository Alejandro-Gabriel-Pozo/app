/**
 * @file outbox.registry.ts
 * @description Registro de workers de outbox por tenant.
 *
 * Instancia un OutboxWorker por tenant activo, arrancado bajo demanda
 * desde tenantMiddleware (fix C4). Esto garantiza que cada worker lea
 * de la base de datos correcta para cada tenant.
 *
 * Trade-off: con N tenants activos hay N timers de 5 s.
 * Aceptable hasta ~200 tenants (mismo techo que MAX_TENANT_POOLS).
 * Más allá, considerar un único worker que itere sobre tenants activos
 * o migrar el outbox a LISTEN/NOTIFY.
 */

import { OutboxWorker }                        from './outbox.worker.js';
import { SqlDomainEventRepository }            from '../repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository }   from '../repositories/sql.financial-transaction.repository.js';
import { registerFinancialHandlers }           from './outbox.handlers.js';
import type { SqlClient }                      from '../repositories/sql.client.js';

const workers = new Map<string, OutboxWorker>();

/**
 * Arranca un worker de outbox para el tenant dado si aún no existe.
 * Llamar desde tenantMiddleware después de resolver req.db.
 */
export function ensureTenantWorker(businessId: string, db: SqlClient): void {
  if (workers.has(businessId)) return;

  const domainEventRepo          = new SqlDomainEventRepository(db);
  const financialTransactionRepo = new SqlFinancialTransactionRepository(db);

  const worker = new OutboxWorker(domainEventRepo);
  registerFinancialHandlers(worker, financialTransactionRepo);
  worker.start();

  workers.set(businessId, worker);
  console.log(`[outbox] Worker arrancado para tenant ${businessId}`);
}

/**
 * Detiene todos los workers activos.
 * Llamar en el hook onShutdown del servidor.
 */
export async function stopAllWorkers(): Promise<void> {
  await Promise.allSettled([...workers.values()].map((w) => w.stop()));
  workers.clear();
}
