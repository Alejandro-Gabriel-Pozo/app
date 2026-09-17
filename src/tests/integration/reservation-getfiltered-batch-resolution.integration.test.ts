/**
 * @file reservation-getfiltered-batch-resolution.integration.test.ts
 * @description D-17 (17/09/2026, docs/auditoria-integral-fase15-2026-09-16.md:499-521,
 * F12-01) -- `SqlReservationRepository.getFiltered()`/`getActiveInRange()` dejaron
 * de resolver recurso y líneas POR FILA (1+2N round-trips, medido en 401 queries
 * para 200 filas) y pasaron a batchear (`rowsToReservations()`): una query para
 * `resources WHERE id = ANY($1)`, una para `reservation_lines WHERE reservation_id
 * = ANY($1)`, armado en memoria -- mismo patrón que `sql.order.repository.ts`.
 *
 * Gate `architecture-governor` (17/09/2026, ronda D-17): el único riesgo real de
 * este cambio es un `Map` mal indexado -- una reserva termina con el recurso o
 * las líneas de OTRA. Nada en la suite existente lo detectaría:
 * `sql.reservation.repository.test.ts` usa un fake que ignora `params` y devuelve
 * el mismo recurso para cualquier query; `reservations-unpaginated-limit.
 * integration.test.ts` siembra un solo recurso, así que el mapeo por id nunca se
 * ejercita. Esta suite siembra 2+ recursos DISTINTOS y 2+ reservas con LÍNEAS
 * DISTINTAS, y confirma que cada reserva devuelta trae su propio recurso y sus
 * propias líneas -- no las de otra. También reproduce la medición 401→≤4 del
 * hallazgo de forma permanente (contando `.query()` reales), en vez de dejarla
 * como un script descartable que nadie puede volver a correr.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el pipeline.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

describe.skipIf(skipIfNoDb)('SqlReservationRepository.getFiltered() -- resolución batch por-fila correcta (D-17)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('cada reserva devuelta trae SU propio recurso y SUS propias líneas, y getFiltered({limit:200}) corre en <=4 queries', async () => {
    const category = await seedCategory(db);
    const resourceA = await seedResource(db, category.id, { name: `D17-A-${randomUUID().slice(0, 8)}` });
    const resourceB = await seedResource(db, category.id, { name: `D17-B-${randomUUID().slice(0, 8)}` });
    const customer = await seedCustomer(db);

    const reservationA = await seedReservation(db, resourceA.id, customer.id, {
      startTime: new Date('2030-06-01T10:00:00Z'),
      endTime:   new Date('2030-06-01T12:00:00Z'),
    });
    const reservationB = await seedReservation(db, resourceB.id, customer.id, {
      startTime: new Date('2030-06-02T10:00:00Z'),
      endTime:   new Date('2030-06-02T12:00:00Z'),
    });

    // reservation_lines: sin helper de seed dedicado (seed.ts no tiene uno) --
    // INSERT directo, mismo criterio que reservations-unpaginated-limit
    // usa para el bulk de reservations. Líneas DELIBERADAMENTE distintas
    // (fechas y cantidad) para que un Map mal indexado sea detectable.
    await db.query(
      `INSERT INTO reservation_lines (id, reservation_id, unit_date, price) VALUES
         ($1, $2, '2030-06-01', 500)`,
      [randomUUID(), reservationA.id],
    );
    await db.query(
      `INSERT INTO reservation_lines (id, reservation_id, unit_date, price) VALUES
         ($1, $2, '2030-06-02', 700),
         ($3, $2, '2030-06-03', 700)`,
      [randomUUID(), reservationB.id, randomUUID()],
    );

    let queryCount = 0;
    const countingDb: SqlClient = {
      query: async (sql, params) => {
        queryCount++;
        return db.query(sql, params);
      },
    };
    const resourceRepo = new SqlResourceRepository(countingDb);
    const repo = new SqlReservationRepository(countingDb, resourceRepo);

    queryCount = 0;
    const results = await repo.getFiltered({ limit: 200 });

    // F12-01: 401 queries medidas para 200 filas antes de este bloque --
    // acá van 2, pero el criterio de aceptación del hallazgo es <=4.
    expect(queryCount).toBeLessThanOrEqual(4);

    expect(results).toHaveLength(2);
    const byId = new Map(results.map((r) => [r.id, r]));
    const gotA = byId.get(reservationA.id);
    const gotB = byId.get(reservationB.id);
    expect(gotA).toBeDefined();
    expect(gotB).toBeDefined();

    // El recurso de cada reserva es EL SUYO, no el de la otra.
    expect(gotA!.resource.id).toBe(resourceA.id);
    expect(gotB!.resource.id).toBe(resourceB.id);

    // Las líneas de cada reserva son LAS SUYAS, no las de la otra --
    // esto es lo que un Map indexado por resource_id/reservation_id mal
    // armado rompería en silencio sin que ningún test existente lo notara.
    expect(gotA!.lines).toHaveLength(1);
    expect(gotA!.lines[0]!.unitDate.toISOString().slice(0, 10)).toBe('2030-06-01');
    expect(gotB!.lines).toHaveLength(2);
    expect(gotB!.lines.map((l) => l.unitDate.toISOString().slice(0, 10)).sort()).toEqual(['2030-06-02', '2030-06-03']);
  });
});
