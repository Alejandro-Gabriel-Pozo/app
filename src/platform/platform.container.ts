/**
 * @file platform.container.ts
 * @description Composición de dependencias de la capa de plataforma.
 *
 * Completamente independiente de `AppContainer` (tenants). Se instancia
 * UNA vez al arrancar el servidor y se pasa al `createPlatformRouter`.
 *
 * En modo in-memory (sin PLATFORM_DATABASE_URL) devuelve null — las rutas
 * /platform/* responderán 503 Service Unavailable.
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
 * Retorna `null` si `PLATFORM_DATABASE_URL` no está definida.
 */
export function createPlatformContainer(): PlatformContainer | null {
  if (!process.env.PLATFORM_DATABASE_URL) {
    console.warn(
      '[platform-container] ⚠️  PLATFORM_DATABASE_URL no definida — ' +
      'rutas /platform/* deshabilitadas.',
    );
    return null;
  }

  const platformSqlClient = createPlatformPool();
  if (!platformSqlClient) return null;

  return {
    platformRepository:  new PlatformRepository(platformSqlClient),
    platformAuthService: new PlatformAuthService(),
  };
}
