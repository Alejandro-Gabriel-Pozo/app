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
 * ## Cookie httpOnly (B2, docs/pendientes-2026-08-13.md)
 * `authenticate()` acepta el token de TRES formas, en este orden: header
 * `Authorization: Bearer <token>` (como siempre), la cookie de staff
 * `AUTH_COOKIE_NAME`, o la cookie de portal de clientes
 * `AUTH_COOKIE_NAME_CUSTOMER` (19/08/2026, docs/pendientes-2026-08-18.md
 * punto P — portal migrado al mismo patrón). Es un fallback, no un
 * reemplazo — cualquier cliente que ya mande el header (apps, Postman, la
 * doc de Swagger) sigue funcionando exactamente igual.
 *
 * Dos cookies con nombres DISTINTOS a propósito, no una compartida: viven
 * en el mismo dominio/path (`/`), así que un mismo navegador con sesión de
 * staff Y de portal abiertas a la vez (ej. el dueño probando su propio
 * portal) pisaría una cookie con la otra si compartieran nombre.
 * `setAuthCookie`/`clearAuthCookie`/`setCustomerAuthCookie`/
 * `clearCustomerAuthCookie` viven acá para que ningún caller duplique las
 * opciones de la cookie (httpOnly/secure/sameSite/path) en dos archivos.
 *
 * ## hashPassword / verifyPassword
 * Viven en user.store.ts — importarlas de ahí directamente. Hasta el
 * 13/08/2026 este archivo las re-exportaba "para que los routers no se
 * acoplen a user.store", pero ningún caller real las importaba desde acá
 * (`business.routes.ts`/`users.routes.ts` siempre importaron directo de
 * `user.store.js`) — el re-export estaba muerto y el comentario que lo
 * justificaba, desactualizado (jscpd C7 / ts-prune). Sacado.
 */

import type { Request, Response, NextFunction } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { UserRole } from '../types/enums.js';
import type { AuthenticatedUser } from './user.types.js';
import type { PermissionGroup } from './roles.js';
import { CUSTOMER_PERMISSION_GROUPS } from './roles.js';

// ---------------------------------------------------------------------------
// JWT Payload
// ---------------------------------------------------------------------------

export interface JwtPayload {
  sub: string;
  /**
   * Presente SOLO en tokens CUSTOMER (14/08/2026 — ver security/roles.ts).
   * El staff ya no lleva su rol acá: `role_id` vive en `memberships`, se
   * resuelve en cada request contra `role_permission_groups`, nunca se
   * embebe en el JWT (mismo motivo que `isMembershipActive` no se cachea
   * ahí — un cambio de permisos debe tener efecto inmediato, no recién al
   * expirar el token).
   */
  role?: UserRole;
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
// Cookie httpOnly — fallback de authenticate(), usada por login/logout
// ---------------------------------------------------------------------------

export const AUTH_COOKIE_NAME = 'rh_token';
export const AUTH_COOKIE_NAME_CUSTOMER = 'rh_customer_token';

/**
 * Parser mínimo del header `Cookie`. No se agregó `cookie-parser` como
 * dependencia por una sola cookie de lectura — mismo criterio que el JWT
 * hecho a mano con `node:crypto` en vez de una lib externa.
 */
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

/**
 * Opciones compartidas por las dos cookies de sesión (staff y cliente).
 * `secure` solo en producción: en desarrollo local (http, sin TLS) el
 * browser descarta silenciosamente una cookie `Secure` y rompería el
 * login local. Un solo lugar para no desincronizar las opciones entre
 * `set*`/`clear*` de las dos cookies.
 */
function cookieOptions(maxAgeSeconds?: number): {
  httpOnly: true; secure: boolean; sameSite: 'strict'; path: string; maxAge?: number;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    ...(maxAgeSeconds !== undefined && { maxAge: maxAgeSeconds * 1000 }),
  };
}

export function setAuthCookie(res: Response, token: string, maxAgeSeconds: number): void {
  res.cookie(AUTH_COOKIE_NAME, token, cookieOptions(maxAgeSeconds));
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME, cookieOptions());
}

/** Cookie del portal de clientes — mismas opciones, nombre distinto (ver docblock del archivo). */
export function setCustomerAuthCookie(res: Response, token: string, maxAgeSeconds: number): void {
  res.cookie(AUTH_COOKIE_NAME_CUSTOMER, token, cookieOptions(maxAgeSeconds));
}

