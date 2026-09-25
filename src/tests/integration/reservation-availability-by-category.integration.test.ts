/**
 * @file reservation-availability-by-category.integration.test.ts
 * @description Fase 0 de "reserva por tipo de unidad con asignación
 * diferida" (Wave 14, item 4.3, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md
 * §6) — `GET /reservations/availability-by-category`. Ejercita el ROUTER
 * real (`createReservationsRouter`), el schema Zod real
 * (`AvailabilityByCategoryQuerySchema`), `authorize(Roles.FRONT_DESK)` real
 * y `ReservationAvailabilityService.countAvailableInCategory()` contra
 * Postgres real — no un mock de repositorio.
 *
 * ## Por qué un harness Express propio y no `createApp()`/`tenantMiddleware()` real
 * Mismo criterio que `customer-token-staff-route-ownership.integration.test.ts`
 * (precedente directo de este repo para montar un router de producción en
 * un harness de test): `tenantMiddleware()` real resuelve el tenant contra
 * `PlatformRepository`/`PLATFORM_DATABASE_URL`, un mecanismo que Fase 0 no
 * toca. Lo que esta suite audita es el router + schema + servicio bajo
 * `req.db`/`req.user` reales, no la resolución de tenant — así que
 * `req.db`/`req.user` se setean directo con un middleware mínimo, y se
 * monta el router real de producción (`createReservationsRouter`) después.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@localhost:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea (skipIfNoDb), no
 * falla el pipeline. Corrido contra Postgres real el 25/09/2026
 * (`service postgresql start` + `TEST_DATABASE_URL` + `npm run
 * test:integration`), 7/7, incluido el 422 `CATEGORY_NOT_LODGING`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';

import type { SqlClient } from '../../repositories/sql.client.js';
import { errorHandler } from '../../api/middleware/error.middleware.js';
import { createReservationsRouter } from '../../reservas/reservations.routes.js';
import { Roles } from '../../security/roles.js';
import type { AppContainer } from '../../container.js';

let db: SqlClient;
let pool: pg.Pool;
let dbName: string;

/** Mismo criterio que buildFakeContainer() de customer-token-staff-route-ownership --
 *  esta ruta no llama a requireModule(), así que ningún método de
 *  AppContainer se invoca; los 4 stubs revientan si algo cambia y alguna
 *  vez se llegan a llamar, en vez de fallar con un TypeError opaco. */
function buildUnusedContainer(): AppContainer {
  const boom = (name: string) => (): never => {
    throw new Error(`[buildUnusedContainer] ${name} no debería invocarse -- esta ruta no usa requireModule().`);
  };
  return {
    getBusinessPlan: boom('getBusinessPlan'),
    getBusinessModules: boom('getBusinessModules'),
    getBusinessModuleGates: boom('getBusinessModuleGates'),
    getPlanLimits: boom('getPlanLimits'),
    mode: 'postgresql',
  };
}

/** req.db/req.user seteados directo (ver docblock de arriba) -- permissionGroups
 *  configurable por test para ejercitar authorize(Roles.FRONT_DESK) real. */
function fakeAuth(permissionGroups: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.db = db;
    req.user = { id: 'staff-1', roleId: 'role-1', permissionGroups, businessId: 'biz-1' };
    next();
  };
}

function buildTestApp(permissionGroups: string[]): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/reservations', fakeAuth(permissionGroups), createReservationsRouter(buildUnusedContainer()));
  app.use(errorHandler);
  return app;
}

