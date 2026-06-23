import express from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { createAppContainer, AppContainer } from './container.js';
import { createResourcesRouter } from './api/routes/resources.routes.js';
import { createReservationsRouter } from './api/routes/reservations.routes.js';
import { createReportsRouter } from './api/routes/reports.routes.js';
import { errorHandler } from './api/middleware/error.middleware.js';
import { openApiSpec } from './openapi/spec.js';

export async function createApp(): Promise<{
  app: express.Application;
  container: AppContainer;
}> {
  const container = await createAppContainer();
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      mode: 'in-memory',
      resources: 'seeded',
    });
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
    }),
  );

  app.use('/api/resources', createResourcesRouter(container));
  app.use('/api/reservations', createReservationsRouter(container));
  app.use('/api/reports', createReportsRouter(container));

  app.use(errorHandler);

  return { app, container };
}
