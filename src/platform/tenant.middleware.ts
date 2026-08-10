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
 * 7. Arranca un OutboxWorker por tenant si aún no existe
 *
 * ## SSL y Neon
 * La connection string descifrada puede incluir ?sslmode=require.
 * Se elimina antes de crear el pool con stripSslMode() (importado de pg.client)
 * para evitar el warning de Neon:
 *   "SSL modes 'require' are treated as aliases for 'verify-full'"
 * La variable NEON_SSL=true controla si se valida el certificado completo.
 * Consistente con pg.client.ts.
 */

import { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { SqlClient } from '../repositories/sql.client.js';
import { PlatformRepository } from './platform.repository.js';
import { decryptConnectionString } from './supabase.provisioner.js';
import { BusinessStatus, UserRole } from '../types/enums.js';
import { ensureTenantWorker } from '../workers/outbox.registry.js';
import { stripSslMode } from '../db/pg.client.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

// ---------------------------------------------------------------------------
// Pool cache
// ---------------------------------------------------------------------------

interface TenantPoolEntry {
  client: SqlClient;
  pool:   PgPool;
}

const MAX_TENANT_POOLS = parseInt(process.env.MAX_TENANT_POOLS ?? '200', 10);
const tenantPools = new Map<string, TenantPoolEntry>();

// ---------------------------------------------------------------------------
// SSL config — misma lógica que pg.client.ts
// ---------------------------------------------------------------------------

function tenantSslConfig(): pg.PoolConfig['ssl'] {
  return process.env.NEON_SSL === 'true'
    ? { rejectUnauthorized: true }
    : { rejectUnauthorized: false };
}

// ---------------------------------------------------------------------------
// Pool lifecycle
// ---------------------------------------------------------------------------

export async function getTenantClient(
  businessId: string,
  platformRepo: PlatformRepository,
): Promise<SqlClient> {
  const cached = tenantPools.get(businessId);
  if (cached) return cached.client;

  const business = await platformRepo.findById(businessId);

  if (!business)              throw new TenantNotFoundError(businessId);
  if (business.status !== BusinessStatus.ACTIVE) throw new TenantInactiveError(businessId, business.status);
  if (!business.dbUrlEncrypted) throw new TenantNotReadyError(businessId);

  // Descifrar y limpiar ?sslmode para evitar conflictos con el objeto ssl:
  const rawConnectionString = await decryptConnectionString(business.dbUrlEncrypted);
  const connectionString    = stripSslMode(rawConnectionString);

  const pool = new Pool({
    connectionString,
    max:                    5,
    idleTimeoutMillis:      30_000,
    connectionTimeoutMillis: 5_000,
    ssl: tenantSslConfig(),
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

  if (tenantPools.size >= MAX_TENANT_POOLS) {
    console.warn(
      `[tenant] ⚠️  Límite de pools alcanzado (${MAX_TENANT_POOLS}). ` +
      `Tenants activos: ${tenantPools.size + 1}. ` +
      'Considerar LRU o aumentar MAX_TENANT_POOLS.',
    );
  }

  tenantPools.set(businessId, { client, pool });
  return client;
}

export function getTenantRawPool(businessId: string): PgPool {
  const entry = tenantPools.get(businessId);
  if (!entry) {
    throw new Error(
      `[tenant] getTenantRawPool: no hay pool cacheado para "${businessId}". ` +
      'Llamar solo después de que tenantMiddleware haya resuelto req.db.',
    );
  }
  return entry.pool;
}

export async function evictTenantPool(businessId: string): Promise<void> {
  const entry = tenantPools.get(businessId);
  if (!entry) return;
  tenantPools.delete(businessId);
  try {
    await entry.pool.end();
    console.log(`[tenant] Pool de ${businessId} invalidado.`);
  } catch (err) {
    console.error(
      `[tenant] Error al cerrar pool de ${businessId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function tenantMiddleware(platformRepo: PlatformRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (req.user?.role === UserRole.CUSTOMER) {
      next();
      return;
    }

    if (!req.user?.businessId) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token no contiene business_id' });
      return;
    }

    try {
      req.db         = await getTenantClient(req.user.businessId, platformRepo);
      req.businessId = req.user.businessId;
      ensureTenantWorker(req.user.businessId, req.db);
      next();
    } catch (err) {
      if (err instanceof TenantNotFoundError) {
        res.status(404).json({ code: 'BUSINESS_NOT_FOUND', message: 'Negocio no encontrado' });
        return;
      }
      if (err instanceof TenantInactiveError) {
        res.status(403).json({ code: 'BUSINESS_INACTIVE', message: `Negocio inactivo (estado: ${err.status})` });
        return;
      }
      if (err instanceof TenantNotReadyError) {
        res.status(503).json({ code: 'BUSINESS_NOT_READY', message: 'BD en provisioning' });
        return;
      }
      next(err);
    }
  };
}

// ---------------------------------------------------------------------------
// Shutdown graceful
// ---------------------------------------------------------------------------

export async function closeTenantPools(): Promise<void> {
  const entries = Array.from(tenantPools.entries());
  tenantPools.clear();
  await Promise.allSettled(
    entries.map(async ([businessId, { pool }]) => {
      try {
        await pool.end();
      } catch (err) {
        console.error(`[tenant] Error cerrando pool de ${businessId}:`, err instanceof Error ? err.message : err);
      }
    }),
  );
  console.log(`[tenant] ${entries.length} pool(s) cerrados.`);
}

// ---------------------------------------------------------------------------
// Errores
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