async function get(app: express.Application, path: string): Promise<{ status: number; body: unknown }> {
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

describe.skipIf(skipIfNoDb)('GET /reservations/availability-by-category (Fase 0, Postgres real)', () => {
  beforeAll(async () => {
    ({ db, pool, dbName } = await createTestDatabase());
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('403 si el token no tiene FRONT_DESK', async () => {
    const category = await seedCategory(db, { isExclusive: true, isLodging: true });
    const app = buildTestApp([]); // sin FRONT_DESK
    const { status, body } = await get(
      app,
      `/api/reservations/availability-by-category?categoryId=${category.id}&startDate=2030-01-01&endDate=2030-01-03`,
    );
    expect(status).toBe(403);
    expect((body as { code: string }).code).toBe('FORBIDDEN');
  });

  it('400 si falta un query param obligatorio', async () => {
    const app = buildTestApp([Roles.FRONT_DESK]);
    const { status } = await get(app, '/api/reservations/availability-by-category?categoryId=cat-1&startDate=2030-01-01');
    expect(status).toBe(400);
  });

  it('400 si endDate no es posterior a startDate', async () => {
    const app = buildTestApp([Roles.FRONT_DESK]);
    const { status } = await get(
      app,
      '/api/reservations/availability-by-category?categoryId=cat-1&startDate=2030-01-03&endDate=2030-01-01',
    );
    expect(status).toBe(400);
  });

  it('404 si la categoría no existe', async () => {
    const app = buildTestApp([Roles.FRONT_DESK]);
    const { status, body } = await get(
      app,
      '/api/reservations/availability-by-category?categoryId=00000000-0000-0000-0000-000000000000&startDate=2030-01-01&endDate=2030-01-03',
    );
    expect(status).toBe(404);
    expect((body as { code: string; message: string }).code).toBe('NOT_FOUND');
    // Distingue este 404 tanto del 422 CATEGORY_NOT_LODGING (misma familia
    // "categoría rechazada", código de estado distinto) como del 404 que
    // devuelve GET /:id por accidente de montaje (este endpoint está
    // montado ANTES de GET /:id a propósito -- ver comentario en la ruta;
    // si el orden se rompiera, un 404 real de GET /:id también traería
    // code: 'NOT_FOUND' pero con este mensaje distinto).
    expect((body as { code: string; message: string }).message).toBe('Categoría no encontrada');
  });

  /**
   * C1 (gate `architecture-governor`, corregido 25/09/2026) -- Fase 0
   * aplica ÚNICAMENTE a categorías `is_lodging = TRUE` (diseño §5 punto 1,
   * decisión del dueño vía `AskUserQuestion`: "solo alojamiento"). Antes
   * de esta corrección ningún test ejercitaba este rechazo.
   */
  it('422 CATEGORY_NOT_LODGING si la categoría no es de alojamiento', async () => {
    const category = await seedCategory(db, { isExclusive: true, isLodging: false });
    const app = buildTestApp([Roles.FRONT_DESK]);
    const { status, body } = await get(
      app,
      `/api/reservations/availability-by-category?categoryId=${category.id}&startDate=2030-01-01&endDate=2030-01-03`,
    );
    expect(status).toBe(422);
    expect((body as { code: string; message: string }).code).toBe('CATEGORY_NOT_LODGING');
    expect((body as { code: string; message: string }).message).toBe(
      'La categoría no es de alojamiento — este endpoint solo aplica a categorías de alojamiento',
    );
  });

  /**
   * N4 (decisión del dueño, §6/§9 del diseño) contra Postgres real: 2
   * habitaciones de la misma categoría, una libre TODO el rango pedido, la
   * otra ocupada solo en la SEGUNDA noche. El conteo tiene que excluir la
   * segunda -- si el endpoint mirara solo el primer día, las dos
   * aparecerían libres.
   */
  it('N4 -- cuenta solo los recursos libres para el RANGO COMPLETO, no el primer día', async () => {
    const category = await seedCategory(db, { isExclusive: true, isLodging: true });
    const roomFree = await seedResource(db, category.id);
    const roomPartial = await seedResource(db, category.id);
    const customer = await seedCustomer(db);

    // Ocupa roomPartial únicamente la noche del 2 al 3 -- dentro del rango
    // pedido (1 al 3), pero no el rango completo.
    await seedReservation(db, roomPartial.id, customer.id, {
      startTime: new Date('2030-06-02T00:00:00Z'),
      endTime: new Date('2030-06-03T00:00:00Z'),
    });

    const app = buildTestApp([Roles.FRONT_DESK]);
    const { status, body } = await get(
      app,
      `/api/reservations/availability-by-category?categoryId=${category.id}&startDate=2030-06-01&endDate=2030-06-03`,
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({
      categoryId: category.id,
      totalResources: 2,
      availableResources: 1,
    });
    // No dice CUÁL está libre a propósito -- el contrato es un conteo, no
    // una lista de ids (ver §6 del diseño). roomFree existe para que el
    // test no dependa de que "no hay ninguna reserva en absoluto".
    expect(roomFree.id).toBeTruthy();
  });

  it('serviceId filtra por resource_locks -- sin él, el conteo puede sobreestimar (C-5)', async () => {
    const category = await seedCategory(db, { isExclusive: true, isLodging: true });
    // El recurso en sí (no usado por id abajo) -- solo necesita existir en
    // `category` para que totalResources sea 1; lo que bloquea la
    // disponibilidad es el shuttle vía resource_locks, no una reserva sobre
    // este recurso.
    await seedResource(db, category.id);
    // La categoría del shuttle NO necesita isLodging: true -- nunca se
    // pasa como `categoryId` al endpoint (el shuttle solo bloquea vía
    // resource_locks, ver más abajo); el 422 CATEGORY_NOT_LODGING solo
    // mira la categoría consultada.
    const shuttleCategory = await seedCategory(db, { isExclusive: true });
    const shuttle = await seedResource(db, shuttleCategory.id);
    const customer = await seedCustomer(db);

    // bookable_services.category_id es la categoría del SERVICIO (no hay
    // columna resource_id en esta tabla -- el recurso concreto que bloquea
    // se declara vía resource_locks, pivote service_id/resource_id).
    const serviceId = randomUUID();
    // booking_mode NOT NULL sin DEFAULT en la tabla real (schema.sql,
    // `ALTER TABLE bookable_services ALTER COLUMN booking_mode DROP DEFAULT`
    // -- el DEFAULT 'slot' de la definición original de la tabla no
    // sobrevive a esa migración posterior, hay que pasarlo explícito).
    await db.query(
      `INSERT INTO bookable_services (id, category_id, name, booking_mode, duration_minutes, price)
       VALUES ($1, $2, 'Transfer', 'slot', 60, 0)`,
      [serviceId, category.id],
    );
    await db.query(
      `INSERT INTO resource_locks (service_id, resource_id, sort_order) VALUES ($1, $2, 0)`,
      [serviceId, shuttle.id],
    );
    await seedReservation(db, shuttle.id, customer.id, {
      startTime: new Date('2030-07-01T00:00:00Z'),
      endTime: new Date('2030-07-03T00:00:00Z'),
    });

    const app = buildTestApp([Roles.FRONT_DESK]);

    const withoutServiceId = await get(
      app,
      `/api/reservations/availability-by-category?categoryId=${category.id}&startDate=2030-07-01&endDate=2030-07-03`,
    );
    expect(withoutServiceId.body).toMatchObject({ totalResources: 1, availableResources: 1 });

    const withServiceId = await get(
      app,
      `/api/reservations/availability-by-category?categoryId=${category.id}&startDate=2030-07-01&endDate=2030-07-03&serviceId=${serviceId}`,
    );
    expect(withServiceId.body).toMatchObject({ totalResources: 1, availableResources: 0 });
  });
});
