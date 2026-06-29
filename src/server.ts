/**
 * @file server.ts
 * @description Entry point — corre migraciones y arranca el servidor.
 *
 * Migraciones automáticas al arrancar:
 * - DATABASE_URL        → schema.sql (BD del tenant, para modo single-tenant)
 * - PLATFORM_DATABASE_URL → platform.schema.sql (BD central)
 */
 
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, registerGracefulShutdown } from './app.js';
import { pgClient } from './db/pg.client.js';
import pg from 'pg';
 
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3000', 10);
 
// ---------------------------------------------------------------------------
// Migración de la BD central (PLATFORM_DATABASE_URL)
// ---------------------------------------------------------------------------
if (process.env.PLATFORM_DATABASE_URL) {
  try {
    console.log('[migrate] Ejecutando platform.schema.sql...');
    const schemaPath = join(__dirname, 'db', 'platform.schema.sql');
    const sql = await readFile(schemaPath, 'utf-8');
 
    const { Pool } = pg;
    const pool = new Pool({
      connectionString: process.env.PLATFORM_DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    });
    await pool.query(sql);
    await pool.end();
    console.log('[migrate] ✅ platform.schema.sql aplicado.');
  } catch (err) {
    console.error('[migrate] ❌ Error en platform.schema.sql:', err);
    process.exit(1);
  }
}
 
// ---------------------------------------------------------------------------
// Migración de la BD del tenant (DATABASE_URL — modo single-tenant / dev)
// ---------------------------------------------------------------------------
if (process.env.DATABASE_URL) {
  try {
    console.log('[migrate] Ejecutando schema.sql...');
    const schemaPath = join(__dirname, 'db', 'schema.sql');
    const sql = await readFile(schemaPath, 'utf-8');
    await pgClient.query(sql);
    console.log('[migrate] ✅ schema.sql aplicado.');
  } catch (err) {
    console.error('[migrate] ❌ Error en schema.sql:', err);
    process.exit(1);
  }
}
 
// ---------------------------------------------------------------------------
// Arranque del servidor
// ---------------------------------------------------------------------------
const { app } = await createApp();
 
const server = app.listen(PORT, () => {
  const isMultiTenant = Boolean(process.env.PLATFORM_DATABASE_URL);
  console.log(`\n🚀 Reservations API en http://localhost:${PORT}`);
  console.log(`   Swagger UI: http://localhost:${PORT}/docs`);
  console.log(`   Modo:       ${isMultiTenant ? 'multi-tenant' : 'single-tenant (dev)'}\n`);
});
 
registerGracefulShutdown(server);
