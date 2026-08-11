/**
 * @file tenant-db.setup.ts
 * @description Cifrado de connection strings de tenant + carga del schema.
 *
 * Antes se llamaba supabase.provisioner.ts y también auto-creaba proyectos
 * Supabase vía su API de gestión. Ese flujo automático ya no se usa (dejaron
 * de operar con Supabase) y se eliminó — ver el hallazgo del code review de
 * agosto 2026. Lo que queda acá es independiente del proveedor:
 *
 * 1. Cifrado AES-256-GCM de la connection string antes de guardarla en
 *    `businesses.db_url_encrypted` (BD central).
 * 2. Carga de `src/db/schema.sql` para aplicarlo a una BD de tenant nueva.
 *
 * ## Flujo actual de alta de un negocio (manual, sin decisión de proveedor
 * automático todavía)
 * 1. Se crea el negocio vía POST /register o POST /platform/businesses —
 *    queda en estado PENDING, sin BD asignada.
 * 2. Alguien crea la BD del negocio a mano (hoy: un proyecto Neon) y corre
 *    schema.sql contra ella (SQL Editor o psql).
 * 3. El ADMIN del negocio llama POST /api/admin/set-tenant-url con la
 *    connection string ya lista — acá se cifra y se guarda.
 *
 * ## Variables de entorno requeridas
 * | Variable          | Descripción                                      |
 * |-------------------|---------------------------------------------------|
 * | DB_ENCRYPTION_KEY | 32 bytes hex para cifrar db_urls en la BD central |
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Schema loader — fuente de verdad única, resuelta desde este archivo
// ---------------------------------------------------------------------------

/** Caché en memoria: se lee una sola vez por proceso. */
let _schemaSQLCache: string | undefined;

/**
 * Devuelve el contenido de src/db/schema.sql.
 *
 * Usa import.meta.url para resolver el path de forma robusta,
 * independientemente de la estructura del directorio de build.
 * El resultado se cachea en memoria para no releer el disco en cada uso.
 */
export async function loadTenantSchema(): Promise<string> {
  if (_schemaSQLCache) return _schemaSQLCache;
  // Este archivo está en src/platform/ — schema.sql está en src/db/
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = resolve(thisDir, '..', 'db', 'schema.sql');
  _schemaSQLCache = await readFile(schemaPath, 'utf-8');
  return _schemaSQLCache;
}

// ---------------------------------------------------------------------------
// Cifrado de connection strings
// ---------------------------------------------------------------------------

export async function encryptConnectionString(plaintext: string): Promise<string> {
  const key = await deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export async function decryptConnectionString(ciphertext: string): Promise<string> {
  const key = await deriveEncryptionKey();
  const [ivHex, authTagHex, dataHex] = ciphertext.split(':');
  if (!ivHex || !authTagHex || !dataHex) {
    throw new Error('[tenant-db.setup] Formato de ciphertext inválido — esperado: iv:authTag:ciphertext');
  }
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const data = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

async function deriveEncryptionKey(): Promise<Buffer> {
  const keyMaterial = process.env.DB_ENCRYPTION_KEY;
  if (!keyMaterial) {
    throw new Error(
      '[tenant-db.setup] DB_ENCRYPTION_KEY no está definida. ' +
      'Esta variable es obligatoria en modo multi-tenant. ' +
      'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const keyBuffer = Buffer.from(keyMaterial, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(
      `[tenant-db.setup] DB_ENCRYPTION_KEY debe ser 32 bytes en hex (64 caracteres). ` +
      `Recibido: ${keyBuffer.length} bytes.`,
    );
  }
  return keyBuffer;
}

// ---------------------------------------------------------------------------
// Aplicar schema a una BD de tenant ya creada (independiente del proveedor)
// ---------------------------------------------------------------------------

export async function runSchemaOnNewDatabase(
  connectionString: string,
  schemaSQL: string,
): Promise<void> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    await client.query(schemaSQL);
    console.log('[tenant-db.setup] ✅ Schema aplicado en la nueva BD');
  } finally {
    await client.end();
  }
}
