/**
 * @file container.ts
 * @description Composition Root — infraestructura stateless y cross-tenant.
 *
 * ## Qué vive aquí y qué no
 *
 * ✅ VIVE EN EL CONTAINER (stateless / cross-tenant):
 * - getBusinessPlan: consulta la BD de plataforma (PLATFORM_DATABASE_URL).
 *
 * ❌ NO VIVE EN EL CONTAINER (requieren req.db del tenant):
 * - ReservationService, ProductService, CategoryService, ReportService
 * - Todos los SqlXxxRepository de entidades de negocio
 * - TransactionManager de tenant (ver src/db/tenant-context.ts)
 * - OutboxWorker por tenant (arrancado desde tenantMiddleware, fix C4)
 *
 * ## SSL
 *
 * Usa NEON_SSL=true (igual que pg.client.ts) en vez de NODE_ENV.
 * Agregá NEON_SSL=true en Render → Environment Variables.
 */

import { PlatformRepository } from './platform/platform.repository.js';
import { BusinessPlan }        from './types/enums.js';
import { SqlClient }           from './repositories/sql.client.js';
import { stripSslMode }        from './db/pg.client.js';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool compartido para PLATFORM_DATABASE_URL (BD central de la plataforma)
// ---------------------------------------------------------------------------

let _platformPool: InstanceType<typeof Pool> | null = null;

export function createPlatformPool(): SqlClient {
  const rawUrl = process.env.PLATFORM_DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      '[container] PLATFORM_DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }

  if (!_platformPool) {
    const connectionString = stripSslMode(rawUrl);
    _platformPool = new Pool({
      connectionString,
      max: 5,
      ssl: process.env.NEON_SSL === 'true' ? { rejectUnauthorized: true } : false,
    });
    _platformPool.on('error', (err) => {
      console.error('[platform] Error en pool central:', err.message);
    });
  }

  return {
    async query<T = unknown>(sql: string, params?: unknown[]) {
      const result = await _platformPool!.query(sql, params);
      const rowCount = result.rowCount ?? undefined;
      return {
        rows: result.rows as T[],
        ...(rowCount !== undefined && { rowCount }),
      };
    },
  };
}

export function getPlatformRawPool(): InstanceType<typeof Pool> {
  if (!_platformPool) {
    createPlatformPool();
  }
  return _platformPool!;
}

export async function closePlatformPool(): Promise<void> {
  if (_platformPool) {
    await _platformPool.end();
    _platformPool = null;
  }
}

// ---------------------------------------------------------------------------
// AppContainer — solo infraestructura stateless y cross-tenant
// ---------------------------------------------------------------------------

export interface AppContainer {
  getBusinessPlan: (businessId: string) => Promise<BusinessPlan>;
  mode: 'postgresql';
}

export async function createAppContainer(): Promise<AppContainer> {
  if (!process.env.PLATFORM_DATABASE_URL) {
    throw new Error(
      '[container] PLATFORM_DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }
  return createPostgresContainer();
}

async function createPostgresContainer(): Promise<AppContainer> {
  console.log('[container] 🐘 Modo PostgreSQL — conectando a PLATFORM_DATABASE_URL');

  const platformSqlClient  = createPlatformPool();
  const platformRepository = new PlatformRepository(platformSqlClient);

  /**
   * Obtiene el plan del negocio desde la BD de plataforma.
   *
   * Lanza un Error explícito si el negocio no existe, en vez de retornar
   * FREE silenciosamente.
   *
   * El caller debe capturar el error y responder 503 PLATFORM_UNAVAILABLE.
   */
  const getBusinessPlan = async (businessId: string): Promise<BusinessPlan> => {
    const business = await platformRepository.findById(businessId);

    if (!business) {
      throw new Error(
        `[getBusinessPlan] businessId "${businessId}" no encontrado en la BD de plataforma. ` +
        'Verificá que el negocio esté registrado correctamente y que el JWT contenga el business_id correcto.',
      );
    }

    return (business.plan ?? BusinessPlan.FREE) as BusinessPlan;
  };

  console.log('[container] ✅ PostgreSQL listo.');

  return {
    getBusinessPlan,
    mode: 'postgresql',
  };
}
