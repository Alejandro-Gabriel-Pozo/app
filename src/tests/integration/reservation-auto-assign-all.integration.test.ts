/**
 * @file reservation-auto-assign-all.integration.test.ts
 * @description Fase 3 de "reserva por tipo de unidad con asignación
 * diferida", "Auto Assign All"
 * (docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md §8.3) — mismo
 * patrón que `reservation-deferred-assignment.integration.test.ts` (Fase
 * 2): sin mocks ni stubs de `ReservationService`, contra Postgres real.
 *
 * ## Qué se cubre
 * - Confirma la MISMA provisoria cuando sigue libre (Paso A): ocupación
 *   EXACTA, `resource_id` sin cambiar.
 * - Reasigna cuando la provisoria se ocupó (Paso B, fallback): ocupación
 *   exacta en el nuevo recurso, cero en el viejo.
 * - Una reserva que falla (se cancela DESPUÉS de que el batch la leyó,
 *   ANTES de que la procese) no aborta las demás — mecanismo de spy sobre
 *   `getPendingAssignmentByCategory()`, corrección C4 del gate (la v1 de
 *   este test plan cancelaba ANTES de leer la lista, lo cual hacía que la
 *   reserva ni siquiera entrara en `pendingList`).
 * - `expectedDateRange` (F3-6): un cambio de fechas concurrente (`PUT`
 *   real, sin tocar `resourceId`) entre la lectura sin lock del batch y su
 *   propio lock produce `RESERVATION_CONCURRENTLY_MODIFIED`/'cambió de
 *   fechas', sin afectar a las demás reservas del batch.
 * - Dos batches concurrentes sobre la MISMA categoría: invariantes
 *   corregidas por el gate (v3) — 1 fila de ocupación por reserva
 *   PROCESADA en el estado final; a lo sumo un ÉXITO por reserva entre los
 *   2 reportes combinados (no "exactamente uno" — la misma reserva puede
 *   aparecer en los dos reportes, una vez como éxito y otra como
 *   `SKIPPED_ALREADY_ASSIGNED`); cero `INTERNAL_ERROR`.
 *
 * ## Cap de 200 (`truncated`) -- NO automatizado acá, a propósito
 * `RESERVATIONS_MAX_LIMIT` (`reservation.repository.ts`) es una constante
 * fija, sin ningún mecanismo de inyección en este repo (confirmado: no hay
 * env var ni parámetro que la baje para un test). Crear 201 reservas
 * `PENDING_ASSIGNMENT` reales contra Postgres solo para ejercitar el
 * `truncated: true` sería un fixture pesado y lento sin aportar cobertura
 * que `reservation.service.test.ts` (unit, `RESERVATIONS_MAX_LIMIT + 1`
 * filas sintéticas in-memory, sub-segundo) no dé ya — mismo criterio que
 * el propio test plan del diseño autoriza ("documentarlo como test
 * manual/QA, no bloqueante para el gate", §8.3).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el pipeline.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlOccupancyRepository } from '../../reservas/sql.occupancy.repository.js';
import { SqlCategoryRepository } from '../../reservas/sql.category.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository } from '../../reservas/sql.resource-lock.repository.js';
import { SqlBookableServiceRepository } from '../../reservas/sql.bookable-service.repository.js';
import { SqlCustomerRateRepository } from '../../clientes-finanzas/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository } from '../../platform/sql.operating-hours.repository.js';
import { SqlMaintenanceWindowRepository } from '../../pms-estadias/sql.maintenance-window.repository.js';
import { SqlStayRepository } from '../../pms-estadias/stay.repository.js';
import { SqlDepositPolicyRepository } from '../../reservas/sql.deposit-policy.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { SqlFinancialTransactionRepository } from '../../clientes-finanzas/sql.financial-transaction.repository.js';
import { SqlInvoiceRepository } from '../../facturacion/sql.invoice.repository.js';
import { SqlNumberSequenceRepository } from '../../repositories/sql.number-sequence.repository.js';
import { SqlCancellationPolicyRepository } from '../../reservas/sql.cancellation-policy.repository.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import { PostgresTransactionManager } from '../../db/postgres-transaction-manager.js';
import { ReservationService } from '../../reservas/reservation.service.js';
import { Customer } from '../../clientes-finanzas/customer.entities.js';
import type { AutoAssignAllItemResult } from '../../reservas/reservation.types.js';

// ---------------------------------------------------------------------------
// Lifecycle de BD
// ---------------------------------------------------------------------------

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-4.3-fase3';
const USER_ID = 'user-test-4.3-fase3';

// "Hoy" (huso de negocio, America/Argentina/Buenos_Aires -- default de
// business_profile, schema.sql) fijo en 2030-07-01. Las reservas de este
// archivo usan startTime/endTime del mismo día calendario
// (2030-07-01T20:00-22:00Z = 17:00-19:00 hora Argentina) para que
// `deriveCalendarDate() === todayBusinessDate` en cada test, sin depender
// de la fecha real en que corre la suite.
const TODAY_NOW = () => new Date('2030-07-01T15:00:00Z');
const START_TIME = new Date('2030-07-01T20:00:00Z');
const END_TIME   = new Date('2030-07-01T22:00:00Z');
const DURATION_MINUTES = 120;

// ---------------------------------------------------------------------------
// Composition root — mismo patrón que reservation-deferred-assignment.
// integration.test.ts::buildReservationService(), pero devuelve también
// el `reservationRepo` real (D-4.5) -- los tests de concurrencia (C4)
// necesitan espiar `getPendingAssignmentByCategory()` sobre la MISMA
// instancia que el service usa internamente.
// ---------------------------------------------------------------------------

function buildReservationService(now: () => Date = TODAY_NOW): {
  service: ReservationService;
  reservationRepo: SqlReservationRepository;
} {
  const resourceRepo = new SqlResourceRepository(db);
  const reservationRepo = new SqlReservationRepository(db, resourceRepo);
  const occupancyRepo = new SqlOccupancyRepository(db);
  const categoryRepo = new SqlCategoryRepository(db);
  const domainEventRepo = new SqlDomainEventRepository(db);
  const resourceLockRepo = new SqlResourceLockRepository(db);
  const bookableServiceRepo = new SqlBookableServiceRepository(db);
  const customerRateRepo = new SqlCustomerRateRepository(db);
  const operatingHoursRepo = new SqlOperatingHoursRepository(db);
  const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(db);
  const txManager = new PostgresTransactionManager(pool);
  const depositPolicyRepo = new SqlDepositPolicyRepository(db);
  const businessProfileRepo = new SqlBusinessProfileRepository(db);
  const financialTransactionRepo = new SqlFinancialTransactionRepository(db);
  const invoiceRepo = new SqlInvoiceRepository(db);
  const numberSequenceRepo = new SqlNumberSequenceRepository(db);
  const cancellationPolicyRepo = new SqlCancellationPolicyRepository(db);
  const auditLogRepo = new SqlAuditLogRepository(db);
  const stayRepo = new SqlStayRepository(db);

  const service = new ReservationService(
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
    auditLogRepo,
    stayRepo,
    now,
  );

  return { service, reservationRepo };
}

async function occupancyForResource(resourceId: string): Promise<{ rows: number; bookedMinutes: number }> {
  const occupancyRepo = new SqlOccupancyRepository(db);
  const snapshots = await occupancyRepo.getAllSnapshots();
  const forResource = snapshots.filter((s) => s.resourceId === resourceId);
  return {
    rows: forResource.length,
    bookedMinutes: forResource.reduce((sum, s) => sum + s.bookedMinutes, 0),
  };
}

/**
 * Fixture común: categoría de ALOJAMIENTO, un servicio "Estadía"
 * (bookingMode 'slot', mismo patrón que el archivo hermano de Fase 2 --
 * duración la da el `endTime` explícito, no `duration_minutes`) y un
 * cliente. Los recursos concretos los siembra cada test (varía cuántos
 * necesita).
 */
