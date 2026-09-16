/**
 * @file customer-token-staff-route-ownership.integration.test.ts
 * @description F5-01 (docs/auditoria-integral-fase5-2026-09-15.md) / D-03
 * (docs/auditoria-integral-fase15-2026-09-16.md) — **P-01/D-03 RESUELTO en
 * este bloque (Wave 2, 16/09/2026, docs/decisiones-plan-integral-2026-09-16.md)**.
 * Hasta acá este archivo era reproducción/evidencia, no fix: un JWT CUSTOMER
 * alcanzaba 4 rutas mutantes de routers de STAFF y crasheaba con un 500
 * ACCIDENTAL (dos mecanismos de crash distintos, ninguno un guard
 * deliberado — ver `docs/pendientes-2026-09-12.md` histórico y el `git log`
 * de este archivo para el detalle previo). El fix real (opción "a" de Fase
 * 15, decidida por el dueño): `tenantMiddleware()`
 * (`src/platform/tenant.middleware.ts`) ahora RECHAZA cualquier token
 * `role === CUSTOMER` con `403 FORBIDDEN` de forma deliberada, ANTES de
 * llegar a cualquier handler de ruta de staff — por ACTOR (el rol),
 * no por archivo: cubre las 4 rutas de abajo Y cualquier otra ruta de
 * staff presente o futura, sin necesidad de un guard por-ruta (opción "b",
 * descartada por el dueño por ser más frágil — protege ruta por ruta).
 *
 *   1. POST /api/reservations                       (reservations.routes.ts:363)
 *   2. POST /api/reservations/:id/schedule-request   (reservations.routes.ts:676)
 *   3. POST /api/orders                              (orders.routes.ts:200)
 *   4. POST /api/orders/:id/items                    (orders.routes.ts:386)
 *
 * Este test ejercita el pipeline HTTP real (authenticate → tenantMiddleware
 * → authorize → requireModule → handler) — no llama al guard como función,
 * porque lo que se está probando es precisamente si ESE pipeline rechaza el
 * token antes de llegar al handler.
 *
 * ## Por qué un harness Express propio y no `createApp()` de src/app.ts
 * `createApp()` (exportada) arma TODO el árbol de rutas de la aplicación,
 * pero también exige `PLATFORM_DATABASE_URL` real (crea el pool de
 * plataforma al boot, `createPlatformPool()`) y resuelve el tenant de cada
 * request de staff contra esa BD (`tenantMiddleware` → `platformRepo.findById`).
 * Ningún test de este repo importa `app.js` hoy (grep verificado,
 * 15/09/2026) — no hay patrón previo que reusar. Se optó por un harness
 * mínimo que monta, EN EL MISMO ORDEN que `app.ts`, los middlewares reales
 * (`authenticate`, `tenantMiddleware`, `authorize`, `requireModule`) y los
 * routers reales bajo prueba (`createReservationsRouter`,
 * `createOrdersRouter`), con un `AppContainer` de prueba que solo implementa
 * `getBusinessModuleGates` (lo único que estos routers leen de `container`
 * — verificado por grep, ver comentario junto a `fakeContainer` más abajo).
 *
 * Esto es fiel al pipeline real porque:
 * - Un token CUSTOMER real (firmado con `signToken`/JWT_SECRET, igual que
 *   `CustomerAuthService.login()`) pasa por el `authenticate()` real.
 * - `tenantMiddleware()` real corre: para `req.user.role === CUSTOMER`
 *   responde `403 FORBIDDEN` sin resolver el tenant contra la BD de
 *   plataforma (tenant.middleware.ts, rama CUSTOMER al principio) — ESTE es
 *   el mecanismo bajo prueba, y no necesita `PlatformRepository` real para
 *   tomar esa rama (el `platformRepo` que se le pasa nunca se invoca en
 *   este test: el guard de rol corta antes, igual que antes del fix).
 * - Si `unusedResolveMembershipContext()` llegara a invocarse (no debería:
 *   `auth.middleware.ts:327` la saltea para tokens CUSTOMER), su `throw` NO
 *   se propaga ruidoso al log — `auth.middleware.ts:328-333` lo envuelve en
 *   un `try/catch` que responde `401 UNAUTHORIZED` opaco. Sigue siendo un
 *   status de fallo (no un falso verde), pero el mensaje del stub no
 *   aparecería en ningún lado si ese camino llegara a activarse.
 * - `authorize(Roles.BOOKING)`, `requireModule()` y los 4 handlers reales
 *   NUNCA se ejercitan para un token CUSTOMER en este test — el rechazo de
 *   `tenantMiddleware()` corta el pipeline antes. Siguen montados en el
 *   harness porque son los mismos routers reales de producción; lo que
 *   cambió es que el token CUSTOMER ya no los alcanza.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea (ver helpers/db.ts).
 *
 * ## Resultado real esperado tras el fix
 * Las 4 rutas responden **403 FORBIDDEN** (`{code: 'FORBIDDEN', message:
 * 'Un token del portal de clientes no puede acceder a rutas de staff.'}`)
 * — NO 2xx, y NO el 500 accidental de antes. Cada caso mide (no infiere)
 * dos cosas: el status+body exacto (criterio de aceptación F9-15: asertar
 * también el BODY de la respuesta, no solo el status) y que ninguna fila
 * nueva se escribió a nombre de B.
 *
 * ## Hallazgo relacionado, sin resolver en este bloque —
 * `CUSTOMER-TOKEN-STAFF-ROUTE-500-001` (ver docs/pendientes-2026-09-12.md)
 * El mismo mecanismo (tenantMiddleware rechaza CUSTOMER por ACTOR, no por
 * archivo) alcanza también, como efecto colateral, 7 rutas GET con
 * `authorize(Roles.BOOKING)` (bookable-services.routes.ts, resources.routes.ts,
 * business-hours.routes.ts) y 2 GET de `categories.routes.ts` que no tenían
 * `authorize()` en absoluto — todas convierten su 500 accidental previo en
 * un 403 deliberado, pero la PREGUNTA que ese ítem registra (¿debería un
 * token CUSTOMER poder LEER esos catálogos vía un camino dedicado, en vez
 * de vía una ruta de staff?) sigue sin decidir — no es parte de esta
 * decisión (P-01/D-03 es sobre las 4 rutas MUTANTES). `GET
 * /api/bookable-services` sigue teniendo el consumidor real en
 * `appfrontend-main` (`src/lib/customerApi.ts:221`, llamado desde
 * `app/portal/[businessSlug]/cuenta/reservas/page.tsx:112,130`) que ya
 * tragaba el 500 en silencio (`.catch(() => {})`) — con el 403 nuevo, el
 * comportamiento observable para ese consumidor no cambia (sigue fallando
 * silenciosamente, el selector de servicios del portal sigue vacío), solo
 * cambia el motivo del fallo, de accidental a deliberado.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import type pg from 'pg';

import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory, seedResource, seedCustomer, seedReservation } from './helpers/seed.js';
import type { SqlClient } from '../../repositories/sql.client.js';

import { authenticate, signToken } from '../../security/auth.middleware.js';
import type { MembershipContext } from '../../security/auth.middleware.js';
import { tenantMiddleware } from '../../platform/tenant.middleware.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';
import { errorHandler } from '../../api/middleware/error.middleware.js';
import { requireModule } from '../../security/module.middleware.js';
import { createReservationsRouter } from '../../reservas/reservations.routes.js';
import { createOrdersRouter } from '../../pos-menu/orders.routes.js';
import type { AppContainer, ModuleGate } from '../../container.js';
import { ModuleKey, UserRole } from '../../types/enums.js';

// ---------------------------------------------------------------------------
// JWT_SECRET — authenticate()/signToken() lo leen de env en el momento de
// usarse (lazy, ver getJwtSecret()). Mínimo 32 caracteres.
// ---------------------------------------------------------------------------
process.env.JWT_SECRET ??= 'test-secret-para-f5-01-suficientemente-largo-32';

/**
 * `AppContainer` de prueba. Grep verificado (15/09/2026) sobre
 * reservations.routes.ts y orders.routes.ts: el único método de
 * `AppContainer` que cualquiera de los dos routers invoca es
 * `getBusinessModuleGates` (vía `requireModule()`, en el mount de
 * `/api/orders` y en las 3 rutas de schedule-request de reservations). Los
 * otros tres miembros de la interfaz (`getBusinessPlan`, `getBusinessModules`,
 * `getPlanLimits`) nunca se llaman en las rutas bajo prueba — se satisfacen
 * con stubs que revientan si alguna vez se invocan, para que un cambio
 * futuro en esos routers que SÍ los use falle ruidoso en vez de devolver
 * `undefined` en silencio.
 *
 * Los dos módulos que estas 4 rutas necesitan (ALOJAMIENTO para
 * schedule-request, POS_RESTAURANTE para orders) se devuelven habilitados
 * — así el test llega al punto real bajo auditoría (el handler / el guard
 * de ownership ausente) en vez de frenar antes en un 402 MODULE_NOT_ENABLED
 * que no tiene nada que ver con F5-01.
 */
