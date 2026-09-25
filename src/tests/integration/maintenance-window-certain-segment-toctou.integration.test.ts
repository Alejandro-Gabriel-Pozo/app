/**
 * @file maintenance-window-certain-segment-toctou.integration.test.ts
 * @description MAINTENANCE-WINDOW-CERTAIN-SEGMENT-TOCTOU-001 (25/09/2026,
 * gate `architecture-governor`) — reproduce, contra Postgres real y con
 * conexiones separadas de verdad, la carrera check-then-insert que
 * `MaintenanceWindowService.createWindow()` tenía en el chequeo del "tramo
 * cierto" (rango `[startDate, min(endDate, hoy + horizonte)]` — una
 * reserva CONFIRMED/PENDING ahí bloquea el alta de la ventana con
 * `MaintenanceWindowConflictError`).
 *
 * ## El defecto (código sin este fix, `283bc4c`)
 * El chequeo del tramo cierto leía con `getActiveForResourceInRange()`
 * (SIN `FOR UPDATE`) y **AFUERA** de la transacción de `createWindow()` —
 * antes de que el servicio tomara ningún lock. Dos transacciones
 * concurrentes (una creando una reserva sobre el recurso R, otra creando
 * una ventana de mantenimiento sobre el mismo R y rango solapado) podían
 * pasar sus respectivos chequeos ANTES de que ninguna de las dos hubiera
 * comiteado nada — check-then-insert clásico (clase A8.3) — y terminar con
 * una ventana de mantenimiento y una reserva activa solapadas, ninguna de
 * las dos bloqueada por la otra.
 *
 * ## El fix
 * `createWindow()` ahora lockea el RECURSO (`resourceRepository.lockByIds()`,
 * `SELECT ... FOR UPDATE` sobre `resources`) como primera sentencia dentro
 * de la transacción — mismo mecanismo que
 * `ReservationService.createReservation()`/`updateReservation()` ya usan
 * antes de chequear disponibilidad (Bug 2, 25/08/2026). El chequeo del
 * tramo cierto se relee DESPUÉS de ese lock, con
 * `getActiveForResourceInRangeWithLock()`, dentro de la misma transacción
 * — así que `createWindow()` queda esperando el lock del recurso que
 * sostiene la otra transacción, y solo puede avanzar (y decidir el
 * conflicto) una vez que esa transacción se resuelve.
 *
 * ## Escenario de este test (S2 del diseño aprobado)
 * 1. `connA` toma el lock del recurso R (`SELECT ... FOR UPDATE` sobre
 *    `resources`, mismo orden que `ReservationService.createReservation()`)
 *    e inserta una reserva CONFIRMED dentro del tramo cierto de la ventana
 *    que se va a crear — SIN comitear.
 * 2. En paralelo se dispara `service.createWindow()` sobre el mismo
 *    recurso R — tiene que quedar BLOQUEADA esperando el lock que `connA`
 *    sostiene sobre `resources` (confirmado con `waitUntilBlockedBy()`, no
 *    con un `setTimeout` — mismo patrón que
 *    `maintenance-window-stale-save.integration.test.ts`).
 * 3. `connA` comitea — la reserva queda CONFIRMED y activa dentro del
 *    rango.
 * 4. `createWindow()` se desbloquea, relee el tramo cierto (ahora ve la
 *    reserva recién comiteada) y **tiene que fallar** con
 *    `MaintenanceWindowConflictError` — y no debe haber quedado ninguna
 *    ventana creada.
 *
 * ## Cómo se demostró (rojo/verde, reportado en el cierre de la sesión)
 * Corrido con `maintenance-window.service.ts` revertido temporalmente al
 * estado previo a este fix (`283bc4c`, chequeo del tramo cierto SIN lock y
 * AFUERA de la transacción): `createWindow()` SÍ queda bloqueada por
 * `connA` en este escenario — pero no por el mecanismo que este fix agrega.
 * `maintenance_windows.resource_id` tiene FK contra `resources` (columna
 * inline en el `CREATE TABLE maintenance_windows` de `schema.sql`, sin
 * `CONSTRAINT` nombrada), así que el INSERT de la ventana toma un `FOR KEY
 * SHARE` implícito sobre la fila del recurso, y ese sí espera el `FOR
 * UPDATE` que `connA` sostiene (mismo mecanismo ya documentado para
 * MAINTENANCE-WINDOW-STALE-SAVE-001, ver
 * `docs/diseno-reserva-por-tipo-unidad-2026-09-24.md` ~1518). Sin el fix,
 * el chequeo del tramo cierto (sin lock, afuera de la transacción) ya pasó
 * ANTES de llegar a ese INSERT — así que `waitUntilBlockedBy()` pasa igual
 * en las dos versiones del código; lo que distingue rojo de verde es la
 * aserción `rejects.toThrow(MaintenanceWindowConflictError)` + el
 * `toHaveLength(0)` del final del test: sin el fix, `createWindow()`
 * resuelve (no rechaza) y la ventana queda creada solapada con la reserva
 * recién comiteada. Corrido contra el código CON el fix, el test completo
 * PASA.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { PgTransactionManager } from '../../db/pg.transaction-manager.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { SqlMaintenanceWindowRepository } from '../../pms-estadias/sql.maintenance-window.repository.js';
import { SqlBusinessProfileRepository } from '../../repositories/sql.business-profile.repository.js';
import { MaintenanceWindowService } from '../../pms-estadias/maintenance-window.service.js';
import { MaintenanceWindowConflictError } from '../../domain/errors.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

const BUSINESS_ID = 'biz-maintenance-window-certain-segment-toctou-001';

/**
 * Sondeo determinístico vía `pg_blocking_pids()` -- mismo patrón que
 * `maintenance-window-stale-save.integration.test.ts::waitUntilBlockedBy()`
 * (duplicado acá a propósito, mismo criterio ya documentado en ese
 * archivo y en `reservation-deferred-assignment.integration.test.ts`/
 * `invoice-retry-charge-guard.integration.test.ts`: sin módulo
 * compartido de test helpers para esto todavía).
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
    'createWindow() nunca quedó esperando ningún lock mientras connA seguía abierta. ' +
    'Nota: esto NO distingue por sí solo el código con fix del código sin fix -- sin el fix, createWindow() ' +
    'igual queda bloqueada (por el FOR KEY SHARE implícito que el INSERT de la ventana toma vía su FK contra ' +
    '`resources`, no por el chequeo del tramo cierto, que corre sin lock y ya pasó antes de llegar ahí). ' +
    'Lo que prueba el fix es la aserción rejects.toThrow(...) + toHaveLength(0) de abajo, no este bloqueo.',
  );
}

describe.skipIf(skipIfNoDb)(
  'MAINTENANCE-WINDOW-CERTAIN-SEGMENT-TOCTOU-001 -- lock del recurso serializa createWindow() contra una reserva del tramo cierto en vuelo (sin commitear)',
  () => {
    beforeAll(async () => {
      ({ db, pool, dbName } = await createTestDatabase());
    }, 30_000);

    afterAll(async () => {
      await dropTestDatabase(dbName, pool);
    });

    it(
      'una reserva CONFIRMED insertada por otra transacción en vuelo dentro del tramo cierto bloquea createWindow() -- al comitear, createWindow() falla con conflicto y no crea ninguna ventana',
      async () => {
        const category = await seedCategory(db, { isLodging: true });
        const resource = await seedResource(db, category.id);
        const guest = await seedCustomer(db);

        const resourceRepo = new SqlResourceRepository(db);
        const reservationRepo = new SqlReservationRepository(db, resourceRepo);
        const maintenanceWindowRepo = new SqlMaintenanceWindowRepository(db);
        const businessProfileRepo = new SqlBusinessProfileRepository(db);
        const service = new MaintenanceWindowService(
          maintenanceWindowRepo,
          resourceRepo,
          reservationRepo,
          businessProfileRepo,
          new PgTransactionManager(pool),
        );

        const today = new Date();
        const todayStr = today.toISOString().slice(0, 10);
        // Dentro del tramo cierto -- mañana/pasado mañana, bien adentro del
        // horizonte default (business_profile.maintenance_horizon_days,
        // default 30 días desde hoy).
        const startTime = new Date(today.getTime() + 24 * 60 * 60 * 1000);
        const endTime = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000);

        const connA = await pool.connect();
        let createWindowPromise: ReturnType<typeof service.createWindow> | undefined;

        try {
          await connA.query('BEGIN');
          const { rows: pidRows } = await connA.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          const holderPid = pidRows[0]!.pid;

          // Mismo orden que ReservationService.createReservation(): lockea
          // el recurso PRIMERO (SELECT ... FOR UPDATE), recién después
          // inserta la reserva -- sin comitear.
          await connA.query('SELECT id FROM resources WHERE id = $1 FOR UPDATE', [resource.id]);
          await seedReservation(connA as unknown as SqlClient, resource.id, guest.id, {
            status: 'CONFIRMED',
            startTime,
            endTime,
          });

          createWindowPromise = service.createWindow({
            businessId: BUSINESS_ID,
            resourceId: resource.id,
            startDate: todayStr,
            createdBy: 'user-1',
          });

          // Evidencia crítica -- confirma que createWindow() se quedó
          // esperando ESE lock puntual sobre `resources`, sostenido por
          // connA, y no que ya terminó (o que nunca llegó a intentar
          // tomarlo).
          await waitUntilBlockedBy(holderPid);
        } finally {
          await connA.query('COMMIT').catch(() => {});
          connA.release();
        }

        // Al comitear connA, createWindow() se desbloquea, relee el tramo
        // cierto CON el lock ya propio, ve la reserva recién comiteada
        // dentro del rango y tiene que fallar con conflicto.
        await expect(createWindowPromise).rejects.toThrow(MaintenanceWindowConflictError);

        // Nada debe haber quedado persistido -- ni la ventana ni ningún
        // efecto secundario del INSERT que nunca llegó a correr (el
        // `throw` desde dentro del callback de transactionManager.run()
        // dispara ROLLBACK, mismo mecanismo que assertAllResourcesAvailable()).
        const windows = await maintenanceWindowRepo.findByResource(resource.id, BUSINESS_ID);
        expect(windows).toHaveLength(0);
      },
      30_000,
    );
  },
);
