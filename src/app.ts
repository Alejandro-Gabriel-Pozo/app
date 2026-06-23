
/**
 * @file app.ts
 * @description Bootstrap de la aplicación Express.
 *
 * ## Orden de middlewares (crítico para la seguridad)
 *
 * ```
 * cors()          ← CORS headers antes de parsear body
 * express.json()  ← Parser de body JSON
 * /health         ← Pública: sin auth
 * /               ← Pública: redirect a /docs
 * /openapi.json   ← Pública: spec para clientes SDK
 * /docs           ← Pública: Swagger UI
 * /api/login      ← Pública: emite tokens (antes del authenticate)
 * authenticate()  ← A partir de aquí: todas las rutas requieren JWT
 * /api/resources     ← Protegida
 * /api/reservations  ← Protegida
 * /api/reports       ← Protegida
 * errorHandler    ← Siempre al final
 * ```
 *
 * ## Por qué /api/login va ANTES de authenticate()
 *
 * `authenticate()` rechaza cualquier request sin JWT válido.
 * Si montáramos `/api/login` después, el propio endpoint de login
 * sería bloqueado antes de poder emitir el primer token.
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
 
export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
  const container = await createAppContainer();
 
  // Inicializar servicio de autenticación con el store en memoria.
  // Para producción con BD: sustituir InMemoryUserStore por SqlUserStore.
  const userStore = new InMemoryUserStore();
  const authService = new AuthService(userStore);
 
  const app = express();
 
  // -------------------------------------------------------------------------
  // Middlewares globales
  // -------------------------------------------------------------------------
 
  app.use(
    cors({
      // En producción: restringe al origen del frontend.
      // Render Dashboard → Environment → CORS_ORIGIN=https://tu-frontend.com
      origin: process.env.CORS_ORIGIN ?? '*',
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }),
  );
 
  app.use(express.json());
 
  // -------------------------------------------------------------------------
  // Rutas públicas — sin authenticate()
  // -------------------------------------------------------------------------
 
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', mode: 'in-memory', resources: 'seeded' });
  });
 
  app.get('/', (_req, res) => {
    res.redirect('/docs');
  });
 
  app.get('/openapi.json', (_req, res) => {
    res.json(openApiSpec);
  });
 
  app.use(
    '/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiSpec, {
      customSiteTitle: 'Reservations API',
      swaggerOptions: {
        // Mantiene el token entre recargas del navegador
        persistAuthorization: true,
        // Expande el tag Auth por defecto para que el flujo login→Authorize sea visible
        docExpansion: 'list',
        filter: true,
      },
    }),
  );
 
  // -------------------------------------------------------------------------
  // POST /api/login — DEBE ir antes de authenticate()
  // -------------------------------------------------------------------------
  app.use('/api/login', createAuthRouter(authService));
 
  // -------------------------------------------------------------------------
  // authenticate() — protege TODAS las rutas /api/* montadas a continuación
  // -------------------------------------------------------------------------
  app.use('/api', authenticate());
 
  app.use('/api/resources', createResourcesRouter(container));
  app.use('/api/reservations', createReservationsRouter(container));
  app.use('/api/reports', createReportsRouter(container));
 
  // -------------------------------------------------------------------------
  // Error handler global — siempre al final
  // -------------------------------------------------------------------------
  app.use(errorHandler);
 
  return { app, container };
}
 
