/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express.
 *
 * Orden de middlewares (importa para la seguridad):
 * 1. cors()          — Headers CORS (antes de parsear el body)
 * 2. express.json()  — Parsear body JSON
 * 3. Rutas públicas  — /health, /, /openapi.json, /docs  (sin auth)
 * 4. authenticate()  — Verifica JWT para todo /api/*
 * 5. Routers de API  — /api/resources, /api/reservations, /api/reports
 * 6. errorHandler    — Captura errores de toda la cadena anterior
 */

import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { createAppContainer, AppContainer } from './container.js';
import { createResourcesRouter } from './api/routes/resources.routes.js';
import { createReservationsRouter } from './api/routes/reservations.routes.js';
import { createReportsRouter } from './api/routes/reports.routes.js';
import { errorHandler } from './api/middleware/error.middleware.js';
import { openApiSpec } from './openapi/spec.js';
import { authenticate } from './security/auth.middleware.js';

export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
  const container = await createAppContainer();
  const app = express();

  // -------------------------------------------------------------------------
  // Middlewares globales
  // -------------------------------------------------------------------------

  /**
   * CORS: en producción restringe el origen al dominio de tu frontend.
   *
   * Render Dashboard → Environment → Agregar:
   *   CORS_ORIGIN = https://tu-frontend.onrender.com
   *
   * Para múltiples orígenes, usa una lista separada por comas en la variable
   * y parsea aquí: process.env.CORS_ORIGIN?.split(',')
   */
  app.use(
    cors({
      origin: process.env.CORS_ORIGIN ?? '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );

  app.use(express.json());

  // -------------------------------------------------------------------------
  // Rutas públicas (sin autenticación)
  // -------------------------------------------------------------------------

  /**
   * @swagger
   * /health:
   *   get:
   *     summary: Health check — no requiere autenticación
   *     tags: [System]
   *     responses:
   *       200:
   *         description: Servicio operativo
   */
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: 'in-memory',
      resources: 'seeded',
    });
  });

  /** Redirige la raíz a la documentación Swagger */
  app.get('/', (_req, res) => {
    res.redirect('/docs');
  });

  /** Spec OpenAPI en JSON — útil para clientes que generan SDK */
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });

  /** Swagger UI — disponible sin autenticación para facilitar la exploración */
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'Reservations API',
      swaggerOptions: {
        // Persiste el token entre recargas en el navegador
        persistAuthorization: true,
      },
    }),
  );

  // -------------------------------------------------------------------------
  // Rutas protegidas — authenticate() se aplica a TODO /api/*
  // -------------------------------------------------------------------------

  /**
   * `authenticate()` sin argumentos lee el JWT del header `Authorization: Bearer <token>`.
   * Para tests de integración se puede pasar un resolver que devuelva un usuario fijo:
   *
   * ```ts
   * app.use('/api', authenticate(() => ({ id: 'test', role: UserRole.ADMIN })));
   * ```
   */
  app.use('/api', authenticate());

  app.use('/api/resources', createResourcesRouter(container));
  app.use('/api/reservations', createReservationsRouter(container));
  app.use('/api/reports', createReportsRouter(container));

  // -------------------------------------------------------------------------
  // Manejador de errores global — siempre al final
  // -------------------------------------------------------------------------
  app.use(errorHandler);

  return { app, container };
}
