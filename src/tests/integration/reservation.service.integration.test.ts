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
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient }                            from '../../repositories/sql.client.js';
import { SqlReservationRepository }             from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository }               from '../../reservas/sql.resource.repository.js';
import { SqlOccupancyRepository }              from '../../reservas/sql.occupancy.repository.js';
import { SqlCategoryRepository }              from '../../reservas/sql.category.repository.js';
import { SqlDomainEventRepository }           from '../../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository }          from '../../reservas/sql.resource-lock.repository.js';
import { SqlBookableServiceRepository }       from '../../reservas/sql.bookable-service.repository.js';
import { SqlCustomerRateRepository }          from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository }        from '../../platform/sql.operating-hours.repository.js';
import { SqlMaintenanceWindowRepository }     from '../../pms-estadias/sql.maintenance-window.repository.js';
import { SqlDepositPolicyRepository }         from '../../reservas/sql.deposit-policy.repository.js';
import { SqlBusinessProfileRepository }       from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository }  from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlNumberSequenceRepository }        from '../../repositories/sql.number-sequence.repository.js';
import { SqlCancellationPolicyRepository }    from '../../reservas/sql.cancellation-policy.repository.js';
import { PostgresTransactionManager }         from '../../db/postgres-transaction-manager.js';
import { ReservationService }                 from '../../reservas/reservation.service.js';
import { Customer }                           from '../../clientes-finanzas/customer.entities.js';
import {
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
  ReservationChargeInvoicedError,
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
  const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(db);
  const txManager       = new PostgresTransactionManager(pool);
  const depositPolicyRepo = new SqlDepositPolicyRepository(db);
  const businessProfileRepo = new SqlBusinessProfileRepository(db);
  const financialTransactionRepo = new SqlFinancialTransactionRepository(db);
  const invoiceRepo = new SqlInvoiceRepository(db);
  const numberSequenceRepo = new SqlNumberSequenceRepository(db);
  const cancellationPolicyRepo = new SqlCancellationPolicyRepository(db);

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
    maintenanceWindowRepo,
    depositPolicyRepo,
    businessProfileRepo,
    financialTransactionRepo,
    invoiceRepo,
    numberSequenceRepo,
    cancellationPolicyRepo,
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

      const row = await db.query<{ status: string; total_price: string }>(
        'SELECT status, total_price FROM reservations WHERE id = $1',
        [reservation.id],
      );
      expect(row.rows[0]?.status).toBe('PENDING');
      expect(Number(row.rows[0]?.total_price)).toBe(resource.basePrice);
    });

    it('usa la tarifa especial del cliente en vez del basePrice cuando existe una activa', async () => {
      const { resource, customer, service } = await setupFixture();

      // `price` se renombró a `fixed_price` (D9-Parte 1, 22/08/2026) --
      // este test seguía usando el nombre viejo, encontrado 25/08/2026
      // verificando Bug 2 contra una BD fresca.
      await db.query(
        `INSERT INTO customer_rates (id, business_id, customer_id, resource_id, fixed_price)
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
      const count = await db.query<{ count: string }>(
        `SELECT COUNT(*) FROM reservations
         WHERE resource_id = $1
           AND start_time = $2
           AND status != 'CANCELLED'`,
        [resource.id, slot.startTime],
      );
      expect(Number(count.rows[0]!.count)).toBe(1);
    });

    it('Bug 2 (25/08/2026) — 10 requests simultáneos sobre el mismo slot → exactamente 1 éxito', async () => {
      // Timeout largo a propósito: el fix (lockByIds) SERIALIZA los 10
      // intentos sobre el mismo recurso -- contra un TEST_DATABASE_URL
      // remoto (no localhost) cada uno paga latencia de red real, y encima
      // hacen cola por el pool de 3 conexiones de createTestDatabase(). No
      // es un signo de que el fix esté mal, es la consecuencia esperada de
      // serializar 10 flujos completos en vez de dejarlos correr en
      // paralelo (que es justamente el bug que este test reproduce).
      // Con solo 2 promesas in-process el gotcha de FOR UPDATE sobre 0 filas
      // (docs/auditoria-tecnica-infra-reservas.md sección 3) no se reproducía
      // de forma confiable -- el event loop de Node podía serializar las dos
      // llamadas lo suficiente como para no exponer la carrera. Con 10
      // intentos concurrentes (mismo orden de magnitud que el script
      // concurrency-test-reservations.ts que sí lo reprodujo con autocannon)
      // este test falla de forma confiable SIN el fix de lockByIds() y pasa
      // con él.
      const { resource, service } = await setupFixture();
      const attempts = 10;
      const customers = await Promise.all(
        Array.from({ length: attempts }, () => seedCustomer(db)),
      );

      const slot = {
        startTime: new Date('2030-06-11T10:00:00Z'),
        endTime:   new Date('2030-06-11T12:00:00Z'),
      };

      const results = await Promise.allSettled(
        customers.map((c) =>
          service.createReservation({
            id:         randomUUID(),
            resourceId: resource.id,
            customer:   new Customer(c.id, c.fullName, c.email),
            ...slot,
            details:    {},
          }),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);

      const count = await db.query<{ count: string }>(
        `SELECT COUNT(*) FROM reservations
         WHERE resource_id = $1
           AND start_time = $2
           AND status != 'CANCELLED'`,
        [resource.id, slot.startTime],
      );
      expect(Number(count.rows[0]!.count)).toBe(1);
    }, 60_000);
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
      const row = await db.query<{ status: string }>(
        'SELECT status FROM reservations WHERE id = $1',
        [seeded.id],
      );
      expect(row.rows[0]?.status).toBe('CONFIRMED');

      // Verifica evento de dominio
      const event = await db.query<{ event_type: string; business_id: string }>(
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

    // RESERVA-10 (05/09/2026) -- puerta fail-closed contra factura viva.
    it('RESERVA-10: rechaza cancelar si el cargo de la reserva ya tiene una Factura B ISSUED, y la reserva NO queda CANCELLED', async () => {
      const { resource, customer, service } = await setupFixture();
      const seeded = await seedReservation(db, resource.id, customer.id, {
        startTime: new Date('2030-08-03T10:00:00Z'),
        endTime:   new Date('2030-08-03T12:00:00Z'),
        status:    'CONFIRMED',
      });

      const chargeId = randomUUID();
      await db.query(
        `INSERT INTO financial_transactions
           (id, business_id, customer_id, reservation_id, type, amount, currency, status)
         VALUES ($1,$2,$3,$4,'CHARGE',100,'ARS','SETTLED')`,
        [chargeId, BUSINESS_ID, customer.id, seeded.id],
      );
      const invoiceId = randomUUID();
      await db.query(
        `INSERT INTO invoices
           (id, business_id, financial_transaction_id, customer_id, idempotency_key,
            environment, pto_vta, cbte_tipo, cbte_nro, concepto, doc_tipo, doc_nro,
            condicion_iva_receptor_id, moneda, imp_neto, imp_iva, imp_total,
            cae, cae_vto, status, issued_at)
         VALUES ($1, $2, $3, $4, $5, 'homologacion', 1, 6, 1, 1, 96, '0',
                 5, 'PES', 100, 0, 100, '123', '2030-01-01', 'ISSUED', NOW())`,
        [invoiceId, BUSINESS_ID, chargeId, customer.id, `idem-${invoiceId}`],
      );

      await expect(service.cancelReservation(seeded.id, BUSINESS_ID))
        .rejects.toThrow(ReservationChargeInvoicedError);

      // El rollback deshizo TODA la transacción -- la reserva sigue como
      // estaba, no CANCELLED a medias con la factura viva sin contrapartida.
      const row = await db.query<{ status: string }>(
        `SELECT status FROM reservations WHERE id = $1`, [seeded.id],
      );
      expect(row.rows[0]!.status).toBe('CONFIRMED');
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

      const row = await db.query<{ start_time: string; end_time: string }>(
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

  // ─── EXCLUDE constraint — respaldo A8.2 del Bug 2 ─────────────────────

  describe('reservations_no_overlap_exclusive (EXCLUDE constraint)', () => {
    // Bypasea el service a propósito -- lo que se está probando es el
    // constraint de la BASE, no la validación de la capa de aplicación
    // (esa ya la cubren los tests de arriba).
    async function insertRawReservation(params: {
      resourceId: string;
      customerId: string;
      startTime: Date;
      endTime: Date;
      isExclusiveResource: boolean;
    }) {
      await db.query(
        `WITH n AS (
           UPDATE number_sequences SET next_value = next_value + 1
           WHERE entity_type = 'RESERVATION'
           RETURNING next_value - 1 AS value
         )
         INSERT INTO reservations
           (id, resource_id, customer_id, customer_name, start_time, end_time,
            status, total_price, deposit_amount, reservation_number, is_exclusive_resource)
         VALUES ($1, $2, $3, 'Test', $4, $5, 'PENDING', 1000, 0, (SELECT value FROM n), $6)`,
        [
          randomUUID(), params.resourceId, params.customerId,
          params.startTime, params.endTime, params.isExclusiveResource,
        ],
      );
    }

    it('rechaza un solapamiento directo en un recurso EXCLUSIVO', async () => {
      const { resource, customer } = await setupFixture();
      const customer2 = await seedCustomer(db);

      await insertRawReservation({
        resourceId: resource.id, customerId: customer.id,
        startTime: new Date('2031-01-01T10:00:00Z'), endTime: new Date('2031-01-01T12:00:00Z'),
        isExclusiveResource: true,
      });

      await expect(
        insertRawReservation({
          resourceId: resource.id, customerId: customer2.id,
          startTime: new Date('2031-01-01T11:00:00Z'), endTime: new Date('2031-01-01T13:00:00Z'),
          isExclusiveResource: true,
        }),
      ).rejects.toThrow();
    });

    it('NO rechaza un solapamiento equivalente en un recurso de CUPO COMPARTIDO', async () => {
      const { resource, customer } = await setupFixture();
      const customer2 = await seedCustomer(db);

      await insertRawReservation({
        resourceId: resource.id, customerId: customer.id,
        startTime: new Date('2031-02-01T10:00:00Z'), endTime: new Date('2031-02-01T12:00:00Z'),
        isExclusiveResource: false,
      });

      // No debe tirar -- is_exclusive_resource = false queda fuera del
      // WHERE parcial del EXCLUDE, mismo recurso y rango solapado.
      await expect(
        insertRawReservation({
          resourceId: resource.id, customerId: customer2.id,
          startTime: new Date('2031-02-01T11:00:00Z'), endTime: new Date('2031-02-01T13:00:00Z'),
          isExclusiveResource: false,
        }),
      ).resolves.not.toThrow();
    });
  });

  // ─── Bug 1 — cupo compartido ───────────────────────────────────────────

  describe('cupo compartido (isExclusive = false)', () => {
    it('permite varias reservas hasta llenar capacity, rechaza al superarlo', async () => {
      const category = await seedCategory(db, { isExclusive: false });
      const resource = await seedResource(db, category.id, { capacity: 5 });
      const service = await buildService();

      const slot = {
        startTime: new Date('2031-03-01T10:00:00Z'),
        endTime:   new Date('2031-03-01T12:00:00Z'),
      };

      // 2 + 2 = 4/5 -- entran las dos.
      const c1 = await seedCustomer(db);
      await service.createReservation({
        id: randomUUID(), resourceId: resource.id,
        customer: new Customer(c1.id, c1.fullName, c1.email),
        ...slot, details: {}, partySize: 2,
      });
      const c2 = await seedCustomer(db);
      await service.createReservation({
        id: randomUUID(), resourceId: resource.id,
        customer: new Customer(c2.id, c2.fullName, c2.email),
        ...slot, details: {}, partySize: 2,
      });

      // 4/5 ocupados, pide 2 más (llegaría a 6) -- rechaza.
      const c3 = await seedCustomer(db);
      await expect(
        service.createReservation({
          id: randomUUID(), resourceId: resource.id,
          customer: new Customer(c3.id, c3.fullName, c3.email),
          ...slot, details: {}, partySize: 2,
        }),
      ).rejects.toThrow(InvalidReservationError);

      // Pide 1 (entra justo en el lugar que queda) -- sí entra.
      const c4 = await seedCustomer(db);
      const last = await service.createReservation({
        id: randomUUID(), resourceId: resource.id,
        customer: new Customer(c4.id, c4.fullName, c4.email),
        ...slot, details: {}, partySize: 1,
      });
      expect(last.status).toBe('PENDING');
    });
  });
});
