/**
 * @file reservation-deferred-assignment.integration.test.ts
 * @description Fase 2 de "reserva por tipo de unidad con asignación
 * diferida" (Wave 14, item 4.3, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md)
 * — B-3, corrección post-gate `architecture-governor` sobre la
 * implementación de Fase 2.
 *
 * Los 2 archivos de integración que Fase 2 tocó
 * (`cancel-order-with-credit-note.integration.test.ts`,
 * `reservation-price-adjustment-stay.integration.test.ts`) reemplazan
 * `ReservationService` por un STUB que TIRA si se invoca `assignDeferred()`
 * — sirven para otra cosa (ejercitan reservas ya `ASSIGNED`, Fase 1) y no
 * se tocan acá. Este archivo es el que prueba el mecanismo NUEVO de Fase 2
 * (`assignDeferred()`, el salteo de `recordOccupancy()` mientras
 * `PENDING_ASSIGNMENT`, y el registro post-commit) contra Postgres real,
 * sin ningún mock ni stub de `ReservationService`.
 *
 * ## Qué se cubre
 * - PUT /reservations/:id (updateReservation() → assignDeferred()):
 *   ocupación EXACTA sobre el recurso final, CERO en el provisorio (B-1/B-2).
 * - Check-in (StayService.checkIn() → assignDeferred()): misma verificación.
 * - Completar (ReservationService.completeReservation() → assignDeferred()):
 *   misma verificación.
 * - Check-in con un recurso candidato de OTRA categoría:
 *   AssignmentCategoryMismatchError, y la transacción completa (Stay +
 *   transición de Reservation + link de cargos) se deshace — ninguna fila
 *   parcial.
 * - Tabla de 6 casos de "completar" (§8 A6.1, N-2/Ronda 14-15), filas 3 y 4
 *   (`preCheck` PENDING_ASSIGNMENT / `locked` ya ASSIGNED, mismo recurso y
 *   recurso distinto) con 2 clientes de Postgres reales en paralelo — NO
 *   disparan `ReservationConcurrentlyModifiedError`. El bloqueo real se
 *   verifica con espera ACTIVA (`waitUntilBlockedBy()`, `pg_blocking_pids`),
 *   no con un `setTimeout` fijo (Condición 1, gate `architecture-governor`,
 *   25/09/2026).
 * - Regresión B-2: `recordReservation()` descarta en silencio cualquier
 *   reserva no CONFIRMED/COMPLETED — un PUT que confirma la asignación
 *   diferida sobre una reserva todavía PENDING deja 0 filas de ocupación
 *   hasta que se confirma (o 0 para siempre si se cancela en vez de
 *   confirmar) (Condición 3, gate `architecture-governor`, 25/09/2026).
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer } from './helpers/seed.js';

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
import { SqlHousekeepingRepository } from '../../pms-estadias/housekeeping.repository.js';
import { PostgresTransactionManager } from '../../db/postgres-transaction-manager.js';
import { ReservationService } from '../../reservas/reservation.service.js';
import { StayService } from '../../pms-estadias/stay.service.js';
import { Customer } from '../../clientes-finanzas/customer.entities.js';
import { AssignmentCategoryMismatchError } from '../../domain/errors.js';

// ---------------------------------------------------------------------------
// Lifecycle de BD
// ---------------------------------------------------------------------------

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-test-4.3-fase2';
const USER_ID = 'user-test-4.3-fase2';

// ---------------------------------------------------------------------------
// Composition roots — mismo patrón que reservation.service.integration.test.ts
// (buildService()) y reservations.routes.ts::buildStayService() (acá
// reconstruido a mano, sin `Request`, mismo criterio que ya usan
// cancel-order-with-credit-note.integration.test.ts/
// reservation-price-adjustment-stay.integration.test.ts para StayService).
// ---------------------------------------------------------------------------

function buildReservationService(): ReservationService {
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
    auditLogRepo,
    stayRepo,
  );
}

function buildStayService(reservationService: ReservationService, now: () => Date = () => new Date()): StayService {
  const resourceRepo = new SqlResourceRepository(db);
  const reservationRepo = new SqlReservationRepository(db, resourceRepo);
  const stayRepo = new SqlStayRepository(db);
  const housekeepingRepo = new SqlHousekeepingRepository(db);
  const financialRepo = new SqlFinancialTransactionRepository(db);
  const businessProfileRepo = new SqlBusinessProfileRepository(db);
  const txManager = new PostgresTransactionManager(pool);

  return new StayService(
    stayRepo,
    reservationRepo,
    housekeepingRepo,
    financialRepo,
    businessProfileRepo,
    txManager,
    // Mismo `ReservationService` REAL (no stub) que se usa para el resto
    // de la fixture -- acá es exactamente lo que este archivo quiere
    // ejercitar: `assignDeferred()`/`recordOccupancy()` reales, contra
    // Postgres real.
    reservationService,
    resourceRepo,
    // Guard de check-in antes de la fecha de llegada (27/09/2026) --
    // reloj inyectable, reenviado desde setupLodgingFixture() (C4 del
    // gate sobre el diseño). Default real para los callers de este
    // archivo que nunca llaman a checkIn() (PUT/completar).
    now,
  );
}

/**
 * Sondeo determinístico vía `pg_blocking_pids()` -- mismo patrón que
 * `invoice-retry-charge-guard.integration.test.ts::waitUntilBlockedBy()`,
 * duplicado acá (archivo distinto, sin módulo compartido de test helpers
 * para esto todavía -- mismo criterio que ese archivo documenta para su
 * propia duplicación). Reemplaza el `setTimeout(300)` fijo que usaban las
 * filas 3/4 de la tabla de "completar" más abajo (Condición 1, gate
 * `architecture-governor` sobre Fase 2, 25/09/2026): un timeout fijo es un
 * riesgo de VERDE FALSO -- si la máquina va lenta, el test puede pasar por
 * casualidad sin haber verificado de verdad que `completeReservation()`
 * llegó a bloquearse contra el lock de fila que `connA` sostiene, en vez de
 * fallar. Esto poll-ea `pg_stat_activity` hasta ver al menos un backend
 * bloqueado por `holderPid`, y tira fuerte (mensaje explícito) si nunca
 * ocurre dentro del timeout.
 */
