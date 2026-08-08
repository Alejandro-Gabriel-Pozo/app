/**
 * @file container.ts
 * @description Composition Root — infraestructura stateless y cross-tenant.
 *
 * ## Qué vive aquí y qué no
 *
 * ✅ VIVE EN EL CONTAINER (stateless / cross-tenant):
 * - transactionManager: stateless, no guarda conexión.
 * - outboxWorker: procesa domain_events de la BD central de cada tenant
 *   a través del domainEventRepository inyectado.
 * - getBusinessPlan: consulta la BD de plataforma (PLATFORM_DATABASE_URL).
 *
 * ❌ NO VIVE EN EL CONTAINER (requieren req.db del tenant):
 * - ReservationService, ProductService, CategoryService, ReportService
 * - Todos los SqlXxxRepository de entidades de negocio
 *
 * Estos se construyen por request en cada router mediante funciones
 * buildXxxService(req) que reciben req.db (SqlClient del tenant
 * inyectado por tenantMiddleware). Ver reservations.routes.ts y
 * products.routes.ts como referencia del patrón.
 *
 * ## fix/code-review-bugs
 * - ssl: rejectUnauthorized cambiado de false → true en producción.
 *   rejectUnauthorized: false deshabilitaba la verificación del certificado
 *   SSL, exponiendo la conexión a ataques MITM en proveedores como Render o
 *   Neon que emiten certificados válidos. Si se necesita un cert autofirmado
 *   usar la variable SSL_CERT con el CA bundle correspondiente.
 */

import { TransactionManager }            from './db/transaction-manager.js';
import { DomainEventRepository }         from './repositories/domain-event.repository.js';
import { FinancialTransactionRepository } from './repositories/financial-transaction.repository.js';

import { SqlDomainEventRepository }          from './repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from './repositories/sql.financial-transaction.repository.js';

import { OutboxWorker }              from './workers/outbox.worker.js';
import { registerFinancialHandlers } from './workers/outbox.handlers.js';

import { PlatformRepository } from './platform/platform.repository.js';
import { PgTransactionManager } from './db/pg.transaction-manager.js';
import { BusinessPlan }        from './types/enums.js';
import { SqlClient }           from './repositories/sql.client.js';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool compartido para PLATFORM_DATABASE_URL (BD central de la plataforma)
// ---------------------------------------------------------------------------

let _platformPool: InstanceType<typeof Pool> | null = null;

export function createPlatformPool(): SqlClient {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) {
    throw new Error(
      '[container] PLATFORM_DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }

  if (!_platformPool) {
    _platformPool = new Pool({
      connectionString: url,
      max: 5,
      // rejectUnauthorized: true verifica el certificado SSL del servidor.
      // Proveedores como Render y Neon emiten certs válidos — no deshabilitar.
      // Si usás un cert autofirmado, pasá el CA via SSL_CERT env var.
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
    });
    _platformPool.on('error', (err) => {
      console.error('[platform] Error en pool central:', err.message);
    });
  }

  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await _platformPool!.query(sql, params);
      const rowCount = result.rowCount ?? undefined;
      return {
        rows: result.rows as T[],
        ...(rowCount !== undefined && { rowCount }),
      };
    },
  };
}

export async function closePlatformPool(): Promise<void> {
  if (_platformPool) {
    await _platformPool.end();
    _platformPool = null;
  }
}

// ---------------------------------------------------------------------------
// AppContainer — solo infraestructura stateless y cross-tenant
// ---------------------------------------------------------------------------

export interface AppContainer {
  /**
   * Stateless: gestiona BEGIN/COMMIT/ROLLBACK sobre cualquier SqlClient.
   * Los routers lo reciben y lo pasan a los servicios que lo necesitan.
   */
  transactionManager: TransactionManager;

  /**
   * Worker de outbox. Procesa domain_events pendientes de cada tenant
   * usando el domainEventRepository inyectado al construir el container.
   */
  outboxWorker: OutboxWorker;

  /**
   * Consulta el plan de negocio en la BD central de plataforma.
   * Cross-tenant por naturaleza.
   */
  getBusinessPlan: (businessId: string) => Promise<BusinessPlan>;

  mode: 'postgresql';
}

export async function createAppContainer(): Promise<AppContainer> {
  if (!process.env.PLATFORM_DATABASE_URL) {
    throw new Error(
      '[container] PLATFORM_DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }
  return createPostgresContainer();
}

async function createPostgresContainer(): Promise<AppContainer> {
  console.log('[container] 🐘 Modo PostgreSQL — conectando a PLATFORM_DATABASE_URL');

  const platformSqlClient  = createPlatformPool();
  const platformRepository = new PlatformRepository(platformSqlClient);

  // El OutboxWorker necesita leer/marcar domain_events de la BD central.
  // NOTA: cuando el sistema escale a events por tenant, el worker
  // deberá instanciarse por tenant con su propio SqlClient.
  const domainEventRepository: DomainEventRepository =
    new SqlDomainEventRepository(platformSqlClient);
  const financialTransactionRepository: FinancialTransactionRepository =
    new SqlFinancialTransactionRepository(platformSqlClient);

  const transactionManager = new PgTransactionManager();

  const outboxWorker = new OutboxWorker(domainEventRepository);
  registerFinancialHandlers(outboxWorker, financialTransactionRepository);

  const getBusinessPlan = async (businessId: string): Promise<BusinessPlan> => {
    const business = await platformRepository.findById(businessId);
    return (business?.plan ?? BusinessPlan.FREE) as BusinessPlan;
  };

  console.log('[container] ✅ PostgreSQL listo.');

  return {
    transactionManager,
    outboxWorker,
    getBusinessPlan,
    mode: 'postgresql',
  };
}
