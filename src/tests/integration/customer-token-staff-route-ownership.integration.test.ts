/**
 * @file customer-token-staff-route-ownership.integration.test.ts
 * @description F5-01 (docs/auditoria-integral-fase5-2026-09-15.md, Fase 5
 * del protocolo de auditoría integral, con apéndice de verificación
 * independiente del `architecture-governor`) — reproducción/evidencia, NO
 * fix. El hallazgo: un JWT de tipo CUSTOMER (portal de clientes) puede
 * alcanzar 4 rutas mutantes de routers de STAFF sin que ningún guard
 * compare `req.user.customerId` contra el dueño real del recurso:
 *
 *   1. POST /api/reservations                       (reservations.routes.ts:363)
 *   2. POST /api/reservations/:id/schedule-request   (reservations.routes.ts:676)
 *   3. POST /api/orders                              (orders.routes.ts:200)
 *   4. POST /api/orders/:id/items                    (orders.routes.ts:386)
 *
 * Este test ejercita el pipeline HTTP real (authenticate → tenantMiddleware
 * → authorize → requireModule → handler) — no llama al guard como función,
 * porque lo que se está probando es precisamente si ESE pipeline compara
 * ownership o no.
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
 *   hace `next()` sin resolver el tenant contra la BD de plataforma
 *   (tenant.middleware.ts:193-196) — ESTE es el mecanismo bajo prueba, y no
 *   necesita `PlatformRepository` real para tomar esa rama (el
 *   `platformRepo` que se le pasa nunca se invoca en este test: el guard de
 *   rol corta antes).
 * - Si `unusedResolveMembershipContext()` llegara a invocarse (no debería:
 *   `auth.middleware.ts:327` la saltea para tokens CUSTOMER), su `throw` NO
 *   se propaga ruidoso al log — `auth.middleware.ts:328-333` lo envuelve en
 *   un `try/catch` que responde `401 UNAUTHORIZED` opaco. Sigue siendo un
 *   status de fallo (no un falso verde), pero el mensaje del stub no
 *   aparecería en ningún lado si ese camino llegara a activarse.
 * - `authorize(Roles.BOOKING)` real corre y evalúa `CUSTOMER_PERMISSION_GROUPS`
 *   (roles.ts:81-84), igual que en producción.
 * - `requireModule()` real corre contra el `AppContainer` de prueba.
 *
 * ## Requisito de entorno
 * TEST_DATABASE_URL=postgres://user:pass@host:5432/postgres
 * Si no está definida (y no es CI), la suite se saltea (ver helpers/db.ts).
 *
 * ## No implementa ningún fix
 * Cada caso documenta el status HTTP REAL observado en un comentario
 * `// OBSERVADO:`, mide (no infiere) que ninguna fila nueva se escribió a
 * nombre de B, y declara el objetivo de seguridad real (403 por ownership)
 * como `it.todo` — NO como un `expect` rojo. Dos motivos, condición del
 * gate `architecture-governor` (15/09/2026):
 *   - `expect(status).toBe(403)` dejaría el job `integration` de CI rojo de
 *     forma permanente. Este repo ya documentó el modo de falla simétrico
 *     ("verde silencioso") — un rojo permanente entrena a leer el rojo como
 *     ruido, y la próxima regresión real de integración se leería como "ah,
 *     es el de F5-01". El hallazgo queda igual de enterrado, con más color.
 *   - `it.fails()` tampoco sirve: pasa tanto con el 500 de hoy como con un
 *     2xx real (el bypass de escritura) — tragaría exactamente la
 *     regresión que este archivo existe para atrapar.
 *
 * ## Resultado real observado (corrido contra Postgres real, 15/09/2026;
 * re-verificado de forma independiente por el gate `architecture-governor`
 * con log de servidor por caso — el mecanismo NO es el mismo en los 4 casos)
 * Las 4 rutas responden **500 INTERNAL_ERROR** — NO 2xx, y NO 403. F5-01
 * describía el riesgo como "podría alcanzar" las rutas; corrido de punta a
 * punta, el pipeline SÍ deja pasar el token CUSTOMER (authenticate +
 * authorize(Roles.BOOKING) + requireModule dan next() los tres), pero cada
 * handler crashea antes de escribir nada — por DOS mecanismos distintos:
 *
 *   - **Caso 1** (`POST /api/reservations`): `TypeError: Cannot read
 *     properties of undefined (reading 'query')` en
 *     `new SqlCustomerRepository(req.db).getById(...)`
 *     (reservations.routes.ts:369) — ANTES de llegar a
 *     `buildReservationService()`. Es un deref de `undefined`, no una
 *     verificación explícita: el más frágil de los cuatro.
 *   - **Casos 2, 3, 4**: `Error: req.businessId no está disponible`, throw
 *     explícito y síncrono de `buildTenantTransactionManager(req)`
 *     (db/tenant-context.ts:78, invocado directo o vía `buildOrderService`/
 *     `buildStayService`) — fail-loud real.
 *
 * En los dos casos, la causa raíz es la misma: `tenantMiddleware` hace
 * `next()` sin fijar `req.db` NI `req.businessId` cuando
 * `req.user.role === CUSTOMER` (tenant.middleware.ts:193-196 — diseñado
 * para las rutas de `/api/customer/*`, que resuelven el tenant por su
 * cuenta; estas 4 rutas de STAFF nunca esperaban recibir un token
 * CUSTOMER). `error.middleware.ts` mapea ambos a 500 `INTERNAL_ERROR` por
 * ser un `Error`/`TypeError` genérico (no `DomainError`).
 *
 * Lectura de esto: NO hay bypass limpio de ownership hoy — el atacante no
 * logra crear ni modificar nada a nombre de otro cliente por este camino
 * puntual (medido, no solo inferido: cada caso confirma contra la BD que
 * el conteo/valor relevante no cambió), porque el proceso revienta antes de
 * tocar la BD del tenant. Pero el hallazgo de fondo de F5-01 sigue siendo
 * real y sigue sin arreglar: la cadena de middlewares deja pasar un token
 * CUSTOMER hasta el código interno de rutas de STAFF sin ningún guard de
 * autorización explícito — hoy el único motivo por el que no hay escritura
 * cruzada es un efecto colateral no diseñado para ese propósito
 * (`req.businessId` ausente, y en el caso 1 ni siquiera eso: un simple
 * deref), no un chequeo deliberado. Cualquier cambio futuro que fije
 * `req.db`/`req.businessId` para tokens CUSTOMER en el gate global (p. ej.
 * para habilitar alguna otra ruta) reabriría el bypass real de escritura
 * sin que ninguna de las 5 cercas RBAC existentes (rbac-route-coverage,
 * rbac-matrix-sync, api-auth-gate-order, customer-portal-ownership-guard,
 * credit-note-escape-containment) lo note — ninguna de esas cinco mira
 * ownership dentro de rutas de STAFF, solo dentro de `customer.routes.ts`.
 * Este test queda como regresión para ESE escenario: si algún cambio futuro
 * hace que una de estas 4 rutas devuelva 2xx para un token CUSTOMER ajeno
 * al recurso, la aserción `!res.ok` + "sin escritura" cae en rojo por el
 * motivo correcto (bypass real), y los `it.todo` señalan qué falta arreglar.
 *
 * ## Hallazgo relacionado, encontrado al gatear este bloque —
 * `CUSTOMER-TOKEN-STAFF-ROUTE-500-001` (ver docs/pendientes-2026-09-12.md)
 * El mismo token CUSTOMER alcanza, por el mismo mecanismo, 7 rutas GET con
 * `authorize(Roles.BOOKING)` (bookable-services.routes.ts, resources.routes.ts,
 * business-hours.routes.ts) y 2 GET de `categories.routes.ts` que no tienen
 * `authorize()` en absoluto — confirmado por camino de código, no observado
 * en producción. `GET /api/bookable-services` tiene un consumidor real en
 * `appfrontend-main` (`src/lib/customerApi.ts:221`, llamado desde
 * `app/portal/[businessSlug]/cuenta/reservas/page.tsx:112,130`) que hoy
 * recibe este mismo 500 y lo traga en silencio (`.catch(() => {})`) — el
 * selector de servicios del portal queda vacío sin ningún error visible.
 * Consecuencia de diseño: el fix "obvio" de F5-01 (poblar `req.db` para
 * CUSTOMER) arreglaría ese consumidor Y abriría el bypass de escritura de
 * las 4 rutas mutantes en el mismo cambio — el guard de ownership tiene que
 * aterrizar antes o junto con cualquier cambio que pueble `req.db` para
 * tokens CUSTOMER, no después.
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
 * `tenantMiddleware` hace `next()` en la primera línea
 * (tenant.middleware.ts:194-197) sin tocar `platformRepo` — que es
 * exactamente el mecanismo que F5-01 señala. El stub revienta si algo
 * cambia y alguna vez se llega a invocarlo, en vez de fallar con un TypeError
 * opaco contra un objeto vacío.
 */
