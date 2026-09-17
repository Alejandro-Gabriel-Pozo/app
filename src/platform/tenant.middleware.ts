/**
 * @file tenant.middleware.ts
 * @description Resuelve la conexión a la BD correcta para cada request.
 *
 * ## Flujo
 * 0. Un token CUSTOMER se rechaza acá con 403 -- este middleware es SOLO
 *    para rutas de staff (P-01/D-03, Wave 2, 16/09/2026). El portal de
 *    cliente resuelve su propio tenant dentro de customer.routes.ts, mount
 *    anterior a este middleware en app.ts.
 * 1. Lee `req.user.businessId` (inyectado por authenticate())
 * 2. Busca el negocio en la BD central → obtiene db_url_encrypted
 * 2b. Compara business.schema_version contra CURRENT_SCHEMA_VERSION
 *     (tenant-db.setup.ts) — solo warn-only por ahora, ver comentario
 *     junto al chequeo en getTenantClient(). Solo corre al crear el pool
 *     (cache miss), no en cada request.
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
 * La config SSL (`sslConfig()`) se importa de pg.client.ts — misma fuente
 * que usan el pool de plataforma (container.ts) y el legado. Antes este
 * archivo tenía su propia función con un fallback distinto
 * (`{ rejectUnauthorized: false }` en vez de `false`), que dejaba SSL
 * activo sin validar certificado — vulnerable a MITM — pese a decir en
 * un comentario que era "consistente con pg.client.ts".
 */

