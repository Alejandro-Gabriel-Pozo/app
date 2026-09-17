/**
 * @file roles.routes.ts
 * @description CRUD de roles configurables (14/08/2026).
 *
 * GET    /api/roles          — MANAGEMENT
 * GET    /api/roles/:id      — MANAGEMENT
 * POST   /api/roles          — MANAGEMENT
 * PUT    /api/roles/:id      — MANAGEMENT (name y/o permissionGroups)
 * DELETE /api/roles/:id      — MANAGEMENT (desactiva, R3/R5)
 *
 * Montada junto a users.routes.ts (después de tenantMiddleware, aunque las
 * operaciones reales van contra la BD de plataforma vía platformRepo) —
 * necesita req.db para auditar contra la tenant DB, ver role.service.ts.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { RoleService } from './role.service.js';
import {
  RoleNotFoundError,
  DuplicateRoleNameError,
  InvalidPermissionGroupError,
  CannotModifySystemRoleError,
  RoleInUseError,
} from './role.service.js';
import { SqlAuditLogRepository } from '../repositories/audit-log.repository.js';
import type { PlatformRepository } from '../platform/platform.repository.js';
import type { AppContainer } from '../container.js';
import type { BusinessPlan } from '../types/enums.js';
import { PlanLimitError, PermissionGroupNotAvailableInPlanError } from '../domain/errors.js';
import { resolvePlanLimits } from '../security/resolve-plan-limits.js';

const CreateRoleSchema = z.object({
  name: z.string().min(1, 'name es obligatorio').max(100),
  permissionGroups: z.array(z.string()).default([]),
});

const UpdateRoleSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  permissionGroups: z.array(z.string()).optional(),
});

function param(req: Request, key: string): string {
  return String(req.params[key]);
}

function handleDomainError(err: unknown, res: Response, next: NextFunction): void {
  if (err instanceof RoleNotFoundError) { res.status(404).json({ code: err.code, message: err.message }); return; }
  if (err instanceof DuplicateRoleNameError) { res.status(409).json({ code: err.code, message: err.message }); return; }
  if (err instanceof InvalidPermissionGroupError) { res.status(400).json({ code: err.code, message: err.message }); return; }
  if (err instanceof CannotModifySystemRoleError) { res.status(409).json({ code: err.code, message: err.message }); return; }
  if (err instanceof RoleInUseError) { res.status(409).json({ code: err.code, message: err.message }); return; }
  // L (23/08/2026) -- techo de plan para roles CUSTOM. PlanLimitError
  // también la puede tirar create/update de OTROS recursos (categorías,
  // memberships) pero acá solo puede venir de este router -- mismo
  // criterio que categories.routes.ts/users.routes.ts, cuerpo enriquecido
  // con plan/limit para que el frontend arme el UpgradePrompt sin parsear
  // el mensaje.
  if (err instanceof PlanLimitError) {
    res.status(402).json({ code: err.code, message: err.message, plan: err.plan, limit: err.limit });
    return;
  }
  if (err instanceof PermissionGroupNotAvailableInPlanError) {
    res.status(402).json({ code: err.code, message: err.message, plan: err.plan, permissionGroups: err.permissionGroups });
    return;
  }
  next(err);
}

export function createRolesRouter(platformRepo: PlatformRepository, container: AppContainer): Router {
  const router = Router();

  function buildService(req: Request): RoleService {
    return new RoleService(platformRepo, new SqlAuditLogRepository(req.db!));
  }

  /**
   * L (23/08/2026) — cruza `permissionGroups` contra
   * `limits.allowedPermissionGroups` ('ALL' = sin restricción). Se llama
   * desde POST y desde PUT (solo cuando el body trae `permissionGroups`) —
   * un rol CUSTOM nunca puede incluir un grupo que el plan no habilita,
   * sin importar si es alta o edición.
   */
  function assertPermissionGroupsAllowedInPlan(
    limits: { allowedPermissionGroups: readonly string[] | 'ALL' },
    plan: BusinessPlan,
    permissionGroups: string[],
  ): void {
    if (limits.allowedPermissionGroups === 'ALL') return;
    const disallowed = permissionGroups.filter((g) => !limits.allowedPermissionGroups.includes(g));
    if (disallowed.length > 0) throw new PermissionGroupNotAvailableInPlanError(plan, disallowed);
  }

  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      res.json(await buildService(req).listRoles(businessId));
    } catch (err) { next(err); }
  });

  router.get('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      res.json(await buildService(req).getRole(param(req, 'id'), businessId));
    } catch (err) { handleDomainError(err, res, next); }
  });

  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      const body = CreateRoleSchema.parse(req.body);

      // L (23/08/2026) -- gobernanza por plan, en este orden: primero
      // "¿hay lugar para otro rol custom?" (cantidad), después "¿el plan
      // habilita estos grupos puntuales?" (techo de permisos). Los 5 roles
      // de fábrica (isSystem=true) no cuentan contra maxCustomRoles.
      const resolved = await resolvePlanLimits(container, res, businessId);
      if (!resolved) return;
      const { plan, limits } = resolved;

      const existingRoles = await buildService(req).listRoles(businessId);
      const activeCustomRoleCount = existingRoles.filter((r) => !r.isSystem && r.active).length;
      if (activeCustomRoleCount >= limits.maxCustomRoles) {
        throw new PlanLimitError(plan, limits.maxCustomRoles, 'customRoles');
      }
      assertPermissionGroupsAllowedInPlan(limits, plan, body.permissionGroups);

      const role = await buildService(req).createRole(businessId, body.name, body.permissionGroups, req.user!.id);
      res.status(201).json(role);
    } catch (err) {
      handleDomainError(err, res, next);
    }
  });

  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      const roleId = param(req, 'id');
      const body = UpdateRoleSchema.parse(req.body);
      const service = buildService(req);

      // L (23/08/2026) -- mismo techo de permisos que POST, pero SIN el
      // chequeo de cantidad: cambiar los grupos de un rol que ya existe no
      // suma un rol nuevo (mismo criterio que users.routes.ts PUT para
      // maxActiveMemberships, que tampoco lo repite al cambiar de rol).
      if (body.permissionGroups !== undefined) {
        const resolved = await resolvePlanLimits(container, res, businessId);
        if (!resolved) return;
        assertPermissionGroupsAllowedInPlan(resolved.limits, resolved.plan, body.permissionGroups);
      }

      let role = await service.getRole(roleId, businessId);
      if (body.name !== undefined) {
        role = await service.renameRole(roleId, businessId, body.name, req.user!.id);
      }
      if (body.permissionGroups !== undefined) {
        role = await service.updatePermissionGroups(roleId, businessId, body.permissionGroups, req.user!.id);
      }
      res.json(role);
    } catch (err) {
      handleDomainError(err, res, next);
    }
  });

  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      await buildService(req).deactivateRole(param(req, 'id'), businessId);
      res.status(204).send();
    } catch (err) { handleDomainError(err, res, next); }
  });

  return router;
}
