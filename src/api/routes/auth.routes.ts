/**
 * @file auth.routes.ts
 * @description Router de autenticación — expone `POST /api/login`.
 *
 * Este router se monta **antes** del middleware `authenticate()` en `app.ts`,
 * ya que es la ruta pública que emite los tokens.
 *
 * ## Flujo completo
 * ```
 * Cliente → POST /api/login { email, password }
 *        ← 200 { token, tokenType, expiresIn, user }
 *
 * Cliente → GET /api/reservations
 *           Authorization: Bearer <token>
 *        ← 200 [...]
 * ```
 *
 * ## Rate limiting
 * Limita a 10 intentos por IP cada 15 minutos para prevenir fuerza bruta.
 * En producción detrás de Render/Cloudflare, asegúrate de activar
 * `app.set('trust proxy', 1)` para que el limiter lea la IP real desde
 * el header `X-Forwarded-For`.
 */

import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { AuthService } from '../../security/auth.service.js';
import { setAuthCookie } from '../../security/auth.middleware.js';

// ---------------------------------------------------------------------------
// Rate limiter — protección anti fuerza bruta
// ---------------------------------------------------------------------------

/**
 * Mapa en memoria: IP → { count, resetAt }.
 * Suficiente para una instancia única (Render free/starter).
 * Para multi-instancia reemplazar por un store Redis.
 */
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

/** Máximo de intentos fallidos por IP en la ventana */
const MAX_ATTEMPTS = 10;
/** Ventana de tiempo en milisegundos (15 minutos) */
const WINDOW_MS = 15 * 60 * 1_000;

/**
 * Middleware de rate limiting para el endpoint de login.
 * Retorna 429 con el header `Retry-After` si se supera el límite.
 */
function loginRateLimiter(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const ip =
    (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ??
    req.socket.remoteAddress ??
    'unknown';

  const now = Date.now();
  const entry = loginAttempts.get(ip);

  if (!entry || now > entry.resetAt) {
    // Primera petición o ventana expirada — reiniciar contador
    loginAttempts.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    next();
    return;
  }

  if (entry.count >= MAX_ATTEMPTS) {
    const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1_000);
    res.set('Retry-After', String(retryAfterSeconds));
    res.status(429).json({
      code: 'TOO_MANY_REQUESTS',
      message: `Demasiados intentos de inicio de sesión. Intentá de nuevo en ${Math.ceil(retryAfterSeconds / 60)} minuto(s).`,
    });
    return;
  }

  entry.count += 1;
  next();
}

// ---------------------------------------------------------------------------
// Schema de validación del body
// ---------------------------------------------------------------------------

/**
 * Esquema Zod para el body de `POST /api/login`.
 *
 * Intencionalmente minimalista: solo valida que los campos existan y tengan
 * formato básico correcto. La validación de credenciales la hace `AuthService`.
 */
const LoginBodySchema = z.object({
  /**
   * Email del usuario. Se normaliza a minúsculas en AuthService.
   * @example "admin@demo.com"
   */
  email: z
    .string({ required_error: 'email es obligatorio' })
    .email({ message: 'email debe tener un formato válido' }),

  /**
   * Contraseña en texto plano. Longitud mínima de 6 para evitar
   * envíos vacíos accidentales, sin revelar la política real.
   * @example "admin123"
   */
  password: z
    .string({ required_error: 'password es obligatorio' })
    .min(6, { message: 'password debe tener al menos 6 caracteres' }),
});

/**
 * Body de `POST /api/login/select-business` — paso 2, solo cuando el login
 * devolvió `needsBusinessSelection: true`.
 */
const SelectBusinessBodySchema = z.object({
  identityToken: z
    .string({ required_error: 'identityToken es obligatorio' })
    .min(1, { message: 'identityToken es obligatorio' }),
  businessId: z
    .string({ required_error: 'businessId es obligatorio' })
    .min(1, { message: 'businessId es obligatorio' }),
});

// ---------------------------------------------------------------------------
// Factory del router
// ---------------------------------------------------------------------------

