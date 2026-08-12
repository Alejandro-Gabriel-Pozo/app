/**
 * @file users.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET    /users          — MANAGEMENT (OWNER, ADMIN)
 * GET    /users/:id      — MANAGEMENT
 * POST   /users          — MANAGEMENT
 * PUT    /users/:id      — MANAGEMENT
 * DELETE /users/:id      — OWNER_ONLY (solo el propietario puede eliminar usuarios)
 *
 * Nota: el rol OWNER no puede ser asignado desde la API — se asigna al crear
 * el negocio en la plataforma. El endpoint de creación lo rechaza explícitamente.
 *
 * `:id` es el ID de la MEMBERSHIP (no de la identity) — un usuario es
 * "una persona en este negocio, con este rol". Ver src/db/platform.schema.sql,
 * bloque IDENTITY/MEMBERSHIP.
 *
 * authenticate() fue removido de cada handler: app.ts lo aplica
 * globalmente sobre /api/* antes de tenantMiddleware. Doble authenticate()
 * causaba 401 UNAUTHORIZED al re-leer el header en el segundo pase.
 */

import { Router } from 'express';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { UserRole } from '../../types/enums.js';
import { hashPassword } from '../../security/user.store.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';

const MEMBER_ROLES = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER, UserRole.HOUSEKEEPING] as const;

const CreateUserBodySchema = z.object({
  email: z.string({ required_error: 'email es obligatorio' }).email(),
  password: z.string({ required_error: 'password es obligatorio' }).min(8, {
    message: 'password debe tener al menos 8 caracteres',
  }),
  role: z.enum(MEMBER_ROLES, { required_error: 'role es obligatorio' }),
});

const UpdateUserBodySchema = z.object({
  role: z.enum(MEMBER_ROLES).optional(),
  password: z.string().min(8, { message: 'password debe tener al menos 8 caracteres' }).optional(),
});

export function createUsersRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

  // ── GET /users ─────────────────────────────────────────────────────────────
  router.get(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const members = await platformRepo.listMembershipsByBusiness(businessId);
        res.json(members);
      } catch (err) { next(err); }
    },
  );

  // ── GET /users/:id ─────────────────────────────────────────────────────────
  router.get(
    '/:id',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const member = await platformRepo.findMembershipByIdAndBusiness(
          req.params['id'] as string,
          businessId,
        );
        if (!member) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Usuario no encontrado' });
          return;
        }
        res.json(member);
      } catch (err) { next(err); }
    },
  );

  // ── POST /users ────────────────────────────────────────────────────────────
  router.post(
    '/',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const body = CreateUserBodySchema.parse(req.body);

        const existingIdentity = await platformRepo.findIdentityByEmail(body.email);

        // Todavía no hay flujo de invitación (requeriría envío de emails).
        // Rechazamos explícito en vez de pisar la contraseña de otra cuenta
        // o crear una membership silenciosa con una password que el dueño
        // real de esa identity no conoce.
        if (existingIdentity) {
          const alreadyMember = await platformRepo.findMembership(existingIdentity.id, businessId);
          if (alreadyMember) {
            res.status(409).json({
              code: 'MEMBERSHIP_ALREADY_EXISTS',
              message: 'Ese email ya es parte de este negocio.',
            });
            return;
          }
          res.status(409).json({
            code: 'IDENTITY_ALREADY_EXISTS',
            message: 'Ese email ya tiene una cuenta en la plataforma (en otro negocio). ' +
              'Pedile a esa persona que inicie sesión — todavía no existe un flujo de invitación automático.',
          });
          return;
        }

        const identity = await platformRepo.createIdentity({
          id: randomUUID(),
          email: body.email,
          passwordHash: await hashPassword(body.password),
        });

        const member = await platformRepo.createMembership({
          id: randomUUID(),
          identityId: identity.id,
          businessId,
          role: body.role,
        });

        res.status(201).json({ ...member, email: identity.email });
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Datos inválidos', errors: err.flatten() });
          return;
        }
        next(err);
      }
    },
  );

  // ── PUT /users/:id ─────────────────────────────────────────────────────────
  router.put(
    '/:id',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const membershipId = req.params['id'] as string;
        const body = UpdateUserBodySchema.parse(req.body);

        const member = await platformRepo.findMembershipByIdAndBusiness(membershipId, businessId);
        if (!member) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Usuario no encontrado' });
          return;
        }

        if (body.role !== undefined) {
          await platformRepo.updateMembershipRole(membershipId, businessId, body.role);
        }

        if (body.password !== undefined) {
          // La password vive en la identity, compartida entre TODOS los
          // negocios en los que esa persona es miembro. Si dejáramos que
          // cualquier ADMIN de CUALQUIER negocio la cambie sin más, un
          // negocio podría "resetear" sin querer (o a propósito) el acceso
          // de esa persona a otro negocio distinto. Solo lo permitimos
          // cuando esta es la única membership activa de la identity.
          const memberships = await platformRepo.findActiveMembershipsByIdentityId(member.identityId);
          if (memberships.length > 1) {
            res.status(409).json({
              code: 'SHARED_IDENTITY_PASSWORD',
              message: 'Esta cuenta pertenece a más de un negocio — no se puede cambiar la ' +
                'contraseña desde acá. Esa persona puede cambiarla ella misma cuando haya un flujo de perfil propio.',
            });
            return;
          }
          await platformRepo.updateIdentityPassword(member.identityId, await hashPassword(body.password));
        }

        const updated = await platformRepo.findMembershipByIdAndBusiness(membershipId, businessId);
        res.json(updated);
      } catch (err) {
        if (err instanceof ZodError) {
          res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Datos inválidos', errors: err.flatten() });
          return;
        }
        next(err);
      }
    },
  );

  // ── DELETE /users/:id — solo OWNER ─────────────────────────────────────────
  router.delete(
    '/:id',
    authorize(Roles.OWNER_ONLY),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        await platformRepo.deactivateMembership(req.params['id'] as string, businessId);
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  return router;
}
