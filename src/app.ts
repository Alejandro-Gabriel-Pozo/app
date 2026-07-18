/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express — arquitectura multi-tenant.
 *
 * ## Dos bases de datos
 * - PLATFORM_DATABASE_URL → BD central (businesses, platform_users)
 * - DATABASE_URL          → BD del negocio (inyectada por tenantMiddleware en req.db)
 *
 * ## Orden de middlewares
 * 1. cors, express.json
 * 2. /health, /docs, /openapi.json  — rutas públicas
 * 3. /platform/*                    — gestión de plataforma (SUPERADMIN)
 *    - POST /platform/login         — público
 *    - resto requiere JWT SUPERADMIN (authenticatePlatform dentro del router)
 * 4. POST /register                 — registro de negocios (público, sin auth)
 * 5. POST /api/login                — login de empleados (público)
 * 6. /api/customer/register         — registro de clientes (público)
 * 7. /api/customer/login            — login de clientes (público)
 * 8. /api/customer/availability/**  — disponibilidad pública (sin auth)
 * 9. authenticate()                 — verifica JWT, protege /api/* restante
 * 10. tenantMiddleware()            — inyecta req.db con la BD del negocio
 * 11. /api/resources, /reservations, /reports, /customers, /users, /categories
 *                                    — rutas de empleados
 * 12. /api/customer/me/**           — rutas privadas del cliente (auth dentro del router)
 * 13. errorHandler
 */

import express from 'express';
import cors    from 'cors';
import swaggerUi from 'swagger-ui-express';
import http from 'node:http';

import { createResourcesRouter }    from './api/routes/resources.routes.js';
import { createReservationsRouter } from './api/routes/reservations.routes.js';
import { createReportsRouter }      from './api/routes/reports.routes.js';
import { createAuthRouter }         from './api/routes/auth.routes.js';
import { createBusinessRouter }     from './api/routes/business.routes.js';
import { createCustomerRouter }     from './api/routes/customer.routes.js';
import { createCustomersRouter }    from './api/routes/customers.routes.js';
import { createCategoryRouter }     from './api/routes/categories.routes.js';
import { createUsersRouter }        from './api/routes/users.routes.js';
import { createPlatformRouter }     from './api/routes/platform.routes.js';
import { errorHandler }             from './api/middleware/error.middleware.js';
import { openApiSpec }              from './openapi/spec.js';
import { authenticate }             from './security/auth.middleware.js';
import { AuthService }              from './security/auth.service.js';
import { PlatformRepository }       from './platform/platform.repository.js';
import { createPlatformContainer }  from './platform/platform.container.js';
import { tenantMiddleware }         from './platform/tenant.middleware.js';
import { createAppContainer, AppContainer, createPlatformPool } from './container.js';
import { checkDatabaseHealth }      from './db/pg.client.js';

export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
  const app = express();

  // -------------------------------------------------------------------------
  // BD central y repositorio de plataforma (usa pool compartido de container.ts)
  // -------------------------------------------------------------------------
  const platformClient = createPlatformPool();
  const platformRepo   = platformClient ? new PlatformRepository(platformClient) : null;

  if (!platformClient) {
    console.warn(
      '[app] ⚠️  PLATFORM_DATABASE_URL no definida. ' +
      'El registro de negocios y el login multi-tenant no funcionarán.',
    );
  }

  // -------------------------------------------------------------------------
  // Auth service (empleados)
  // -------------------------------------------------------------------------
  const authService = new AuthService(platformRepo);

  // -------------------------------------------------------------------------
  // Container principal (siempre PostgreSQL)
  // -------------------------------------------------------------------------
  const container = await createAppContainer();

  // -------------------------------------------------------------------------
  // Middlewares globales
  // -------------------------------------------------------------------------
  //
  // CORS origin: en producción se requiere CORS_ORIGIN explícita.
  // Si no está definida en producción, se bloquea todo origen (false)
  // para evitar exponer la API a cualquier dominio.
  // En desarrollo el fallback es '*' para comodidad local.
  const corsOrigin =
    process.env.CORS_ORIGIN ??
    (process.env.NODE_ENV === 'production' ? false : '*');

  app.use(cors({
    origin: corsOrigin,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Rutas públicas
  // -------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const dbOk = await checkDatabaseHealth();
    res.json({
      status: 'ok',
      mode: platformClient ? 'multi-tenant' : 'single-tenant',
      db: dbOk ? 'connected' : 'error',
    });
  });

  app.get('/', (_req, res) => res.redirect('/docs'));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Reservations API',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'list', filter: true },
  }));

  // -------------------------------------------------------------------------
  // /platform/* — gestión de plataforma (SUPERADMIN)
  // -------------------------------------------------------------------------
  const platformContainer = createPlatformContainer();
  if (platformContainer) {
    app.use('/platform', createPlatformRouter(platformContainer));
  } else {
    console.warn('[app] ⚠️  /platform deshabilitado — PLATFORM_DATABASE_URL no definida.');
    app.use('/platform', (_req, res) => {
      res.status(503).json({
        code: 'PLATFORM_UNAVAILABLE',
        message: 'Rutas de plataforma no disponibles. Definí PLATFORM_DATABASE_URL en Render Dashboard.',
      });
    });
  }

  // -------------------------------------------------------------------------
  // POST /register — registro de negocios (público)
  // -------------------------------------------------------------------------
  if (platformRepo) {
    app.use('/register', createBusinessRouter(platformRepo));
  }

  // -------------------------------------------------------------------------
  // POST /api/login — login de empleados (público, antes de authenticate)
  // -------------------------------------------------------------------------
  app.use('/api/login', createAuthRouter(authService));

  // -------------------------------------------------------------------------
  // /api/customer — portal del cliente
  // -------------------------------------------------------------------------
  app.use('/api/customer', createCustomerRouter(container));

  // -------------------------------------------------------------------------
  // authenticate() + tenantMiddleware() — protegen todo /api/*
  // -------------------------------------------------------------------------
  app.use('/api', authenticate());

  if (platformRepo) {
    app.use('/api', tenantMiddleware(platformRepo));
  }

  // -------------------------------------------------------------------------
  // Rutas protegidas de empleados
  // -------------------------------------------------------------------------
  app.use('/api/resources',    createResourcesRouter(container));
  app.use('/api/reservations', createReservationsRouter(container));
  app.use('/api/reports',      createReportsRouter(container));
  app.use('/api/customers',    createCustomersRouter(container));
  app.use('/api/users',        createUsersRouter(platformRepo));

  // /api/categories requiere resolver el plan del negocio vía platformRepo.
  // Sin PLATFORM_DATABASE_URL no hay forma de conocer el plan (límites por
  // categoría), así que en single-tenant queda deshabilitado explícitamente
  // en vez de fallar de forma confusa dentro del servicio.
  if (platformRepo) {
    app.use('/api/categories', createCategoryRouter(
      container.categoryService,
      async (businessId: string) => {
        const business = await platformRepo.findById(businessId);
        if (!business) {
          throw new Error(`Negocio "${businessId}" no encontrado al resolver su plan.`);
        }
        return business.plan;
      },
    ));
  } else {
    app.use('/api/categories', (_req, res) => {
      res.status(503).json({
        code: 'PLATFORM_UNAVAILABLE',
        message: 'La gestión de categorías requiere PLATFORM_DATABASE_URL.',
      });
    });
  }

  app.use(errorHandler);

  return { app, container };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

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

    if (onShutdown) {
      try {
        await onShutdown();
      } catch (err) {
        console.error('[server] Error en onShutdown:', err);
      }
    }

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
