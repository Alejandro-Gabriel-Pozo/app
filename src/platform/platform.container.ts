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
import { platformPgClient } from '../db/platform.pg.client.js';

export interface PlatformContainer {
  platformRepository: PlatformRepository;
  platformAuthService: PlatformAuthService;
}

/**
 * Crea el container de plataforma.
 * Retorna `null` si `PLATFORM_DATABASE_URL` no está definida
 * (p. ej. en desarrollo local con modo in-memory).
 */
export function createPlatformContainer(): PlatformContainer | null {
  // platformPgClient ya se conecta contra PLATFORM_DATABASE_URL
  // Si no existe, pg lanzará error al primer query — no al construir el client
  if (!process.env.PLATFORM_DATABASE_URL) {
    console.warn(
      '[platform-container] ⚠️  PLATFORM_DATABASE_URL no definida — ' +
      'rutas /platform/* deshabilitadas.',
    );
    return null;
  }

  return {
    platformRepository:  new PlatformRepository(platformPgClient),
    platformAuthService: new PlatformAuthService(),
  };
}
