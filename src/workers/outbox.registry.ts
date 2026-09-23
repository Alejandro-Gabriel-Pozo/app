/**
 * @file outbox.registry.ts
 * @description Registro de workers de outbox por tenant.
 *
 * Instancia un OutboxWorker por tenant activo, arrancado bajo demanda
 * desde tenantMiddleware (fix C4) y, desde CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001
 * (11/09/2026), también desde el middleware de `customer.routes.ts` -- dos
 * callers, mismo primitivo idempotente (`ensureTenantWorker`). Esto garantiza
 * que cada worker lea de la base de datos correcta para cada tenant.
 *
 * Trade-off: `ensureTenantWorker` arranca TRES timers por tenant activo, no
 * uno -- `OutboxWorker` a 5 s (abajo), `ReservationHoldExpiryWorker` a 60 s
 * y, desde el Bloque 4 del ADR `docs/diseno-invoice-retry-reverse-window-guard-
 * 2026-09-23.md` (23/09/2026), `InvoicePendingExpiryWorker` también a 60 s
 * (era "DOS timers"/"2N" antes de este bloque -- corregido en el mismo
 * commit que suma el tercero). Con N tenants activos son 3N timers.
 * Aceptable hasta ~200 tenants (mismo techo que MAX_TENANT_POOLS).
 * Más allá, considerar un único worker que itere sobre tenants activos
 * o migrar el outbox a LISTEN/NOTIFY.
 */

import type pg                                 from 'pg';
import { OutboxWorker }                        from './outbox.worker.js';
import { SqlDomainEventRepository }            from '../repositories/sql.domain-event.repository.js';
import { SqlProcessedEventRepository }         from '../repositories/processed-event.repository.js';
import { SqlFinancialTransactionRepository }   from '../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository }                from '../facturacion/sql.invoice.repository.js';
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
import { makeDeadLetterEmailNotifier }         from './dead-letter-notify.js';
import type { PlatformRepository }             from '../platform/platform.repository.js';
import { SqlBusinessProfileRepository }        from '../repositories/sql.business-profile.repository.js';
import { ReservationHoldExpiryWorker }         from './reservation-hold-expiry.worker.js';
import { SqlReservationRepository }            from '../reservas/sql.reservation.repository.js';
import { SqlResourceRepository }               from '../reservas/sql.resource.repository.js';
import { SqlStayRepository }                   from '../pms-estadias/stay.repository.js';
import { SqlAccountsReceivableRepository }     from '../clientes-finanzas/sql.accounts-receivable.repository.js';
import type { SqlClient }                      from '../repositories/sql.client.js';
import { getFrontendOrigin, getInvoicePendingExpiryThresholdMs } from '../config/env.js';
// Bloque 4 (23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-
// 2026-09-23.md §3.3/§6) -- worker hermano de ReservationHoldExpiryWorker,
// mismo ciclo de vida por tenant.
import { InvoicePendingExpiryWorker }          from './invoice-pending-expiry.worker.js';
import { SqlCreditNoteRequestRepository }      from '../facturacion/sql.credit-note-request.repository.js';

const workers = new Map<string, OutboxWorker>();
const holdExpiryWorkers = new Map<string, ReservationHoldExpiryWorker>();
const invoicePendingExpiryWorkers = new Map<string, InvoicePendingExpiryWorker>();

// Un solo EmailSender para todo el proceso -- no es config por tenant
// (A2.9: la cuenta de envío es infraestructura de la plataforma, ver
// email/email.sender.ts). Se crea una vez, no por cada worker de tenant.
const emailSender = createEmailSender();

/**
 * Arranca un worker de outbox y sus DOS hermanos de tenant --
 * `ReservationHoldExpiryWorker` e `InvoicePendingExpiryWorker` (construidos
 * más abajo en este mismo método, citados por nombre, no por línea, desde
 * SCHEMA-ANCHOR-DRIFT-001) -- para el tenant dado si aún no existe. Llamar después de
 * resolver `req.db` -- hoy dos callers: `tenantMiddleware` (staff) y el
 * middleware de `customer.routes.ts` (portal de clientes,
 * CUSTOMER-PORTAL-NO-OUTBOX-WORKER-001, 11/09/2026) -- cualquiera de los
 * dos que llegue primero para un `businessId` gana, el segundo es un no-op
 * por el guard de `workers.has(businessId)` de abajo.
 *
 * `rawPool` (además de `db`, el SqlClient) es necesario para el handler de
 * inventario: necesita un TransactionManager real (BEGIN/COMMIT/ROLLBACK
 * span decrementStock() + el insert de stock_movements), y
 * PgTransactionManager exige el pool crudo, no el wrapper SqlClient. No se
 * importa getTenantRawPool() de tenant.middleware.ts acá a propósito —
 * ese archivo ya importa este (ensureTenantWorker/stopTenantWorker) y
 * cerraría un ciclo de imports (dependency-cruiser no-circular). Cada
 * caller ya tiene su propio pool resuelto, se lo pasa directo.
 */