async function waitUntilBlockedBy(holderPid: number, timeoutMs = 10_000): Promise<number[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { rows } = await db.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (rows.length >= 1) return rows.map((r) => r.pid);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `waitUntilBlockedBy(): ningún backend quedó bloqueado por el pid ${holderPid} dentro de ${timeoutMs} ms -- ` +
    'completeReservation() no se quedó esperando el lock de fila que connA sostiene, o resolvió antes de intentar tomarlo.',
  );
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
 * Fixture común: una categoría de ALOJAMIENTO (isLodging, isExclusive) con
 * dos habitaciones (`provisional`, la que resuelve la asignación diferida
 * al confirmar por categoría; `final`, la que cada test usa como destino
 * real de la asignación), un servicio "Estadía" (booking_mode 'slot',
 * mismo patrón que `svc-estadia-fase2` de reservation.service.test.ts —
 * duración la da el `endTime` explícito, no `duration_minutes`) y un
 * cliente.
 */
/**
 * `now` (guard de check-in, 27/09/2026) es OPCIONAL con default real --
 * la mayoría de los callers de este helper (PUT/completar) nunca llaman
 * a `checkIn()`, así que no se les puede exigir el parámetro. Los 3
 * tests que sí llaman a `checkIn()` (más abajo) pasan su propio reloj
 * congelado, sincronizado con la fecha de su fixture puntual.
 */
