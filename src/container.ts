/**
 * @file container.ts
 * @description Composición de dependencias (Composition Root).
 *
 * ## Cambios en esta versión
 * - Se agregan `SqlCategoryRepository` y `CategoryService` al container.
 * - Se expone `categoryService` en `AppContainer`.
 * - Se agrega `getBusinessPlan` como callback que lee `plan` de la BD central
 *   via `PlatformRepository.findById()`. Se usa en las rutas de categorías
 *   para enforcement de límites por plan.
 * - El seed in-memory ya no crea recursos con `type` — usa `categoryId`.
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

  const categoryRepository    = new SqlCategoryRepository(pgClient);
  const resourceRepository    = new SqlResourceRepository(pgClient);
  const customerRepository    = new SqlCustomerRepository(pgClient);
  const reservationRepository = new SqlReservationRepository(pgClient, resourceRepository);
  const occupancyRepository   = new SqlOccupancyRepository(pgClient);

  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
    categoryRepository,
  );
  const reportService    = new ReportService(occupancyRepository);
  const categoryService  = new CategoryService(categoryRepository);

  // Repositorio de la BD central para leer el plan del negocio
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
    getBusinessPlan,
    mode: 'postgresql',
  };
}

async function createInMemoryContainer(): Promise<AppContainer> {
  console.log('[container] 🧠 Modo in-memory — datos no persisten entre reinicios');

  // In-memory no tiene ICategoryRepository real — usamos un stub mínimo
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
    BusinessPlan.PRO; // In-memory siempre PRO para no bloquear el desarrollo

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
    getBusinessPlan,
    mode: 'in-memory',
  };
}
