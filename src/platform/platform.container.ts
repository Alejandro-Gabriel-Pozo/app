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
import { PlatformAuthService } from '../security/platform.auth.service.js';
import { createPlatformPool } from '../container.js';

export interface PlatformContainer {
  platformRepository: PlatformRepository;
  platformAuthService: PlatformAuthService;
}

/**
 * Crea el container de plataforma.
 * Lanza error si `PLATFORM_DATABASE_URL` no está definida.
 */
export function createPlatformContainer(): PlatformContainer {
  const platformSqlClient = createPlatformPool();

  return {
    platformRepository:  new PlatformRepository(platformSqlClient),
    platformAuthService: new PlatformAuthService(),
  };
}