/**
 * Crea y configura el router de autenticación.
 *
 * @param authService - Instancia del servicio de autenticación (inyectada desde `app.ts`)
 * @returns Router Express con el endpoint `POST /`
 *
 * @example
 * ```ts
 * // En app.ts:
 * app.use('/api/login', createAuthRouter(authService));
 * ```
 */
export function createAuthRouter(authService: AuthService): Router {
  const router = Router();

  /**
   * @swagger
   * /api/login:
   *   post:
   *     summary: Autenticarse y obtener un JWT
   *     description: >
   *       Valida las credenciales del usuario y devuelve un JWT Bearer.
   *       Incluye el token en el header `Authorization: Bearer <token>`
   *       de todas las peticiones posteriores a `/api/*`.
   *       Máximo 10 intentos por IP cada 15 minutos (429 si se supera).
   *     tags:
   *       - Auth
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/LoginRequest'
   *           examples:
   *             admin:
   *               summary: Administrador demo
   *               value:
   *                 email: "admin@demo.com"
   *                 password: "admin123"
   *             recepcionista:
   *               summary: Recepcionista demo
   *               value:
   *                 email: "recepcion@demo.com"
   *                 password: "recep123"
   *     responses:
   *       200:
   *         description: Autenticación exitosa
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/LoginResponse'
   *       400:
   *         description: Body inválido (email o password con formato incorrecto)
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ValidationErrorResponse'
   *       401:
   *         description: Credenciales incorrectas
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ErrorResponse'
   *             example:
   *               code: "INVALID_CREDENTIALS"
   *               message: "Credenciales inválidas"
   *       429:
   *         description: Demasiados intentos — rate limit superado
   *         headers:
   *           Retry-After:
   *             schema: { type: integer }
   *             description: Segundos hasta que se libera la ventana
   */
  router.post(
    '/',
    loginRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // 1. Validar formato del body con Zod (400 si falla)
        const body = LoginBodySchema.parse(req.body);

        // 2. Delegar autenticación al servicio (401 si las credenciales son incorrectas)
        const result = await authService.login(body.email, body.password);

        // 2.5. Cookie httpOnly (B2) — fallback además del token en el body,
        // no en su reemplazo todavía. Solo cuando el login se resolvió del
        // todo (needsBusinessSelection no trae token).
        if ('token' in result) {
          setAuthCookie(res, result.token, result.expiresIn);
        }

        // 3. Responder con el token (o con la lista de negocios para elegir)
        res.status(200).json(result);
      } catch (err) {
        // Credenciales inválidas → 401 (no pasa por el errorHandler genérico)
        if ((err as NodeJS.ErrnoException).code === 'INVALID_CREDENTIALS') {
          res.status(401).json({
            code: 'INVALID_CREDENTIALS',
            // Mensaje genérico intencional: no revelar si falló email o password
            message: 'Credenciales inválidas',
          });
          return;
        }
        // Cualquier otro error (ZodError, errores de sistema) → errorHandler global
        next(err);
      }
    },
  );

  /**
   * @swagger
   * /api/login/select-business:
   *   post:
   *     summary: Paso 2 del login — elegir negocio cuando el email tiene más de una membership activa
   *     tags:
   *       - Auth
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [identityToken, businessId]
   *             properties:
   *               identityToken: { type: string }
   *               businessId: { type: string }
   *     responses:
   *       200:
   *         description: Autenticación exitosa
   *       401:
   *         description: identityToken inválido/expirado o sin membership activa en ese negocio
   */
  router.post(
    '/select-business',
    loginRateLimiter,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = SelectBusinessBodySchema.parse(req.body);
        const result = await authService.selectBusiness(body.identityToken, body.businessId);
        setAuthCookie(res, result.token, result.expiresIn);
        res.status(200).json(result);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'INVALID_BUSINESS_SELECTION') {
          res.status(401).json({
            code: 'INVALID_BUSINESS_SELECTION',
            message: 'Selección de negocio inválida o expirada. Iniciá sesión de nuevo.',
          });
          return;
        }
        next(err);
      }
    },
  );

  return router;
}
