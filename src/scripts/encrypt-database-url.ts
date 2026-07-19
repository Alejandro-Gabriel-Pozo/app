#!/usr/bin/env node
/**
 * @file encrypt-database-url.ts
 * @description CLI para cifrar una DATABASE_URL y obtener el valor
 * listo para insertar en el campo `db_url_encrypted` de la tabla
 * `businesses` en la BD central.
 *
 * ## Requisitos
 * - DB_ENCRYPTION_KEY debe estar definida en el entorno (32 bytes hex).
 *   Generá una con:
 *     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * ## Uso
 *   DB_ENCRYPTION_KEY=<hex> npx ts-node src/scripts/encrypt-database-url.ts \
 *     "postgres://user:pass@host:5432/postgres"
 *
 * ## Con npm script (agregar en package.json):
 *   "encrypt-db-url": "ts-node --esm src/scripts/encrypt-database-url.ts"
 *
 *   DB_ENCRYPTION_KEY=<hex> npm run encrypt-db-url -- "<connection-string>"
 *
 * ## Dónde obtener la connection string en Supabase
 * Supabase Dashboard → tu proyecto → Connect → Connection string
 * Usar "Session pooler" para conexiones persistentes desde Render.
 *
 * ## Cómo usar el resultado
 * Insertar el valor cifrado en la BD central:
 *   UPDATE businesses
 *   SET db_url_encrypted = '<resultado>', status = 'active'
 *   WHERE id = '<business-id>';
 *
 * O bien mediante la ruta POST /platform/businesses/:id/activate
 * (ver platform.routes.ts) que lo hace automáticamente.
 */

import { encryptConnectionString } from '../platform/supabase.provisioner.js';

const args = process.argv.slice(2);
const databaseUrl = args[0];

if (!databaseUrl) {
  console.error('❌ Error: falta la DATABASE_URL como argumento.');
  console.error('');
  console.error('Uso:');
  console.error('  DB_ENCRYPTION_KEY=<hex> npx ts-node src/scripts/encrypt-database-url.ts \\');
  console.error('    "postgres://user:pass@host:5432/postgres"');
  process.exit(1);
}

if (!process.env.DB_ENCRYPTION_KEY) {
  console.error('❌ Error: DB_ENCRYPTION_KEY no está definida.');
  console.error('');
  console.error('Generá una clave con:');
  console.error('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

try {
  const encrypted = await encryptConnectionString(databaseUrl);

  console.log('');
  console.log('✅ DATABASE_URL cifrada correctamente.');
  console.log('');
  console.log('Valor para db_url_encrypted:');
  console.log('─'.repeat(60));
  console.log(encrypted);
  console.log('─'.repeat(60));
  console.log('');
  console.log('Copiá este valor y usalo en:');
  console.log('  POST /platform/businesses/:id/activate');
  console.log('  o directamente en la BD central.');
  console.log('');
} catch (err) {
  console.error('❌ Error al cifrar:', err instanceof Error ? err.message : err);
  process.exit(1);
}
