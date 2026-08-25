/**
 * @file server.ts
 * @description Entry point — corre migraciones y arranca el servidor.
 *
 * ## Cambios en esta versión
 * - El worker de outbox por tenant se arranca desde tenantMiddleware;
 *   ya no hay un outboxWorker global en AppContainer ni en server.ts.
 * - stopAllWorkers() se llama desde registerGracefulShutdown en app.ts.
 * - Cierra pools de tenants y plataforma en el graceful shutdown.
 * - Envuelve el arranque en main() con try/catch para capturar errores fatales.
 *
 * Migraciones automáticas al arrancar:
 * - PLATFORM_DATABASE_URL → platform.schema.sql (BD central, siempre requerida)
 * - Tenant schemas se aplican vía tenant.middleware al primer request del tenant.
 */

import './instrument.js'; // SIEMPRE primero -- ver docblock de instrument.ts

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, registerGracefulShutdown } from './app.js';
import * as Sentry from '@sentry/node';
import { closePlatformPool } from './container.js';
import { closeTenantPools } from './platform/tenant.middleware.js';
import { sslConfig } from './db/pg.client.js';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Migración de la BD central (PLATFORM_DATABASE_URL — siempre requerida)
  // -------------------------------------------------------------------------
  try {
    console.log('[migrate] Ejecutando platform.schema.sql...');
    const schemaPath = join(__dirname, 'db', 'platform.schema.sql');
    const sql = await readFile(schemaPath, 'utf-8');

    const { Pool } = pg;
    const pool = new Pool({
      connectionString: process.env.PLATFORM_DATABASE_URL,
      // Misma fuente de verdad que el resto de los pools del proceso
      // (container.ts, tenant.middleware.ts) — ver db/pg.client.ts.
      // Antes decidía por NODE_ENV en vez de NEON_SSL, un tercer criterio
      // distinto para la misma conexión.
      ssl: sslConfig(),
    });
    await pool.query(sql);
    await pool.end();
    console.log('[migrate] ✅ platform.schema.sql aplicado.');
  } catch (err) {
    console.error('[migrate] ❌ Error en platform.schema.sql:', err);
    Sentry.captureException(err);
    await Sentry.flush(2000);
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // Arranque del servidor
  // Los workers de outbox por tenant arrancan desde tenantMiddleware.
  // -------------------------------------------------------------------------
  const { app } = await createApp();

  const server = app.listen(PORT, () => {
    console.log(`\n🚀 Reservations API en http://localhost:${PORT}`);
    console.log(`   Swagger UI: http://localhost:${PORT}/docs`);
    console.log(`   Modo:       multi-tenant\n`);
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown: HTTP server → workers por tenant → pools PostgreSQL
  // stopAllWorkers() y closeTenantPools() se llaman desde app.ts
  // -------------------------------------------------------------------------
  registerGracefulShutdown(server, {
    onShutdown: async () => {
      await closeTenantPools();
      await closePlatformPool();
      console.log('[server] Pools PostgreSQL cerrados.');
    },
  });
}

main().catch(async (err) => {
  console.error('[server] Error fatal al arrancar:', err);
  Sentry.captureException(err);
  await Sentry.flush(2000);
  process.exit(1);
});
