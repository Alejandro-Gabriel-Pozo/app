/**
 * @file customer-portal-ownership.integration.test.ts
 * @description RBAC-OWN-001 (docs/pendientes-2026-08-30.md; triage 07/09/2026
 * en docs/pendientes-2026-09-06.md) — el aislamiento ENTRE negocios es
 * estructural (una BD por tenant); el que NO lo es, y hasta ahora no tenía
 * prueba negativa, es cliente A vs. cliente B dentro del MISMO negocio en el
 * portal de clientes. Este test ejercita el guard central
 * `requireOwnReservation()` de `customer.routes.ts` contra un Postgres real:
 * reserva sembrada del cliente B, pedida con el id del cliente A → 403; con
 * el de B → pasa; id inexistente → 404.
 *
 * Por qué integración y no unit: el `!==` de pertenencia depende de que el
 * SQL repo real mapee `reservations.customer_id` a `reservation.customer.id`.
 * Un mock que devuelve `{ customer: { id } }` a mano no prueba ese mapeo —
 * que es justo el eslabón que el guard central asume.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';
import { SqlReservationRepository } from '../../reservas/sql.reservation.repository.js';
import { SqlResourceRepository } from '../../reservas/sql.resource.repository.js';
import { requireOwnReservation } from '../../api/routes/customer.routes.js';

function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.status = vi.fn((code: number) => { res.statusCode = code; return res as Response; });
  res.json = vi.fn((body: unknown) => { res.body = body; return res as Response; });
  return res as Response & { statusCode?: number; body?: unknown };
}

describe.skipIf(skipIfNoDb)('RBAC-OWN-001 — requireOwnReservation() contra Postgres real', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;
  let repo: SqlReservationRepository;

  let customerAId: string;
  let customerBId: string;
  let reservationDeB: string;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
    repo = new SqlReservationRepository(db, new SqlResourceRepository(db));

    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    const a = await seedCustomer(db, { fullName: 'Cliente A' });
    const b = await seedCustomer(db, { fullName: 'Cliente B' });
    customerAId = a.id;
    customerBId = b.id;

    const r = await seedReservation(db, resource.id, b.id, { status: 'PENDING' });
    reservationDeB = r.id;
  }, 90_000);

  afterAll(async () => {
    if (dbName) await dropTestDatabase(dbName, pool);
  });

  it('cliente A pidiendo la reserva del cliente B → 403, devuelve null', async () => {
    const res = fakeRes();
    const out = await requireOwnReservation(reservationDeB, customerAId, repo, res, 'modificar');

    expect(out).toBeNull();
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      code: 'FORBIDDEN',
      message: 'No tenés permiso para modificar esta reserva',
    });
  });

  it('cliente B pidiendo su propia reserva → devuelve la reserva, no responde', async () => {
    const res = fakeRes();
    const out = await requireOwnReservation(reservationDeB, customerBId, repo, res, 'cancelar');

    expect(out).not.toBeNull();
    expect(out!.id).toBe(reservationDeB);
    expect(out!.customer.id).toBe(customerBId);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('id de reserva inexistente → 404, devuelve null', async () => {
    const res = fakeRes();
    const out = await requireOwnReservation(randomUUID(), customerBId, repo, res, 'modificar');

    expect(out).toBeNull();
    expect(res.statusCode).toBe(404);
  });
});
