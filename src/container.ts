/**
 * @file container.ts
 * @description Composición de dependencias (Composition Root).
 *
 * ## Cambios en esta versión
 * - Se agrega `SqlDomainEventRepository` al container PostgreSQL.
 * - Se agrega `SqlFinancialTransactionRepository` al container PostgreSQL.
 * - Se inyectan ambos en `ReservationService` (parámetros opcionales 5.° y 6.°)
 *   para activar el outbox transaccional en modo PostgreSQL.
 * - Se crea y expone `outboxWorker` en el container para que `server.ts`
 *   pueda arrancarlo y detenerlo con graceful shutdown.
 * - El modo in-memory no instancia ni arranca el worker (no hay BD).
 */

import { ReservationService } from './services/reservation.service.js';
import { ReportService } from './services/report.service.js';
import { CategoryService } from './services/category.service.js';

import { ReservationRepository } from './repositories/reservation.repository.js';
import { ResourceRepository } from './repositories/resource.repository.js';
import { OccupancyRepository } from './repositories/occupancy.repository.js';
import { CustomerRepository } from './repositories/customer.repository.js';
import { ICategoryRepository } from './repositories/category.repository.js';

import { InMemoryResourceRepository } from './repositories/in-memory.resource.repository.js';
import { InMemoryReservationRepository } from './repositories/in-memory.reservation.repository.js';
import { InMemoryOccupancyRepository } from './repositories/in-memory.occupancy.repository.js';
import { InMemoryCustomerRepository } from './repositories/in-memory.customer.repository.js';

import { SqlResourceRepository } from './repositories/sql.resource.repository.js';
import { SqlReservationRepository } from './repositories/sql.reservation.repository.js';
import { SqlOccupancyRepository } from './repositories/sql.occupancy.repository.js';
import { SqlCustomerRepository } from './repositories/sql.customer.repository.js';
import { SqlCategoryRepository } from './repositories/sql.category.repository.js';
import { SqlDomainEventRepository } from './repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from './repositories/sql.financial-transaction.repository.js';

import { OutboxWorker } from './workers/outbox.worker.js';
import { registerFinancialHandlers } from './workers/outbox.handlers.js';

import { PlatformRepository } from './platform/platform.repository.js';
import { pgClient } from './db/pg.client.js';
import { platformPgClient } from './db/platform.pg.client.js';
import { seedDemoData } from './seed/demo-data.js';
import { BusinessPlan } from './types/enums.js';

export interface AppContainer {
  resourceRepository:    ResourceRepository;
  reservationRepository: ReservationRepository;
  occupancyRepository:   OccupancyRepository;
  customerRepository:    CustomerRepository;
  categoryRepository:    ICategoryRepository;
  reservationService:    ReservationService;
  reportService:         ReportService;
  categoryService:       CategoryService;
  /** Solo presente en modo PostgreSQL. null en modo in-memory. */
  outboxWorker:          OutboxWorker | null;
  /** Resuelve el plan de un negocio desde la BD central */
  getBusinessPlan:       (businessId: string) => Promise<BusinessPlan>;
  mode: 'in-memory' | 'postgresql';
}

export async function createAppContainer(): Promise<AppContainer> {
  return process.env.DATABASE_URL
    ? createPostgresContainer()
    : createInMemoryContainer();
}

async function createPostgresContainer(): Promise<AppContainer> {
  console.log('[container] 🐘 Modo PostgreSQL — conectando a DATABASE_URL');

  const categoryRepository            = new SqlCategoryRepository(pgClient);
  const resourceRepository            = new SqlResourceRepository(pgClient);
  const customerRepository            = new SqlCustomerRepository(pgClient);
  const reservationRepository         = new SqlReservationRepository(pgClient, resourceRepository);
  const occupancyRepository           = new SqlOccupancyRepository(pgClient);
  const domainEventRepository         = new SqlDomainEventRepository(pgClient);
  const financialTransactionRepository = new SqlFinancialTransactionRepository(pgClient);

  // Inyectar domainEventRepository + pgClient activa el outbox transaccional
  // en confirmReservation() y completeReservation().
  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
    categoryRepository,
    domainEventRepository,
    pgClient,
  );

  const reportService   = new ReportService(occupancyRepository);
  const categoryService = new CategoryService(categoryRepository);

  // Worker: lee domain_events pendientes cada 5 s y los despacha.
  const outboxWorker = new OutboxWorker(domainEventRepository);
  registerFinancialHandlers(outboxWorker, financialTransactionRepository);

  const platformRepository = new PlatformRepository(platformPgClient);
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
    reservationService,
    reportService,
    categoryService,
    outboxWorker,
    getBusinessPlan,
    mode: 'postgresql',
  };
}

async function createInMemoryContainer(): Promise<AppContainer> {
  console.log('[container] 🧠 Modo in-memory — datos no persisten entre reinicios');

  const categoryRepository: ICategoryRepository = {
    findAll:     async () => [],
    findById:    async () => null,
    countActive: async () => 0,
    create:      async (dto) => ({ ...dto, active: true, createdAt: new Date(), updatedAt: new Date() }),
    update:      async (_id, dto) => ({ id: _id, name: '', fields: [], active: true, createdAt: new Date(), updatedAt: new Date(), ...dto }),
    deactivate:  async () => {},
  };

  const resourceRepository    = new InMemoryResourceRepository();
  const reservationRepository = new InMemoryReservationRepository();
  const occupancyRepository   = new InMemoryOccupancyRepository();
  const customerRepository    = new InMemoryCustomerRepository();

  // Sin outbox en in-memory — ReservationService funciona igual que antes.
  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
    categoryRepository,
  );
  const reportService   = new ReportService(occupancyRepository);
  const categoryService = new CategoryService(categoryRepository);

  await seedDemoData({
    resourceRepository,
    reservationRepository,
    occupancyRepository,
    customerRepository,
  });

  const getBusinessPlan = async (_businessId: string): Promise<BusinessPlan> =>
    BusinessPlan.PRO;

  console.log('[container] ✅ In-memory listo con datos demo.');

  return {
    resourceRepository,
    reservationRepository,
    occupancyRepository,
    customerRepository,
    categoryRepository,
    reservationService,
    reportService,
    categoryService,
    outboxWorker: null,   // no hay BD en modo in-memory
    getBusinessPlan,
    mode: 'in-memory',
  };
}