export function ensureTenantWorker(
  businessId: string,
  db: SqlClient,
  rawPool: pg.Pool,
  /**
   * O5 / D2-C (07/09/2026) — solo lectura, contra la PLATFORM DB
   * (`getManagementEmails`). `tenant.middleware.ts` ya lo tiene y lo pasa;
   * no se importa `getPlatformRawPool()` acá para no acoplar el registry al
   * container (DEFENSIVE_DEVELOPING §3: el repo ya viene construido con la
   * BD correcta).
   */
  platformRepo: Pick<PlatformRepository, 'getManagementEmails'>,
): void {
  if (workers.has(businessId)) return;

  const domainEventRepo          = new SqlDomainEventRepository(db);
  const financialTransactionRepo = new SqlFinancialTransactionRepository(db);
  // ADR común cancelar-con-NC sub-bloque 5 (b) -- `handleOrderCancelled` lo
  // usa para clasificar `CARGO_CON_COMPROBANTE_VIVO` post-escape. Mismo `db`
  // de tenant que el resto (DEFENSIVE_DEVELOPING §3).
  const invoiceRepo              = new SqlInvoiceRepository(db);
  // STAY-ADJUSTMENT-PRICE-001 (11/09/2026, gate `architecture-governor`) --
  // `handleReservationPriceAdjusted` lo usa para heredar `stay_id` en el
  // ADJUSTMENT de un ajuste de precio confirmado DESPUÉS del check-in. Mismo
  // `db` de tenant que el resto (DEFENSIVE_DEVELOPING §3).
  const stayRepo                 = new SqlStayRepository(db);
  // City Ledger Bloque 3a (13/09/2026, gate `architecture-governor`) --
  // `handleReservationCancelled` lo usa para detectar AR viva colgada de
  // la estadía. `accounts_receivable` es tabla de TENANT (`src/db/schema.sql`,
  // no `platform.schema.sql`) -- mismo `db` de tenant que el resto
  // (DEFENSIVE_DEVELOPING §3), nunca `getPlatformRawPool()`.
  const accountsReceivableRepo   = new SqlAccountsReceivableRepository(db);
  const stockMovementRepo        = new SqlStockMovementRepository();
  const productRepo              = new SqlProductRepository(db);
  const productVariantRepo       = new SqlProductVariantRepository(db);
  const auditLogRepo             = new SqlAuditLogRepository(db);
  const inventoryLevelRepo       = new SqlInventoryLevelRepository(db);
  const transactionManager       = new PgTransactionManager(rawPool);
  const productService           = new ProductService(productRepo, productVariantRepo, auditLogRepo, inventoryLevelRepo, transactionManager);
  const businessProfileRepo      = new SqlBusinessProfileRepository(db);

  // `db` es el SqlClient DEL TENANT (lo pasa el caller -- tenantMiddleware o
  // el middleware de customer.routes.ts), igual que el resto de los repos de
  // arriba — processed_events vive en la tenant DB, no en la de plataforma
  // (docs/DEFENSIVE_DEVELOPING.md §3).
  const processedEventRepo = new SqlProcessedEventRepository(db);

  // O5 / D2-C: aviso por email a los MANAGEMENT del tenant cuando un evento
  // pasa a dead-letter. `dashboardUrl` = misma base que el CORS del frontend
  // (app.ts:181) + /dashboard, donde vive el OutboxAlertBanner. Sin
  // CORS_ORIGIN (dev), cae al puerto default de Next.
  const frontendBase = getFrontendOrigin();
  const onDeadLetterBatch = makeDeadLetterEmailNotifier({
    businessId,
    getManagementEmails: (id) => platformRepo.getManagementEmails(id),
    // B2: identificar el negocio en el aviso -- reusa el businessProfileRepo
    // que ya se construyó arriba (mismo patrón que email.handlers.ts:63,75).
    getBusinessDisplayName: async () => (await businessProfileRepo.get()).displayName,
    emailSender,
    dashboardUrl: `${frontendBase}/dashboard`,
  });

  // Con el 4º argumento presente, OutboxWorker.on() exige nombre en todo
  // handler — la cerca que evita que un handler nuevo quede sin idempotencia
  // por olvido. pollIntervalMs/maxRetries van explícitos porque TypeScript no
  // deja saltear posicionales; son los mismos defaults de la clase.
  const worker = new OutboxWorker(domainEventRepo, 5_000, 60, processedEventRepo, onDeadLetterBatch);
  // O2: el handler financiero necesita transacción propia -- el lock de la
  // fila de la orden y el INSERT del CHARGE tienen que compartir conexión.
  // Es el MISMO PgTransactionManager sobre el pool crudo del tenant que ya
  // usa el handler de inventario (DEFENSIVE_DEVELOPING §3).
  registerFinancialHandlers(worker, financialTransactionRepo, businessProfileRepo, transactionManager, invoiceRepo, db, stayRepo, accountsReceivableRepo);
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

  // Bloque 4 (23/09/2026, docs/diseno-invoice-retry-reverse-window-guard-
  // 2026-09-23.md §3.3/§6) -- worker de vencimiento de facturas PENDING,
  // mismo ciclo de vida que los dos de arriba (por tenant, arrancado acá,
  // detenido en stopTenantWorker/stopAllWorkers). Reusa el `invoiceRepo`
  // ya construido arriba (mismo `db` de tenant, DEFENSIVE_DEVELOPING §3) --
  // creditNoteRequestRepo es nuevo, sobre el mismo `db`, ninguno de los
  // otros handlers de este archivo lo necesitaba hasta ahora.
  const creditNoteRequestRepo = new SqlCreditNoteRequestRepository(db);
  const invoicePendingExpiryWorker = new InvoicePendingExpiryWorker(
    businessId,
    invoiceRepo,
    creditNoteRequestRepo,
    transactionManager,
    getInvoicePendingExpiryThresholdMs(),
  );
  invoicePendingExpiryWorker.start();
  invoicePendingExpiryWorkers.set(businessId, invoicePendingExpiryWorker);
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
  await Promise.allSettled([...invoicePendingExpiryWorkers.values()].map((w) => w.stop()));
  invoicePendingExpiryWorkers.clear();
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

  const invoicePendingExpiryWorker = invoicePendingExpiryWorkers.get(businessId);
  if (invoicePendingExpiryWorker) {
    invoicePendingExpiryWorkers.delete(businessId);
    await invoicePendingExpiryWorker.stop();
  }
}
