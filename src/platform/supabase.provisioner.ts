/**
 * @file supabase.provisioner.ts
 * @description Provisiona automáticamente una base de datos Supabase
 * por cada negocio que se registra en la plataforma.
 *
 * ## Variables de entorno requeridas (Render Dashboard)
 *
 * | Variable                  | Descripción                                      |
 * |---------------------------|--------------------------------------------------|
 * | SUPABASE_ACCESS_TOKEN     | Personal access token de tu cuenta Supabase      |
 * | SUPABASE_ORG_ID           | Organization ID de tu cuenta Supabase            |
 * | SUPABASE_REGION           | Región para nuevos proyectos (default: us-east-1)|
 * | SUPABASE_DB_PASSWORD_SALT | Salt para derivar passwords de BD por negocio    |
 * | DB_ENCRYPTION_KEY         | 32 bytes hex para cifrar db_urls en la BD central|
 *
 * ## Seguridad de db_url
 * La connection string de cada negocio se guarda en la BD central cifrada
 * con AES-256-GCM usando DB_ENCRYPTION_KEY. Nunca se almacena en texto plano.
 *
 * ## Modo de operación
 * Esta plataforma siempre opera en modo MULTI-TENANT.
 * Cada negocio tiene su propia BD Supabase — no existe fallback single-tenant.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scryptAsync = promisify(scrypt);

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface ProvisionedDatabase {
  projectId: string;
  connectionString: string;
  host: string;
}

interface SupabaseProject {
  id: string;
  name: string;
  db_host: string;
  db_port: number;
  db_name: string;
  db_user: string;
  status: string;
}

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
 * El resultado se cachea en memoria para no releer el disco en cada provisioning.
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
    throw new Error('[provisioner] Formato de ciphertext inválido — esperado: iv:authTag:ciphertext');
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
      '[provisioner] DB_ENCRYPTION_KEY no está definida. ' +
      'Esta variable es obligatoria en modo multi-tenant. ' +
      'Generá una con: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  const keyBuffer = Buffer.from(keyMaterial, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error(
      `[provisioner] DB_ENCRYPTION_KEY debe ser 32 bytes en hex (64 caracteres). ` +
      `Recibido: ${keyBuffer.length} bytes.`,
    );
  }
  return keyBuffer;
}

// ---------------------------------------------------------------------------
// Provisioner
// ---------------------------------------------------------------------------

export async function provisionBusinessDatabase(
  businessId: string,
  businessName: string,
): Promise<ProvisionedDatabase> {
  const accessToken = requireEnv('SUPABASE_ACCESS_TOKEN');
  const orgId = requireEnv('SUPABASE_ORG_ID');
  const region = process.env.SUPABASE_REGION ?? 'us-east-1';
  const dbPassword = await deriveDbPassword(businessId);
  const projectName = `reservations-${slugify(businessName)}-${businessId.slice(0, 8)}`;

  console.log(`[provisioner] Creando proyecto Supabase: ${projectName}`);

  const createResponse = await fetch('https://api.supabase.com/v1/projects', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: projectName, organization_id: orgId, region, db_pass: dbPassword, plan: 'free' }),
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(`[provisioner] Error creando proyecto Supabase: ${error}`);
  }

  const project = await createResponse.json() as SupabaseProject;
  console.log(`[provisioner] Proyecto creado: ${project.id} — esperando activación...`);

  const activeProject = await waitForProjectActive(project.id, accessToken);
  const connectionString = buildConnectionString(activeProject, dbPassword);

  console.log(`[provisioner] ✅ BD provisionada para negocio ${businessId}`);
  return { projectId: activeProject.id, connectionString, host: activeProject.db_host };
}

async function waitForProjectActive(
  projectId: string,
  accessToken: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<SupabaseProject> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    await sleep(10_000);
    const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!response.ok) continue;
    const project = await response.json() as SupabaseProject;
    console.log(`[provisioner] Estado del proyecto ${projectId}: ${project.status}`);
    if (project.status === 'ACTIVE_HEALTHY') return project;
  }
  throw new Error(`[provisioner] Timeout esperando activación del proyecto ${projectId} (5 min)`);
}

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
    console.log('[provisioner] ✅ Schema aplicado en la nueva BD');
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConnectionString(project: SupabaseProject, password: string): string {
  return `postgresql://${project.db_user}:${encodeURIComponent(password)}@${project.db_host}:${project.db_port}/${project.db_name}`;
}

async function deriveDbPassword(businessId: string): Promise<string> {
  const salt = requireEnv('SUPABASE_DB_PASSWORD_SALT');
  const key = await scryptAsync(businessId, salt, 32) as Buffer;
  return key.toString('base64url').slice(0, 32);
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`[provisioner] Variable de entorno requerida no definida: ${key}`);
  return value;
}