function buildUnusedPlatformRepo(): PlatformRepository {
  return new Proxy({}, {
    get(_target, prop) {
      throw new Error(
        `[buildUnusedPlatformRepo] PlatformRepository.${String(prop)} no debería invocarse ` +
        'para un token CUSTOMER — tenantMiddleware corta antes (tenant.middleware.ts:194-197).',
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

describe.skipIf(skipIfNoDb)('F5-01 — token CUSTOMER contra rutas mutantes de STAFF (Postgres real)', () => {
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
   * Cada caso separa dos aserciones distintas (condición del gate
   * `architecture-governor`, 15/09/2026):
   *   1. La que HOY se cumple y se MIDE (no infiere) — la request no tuvo
   *      éxito (`!res.ok`) Y no se escribió ninguna fila nueva a nombre de
   *      B. Esto es lo que hace que el job `integration` de CI quede verde:
   *      el invariante real de hoy (nula escritura cruzada) sí se sostiene,
   *      aunque por un motivo accidental (ver docblock del archivo).
   *   2. El objetivo de seguridad real (403 por ownership) — declarado como
   *      `it.todo`, NO como `expect` rojo. `expect(status).toBe(403)`
   *      dejaría el job permanentemente rojo (entrena a leer el rojo como
   *      ruido — mismo modo de falla que el "verde silencioso" que este
   *      repo ya documentó del otro lado). `it.fails()` tampoco sirve:
   *      pasa tanto con 500 como con un 2xx real, así que tragaría
   *      exactamente la regresión que este archivo existe para atrapar.
   */

  // ── Caso 1 — POST /api/reservations, customer.id = B, auth = A ──────────
  it('POST /api/reservations "a nombre de" B con token de A → sin éxito, sin escritura', async () => {
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
    const bodyText = await res.text();

    // OBSERVADO (corrido contra Postgres real, 15/09/2026, re-verificado por
    // el gate con log de servidor): 500 {"code":"INTERNAL_ERROR",...}. Pero
    // NO es el mismo mecanismo que los casos 2-4 — acá el crash es un
    // TypeError ("Cannot read properties of undefined (reading 'query')")
    // en `new SqlCustomerRepository(req.db).getById(...)`
    // (reservations.routes.ts:369), ANTES de llegar a
    // `buildReservationService()`/`buildTenantTransactionManager`. Es un
    // deref de `undefined`, no un guard explícito — el más frágil de los 4.
    expect(res.ok, `esperado !ok, status real=${res.status} body=${bodyText}`).toBe(false);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM reservations WHERE customer_id = $1`,
      [customerBId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it.todo(
    'F5-01: POST /api/reservations "a nombre de" B con token de A debería dar ' +
    '403 por ownership (no 500 accidental) — guard no implementado, ver ' +
    'docs/auditoria-integral-fase5-2026-09-15.md §F5-01 y docs/pendientes-2026-09-12.md',
  );

  // ── Caso 2 — POST /api/reservations/:id/schedule-request sobre reserva de B, auth = A ──
  it('POST /reservations/:id/schedule-request sobre reserva de B con token de A → sin éxito, sin escritura', async () => {
    const before = await db.query<{ requested_check_in_time: string | null }>(
      `SELECT requested_check_in_time::text FROM reservations WHERE id = $1`,
      [reservationDeB],
    );

    const res = await postAsA(`/api/reservations/${reservationDeB}/schedule-request`, {
      requestedCheckInTime: '15:00',
    });
    const bodyText = await res.text();

    // OBSERVADO (corrido y re-verificado por el gate con log de servidor,
    // 15/09/2026): 500, throw explícito de
    // `buildTenantTransactionManager` (db/tenant-context.ts:78,
    // "req.businessId no está disponible") — fail-loud real, a diferencia
    // del caso 1. `tenantMiddleware()` (platform/tenant.middleware.ts:193-196)
    // hace `next()` sin fijar `req.db`/`req.businessId` para
    // `req.user.role === CUSTOMER` (rama diseñada para `/api/customer/*`,
    // no para que un token CUSTOMER llegue a una ruta de STAFF). NO 2xx.
    expect(res.ok, `esperado !ok, status real=${res.status} body=${bodyText}`).toBe(false);

    const after = await db.query<{ requested_check_in_time: string | null }>(
      `SELECT requested_check_in_time::text FROM reservations WHERE id = $1`,
      [reservationDeB],
    );
    expect(after.rows[0]!.requested_check_in_time).toBe(before.rows[0]!.requested_check_in_time);
  });

  it.todo(
    'F5-01: POST /reservations/:id/schedule-request sobre reserva de B con token de A debería dar ' +
    '403 por ownership (no 500 accidental) — guard no implementado, ver ' +
    'docs/auditoria-integral-fase5-2026-09-15.md §F5-01 y docs/pendientes-2026-09-12.md',
  );

  // ── Caso 3 — POST /api/orders, customerId = B, auth = A ──────────────────
  it('POST /api/orders "a nombre de" B con token de A → sin éxito, sin escritura', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders WHERE customer_id = $1`,
      [customerBId],
    );

    const res = await postAsA('/api/orders', {
      customerId: customerBId,
      items: [],
    });
    const bodyText = await res.text();

    // OBSERVADO (re-verificado por el gate con log de servidor, 15/09/2026):
    // 500, mismo throw explícito de tenant-context.ts:78 que el caso 2 —
    // `buildOrderService()` invoca `buildTenantTransactionManager(req)`
    // antes de tocar cualquier tabla. NO 2xx.
    expect(res.ok, `esperado !ok, status real=${res.status} body=${bodyText}`).toBe(false);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM orders WHERE customer_id = $1`,
      [customerBId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it.todo(
    'F5-01: POST /api/orders "a nombre de" B con token de A debería dar ' +
    '403 por ownership (no 500 accidental) — guard no implementado, ver ' +
    'docs/auditoria-integral-fase5-2026-09-15.md §F5-01 y docs/pendientes-2026-09-12.md',
  );

  // ── Caso 4 — POST /api/orders/:id/items sobre orden de B, auth = A ──────
  it('POST /orders/:id/items sobre orden de B con token de A → sin éxito, sin escritura', async () => {
    const before = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_items WHERE order_id = $1`,
      [orderDeB],
    );

    const res = await postAsA(`/api/orders/${orderDeB}/items`, {
      itemType: 'PRODUCT',
      productId,
      quantity: 1,
    });
    const bodyText = await res.text();

    // OBSERVADO (re-verificado por el gate con log de servidor, 15/09/2026):
    // 500, mismo mecanismo que el caso 3 — `buildOrderService()` crashea
    // antes de llegar a `OrderService.addItem()`. NO 2xx.
    expect(res.ok, `esperado !ok, status real=${res.status} body=${bodyText}`).toBe(false);

    const after = await db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM order_items WHERE order_id = $1`,
      [orderDeB],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it.todo(
    'F5-01: POST /orders/:id/items sobre orden de B con token de A debería dar ' +
    '403 por ownership (no 500 accidental) — guard no implementado, ver ' +
    'docs/auditoria-integral-fase5-2026-09-15.md §F5-01 y docs/pendientes-2026-09-12.md',
  );
});
