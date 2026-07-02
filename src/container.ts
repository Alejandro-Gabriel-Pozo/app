/**
 * @file container.ts
 * @description Composición de dependencias (Composition Root).
 *
 * ## Estrategia de selección de repositorios
 *
 * El container detecta automáticamente si `DATABASE_URL` está definida:
 *
 * ```
 * DATABASE_URL definida  →  SqlReservationRepository + pg.Pool
 * DATABASE_URL ausente   →  InMemoryReservationRepository (dev / tests)
 * ```
 *
 * Esto garantiza que:
 * - Los tests unitarios y de integración funcionan sin Postgres.
 * - En Render, con `DATABASE_URL` inyectada automáticamente, el deploy
 *   pasa automáticamente a SQL sin ningún cambio de código.
 * - El seed de demo se ejecuta SOLO en modo in-memory.
 *   En modo SQL el seed vive en `schema.sql` (idempotente con ON CONFLICT).
 *
 * ## AppContainer
 *
 * Las propiedades están tipadas contra las INTERFACES, no las
 * implementaciones concretas. Esto cierra el acoplamiento entre
 * capas y facilita el testing.
 */

import { ReservationService } from './services/reservation.service.js';
import { ReportService } from './services/report.service.js';

import { ReservationRepository } from './repositories/reservation.repository.js';
import { ResourceRepository } from './repositories/resource.repository.js';
import { OccupancyRepository } from './repositories/occupancy.repository.js';
import { CustomerRepository } from './repositories/customer.repository.js';

import { InMemoryResourceRepository } from './repositories/in-memory.resource.repository.js';
import { InMemoryReservationRepository } from './repositories/in-memory.reservation.repository.js';
import { InMemoryOccupancyRepository } from './repositories/in-memory.occupancy.repository.js';
import { InMemoryCustomerRepository } from './repositories/in-memory.customer.repository.js';

import { SqlResourceRepository } from './repositories/sql.resource.repository.js';
import { SqlReservationRepository } from './repositories/sql.reservation.repository.js';
import { SqlOccupancyRepository } from './repositories/sql.occupancy.repository.js';
import { SqlCustomerRepository } from './repositories/sql.customer.repository.js';

import { pgClient } from './db/pg.client.js';
import { seedDemoData } from './seed/demo-data.js';

// ---------------------------------------------------------------------------
// Interfaz del container — tipada contra interfaces, no implementaciones
// ---------------------------------------------------------------------------

/**
 * Contenedor de dependencias de la aplicación.
 *
 * Todas las propiedades están tipadas contra las interfaces del repositorio,
 * no las implementaciones concretas. Esto permite que los consumers (routers,
 * servicios) no estén acoplados a in-memory ni a SQL.
 */
export interface AppContainer {
  resourceRepository:    ResourceRepository;
  reservationRepository: ReservationRepository;
  occupancyRepository:   OccupancyRepository;
  customerRepository:    CustomerRepository;
  reservationService:    ReservationService;
  reportService:         ReportService;
  /** Indica el modo de persistencia activo — útil para /health */
  mode: 'in-memory' | 'postgresql';
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Crea y conecta todas las dependencias de la aplicación.
 *
 * Selección automática:
 * - `DATABASE_URL` definida → PostgreSQL (producción / staging en Render)
 * - `DATABASE_URL` ausente  → In-memory (desarrollo local / tests)
 *
 * @returns Contenedor con todos los repositorios y servicios listos
 */
export async function createAppContainer(): Promise<AppContainer> {
  const usePostgres = Boolean(process.env.DATABASE_URL);

  if (usePostgres) {
    return createPostgresContainer();
  }
  return createInMemoryContainer();
}

// ---------------------------------------------------------------------------
// Modo PostgreSQL
// ---------------------------------------------------------------------------

async function createPostgresContainer(): Promise<AppContainer> {
  console.log('[container] 🐘 Modo PostgreSQL — conectando a DATABASE_URL');

  // Los repositorios comparten el mismo pool (pgClient es singleton)
  const resourceRepository    = new SqlResourceRepository(pgClient);
  const customerRepository    = new SqlCustomerRepository(pgClient);
  const reservationRepository = new SqlReservationRepository(
    pgClient,
    resourceRepository,
    customerRepository,
  );
  const occupancyRepository   = new SqlOccupancyRepository(pgClient);

  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
  );
  const reportService = new ReportService(occupancyRepository);

  console.log('[container] ✅ PostgreSQL listo. Seed en schema.sql (idempotente).');

  return {
    resourceRepository,
    reservationRepository,
    occupancyRepository,
    customerRepository,
    reservationService,
    reportService,
    mode: 'postgresql',
  };
}

// ---------------------------------------------------------------------------
// Modo In-memory
// ---------------------------------------------------------------------------

async function createInMemoryContainer(): Promise<AppContainer> {
  console.log('[container] 🧠 Modo in-memory — datos no persisten entre reinicios');

  const resourceRepository    = new InMemoryResourceRepository();
  const reservationRepository = new InMemoryReservationRepository();
  const occupancyRepository   = new InMemoryOccupancyRepository();
  const customerRepository    = new InMemoryCustomerRepository();

  const reservationService = new ReservationService(
    reservationRepository,
    resourceRepository,
    occupancyRepository,
  );
  const reportService = new ReportService(occupancyRepository);

  // El seed solo corre en modo in-memory — en SQL los recursos viven en schema.sql
  await seedDemoData({
    resourceRepository,
    reservationRepository,
    occupancyRepository,
  });

  console.log('[container] ✅ In-memory listo con datos demo.');

  return {
    resourceRepository,
    reservationRepository,
    occupancyRepository,
    customerRepository,
    reservationService,
    reportService,
    mode: 'in-memory',
  };
}
