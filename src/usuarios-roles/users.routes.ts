/**
 * @file users.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET    /users                        — MANAGEMENT (OWNER, ADMIN)
 * GET    /users/:id                    — MANAGEMENT
 * POST   /users                        — MANAGEMENT
 * PUT    /users/:id                    — MANAGEMENT
 * POST   /users/:id/password-reset-link — MANAGEMENT (K1, 23/08/2026 — manda un link, no fija la password a mano)
 * DELETE /users/:id                    — OWNER_ONLY (solo el propietario puede eliminar usuarios)
 * POST   /users/:id/reactivate         — MANAGEMENT (F2, 25/08/2026 — reincorpora una membership desactivada)
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
 * 1. El rol elegido tiene que estar en `limits.allowedRoleNames`
 *    (`container.getPlanLimits(plan)`, 422→402 ROLE_NOT_AVAILABLE_IN_PLAN)
 *    — ej. plan FREE solo permite asignar ADMIN, no
 *    RECEPTIONIST/HOUSEKEEPING/WAITER.
 * 2. Las membresías activas no-OWNER del negocio no superan
 *    `maxActiveMemberships` (402 PLAN_LIMIT_REACHED).
 * PUT /users/:id repite el chequeo (1) cuando cambia el roleId — cambiar de
 * rol no suma un asiento nuevo, así que no repite el chequeo (2).
 * Mismo patrón que categories.routes.ts: `container.getBusinessPlan()` +
 * `container.getPlanLimits()` (18/08/2026: los límites viven en la tabla
 * `plan_limits` de la BD de plataforma, ya no en la constante TS
 * `PLAN_LIMITS`) con 503 PLATFORM_UNAVAILABLE si esa BD no responde.
 */

import { Router, type Request } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { hashPassword } from '../security/user.store.js';
import { generatePasswordResetToken, hashPasswordResetToken } from '../security/password-reset-token.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { sendPasswordResetEmail, PASSWORD_RESET_EXPIRES_HOURS } from './password-reset.routes.js';
import type { EmailSender } from '../email/email.sender.js';
import type { PlatformRepository } from '../platform/platform.repository.js';
import type { AppContainer } from '../container.js';
import { PlanLimitError, RoleNotAvailableInPlanError } from '../domain/errors.js';
import { resolvePlanLimits } from '../security/resolve-plan-limits.js';

/**
 * `roleId` reemplaza el enum fijo `role` (14/08/2026, ver security/roles.ts
 * — roles pasaron a ser filas de `roles`, editables por negocio sin
 * deploy). Ya no se puede validar el valor con un z.enum estático: se
 * valida en el handler contra `platformRepo.getRoleById(roleId, businessId)`
 * — así también se puede rechazar OWNER con un mensaje específico (ver
 * comentario en POST más abajo) y roles de otro negocio/inexistentes con
 * 404 en vez de aceptarlos en silencio.
 */
// F2 (23/08/2026, pendientes-2026-08-23.md) — fullName/dni/phone son de la
// IDENTITY (la persona, compartida entre negocios si trabaja en más de
// uno); employeeNumber/hiredAt son de la MEMBERSHIP (el empleo en ESTE
// negocio puntual). Ver docblock de Identity/Membership en
// platform.repository.ts para el razonamiento completo. Todos opcionales
// -- ninguno se pedía hasta ahora, no se vuelven obligatorios de golpe.
const CreateUserBodySchema = z.object({
  email: z.string({ required_error: 'email es obligatorio' }).email(),
  password: z.string({ required_error: 'password es obligatorio' }).min(8, {
    message: 'password debe tener al menos 8 caracteres',
  }),
  roleId: z.string({ required_error: 'roleId es obligatorio' }).min(1),
  fullName: z.string().trim().min(1).optional(),
  dni: z.string().trim().min(1).max(20).optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  employeeNumber: z.string().trim().min(1).max(50).optional(),
  hiredAt: z.coerce.date().optional(),
});

const UpdateUserBodySchema = z.object({
  roleId: z.string().min(1).optional(),
  password: z.string().min(8, { message: 'password debe tener al menos 8 caracteres' }).optional(),
  fullName: z.string().trim().min(1).optional(),
  dni: z.string().trim().min(1).max(20).optional(),
  phone: z.string().trim().min(1).max(30).optional(),
  employeeNumber: z.string().trim().min(1).max(50).optional(),
  hiredAt: z.coerce.date().optional(),
});

