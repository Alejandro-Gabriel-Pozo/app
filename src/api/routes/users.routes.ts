/**
 * @file users.routes.ts
 * @description Gestión de empleados por el ADMIN del negocio.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { authorize } from '../middleware/auth.middleware.wrapper.js';
import { PlatformRepository } from '../../platform/platform.repository.js';
import { hashPassword } from '../../security/user.store.js';
import { UserRole } from '../../types/enums.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normaliza query params que pueden ser string | string[] a string */
function firstString(val: string | string[] | undefined): string | undefined {
  if (val === undefined) return undefined;
  return Array.isArray(val) ? val[0] : val;
}

// ---------------------------------------------------------------------------
// Schemas Zod
// ---------------------------------------------------------------------------

const STAFF_ROLES = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;

const CreateUserSchema = z.object({
  email: z
    .string({ required_error: 'email es obligatorio' })
    .email('email debe tener un formato válido')
    .toLowerCase(),
  password: z
    .string({ required_error: 'password es obligatorio' })
    .min(8, 'password debe tener al menos 8 caracteres'),
  role: z.enum(
    [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER],
    { required_error: 'role es obligatorio', invalid_type_error: `role debe ser uno de: ${STAFF_ROLES.join(', ')}` },
  ),
});

const UpdateUserSchema = z.object({
  email: z.string().email('email debe tener un formato válido').toLowerCase().optional(),
  password: z.string().min(8, 'password debe tener al menos 8 caracteres').optional(),
  role: z.enum(
    [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER],
    { invalid_type_error: `role debe ser uno de: ${STAFF_ROLES.join(', ')}` },
  ).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'Debe enviar al menos un campo para actualizar (email, password, role)' },
);

// ---------------------------------------------------------------------------
// DTO de respuesta — nunca expone passwordHash
// ---------------------------------------------------------------------------

function toUserDto(user: { id: string; email: string; role: string; active: boolean; createdAt: Date; businessId: string }) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    active: user.active,
    createdAt: user.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Factory del router
// ---------------------------------------------------------------------------

export function createUsersRouter(
  platformRepo: PlatformRepository,
): Router {
  const router = Router();

  // GET /api/users
  router.get(
    '/',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = req.user!.businessId!;
        const users = await platformRepo.listUsersByBusiness(businessId);
        res.json(users.map(toUserDto));
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/users
  router.post(
    '/',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = CreateUserSchema.parse(req.body);
        const businessId = req.user!.businessId!;

        const emailTaken = await platformRepo.existsUserByEmailInBusiness(
          body.email,
          businessId,
        );
        if (emailTaken) {
          res.status(409).json({
            code: 'EMAIL_ALREADY_EXISTS',
            message: `Ya existe un empleado con el email ${body.email} en este negocio.`,
          });
          return;
        }

        const passwordHash = await hashPassword(body.password);
        const newUser = await platformRepo.createPlatformUser({
          id: crypto.randomUUID(),
          email: body.email,
          businessId,
          role: body.role,
          passwordHash,
        });

        res.status(201).json(toUserDto(newUser));
      } catch (err) {
        next(err);
      }
    },
  );

  // PATCH /api/users/:id
  router.patch(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = UpdateUserSchema.parse(req.body);
        const businessId = req.user!.businessId!;
        const targetId   = firstString(req.params['id'] as string | string[]) ?? '';

        if (targetId === req.user!.id && body.role !== undefined && body.role !== UserRole.ADMIN) {
          res.status(422).json({
            code: 'CANNOT_CHANGE_OWN_ROLE',
            message: 'No podés cambiar tu propio rol.',
          });
          return;
        }

        const existing = await platformRepo.findUserByIdAndBusiness(targetId, businessId);
        if (!existing) {
          res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Usuario no encontrado.' });
          return;
        }

        if (body.email && body.email !== existing.email) {
          const emailTaken = await platformRepo.existsUserByEmailInBusiness(
            body.email,
            businessId,
            targetId,
          );
          if (emailTaken) {
            res.status(409).json({
              code: 'EMAIL_ALREADY_EXISTS',
              message: `Ya existe un empleado con el email ${body.email} en este negocio.`,
            });
            return;
          }
        }

        const passwordHash = body.password
          ? await hashPassword(body.password)
          : undefined;

        const updated = await platformRepo.updateUser(targetId, businessId, {
          ...(body.email     !== undefined && { email: body.email }),
          ...(body.role      !== undefined && { role: body.role }),
          ...(passwordHash   !== undefined && { passwordHash }),
        });

        res.json(toUserDto(updated!));
      } catch (err) {
        next(err);
      }
    },
  );

  // DELETE /api/users/:id
  router.delete(
    '/:id',
    authorize([UserRole.ADMIN]),
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const businessId = req.user!.businessId!;
        const targetId   = firstString(req.params['id'] as string | string[]) ?? '';

        if (targetId === req.user!.id) {
          res.status(422).json({
            code: 'CANNOT_DEACTIVATE_SELF',
            message: 'No podés desactivar tu propia cuenta.',
          });
          return;
        }

        const deactivated = await platformRepo.deactivateUser(targetId, businessId);
        if (!deactivated) {
          res.status(404).json({ code: 'USER_NOT_FOUND', message: 'Usuario no encontrado o ya inactivo.' });
          return;
        }

        res.status(204).send();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
