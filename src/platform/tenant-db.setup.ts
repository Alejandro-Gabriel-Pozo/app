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
 * ## Flujo actual de alta de un negocio (creación de BD manual, resto ya no)
 * 1. Se crea el negocio vía POST /register o POST /platform/businesses —
 *    queda en estado PENDING, sin BD asignada.
 * 2. Alguien crea la BD del negocio a mano (hoy: un proyecto Neon) — vacía,
 *    sin schema todavía.
 * 3. El ADMIN del negocio llama POST /api/admin/set-tenant-url (o
 *    repair-tenant-db) con la connection string. Desde ahí el propio
 *    endpoint llama a applyTenantSchema() — corre schema.sql y registra la
 *    versión (ver CURRENT_SCHEMA_VERSION más abajo) antes de cifrar y
 *    guardar la connection string. Ya no hace falta correr schema.sql a
 *    mano por SQL Editor/psql como antes.
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
// Versionado y aplicación de schema.sql por tenant
// ---------------------------------------------------------------------------

/**
 * Versión actual de src/db/schema.sql. Única fuente de verdad — bumpear a
 * mano cada vez que schema.sql cambie de forma que valga la pena rastrear
 * (nueva tabla/columna, backfill nuevo). No hay migraciones numeradas
 * separadas: el archivo entero se re-aplica siempre, así que esta versión
 * es solo una etiqueta de "hasta qué cambio llegó esta tenant DB".
 *
 * Consumida por applyTenantSchema() (acá abajo, quien la persiste) y por
 * tenant.middleware.ts (quien la compara contra businesses.schema_version
 * para advertir sobre tenants desactualizados).
 */
