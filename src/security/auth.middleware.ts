/**
 * @file auth.middleware.ts
 * @description Middleware de autenticación y autorización basado en JWT.
 *
 * ## Payload del JWT
 * - Empleados (ADMIN, RECEPTIONIST, WAITER): llevan `sub` (userId) + `business_id`
 * - Clientes (CUSTOMER): llevan `sub` (customerId) + `customer_id` + `business_id`
 *
 * ## Variables de entorno
 * - JWT_SECRET     — clave secreta (OBLIGATORIA, mínimo 32 chars)
 * - JWT_EXPIRES_IN — duración del token (opcional, default "24h")
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserRole } from '../types/enums.js';
import { AuthenticatedUser } from './user.types.js';

// ---------------------------------------------------------------------------
// JWT Payload
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;
  role: UserRole;
  /** ID del negocio al que pertenece el usuario (multi-tenant) */
  business_id?: string;
  /** ID del Customer entity — presente solo en tokens CUSTOMER */
  customer_id?: string;
  iat: number;
  exp: number;
}

// ---------------------------------------------------------------------------
// Implementación JWT con node:crypto (sin dependencias externas)
// ---------------------------------------------------------------------------

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(input: string): Buffer {
  const padded = input + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signToken(
  payload: Omit<JwtPayload, 'iat' | 'exp'>,
  secret: string,
  expiresIn = 86_400,
): string {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64UrlEncode(
    JSON.stringify({ ...payload, iat: now, exp: now + expiresIn }),
  );
  const signingInput = `${header}.${body}`;
  const signature = base64UrlEncode(
    createHmac('sha256', secret).update(signingInput).digest(),
  );
  return `${signingInput}.${signature}`;
}

export function verifyToken(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    const err = new Error('Token malformado');
    (err as NodeJS.ErrnoException).code = 'JWT_MALFORMED';
    throw err;
  }

  const [header, body, signature] = parts;
  const signingInput = `${header}.${body}`;
  const expectedSig = base64UrlEncode(
    createHmac('sha256', secret).update(signingInput).digest(),
  );
  const expectedBuf = Buffer.from(expectedSig);
  const receivedBuf = Buffer.from(signature);

  if (
    expectedBuf.length !== receivedBuf.length ||
    !timingSafeEqual(expectedBuf, receivedBuf)
  ) {
    const err = new Error('Firma inválida');
    (err as NodeJS.ErrnoException).code = 'JWT_INVALID_SIGNATURE';
    throw err;
  }

  const payload = JSON.parse(base64UrlDecode(body).toString('utf8')) as JwtPayload;
  const now = Math.floor(Date.now() / 1000);

  if (payload.exp < now) {
    const err = new Error('Token expirado');
    (err as NodeJS.ErrnoException).code = 'JWT_EXPIRED';
    throw err;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Configuración — LAZY: se lee en tiempo de uso, no al importar
// ---------------------------------------------------------------------------

/**
 * Lee y valida JWT_SECRET en el momento de llamarse.
 * Al ser lazy, no explota durante la carga del módulo en tests donde
 * beforeEach setea la variable antes de instanciar el servicio.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('[auth.middleware] JWT_SECRET no está definida.');
  if (secret.length < 32) throw new Error('[auth.middleware] JWT_SECRET debe tener al menos 32 caracteres.');
  return secret;
}

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------

export const authenticate = (resolveUser?: (req: Request) => AuthenticatedUser | undefined) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (resolveUser) {
      const user = resolveUser(req);
      if (!user) {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
        return;
      }
      req.user = user;
      next();
      return;
    }

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
      const payload = verifyToken(token, getJwtSecret());
      req.user = {
        id: payload.sub,
        role: payload.role,
        businessId: payload.business_id,
        customerId: payload.customer_id,
      };
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
};

export const authorize = (allowedRoles: readonly UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `Acceso denegado. Roles permitidos: ${allowedRoles.join(', ')}`,
      });
      return;
    }
    next();
  };
};