export function createUsersRouter(
  platformRepo: PlatformRepository,
  container: AppContainer,
  /** K1 (23/08/2026) — para POST /:id/password-reset-link, mismo patrón que user-invitation.routes.ts. */
  emailSender: EmailSender,
  frontendUrl: string,
): Router {
  const router = Router();

  async function dispatchPasswordResetEmail(req: Request, email: string, token: string): Promise<void> {
    const profile = await new SqlBusinessProfileRepository(req.db!).get();
    await sendPasswordResetEmail(emailSender, frontendUrl, email, token, profile);
  }

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

        // Esta alta directa sigue pisando la contraseña de la persona nueva
        // (el ADMIN la tipea acá) — para un email que ya tiene identity en
        // otro negocio eso pisaría su contraseña real, así que rechazamos
        // explícito y mandamos a usar el flujo de invitación (D2,
        // user-invitation.routes.ts) en vez de esta alta directa.
        if (existingIdentity) {
          const alreadyMember = await platformRepo.findMembership(existingIdentity.id, businessId);
          if (alreadyMember) {
            // F2 (25/08/2026, pendientes-2026-08-25.md) -- una membership
            // desactivada NO debe bloquear para siempre: un negocio real
            // recontrata gente. El UNIQUE(identity_id, business_id) impide
            // insertar una fila nueva, así que la única salida es
            // reactivar la existente -- se lo decimos al caller en vez de
            // dejarlo sin salida con el mismo 409 genérico de "ya existe".
            if (!alreadyMember.active) {
              res.status(409).json({
                code: 'MEMBERSHIP_DEACTIVATED',
                message: 'Ese email ya tuvo una cuenta en este negocio, pero está desactivada. ' +
                  'Reactivala (POST /users/:id/reactivate) en vez de crear una nueva.',
                membershipId: alreadyMember.id,
              });
              return;
            }
            res.status(409).json({
              code: 'MEMBERSHIP_ALREADY_EXISTS',
              message: 'Ese email ya es parte de este negocio.',
            });
            return;
          }
          res.status(409).json({
            code: 'IDENTITY_ALREADY_EXISTS',
            message: 'Ese email ya tiene una cuenta en la plataforma (en otro negocio). ' +
              'Usá "Invitar usuario" en vez de esta alta directa — la persona acepta desde su email ' +
              'y se le agrega una membership nueva sin tocar su contraseña actual.',
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
        // resolvePlanLimits() (security/) ya maneja el 503 PLATFORM_UNAVAILABLE.
        const resolved = await resolvePlanLimits(container, res, businessId);
        if (!resolved) return;
        const { plan, limits } = resolved;

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
          fullName: body.fullName,
          dni: body.dni,
          phone: body.phone,
        });

        const member = await platformRepo.createMembership({
          id: randomUUID(),
          identityId: identity.id,
          businessId,
          roleId: role.id,
          employeeNumber: body.employeeNumber,
          hiredAt: body.hiredAt,
        });

        res.status(201).json({ ...member, email: identity.email, fullName: identity.fullName, dni: identity.dni, phone: identity.phone });
      } catch (err) {
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
          const resolved = await resolvePlanLimits(container, res, businessId);
          if (!resolved) return;
          const { plan, limits } = resolved;
          if (limits.allowedRoleNames !== 'ALL' && !limits.allowedRoleNames.includes(role.name)) {
            const err = new RoleNotAvailableInPlanError(plan, role.name);
            res.status(402).json({ code: err.code, message: err.message, plan: err.plan, roleName: err.roleName });
            return;
          }

          await platformRepo.updateMembershipRole(membershipId, businessId, role.id);
        }

        if (body.password !== undefined) {
          // K1 (23/08/2026, pendientes-2026-08-23.md) — jerarquía de rol:
          // un MANAGEMENT no puede pisarle la contraseña a un OWNER (ni a
          // otro MANAGEMENT) de una sola membership — antes solo se
          // chequeaba identidad compartida entre negocios (ver comentario
          // de abajo), sin mirar el rol del objetivo. Se usa
          // permissionGroups (vía getRoleById), NO roleName — roleName es
          // "solo para mostrar" (ver comentario en Membership más arriba
          // en este archivo), los roles son configurables por negocio.
          const targetRole = await platformRepo.getRoleById(member.roleId, businessId);
          const targetIsProtected = Boolean(
            targetRole?.permissionGroups.includes(Roles.OWNER_ONLY)
            || targetRole?.permissionGroups.includes(Roles.MANAGEMENT),
          );
          const actorIsOwnerOnly = (req.user!.permissionGroups ?? []).includes(Roles.OWNER_ONLY);
          if (targetIsProtected && !actorIsOwnerOnly) {
            res.status(403).json({
              code: 'ROLE_HIERARCHY_PROTECTED',
              message: 'No podés cambiarle la contraseña a alguien de este rol directamente — ' +
                'mandale un link de reseteo (POST /users/:id/password-reset-link).',
            });
            return;
          }

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

        if (body.fullName !== undefined || body.dni !== undefined || body.phone !== undefined) {
          await platformRepo.updateIdentityProfile(member.identityId, {
            fullName: body.fullName,
            dni: body.dni,
            phone: body.phone,
          });
        }

        if (body.employeeNumber !== undefined || body.hiredAt !== undefined) {
          await platformRepo.updateMembershipEmployment(membershipId, {
            employeeNumber: body.employeeNumber,
            hiredAt: body.hiredAt,
          });
        }

        const updated = await platformRepo.findMembershipByIdAndBusiness(membershipId, businessId);
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /users/:id/password-reset-link — K1, 23/08/2026 ───────────────────
  // Vía general para restablecer la contraseña de cualquier usuario (no
  // solo el caso bloqueado por jerarquía más arriba) — es la propia
  // persona la que la cambia al abrir el link, así que a diferencia de
  // fijarla a mano acá NO aplica el chequeo de identidad compartida entre
  // negocios (SHARED_IDENTITY_PASSWORD): ese chequeo existe para evitar que
  // un admin la pise sin que la persona se entere, un link no tiene ese
  // problema.
  router.post(
    '/:id/password-reset-link',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const membershipId = req.params['id'] as string;

        const member = await platformRepo.findMembershipByIdAndBusiness(membershipId, businessId);
        if (!member) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Usuario no encontrado' });
          return;
        }

        const token = generatePasswordResetToken();
        const resetToken = await platformRepo.upsertPasswordResetToken({
          id: randomUUID(),
          identityId: member.identityId,
          requestedByIdentityId: req.user!.id,
          businessId,
          tokenHash: hashPasswordResetToken(token),
          expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRES_HOURS * 60 * 60 * 1000),
        });

        await dispatchPasswordResetEmail(req, resetToken.identityEmail, token);

        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  // ── DELETE /users/:id — solo OWNER ─────────────────────────────────────────
  router.delete(
    '/:id',
    authorize(Roles.OWNER_ONLY),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        await platformRepo.deactivateMembership(req.params['id'] as string, businessId, req.user!.id);
        res.status(204).send();
      } catch (err) { next(err); }
    },
  );

  // ── POST /users/:id/reactivate ──────────────────────────────────────────
  // F2 (25/08/2026, pendientes-2026-08-25.md) -- reincorpora una membership
  // desactivada. Antes no existía NINGÚN camino de vuelta: POST /users y
  // POST /users/invitations rechazaban con MEMBERSHIP_ALREADY_EXISTS apenas
  // existía cualquier membership previa (activa o no) para esa identity+
  // negocio, y el UNIQUE(identity_id, business_id) impide insertar una fila
  // nueva -- un negocio real que recontrata a alguien no tenía forma de
  // hacerlo. Reusa los mismos chequeos de plan que POST /users (rol
  // permitido + asiento libre): reactivar un empleado ocupa un asiento
  // igual que crear uno nuevo, así que no debe saltear el límite.
  router.post(
    '/:id/reactivate',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const membershipId = req.params['id'] as string;

        const member = await platformRepo.findMembershipByIdAndBusiness(membershipId, businessId);
        if (!member) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Usuario no encontrado' });
          return;
        }
        if (member.active) {
          res.status(409).json({ code: 'MEMBERSHIP_ALREADY_ACTIVE', message: 'Este usuario ya está activo.' });
          return;
        }

        const role = await platformRepo.getRoleById(member.roleId, businessId);
        if (!role || !role.active) {
          res.status(422).json({ code: 'INVALID_ROLE', message: 'El rol que tenía asignado ya no existe o está desactivado en este negocio — asignale uno nuevo primero (PUT /users/:id) antes de reactivar.' });
          return;
        }

        const resolved = await resolvePlanLimits(container, res, businessId);
        if (!resolved) return;
        const { plan, limits } = resolved;

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

        await platformRepo.reactivateMembership(membershipId, businessId, req.user!.id);
        const updated = await platformRepo.findMembershipByIdAndBusiness(membershipId, businessId);
        res.json(updated);
      } catch (err) { next(err); }
    },
  );

  return router;
}
