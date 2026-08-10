/**
 * @file tenant.middleware.ts
 * @description Resuelve la conexión a la BD correcta para cada request.
 *
 * ## Flujo
 * 1. Lee `req.user.businessId` (inyectado por authenticate())
 * 2. Busca el negocio en la BD central → obtiene db_url_encrypted
 * 3. Descifra la connection string
 * 4. Obtiene (o crea) un pool de conexiones para ese negocio
 * 5. Adjunta `req.db` al request
 * 6. Adjunta `req.businessId` al request
 * 7. Arranca un OutboxWorker por tenant si aún no existe (fix C4)
 *
 * ## Pool cache
 * Los pools se cachean en `tenantPools` por business_id.
 * Cada entrada guarda tanto el SqlClient (interfaz usada por los repos)
 * como el Pool de pg (necesario para llamar pool.end() en shutdown o
 * para construir un PgTransactionManager — ver getTenantRawPool).
 *
 * Un negocio activo tiene exactamente un pool durante la vida del proceso.
 * Si el proceso se reinicia (Render deploy), los pools se recrean lazy.
 *
 * ## Límite de pools
 * MAX_TENANT_POOLS controla cuántos pools pueden coexistir en memoria.
 * Cada pool tiene max:5 conexiones; a 200 tenants = 1.000 conexiones
 * máximas. Al superarse el límite se loguea una advertencia — no se
 * bloquea ni se implementa LRU dado el volumen actual del producto.
 * Revisitar cuando se superen los 200 tenants activos simultáneos.
 *
 * ## Invalidación proactiva
 * `evictTenantPool(businessId)` cierra el pool y lo remueve del cache.
 * Útil para rotar credenciales o cuando un negocio se desactiva en caliente.
 *
 * ## Por qué no usar el pgClient global
 * El pgClient global apunta a la BD central (PLATFORM_DATABASE_URL).
 * Cada tenant tiene su propia BD — req.db apunta a ella.
 *
 * ## CUSTOMER y tenantMiddleware
 * Las rutas `/customer/*` se montan antes de este middleware en `app.ts`,
 * así que sus requests no llegan aquí en condiciones normales — resuelven
 * su propio `req.db` internamente (ver `customer.routes.ts`), a partir de
 * `:businessSlug` en las rutas públicas o de `business_id` en el JWT del
 * cliente para las rutas autenticadas. El guard de abajo es una segunda
 * defensa por si el orden de montaje cambiara en el futuro.
 *
 * ## SSL y Neon
 * La connection string descifrada puede incluir ?sslmode=require.
 * Se elimina antes de crear el pool para evitar conflictos con el objeto
 * ssl: del driver. rejectUnauthorized: true en producción valida el cert
 * completo de Neon (misma lógica que pg.client.ts).
 */

import { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { SqlClient } from '../repositories/sql.client.js';
import { PlatformRepository } from './platform.repository.js';
import { decryptConnectionString } from './supabase.provisioner.js';
import { BusinessStatus, UserRole } from '../types/enums.js';
import { ensureTenantWorker } from '../workers/outbox.registry.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

// ---------------------------------------------------------------------------
// Pool cache — un pool por business_id
// ---------------------------------------------------------------------------

/**
 * Entrada del cache de pools.
 * Se guarda el Pool de pg junto al SqlClient para poder:
 * - Cerrar la conexión real en shutdown o al invalidar un tenant.
 * - Obtener el Pool raw para construir PgTransactionManager (fix C1).
 */
interface TenantPoolEntry {
  client: SqlClient;
  pool:   PgPool;
}

/**
 * Número máximo de pools de tenant en memoria.
 * Cada pool tiene max:5 conexiones; a 200 tenants = 1.000 conexiones máximas.
 * Al superarse, se loguea una advertencia. No se bloquea ni se hace evición
 * automática (LRU) dado el volumen actual. Revisitar al escalar.
 */
const MAX_TENANT_POOLS = parseInt(process.env.MAX_TENANT_POOLS ?? '200', 10);

const tenantPools = new Map<string, TenantPoolEntry>();

// ---------------------------------------------------------------------------
// Helper SSL — igual que pg.client.ts
// ---------------------------------------------------------------------------

/**
 * Elimina el parámetro ?sslmode de la URL para evitar que el driver `pg`
 * lo procese junto al objeto ssl:, lo que puede provocar
 * SELF_SIGNED_CERT_IN_CHAIN en Neon.
 */
function stripSslMode(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    return u.toString();
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Pool lifecycle
// ---------------------------------------------------------------------------

/**
 * Obtiene (o crea) el SqlClient para un negocio.
 * Cachea los pools en memoria para no reconectar en cada request.
 */
export async function getTenantClient(
  businessId: string,
  platformRepo: PlatformRepository,
): Promise<SqlClient> {
  // Cache hit
  const cached = tenantPools.get(businessId);
  if (cached) return cached.client;

  // Buscar negocio en BD central
  const business = await platformRepo.findById(businessId);

  if (!business) {
    throw new TenantNotFoundError(businessId);
  }

  if (business.status !== BusinessStatus.ACTIVE) {
    throw new TenantInactiveError(businessId, business.status);
  }

  if (!business.dbUrlEncrypted) {
    throw new TenantNotReadyError(businessId);
  }

  // Descifrar connection string y limpiar ?sslmode para evitar conflictos
  const rawConnectionString = await decryptConnectionString(business.dbUrlEncrypted);
  const connectionString    = stripSslMode(rawConnectionString);

  // Crear pool para este tenant.
  // rejectUnauthorized: true en producción — Neon tiene certs válidos;
  // validar la cadena completa previene MITM y SELF_SIGNED_CERT_IN_CHAIN.
  const pool = new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: true }
      : { rejectUnauthorized: false },
  });

  pool.on('error', (err) => {
    console.error(`[tenant] Error en pool de ${businessId}:`, err.message);
    tenantPools.delete(businessId);
  });

  const client: SqlClient = {
    async query(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      const rowCount = result.rowCount ?? undefined;
      return rowCount !== undefined
        ? { rows: result.rows, rowCount }
        : { rows: result.rows };
    },
  };

  // Advertir si se supera el límite de pools simultáneos
  if (tenantPools.size >= MAX_TENANT_POOLS) {
    console.warn(
      `[tenant] ⚠️  Límite de pools alcanzado (${MAX_TENANT_POOLS}). ` +
      `Tenants activos: ${tenantPools.size + 1}. ` +
      'Considerar implementar LRU o aumentar MAX_TENANT_POOLS.',
    );
  }

  tenantPools.set(businessId, { client, pool });
  return client;
}

