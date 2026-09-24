/**
 * @file me.routes.ts
 * @description Sesión del usuario autenticado (B2, docs/pendientes-2026-08-13.md).
 * No requiere req.db de tenant — lee solo req.user (+ un lookup puntual de
 * identity para el email), montado antes de tenantMiddleware, igual que
 * /api/admin y /api/business/modules.
 *
 * ## GET /api/auth/me
 * Devuelve el usuario decodificado del token como JSON legible. Existe
 * porque con la cookie httpOnly el frontend deja de poder leer el JWT con
 * `parseJwt()` client-side (esa es la idea de httpOnly) — este endpoint
 * reemplaza esa lectura.
 *
 * El JWT de empleado nunca llevó `email` en el payload (solo `sub`,
 * `business_id` — ver auth.middleware.ts JwtPayload). El frontend viejo
 * decodificaba el token igual y hacía `payload.email ?? payload.sub`, así
 * que en la práctica siempre mostraba el UUID de la identity como "email"
 * en el sidebar. Acá se resuelve bien: un lookup a `platformRepo` para
 * roles de empleado (no CUSTOMER — ese token no tiene identity de
 * plataforma, es un flujo separado, fuera de alcance de este paso).
 *
 * `role` en la respuesta (14/08/2026): tampoco viene ya del JWT — para
 * staff, `req.user.role` es `undefined` (solo los tokens CUSTOMER lo
 * llevan, ver security/roles.ts). Se resuelve el nombre del rol actual
 * vía `roleId` + un lookup a `roles`, mismo patrón que el email.
 * 200 — { id, role, businessId?, customerId?, email? }
 *
 * ## POST /api/auth/logout
 * Limpia la cookie de sesión. No hace nada con localStorage — de eso se
 * sigue encargando el frontend (clearToken()) para el período de
 * transición en que todavía coexisten los dos mecanismos.
 * 204 — sin body
 *
 * ## POST /api/auth/refresh (punto 3, pendientes-2026-08-15.md)
 * Re-firma el token del usuario YA autenticado con un `exp` nuevo — antes
 * la sesión de staff duraba 24h fijas sin forma de extenderla, así que
 * cualquiera que se quedara trabajando más de un turno tenía que volver a
 * loguearse en medio del día. Solo para staff (token con `business_id`,
 * sin `customer_id` — el portal de clientes es un flujo de auth aparte,
 * fuera de alcance acá). El frontend lo llama periódicamente en segundo
 * plano (AuthContext) mientras la pestaña sigue abierta.
 * 200 — { token, tokenType, expiresIn }
 *
 * Wave 15 (24/09/2026, docs/diseno-wave15-sesion-saga-aprovisionamiento-
 * 2026-09-24.md §1/§2) — `AuthService.refreshTenantToken()` pasó de
 * síncrono (pura re-firma en memoria) a async: ahora resuelve el TTL por
 * negocio (item 1, `security/session-ttl.ts::resolveSessionTtl()`) y
 * relee `token_version` (item 2) antes de re-firmar. **Importante — leer
 * antes de describir este cambio en otro lado:** esto es TTL
 * configurable, NO un idle-timeout real — el párrafo de arriba ("el
 * frontend lo llama periódicamente en segundo plano... mientras la
 * pestaña sigue abierta") sigue siendo la cadencia real hoy; sin que
 * `AuthContext` (appfrontend-main) pase a llamar `/refresh` en respuesta
 * a actividad genuina del usuario en vez de un timer fijo, achicar el TTL
 * acorta la sesión pero no la hace expirar por inactividad real. Detalle
 * completo en el docblock de `session-ttl.ts`.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { clearAuthCookie, setAuthCookie } from '../../security/auth.middleware.js';
import { UserRole } from '../../types/enums.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';
import type { AuthService } from '../../security/auth.service.js';

export function createMeRouter(platformRepo: PlatformRepository, authService: AuthService): Router {
  const router = Router();

  router.get('/me', async (req: Request, res: Response): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
      return;
    }

    let email: string | undefined;
    let roleName: string | undefined = req.user.role;
    if (req.user.role !== UserRole.CUSTOMER) {
      const identity = await platformRepo.findIdentityById(req.user.id);
      email = identity?.email;

      if (req.user.roleId !== undefined && req.user.businessId !== undefined) {
        const role = await platformRepo.getRoleById(req.user.roleId, req.user.businessId);
        roleName = role?.name;
      }
    }

    res.status(200).json({
      id: req.user.id,
      ...(roleName !== undefined && { role: roleName }),
      ...(email !== undefined && { email }),
      ...(req.user.businessId !== undefined && { businessId: req.user.businessId }),
      ...(req.user.customerId !== undefined && { customerId: req.user.customerId }),
    });
  });

  router.post('/logout', (_req: Request, res: Response): void => {
    clearAuthCookie(res);
    res.status(204).end();
  });

  router.post('/refresh', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user || req.user.businessId === undefined || req.user.customerId !== undefined) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: 'No autenticado' });
      return;
    }

    try {
      const result = await authService.refreshTenantToken(req.user.id, req.user.businessId, req.user.tokenVersion ?? 0);
      setAuthCookie(res, result.token, result.expiresIn);
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
