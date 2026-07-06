/**
 * @file container.ts
 * @description Composición de dependencias (Composition Root).
 *
 * Siempre usa PostgreSQL (DATABASE_URL obligatoria).
 * El modo in-memory fue eliminado — usar Supabase en todos los entornos.
 */

import { ReservationService }   from './services/reservation.service.js';
import { ReportService }        from './services/report.service.js';
import { CategoryService }      from './services/category.service.js';

import { ReservationRepository }          from './repositories/reservation.repository.js';
import { ResourceRepository }            from './repositories/resource.repository.js';
import { OccupancyRepository }           from './repositories/occupancy.repository.js';
import { CustomerRepository }            from './repositories/customer.repository.js';
import { ICategoryRepository }           from './repositories/category.repository.js';
import { FinancialTransactionRepository } from './repositories/financial-transaction.repository.js';

import { SqlResourceRepository }             from './repositories/sql.resource.repository.js';
import { SqlReservationRepository }          from './repositories/sql.reservation.repository.js';
import { SqlOccupancyRepository }            from './repositories/sql.occupancy.repository.js';
import { SqlCustomerRepository }             from './repositories/sql.customer.repository.js';
import { SqlCategoryRepository }             from './repositories/sql.category.repository.js';
import { SqlDomainEventRepository }          from './repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from './repositories/sql.financial-transaction.repository.js';

import { OutboxWorker }             from './workers/outbox.worker.js';
import { registerFinancialHandlers } from './workers/outbox.handlers.js';

import { PlatformRepository } from './platform/platform.repository.js';
import { pgClient }           from './db/pg.client.js';
import { SqlClient }          from './repositories/sql.client.js';
import { BusinessPlan }       from './types/enums.js';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool compartido para PLATFORM_DATABASE_URL
// Usado tanto por container.ts como por app.ts — fuente única de verdad.
// ---------------------------------------------------------------------------

let _platformPool: InstanceType<typeof Pool> | null = null;

export function createPlatformPool(): SqlClient | null {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) return null;

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
      return { rows: result.rows as T[], rowCount: result.rowCount ?? undefined };
    },
  };
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
  reservationService:             ReservationService;
  reportService:                  ReportService;
  categoryService:                CategoryService;
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

  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
    categoryRepository,
    domainEventRepository,
  );

  const reportService   = new ReportService(occupancyRepository);
  const categoryService = new CategoryService(categoryRepository);

  const outboxWorker = new OutboxWorker(domainEventRepository);
  registerFinancialHandlers(outboxWorker, financialTransactionRepository);

  // Plataforma: instancia única del repositorio fuera del closure.
  const platformSqlClient    = createPlatformPool();
  const platformRepository   = platformSqlClient ? new PlatformRepository(platformSqlClient) : null;

  const getBusinessPlan = async (businessId: string): Promise<BusinessPlan> => {
    if (!platformRepository) return BusinessPlan.PRO;
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
    reservationService,
    reportService,
    categoryService,
    outboxWorker,
    getBusinessPlan,
    mode: 'postgresql',
  };
}
