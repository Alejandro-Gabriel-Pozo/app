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
 * llamar `buildTenantTransactionManager(req)` en vez de instanciar
 * `PgTransactionManager` ni llamar `getPlatformRawPool()` directamente.
 *
 * Si en el futuro alguien agrega un router nuevo y olvida esto, el error
 * es explícito: getTenantRawPool lanza con un mensaje claro si el pool
 * del tenant no está en cache.
 *
 * ## Uso
 *
 * ```ts
 * import { buildTenantTransactionManager } from '../../db/tenant-context.js';
 *
 * function buildReservationService(req: Request): ReservationService {
 *   return new ReservationService(
 *     new SqlReservationRepository(req.db),
 *     // ...
 *     buildTenantTransactionManager(req),  // ← siempre así
 *   );
 * }
 * ```
 */

import { Request }              from 'express';
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
