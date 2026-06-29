/**
 * @file auth.middleware.ts
 * @description Middleware de autenticación y autorización basado en JWT.
 *
 * ## Cambio respecto a versión anterior
 * El JWT puede incluir `business_id` en el payload (multi-tenant).
 * Es opcional para mantener compatibilidad con modos single-tenant / dev.
 *
 * ## Variables de entorno (Render Dashboard)
 * - JWT_SECRET     — clave secreta para firmar/verificar tokens (OBLIGATORIA)
 * - JWT_EXPIRES_IN — duración del token (opcional, default "24h")
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserRole } from '../types/enums.js';
import { AuthenticatedUser } from './user.types.js';

// ---------------------------------------------------------------------------
// JWT Payload
// ---------------------------------------------------------------------------

/**
 * Payload del JWT.
 * `business_id` es opcional: presente en modo multi-tenant,
 * ausente en modo single-tenant / dev.
 */
export interface JwtPayload {
  sub: string;
  role: UserRole;
  /** ID del negocio al que pertenece el usuario (multi-tenant únicamente) */
  business_id?: string;
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

/**
 * Genera un JWT firmado con HS256.
 *
 * @example
 * ```ts
 * const token = signToken(
 *   { sub: 'user-1', role: UserRole.ADMIN },
 *   process.env.JWT_SECRET!
 * );
 * ```
 */
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

/**
 * Verifica y decodifica un JWT.
 */
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
// Configuración
// ---------------------------------------------------------------------------

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('[auth.middleware] JWT_SECRET no está definida.');
  }
  if (secret.length < 32) {
    throw new Error('[auth.middleware] JWT_SECRET debe tener al menos 32 caracteres.');
  }
  return secret;
}

const JWT_SECRET = requireJwtSecret();

// ---------------------------------------------------------------------------
// Middlewares
// ---------------------------------------------------------------------------

/**
 * Middleware de autenticación.
 * Verifica el JWT y adjunta `req.user` con `{ id, role, businessId }`.
 */
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
      const payload = verifyToken(token, JWT_SECRET);
      req.user = {
        id: payload.sub,
        role: payload.role,
        businessId: payload.business_id,
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

/**
 * Middleware de autorización por rol.
 */
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