import type { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import type { SqlClient } from '../repositories/sql.client.js';
import type { PlatformRepository } from './platform.repository.js';
import { decryptConnectionString, CURRENT_SCHEMA_VERSION } from './tenant-db.setup.js';
import { BusinessStatus, UserRole } from '../types/enums.js';
import { ensureTenantWorker, stopTenantWorker } from '../workers/outbox.registry.js';
import { stripSslMode, sslConfig } from '../db/pg.client.js';
import { logger } from '../logger.js';
import { getMaxTenantPools } from '../config/env.js';

const { Pool } = pg;
type PgPool = InstanceType<typeof Pool>;

// ---------------------------------------------------------------------------
// Pool cache
//
// LRU real: al llegar a MAX_TENANT_POOLS, el pool (+ su worker de outbox)
// menos usado recientemente se cierra ANTES de abrir uno nuevo. Antes de
// este cambio, el límite solo emitía un warning y seguía creando pools sin
// techo — en un proceso long-running (Render) eso es una fuga de conexiones
// pg y de timers de 5s (uno por OutboxWorker) que nunca se libera sola.
// ---------------------------------------------------------------------------

interface TenantPoolEntry {
  client:     SqlClient;
  pool:       PgPool;
  lastUsedAt: number;
}

const MAX_TENANT_POOLS = getMaxTenantPools();
const tenantPools = new Map<string, TenantPoolEntry>();

// ---------------------------------------------------------------------------
// Pool lifecycle
// ---------------------------------------------------------------------------

export async function getTenantClient(
  businessId: string,
  platformRepo: PlatformRepository,
): Promise<SqlClient> {
  const cached = tenantPools.get(businessId);
  if (cached) {
    cached.lastUsedAt = Date.now();
    return cached.client;
  }

  const business = await platformRepo.findById(businessId);

  if (!business)              throw new TenantNotFoundError(businessId);
  if (business.status !== BusinessStatus.ACTIVE) throw new TenantInactiveError(businessId, business.status);
  if (!business.dbUrlEncrypted) throw new TenantNotReadyError(businessId);

  // Chequeo fail-SOFT (a propósito): solo advierte, no bloquea la request.
  // Hoy la mayoría de los negocios activos tiene schema_version = NULL
  // (nunca pasaron por applyTenantSchema — ver 0.1 en la auditoría de deuda
  // estructural), así que un fail-fast real acá tumbaría tráfico real hasta
  // correr `npm run migrate:tenants` sobre toda la flota. Subir esto a
  // fail-fast (lanzar en vez de solo loguear) es un paso deliberado
  // posterior, una vez confirmado que todos los tenants activos ya fueron
  // migrados al menos una vez.
  if (business.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    logger.warn(
      { businessId, schemaVersion: business.schemaVersion, currentSchemaVersion: CURRENT_SCHEMA_VERSION },
      `[tenant] ${businessId}: schema_version=${business.schemaVersion ?? 'null'} ` +
      `≠ CURRENT_SCHEMA_VERSION=${CURRENT_SCHEMA_VERSION}. Corré \`npm run migrate:tenants\`.`,
    );
  }

  // Descifrar y limpiar ?sslmode para evitar conflictos con el objeto ssl:
  const rawConnectionString = await decryptConnectionString(business.dbUrlEncrypted);
  const connectionString    = stripSslMode(rawConnectionString);

  const pool = new Pool({
    connectionString,
    max:                    5,
    idleTimeoutMillis:      30_000,
    connectionTimeoutMillis: 5_000,
    ssl: sslConfig(),
  });

  pool.on('error', (err) => {
    logger.error({ err: err.message, businessId }, '[tenant] Error en pool');
    tenantPools.delete(businessId);
    void stopTenantWorker(businessId);
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
    const lruBusinessId = findLeastRecentlyUsed();
    if (lruBusinessId) {
      logger.warn(
        { maxTenantPools: MAX_TENANT_POOLS, evicted: lruBusinessId, businessId },
        '[tenant] Límite de pools alcanzado. Desalojando el menos usado.',
      );
      await evictTenantPool(lruBusinessId);
    }
  }

  tenantPools.set(businessId, { client, pool, lastUsedAt: Date.now() });
  return client;
}

function findLeastRecentlyUsed(): string | undefined {
  let oldestId: string | undefined;
  let oldestAt = Infinity;
  for (const [id, entry] of tenantPools) {
    if (entry.lastUsedAt < oldestAt) {
      oldestAt = entry.lastUsedAt;
      oldestId = id;
    }
  }
  return oldestId;
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

/**
 * Cierra el pool de un tenant y detiene su OutboxWorker. Se usa tanto para
 * la invalidación manual (ej. admin.routes.ts tras cambiar la URL de la BD)
 * como para el desalojo automático por LRU en getTenantClient().
 */
export async function evictTenantPool(businessId: string): Promise<void> {
  const entry = tenantPools.get(businessId);
  if (!entry) return;
  tenantPools.delete(businessId);

  await stopTenantWorker(businessId);

  try {
    await entry.pool.end();
    logger.info({ businessId }, '[tenant] Pool invalidado.');
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : err, businessId },
      '[tenant] Error al cerrar pool',
    );
  }
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export function tenantMiddleware(platformRepo: PlatformRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // P-01/D-03 (Wave 2, 16/09/2026): un token CUSTOMER nunca debería llegar
    // hasta acá -- el portal de cliente resuelve su propio tenant en
    // customer.routes.ts (mount ANTES de este middleware, app.ts) sin pasar
    // por req.db/req.businessId de tenantMiddleware. Si un token CUSTOMER SÍ
    // llega hasta acá, es porque está pegándole a una ruta de STAFF (todo lo
    // que se monta DESPUÉS de este middleware en app.ts) -- antes esto hacía
    // next() sin fijar req.db/req.businessId, dejando pasar el request hasta
    // el handler de la ruta de staff, que crasheaba con un 500 accidental
    // (deref de `undefined` o throw de buildTenantTransactionManager) en vez
    // de un 403 deliberado -- el hallazgo real de D-03 (Fase 15): CUSTOMER
    // satisface Roles.BOOKING y alcanzaba 4 rutas mutantes de staff sin
    // ningún guard de ownership. Rechazar acá es por ACTOR (cualquier ruta
    // de staff, sin importar el archivo) y no por archivo, como pedía la
    // decisión del dueño (docs/decisiones-plan-integral-2026-09-16.md,
    // P-01/D-03) -- corrige el criterio de cierre del Hueco 1 original del
    // ADR de RBAC, que cerró por archivo (customer.routes.ts) y grupo
    // (CUSTOMER_ONLY), no por actor.
    if (req.user?.role === UserRole.CUSTOMER) {
      res.status(403).json({
        code:    'FORBIDDEN',
        message: 'Un token del portal de clientes no puede acceder a rutas de staff.',
      });
      return;
    }

    if (!req.user?.businessId) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token no contiene business_id' });
      return;
    }

    try {
      req.db         = await getTenantClient(req.user.businessId, platformRepo);
      req.businessId = req.user.businessId;
      ensureTenantWorker(req.user.businessId, req.db, getTenantRawPool(req.user.businessId), platformRepo);
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
        logger.error({ err: err instanceof Error ? err.message : err, businessId }, '[tenant] Error cerrando pool');
      }
    }),
  );
  logger.info({ count: entries.length }, '[tenant] Pools cerrados.');
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
