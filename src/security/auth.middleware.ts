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
 *
 * ## authenticate() — firma
 * `authenticate(resolveUser?, isMembershipActive?)` — ambos parámetros son
 * SIEMPRE opcionales. No agregar parámetros obligatorios: el 99% de las
 * rutas lo llaman como `authenticate()` sin argumentos. Si alguno fuera
 * requerido rompería todos esos call-sites con TS2554.
 *
 * ## Revocación de acceso — `isMembershipActive`
 * Verificar la firma y el `exp` del JWT NO alcanza: un empleado desactivado
 * (`memberships.active = false`) conserva un token válido hasta que expira
 * (`JWT_EXPIRES_IN`, default 24h). `isMembershipActive` es el hook que
 * cierra ese hueco — se le pasa una vez en el mount global de app.ts
 * (`authenticate(undefined, checker)`) y desde ahí protege TODO /api/*,
 * incluidas las rutas que vuelven a llamar `authenticate()` sin argumentos
 * más abajo (esas son redundantes pero inofensivas: si la membership ya
 * fue rechazada acá, la request nunca llega a la segunda verificación).
 * Solo aplica a tokens de empleado (`business_id` presente, role≠CUSTOMER):
 * la revocación de clientes es un caso distinto (vive en la tenant DB, no
 * en `memberships` de plataforma) y queda fuera de este cambio.
 *
 * ## Re-exports de utilidades de hashing
 * hashPassword y verifyPassword viven en user.store.ts.
 * Se re-exportan aquí para que los routers puedan importarlas desde
 * auth.middleware sin depender directamente de user.store.
 * NO mover la implementación a este archivo — rompería la separación
 * de responsabilidades y duplicaría la lógica.
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserRole } from '../types/enums.js';
import { AuthenticatedUser } from './user.types.js';

// ---------------------------------------------------------------------------
// Re-exports — utilitarios de hashing de contraseñas
// ---------------------------------------------------------------------------

/**
 * Re-export de hashPassword y verifyPassword desde user.store.
 *
 * ## ¿Por qué re-exportar desde aquí?
 * users.routes.ts importa `hashPassword` desde auth.middleware para no
 * acoplarse a user.store directamente (que es un detalle de implementación
 * del InMemoryUserStore). Al re-exportar aquí mantenemos el contrato de
 * import estable incluso si la implementación cambia.
 *
 * ## REGLA: no duplicar la implementación
 * Siempre re-exportar desde user.store.ts — nunca reimplementar aquí.
 */
export { hashPassword, verifyPassword } from './user.store.js';

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

/**
 * `signToken`/`verifyToken` son genéricos en el payload para poder reutilizar
 * la misma implementación HMAC en tokens que no son `JwtPayload` (ej. el
 * token corto de selección de negocio en el login multi-membership — ver
 * `auth.service.ts`). Un solo camino de firma/verificación para todo el
 * proyecto, en vez de reimplementar JWT por segunda vez.
 */
export function signToken<T extends object = Omit<JwtPayload, 'iat' | 'exp'>>(
  payload: T,
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

export function verifyToken<T = JwtPayload>(token: string, secret: string): T & { iat: number; exp: number } {
  const parts = token.split('.');
  if (parts.length !== 3) {
    const err = new Error('Token malformado');
    (err as NodeJS.ErrnoException).code = 'JWT_MALFORMED';
    throw err;
  }

  const [header, body, signature] = parts as [string, string, string];
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

  const payload = JSON.parse(base64UrlDecode(body).toString('utf8')) as T & { iat: number; exp: number };
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

/**
 * Middleware de autenticación.
 *
 * ## Parámetros — SIEMPRE opcionales
 * No convertir ninguno en obligatorio. Todas las rutas llaman `authenticate()`
 * sin argumentos. Si alguno se vuelve requerido, rompe con TS2554 en cada
 * call-site que no lo pase.
 *
 * @param resolveUser - Función opcional para resolver el usuario desde req
 *   (usada en tests o en rutas que necesitan un resolver personalizado).
 *   Si se omite, el usuario se extrae del header Authorization: Bearer.
 * @param isMembershipActive - Chequeo opcional contra `memberships.active`
 *   para tokens de empleado (ver comentario de archivo). Si se omite, el
 *   middleware se comporta como antes (solo firma + expiración).
 */
export const authenticate = (
  resolveUser?: (req: Request) => AuthenticatedUser | undefined,
  isMembershipActive?: (identityId: string, businessId: string) => Promise<boolean>,
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
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

    let payload: JwtPayload;
    try {
      payload = verifyToken(token, getJwtSecret());
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'JWT_ERROR';
      if (code === 'JWT_EXPIRED') {
        res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'El token ha expirado' });
        return;
      }
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token inválido' });
      return;
    }

    if (isMembershipActive && payload.role !== UserRole.CUSTOMER && payload.business_id) {
      try {
        const active = await isMembershipActive(payload.sub, payload.business_id);
        if (!active) {
          res.status(401).json({
            code: 'MEMBERSHIP_INACTIVE',
            message: 'Tu acceso a este negocio fue desactivado.',
          });
          return;
        }
      } catch {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'No se pudo verificar el acceso.' });
        return;
      }
    }

    req.user = {
      id: payload.sub,
      role: payload.role,
      ...(payload.business_id !== undefined && { businessId: payload.business_id }),
      ...(payload.customer_id !== undefined && { customerId: payload.customer_id }),
    };
    next();
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
