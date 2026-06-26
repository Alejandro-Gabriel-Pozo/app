/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express.
 *
 * Cambios respecto a la versión anterior:
 * - `/health` ahora reporta el modo de persistencia y el estado de la BD.
 * - El graceful shutdown cierra el pool de pg antes de que el proceso muera.
 */

import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { createAppContainer, AppContainer } from './container.js';
import { createResourcesRouter } from './api/routes/resources.routes.js';
import { createReservationsRouter } from './api/routes/reservations.routes.js';
import { createReportsRouter } from './api/routes/reports.routes.js';
import { createAuthRouter } from './api/routes/auth.routes.js';
import { errorHandler } from './api/middleware/error.middleware.js';
import { openApiSpec } from './openapi/spec.js';
import { authenticate } from './security/auth.middleware.js';
import { AuthService } from './security/auth.service.js';
import { InMemoryUserStore } from './security/user.store.js';
import { checkDatabaseHealth, closeDatabasePool } from './db/pg.client.js';

export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
  const container = await createAppContainer();

  const userStore  = new InMemoryUserStore();
  const authService = new AuthService(userStore);

  const app = express();

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

  /**
   * Health check enriquecido.
   *
   * En modo in-memory devuelve db: 'n/a'.
   * En modo PostgreSQL verifica la conexión real con SELECT 1.
   *
   * Render usa este endpoint para saber si el servicio está listo.
   * Si responde con status != 200, Render reinicia el contenedor.
   *
   * @swagger
   * /health:
   *   get:
   *     summary: Health check del servicio
   *     tags: [System]
   *     security: []
   *     responses:
   *       200:
   *         description: Servicio operativo
   *         content:
   *           application/json:
   *             examples:
   *               postgres:
   *                 value: { status: ok, mode: postgresql, db: connected }
   *               memory:
   *                 value: { status: ok, mode: in-memory, db: n/a }
   */
  app.get('/health', async (_req, res) => {
    if (container.mode === 'postgresql') {
      const dbOk = await checkDatabaseHealth();
      if (!dbOk) {
        // 503 hace que Render marque el servicio como unhealthy
        res.status(503).json({ status: 'error', mode: 'postgresql', db: 'unreachable' });
        return;
      }
      res.json({ status: 'ok', mode: 'postgresql', db: 'connected' });
    } else {
      res.json({ status: 'ok', mode: 'in-memory', db: 'n/a' });
    }
  });

  app.get('/', (_req, res) => res.redirect('/docs'));

  app.get('/openapi.json', (_req, res) => res.json(openApiSpec));

  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec, {
    customSiteTitle: 'Reservations API',
    swaggerOptions: { persistAuthorization: true, docExpansion: 'list', filter: true },
  }));

  // -------------------------------------------------------------------------
  // POST /api/login — pública, antes de authenticate()
  // -------------------------------------------------------------------------
  app.use('/api/login', createAuthRouter(authService));

  // -------------------------------------------------------------------------
  // Rutas protegidas
  // -------------------------------------------------------------------------
  app.use('/api', authenticate());

  app.use('/api/resources',     createResourcesRouter(container));
  app.use('/api/reservations',  createReservationsRouter(container));
  app.use('/api/reports',       createReportsRouter(container));

  // -------------------------------------------------------------------------
  // Error handler global
  // -------------------------------------------------------------------------
  app.use(errorHandler);

  return { app, container };
}

// ---------------------------------------------------------------------------
// Graceful shutdown — cierra el pool de pg antes de que el proceso muera
// ---------------------------------------------------------------------------

/**
 * Registra los handlers de shutdown para SIGTERM y SIGINT.
 *
 * Render envía SIGTERM cuando va a detener o reiniciar el servicio.
 * Si el proceso no termina en ~30 segundos, Render envía SIGKILL.
 *
 * El cierre limpio del pool evita:
 * - Conexiones "zombie" que consumen slots del PostgreSQL de Render.
 * - Queries truncadas a mitad de ejecución.
 *
 * @param server - Servidor HTTP de Node para cerrar los sockets activos
 */
export function registerGracefulShutdown(
  server: ReturnType<express.Application['listen']>,
): void {
  const shutdown = async (signal: string) => {
    console.log(`[shutdown] Señal ${signal} recibida — cerrando gracefully...`);

    server.close(async () => {
      console.log('[shutdown] Servidor HTTP cerrado.');
      if (process.env.DATABASE_URL) {
        await closeDatabasePool();
        console.log('[shutdown] Pool de PostgreSQL cerrado.');
      }
      process.exit(0);
    });

    // Si los sockets tardan más de 10s, forzar salida
    setTimeout(() => {
      console.error('[shutdown] Timeout — forzando salida.');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}
