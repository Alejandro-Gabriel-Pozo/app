/**
 * @file container.ts
 * @description Composición de dependencias (Composition Root).
 */

import { ReservationService }   from './services/reservation.service.js';
import { ReportService }        from './services/report.service.js';
import { CategoryService }      from './services/category.service.js';
import { ProductService }       from './services/product.service.js';

import { ReservationRepository }          from './repositories/reservation.repository.js';
import { ResourceRepository }            from './repositories/resource.repository.js';
import { OccupancyRepository }           from './repositories/occupancy.repository.js';
import { CustomerRepository }            from './repositories/customer.repository.js';
import { ICategoryRepository }           from './repositories/category.repository.js';
import { FinancialTransactionRepository } from './repositories/financial-transaction.repository.js';
import { TransactionManager }            from './db/transaction-manager.js';

import { SqlResourceRepository }             from './repositories/sql.resource.repository.js';
import { SqlReservationRepository }          from './repositories/sql.reservation.repository.js';
import { SqlOccupancyRepository }            from './repositories/sql.occupancy.repository.js';
import { SqlCustomerRepository }             from './repositories/sql.customer.repository.js';
import { SqlCategoryRepository }             from './repositories/sql.category.repository.js';
import { SqlDomainEventRepository }          from './repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from './repositories/sql.financial-transaction.repository.js';
import {
  SqlProductRepository,
  SqlProductVariantRepository,
} from './repositories/sql.product.repository.js';

import { OutboxWorker }             from './workers/outbox.worker.js';
import { registerFinancialHandlers } from './workers/outbox.handlers.js';

import { PlatformRepository } from './platform/platform.repository.js';
import { pgClient }           from './db/pg.client.js';
import { SqlClient }          from './repositories/sql.client.js';
import { PgTransactionManager } from './db/pg.transaction-manager.js';
import { BusinessPlan }       from './types/enums.js';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool compartido para PLATFORM_DATABASE_URL (siempre requerida)
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
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
// AppContainer
// ---------------------------------------------------------------------------

export interface AppContainer {
  resourceRepository:             ResourceRepository;
  reservationRepository:          ReservationRepository;
  occupancyRepository:            OccupancyRepository;
  customerRepository:             CustomerRepository;
  categoryRepository:             ICategoryRepository;
  financialTransactionRepository: FinancialTransactionRepository;
  transactionManager:             TransactionManager;
  reservationService:             ReservationService;
  reportService:                  ReportService;
  categoryService:                CategoryService;
  productService:                 ProductService;
  outboxWorker:                   OutboxWorker;
  getBusinessPlan:                (businessId: string) => Promise<BusinessPlan>;
  mode: 'postgresql';
}

export async function createAppContainer(): Promise<AppContainer> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      '[container] DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }
  return createPostgresContainer();
}

async function createPostgresContainer(): Promise<AppContainer> {
  console.log('[container] 🐘 Modo PostgreSQL — conectando a DATABASE_URL');

  const categoryRepository             = new SqlCategoryRepository(pgClient);
  const resourceRepository             = new SqlResourceRepository(pgClient);
  const customerRepository             = new SqlCustomerRepository(pgClient);
  const reservationRepository          = new SqlReservationRepository(pgClient, resourceRepository);
  const occupancyRepository            = new SqlOccupancyRepository(pgClient);
  const domainEventRepository          = new SqlDomainEventRepository(pgClient);
  const financialTransactionRepository = new SqlFinancialTransactionRepository(pgClient);
  const transactionManager             = new PgTransactionManager();

  const productRepository        = new SqlProductRepository(pgClient);
  const productVariantRepository = new SqlProductVariantRepository(pgClient);
  const productService           = new ProductService(productRepository, productVariantRepository);

  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
    categoryRepository,
    domainEventRepository,
    transactionManager,
  );

  const reportService   = new ReportService(occupancyRepository);
  const categoryService = new CategoryService(categoryRepository);

  const outboxWorker = new OutboxWorker(domainEventRepository);
  registerFinancialHandlers(outboxWorker, financialTransactionRepository);

  const platformSqlClient  = createPlatformPool();
  const platformRepository = new PlatformRepository(platformSqlClient);

  const getBusinessPlan = async (businessId: string): Promise<BusinessPlan> => {
    const business = await platformRepository.findById(businessId);
    return (business?.plan ?? BusinessPlan.FREE) as BusinessPlan;
  };

  console.log('[container] ✅ PostgreSQL listo.');

  return {
    resourceRepository,
    reservationRepository,
    occupancyRepository,
    customerRepository,
    categoryRepository,
    financialTransactionRepository,
    transactionManager,
    reservationService,
    reportService,
    categoryService,
    productService,
    outboxWorker,
    getBusinessPlan,
    mode: 'postgresql',
  };
}
