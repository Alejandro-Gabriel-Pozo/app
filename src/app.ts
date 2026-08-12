/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express — arquitectura multi-tenant.
 *
 * ## Orden de middlewares
 * 1.  trust proxy (Render/Cloudflare)
 * 2.  helmetBase — security headers globales (sin CSP, se aplica por ruta)
 * 3.  globalLimiter — baseline anti-DoS (500 req/min/IP)
 * 4.  cors, express.json
 * 5.  /health               — chequea platformClient (PLATFORM_DATABASE_URL)
 * 6.  /docs                 — helmetDocs (CSP permisiva para Swagger UI)
 * 7.  /openapi.json         — helmetBase ya aplicado
 * 8.  /platform/*           — helmetApi + platformLimiter (SUPERADMIN)
 * 9.  POST /register        — helmetApi + authLimiter (público)
 * 10. POST /api/login       — helmetApi + authLimiter (público)
 * 11. /api/customer/*       — helmetApi (portal del cliente)
 * 12. authenticate()        — verifica JWT, protege /api/* restante
 * 13. /api/admin            — mantenimiento (ADMIN, SIN tenantMiddleware)
 *     ⚠️  Montado ANTES de tenantMiddleware a propósito: repair-tenant-db
 *        necesita correr cuando la BD del tenant todavía no está activa.
 * 14. tenantMiddleware()    — inyecta req.db + arranca OutboxWorker por tenant
 * 15. apiLimiter            — 200 req/min/IP sobre /api/* autenticado
 * 16. /api/resources, /reservations, /reports, /customers, /users,
 *     /categories, /products, /orders, /bookable-services,
 *     /housekeeping, /stays
 * 17. errorHandler
 */

import express from 'express';
import cors    from 'cors';
import swaggerUi from 'swagger-ui-express';
import http from 'node:http';

import { createResourcesRouter }         from './api/routes/resources.routes.js';
import { createReservationsRouter }      from './api/routes/reservations.routes.js';
import { createReportsRouter }           from './api/routes/reports.routes.js';
import { createAuthRouter }              from './api/routes/auth.routes.js';
import { createBusinessRouter }          from './api/routes/business.routes.js';
import { createCustomerRouter }          from './api/routes/customer.routes.js';
import { createCustomersRouter }         from './api/routes/customers.routes.js';
import { createCategoryRouter }          from './api/routes/categories.routes.js';
import { createUsersRouter }             from './api/routes/users.routes.js';
import { createPlatformRouter }          from './api/routes/platform.routes.js';
import { createAdminRouter }             from './api/routes/admin.routes.js';
import { createProductsRouter }          from './api/routes/products.routes.js';
import { createOrdersRouter }            from './api/routes/orders.routes.js';
import { createBookableServicesRouter }  from './api/routes/bookable-services.routes.js';
import { createHousekeepingRouter }      from './api/routes/housekeeping.routes.js';
import { createStaysRouter }             from './api/routes/stays.routes.js';
import { createBusinessHoursRouter }     from './api/routes/business-hours.routes.js';
import { errorHandler }                  from './api/middleware/error.middleware.js';
import { globalLimiter, authLimiter, platformLimiter, apiLimiter } from './api/middleware/rate-limit.middleware.js';
import { helmetBase, helmetApi, helmetDocs } from './api/middleware/helmet.middleware.js';
import { openApiSpec }                   from './openapi/spec.js';
import { authenticate }                  from './security/auth.middleware.js';
import { AuthService }                   from './security/auth.service.js';
import { PlatformRepository }            from './platform/platform.repository.js';
import { createPlatformContainer }       from './platform/platform.container.js';
import { tenantMiddleware }              from './platform/tenant.middleware.js';
import { createAppContainer, AppContainer, createPlatformPool, closePlatformPool } from './container.js';
import { checkDatabaseHealth }           from './db/pg.client.js';
import { SqlHousekeepingRepository }     from './repositories/housekeeping.repository.js';
import { SqlStayRepository }             from './repositories/stay.repository.js';
import { HousekeepingService }           from './services/housekeeping.service.js';
import { StayService }                   from './services/stay.service.js';
import { SqlResourceRepository }         from './repositories/sql.resource.repository.js';
import { SqlReservationRepository }      from './repositories/sql.reservation.repository.js';
import { SqlOccupancyRepository }        from './repositories/sql.occupancy.repository.js';
import { ReportService }                 from './services/report.service.js';
import { closeTenantPools }              from './platform/tenant.middleware.js';
import { stopAllWorkers }                from './workers/outbox.registry.js';
import type { Request, Response, NextFunction } from 'express';

