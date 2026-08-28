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
import { SqlProcessedEventRepository }         from '../repositories/processed-event.repository.js';
import { SqlFinancialTransactionRepository }   from '../clientes-finanzas/sql.financial-transaction.repository.js';
import { registerFinancialHandlers }           from './outbox.handlers.js';
import { SqlStockMovementRepository }          from '../repositories/sql.stock-movement.repository.js';
import { SqlInventoryLevelRepository }         from '../repositories/sql.inventory-level.repository.js';
import { SqlProductRepository, SqlProductVariantRepository } from '../pos-menu/sql.product.repository.js';
import { SqlAuditLogRepository }               from '../repositories/audit-log.repository.js';
import { ProductService }                      from '../pos-menu/product.service.js';
import { logger }                              from '../logger.js';
import { PgTransactionManager }                from '../db/pg.transaction-manager.js';
import { registerInventoryHandlers }           from './inventory.handlers.js';
import { registerEmailHandlers }               from './email.handlers.js';
import { createEmailSender }                   from '../email/email.sender.js';
import { SqlBusinessProfileRepository }        from '../repositories/sql.business-profile.repository.js';
import { ReservationHoldExpiryWorker }         from './reservation-hold-expiry.worker.js';
import { SqlReservationRepository }            from '../reservas/sql.reservation.repository.js';
import { SqlResourceRepository }               from '../reservas/sql.resource.repository.js';
import type { SqlClient }                      from '../repositories/sql.client.js';

const workers = new Map<string, OutboxWorker>();
const holdExpiryWorkers = new Map<string, ReservationHoldExpiryWorker>();

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
  const inventoryLevelRepo       = new SqlInventoryLevelRepository(db);
  const transactionManager       = new PgTransactionManager(rawPool);
  const productService           = new ProductService(productRepo, productVariantRepo, auditLogRepo, inventoryLevelRepo, transactionManager);
  const businessProfileRepo      = new SqlBusinessProfileRepository(db);

  // `db` es el SqlClient DEL TENANT (lo pasa tenant.middleware.ts), igual que
  // el resto de los repos de arriba — processed_events vive en la tenant DB,
  // no en la de plataforma (docs/DEFENSIVE_DEVELOPING.md §3).
  const processedEventRepo = new SqlProcessedEventRepository(db);

  // Con el 4º argumento presente, OutboxWorker.on() exige nombre en todo
  // handler — la cerca que evita que un handler nuevo quede sin idempotencia
  // por olvido. pollIntervalMs/maxRetries van explícitos porque TypeScript no
  // deja saltear posicionales; son los mismos defaults de la clase.
  const worker = new OutboxWorker(domainEventRepo, 5_000, 60, processedEventRepo);
  registerFinancialHandlers(worker, financialTransactionRepo, businessProfileRepo);
  registerInventoryHandlers(worker, productService, stockMovementRepo, transactionManager);
  registerEmailHandlers(worker, emailSender, businessProfileRepo);
  worker.start();

  workers.set(businessId, worker);
  logger.info({ businessId }, '[outbox] Worker arrancado para tenant');

  // C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md)
  // -- worker de liberación de holds vencidos, mismo ciclo de vida que el
  // de outbox (por tenant, arrancado acá, detenido en stopTenantWorker/
  // stopAllWorkers).
  const reservationRepo = new SqlReservationRepository(db, new SqlResourceRepository(db));
  const holdExpiryWorker = new ReservationHoldExpiryWorker(
    businessId,
    reservationRepo,
    financialTransactionRepo,
    domainEventRepo,
    transactionManager,
  );
  holdExpiryWorker.start();
  holdExpiryWorkers.set(businessId, holdExpiryWorker);
}

/**
 * Detiene todos los workers activos.
 * Llamar en el hook onShutdown del servidor.
 */
export async function stopAllWorkers(): Promise<void> {
  await Promise.allSettled([...workers.values()].map((w) => w.stop()));
  workers.clear();
  await Promise.allSettled([...holdExpiryWorkers.values()].map((w) => w.stop()));
  holdExpiryWorkers.clear();
}

/**
 * Detiene y quita el worker de UN tenant puntual.
 * Usado por tenant.middleware.ts al desalojar (LRU) o invalidar el pool
 * de un negocio — el worker de outbox de ese tenant no tiene sentido
 * seguir corriendo sin su pool.
 */
export async function stopTenantWorker(businessId: string): Promise<void> {
  const worker = workers.get(businessId);
  if (worker) {
    workers.delete(businessId);
    await worker.stop();
  }

  const holdExpiryWorker = holdExpiryWorkers.get(businessId);
  if (holdExpiryWorker) {
    holdExpiryWorkers.delete(businessId);
    await holdExpiryWorker.stop();
  }
}
