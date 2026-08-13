/**
 * @file platform.auth.middleware.ts
 * @description Autenticación y autorización para rutas /platform/*.
 *
 * Usa una clave JWT separada (PLATFORM_JWT_SECRET) para aislar completamente
 * los tokens de SUPERADMIN de los tokens de empleados/clientes de cada tenant.
 *
 * ## Variables de entorno requeridas
 * - PLATFORM_JWT_SECRET  — clave secreta exclusiva para tokens de plataforma (min 32 chars)
 * - PLATFORM_JWT_EXPIRES_IN — duración del token en segundos (default: 3600 = 1 hora)
 *
 * ## Por qué una clave separada
 * - Un token de empleado comprometido no puede usarse en /platform/*
 * - Un token de SUPERADMIN no puede usarse en rutas de tenant
 * - Permite rotar cada clave independientemente
 *
 * ## signToken/verifyToken importados de auth.middleware.ts
 * No rompe el aislamiento de arriba: son genéricos en el payload y reciben
 * el secret como parámetro, así que acá se usan con `PLATFORM_JWT_SECRET`
 * — la separación de claves sigue intacta, solo se reusa el algoritmo de
 * firma/verificación HMAC (antes reimplementado acá desde cero, jscpd C6).
 */

import { Request, Response, NextFunction } from 'express';
import { PlatformRole } from '../types/enums.js';
import { signToken, verifyToken } from './auth.middleware.js';

export interface PlatformJwtPayload {
  sub: string;
  role: PlatformRole;
  email: string;
  iat: number;
  exp: number;
}

export interface AuthenticatedPlatformUser {
  id: string;
  email: string;
  role: PlatformRole;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      platformUser?: AuthenticatedPlatformUser;
    }
  }
}

function getPlatformJwtSecret(): string {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (!secret) throw new Error('[platform.auth] PLATFORM_JWT_SECRET no está definida.');
  if (secret.length < 32) throw new Error('[platform.auth] PLATFORM_JWT_SECRET debe tener al menos 32 caracteres.');
  return secret;
}

export function signPlatformToken(
  payload: Omit<PlatformJwtPayload, 'iat' | 'exp'>,
  expiresIn = 3_600,
): string {
  return signToken(payload, getPlatformJwtSecret(), expiresIn);
}

function verifyPlatformToken(token: string): PlatformJwtPayload {
  return verifyToken<Omit<PlatformJwtPayload, 'iat' | 'exp'>>(token, getPlatformJwtSecret());
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------

/**
 * Verifica el Bearer token de plataforma y adjunta `req.platformUser`.
 * Usa PLATFORM_JWT_SECRET — completamente separado de JWT_SECRET de tenants.
 */
export function authenticatePlatform() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Se requiere header Authorization: Bearer <token>',
      });
      return;
    }

    const token = authHeader.slice(7);
    try {
      const payload = verifyPlatformToken(token);
      req.platformUser = { id: payload.sub, email: payload.email, role: payload.role };
      next();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'JWT_ERROR';
      if (code === 'JWT_EXPIRED') {
        res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'El token ha expirado' });
        return;
      }
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token inválido' });
    }
  };
}

/**
 * Verifica que `req.platformUser.role` esté en los roles permitidos.
 * Siempre va después de `authenticatePlatform()`.
 */
export function authorizePlatform(allowedRoles: readonly PlatformRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.platformUser) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado en plataforma' });
      return;
    }
    if (!allowedRoles.includes(req.platformUser.role)) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `Acceso denegado. Roles permitidos: ${allowedRoles.join(', ')}`,
      });
      return;
    }
    next();
  };
}
