/**
 * @file auth.middleware.ts
 * @description Middleware de autenticación y autorización basado en JWT.
 *
 * ## Variables de entorno requeridas (configurar en Render Dashboard):
 * - `JWT_SECRET`     — clave secreta para firmar/verificar tokens (OBLIGATORIA)
 * - `JWT_EXPIRES_IN` — duración del token, ej. "24h", "7d" (opcional, default: "24h")
 *
 * ## Uso en app.ts:
 * ```ts
 * import { authenticate, authorize } from './security/auth.middleware.js';
 * import { UserRole } from './types/enums.js';
 *
 * // Proteger todas las rutas /api/*
 * app.use('/api', authenticate());
 *
 * // Proteger una ruta solo para ADMIN
 * router.delete('/:id', authorize([UserRole.ADMIN]), handler);
 * ```
 */

import { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserRole } from '../types/enums.js';
import { AuthenticatedUser } from './user.types.js';

// ---------------------------------------------------------------------------
// Implementación de JWT mínima sin dependencias externas
// Usa HMAC-SHA256, el algoritmo estándar para HS256.
// Si en el futuro se necesita RS256 (asimétrico), instalar `jsonwebtoken`
// y reemplazar `verifyToken` / `signToken` sin tocar el resto del archivo.
// ---------------------------------------------------------------------------

/**
 * Payload que se incluye dentro del JWT.
 * Extiende los claims estándar de RFC 7519.
 */
export interface JwtPayload {
  /** ID del usuario autenticado */
  sub: string;
  /** Rol del usuario en el sistema */
  role: UserRole;
  /** Timestamp de emisión (Unix epoch, segundos) */
  iat: number;
  /** Timestamp de expiración (Unix epoch, segundos) */
  exp: number;
}

/**
 * Codifica en Base64URL (RFC 4648 §5), sin padding.
 */
function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Decodifica Base64URL, añadiendo el padding que Node requiere.
 */
function base64UrlDecode(input: string): Buffer {
  const padded = input + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Genera un JWT firmado con HS256.
 *
 * @param payload - Datos a incluir en el token (sin `iat` ni `exp`, se calculan aquí)
 * @param secret  - Clave secreta (`JWT_SECRET`)
 * @param expiresIn - Duración en segundos (default: 86400 = 24h)
 * @returns Token JWT como string
 *
 * @example
 * ```ts
 * const token = signToken({ sub: 'user-1', role: UserRole.ADMIN }, process.env.JWT_SECRET!);
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
 * Lanza un error descriptivo en cada caso de fallo, para que `authenticate()`
 * pueda devolver el mensaje adecuado sin exponer detalles internos al cliente.
 *
 * @param token  - Token JWT recibido del cliente
 * @param secret - Clave secreta (`JWT_SECRET`)
 * @returns Payload decodificado y verificado
 * @throws `Error` con `code` en { 'JWT_MALFORMED', 'JWT_INVALID_SIGNATURE', 'JWT_EXPIRED' }
 */
export function verifyToken(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) {
    const err = new Error('Token malformado');
    (err as NodeJS.ErrnoException).code = 'JWT_MALFORMED';
    throw err;
  }

  const [header, body, signature] = parts;

  // Verificar firma con comparación en tiempo constante (previene timing attacks)
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

  // Decodificar payload
  const payload = JSON.parse(base64UrlDecode(body).toString('utf8')) as JwtPayload;

  // Verificar expiración
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp < now) {
    const err = new Error('Token expirado');
    (err as NodeJS.ErrnoException).code = 'JWT_EXPIRED';
    throw err;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Helpers de configuración
// ---------------------------------------------------------------------------

/**
 * Lee y valida que `JWT_SECRET` esté definida en el entorno.
 * Falla al arrancar la aplicación si no está configurada, no en tiempo de request.
 *
 * @throws `Error` si `JWT_SECRET` no está definida o es demasiado corta (< 32 chars)
 */
function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error(
      '[auth.middleware] JWT_SECRET no está definida. ' +
      'Agrégala como variable de entorno en Render Dashboard.',
    );
  }
  if (secret.length < 32) {
    throw new Error(
      '[auth.middleware] JWT_SECRET debe tener al menos 32 caracteres para ser segura.',
    );
  }
  return secret;
}

// Se valida una sola vez al importar el módulo (fail-fast al arrancar).
const JWT_SECRET = requireJwtSecret();

// ---------------------------------------------------------------------------
// Middlewares exportados
// ---------------------------------------------------------------------------

/**
 * Middleware de autenticación. Extrae y verifica el JWT del header `Authorization`.
 *
 * Formato esperado: `Authorization: Bearer <token>`
 *
 * En caso de éxito, adjunta `req.user` con `{ id, role }` para los middlewares
 * y handlers subsiguientes.
 *
 * @param resolveUser - Función opcional para obtener el usuario desde la request.
 *   Por defecto lee el JWT del header `Authorization`. Útil para tests o para
 *   integrar con sistemas externos (ej. Supabase Auth, Auth0).
 *
 * @example
 * ```ts
 * // Proteger todas las rutas de la API
 * app.use('/api', authenticate());
 *
 * // Inyectar un usuario falso en tests de integración
 * app.use('/api', authenticate(() => ({ id: 'test-user', role: UserRole.ADMIN })));
 * ```
 *
 * @swagger
 * components:
 *   securitySchemes:
 *     BearerAuth:
 *       type: http
 *       scheme: bearer
 *       bearerFormat: JWT
 */
export const authenticate = (resolveUser?: (req: Request) => AuthenticatedUser | undefined) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Ruta de escape para tests: si se inyecta un resolver externo, usarlo directamente.
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

    // Extraer token del header Authorization
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Se requiere header Authorization: Bearer <token>',
      });
      return;
    }

    const token = authHeader.slice(7); // Remover "Bearer "

    try {
      const payload = verifyToken(token, JWT_SECRET);
      req.user = { id: payload.sub, role: payload.role };
      next();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'JWT_ERROR';

      if (code === 'JWT_EXPIRED') {
        res.status(401).json({ code: 'TOKEN_EXPIRED', message: 'El token ha expirado' });
        return;
      }
      // JWT_MALFORMED o JWT_INVALID_SIGNATURE — no revelar detalles al cliente
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'Token inválido' });
    }
  };
};

/**
 * Middleware de autorización por rol. Debe usarse **después** de `authenticate()`.
 *
 * @param allowedRoles - Lista de roles que tienen acceso al endpoint.
 *
 * @example
 * ```ts
 * // Solo ADMIN puede eliminar recursos
 * router.delete('/:id', authorize([UserRole.ADMIN]), deleteHandler);
 *
 * // ADMIN y RECEPTIONIST pueden crear reservas
 * router.post('/', authorize([UserRole.ADMIN, UserRole.RECEPTIONIST]), createHandler);
 * ```
 *
 * @swagger
 * security:
 *   - BearerAuth: []
 */
export const authorize = (allowedRoles: readonly UserRole[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      // Guardia defensiva: no debería ocurrir si `authenticate()` se usó antes.
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
