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
 * 11. /api/resources, /reservations, /reports, /users — rutas de empleados
 * 12. /api/customer/me/**           — rutas privadas del cliente (auth dentro del router)
 * 13. errorHandler
 *
 * ## Cambios en esta versión
 * - `createApp()` devuelve `{ app, container }` para que `server.ts` pueda
 *   acceder al `outboxWorker` y arrancarlo/detenerlo.
 * - `registerGracefulShutdown()` acepta un segundo parámetro opcional
 *   `{ onShutdown }` que se ejecuta antes de cerrar el servidor HTTP.
 *   Permite detener el outbox worker limpiamente en SIGTERM/SIGINT.
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
import { createUsersRouter }         from './api/routes/users.routes.js';
import { createPlatformRouter }      from './api/routes/platform.routes.js';
import { errorHandler }              from './api/middleware/error.middleware.js';
import { openApiSpec }               from './openapi/spec.js';
import { authenticate }              from './security/auth.middleware.js';
import { AuthService }               from './security/auth.service.js';
import { PlatformRepository }        from './platform/platform.repository.js';
import { createPlatformContainer }   from './platform/platform.container.js';
import { tenantMiddleware }          from './platform/tenant.middleware.js';
import { SqlClient }                 from './repositories/sql.client.js';
import { createAppContainer, AppContainer } from './container.js';
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

export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
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
  // /platform/* — gestión de plataforma (SUPERADMIN)
  // POST /platform/login es público; el resto requiere JWT SUPERADMIN.
  // Se monta ANTES de authenticate() para que /platform/login no quede bloqueado.
  // -------------------------------------------------------------------------
  const platformContainer = createPlatformContainer();
  if (platformContainer) {
    app.use('/platform', createPlatformRouter(platformContainer));
  } else {
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
  // register, login y availability son públicos;
  // /me/** está protegido por authenticate+authorize dentro del router.
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
  app.use('/api/users',        createUsersRouter(platformRepo));

  app.use(errorHandler);

  return { app, container };
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

export interface GracefulShutdownOptions {
  /**
   * Callback asíncrono ejecutado ANTES de cerrar el servidor HTTP.
   * útil para detener workers, cerrar conexiones externas, etc.
   */
  onShutdown?: () => Promise<void>;
}

export function registerGracefulShutdown(
  server: http.Server,
  options: GracefulShutdownOptions = {},
): void {
  const { onShutdown } = options;

  const shutdown = async (signal: string) => {
    console.log(`\n[server] ${signal} recibido. Cerrando servidor...`);

    // 1. Ejecutar cleanup (detener workers, etc.) antes de cerrar el HTTP server.
    //    Si onShutdown lanza, se loguea el error pero el proceso sigue cerrando.
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (err) {
        console.error('[server] Error en onShutdown:', err);
      }
    }

    // 2. Cerrar el servidor HTTP — deja de aceptar conexiones nuevas.
    server.close(() => {
      console.log('[server] Servidor cerrado correctamente.');
      process.exit(0);
    });

    // 3. Forzar cierre si no termina en 10 s.
    setTimeout(() => {
      console.error('[server] Cierre forzado por timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT',  () => { void shutdown('SIGINT'); });
}
