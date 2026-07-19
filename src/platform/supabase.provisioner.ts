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
 * ## Cómo obtener SUPABASE_ACCESS_TOKEN
 * Supabase Dashboard → Account (avatar) → Access Tokens → Generate new token
 * Nombre sugerido: "reservations-platform-api"
 *
 * ## Generar DB_ENCRYPTION_KEY
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * ## Seguridad de db_url
 * La connection string de cada negocio se guarda en la BD central cifrada
 * con AES-256-GCM usando DB_ENCRYPTION_KEY. Nunca se almacena en texto plano.
 *
 * ## Cifrado manual de una connection string existente
 * Usar el script CLI incluido:
 *   DB_ENCRYPTION_KEY=<hex> npx ts-node src/scripts/encrypt-database-url.ts \
 *     "postgres://user:pass@host:5432/postgres"
 *
 * ## Modo de operación
 * Esta plataforma siempre opera en modo MULTI-TENANT.
 * Cada negocio tiene su propia BD Supabase — no existe fallback single-tenant.
 * La connection string se obtiene dinámicamente desde businesses.db_url_encrypted
 * en la BD central, nunca desde una variable de entorno estática por tenant.
 */

import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface ProvisionedDatabase {
  /** ID del proyecto en Supabase */
  projectId: string;
  /** Connection string completa — cifrada antes de guardar en BD central */
  connectionString: string;
  /** Host del proyecto (para referencia) */
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
// Cifrado de connection strings
// ---------------------------------------------------------------------------

/**
 * Cifra una connection string con AES-256-GCM.
 * El resultado es seguro para almacenar en la BD central.
 *
 * Requiere DB_ENCRYPTION_KEY en el entorno (32 bytes hex).
 * Lanza error si la variable no está definida — no hay fallback single-tenant.
 *
 * @param plaintext - Connection string en texto plano
 * @returns String cifrado en formato "iv:authTag:ciphertext" (hex)
 */
export async function encryptConnectionString(plaintext: string): Promise<string> {
  const key = await deriveEncryptionKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Descifra una connection string cifrada con `encryptConnectionString`.
 *
 * Requiere DB_ENCRYPTION_KEY en el entorno (32 bytes hex).
 * Lanza error si la variable no está definida — no hay fallback single-tenant.
 *
 * @param ciphertext - String cifrado en formato "iv:authTag:ciphertext"
 * @returns Connection string en texto plano
 */
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

/**
 * Deriva la clave de cifrado desde DB_ENCRYPTION_KEY.
 *
 * Lanza un error descriptivo si la variable no está definida.
 * En modo multi-tenant esta variable es OBLIGATORIA — no hay fallback.
 */
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

/**
 * Provisiona una nueva base de datos Supabase para un negocio.
 *
 * Proceso:
 * 1. Crea el proyecto en Supabase via Management API
 * 2. Espera a que el proyecto esté activo (polling hasta 5 minutos)
 * 3. Retorna la connection string lista para usar
 *
 * @param businessId  - ID único del negocio (se usa como nombre del proyecto)
 * @param businessName - Nombre del negocio (para identificación en Supabase)
 * @returns Datos del proyecto provisionado
 * @throws Error si el provisioning falla o timeout después de 5 minutos
 */
export async function provisionBusinessDatabase(
  businessId: string,
  businessName: string,
): Promise<ProvisionedDatabase> {
  const accessToken = requireEnv('SUPABASE_ACCESS_TOKEN');
  const orgId = requireEnv('SUPABASE_ORG_ID');
  const region = process.env.SUPABASE_REGION ?? 'us-east-1';

  // Password único por negocio — derivado del business_id + salt
  const dbPassword = await deriveDbPassword(businessId);

  // Nombre del proyecto: slug del negocio + primeros 8 chars del id
  const projectName = `reservations-${slugify(businessName)}-${businessId.slice(0, 8)}`;

  console.log(`[provisioner] Creando proyecto Supabase: ${projectName}`);

  // 1. Crear el proyecto
  const createResponse = await fetch('https://api.supabase.com/v1/projects', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: projectName,
      organization_id: orgId,
      region,
      db_pass: dbPassword,
      plan: 'free',
    }),
  });

  if (!createResponse.ok) {
    const error = await createResponse.text();
    throw new Error(`[provisioner] Error creando proyecto Supabase: ${error}`);
  }

  const project = await createResponse.json() as SupabaseProject;
  console.log(`[provisioner] Proyecto creado: ${project.id} — esperando activación...`);

  // 2. Polling hasta que el proyecto esté activo (máximo 5 minutos)
  const activeProject = await waitForProjectActive(project.id, accessToken);

  // 3. Construir connection string
  const connectionString = buildConnectionString(activeProject, dbPassword);

  console.log(`[provisioner] ✅ BD provisionada para negocio ${businessId}`);

  return {
    projectId: activeProject.id,
    connectionString,
    host: activeProject.db_host,
  };
}

/**
 * Espera hasta que el proyecto Supabase esté en estado ACTIVE_HEALTHY.
 * Polling cada 10 segundos, timeout de 5 minutos.
 */
async function waitForProjectActive(
  projectId: string,
  accessToken: string,
  timeoutMs = 5 * 60 * 1000,
): Promise<SupabaseProject> {
  const startTime = Date.now();
  const pollInterval = 10_000; // 10 segundos

  while (Date.now() - startTime < timeoutMs) {
    await sleep(pollInterval);

    const response = await fetch(`https://api.supabase.com/v1/projects/${projectId}`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });

    if (!response.ok) continue;

    const project = await response.json() as SupabaseProject;
    console.log(`[provisioner] Estado del proyecto ${projectId}: ${project.status}`);

    if (project.status === 'ACTIVE_HEALTHY') {
      return project;
    }
  }

  throw new Error(
    `[provisioner] Timeout esperando activación del proyecto ${projectId} (5 min)`,
  );
}

/**
 * Ejecuta el schema.sql en el proyecto recién provisionado.
 * Se llama después de que el proyecto está activo.
 *
 * @param connectionString - Connection string del proyecto
 * @param schemaSQL        - Contenido del archivo schema.sql
 */
export async function runSchemaOnNewDatabase(
  connectionString: string,
  schemaSQL: string,
): Promise<void> {
  // Importación dinámica para evitar cargar pg si no se usa
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
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 20);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`[provisioner] Variable de entorno requerida no definida: ${key}`);
  }
  return value;
}