export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
  const app = express();

  // -------------------------------------------------------------------------
  // 1. trust proxy — DEBE ir primero, antes de cualquier middleware que lea
  //    req.ip (rate limiter, logging). Sin esto, en Render/Cloudflare req.ip
  //    resuelve a la IP interna del proxy.
  // -------------------------------------------------------------------------
  app.set('trust proxy', 1);

  // -------------------------------------------------------------------------
  // 2. Helmet base — security headers globales, sin CSP.
  // -------------------------------------------------------------------------
  app.use(helmetBase);

  // -------------------------------------------------------------------------
  // 3. Global limiter — baseline anti-DoS.
  // -------------------------------------------------------------------------
  app.use(globalLimiter);

  // platformClient se crea UNA sola vez y se reutiliza en toda la app,
  // incluyendo el health check. Es el pool real de PLATFORM_DATABASE_URL.
  const platformClient = createPlatformPool();
  const platformRepo   = new PlatformRepository(platformClient);

  const authService = new AuthService(platformRepo);
  const container   = await createAppContainer();

  // -------------------------------------------------------------------------
  // 4. CORS + body parser
  // -------------------------------------------------------------------------
  const corsOrigin =
    process.env.CORS_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? false : '*');

  app.use(cors({
    origin:         corsOrigin,
    methods:        ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  // -------------------------------------------------------------------------
  // 5. /health — chequea platformClient (PLATFORM_DATABASE_URL), no DATABASE_URL.
  //    Antes usaba el pool interno de pg.client.ts (DATABASE_URL legacy)
  //    que no está seteada en Render → siempre retornaba db:"error".
  // -------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const dbOk = await checkDatabaseHealth(platformClient);
    res.json({
      status: 'ok',
      mode:   'multi-tenant',
      db:     dbOk ? 'connected' : 'error',
    });
  });

  app.get('/', (_req, res) => res.redirect('/docs'));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));

  // /docs — CSP permisiva para que Swagger UI cargue sus assets de CDN
  app.use('/docs', helmetDocs, swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Reservations API',
    swaggerOptions:  { persistAuthorization: true, docExpansion: 'list', filter: true },
  }));

  // -------------------------------------------------------------------------
  // 8. /platform/* — helmetApi (CSP estricta) + platformLimiter
  // -------------------------------------------------------------------------
  const platformContainer = createPlatformContainer();
  app.use('/platform', ...helmetApi, platformLimiter, createPlatformRouter(platformContainer));

  // -------------------------------------------------------------------------
  // 9-10. /register + /api/login — helmetApi + authLimiter (anti brute-force)
  // -------------------------------------------------------------------------
  app.use('/register',  ...helmetApi, authLimiter, createBusinessRouter(platformRepo));
  app.use('/api/login', ...helmetApi, authLimiter, createAuthRouter(authService));

  // -------------------------------------------------------------------------
  // 11. /api/customer — portal del cliente
  // -------------------------------------------------------------------------
  app.use('/api/customer', createCustomerRouter(container, platformRepo));

  // -------------------------------------------------------------------------
  // 12. helmetApi sobre todo /api/* — cubre customer, admin y rutas de tenant.
  // -------------------------------------------------------------------------
  app.use('/api', ...helmetApi);

  // authenticate() — protege /api/* desde aquí
  app.use('/api', authenticate());

  // -------------------------------------------------------------------------
  // 13. /api/admin — ANTES de tenantMiddleware (repair-tenant-db lo requiere)
  // -------------------------------------------------------------------------
  app.use('/api/admin', createAdminRouter(platformRepo));

  // -------------------------------------------------------------------------
  // 14. tenantMiddleware — inyecta req.db + arranca OutboxWorker por tenant
  // -------------------------------------------------------------------------
  app.use('/api', tenantMiddleware(platformRepo));

  // -------------------------------------------------------------------------
  // 15. apiLimiter — después de autenticación y resolución de tenant
  // -------------------------------------------------------------------------
  app.use('/api', apiLimiter);

  // -------------------------------------------------------------------------
  // 16. Rutas protegidas de empleados (todas usan req.db del tenant)
  // -------------------------------------------------------------------------
  app.use('/api/resources',         createResourcesRouter());
  app.use('/api/reservations',      createReservationsRouter());
  app.use('/api/customers',         createCustomersRouter(container));
  app.use('/api/users',             createUsersRouter(platformRepo));
  app.use('/api/categories',        createCategoryRouter(container));
  app.use('/api/products',          createProductsRouter(container));
  app.use('/api/orders',            createOrdersRouter(container));
  app.use('/api/bookable-services', createBookableServicesRouter(container));
  app.use('/api/business-hours',    createBusinessHoursRouter(container));

  app.use('/api/reports', (req: Request, _res: Response, next: NextFunction) => {
    const occupancyRepo = new SqlOccupancyRepository(req.db);
    const reportService = new ReportService(occupancyRepo);
    const router = createReportsRouter(reportService);
    router(req, _res, next);
  });

  app.use('/api/housekeeping', (req: Request, _res: Response, next: NextFunction) => {
    const housekeepingRepo    = new SqlHousekeepingRepository(req.db);
    const housekeepingService = new HousekeepingService(housekeepingRepo);
    const router = createHousekeepingRouter(housekeepingService);
    router(req, _res, next);
  });

  app.use('/api/stays', (req: Request, _res: Response, next: NextFunction) => {
    const stayRepo        = new SqlStayRepository(req.db);
    const resourceRepo    = new SqlResourceRepository(req.db);
    const reservationRepo = new SqlReservationRepository(req.db, resourceRepo);
    const housekeepingRepo = new SqlHousekeepingRepository(req.db);
    const stayService = new StayService(stayRepo, reservationRepo, housekeepingRepo);
    const router = createStaysRouter(stayService);
    router(req, _res, next);
  });

  // -------------------------------------------------------------------------
  // 17. Error handler — siempre al final
  // -------------------------------------------------------------------------
  app.use(errorHandler);

  return { app, container };
}

export interface GracefulShutdownOptions {
  onShutdown?: () => Promise<void>;
}

export function registerGracefulShutdown(
  server: http.Server,
  options: GracefulShutdownOptions = {},
): void {
  const { onShutdown } = options;

  const shutdown = async (signal: string) => {
    console.log(`\n[server] ${signal} recibido. Cerrando servidor...`);

    try { await stopAllWorkers(); }
    catch (err) { console.error('[server] Error al detener outbox workers:', err); }

    if (onShutdown) {
      try { await onShutdown(); }
      catch (err) { console.error('[server] Error en onShutdown:', err); }
    }

    try { await closeTenantPools(); }
    catch (err) { console.error('[server] Error al cerrar tenant pools:', err); }

    try { await closePlatformPool(); }
    catch (err) { console.error('[server] Error al cerrar platform pool:', err); }

    server.close(() => {
      console.log('[server] Servidor cerrado correctamente.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('[server] Cierre forzado por timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}
