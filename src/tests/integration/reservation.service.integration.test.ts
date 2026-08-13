/**
 * @file reservation.service.integration.test.ts
 * @description Tests de integración para ReservationService.
 *
 * Cada test corre contra una base de datos PostgreSQL real (BD temporal
 * creada en beforeAll y destruida en afterAll). No usa mocks de
 * repositorios ni del TransactionManager — todo el stack SQL es real.
 *
 * ## Qué se cubre
 *
 * ### createReservation
 * - Crea reserva exitosa → persiste con status PENDING
 * - Falla con recurso inexistente → ResourceNotFoundError
 * - Falla con rango solapado → InvalidReservationError
 * - Concurrencia: 2 requests simultáneos → exactamente 1 éxito, 1 fallo
 *
 * ### confirmReservation
 * - Confirma PENDING → status CONFIRMED + evento domain_events
 * - businessId vacío → Error explícito (guard del servicio)
 * - Reserva inexistente → ReservationNotFoundError
 *
 * ### cancelReservation
 * - Cancela PENDING → CANCELLED + evento domain_events
 * - Cancela CONFIRMED → CANCELLED + evento domain_events
 *
 * ### completeReservation
 * - Completa CONFIRMED → COMPLETED + evento domain_events
 * - Intento sobre PENDING → InvalidReservationError
 *
 * ### updateReservation
 * - Actualiza startTime/endTime de PENDING → persiste cambios
 * - Intento sobre CONFIRMED → InvalidReservationError
 * - Nuevo rango solapado → InvalidReservationError
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 *
 * Si TEST_DATABASE_URL no está definida la suite completa se saltea
 * (skipped) en lugar de fallar el pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import { SqlClient }                            from '../../repositories/sql.client.js';
import { SqlReservationRepository }             from '../../repositories/sql.reservation.repository.js';
import { SqlResourceRepository }               from '../../repositories/sql.resource.repository.js';
import { SqlOccupancyRepository }              from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }              from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository }           from '../../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository }          from '../../repositories/sql.resource-lock.repository.js';
import { SqlBookableServiceRepository }       from '../../repositories/sql.bookable-service.repository.js';
import { SqlCustomerRateRepository }          from '../../repositories/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository }        from '../../repositories/sql.operating-hours.repository.js';
import { SqlHousekeepingRepository }          from '../../repositories/housekeeping.repository.js';
import { PostgresTransactionManager }         from '../../db/postgres-transaction-manager.js';
import { ReservationService }                 from '../../services/reservation.service.js';
import { Customer }                           from '../../domain/entities.js';
import {
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
} from '../../domain/errors.js';

// ---------------------------------------------------------------------------
// Lifecycle de BD
// ---------------------------------------------------------------------------

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

// ---------------------------------------------------------------------------
// Helpers de fixture por test
// ---------------------------------------------------------------------------

const BUSINESS_ID = 'biz-test-001';

async function buildService() {
  const resourceRepo    = new SqlResourceRepository(db);
  const reservationRepo = new SqlReservationRepository(db, resourceRepo);
  const occupancyRepo   = new SqlOccupancyRepository(db);
  const categoryRepo    = new SqlCategoryRepository(db);
  const domainEventRepo = new SqlDomainEventRepository(db);
  const resourceLockRepo = new SqlResourceLockRepository(db);
  const bookableServiceRepo = new SqlBookableServiceRepository(db);
  const customerRateRepo = new SqlCustomerRateRepository(db);
  const operatingHoursRepo = new SqlOperatingHoursRepository(db);
  const housekeepingRepo = new SqlHousekeepingRepository(db);
  const txManager       = new PostgresTransactionManager(pool);

  return new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    txManager,
    resourceLockRepo,
    bookableServiceRepo,
    customerRateRepo,
    operatingHoursRepo,
    housekeepingRepo,
  );
}

async function setupFixture() {
  const category = await seedCategory(db);
  const resource  = await seedResource(db, category.id);
  const customer  = await seedCustomer(db);
  const service   = await buildService();
  return { category, resource, customer, service };
}

// ---------------------------------------------------------------------------
// Suite — se saltea automáticamente si TEST_DATABASE_URL no está definida
// ---------------------------------------------------------------------------

describe.skipIf(skipIfNoDb)('ReservationService — integración', () => {

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  // ─── createReservation ─────────────────────────────────────────────────

  describe('createReservation', () => {
    it('crea una reserva exitosa y la persiste en BD con status PENDING', async () => {
      const { resource, customer, service } = await setupFixture();

      const reservation = await service.createReservation({
        id:         randomUUID(),
        resourceId: resource.id,
        customer:   new Customer(customer.id, customer.fullName, customer.email),
        startTime:  new Date('2030-06-01T10:00:00Z'),
        endTime:    new Date('2030-06-01T12:00:00Z'),
        details:    {},
      });

      expect(reservation.status).toBe('PENDING');
      // Regresión: total_price es NOT NULL sin default — antes de este fix
      // este INSERT fallaba siempre con una violación de constraint.
      expect(reservation.totalPrice).toBe(resource.basePrice);

      const row = await db.query(
        'SELECT status, total_price FROM reservations WHERE id = $1',
        [reservation.id],
      );
      expect(row.rows[0]?.status).toBe('PENDING');
      expect(Number(row.rows[0]?.total_price)).toBe(resource.basePrice);
    });

    it('usa la tarifa especial del cliente en vez del basePrice cuando existe una activa', async () => {
      const { resource, customer, service } = await setupFixture();

      await db.query(
        `INSERT INTO customer_rates (id, business_id, customer_id, resource_id, price)
         VALUES ($1, $2, $3, $4, $5)`,
        [randomUUID(), BUSINESS_ID, customer.id, resource.id, 42],
      );

      const reservation = await service.createReservation({
        id:         randomUUID(),
        resourceId: resource.id,
        customer:   new Customer(customer.id, customer.fullName, customer.email),
        startTime:  new Date('2030-06-01T14:00:00Z'),
        endTime:    new Date('2030-06-01T16:00:00Z'),
        details:    {},
      });

      expect(reservation.totalPrice).toBe(42);
    });

    it('lanza ResourceNotFoundError si el recurso no existe', async () => {
      const { customer, service } = await setupFixture();

      await expect(
        service.createReservation({
          id:         randomUUID(),
          resourceId: 'recurso-inexistente',
          customer:   new Customer(customer.id, customer.fullName, customer.email),
          startTime:  new Date('2030-06-02T10:00:00Z'),
          endTime:    new Date('2030-06-02T12:00:00Z'),
          details:    {},
        }),
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it('lanza InvalidReservationError si el rango se solapa con una reserva existente', async () => {
      const { resource, customer, service } = await setupFixture();
      const customer2 = await seedCustomer(db);

      // Primera reserva: 10:00–12:00
      await service.createReservation({
        id:         randomUUID(),
        resourceId: resource.id,
        customer:   new Customer(customer.id, customer.fullName, customer.email),
        startTime:  new Date('2030-06-03T10:00:00Z'),
        endTime:    new Date('2030-06-03T12:00:00Z'),
        details:    {},
      });

      // Segunda reserva solapada: 11:00–13:00
      await expect(
        service.createReservation({
          id:         randomUUID(),
          resourceId: resource.id,
          customer:   new Customer(customer2.id, customer2.fullName, customer2.email),
          startTime:  new Date('2030-06-03T11:00:00Z'),
          endTime:    new Date('2030-06-03T13:00:00Z'),
          details:    {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('concurrencia: 2 requests simultáneos sobre el mismo slot → exactamente 1 éxito', async () => {
      const { resource, customer, service } = await setupFixture();
      const customer2 = await seedCustomer(db);

      const slot = {
        startTime: new Date('2030-06-10T10:00:00Z'),
        endTime:   new Date('2030-06-10T12:00:00Z'),
      };

      const results = await Promise.allSettled([
        service.createReservation({
          id:         randomUUID(),
          resourceId: resource.id,
          customer:   new Customer(customer.id,  customer.fullName,  customer.email),
          ...slot,
          details:    {},
        }),
        service.createReservation({
          id:         randomUUID(),
          resourceId: resource.id,
          customer:   new Customer(customer2.id, customer2.fullName, customer2.email),
          ...slot,
          details:    {},
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected  = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      // Solo 1 fila en BD para ese slot
      const count = await db.query(
        `SELECT COUNT(*) FROM reservations
         WHERE resource_id = $1
           AND start_time = $2
           AND status != 'CANCELLED'`,
        [resource.id, slot.startTime],
      );
      expect(Number(count.rows[0]!.count)).toBe(1);
    });
  });

  // ─── confirmReservation ────────────────────────────────────────────────

  describe('confirmReservation', () => {
    it('confirma una reserva PENDING → status CONFIRMED + evento en domain_events', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-07-01T10:00:00Z'),
        endTime:   new Date('2030-07-01T12:00:00Z'),
      });

      const confirmed = await service.confirmReservation(seeded.id, BUSINESS_ID);
      expect(confirmed.status).toBe('CONFIRMED');

      // Verifica en BD
      const row = await db.query(
        'SELECT status FROM reservations WHERE id = $1',
        [seeded.id],
      );
      expect(row.rows[0]?.status).toBe('CONFIRMED');

      // Verifica evento de dominio
      const event = await db.query(
        `SELECT event_type, business_id FROM domain_events
         WHERE aggregate_id = $1 AND event_type = 'reservation.confirmed'`,
        [seeded.id],
      );
      expect(event.rows).toHaveLength(1);
      expect(event.rows[0]!.business_id).toBe(BUSINESS_ID);
    });

    it('lanza Error si businessId es string vacío', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-07-02T10:00:00Z'),
        endTime:   new Date('2030-07-02T12:00:00Z'),
      });

      await expect(
        service.confirmReservation(seeded.id, ''),
      ).rejects.toThrow('businessId es obligatorio');
    });

    it('lanza ReservationNotFoundError si la reserva no existe', async () => {
      const { service } = await setupFixture();
      await expect(
        service.confirmReservation('id-inexistente', BUSINESS_ID),
      ).rejects.toThrow(ReservationNotFoundError);
    });
  });

  // ─── cancelReservation ─────────────────────────────────────────────────

  describe('cancelReservation', () => {
    it('cancela una reserva PENDING → status CANCELLED + evento reservation.cancelled', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-08-01T10:00:00Z'),
        endTime:   new Date('2030-08-01T12:00:00Z'),
        status:    'PENDING',
      });

      const cancelled = await service.cancelReservation(seeded.id, BUSINESS_ID);
      expect(cancelled.status).toBe('CANCELLED');

      const event = await db.query(
        `SELECT event_type FROM domain_events
         WHERE aggregate_id = $1 AND event_type = 'reservation.cancelled'`,
        [seeded.id],
      );
      expect(event.rows).toHaveLength(1);
    });

    it('cancela una reserva CONFIRMED → status CANCELLED', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-08-02T10:00:00Z'),
        endTime:   new Date('2030-08-02T12:00:00Z'),
        status:    'CONFIRMED',
      });

      const cancelled = await service.cancelReservation(seeded.id, BUSINESS_ID);
      expect(cancelled.status).toBe('CANCELLED');
    });
  });

  // ─── completeReservation ───────────────────────────────────────────────

  describe('completeReservation', () => {
    it('completa una reserva CONFIRMED → status COMPLETED + evento reservation.completed', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-09-01T10:00:00Z'),
        endTime:   new Date('2030-09-01T12:00:00Z'),
        status:    'CONFIRMED',
      });

      const completed = await service.completeReservation(seeded.id, BUSINESS_ID);
      expect(completed.status).toBe('COMPLETED');

      const event = await db.query(
        `SELECT event_type FROM domain_events
         WHERE aggregate_id = $1 AND event_type = 'reservation.completed'`,
        [seeded.id],
      );
      expect(event.rows).toHaveLength(1);
    });

    it('lanza InvalidReservationError si la reserva está en PENDING', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-09-02T10:00:00Z'),
        endTime:   new Date('2030-09-02T12:00:00Z'),
        status:    'PENDING',
      });

      await expect(
        service.completeReservation(seeded.id, BUSINESS_ID),
      ).rejects.toThrow(InvalidReservationError);
    });
  });

  // ─── updateReservation ─────────────────────────────────────────────────

  describe('updateReservation', () => {
    it('actualiza el rango de tiempo de una reserva PENDING y persiste en BD', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-10-01T10:00:00Z'),
        endTime:   new Date('2030-10-01T12:00:00Z'),
        status:    'PENDING',
      });

      const newStart = new Date('2030-10-01T14:00:00Z');
      const newEnd   = new Date('2030-10-01T16:00:00Z');

      const updated = await service.updateReservation(seeded.id, {
        startTime: newStart,
        endTime:   newEnd,
      });

      expect(updated.startTime).toEqual(newStart);
      expect(updated.endTime).toEqual(newEnd);

      const row = await db.query(
        'SELECT start_time, end_time FROM reservations WHERE id = $1',
        [seeded.id],
      );
      expect(new Date(row.rows[0]!.start_time)).toEqual(newStart);
    });

    it('lanza InvalidReservationError al intentar modificar una reserva CONFIRMED', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-10-02T10:00:00Z'),
        endTime:   new Date('2030-10-02T12:00:00Z'),
        status:    'CONFIRMED',
      });

      await expect(
        service.updateReservation(seeded.id, { startTime: new Date('2030-10-02T14:00:00Z') }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('lanza InvalidReservationError si el nuevo rango se solapa con otra reserva', async () => {
      const { resource, customer, service } = await setupFixture();
      const customer2 = await seedCustomer(db);

      // Reserva fija: 14:00–16:00
      await seedReservation(db, resource.id, customer2.id, {
        startTime: new Date('2030-10-03T14:00:00Z'),
        endTime:   new Date('2030-10-03T16:00:00Z'),
        status:    'CONFIRMED',
      });

      // Reserva a mover: 10:00–12:00 → intentar mover a 13:00–15:00 (solapa)
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-10-03T10:00:00Z'),
        endTime:   new Date('2030-10-03T12:00:00Z'),
        status:    'PENDING',
      });

      await expect(
        service.updateReservation(seeded.id, {
          startTime: new Date('2030-10-03T13:00:00Z'),
          endTime:   new Date('2030-10-03T15:00:00Z'),
        }),
      ).rejects.toThrow(InvalidReservationError);
    });
  });
});
