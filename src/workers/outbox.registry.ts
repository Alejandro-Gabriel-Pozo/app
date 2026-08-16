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

import type pg                                 from 'pg';
import { OutboxWorker }                        from './outbox.worker.js';
import { SqlDomainEventRepository }            from '../repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository }   from '../repositories/sql.financial-transaction.repository.js';
import { registerFinancialHandlers }           from './outbox.handlers.js';
import { SqlStockMovementRepository }          from '../repositories/sql.stock-movement.repository.js';
import { SqlProductRepository, SqlProductVariantRepository } from '../pos-menu/sql.product.repository.js';
import { SqlAuditLogRepository }               from '../repositories/audit-log.repository.js';
import { ProductService }                      from '../pos-menu/product.service.js';
import { PgTransactionManager }                from '../db/pg.transaction-manager.js';
import { registerInventoryHandlers }           from './inventory.handlers.js';
import { registerEmailHandlers }               from './email.handlers.js';
import { createEmailSender }                   from '../email/email.sender.js';
import { SqlBusinessProfileRepository }        from '../repositories/sql.business-profile.repository.js';
import type { SqlClient }                      from '../repositories/sql.client.js';

const workers = new Map<string, OutboxWorker>();

// Un solo EmailSender para todo el proceso -- no es config por tenant
// (A2.9: la cuenta de envío es infraestructura de la plataforma, ver
// email/email.sender.ts). Se crea una vez, no por cada worker de tenant.
const emailSender = createEmailSender();

/**
 * Arranca un worker de outbox para el tenant dado si aún no existe.
 * Llamar desde tenantMiddleware después de resolver req.db.
 *
 * `rawPool` (además de `db`, el SqlClient) es necesario para el handler de
 * inventario: necesita un TransactionManager real (BEGIN/COMMIT/ROLLBACK
 * span decrementStock() + el insert de stock_movements), y
 * PgTransactionManager exige el pool crudo, no el wrapper SqlClient. No se
 * importa getTenantRawPool() de tenant.middleware.ts acá a propósito —
 * ese archivo ya importa este (ensureTenantWorker/stopTenantWorker) y
 * cerraría un ciclo de imports (dependency-cruiser no-circular). El
 * caller (tenant.middleware.ts) ya tiene el pool, se lo pasa directo.
 */
export function ensureTenantWorker(businessId: string, db: SqlClient, rawPool: pg.Pool): void {
  if (workers.has(businessId)) return;

  const domainEventRepo          = new SqlDomainEventRepository(db);
  const financialTransactionRepo = new SqlFinancialTransactionRepository(db);
  const stockMovementRepo        = new SqlStockMovementRepository();
  const productRepo              = new SqlProductRepository(db);
  const productVariantRepo       = new SqlProductVariantRepository(db);
  const auditLogRepo             = new SqlAuditLogRepository(db);
  const productService           = new ProductService(productRepo, productVariantRepo, auditLogRepo);
  const transactionManager       = new PgTransactionManager(rawPool);
  const businessProfileRepo      = new SqlBusinessProfileRepository(db);

  const worker = new OutboxWorker(domainEventRepo);
  registerFinancialHandlers(worker, financialTransactionRepo);
  registerInventoryHandlers(worker, productService, stockMovementRepo, transactionManager);
  registerEmailHandlers(worker, emailSender, businessProfileRepo);
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

/**
 * Detiene y quita el worker de UN tenant puntual.
 * Usado por tenant.middleware.ts al desalojar (LRU) o invalidar el pool
 * de un negocio — el worker de outbox de ese tenant no tiene sentido
 * seguir corriendo sin su pool.
 */
export async function stopTenantWorker(businessId: string): Promise<void> {
  const worker = workers.get(businessId);
  if (!worker) return;
  workers.delete(businessId);
  await worker.stop();
}
