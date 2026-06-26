/**
 * @file server.ts
 * @description Entry point del servidor HTTP.
 *
 * Responsabilidades:
 * 1. Crear la aplicación Express (`createApp`).
 * 2. Arrancar el servidor en el puerto configurado.
 * 3. Registrar los handlers de shutdown graceful (SIGTERM / SIGINT).
 *
 * `server.ts` es el único archivo que llama a `app.listen()` — facilita
 * los tests de integración, que importan `createApp()` directamente
 * sin levantar un puerto real.
 */

import { createApp, registerGracefulShutdown } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

const { app } = await createApp();

const server = app.listen(PORT, () => {
  const mode = process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory';
  console.log(`\n🚀 Reservations API en http://localhost:${PORT}`);
  console.log(`   Swagger UI:  http://localhost:${PORT}/docs`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   Modo:        ${mode}\n`);
});

// Registrar SIGTERM / SIGINT para Render y entornos containerizados
registerGracefulShutdown(server);
