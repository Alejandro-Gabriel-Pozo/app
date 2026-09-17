/**
 * @file user-invitation.routes.ts
 * @description Invitación de usuarios por mail (D2, pendientes-2026-08-19.md)
 * — reemplaza/complementa la alta directa de users.routes.ts, donde HOY un
 * ADMIN tipea la contraseña de otra persona. Acá el ADMIN solo carga
 * email + rol; la persona invitada define su propia contraseña (o, si ya
 * tiene una identity de otro negocio, solo se le agrega una membership
 * nueva — ver `acceptInvitation` más abajo, misma lógica "una identity, N
 * memberships" que ya existe en identities/memberships).
 *
 * Dos routers en este archivo — mismo criterio que invoices.routes.ts,
 * que exporta `createInvoicesRouter` + `createAfipCredentialsRouter`:
 *
 * - `createUserInvitationsRouter` — MANAGEMENT, montado en
 *   `/api/users/invitations` DESPUÉS de tenantMiddleware (necesita req.db
 *   para el nombre del negocio del mail, vía SqlBusinessProfileRepository
 *   — mismo dato que usa reservation.confirmed en email.handlers.ts). Se
 *   monta ANTES que `/api/users` en app.ts: si no, el router de
 *   `/api/users` (con `GET/PUT /:id`) intercepta `/invitations`
 *   tratándolo como un `:id`.
 * - `createInvitationAcceptanceRouter` — PÚBLICO, montado en
 *   `/api/invitations` ANTES de authenticate() (mismo motivo que
 *   `/api/admin`: quien acepta todavía no tiene ningún JWT). El token de
 *   la invitación viaja en el BODY de los POST, nunca en la URL/query
 *   string de esta API — así no queda en logs de acceso del servidor
 *   (el token no es PII en el sentido de A7.2, pero es una credencial de
 *   un solo uso y mejor no loguearla igual). El link del MAIL sí lleva el
 *   token en su query string — esa URL apunta al FRONTEND, no a esta API,
 *   mismo trade-off que cualquier link de invitación/reset de contraseña
 *   de la industria.
 *
 * ## Qué NO hace (fuera de alcance de D2)
 * - No re-valida rol-vs-plan en el momento de aceptar (solo al invitar) —
 *   si el plan del negocio cambió entre la invitación y la aceptación, el
 *   límite de ASIENTOS sí se vuelve a chequear (abajo), pero no si el rol
 *   puntual sigue permitido. Riesgo bajo, no resuelto acá.
 * - El chequeo de asiento (`countActiveStaffMembershipsByBusiness` +
 *   comparar contra `maxActiveMemberships`) sigue siendo un read-then-write
 *   sin serializar en la base — mismo gap conocido que ya tiene POST
 *   /users (A8.3, criterios-negocio.md), no introducido ni resuelto por
 *   este archivo.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import { hashPassword } from '../security/user.store.js';
import { generateInvitationToken, hashInvitationToken } from '../security/invitation-token.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { userInvitationEmail } from '../email/templates.js';
import { DEFAULT_SENDER_NAME, type EmailSender } from '../email/email.sender.js';
import type { PlatformRepository, UserInvitation } from '../platform/platform.repository.js';
import type { AppContainer } from '../container.js';
import { PlanLimitError, RoleNotAvailableInPlanError } from '../domain/errors.js';
import { resolvePlanLimits } from '../security/resolve-plan-limits.js';

const INVITATION_EXPIRES_DAYS = 7;

const InviteUserBodySchema = z.object({
  email:  z.string({ required_error: 'email es obligatorio' }).email(),
  roleId: z.string({ required_error: 'roleId es obligatorio' }).min(1),
});

function invitationExpiry(): Date {
  return new Date(Date.now() + INVITATION_EXPIRES_DAYS * 24 * 60 * 60 * 1000);
}

function buildAcceptUrl(frontendUrl: string, token: string): string {
  return `${frontendUrl}/invitaciones/aceptar?token=${encodeURIComponent(token)}`;
}

// =============================================================================
// Router de gestión — MANAGEMENT, /api/users/invitations
// =============================================================================

export function createUserInvitationsRouter(
  platformRepo: PlatformRepository,
  container: AppContainer,
  emailSender: EmailSender,
  frontendUrl: string,
): Router {
  const router = Router();

  async function dispatchInvitationEmail(req: Request, email: string, roleName: string, token: string): Promise<void> {
    const profile = await new SqlBusinessProfileRepository(req.db!).get();
    const { subject, html } = userInvitationEmail({
      businessDisplayName: profile.displayName ?? DEFAULT_SENDER_NAME,
      roleName,
      acceptUrl:     buildAcceptUrl(frontendUrl, token),
      expiresInDays: INVITATION_EXPIRES_DAYS,
    });
    await emailSender.send({
      to: email,
      fromName: profile.displayName ?? DEFAULT_SENDER_NAME,
      ...(profile.contactEmail && { replyTo: profile.contactEmail }),
      subject,
      html,
    });
  }

  // ── GET /users/invitations — pendientes del negocio ─────────────────────
  router.get('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user!.businessId as string;
      res.json(await platformRepo.listPendingInvitationsByBusiness(businessId));
    } catch (err) { next(err); }
  });

  // ── POST /users/invitations — crear + enviar mail ───────────────────────
  router.post('/', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user!.businessId as string;
      const body = InviteUserBodySchema.parse(req.body);

      const existingPending = await platformRepo.findPendingInvitationByBusinessAndEmail(businessId, body.email);
      if (existingPending) {
        res.status(409).json({
          code: 'INVITATION_ALREADY_PENDING',
          message: 'Ya hay una invitación pendiente para ese email en este negocio — reenviala en vez de crear otra.',
          invitationId: existingPending.id,
        });
        return;
      }

      const existingIdentity = await platformRepo.findIdentityByEmail(body.email);
      if (existingIdentity) {
        const alreadyMember = await platformRepo.findMembership(existingIdentity.id, businessId);
        if (alreadyMember) {
          // F2 (25/08/2026, pendientes-2026-08-25.md) -- mismo criterio que
          // POST /users: una membership desactivada no debe bloquear para
          // siempre, se reactiva en vez de reinvitar.
          if (!alreadyMember.active) {
            res.status(409).json({
              code: 'MEMBERSHIP_DEACTIVATED',
              message: 'Ese email ya tuvo una cuenta en este negocio, pero está desactivada. ' +
                'Reactivala (POST /users/:id/reactivate) en vez de invitarla de nuevo.',
              membershipId: alreadyMember.id,
            });
            return;
          }
          res.status(409).json({ code: 'MEMBERSHIP_ALREADY_EXISTS', message: 'Ese email ya es parte de este negocio.' });
          return;
        }
      }

      // roleId debe existir en ESTE negocio y no puede ser OWNER — mismo
      // criterio que POST /users (users.routes.ts).
      const role = await platformRepo.getRoleById(body.roleId, businessId);
      if (!role || !role.active) {
        res.status(422).json({ code: 'INVALID_ROLE', message: `El rol '${body.roleId}' no existe o está desactivado en este negocio.` });
        return;
      }
      if (role.name === 'OWNER') {
        res.status(422).json({ code: 'CANNOT_ASSIGN_OWNER', message: 'El rol OWNER no se puede asignar desde acá.' });
        return;
      }

      // Límite de asientos y roles por plan (F2) — mismo patrón que POST /users.
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

      const token = generateInvitationToken();
      const invitation = await platformRepo.createInvitation({
        id: randomUUID(),
        businessId,
        email: body.email,
        roleId: role.id,
        tokenHash: hashInvitationToken(token),
        invitedByIdentityId: req.user!.id,
        expiresAt: invitationExpiry(),
      });

      await dispatchInvitationEmail(req, invitation.email, role.name, token);

      res.status(201).json(invitation);
    } catch (err) {
      next(err);
    }
  });

  // ── POST /users/invitations/:id/resend ───────────────────────────────────
  router.post('/:id/resend', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user!.businessId as string;
      const invitation = await platformRepo.findInvitationByIdAndBusiness(req.params['id'] as string, businessId);
      if (!invitation || invitation.status !== 'PENDING') {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Invitación no encontrada o ya no está pendiente.' });
        return;
      }

      const token = generateInvitationToken();
      const rotated = await platformRepo.rotateInvitationToken(invitation.id, businessId, hashInvitationToken(token), invitationExpiry());
      if (!rotated) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Invitación no encontrada o ya no está pendiente.' });
        return;
      }

      await dispatchInvitationEmail(req, invitation.email, invitation.roleName, token);
      res.status(204).send();
    } catch (err) { next(err); }
  });

  // ── DELETE /users/invitations/:id — cancelar ────────────────────────────
  router.delete('/:id', authorize(Roles.MANAGEMENT), async (req: Request, res: Response, next: NextFunction) => {
    try {
      const businessId = req.user!.businessId as string;
      const revoked = await platformRepo.revokeInvitation(req.params['id'] as string, businessId);
      if (!revoked) {
        res.status(404).json({ code: 'NOT_FOUND', message: 'Invitación no encontrada o ya no está pendiente.' });
        return;
      }
      res.status(204).send();
    } catch (err) { next(err); }
  });

  return router;
}

// =============================================================================
// Router público — /api/invitations (SIN authenticate(), ver docblock)
// =============================================================================

const LookupInvitationBodySchema = z.object({
  token: z.string({ required_error: 'token es obligatorio' }).min(1),
});

const AcceptInvitationBodySchema = z.object({
  token:    z.string({ required_error: 'token es obligatorio' }).min(1),
  password: z.string().min(8, { message: 'password debe tener al menos 8 caracteres' }).optional(),
});

export function createInvitationAcceptanceRouter(
  platformRepo: PlatformRepository,
  container: AppContainer,
): Router {
  const router = Router();

  async function findValidPendingInvitation(token: string): Promise<UserInvitation | undefined> {
    const invitation = await platformRepo.findInvitationByTokenHash(hashInvitationToken(token));
    if (!invitation || invitation.status !== 'PENDING' || invitation.expiresAt.getTime() < Date.now()) {
      return undefined;
    }
    return invitation;
  }

  // ── POST /invitations/lookup — preview antes de pedir password ─────────
  router.post('/lookup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = LookupInvitationBodySchema.parse(req.body);
      const invitation = await findValidPendingInvitation(token);
      if (!invitation) {
        res.status(404).json({ code: 'INVITATION_NOT_FOUND', message: 'Invitación inválida, ya usada o vencida.' });
        return;
      }
      const existingIdentity = await platformRepo.findIdentityByEmail(invitation.email);
      res.json({
        email: invitation.email,
        businessName: invitation.businessName,
        roleName: invitation.roleName,
        requiresPassword: !existingIdentity,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /invitations/accept ────────────────────────────────────────────
  router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = AcceptInvitationBodySchema.parse(req.body);
      const invitation = await findValidPendingInvitation(body.token);
      if (!invitation) {
        res.status(404).json({ code: 'INVITATION_NOT_FOUND', message: 'Invitación inválida, ya usada o vencida.' });
        return;
      }

      let identity = await platformRepo.findIdentityByEmail(invitation.email);
      if (!identity) {
        if (!body.password) {
          res.status(400).json({ code: 'PASSWORD_REQUIRED', message: 'password es obligatorio para crear tu cuenta.' });
          return;
        }
        identity = await platformRepo.createIdentity({
          id: randomUUID(),
          email: invitation.email,
          passwordHash: await hashPassword(body.password),
        });
      }

      const alreadyMember = await platformRepo.findMembership(identity.id, invitation.businessId);
      if (!alreadyMember) {
        // Recheck de asiento — pueden haber pasado días desde que se creó
        // la invitación (ver docblock del archivo, "qué NO hace").
        const resolved = await resolvePlanLimits(container, res, invitation.businessId);
        if (!resolved) return;
        const { limits } = resolved;

        const activeStaffCount = await platformRepo.countActiveStaffMembershipsByBusiness(invitation.businessId);
        if (activeStaffCount >= limits.maxActiveMemberships) {
          res.status(402).json({
            code: 'PLAN_LIMIT_REACHED',
            message: 'El negocio alcanzó el límite de usuarios de su plan — pedile a un administrador que libere un asiento.',
          });
          return;
        }

        await platformRepo.createMembership({
          id: randomUUID(),
          identityId: identity.id,
          businessId: invitation.businessId,
          roleId: invitation.roleId,
        });
      }

      await platformRepo.markInvitationAccepted(invitation.id, identity.id);

      res.status(201).json({ email: invitation.email, businessName: invitation.businessName, requiresLogin: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
