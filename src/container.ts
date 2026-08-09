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
 * ## Por qué se removió transactionManager y outboxWorker del container
 *
 * transactionManager: construido sobre getPlatformRawPool() apuntaba a
 * PLATFORM_DATABASE_URL. Los repos de reservas/órdenes usan req.db (tenant).
 * Correr el FOR UPDATE y el INSERT en BDs distintas rompe el aislamiento.
 * La solución es buildTenantTransactionManager(req) en tenant-context.ts.
 *
 * outboxWorker: construido sobre platformSqlClient, nunca encontraba filas.
 * Los domain events se escriben en la BD del tenant. La solución es
 * ensureTenantWorker(businessId, req.db) en outbox.registry.ts, llamado
 * desde tenantMiddleware (fix C4).
 *
 * Estos se construyen por request en cada router mediante funciones
 * buildXxxService(req) que reciben req.db (SqlClient del tenant
 * inyectado por tenantMiddleware). Ver reservations.routes.ts y
 * products.routes.ts como referencia del patrón.
 */

import { PlatformRepository } from './platform/platform.repository.js';
import { BusinessPlan }        from './types/enums.js';
import { SqlClient }           from './repositories/sql.client.js';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool compartido para PLATFORM_DATABASE_URL (BD central de la plataforma)
// ---------------------------------------------------------------------------

let _platformPool: InstanceType<typeof Pool> | null = null;

export function createPlatformPool(): SqlClient {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (!url) {
    throw new Error(
      '[container] PLATFORM_DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }

  if (!_platformPool) {
    _platformPool = new Pool({
      connectionString: url,
      max: 5,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: true } : false,
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
    // Trigger pool creation via createPlatformPool
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

  const getBusinessPlan = async (businessId: string): Promise<BusinessPlan> => {
    const business = await platformRepository.findById(businessId);
    return (business?.plan ?? BusinessPlan.FREE) as BusinessPlan;
  };

  console.log('[container] ✅ PostgreSQL listo.');

  return {
    getBusinessPlan,
    mode: 'postgresql',
  };
}