async function setupLodgingFixture(now: () => Date = () => new Date()) {
  const category = await seedCategory(db, { isExclusive: true, isLodging: true });
  const provisional = await seedResource(db, category.id);
  const final = await seedResource(db, category.id);
  const customer = await seedCustomer(db);

  const serviceId = randomUUID();
  await db.query(
    `INSERT INTO bookable_services (id, category_id, name, booking_mode, duration_minutes, price)
     VALUES ($1, $2, 'Estadía', 'slot', 60, 0)`,
    [serviceId, category.id],
  );

  const reservationService = buildReservationService();
  const stayService = buildStayService(reservationService, now);

  return { category, provisional, final, customer, serviceId, reservationService, stayService };
}

/**
 * Crea una reserva `PENDING_ASSIGNMENT` (alta por categoría, sobre el
 * recurso PROVISORIO) y la confirma (status CONFIRMED) — precondición
 * común de los 3 flujos (PUT/check-in/completar). Con B-1 ya corregido,
 * `confirmReservation()` NO deja ninguna fila de ocupación fantasma sobre
 * el provisorio -- se verifica acá mismo, así cada test de más abajo
 * arranca desde una precondición confirmada, no asumida.
 */
async function createConfirmedPendingAssignment(params: {
  reservationService: ReservationService;
  provisionalResourceId: string;
  serviceId: string;
  customerId: string;
  customerFullName: string;
  customerEmail: string;
  startTime: Date;
  endTime: Date;
}) {
  const id = randomUUID();
  const reservation = await params.reservationService.createReservation({
    id,
    resourceId: params.provisionalResourceId,
    customer: new Customer(params.customerId, params.customerFullName, params.customerEmail),
    startTime: params.startTime,
    endTime: params.endTime,
    details: {},
    serviceId: params.serviceId,
    enteredByCategory: true,
  });
  expect(reservation.assignmentStatus).toBe('PENDING_ASSIGNMENT');

  await params.reservationService.confirmReservation(id, BUSINESS_ID, USER_ID);

  // B-1: la ocupación NO se registra mientras la reserva sigue
  // PENDING_ASSIGNMENT -- precondición de los 3 flujos de abajo, no algo
  // que cada test tenga que reverificar por su cuenta.
  const provisionalOccupancy = await occupancyForResource(params.provisionalResourceId);
  expect(provisionalOccupancy.rows).toBe(0);

  return id;
}

const DURATION_MINUTES = 120; // 20:00–22:00, un solo día calendario

// ---------------------------------------------------------------------------
// Suite — se saltea automáticamente si TEST_DATABASE_URL no está definida
// ---------------------------------------------------------------------------