function buildFakeContainer(): AppContainer {
  const enabledGate = (moduleKey: string): ModuleGate => ({
    moduleKey,
    enabled: true,
    origin: 'TENANT_OVERRIDE',
    restrictedBy: null,
  });

  return {
    getBusinessPlan: () => { throw new Error('[fakeContainer] getBusinessPlan no debería llamarse en este test'); },
    getBusinessModules: () => { throw new Error('[fakeContainer] getBusinessModules no debería llamarse en este test'); },
    getPlanLimits: () => { throw new Error('[fakeContainer] getPlanLimits no debería llamarse en este test'); },
    getBusinessModuleGates: async () => ({
      [ModuleKey.ALOJAMIENTO]:     enabledGate(ModuleKey.ALOJAMIENTO),
      [ModuleKey.POS_RESTAURANTE]: enabledGate(ModuleKey.POS_RESTAURANTE),
    }),
    mode: 'postgresql',
  };
}

/**
 * `PlatformRepository` de prueba para `tenantMiddleware(platformRepo)`.
 * NUNCA se invoca en este test: para `req.user.role === UserRole.CUSTOMER`,
 * `tenantMiddleware` responde `403 FORBIDDEN` en la primera rama (P-01/D-03,
 * Wave 2, 16/09/2026) sin tocar `platformRepo`. El stub revienta si algo
 * cambia y alguna vez se llega a invocarlo, en vez de fallar con un TypeError
 * opaco contra un objeto vacío.
 */
