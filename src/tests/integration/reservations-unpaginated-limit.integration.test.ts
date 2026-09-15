/**
 * @file reservations-unpaginated-limit.integration.test.ts
 * @description D-14 parcial (15/09/2026,
 * docs/decisiones-auditoria-fase2-2026-09-15.md, hallazgo D-14 de la
 * auditoría Fase 2) -- `SqlReservationRepository.getFiltered()` sin
 * `page`/`limit` no tenía NINGUNA cota: un `GET /api/reservations` sin
 * parámetros devolvía la tabla `reservations` entera. Esta suite siembra
 * más filas que `SqlReservationRepository.DEFAULT_UNPAGINATED_LIMIT`
 * contra Postgres real y confirma que `getFiltered({})` devuelve como
 * máximo ese tope -- el mismo caso que
 * `in-memory.reservation.repository.test.ts` ya cubre en memoria (ese sí
 * corre sin Postgres).
 *
 * El tope es PROVISORIO: el contrato canónico de paginación (page/limit
 * vs. limit/offset, y si el tope debe ser global/por plan/por tenant)
 * sigue en grounding (D-14 completo, no resuelto todavía) -- ver el
 * comentario en `SqlReservationRepository.getFiltered()`.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida, la suite se saltea (skipIfNoDb), no falla el
 * pipeline. **No se pudo correr en este entorno (sin Postgres real
 * disponible) -- queda como verificación pendiente en CI/entorno real,
 * ver docs/pendientes-2026-09-15.md.**
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

describe.skipIf(skipIfNoDb)('SqlReservationRepository.getFiltered() sin page/limit -- tope duro (D-14 parcial)', () => {
  let repo: SqlReservationRepository;

  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
    const resourceRepo = new SqlResourceRepository(db);
    repo = new SqlReservationRepository(db, resourceRepo);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('siembra más filas que el tope y confirma que getFiltered({}) devuelve como máximo el tope', async () => {
    const limit = SqlReservationRepository.DEFAULT_UNPAGINATED_LIMIT;
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
