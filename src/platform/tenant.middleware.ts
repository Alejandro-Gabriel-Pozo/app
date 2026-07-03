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
 *
 * ## Pool cache
 * Los pools se cachean en memoria por business_id.
 * Un negocio activo tiene exactamente un pool durante la vida del proceso.
 * Si el proceso se reinicia (Render deploy), los pools se recrean lazy.
 *
 * ## Por qué no usar el pgClient global
 * El pgClient global apunta a la BD central (PLATFORM_DATABASE_URL).
 * Cada tenant tiene su propia BD — req.db apunta a ella.
 *
 * ## CUSTOMER y tenantMiddleware
 * Los JWTs de clientes (`role: CUSTOMER`) no llevan `business_id` — usan
 * `customer_id` en su lugar. Las rutas `/customer/*` se montan antes de
 * este middleware en `app.ts`, por lo que los requests de clientes no llegan
 * aquí en condiciones normales. Sin embargo, se agrega un guard explícito
 * para evitar un 401 silencioso si el orden de montaje cambiara en el futuro.
 */
 
import { Request, Response, NextFunction } from 'express';
import pg from 'pg';
import { SqlClient } from '../repositories/sql.client.js';
import { PlatformRepository } from './platform.repository.js';
import { decryptConnectionString } from './supabase.provisioner.js';
import { BusinessStatus, UserRole } from '../types/enums.js';
 
const { Pool } = pg;
 
// ---------------------------------------------------------------------------
// Pool cache — un pool por business_id
// ---------------------------------------------------------------------------
 
const tenantPools = new Map<string, SqlClient>();
 
/**
 * Obtiene (o crea) el SqlClient para un negocio.
 * Cachea los pools en memoria para no reconectar en cada request.
 */
async function getTenantClient(
  businessId: string,
  platformRepo: PlatformRepository,
): Promise<SqlClient> {
  // Cache hit
  const cached = tenantPools.get(businessId);
  if (cached) return cached;
 
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
 
  // Descifrar connection string
  const connectionString = await decryptConnectionString(business.dbUrlEncrypted);
 
  // Crear pool para este tenant
  const pool = new Pool({
    connectionString,
    max: 5, // Pool pequeño por tenant — ajustar según plan
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: { rejectUnauthorized: false },
  });
 
  pool.on('error', (err) => {
    console.error(`[tenant] Error en pool de ${businessId}:`, err.message);
    // Remover del cache para forzar reconexión en el próximo request
    tenantPools.delete(businessId);
  });
 
  const client: SqlClient = {
    async query(sql: string, params?: unknown[]) {
      const result = await pool.query(sql, params);
      return { rows: result.rows, rowCount: result.rowCount ?? undefined };
    },
  };
 
  tenantPools.set(businessId, client);
  return client;
}
 
// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
 
/**
 * Middleware que inyecta `req.db` con la conexión al tenant correcto.
 * Debe montarse DESPUÉS de `authenticate()`.
 *
 * Los requests con `role: CUSTOMER` se dejan pasar sin modificar —
 * sus rutas (`/customer/*`) no usan la BD del tenant y tienen su propio
 * pool. Ver nota en la cabecera del archivo.
 *
 * @param platformRepo - Repositorio de la BD central
 *
 * @example
 * ```ts
 * app.use('/api', authenticate());
 * app.use('/api', tenantMiddleware(platformRepo));
 * app.use('/api/reservations', createReservationsRouter(container));
 * ```
 */
export function tenantMiddleware(platformRepo: PlatformRepository) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Guard: CUSTOMER no usa tenant DB — pasa directo.
    // Sus rutas se montan antes de este middleware, pero si el orden cambia
    // esto evita un 401 por business_id ausente en el JWT de cliente.
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
      req.db = await getTenantClient(req.user.businessId, platformRepo);
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
 
/**
 * Cierra todos los pools de tenants activos.
 * Llamar en el shutdown del servidor (SIGTERM).
 */
export async function closeTenantPools(): Promise<void> {
  const count = tenantPools.size;
  tenantPools.clear();
  console.log(`[tenant] ${count} pools de tenants cerrados`);
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