function buildUnusedPlatformRepo(): PlatformRepository {
  return new Proxy({}, {
    get(_target, prop) {
      throw new Error(
        `[buildUnusedPlatformRepo] PlatformRepository.${String(prop)} no debería invocarse ` +
        'para un token CUSTOMER — tenantMiddleware lo rechaza con 403 antes (tenant.middleware.ts, rama CUSTOMER).',
      );
    },
  }) as PlatformRepository;
}

/** Igual criterio: no debería invocarse para un token CUSTOMER (auth.middleware.ts:327). */
function unusedResolveMembershipContext(): Promise<MembershipContext | null> {
  throw new Error(
    '[unusedResolveMembershipContext] no debería invocarse para un token CUSTOMER ' +
    '(auth.middleware.ts:327: se saltea cuando payload.role === UserRole.CUSTOMER).',
  );
}

/**
 * Arma el harness HTTP: mismo orden de middlewares que app.ts para las
 * rutas bajo prueba —
 *   express.json() → authenticate() → tenantMiddleware() → routers → errorHandler
 * (apiLimiter/helmet/cors quedan fuera a propósito: no forman parte del
 * mecanismo de autorización bajo auditoría y solo agregarían ruido/estado
 * global entre tests).
 */
function buildTestApp(): express.Application {
  const app = express();
  app.use(express.json());

  app.use('/api', authenticate(undefined, unusedResolveMembershipContext));
  app.use('/api', tenantMiddleware(buildUnusedPlatformRepo()));

  const container = buildFakeContainer();
  app.use('/api/reservations', createReservationsRouter(container));
  app.use('/api/orders', requireModule(container, ModuleKey.POS_RESTAURANTE), createOrdersRouter(container));

  app.use(errorHandler);
  return app;
}

/** Firma un JWT CUSTOMER real, mismo shape que CustomerAuthService (sub, role, customer_id, business_id). */
function signCustomerToken(customerId: string, businessId: string): string {
  return signToken(
    { sub: customerId, role: UserRole.CUSTOMER, customer_id: customerId, business_id: businessId },
    process.env.JWT_SECRET!,
  );
}

