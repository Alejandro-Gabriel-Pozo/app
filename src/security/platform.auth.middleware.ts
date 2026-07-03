/**
 * @file platform.auth.middleware.ts
 * @description Middleware de autenticación para rutas de plataforma (/platform/*).
 *
 * Completamente independiente del stack por-tenant (authenticate/authorize).
 * Valida JWTs emitidos por PlatformAuthService y verifica PlatformRole.
 *
 * ## Uso
 * ```typescript
 * import { requirePlatformRole } from '../../security/platform.auth.middleware.js';
 * import { PlatformRole } from '../../types/enums.js';
 *
 * router.use(requirePlatformRole(PlatformRole.SUPERADMIN));
 * ```
 *
 * ## JWT esperado
 * El token debe contener:
 * - `sub`          — ID del usuario de plataforma
 * - `platformRole` — valor del enum PlatformRole
 * - `iat`, `exp`   — emitido y expiración estándar
 *
 * El secreto usado para firmar/verificar debe estar en PLATFORM_JWT_SECRET.
 * Distinto de JWT_SECRET para separar los contextos de autenticación.
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PlatformRole } from '../types/enums.js';

// ---------------------------------------------------------------------------
// Extensión del tipo Request para tipado del usuario de plataforma
// ---------------------------------------------------------------------------

declare global {
  namespace Express {
    interface Request {
      /** Usuario de plataforma autenticado (solo en rutas /platform/*) */
      platformUser?: {
        id: string;
        platformRole: PlatformRole;
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Verificación de JWT (implementación nativa — sin dependencias)
// ---------------------------------------------------------------------------

interface PlatformTokenPayload {
  sub: string;
  platformRole: PlatformRole;
  iat: number;
  exp: number;
}

/**
 * Verifica un JWT HS256 usando PLATFORM_JWT_SECRET.
 * Retorna el payload si el token es válido, lanza Error si no.
 */
function verifyPlatformToken(token: string): PlatformTokenPayload {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (!secret) {
    throw new Error('[platform-auth] PLATFORM_JWT_SECRET no está definida');
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Token malformado');
  }

  const [headerB64, payloadB64, signatureB64] = parts;

  // Verificar firma con timing-safe compare
  const expectedSig = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest('base64url');

  const sigBuffer = Buffer.from(signatureB64, 'base64url');
  const expectedBuffer = Buffer.from(expectedSig, 'base64url');

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    throw new Error('Firma inválida');
  }

  // Decodificar payload
  const payload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8'),
  ) as PlatformTokenPayload;

  // Verificar expiración
  const nowSec = Math.floor(Date.now() / 1000);
  if (payload.exp < nowSec) {
    throw new Error('Token expirado');
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Middleware que verifica el JWT de plataforma y exige el rol indicado.
 *
 * Extrae el token del header `Authorization: Bearer <token>`.
 * Adjunta `req.platformUser` para uso en los handlers.
 *
 * @param requiredRole - Rol mínimo requerido (actualmente solo SUPERADMIN)
 */
export function requirePlatformRole(
  requiredRole: PlatformRole,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Se requiere token de plataforma',
      });
      return;
    }

    const token = authHeader.slice(7);

    let payload: PlatformTokenPayload;
    try {
      payload = verifyPlatformToken(token);
    } catch (err) {
      res.status(401).json({
        code: 'INVALID_TOKEN',
        message: (err as Error).message,
      });
      return;
    }

    if (payload.platformRole !== requiredRole) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `Se requiere rol de plataforma: ${requiredRole}`,
      });
      return;
    }

    req.platformUser = {
      id: payload.sub,
      platformRole: payload.platformRole,
    };

    next();
  };
}