describe.skipIf(skipIfNoDb)('Fase 2 de 4.3 (asignación diferida) — B-1/B-2/B-3, Postgres real', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  // ─── PUT /reservations/:id (updateReservation → assignDeferred) ────────

  describe('PUT (updateReservation) confirma la asignación diferida', () => {
    it('reasigna PENDING_ASSIGNMENT (provisorio) a un recurso concreto por PUT: ocupación EXACTA en el final, CERO en el provisorio', async () => {
      const { provisional, final, customer, serviceId, reservationService } = await setupLodgingFixture();
      const startTime = new Date('2030-06-01T20:00:00Z');
      const endTime = new Date('2030-06-01T22:00:00Z');

      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: provisional.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime, endTime,
      });

      const updated = await reservationService.updateReservation(
        id, { resourceId: final.id }, BUSINESS_ID, USER_ID,
      );
      expect(updated.assignmentStatus).toBe('ASSIGNED');
      expect(updated.resource.id).toBe(final.id);

      const provisionalOccupancy = await occupancyForResource(provisional.id);
      expect(provisionalOccupancy.rows).toBe(0);

      const finalOccupancy = await occupancyForResource(final.id);
      expect(finalOccupancy.rows).toBe(1);
      expect(finalOccupancy.bookedMinutes).toBe(DURATION_MINUTES);
    });

    it('PUT que confirma sobre el MISMO recurso (sin reasignar): ocupación EXACTA una sola vez', async () => {
      const { provisional, customer, serviceId, reservationService } = await setupLodgingFixture();
      const startTime = new Date('2030-06-02T20:00:00Z');
      const endTime = new Date('2030-06-02T22:00:00Z');

      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: provisional.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime, endTime,
      });

      const updated = await reservationService.updateReservation(
        id, { resourceId: provisional.id }, BUSINESS_ID, USER_ID,
      );
      expect(updated.assignmentStatus).toBe('ASSIGNED');
      expect(updated.resource.id).toBe(provisional.id);

      const occupancy = await occupancyForResource(provisional.id);
      expect(occupancy.rows).toBe(1);
      expect(occupancy.bookedMinutes).toBe(DURATION_MINUTES);
    });
  });

  // ─── Check-in (StayService.checkIn → assignDeferred) ────────────────────

  describe('Check-in confirma la asignación diferida', () => {
    it('check-in a un recurso concreto: ocupación EXACTA en el final, CERO en el provisorio', async () => {
      const { provisional, final, customer, serviceId, reservationService, stayService } =
        await setupLodgingFixture(() => new Date('2030-06-03T23:00:00Z'));
      const startTime = new Date('2030-06-03T20:00:00Z');
      const endTime = new Date('2030-06-03T22:00:00Z');

      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: provisional.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime, endTime,
      });

      const stay = await stayService.checkIn({
        reservationId: id,
        resourceId: final.id,
        businessId: BUSINESS_ID,
        assignedBy: USER_ID,
      });
      expect(stay.resourceId).toBe(final.id);

      const row = await db.query<{ assignment_status: string; resource_id: string }>(
        'SELECT assignment_status, resource_id FROM reservations WHERE id = $1',
        [id],
      );
      expect(row.rows[0]).toMatchObject({ assignment_status: 'ASSIGNED', resource_id: final.id });

      const provisionalOccupancy = await occupancyForResource(provisional.id);
      expect(provisionalOccupancy.rows).toBe(0);

      const finalOccupancy = await occupancyForResource(final.id);
      expect(finalOccupancy.rows).toBe(1);
      expect(finalOccupancy.bookedMinutes).toBe(DURATION_MINUTES);
    });

    it('check-in con un recurso candidato de OTRA categoría: AssignmentCategoryMismatchError, y la transacción completa se deshace (sin Stay, sin cargo vinculado, ocupación intacta)', async () => {
      const { provisional, customer, serviceId, reservationService, stayService } =
        await setupLodgingFixture(() => new Date('2030-06-04T23:00:00Z'));
      // Categoría/recurso AJENOS a la fixture de alojamiento -- el "upgrade
      // real" que assignDeferred() (paso 6) tiene que rechazar.
      const otherCategory = await seedCategory(db, { isExclusive: true, isLodging: false });
      const otherResource = await seedResource(db, otherCategory.id);

      const startTime = new Date('2030-06-04T20:00:00Z');
      const endTime = new Date('2030-06-04T22:00:00Z');

      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: provisional.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime, endTime,
      });

      await expect(
        stayService.checkIn({
          reservationId: id,
          resourceId: otherResource.id,
          businessId: BUSINESS_ID,
          assignedBy: USER_ID,
        }),
      ).rejects.toThrow(AssignmentCategoryMismatchError);

      // Rollback de TODA la transacción (atomic-state-mutation, §6/§7 ítem
      // 12 del diseño) -- ninguna escritura parcial sobrevive:
      // (a) la reserva sigue PENDING_ASSIGNMENT, sobre el recurso provisorio.
      const row = await db.query<{ assignment_status: string; resource_id: string; status: string }>(
        'SELECT assignment_status, resource_id, status FROM reservations WHERE id = $1',
        [id],
      );
      expect(row.rows[0]).toMatchObject({
        assignment_status: 'PENDING_ASSIGNMENT', resource_id: provisional.id, status: 'CONFIRMED',
      });

      // (b) no queda ninguna Stay -- el INSERT corrido ANTES de
      // assignDeferred() dentro de la misma transacción se deshizo junto
      // con el resto.
      const stay = await stayService.getStayByReservation(id, BUSINESS_ID);
      expect(stay).toBeNull();

      // (c) ningún cargo quedó vinculado a una Stay que no existe.
      const linkedCharges = await db.query<{ count: string }>(
        `SELECT COUNT(*) FROM financial_transactions WHERE reservation_id = $1 AND stay_id IS NOT NULL`,
        [id],
      );
      expect(Number(linkedCharges.rows[0]!.count)).toBe(0);

      // (d) ocupación intacta -- ni el provisorio (B-1 ya la salteaba) ni
      // el recurso ajeno (el check-in nunca llegó a confirmarse) tienen
      // ninguna fila.
      expect((await occupancyForResource(provisional.id)).rows).toBe(0);
      expect((await occupancyForResource(otherResource.id)).rows).toBe(0);
    });
  });

  // ─── Completar (ReservationService.completeReservation → assignDeferred) ─

  describe('Completar confirma la asignación diferida', () => {
    it('completa una reserva PENDING_ASSIGNMENT (mismo recurso provisorio, "completar" nunca reasigna): ocupación EXACTA, una sola vez', async () => {
      const { provisional, customer, serviceId, reservationService } = await setupLodgingFixture();
      const startTime = new Date('2030-06-05T20:00:00Z');
      const endTime = new Date('2030-06-05T22:00:00Z');

      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: provisional.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime, endTime,
      });

      const completed = await reservationService.completeReservation(id, BUSINESS_ID, USER_ID);
      expect(completed.assignmentStatus).toBe('ASSIGNED');
      expect(completed.status).toBe('COMPLETED');
      expect(completed.resource.id).toBe(provisional.id);

      const occupancy = await occupancyForResource(provisional.id);
      expect(occupancy.rows).toBe(1);
      expect(occupancy.bookedMinutes).toBe(DURATION_MINUTES);
    });
  });

  // ─── Secuencia completa: confirmar → [PUT|check-in|completar] → ocupación exacta ─

  describe('Secuencia completa: confirmar (categoría, provisorio X) → asignar a Y → ocupación EXACTA en Y, CERO en X', () => {
    it('PUT', async () => {
      const { provisional: x, final: y, customer, serviceId, reservationService } = await setupLodgingFixture();
      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: x.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime: new Date('2030-06-06T20:00:00Z'), endTime: new Date('2030-06-06T22:00:00Z'),
      });

      await reservationService.updateReservation(id, { resourceId: y.id }, BUSINESS_ID, USER_ID);

      expect(await occupancyForResource(x.id)).toMatchObject({ rows: 0 });
      expect(await occupancyForResource(y.id)).toMatchObject({ rows: 1, bookedMinutes: DURATION_MINUTES });
    });

    it('check-in', async () => {
      const { provisional: x, final: y, customer, serviceId, reservationService, stayService } =
        await setupLodgingFixture(() => new Date('2030-06-07T23:00:00Z'));
      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: x.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime: new Date('2030-06-07T20:00:00Z'), endTime: new Date('2030-06-07T22:00:00Z'),
      });

      await stayService.checkIn({ reservationId: id, resourceId: y.id, businessId: BUSINESS_ID, assignedBy: USER_ID });

      expect(await occupancyForResource(x.id)).toMatchObject({ rows: 0 });
      expect(await occupancyForResource(y.id)).toMatchObject({ rows: 1, bookedMinutes: DURATION_MINUTES });
    });

    it('completar (siempre sobre el mismo recurso -- "Y" acá es el provisorio X mismo, "completar" nunca reasigna)', async () => {
      const { provisional: x, customer, serviceId, reservationService } = await setupLodgingFixture();
      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: x.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime: new Date('2030-06-08T20:00:00Z'), endTime: new Date('2030-06-08T22:00:00Z'),
      });

      await reservationService.completeReservation(id, BUSINESS_ID, USER_ID);

      expect(await occupancyForResource(x.id)).toMatchObject({ rows: 1, bookedMinutes: DURATION_MINUTES });
    });
  });

  // ─── "Completar" -- tabla de 6 casos (N-2), filas 3 y 4, 2 clientes de Postgres reales ─
  //
  // Mismo método que `reservation.service.integration.test.ts` (describe
  // "updateReservation — concurrencia"): en vez de correr dos invocaciones
  // completas del servicio y dejar el orden de llegada al azar, se sostiene
  // a mano -- en una conexión pg real, sin commitear -- el mismo efecto que
  // otra operación concurrente (otro "completar", un PUT, un check-in) ya
  // aplicó DENTRO de su propia transacción, y se deja que
  // `completeReservation()` real haga su `preCheck` (sin lock, ve el
  // estado VIEJO -- PENDING_ASSIGNMENT -- porque el UPDATE de la otra
  // conexión todavía no comiteó, MVCC/READ COMMITTED estándar) y después
  // se quede esperando el lock de fila que la otra conexión sostiene.
  //
  // Filas 3 y 4 de la tabla (§8 A6.1, N-2): `preCheck` ve PENDING_ASSIGNMENT,
  // `locked` (bajo lock, tras el commit de la otra conexión) ya ve ASSIGNED
  // -- mismo recurso (fila 3) o recurso distinto (fila 4). Las dos tienen
  // que resolver SIN invocar assignDeferred() y SIN ningún error -- el
  // guard de N-2 solo mira `locked`, y en las dos filas ya es ASSIGNED.
  describe('"Completar" -- filas 3 y 4 de la tabla de 6 casos (N-2), sin mock, 2 clientes Postgres reales', () => {
    it('fila 3 -- preCheck PENDING_ASSIGNMENT, locked ASSIGNED, MISMO recurso: completar NO dispara ReservationConcurrentlyModifiedError', async () => {
      const { provisional: x, customer, serviceId, reservationService } = await setupLodgingFixture();
      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: x.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime: new Date('2030-06-09T20:00:00Z'), endTime: new Date('2030-06-09T22:00:00Z'),
      });

      const connA = await pool.connect();
      let completePromise: Promise<unknown> | undefined;

      try {
        // connA simula que OTRA operación ya confirmó la asignación
        // (mismo recurso X) pero todavía no comiteó -- completeReservation()
        // hace su `preCheck` (SELECT normal, ve el último valor COMMITEADO
        // = PENDING_ASSIGNMENT, sin importar el UPDATE en vuelo de connA)
        // y recién después se queda esperando el lock de fila que connA
        // sostiene.
        await connA.query('BEGIN');
        const { rows: pidRows } = await connA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const connAPid = pidRows[0]!.pid;
        await connA.query(
          `UPDATE reservations SET assignment_status = 'ASSIGNED' WHERE id = $1`,
          [id],
        );

        completePromise = reservationService.completeReservation(id, BUSINESS_ID, USER_ID);
        completePromise.catch(() => {});

        // Espera ACTIVA (Condición 1, no un `setTimeout` fijo) hasta que
        // `completeReservation()` llegue a bloquearse de VERDAD contra el
        // lock de fila que connA sostiene (su preCheck ya corrió, sin
        // lock, así que esto confirma que abrió su propia transacción y
        // quedó esperando el FOR UPDATE, en vez de asumirlo por tiempo).
        const blockedByConnA = await waitUntilBlockedBy(connAPid);
        expect(blockedByConnA).toHaveLength(1);

        await connA.query('COMMIT');
      } finally {
        connA.release();
      }

      // NO debe rechazar con ReservationConcurrentlyModifiedError (ni con
      // ningún otro error) -- fila 3 es un camino feliz.
      const completed = await completePromise;
      expect((completed as { status: string }).status).toBe('COMPLETED');
      expect((completed as { assignmentStatus: string }).assignmentStatus).toBe('ASSIGNED');
      expect((completed as { resource: { id: string } }).resource.id).toBe(x.id);

      // recordOccupancy() post-commit sigue corriendo siempre (con o sin
      // assignDeferred() de por medio, §6) -- ocupación exacta sobre X.
      const occupancy = await occupancyForResource(x.id);
      expect(occupancy.rows).toBe(1);
      expect(occupancy.bookedMinutes).toBe(DURATION_MINUTES);
    }, 15_000);

    it('fila 4 -- preCheck PENDING_ASSIGNMENT, locked ASSIGNED, recurso DISTINTO: completar NO dispara ReservationConcurrentlyModifiedError, ocupación queda en el recurso REAL (Y), no en el que preCheck pre-lockeó (X)', async () => {
      const { provisional: x, final: y, customer, serviceId, reservationService } = await setupLodgingFixture();
      const id = await createConfirmedPendingAssignment({
        reservationService, provisionalResourceId: x.id, serviceId,
        customerId: customer.id, customerFullName: customer.fullName, customerEmail: customer.email,
        startTime: new Date('2030-06-10T20:00:00Z'), endTime: new Date('2030-06-10T22:00:00Z'),
      });

      const connA = await pool.connect();
      let completePromise: Promise<unknown> | undefined;

      try {
        // Simula que OTRA operación (un PUT concurrente) ya reasignó Y
        // confirmó sobre el recurso Y (distinto de X, el que `preCheck`
        // de completeReservation() todavía va a ver como recurso actual).
        await connA.query('BEGIN');
        const { rows: pidRows } = await connA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const connAPid = pidRows[0]!.pid;
        await connA.query(
          `UPDATE reservations SET assignment_status = 'ASSIGNED', resource_id = $2 WHERE id = $1`,
          [id, y.id],
        );

        completePromise = reservationService.completeReservation(id, BUSINESS_ID, USER_ID);
        completePromise.catch(() => {});

        // Espera ACTIVA (Condición 1) -- ver el comentario equivalente en
        // la fila 3 de más arriba.
        const blockedByConnA = await waitUntilBlockedBy(connAPid);
        expect(blockedByConnA).toHaveLength(1);

        await connA.query('COMMIT');
      } finally {
        connA.release();
      }

      const completed = await completePromise;
      expect((completed as { status: string }).status).toBe('COMPLETED');
      expect((completed as { assignmentStatus: string }).assignmentStatus).toBe('ASSIGNED');
      // El recurso REAL de la fila es Y (lo que `locked` vio bajo lock) --
      // no X (lo que `preCheck`, sin lock, había pre-lockeado antes de que
      // connA comiteara).
      expect((completed as { resource: { id: string } }).resource.id).toBe(y.id);

      // Ocupación EXACTA sobre Y, CERO en X -- ni el pre-lock "de más" de
      // completeReservation() sobre X (inocuo, nunca se usa para escribir
      // nada) ni ningún camino viejo dejan una fila fantasma en X.
      expect((await occupancyForResource(x.id)).rows).toBe(0);
      const occupancyY = await occupancyForResource(y.id);
      expect(occupancyY.rows).toBe(1);
      expect(occupancyY.bookedMinutes).toBe(DURATION_MINUTES);
    }, 15_000);
  });

  // Nota: `ReservationConcurrentlyModifiedError` (filas 2 y 6 de la misma
  // tabla) sigue cubierto solo con mock en reservation.service.test.ts
  // (N-2/fila 6) -- este archivo cubre específicamente las filas 3/4 (el
  // camino feliz) contra Postgres real, no las duplica.

  // ─── Regresión (Condición 3, gate architecture-governor, 25/09/2026) ───
  //
  // La corrección de B-2 (recordOccupancy() post-commit del PUT, §8 del
  // diseño) depende de un comportamiento que YA existe en
  // `recordReservation()` (tanto `SqlOccupancyRepository` como
  // `InMemoryOccupancyRepository`) pero que hasta acá ningún test fijaba:
  // descarta en silencio cualquier reserva que NO esté CONFIRMED o
  // COMPLETED (`if (status !== CONFIRMED && status !== COMPLETED) return;`).
  // Esto es lo que evita el doble conteo cuando una reserva sigue PENDING
  // (sin confirmar) pero ya tiene `assignmentStatus: 'ASSIGNED'` -- caso
  // real: un PUT con `resourceId` confirma la asignación diferida
  // (`assignDeferred()`) SIN pasar por `confirmReservation()`. El gate lo
  // verificó a mano contra Postgres real (fuera de este repo, ya
  // descartado); este bloque lo fija como test de regresión.
  describe('Regresión B-2: recordReservation() descarta reservas no CONFIRMED/COMPLETED', () => {
    async function createPendingReservationOnly(startTime: Date, endTime: Date) {
      const { provisional, final, customer, serviceId, reservationService } = await setupLodgingFixture();
      const id = randomUUID();
      const reservation = await reservationService.createReservation({
        id,
        resourceId: provisional.id,
        customer: new Customer(customer.id, customer.fullName, customer.email),
        startTime,
        endTime,
        details: {},
        serviceId,
        enteredByCategory: true,
      });
      expect(reservation.assignmentStatus).toBe('PENDING_ASSIGNMENT');
      expect(reservation.status).toBe('PENDING'); // sin confirmar -- a propósito, precondición de este bloque
      return { id, provisional, final, reservationService };
    }

    it('PUT confirma el recurso (assignDeferred) sobre una reserva todavía PENDING (sin confirmar): 0 filas de ocupación -- CONFIRMAR después: exactamente 1 fila', async () => {
      const startTime = new Date('2030-06-11T20:00:00Z');
      const endTime = new Date('2030-06-11T22:00:00Z');
      const { id, final, reservationService } = await createPendingReservationOnly(startTime, endTime);

      // PUT con solo resourceId sobre PENDING_ASSIGNMENT confirma vía
      // assignDeferred() (D-2) -- la reserva sigue PENDING, `assignDeferred()`
      // lo permite (paso 3, allowlist PENDING/CONFIRMED). recordOccupancy()
      // post-commit del PUT (B-2) corre igual, pero recordReservation() la
      // descarta en silencio por no estar CONFIRMED/COMPLETED todavía.
      const updated = await reservationService.updateReservation(
        id, { resourceId: final.id }, BUSINESS_ID, USER_ID,
      );
      expect(updated.assignmentStatus).toBe('ASSIGNED');
      expect(updated.status).toBe('PENDING');
      expect((await occupancyForResource(final.id)).rows).toBe(0);

      // Confirmar la reserva SÍ registra ocupación -- ahora CONFIRMED,
      // recordReservation() ya no la descarta.
      const confirmed = await reservationService.confirmReservation(id, BUSINESS_ID, USER_ID);
      expect(confirmed.status).toBe('CONFIRMED');
      const occupancy = await occupancyForResource(final.id);
      expect(occupancy.rows).toBe(1);
      expect(occupancy.bookedMinutes).toBe(DURATION_MINUTES);
    });

    it('PUT confirma el recurso (assignDeferred) sobre una reserva todavía PENDING; en vez de confirmar, se CANCELA: 0 filas de ocupación', async () => {
      const startTime = new Date('2030-06-12T20:00:00Z');
      const endTime = new Date('2030-06-12T22:00:00Z');
      const { id, final, reservationService } = await createPendingReservationOnly(startTime, endTime);

      const updated = await reservationService.updateReservation(
        id, { resourceId: final.id }, BUSINESS_ID, USER_ID,
      );
      expect(updated.assignmentStatus).toBe('ASSIGNED');
      expect((await occupancyForResource(final.id)).rows).toBe(0);

      // Cancelar en vez de confirmar -- cancelReservation() no llama a
      // recordOccupancy() (a diferencia de confirmReservation()), así que
      // la ocupación queda exactamente donde la dejó el PUT: 0 filas.
      const cancelled = await reservationService.cancelReservation(id, BUSINESS_ID, USER_ID);
      expect(cancelled.status).toBe('CANCELLED');
      expect((await occupancyForResource(final.id)).rows).toBe(0);
    });
  });
});
