/**
 * @file reservations-unpaginated-limit.integration.test.ts
 * @description D-14 (15/09/2026,
 * docs/decisiones-auditoria-fase2-2026-09-15.md #12, RESUELTO) --
 * `SqlReservationRepository.getFiltered()` sin `limit`/`offset` explícitos
 * cae al default (`RESERVATIONS_DEFAULT_LIMIT`, 50) -- antes de D-02/D-14
 * (bf29137) esta query no tenía NINGUNA cota: un `GET /api/reservations`
 * sin parámetros devolvía la tabla `reservations` entera. Esta suite
 * siembra más filas que el default contra Postgres real y confirma que
 * `getFiltered({})` devuelve como máximo ese default -- el mismo caso que
 * `in-memory.reservation.repository.test.ts` ya cubre en memoria (ese sí
 * corre sin Postgres).
 *
 * El contrato es DEFINITIVO (D-14 resuelto, grounding contra 8 sistemas de
 * referencia): limit/offset, envelope único, tope fijo y global (no por
 * plan/tenant), default 50 / máximo 200 (`RESERVATIONS_MAX_LIMIT`, clamp,
 * no rechazo). Ver `resolveReservationsLimit()` en
 * `reservation.repository.ts`.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el
 * pipeline. **No se pudo correr en este entorno (sin Postgres real
 * disponible) -- queda como verificación pendiente en CI/entorno real.**
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { RESERVATIONS_DEFAULT_LIMIT } from '../../reservas/reservation.repository.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

describe.skipIf(skipIfNoDb)('SqlReservationRepository.getFiltered() sin limit/offset -- default duro (D-14)', () => {
  let repo: SqlReservationRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    const resourceRepo = new SqlResourceRepository(db);
    repo = new SqlReservationRepository(db, resourceRepo);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('siembra más filas que el default y confirma que getFiltered({}) devuelve como máximo el default', async () => {
    const limit = RESERVATIONS_DEFAULT_LIMIT;
    const seeded = limit + 1;

    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const customer = await seedCustomer(db);

    // INSERT directo en bulk en vez de N llamadas a seedReservation() --
    // más rápido para sembrar > 100 filas y no depende de
    // number_sequences (reservation_number solo necesita ser NOT NULL y
    // único no es requisito acá).
    const values: string[] = [];
    const params: unknown[] = [];
    for (let i = 0; i < seeded; i++) {
      const base = params.length;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, 'PENDING', 1000, $${base + 7}, 0)`);
      params.push(randomUUID(), resource.id, customer.id, 'Cliente Tope Duro', new Date('2030-01-01T10:00:00Z'), new Date('2030-01-01T12:00:00Z'), i + 1);
    }
    await db.query(
      `INSERT INTO reservations
         (id, resource_id, customer_id, customer_name, start_time, end_time, status, total_price, reservation_number, deposit_amount)
       VALUES ${values.join(', ')}`,
      params,
    );

    const total = await repo.countFiltered({});
    expect(total).toBe(seeded); // sembrado real, countFiltered no tiene cota (no pagina)

    const results = await repo.getFiltered({});
    expect(results.length).toBe(limit);
    expect(results.length).toBeLessThan(seeded);
  });
});
