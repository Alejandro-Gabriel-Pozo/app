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
import { logger } from './logger.js';
import { getPort, getPlatformDatabaseUrl, getDbIdleInTransactionTimeoutMs } from './config/env.js';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = getPort();

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Migración de la BD central (PLATFORM_DATABASE_URL — siempre requerida)
  // -------------------------------------------------------------------------
  try {
    logger.info('[migrate] Ejecutando platform.schema.sql...');
    const schemaPath = join(__dirname, 'db', 'platform.schema.sql');
    const sql = await readFile(schemaPath, 'utf-8');

    const { Pool } = pg;
    const pool = new Pool({
      connectionString: getPlatformDatabaseUrl(),
      // Misma fuente de verdad que el resto de los pools del proceso
      // (container.ts, tenant.middleware.ts) — ver db/pg.client.ts.
      // Antes decidía por NODE_ENV en vez de NEON_SSL, un tercer criterio
      // distinto para la misma conexión.
      ssl: sslConfig(),
      // D-20 sub-bloque 4 (17/09/2026, F12-12) -- este pool aplica
      // platform.schema.sql (DDL), no requests -- a propósito SIN
      // statement_timeout (abortar una migración a mitad de camino en
      // cada deploy es peor que esperar, mismo criterio que Neon en D-20
      // sub-bloque 2). idle_in_transaction_session_timeout SÍ es seguro
      // acá -- solo dispara si la conexión queda con una tx abierta SIN
      // ejecutar nada, no mientras el DDL sigue en curso (ver docblock de
      // getDbIdleInTransactionTimeoutMs() en config/env.ts).
      idle_in_transaction_session_timeout: getDbIdleInTransactionTimeoutMs(),
    });
    await pool.query(sql);
    await pool.end();
    logger.info('[migrate] ✅ platform.schema.sql aplicado.');
  } catch (err) {
    logger.error({ err }, '[migrate] ❌ Error en platform.schema.sql');
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
    // El detalle de Swagger lo loguea app.ts, que es quien sabe si lo montó
    // o no — acá afirmarlo siempre seria mentir en produccion.
    logger.info({ port: PORT }, `🚀 Reservations API en http://localhost:${PORT} (modo: multi-tenant)`);
  });

  // -------------------------------------------------------------------------
  // Graceful shutdown: HTTP server → workers por tenant → pools PostgreSQL
  // stopAllWorkers() y closeTenantPools() se llaman desde app.ts
  // -------------------------------------------------------------------------
  registerGracefulShutdown(server, {
    onShutdown: async () => {
      await closeTenantPools();
      await closePlatformPool();
      logger.info('[server] Pools PostgreSQL cerrados.');
    },
  });
}

main().catch(async (err) => {
  logger.error({ err }, '[server] Error fatal al arrancar');
  Sentry.captureException(err);
  await Sentry.flush(2000);
  process.exit(1);
});
