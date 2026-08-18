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
 *
 * ## Límite de asientos y roles por plan (17/08/2026, F2, pendientes-2026-08-17.md)
 * POST /users chequea, en este orden, ANTES de crear identity/membership:
 * 1. El rol elegido tiene que estar en `PLAN_LIMITS[plan].allowedRoleNames`
 *    (422→402 ROLE_NOT_AVAILABLE_IN_PLAN) — ej. plan FREE solo permite
 *    asignar ADMIN, no RECEPTIONIST/HOUSEKEEPING/WAITER.
 * 2. Las membresías activas no-OWNER del negocio no superan
 *    `maxActiveMemberships` (402 PLAN_LIMIT_REACHED).
 * PUT /users/:id repite el chequeo (1) cuando cambia el roleId — cambiar de
 * rol no suma un asiento nuevo, así que no repite el chequeo (2).
 * Mismo patrón que categories.routes.ts: `container.getBusinessPlan()`
 * (no `platformRepo.findById()` — más liviano) con 503 PLATFORM_UNAVAILABLE
 * si la BD de plataforma no responde.
 */

import { Router } from 'express';
import { z, ZodError } from 'zod';
import { randomUUID } from 'node:crypto';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import { hashPassword } from '../../security/user.store.js';
import type { PlatformRepository } from '../../platform/platform.repository.js';
import type { AppContainer } from '../../container.js';
import { PLAN_LIMITS } from '../../config/plan-limits.js';
import { PlanLimitError, RoleNotAvailableInPlanError } from '../../domain/errors.js';

/**
 * `roleId` reemplaza el enum fijo `role` (14/08/2026, ver security/roles.ts
 * — roles pasaron a ser filas de `roles`, editables por negocio sin
 * deploy). Ya no se puede validar el valor con un z.enum estático: se
 * valida en el handler contra `platformRepo.getRoleById(roleId, businessId)`
 * — así también se puede rechazar OWNER con un mensaje específico (ver
 * comentario en POST más abajo) y roles de otro negocio/inexistentes con
 * 404 en vez de aceptarlos en silencio.
 */
const CreateUserBodySchema = z.object({
  email: z.string({ required_error: 'email es obligatorio' }).email(),
  password: z.string({ required_error: 'password es obligatorio' }).min(8, {
    message: 'password debe tener al menos 8 caracteres',
  }),
  roleId: z.string({ required_error: 'roleId es obligatorio' }).min(1),
});

const UpdateUserBodySchema = z.object({
  roleId: z.string().min(1).optional(),
  password: z.string().min(8, { message: 'password debe tener al menos 8 caracteres' }).optional(),
});

export function createUsersRouter(platformRepo: PlatformRepository, container: AppContainer): Router {
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

        // roleId debe existir en ESTE negocio (guardia multi-tenant, mismo
        // criterio que findMembershipByIdAndBusiness) y no puede ser OWNER
        // — ese rol solo se asigna al registrar el negocio (business.routes.ts),
        // nunca desde acá. Antes esto lo garantizaba el z.enum que excluía
        // OWNER de MEMBER_ROLES; con roleId dinámico el chequeo se mueve
        // acá porque ya no hay forma de expresarlo en el schema de Zod.
        const role = await platformRepo.getRoleById(body.roleId, businessId);
        if (!role || !role.active) {
          res.status(422).json({ code: 'INVALID_ROLE', message: `El rol '${body.roleId}' no existe o está desactivado en este negocio.` });
          return;
        }
        if (role.name === 'OWNER') {
          res.status(422).json({ code: 'CANNOT_ASSIGN_OWNER', message: 'El rol OWNER no se puede asignar desde acá — se asigna al registrar el negocio.' });
          return;
        }

        // Límite de asientos y roles por plan (F2) — ver docblock del archivo.
        let plan;
        try {
          plan = await container.getBusinessPlan(businessId);
        } catch {
          res.status(503).json({
            code:    'PLATFORM_UNAVAILABLE',
            message: 'No se pudo verificar el plan del negocio. Reintentá en unos segundos.',
          });
          return;
        }
        const limits = PLAN_LIMITS[plan];

        if (limits.allowedRoleNames !== 'ALL' && !limits.allowedRoleNames.includes(role.name)) {
          const err = new RoleNotAvailableInPlanError(plan, role.name);
          res.status(402).json({ code: err.code, message: err.message, plan: err.plan, roleName: err.roleName });
          return;
        }

        const activeStaffCount = await platformRepo.countActiveStaffMembershipsByBusiness(businessId);
        if (activeStaffCount >= limits.maxActiveMemberships) {
          const err = new PlanLimitError(plan, limits.maxActiveMemberships, 'memberships');
          res.status(402).json({ code: err.code, message: err.message, plan: err.plan, limit: err.limit });
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
          roleId: role.id,
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

        if (body.roleId !== undefined) {
          const role = await platformRepo.getRoleById(body.roleId, businessId);
          if (!role || !role.active) {
            res.status(422).json({ code: 'INVALID_ROLE', message: `El rol '${body.roleId}' no existe o está desactivado en este negocio.` });
            return;
          }
          if (role.name === 'OWNER') {
            res.status(422).json({ code: 'CANNOT_ASSIGN_OWNER', message: 'El rol OWNER no se puede asignar desde acá.' });
            return;
          }

          // Límite de roles por plan (F2) — no repite el chequeo de asiento:
          // cambiar de rol no suma una membership nueva, ver docblock del archivo.
          let plan;
          try {
            plan = await container.getBusinessPlan(businessId);
          } catch {
            res.status(503).json({
              code:    'PLATFORM_UNAVAILABLE',
              message: 'No se pudo verificar el plan del negocio. Reintentá en unos segundos.',
            });
            return;
          }
          const limits = PLAN_LIMITS[plan];
          if (limits.allowedRoleNames !== 'ALL' && !limits.allowedRoleNames.includes(role.name)) {
            const err = new RoleNotAvailableInPlanError(plan, role.name);
            res.status(402).json({ code: err.code, message: err.message, plan: err.plan, roleName: err.roleName });
            return;
          }

          await platformRepo.updateMembershipRole(membershipId, businessId, role.id);
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