async function setupCategoryFixture() {
  const category = await seedCategory(db, { isExclusive: true, isLodging: true });
  const customer = await seedCustomer(db);

  const serviceId = randomUUID();
  await db.query(
    `INSERT INTO bookable_services (id, category_id, name, booking_mode, duration_minutes, price)
     VALUES ($1, $2, 'Estadía', 'slot', 60, 0)`,
    [serviceId, category.id],
  );

  return { category, customer, serviceId };
}

/** Alta por categoría (PENDING_ASSIGNMENT) sobre un recurso PROVISORIO concreto, HOY (fecha de negocio). */
async function createTodayPendingAssignment(params: {
  service: ReservationService;
  provisionalResourceId: string;
  serviceId: string;
  customerId: string;
  customerFullName: string;
  customerEmail: string;
}): Promise<string> {
  const id = randomUUID();
  const reservation = await params.service.createReservation({
    id,
    resourceId: params.provisionalResourceId,
    customer: new Customer(params.customerId, params.customerFullName, params.customerEmail),
    startTime: START_TIME,
    endTime: END_TIME,
    details: {},
    serviceId: params.serviceId,
    enteredByCategory: true,
  });
  expect(reservation.assignmentStatus).toBe('PENDING_ASSIGNMENT');
  return id;
}

