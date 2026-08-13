/**
 * @file me.routes.ts
 * @description Sesión del usuario autenticado (B2, docs/pendientes-2026-08-13.md).
 * No requiere req.db de tenant — lee solo req.user, montado antes de
 * tenantMiddleware, igual que /api/admin y /api/business/modules.
 *
 * ## GET /api/auth/me
 * Devuelve el usuario decodificado del token como JSON legible. Existe
 * porque con la cookie httpOnly el frontend deja de poder leer el JWT con
 * `parseJwt()` client-side (esa es la idea de httpOnly) — este endpoint
 * reemplaza esa lectura.
 * 200 — { id, role, businessId?, customerId? }
 *
 * ## POST /api/auth/logout
 * Limpia la cookie de sesión. No hace nada con localStorage — de eso se
 * sigue encargando el frontend (clearToken()) para el período de
 * transición en que todavía coexisten los dos mecanismos.
 * 204 — sin body
 */

import { Router, type Request, type Response } from 'express';
import { clearAuthCookie } from '../../security/auth.middleware.js';

export function createMeRouter(): Router {
  const router = Router();

  router.get('/me', (req: Request, res: Response): void => {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
      return;
    }
    res.status(200).json({
      id: req.user.id,
      role: req.user.role,
      ...(req.user.businessId !== undefined && { businessId: req.user.businessId }),
      ...(req.user.customerId !== undefined && { customerId: req.user.customerId }),
    });
  });

  router.post('/logout', (_req: Request, res: Response): void => {
    clearAuthCookie(res);
    res.status(204).end();
  });

  return router;
}