describe.skipIf(skipIfNoDb)('F5-01/D-03 — token CUSTOMER rechazado en rutas mutantes de STAFF (Postgres real)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;
  let server: http.Server;
  let baseUrl: string;

  const FAKE_BUSINESS_ID = 'biz-f5-01';

  let resourceId: string;
  let customerAId: string; // atacante — token CUSTOMER real
  let customerBId: string; // víctima — dueño real del recurso
  let reservationDeB: string;
  let productId: string;
  let orderDeB: string;

  let tokenA: string;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());

    const category = await seedCategory(db);
    const resource = await seedResource(db, category.id);
    resourceId = resource.id;

    const a = await seedCustomer(db, { fullName: 'Cliente A (atacante)' });
    const b = await seedCustomer(db, { fullName: 'Cliente B (víctima)' });
    customerAId = a.id;
    customerBId = b.id;

    const reservation = await seedReservation(db, resourceId, customerBId, { status: 'PENDING' });
    reservationDeB = reservation.id;

    // Producto + orden DRAFT de B, para el caso 4 (POST /orders/:id/items).
    productId = randomUUID();
    await db.query(
      `INSERT INTO products (id, business_id, name, base_price, product_type, sku)
       VALUES ($1, $2, 'Producto F5-01', 500, 'RETAIL', 'SKU-F501')`,
      [productId, FAKE_BUSINESS_ID],
    );
    orderDeB = randomUUID();
    await db.query(
      `INSERT INTO orders (id, business_id, customer_id, status, location_id)
       VALUES ($1, $2, $3, 'DRAFT', 'loc-default')`,
      [orderDeB, FAKE_BUSINESS_ID, customerBId],
    );

    tokenA = signCustomerToken(customerAId, FAKE_BUSINESS_ID);

    const app = buildTestApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  }, 90_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    if (dbName) await dropTestDatabase(dbName, pool);
  });

  function postAsA(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${tokenA}`,
      },
      body: JSON.stringify(body),
    });
  }

  /**
   * P-01/D-03 RESUELTO (Wave 2, 16/09/2026) — cada caso ahora assertea el
   * objetivo de seguridad real directamente: `403 FORBIDDEN` deliberado
   * (status Y body — criterio de aceptación F9-15) Y cero escritura cruzada
   * a nombre de B. Ya no hace falta separar "lo que se mide hoy" de "lo que
   * falta" — las dos cosas son la misma aserción, porque el fix es real.
   */
  const EXPECTED_BODY = {
    code:    'FORBIDDEN',
    message: 'Un token del portal de clientes no puede acceder a rutas de staff.',
  };

  // ── Caso 1 — POST /api/reservations, customer.id = B, auth = A ──────────
  it('POST /api/reservations "a nombre de" B con token de A → 403 FORBIDDEN, sin escritura', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reservations WHERE customer_id = $1`,
      [customerBId],
    );

    const res = await postAsA('/api/reservations', {
      resourceId,
      customer: { id: customerBId },
      startTime: '2031-01-01T10:00:00.000Z',
      endTime:   '2031-01-01T12:00:00.000Z',
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual(EXPECTED_BODY);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reservations WHERE customer_id = $1`,
      [customerBId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  // ── Caso 2 — POST /api/reservations/:id/schedule-request sobre reserva de B, auth = A ──
  it('POST /reservations/:id/schedule-request sobre reserva de B con token de A → 403 FORBIDDEN, sin escritura', async () => {
    const before = await db.query<{ requested_check_in_time: string | null }>(
      `SELECT requested_check_in_time::text FROM reservations WHERE id = $1`,
      [reservationDeB],
    );

    const res = await postAsA(`/api/reservations/${reservationDeB}/schedule-request`, {
      requestedCheckInTime: '15:00',
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual(EXPECTED_BODY);

    const after = await db.query<{ requested_check_in_time: string | null }>(
      `SELECT requested_check_in_time::text FROM reservations WHERE id = $1`,
      [reservationDeB],
    );
    expect(after.rows[0]!.requested_check_in_time).toBe(before.rows[0]!.requested_check_in_time);
  });

  // ── Caso 3 — POST /api/orders, customerId = B, auth = A ──────────────────
  it('POST /api/orders "a nombre de" B con token de A → 403 FORBIDDEN, sin escritura', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders WHERE customer_id = $1`,
      [customerBId],
    );

    const res = await postAsA('/api/orders', {
      customerId: customerBId,
      items: [],
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual(EXPECTED_BODY);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders WHERE customer_id = $1`,
      [customerBId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  // ── Caso 4 — POST /api/orders/:id/items sobre orden de B, auth = A ──────
  it('POST /orders/:id/items sobre orden de B con token de A → 403 FORBIDDEN, sin escritura', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_items WHERE order_id = $1`,
      [orderDeB],
    );

    const res = await postAsA(`/api/orders/${orderDeB}/items`, {
      itemType: 'PRODUCT',
      productId,
      quantity: 1,
    });
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toEqual(EXPECTED_BODY);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_items WHERE order_id = $1`,
      [orderDeB],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });
});
