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
 * Montado junto a users.routes.ts (después de tenantMiddleware, aunque las
 * operaciones reales van contra la BD de plataforma vía platformRepo) —
 * necesita req.db para auditar contra la tenant DB, ver role.service.ts.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { RoleService } from '../../services/role.service.js';
import {
  RoleNotFoundError,
  DuplicateRoleNameError,
  InvalidPermissionGroupError,
  CannotModifySystemRoleError,
  RoleInUseError,
} from '../../services/role.service.js';
import { SqlAuditLogRepository } from '../../repositories/audit-log.repository.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';

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
  next(err);
}

export function createRolesRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  function buildService(req: Request): RoleService {
    return new RoleService(platformRepo, new SqlAuditLogRepository(req.db!));
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
      const role = await buildService(req).createRole(businessId, body.name, body.permissionGroups, req.user!.id);
      res.status(201).json(role);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
      handleDomainError(err, res, next);
    }
  });

  router.put('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const businessId = req.user!.businessId as string;
      const roleId = param(req, 'id');
      const body = UpdateRoleSchema.parse(req.body);
      const service = buildService(req);

      let role = await service.getRole(roleId, businessId);
      if (body.name !== undefined) {
        role = await service.renameRole(roleId, businessId, body.name, req.user!.id);
      }
      if (body.permissionGroups !== undefined) {
        role = await service.updatePermissionGroups(roleId, businessId, body.permissionGroups, req.user!.id);
      }
      res.json(role);
    } catch (err) {
      if (err instanceof ZodError) { res.status(400).json({ code: 'VALIDATION_ERROR', errors: err.errors }); return; }
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
