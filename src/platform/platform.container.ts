/**
 * @file platform.container.ts
 * @description Composición de dependencias de la capa de plataforma.
 *
 * Completamente independiente de `AppContainer` (tenants). Se instancia
 * UNA vez al arrancar el servidor y se pasa al `createPlatformRouter`.
 *
 * PLATFORM_DATABASE_URL siempre es requerida — la app es exclusivamente multi-tenant.
 */

import { PlatformRepository } from './platform.repository.js';
import { PlatformAuthService } from './platform.auth.service.js';
import { PlatformAuditLogRepository } from './platform-audit-log.repository.js';
import { createPlatformPool, buildPlatformTransactionManager } from '../container.js';

export interface PlatformContainer {
  platformRepository: PlatformRepository;
  platformAuthService: PlatformAuthService;
  /**
   * Rastro de las acciones de SUPERADMIN (28/08/2026, Fase 2 del plan de
   * dominios). Comparte el MISMO SqlClient que `platformRepository`: las dos
   * escriben en la BD de plataforma y tienen que poder ir en una sola
   * transacción (DEFENSIVE_DEVELOPING §3 — nunca mezclar con un pool de
   * tenant, `audit_log` del tenant es otra tabla en otra base).
   */
  platformAuditLogRepository: PlatformAuditLogRepository;
}

/**
 * Crea el container de plataforma.
 * Lanza error si `PLATFORM_DATABASE_URL` no está definida.
 */
export function createPlatformContainer(): PlatformContainer {
  const platformSqlClient = createPlatformPool();

  return {
    platformRepository:         new PlatformRepository(platformSqlClient, buildPlatformTransactionManager()),
    platformAuthService:        new PlatformAuthService(),
    platformAuditLogRepository: new PlatformAuditLogRepository(platformSqlClient),
  };
}