export function clearCustomerAuthCookie(res: Response): void {
  res.clearCookie(AUTH_COOKIE_NAME_CUSTOMER, cookieOptions());
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
 * Resultado de resolver una membership de staff — usado por el hook
 * `resolveMembershipContext` de `authenticate()` (ver abajo). Combina en
 * una sola consulta lo que antes era solo `isMembershipActive`: además de
 * si la membership sigue activa, trae el `role_id` actual y los
 * `permissionGroups` que ese rol tiene AHORA MISMO — nunca cacheados en el
 * JWT, resueltos de nuevo en cada request (14/08/2026, security/roles.ts).
 */
export interface MembershipContext {
  active: boolean;
  roleId: string;
  permissionGroups: string[];
}

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
 * @param resolveMembershipContext - Chequeo opcional que reemplaza al viejo
 *   `isMembershipActive` (14/08/2026): además de si la membership sigue
 *   activa, resuelve `roleId` + `permissionGroups` — la fuente real de
 *   autorización que usa `authorize()` de acá en más. Si se omite (rutas
 *   sin este hook), `req.user.permissionGroups` queda `undefined` y
 *   `authorize()` rechaza con 403 cualquier grupo que no sea uno de los
 *   que un CUSTOMER puede cumplir — fail-closed, no fail-open.
 */
export const authenticate = (
  resolveUser?: (req: Request) => AuthenticatedUser | undefined,
  resolveMembershipContext?: (identityId: string, businessId: string) => Promise<MembershipContext | null>,
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
    const cookies = parseCookies(req.headers['cookie']);
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice(7)
      : (cookies[AUTH_COOKIE_NAME] ?? cookies[AUTH_COOKIE_NAME_CUSTOMER]);

    if (!token) {
      res.status(401).json({
        code: 'UNAUTHORIZED',
        message: 'Se requiere header Authorization: Bearer <token>',
      });
      return;
    }

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

    let roleId: string | undefined;
    let permissionGroups: string[] | undefined;

    if (resolveMembershipContext && payload.role !== UserRole.CUSTOMER && payload.business_id) {
      let context: MembershipContext | null;
      try {
        context = await resolveMembershipContext(payload.sub, payload.business_id);
      } catch {
        res.status(401).json({ code: 'UNAUTHORIZED', message: 'No se pudo verificar el acceso.' });
        return;
      }
      if (!context || !context.active) {
        res.status(401).json({
          code: 'MEMBERSHIP_INACTIVE',
          message: 'Tu acceso a este negocio fue desactivado.',
        });
        return;
      }
      roleId = context.roleId;
      permissionGroups = context.permissionGroups;
    }

    req.user = {
      id: payload.sub,
      ...(payload.role !== undefined && { role: payload.role }),
      ...(roleId !== undefined && { roleId }),
      ...(permissionGroups !== undefined && { permissionGroups }),
      ...(payload.business_id !== undefined && { businessId: payload.business_id }),
      ...(payload.customer_id !== undefined && { customerId: payload.customer_id }),
    };
    next();
  };
};

/**
 * `authorize(Roles.X)` — SIN CAMBIOS en la firma que ven las rutas
 * (14/08/2026, ver security/roles.ts para el porqué). Antes comparaba
 * `req.user.role` contra un array de `UserRole` fijo; ahora chequea si el
 * `permissionGroup` requerido está en `req.user.permissionGroups`,
 * resuelto por `authenticate()` contra la BD en este mismo request — o,
 * para tokens CUSTOMER, contra la lista fija `CUSTOMER_PERMISSION_GROUPS`
 * (los clientes no tienen `role_id`).
 */
export const authorize = (requiredGroup: PermissionGroup) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
      return;
    }

    const allowed = req.user.role === UserRole.CUSTOMER
      ? CUSTOMER_PERMISSION_GROUPS.includes(requiredGroup)
      : (req.user.permissionGroups ?? []).includes(requiredGroup);

    if (!allowed) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `Acceso denegado. Se requiere el permiso: ${requiredGroup}`,
      });
      return;
    }
    next();
  };
};

/**
 * `authorizeAny([Roles.A, Roles.B])` — Bloque 5 del ADR común cancelar-con-NC
 * (`docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` §6.5 bis,
 * pregunta de negocio 3, mecanismo corregido 15/09/2026): OR real entre
 * varios grupos, para cuando dos roles distintos deben poder acceder a la
 * misma ruta (ej. `EMISOR_NOTA_CREDITO` y `MANAGEMENT`, para la bandeja de
 * reconciliación manual de Notas de Crédito).
 *
 * Existe porque encadenar dos `authorize()` en la misma ruta NO es OR — es
 * AND: cada middleware de la cadena tiene que dejar pasar (`next()`) para
 * que el siguiente corra, así que `authorize(A), authorize(B)` exige AMBOS
 * grupos, no cualquiera de los dos (corrección registrada en el ADR arriba
 * citado — no había precedente real de "dos `authorize()` encadenados como
 * OR" en este repo pese a que una versión anterior del diseño lo daba por
 * sentado). Mismo shape de respuesta que `authorize()` (401 sin
 * `req.user`, 403 con mensaje claro si no tiene NINGUNO de los grupos) para
 * que un caller no tenga que distinguir cuál de las dos usa una ruta dada.
 */
export const authorizeAny = (requiredGroups: readonly PermissionGroup[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
      return;
    }

    const allowed = req.user.role === UserRole.CUSTOMER
      ? requiredGroups.some((g) => CUSTOMER_PERMISSION_GROUPS.includes(g))
      : requiredGroups.some((g) => (req.user!.permissionGroups ?? []).includes(g));

    if (!allowed) {
      res.status(403).json({
        code: 'FORBIDDEN',
        message: `Acceso denegado. Se requiere alguno de estos permisos: ${requiredGroups.join(', ')}`,
      });
      return;
    }
    next();
  };
};
