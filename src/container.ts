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
import type { PlanLimits }     from './config/plan-limits.js';
import type { ModuleGate }     from './business-context/business-context.types.js';
export type { ModuleGate };
import type { SqlClient }           from './repositories/sql.client.js';
import { stripSslMode, sslConfig } from './db/pg.client.js';
import { PgTransactionManager } from './db/pg.transaction-manager.js';
import type { TransactionManager } from './db/transaction-manager.js';
import { logger } from './logger.js';
import { requirePlatformDatabaseUrl, getPlatformDatabaseUrl } from './config/env.js';
import pg from 'pg';

const { Pool } = pg;

// ---------------------------------------------------------------------------
// Pool compartido para PLATFORM_DATABASE_URL (BD central de la plataforma)
// ---------------------------------------------------------------------------

let _platformPool: InstanceType<typeof Pool> | null = null;

export function createPlatformPool(): SqlClient {
  const rawUrl = requirePlatformDatabaseUrl();

  if (!_platformPool) {
    const connectionString = stripSslMode(rawUrl);
    _platformPool = new Pool({
      connectionString,
      max: 5,
      ssl: sslConfig(),
      // Sin esto, `pg` espera indefinidamente si la BD de plataforma no
      // responde (default de la librería: sin timeout). Encontrado al
      // blindar A4 (pendientes-2026-08-14.md): migrate:tenants pasó a
      // correr en cada build de Render, y sin timeout acá un Neon caído
      // colgaría el build para siempre, bloqueando todo deploy futuro.
      // Mismo valor que ya usa applyTenantSchema() por tenant.
      connectionTimeoutMillis: 10_000,
    });
    _platformPool.on('error', (err) => {
      logger.error({ err: err.message }, '[platform] Error en pool central');
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

/**
 * TransactionManager sobre la BD de PLATAFORMA (Bug #5, 27/08/2026). Lo exige
 * `PlatformRepository` para las escrituras multi-tabla (createBusiness,
 * createRole, updateRolePermissionGroups, updatePlanLimits,
 * updateRolePresetPermissionGroups) — antes iban en conexiones sueltas del
 * pool sin BEGIN/COMMIT. Usa el pool crudo de plataforma (PgTransactionManager
 * necesita el pool, no el wrapper SqlClient), NUNCA un pool de tenant
 * (DEFENSIVE_DEVELOPING §3).
 */
export function buildPlatformTransactionManager(): TransactionManager {
  return new PgTransactionManager(getPlatformRawPool());
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
  getBusinessModules: (businessId: string) => Promise<Record<string, boolean>>;
  getBusinessModuleGates: (businessId: string) => Promise<Record<string, ModuleGate>>;
  getPlanLimits: (plan: BusinessPlan) => Promise<PlanLimits>;
  mode: 'postgresql';
}

export async function createAppContainer(): Promise<AppContainer> {
  if (!getPlatformDatabaseUrl()) {
    throw new Error(
      '[container] PLATFORM_DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }
  return createPostgresContainer();
}

async function createPostgresContainer(): Promise<AppContainer> {
  logger.info('[container] Modo PostgreSQL — conectando a PLATFORM_DATABASE_URL');

  const platformSqlClient  = createPlatformPool();
  const platformRepository = new PlatformRepository(platformSqlClient, buildPlatformTransactionManager());

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

  /**
   * Entitlements del negocio (qué módulos tiene habilitados), desde la BD
   * de plataforma. Mismo contrato de error que getBusinessPlan: lanza si el
   * negocio no existe, en vez de devolver "todo deshabilitado" en silencio
   * — el caller debe distinguir "negocio inexistente" (503) de "módulo
   * deshabilitado" (402), y solo platformRepository.getBusinessModules
   * sabe cuál de los dos es.
   */
  const getBusinessModules = async (businessId: string): Promise<Record<string, boolean>> => {
    const business = await platformRepository.findById(businessId);

    if (!business) {
      throw new Error(
        `[getBusinessModules] businessId "${businessId}" no encontrado en la BD de plataforma. ` +
        'Verificá que el negocio esté registrado correctamente y que el JWT contenga el business_id correcto.',
      );
    }

    return platformRepository.getBusinessModules(businessId);
  };

  /**
   * Igual que getBusinessModules pero conservando el PORQUÉ de cada gate
   * (`restrictedBy` / `origin`) — lo consume `requireModule` para el body
   * del `402` y el log estructurado. Mismo contrato de error: lanza si el
   * negocio no existe (→ 503), distinto de "módulo deshabilitado" (→ 402).
   */
  const getBusinessModuleGates = async (businessId: string): Promise<Record<string, ModuleGate>> => {
    const business = await platformRepository.findById(businessId);

    if (!business) {
      throw new Error(
        `[getBusinessModuleGates] businessId "${businessId}" no encontrado en la BD de plataforma. ` +
        'Verificá que el negocio esté registrado correctamente y que el JWT contenga el business_id correcto.',
      );
    }

    return platformRepository.getBusinessModuleGates(businessId);
  };

  /**
   * Límites de uso del plan (18/08/2026, deuda estructural — reemplaza la
   * constante TS `PLAN_LIMITS`, ver platform.schema.sql BLOQUE PLAN_LIMITS).
   * Mismo contrato de error que getBusinessPlan/getBusinessModules: lanza
   * si el plan no tiene fila en `plan_limits` en vez de aplicar un límite
   * por default en silencio — un plan sin config es un error de
   * plataforma, no "sin restricciones".
   */
  const getPlanLimits = async (plan: BusinessPlan): Promise<PlanLimits> => {
    const limits = await platformRepository.getPlanLimits(plan);

    if (!limits) {
      throw new Error(
        `[getPlanLimits] plan "${plan}" no tiene límites configurados en la BD de plataforma (tabla plan_limits). ` +
        'Verificá el seed de platform.schema.sql BLOQUE PLAN_LIMITS.',
      );
    }

    return limits;
  };

  logger.info('[container] PostgreSQL listo.');

  return {
    getBusinessPlan,
    getBusinessModules,
    getBusinessModuleGates,
    getPlanLimits,
    mode: 'postgresql',
  };
}
