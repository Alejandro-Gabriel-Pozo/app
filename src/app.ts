/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express — arquitectura multi-tenant.
 *
 * ## Dos bases de datos
 * - PLATFORM_DATABASE_URL → BD central (businesses, platform_users)
 * - Por request: req.db   → BD del negocio autenticado (inyectada por tenantMiddleware)
 *
 * ## Orden de middlewares
 * 1. cors, express.json
 * 2. /health, /docs, /openapi.json  — rutas públicas
 * 3. POST /register                 — registro de negocios (público, sin auth)
 * 4. POST /api/login                — login de empleados (público)
 * 5. /api/customer/register         — registro de clientes (público)
 * 6. /api/customer/login            — login de clientes (público)
 * 7. /api/customer/availability/**  — disponibilidad pública (sin auth)
 * 8. authenticate()                 — verifica JWT, protege /api/* restante
 * 9. tenantMiddleware()             — inyecta req.db con la BD del negocio
 * 10. /api/resources, /reservations, /reports — rutas de empleados
 * 11. /api/customer/me/**           — rutas privadas del cliente (auth dentro del router)
 * 12. errorHandler
 */

import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import pg from 'pg';
import http from 'node:http';

import { createResourcesRouter }     from './api/routes/resources.routes.js';
import { createReservationsRouter }  from './api/routes/reservations.routes.js';
import { createReportsRouter }       from './api/routes/reports.routes.js';
import { createAuthRouter }          from './api/routes/auth.routes.js';
import { createBusinessRouter }      from './api/routes/business.routes.js';
import { createCustomerRouter }      from './api/routes/customer.routes.js';
import { errorHandler }              from './api/middleware/error.middleware.js';
import { openApiSpec }               from './openapi/spec.js';
import { authenticate }              from './security/auth.middleware.js';
import { AuthService }               from './security/auth.service.js';
import { PlatformRepository }        from './platform/platform.repository.js';
import { tenantMiddleware }          from './platform/tenant.middleware.js';
import { SqlClient }                 from './repositories/sql.client.js';
import { createAppContainer }        from './container.js';
import { checkDatabaseHealth }       from './db/pg.client.js';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Inicialización de la BD central (PLATFORM_DATABASE_URL)
// ---------------------------------------------------------------------------

function createPlatformClient(): SqlClient | null {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) return null;

  const pool = new Pool({
    connectionString: url,
    max: 5,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  });

  pool.on('error', (err) => {
    console.error('[platform] Error en pool central:', err.message);
  });

  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount ?? undefined };
    },
  };
}

export async function createApp(): Promise<{ app: express.Application }> {
  const app = express();

  // -------------------------------------------------------------------------
  // BD central y repositorio de plataforma
  // -------------------------------------------------------------------------
  const platformClient = createPlatformClient();
  const platformRepo = platformClient
    ? new PlatformRepository(platformClient)
    : null;

  if (!platformClient) {
    console.warn(
      '[app] ⚠️  PLATFORM_DATABASE_URL no definida. ' +
      'El registro de negocios y el login multi-tenant no funcionarán. ' +
      'Modo desarrollo single-tenant activo.',
    );
  }

  // -------------------------------------------------------------------------
  // Auth service (empleados)
  // -------------------------------------------------------------------------
  const authService = new AuthService(platformRepo);

  // -------------------------------------------------------------------------
  // Container single-tenant (fallback cuando no hay PLATFORM_DATABASE_URL)
  // -------------------------------------------------------------------------
  const container = await createAppContainer();

  // -------------------------------------------------------------------------
  // Middlewares globales
  // -------------------------------------------------------------------------
  app.use(cors({
    origin: process.env.CORS_ORIGIN ?? '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));
  app.use(express.json());

  // -------------------------------------------------------------------------
  // Rutas públicas
  // -------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    const dbOk = process.env.DATABASE_URL ? await checkDatabaseHealth() : null;
    res.json({
      status: 'ok',
      mode: platformClient ? 'multi-tenant' : 'single-tenant',
      db: dbOk === null ? 'n/a' : dbOk ? 'connected' : 'error',
    });
  });

  app.get('/', (_req, res) => res.redirect('/docs'));
  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Reservations API',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'list', filter: true },
  }));

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
  // register, login y availability son públicos;
  // /me/** está protegido por authenticate+authorize dentro del router.
  // Montado ANTES del authenticate() global para que register/login/availability
  // no requieran token de empleado.
  // -------------------------------------------------------------------------
  app.use('/api/customer', createCustomerRouter(container));

  // -------------------------------------------------------------------------
  // authenticate() + tenantMiddleware() — protegen todo /api/* (empleados)
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

  app.use(errorHandler);

  return { app };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export function registerGracefulShutdown(server: http.Server): void {
  const shutdown = (signal: string) => {
    console.log(`\n[server] ${signal} recibido. Cerrando servidor...`);
    server.close(() => {
      console.log('[server] Servidor cerrado correctamente.');
      process.exit(0);
    });
    setTimeout(() => {
      console.error('[server] Cierre forzado por timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