// ---------------------------------------------------------------------------
// Suite — se saltea automáticamente si TEST_DATABASE_URL no está definida
// ---------------------------------------------------------------------------

describe.skipIf(skipIfNoDb)('Fase 3 de 4.3 ("Auto Assign All") — autoAssignAllForCategory(), Postgres real', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('confirma la MISMA provisoria si sigue libre (Paso A): ocupación EXACTA, resource_id SIN CAMBIAR', async () => {
    const { category, customer, serviceId } = await setupCategoryFixture();
    const provisional = await seedResource(db, category.id);
    const { service } = buildReservationService();

    const id = await createTodayPendingAssignment({
      service, provisionalResourceId: provisional.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });

    const result = await service.autoAssignAllForCategory(category.id, BUSINESS_ID, USER_ID);

    expect(result.totalPending).toBe(1);
    expect(result.processed).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.confirmedSameResource).toBe(1);
    expect(result.items).toEqual([
      expect.objectContaining({
        reservationId: id, outcome: 'CONFIRMED_SAME_RESOURCE',
        previousResourceId: provisional.id, newResourceId: provisional.id,
      }),
    ]);

    const row = await db.query<{ assignment_status: string; resource_id: string }>(
      'SELECT assignment_status, resource_id FROM reservations WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ assignment_status: 'ASSIGNED', resource_id: provisional.id });

    const occupancy = await occupancyForResource(provisional.id);
    expect(occupancy.rows).toBe(1);
    expect(occupancy.bookedMinutes).toBe(DURATION_MINUTES);
  });

  it('reasigna cuando la provisoria se ocupó (Paso B, fallback): ocupación exacta en el nuevo recurso, cero en el viejo', async () => {
    const { category, customer, serviceId } = await setupCategoryFixture();
    const provisional = await seedResource(db, category.id);
    const alternative = await seedResource(db, category.id);
    const { service } = buildReservationService();

    const id = await createTodayPendingAssignment({
      service, provisionalResourceId: provisional.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });

    // Ocupa `provisional` con OTRA reserva (ASSIGNED, no la propia) en el
    // MISMO rango -- checkAvailability(excludeReservationId=id) da false
    // para `id` en el batch. Inserción directa vía `seedReservation()`
    // (bypassa el chequeo de disponibilidad de createReservation(), que
    // rechazaría un alta real sobre `provisional` estando ya ocupado por
    // la propia reserva `id`).
    const otherCustomer = await seedCustomer(db);
    await seedReservation(db, provisional.id, otherCustomer.id, {
      startTime: START_TIME, endTime: END_TIME, status: 'CONFIRMED',
    });

    const result = await service.autoAssignAllForCategory(category.id, BUSINESS_ID, USER_ID);

    expect(result.reassigned).toBe(1);
    expect(result.confirmedSameResource).toBe(0);
    const item = result.items.find((i) => i.reservationId === id)!;
    expect(item.outcome).toBe('REASSIGNED');
    expect(item.previousResourceId).toBe(provisional.id);
    expect(item.newResourceId).toBe(alternative.id);

    const row = await db.query<{ assignment_status: string; resource_id: string }>(
      'SELECT assignment_status, resource_id FROM reservations WHERE id = $1',
      [id],
    );
    expect(row.rows[0]).toMatchObject({ assignment_status: 'ASSIGNED', resource_id: alternative.id });

    expect((await occupancyForResource(provisional.id)).rows).toBe(0);
    const occupancyAlt = await occupancyForResource(alternative.id);
    expect(occupancyAlt.rows).toBe(1);
    expect(occupancyAlt.bookedMinutes).toBe(DURATION_MINUTES);
  });

  // (C4, corregido) La reserva del medio se cancela DESPUÉS de que el
  // batch lea la lista (spy sobre getPendingAssignmentByCategory), ANTES
  // de que la procese -- la v1 de este test cancelaba ANTES de leer la
  // lista, lo cual hacía que esa reserva ni siquiera entrara en
  // `pendingList` y `processed` no contara las 3.
  it('batch con una reserva que falla (se cancela DESPUÉS de leída, ANTES de procesarse) no aborta las demás', async () => {
    const { category, customer, serviceId } = await setupCategoryFixture();
    const r1 = await seedResource(db, category.id);
    const r2 = await seedResource(db, category.id);
    const r3 = await seedResource(db, category.id);
    const { service, reservationRepo } = buildReservationService();

    const id1 = await createTodayPendingAssignment({
      service, provisionalResourceId: r1.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });
    const id2 = await createTodayPendingAssignment({
      service, provisionalResourceId: r2.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });
    const id3 = await createTodayPendingAssignment({
      service, provisionalResourceId: r3.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });

    const realGetPending = reservationRepo.getPendingAssignmentByCategory.bind(reservationRepo);
    const spy = vi.spyOn(reservationRepo, 'getPendingAssignmentByCategory');
    spy.mockImplementationOnce(async (...args) => {
      const rows = await realGetPending(...args);
      // Cancela la del MEDIO (id2, por start_time/id ASC) recién ACÁ --
      // el batch ya la tiene en `pendingList` (la relee bajo lock dentro
      // de su propia transacción y la encuentra CANCELLED, guard de
      // paso 3 de assignDeferred -- status !== PENDING/CONFIRMED).
      await db.query(`UPDATE reservations SET status = 'CANCELLED' WHERE id = $1`, [id2]);
      return rows;
    });

    const result = await service.autoAssignAllForCategory(category.id, BUSINESS_ID, USER_ID);
    spy.mockRestore();

    expect(result.processed).toBe(3);
    const byId = new Map(result.items.map((i) => [i.reservationId, i]));
    expect(byId.get(id1)?.outcome).toBe('CONFIRMED_SAME_RESOURCE');
    expect(byId.get(id2)?.outcome).toBe('FAILED');
    expect(byId.get(id2)?.code).toBe('INVALID_RESERVATION');
    expect(byId.get(id3)?.outcome).toBe('CONFIRMED_SAME_RESOURCE');
    expect(result.failed).toBe(1);
    expect(result.confirmedSameResource).toBe(2);

    expect((await occupancyForResource(r1.id)).rows).toBe(1);
    expect((await occupancyForResource(r2.id)).rows).toBe(0);
    expect((await occupancyForResource(r3.id)).rows).toBe(1);
  });

  // (C4, corregido) Forma (a) del diseño: spy sobre
  // getPendingAssignmentByCategory que, tras leer las filas, ejecuta un
  // PUT REAL (vía el service, mismo mecanismo que el panel) que cambia
  // startTime/endTime de la reserva SIN tocar resourceId, commiteado,
  // ANTES de devolver el array -- el batch procesa esa reserva con datos
  // ya viejos en `queuedReservation`, abre su transacción, relockea, y
  // encuentra locked.startTime/endTime distinto de lo que traía.
  it('expectedDateRange (F3-6): cambio de fechas concurrente (PUT real) durante el batch -- FAILED/RESERVATION_CONCURRENTLY_MODIFIED, las demás reservas no se ven afectadas', async () => {
    const { category, customer, serviceId } = await setupCategoryFixture();
    const r1 = await seedResource(db, category.id);
    const r2 = await seedResource(db, category.id);
    const { service, reservationRepo } = buildReservationService();

    const id1 = await createTodayPendingAssignment({
      service, provisionalResourceId: r1.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });
    const id2 = await createTodayPendingAssignment({
      service, provisionalResourceId: r2.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });

    const realGetPending = reservationRepo.getPendingAssignmentByCategory.bind(reservationRepo);
    const spy = vi.spyOn(reservationRepo, 'getPendingAssignmentByCategory');
    spy.mockImplementationOnce(async (...args) => {
      const rows = await realGetPending(...args);
      // PUT real sobre id1 (la primera por start_time/id ASC) -- mismo
      // horario base, corrido 1 hora, SIN tocar resourceId. Commiteado
      // antes de devolver el array al batch.
      await service.updateReservation(
        id1,
        { startTime: new Date(START_TIME.getTime() + 60 * 60 * 1000), endTime: new Date(END_TIME.getTime() + 60 * 60 * 1000) },
        BUSINESS_ID, USER_ID,
      );
      return rows;
    });

    const result = await service.autoAssignAllForCategory(category.id, BUSINESS_ID, USER_ID);
    spy.mockRestore();

    const byId = new Map(result.items.map((i) => [i.reservationId, i]));
    expect(byId.get(id1)?.outcome).toBe('FAILED');
    expect(byId.get(id1)?.code).toBe('RESERVATION_CONCURRENTLY_MODIFIED');
    expect(byId.get(id2)?.outcome).toBe('CONFIRMED_SAME_RESOURCE');
    expect(result.failed).toBe(1);
    expect(result.confirmedSameResource).toBe(1);

    // id1 sigue PENDING_ASSIGNMENT (el PUT solo cambió fechas, no
    // resourceId -- no pasó por el discriminador D-2) -- el batch no la
    // tocó (assignDeferred() abortó ANTES de escribir nada).
    const row = await db.query<{ assignment_status: string }>(
      'SELECT assignment_status FROM reservations WHERE id = $1', [id1],
    );
    expect(row.rows[0]!.assignment_status).toBe('PENDING_ASSIGNMENT');
    expect((await occupancyForResource(r2.id)).rows).toBe(1);
  });

  // Dos batches CONCURRENTES sobre la MISMA categoría. Patrón determinístico
  // (C4, corregido): un spy sobre `getPendingAssignmentByCategory()`
  // dispara el SEGUNDO batch real justo DESPUÉS de que el PRIMERO leyó la
  // lista (sin lock) -- garantiza que los dos ven el MISMO estado
  // desactualizado antes de que cualquiera de los dos haga commit, en vez
  // de depender de que el scheduler de Node interleave dos promesas cortas
  // "por las dudas" (mismo motivo por el que
  // reservation.service.integration.test.ts necesita 10 intentos, no 2,
  // para su propia carrera de creación --酸acá el mismo riesgo se cierra
  // con el spy en vez de fuerza bruta).
  it('dos batches concurrentes sobre la MISMA categoría: 1 fila de ocupación por reserva procesada, a lo sumo 1 éxito por reserva entre los 2 reportes, cero INTERNAL_ERROR', async () => {
    const { category, customer, serviceId } = await setupCategoryFixture();
    const r1 = await seedResource(db, category.id);
    const r2 = await seedResource(db, category.id);
    const { service, reservationRepo } = buildReservationService();

    const id1 = await createTodayPendingAssignment({
      service, provisionalResourceId: r1.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });
    const id2 = await createTodayPendingAssignment({
      service, provisionalResourceId: r2.id, serviceId,
      customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
    });

    const realGetPending = reservationRepo.getPendingAssignmentByCategory.bind(reservationRepo);
    const spy = vi.spyOn(reservationRepo, 'getPendingAssignmentByCategory');
    let batch2: Promise<Awaited<ReturnType<typeof service.autoAssignAllForCategory>>> | undefined;
    spy.mockImplementationOnce(async (...args) => {
      const rows = await realGetPending(...args);
      // El SEGUNDO batch arranca ACÁ -- ve la MISMA lista sin lock que el
      // primero, antes de que ninguno de los dos haya tocado nada todavía.
      batch2 = service.autoAssignAllForCategory(category.id, BUSINESS_ID, USER_ID);
      return rows;
    });

    const result1 = await service.autoAssignAllForCategory(category.id, BUSINESS_ID, USER_ID);
    const result2 = await batch2!;
    spy.mockRestore();

    // (1) Estado final: exactamente 1 fila de ocupación por reserva
    // PROCESADA (nunca 0 ni 2).
    expect((await occupancyForResource(r1.id)).rows).toBe(1);
    expect((await occupancyForResource(r2.id)).rows).toBe(1);

    // (2) A lo sumo un ÉXITO por reserva entre los 2 reportes combinados
    // -- NO "exactamente uno": la misma reserva puede aparecer en los dos
    // reportes (una vez como éxito, otra como SKIPPED_ALREADY_ASSIGNED).
    const allItems: AutoAssignAllItemResult[] = [...result1.items, ...result2.items];
    for (const id of [id1, id2]) {
      const successes = allItems.filter(
        (i) => i.reservationId === id && (i.outcome === 'CONFIRMED_SAME_RESOURCE' || i.outcome === 'REASSIGNED'),
      );
      expect(successes.length).toBeLessThanOrEqual(1);
      // Al menos una constancia de la reserva en algún reporte, para que
      // el assert de arriba no sea vacuamente verdadero.
      expect(allItems.filter((i) => i.reservationId === id).length).toBeGreaterThanOrEqual(1);
    }

    // (3) Cero INTERNAL_ERROR en cualquiera de los dos reportes -- la
    // señal correcta y verificable acá (no inspeccionar logs del servidor
    // por un 40P01 real, que classifyFailure() ya captura sin relanzar).
    expect(allItems.filter((i) => i.code === 'INTERNAL_ERROR')).toHaveLength(0);
  }, 15_000);
});