/**
 * Devuelve el pg.Pool raw del tenant desde el cache.
 *
 * Necesario para construir PgTransactionManager con el pool correcto (fix C1).
 * El SqlClient que expone req.db solo tiene .query() — no sirve para abrir
 * una transacción con conn.connect(). Este método expone el Pool subyacente.
 *
 * Lanza error explícito si el pool no está en cache (no debería ocurrir
 * en requests normales que ya pasaron por tenantMiddleware).
 *
 * @param businessId - ID del tenant cuyo pool se quiere obtener.
 */
export function getTenantRawPool(businessId: string): PgPool {
  const entry = tenantPools.get(businessId);
  if (!entry) {
    throw new Error(
      `[tenant] getTenantRawPool: no hay pool cacheado para tenant "${businessId}". ` +
      'Asegurate de llamar a getTenantRawPool solo después de que tenantMiddleware haya resuelto req.db.',
    );
  }
  return entry.pool;
}

/**
 * Invalida el pool de un tenant en caliente.
 * Cierra la conexión real con Postgres y lo remueve del cache.
 * Útil para rotación de credenciales o deprovisioning de un negocio.
 *
 * @param businessId - ID del tenant a invalidar.
 */
export async function evictTenantPool(businessId: string): Promise<void> {
  const entry = tenantPools.get(businessId);
  if (!entry) return;

  tenantPools.delete(businessId);

  try {
    await entry.pool.end();
    console.log(`[tenant] Pool de ${businessId} invalidado correctamente.`);
  } catch (err) {
    console.error(
      `[tenant] Error al cerrar pool de ${businessId} durante eviction:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

/**
 * Middleware que inyecta `req.db` y `req.businessId` con la conexión al tenant correcto.
 * También arranca el OutboxWorker del tenant si aún no está corriendo (fix C4).
 * Debe montarse DESPUÉS de `authenticate()`.
 */
export function tenantMiddleware(platformRepo: PlatformRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.user?.role === UserRole.CUSTOMER) {
      next();
      return;
    }

    if (!req.user?.businessId) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Token no contiene business_id',
      });
      return;
    }

    try {
      req.db         = await getTenantClient(req.user.businessId, platformRepo);
      req.businessId = req.user.businessId;

      ensureTenantWorker(req.user.businessId, req.db);

      next();
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        res.status(404).json({
          code: 'BUSINESS_NOT_FOUND',
          message: 'Negocio no encontrado',
        });
        return;
      }
      if (err instanceof TenantInactiveError) {
        res.status(403).json({
          code: 'BUSINESS_INACTIVE',
          message: `Negocio inactivo (estado: ${err.status})`,
        });
        return;
      }
      if (err instanceof TenantNotReadyError) {
        res.status(503).json({
          code: 'BUSINESS_NOT_READY',
          message: 'La base de datos del negocio aún está siendo provisionada',
        });
        return;
      }
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Shutdown graceful — cerrar todos los pools
// ---------------------------------------------------------------------------

export async function closeTenantPools(): Promise<void> {
  const entries = Array.from(tenantPools.entries());
  tenantPools.clear();

  await Promise.allSettled(
    entries.map(async ([businessId, { pool }]) => {
      try {
        await pool.end();
      } catch (err) {
        console.error(
          `[tenant] Error al cerrar pool de ${businessId}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );

  console.log(`[tenant] ${entries.length} pool(s) de tenants cerrados correctamente.`);
}

// ---------------------------------------------------------------------------
// Errores específicos de tenant
// ---------------------------------------------------------------------------

export class TenantNotFoundError extends Error {
  constructor(businessId: string) {
    super(`Negocio no encontrado: ${businessId}`);
    this.name = 'TenantNotFoundError';
  }
}

export class TenantInactiveError extends Error {
  constructor(businessId: string, public readonly status: string) {
    super(`Negocio ${businessId} inactivo (estado: ${status})`);
    this.name = 'TenantInactiveError';
  }
}

export class TenantNotReadyError extends Error {
  constructor(businessId: string) {
    super(`BD del negocio ${businessId} aún en provisioning`);
    this.name = 'TenantNotReadyError';
  }
}