// v2 (14/08/2026): BLOQUE 10 de schema.sql — tabla audit_log nueva (R8/A9.4).
// Bumpeado a mano acá mismo, junto con el cambio de schema.sql que lo
// motiva — es justamente el paso que pendientes-2026-08-13.md (A4) marcó
// como "hay que acordarse a mano" y que se saltó la sesión anterior.
// v3 (14/08/2026): BLOQUE 11 — tabla cash_register_shifts nueva +
// financial_transactions.payment_method/shift_id (Gap analysis Tango #2).
// v4 (14/08/2026): BLOQUE 12 — financial_transactions.card_installments/
// card_surcharge_amount (Gap analysis Tango #3).
// v5 (15/08/2026): BLOQUE 13 — índice único (order_item_id, movement_type)
// en stock_movements, primer uso real de la tabla (handler de inventario
// enganchado al outbox, ver docs/arquitectura-monolito-modular.md).
// v6 (15/08/2026): BLOQUE 14 — orders.served_at, para que cancelOrder()
// sepa si el bien ya se consumió físicamente antes de restaurar stock.
// v7 (15/08/2026): BLOQUE 7 — domain_events.retry_count/failed_at/last_error
// + índice de dead-letter, dead-letter/alertas del outbox (A9.5/A8.7,
// pendientes-2026-08-15.md punto 2).
// v8 (15/08/2026): BLOQUE 3 — products/product_variants.reserved_quantity +
// CHECK reserved<=stock. BLOQUE 5/13 — stock_movements gana el tipo
// RESERVATION_RELEASED + índice de exclusión mutua con OUT por order_item.
// Carrera de stock en confirmOrder(), pendientes-2026-08-15.md punto 1.
// v9 (15/08/2026): BLOQUE 15 — business_profile (MAESTRO singleton) nueva,
// identidad del negocio para el remitente de mails (punto 5/E5,
// pendientes-2026-08-15.md).
// v10 (15/08/2026): customers.google_sub — login con Google del portal
// (punto 5/E5, segunda mitad). identities.google_sub (staff) vive en
// platform.schema.sql, sin versionado propio — se reaplica en cada boot.
// v11 (16/08/2026): Fase 1 del carve-out de inventario
// (docs/diseno-inventario-carve-out.md) — tabla `inventory_levels` nueva
// (BLOQUE 16), reemplaza products/product_variants.stock_quantity/
// reserved_quantity/stock_min_alert (dropeadas, con backfill previo a
// loc-default). `orders.location_id` nuevo. `stock_movements` gana
// location_id/from_location_id/to_location_id + movement_type TRANSFER.
// v12 (17/08/2026): Fase 2 del carve-out de inventario — tabla
// `waste_reasons` nueva (BLOQUE 17, maestro de catálogo propio por
// negocio). `stock_movements` gana movement_type WASTE + waste_reason_id
// (obligatorio cuando movement_type = 'WASTE').
// v13 (17/08/2026): Fase 3 del carve-out de inventario — `products` gana
// product_type/assemble_on_demand. Tabla `recipe_items` nueva (BLOQUE 18,
// BOM multinivel). `order_items.stock_snapshot` nuevo (persiste qué
// componentes se reservaron de verdad, para que cancelOrder() revierta
// exacto aunque la receta cambie después). `stock_movements` gana
// movement_type PRODUCTION; los índices únicos de idempotencia por
// order_item (BLOQUE 13/D1) se amplían a (order_item, producto/variante,
// tipo) para soportar N componentes por ítem compuesto.
// v14 (17/08/2026): Empresas multipropiedad (BLOQUE 19,
// docs/diseno-empresas-multipropiedad.md) — `products` gana
// company_product_id (vínculo sin FK real a company_products en la BD
// central) + price_override_status/recipe_override_status (tres estados:
// INACTIVO/ACTIVO/PENDIENTE_DE_REVISION) + sus columnas de valor/snapshot
// pendiente. El catálogo canónico en sí (companies/company_products/
// company_recipe_items/company_catalog_propagation_queue) vive en
// platform.schema.sql, no acá.
// v15 (17/08/2026): auditoría de hardcodes (pendientes-2026-08-17.md
// sección F3) — `business_profile` gana `currency`/`timezone`,
// configurables por negocio en vez de constantes fijas en código/SQL.
// DEFAULT explícito igual al valor que estaba hardcodeado antes ('ARS' /
// America/Argentina/Buenos_Aires) para no cambiar comportamiento hasta
// que alguien edite el perfil a propósito.
// v16 (18/08/2026): `occupancy_records` gana `category_id`/`category_name`
// — sql.occupancy.repository.ts ya las escribía (agrupar ocupación por
// categoría real, ver reservation.service.ts) pero la tabla nunca las tuvo.
// Bug real: confirmar una reserva devolvía 500 (Postgres 42703) aunque la
// reserva sí quedaba CONFIRMED, porque recordOccupancy() corre después de
// la transacción. DEFAULT '' solo afecta filas ya existentes.
// v17 (18/08/2026, noche): `resource_categories` gana `is_lodging` —
// backlog E1 (pendientes-2026-08-13.md), separa el panel de Estadías/PMS
// del de Turnos/servicios. DEFAULT FALSE, categorías existentes hay que
// marcarlas a mano desde Categorías (no hay forma de inferirlo).
// v18 (18/08/2026, noche): `reservations` gana `adultos`/`ninos` —
// spec de mejoras PMS (docs/referencia-mejoras-pms-2026-08-18-anexo.md
// sección A). Nullable: solo se pide/muestra hoy en categorías de
// alojamiento (isLodging=true); una reserva de Turnos queda con NULL.
// v19 (18/08/2026, noche): `rate_plans` (precio por tipo de habitación en
// vez de por recurso físico) + `reservations.rate_plan_id`. Ver
// pendientes-2026-08-18.md punto M.
export const CURRENT_SCHEMA_VERSION = 19;

/**
 * Aplica schema.sql (completo, idempotente) contra la tenant DB dada y
 * registra CURRENT_SCHEMA_VERSION en su tabla `schema_migrations`.
 *
 * Reemplaza al flujo manual ("alguien corre schema.sql a mano por SQL
 * Editor o psql" — ver comentario de archivo) en los dos puntos donde el
 * código ya conoce la connection string de un tenant: los endpoints de
 * admin (`repair-tenant-db`, `set-tenant-url`) y el runner masivo
 * (src/scripts/migrate-tenants.ts). Segura de re-correr: mismo criterio
 * idempotente que el resto de schema.sql.
 *
 * @returns la versión máxima registrada en `schema_migrations` después de
 *   aplicar — normalmente CURRENT_SCHEMA_VERSION, pero se lee con MAX() por
 *   si un proceso con código más viejo corre esto contra una BD que un
 *   proceso más nuevo ya migró: nunca reporta un número menor al real.
 */
export async function applyTenantSchema(connectionString: string): Promise<number> {
  const { default: pg } = await import('pg');
  const client = new pg.Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10_000,
  });
  try {
    await client.connect();
    const schemaSQL = await loadTenantSchema();
    await client.query(schemaSQL);
    await client.query(
      `INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING`,
      [CURRENT_SCHEMA_VERSION],
    );
    const result = await client.query<{ max: number }>(
      `SELECT MAX(version)::int AS max FROM schema_migrations`,
    );
    return result.rows[0]?.max ?? CURRENT_SCHEMA_VERSION;
  } finally {
    await client.end();
  }
}
