/**
 * @file tenant-context.ts
 * @description Builders únicos para infraestructura que necesita el pool raw del tenant.
 *
 * ## Por qué existe este archivo
 *
 * PgTransactionManager necesita un `pg.Pool` real (no el SqlClient wrapper)
 * para poder abrir conexiones con `pool.connect()` y gestionar BEGIN/COMMIT.
 *
 * El problema histórico (hallazgo #1 del code review 2026-08-08):
 * Los routers instanciaban `new PgTransactionManager(getPlatformRawPool())`
 * directamente, pasando el pool de PLATFORM_DATABASE_URL en vez del pool
 * del tenant. Eso significa que el chequeo FOR UPDATE y el INSERT de la
 * reserva corrían en la BD de plataforma (que no tiene esas tablas), no en
 * la BD del tenant.
 *
 * ## La solución
 *
 * Este archivo es el único lugar autorizado para construir un
 * `PgTransactionManager` para rutas de tenant. Todos los routers deben
 * llamar una de las dos funciones exportadas:
 *
 * - `buildTenantTransactionManager(req)` — para handlers que ya pasaron
 *   por `tenantMiddleware` y tienen `req.businessId` disponible.
 *   Usado por reservations, orders y cualquier router "staff".
 *
 * - `buildTransactionManagerFromPool(pool)` — para callers que ya
 *   resolvieron el pool del tenant por sus propios medios (ej. rutas
 *   públicas de `customer.routes.ts` que usan `resolveTenantBySlug` o
 *   `getTenantRawPool` directamente, sin pasar por `tenantMiddleware`).
 *
 * ## Uso — req-first (rutas de staff/tenant)
 *
 * ```ts
 * import { buildTenantTransactionManager } from '../../db/tenant-context.js';
 *
 * function buildReservationService(req: Request): ReservationService {
 *   return new ReservationService(
 *     new SqlReservationRepository(req.db),
 *     // ...
 *     buildTenantTransactionManager(req),  // ← req ya tiene businessId
 *   );
 * }
 * ```
 *
 * ## Uso — pool-first (rutas públicas de customer)
 *
 * ```ts
 * import { buildTransactionManagerFromPool } from '../../db/tenant-context.js';
 *
 * function buildService(client: SqlClient, tenantPool: pg.Pool) {
 *   return new ReservationService(
 *     new SqlReservationRepository(client),
 *     // ...
 *     buildTransactionManagerFromPool(tenantPool),  // ← pool ya resuelto
 *   );
 * }
 * ```
 */

import type { Request }              from 'express';
import type pg                  from 'pg';
import { PgTransactionManager } from './pg.transaction-manager.js';
import { getTenantRawPool }     from '../platform/tenant.middleware.js';

/**
 * Construye un PgTransactionManager usando el pool raw del tenant activo.
 *
 * Requiere que tenantMiddleware ya haya corrido (req.businessId disponible).
 * Lanza error explícito si no hay businessId — falla rápido en vez de
 * silenciosamente usar el pool equivocado.
 *
 * @param req - Request de Express con req.businessId inyectado por tenantMiddleware.
 */
export function buildTenantTransactionManager(req: Request): PgTransactionManager {
  const businessId = req.businessId;
  if (!businessId) {
    throw new Error(
      '[tenant-context] buildTenantTransactionManager: req.businessId no está disponible. ' +
      'Asegurate de que tenantMiddleware corre antes de este handler.',
    );
  }
  const tenantPool = getTenantRawPool(businessId);
  return new PgTransactionManager(tenantPool);
}

/**
 * Construye un PgTransactionManager a partir de un pg.Pool ya resuelto.
 *
 * Usar cuando el caller ya obtuvo el pool del tenant por sus propios medios
 * (ej. `resolveTenantBySlug` en rutas públicas de customer, o
 * `getTenantRawPool` en rutas autenticadas de customer que no pasan por
 * tenantMiddleware). Evita el overhead de resolver el businessId de nuevo.
 *
 * @param pool - Pool de pg del tenant, ya inicializado y cacheado.
 */
export function buildTransactionManagerFromPool(pool: pg.Pool): PgTransactionManager {
  return new PgTransactionManager(pool);
}
