/**
 * @file server.ts
 * @description Entry point del servidor HTTP.
 *
 * En modo PostgreSQL ejecuta automáticamente el schema.sql antes de arrancar,
 * así no se necesita correr migraciones manualmente (útil en Render free tier
 * donde no hay acceso a Shell ni CLI remota).
 *
 * El schema usa IF NOT EXISTS y ON CONFLICT DO NOTHING — es idempotente,
 * se puede ejecutar en cada deploy sin riesgo de perder datos.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createApp, registerGracefulShutdown } from './app.js';
import { pgClient } from './db/pg.client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ---------------------------------------------------------------------------
// Migración automática — solo en modo PostgreSQL
// ---------------------------------------------------------------------------
if (process.env.DATABASE_URL) {
  try {
    console.log('[migrate] Ejecutando schema.sql...');
    const schemaPath = join(__dirname, 'db', 'schema.sql');
    const sql = await readFile(schemaPath, 'utf-8');
    await pgClient.query(sql);
    console.log('[migrate] ✅ Schema aplicado correctamente.');
  } catch (err) {
    console.error('[migrate] ❌ Error ejecutando schema.sql:', err);
    process.exit(1); // Si el schema falla, no tiene sentido arrancar
  }
}

// ---------------------------------------------------------------------------
// Arranque del servidor
// ---------------------------------------------------------------------------
const { app } = await createApp();

const server = app.listen(PORT, () => {
  const mode = process.env.DATABASE_URL ? 'PostgreSQL' : 'in-memory';
  console.log(`\n🚀 Reservations API en http://localhost:${PORT}`);
  console.log(`   Swagger UI:  http://localhost:${PORT}/docs`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   Modo:        ${mode}\n`);
});

registerGracefulShutdown(server);
