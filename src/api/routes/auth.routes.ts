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
 * ## Rate limiting (recomendado en producción)
 * El endpoint de login es el más sensible a ataques de fuerza bruta.
 * Cuando añadas un reverse proxy (Render, Nginx, Cloudflare), configura
 * un límite de ~10 intentos por IP por minuto en esta ruta.
 */
 
import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { AuthService } from '../../security/auth.service.js';
 
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
   */
  router.post(
    '/',
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // 1. Validar formato del body con Zod (400 si falla)
        const body = LoginBodySchema.parse(req.body);
 
        // 2. Delegar autenticación al servicio (401 si las credenciales son incorrectas)
        const result = await authService.login(body.email, body.password);
 
        // 3. Responder con el token y datos del usuario
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
 
  return router;
}
 
