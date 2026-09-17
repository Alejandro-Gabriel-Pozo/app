/**
 * @file password-reset.routes.ts
 * @description Reseteo de contraseña — flujo completo, público.
 *
 * - `POST /request` (L, 23/08/2026, self-service) — "olvidé mi
 *   contraseña", sin sesión, sin admin de por medio. Complementa
 *   `POST /users/:id/password-reset-link` (users.routes.ts, MANAGEMENT) —
 *   ese lo dispara un admin sobre OTRA persona; este lo dispara la propia
 *   persona sobre sí misma.
 * - `POST /lookup` / `POST /accept` (K1, 23/08/2026) — acepta el token que
 *   llega en el link, sea cual sea el endpoint que lo generó.
 *
 * Router PÚBLICO, montado en `/api/password-resets` ANTES de authenticate()
 * — mismo motivo que `/api/invitations`: quien todavía no puso su
 * contraseña nueva no tiene ningún JWT. El token viaja siempre en el BODY
 * de los POST, nunca en la URL/query string de esta API (A7.2) — el link
 * del MAIL sí lo lleva en su query string, apunta al FRONTEND, no acá.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { generatePasswordResetToken, hashPasswordResetToken } from '../security/password-reset-token.js';
import { hashPassword } from '../security/user.store.js';
import { passwordResetEmail } from '../email/templates.js';
import { DEFAULT_SENDER_NAME, type EmailSender } from '../email/email.sender.js';
import { SqlBusinessProfileRepository } from '../repositories/sql.business-profile.repository.js';
import { getTenantClient } from '../platform/tenant.middleware.js';
import type { PlatformRepository, PasswordResetToken } from '../platform/platform.repository.js';
import { logger } from '../logger.js';

/** Más corto que los 7 días de invitación — acá ya existe una cuenta activa. */
export const PASSWORD_RESET_EXPIRES_HOURS = 24;

export function buildPasswordResetUrl(frontendUrl: string, token: string): string {
  return `${frontendUrl}/restablecer-contrasena/confirmar?token=${encodeURIComponent(token)}`;
}

/**
 * Compone y manda el mail de reseteo — compartido entre el link disparado
 * por un admin (`users.routes.ts`, ya tiene `req.db` del negocio) y el
 * pedido self-service de acá (sin sesión, sin `req.db` — ver
 * `resolveBusinessBranding` más abajo). `business` ya resuelto por el
 * caller para no acoplar esta función a CÓMO se consiguió.
 */
export async function sendPasswordResetEmail(
  emailSender: EmailSender,
  frontendUrl: string,
  toEmail: string,
  token: string,
  business: { displayName: string | null; contactEmail?: string | null } | null,
): Promise<void> {
  const senderName = business?.displayName ?? DEFAULT_SENDER_NAME;
  const { subject, html } = passwordResetEmail({
    businessDisplayName: senderName,
    resetUrl:       buildPasswordResetUrl(frontendUrl, token),
    expiresInHours: PASSWORD_RESET_EXPIRES_HOURS,
  });
  await emailSender.send({
    to: toEmail,
    fromName: senderName,
    ...(business?.contactEmail && { replyTo: business.contactEmail }),
    subject,
    html,
  });
}

const RequestPasswordResetBodySchema = z.object({
  email: z.string({ required_error: 'email es obligatorio' }).email(),
});

const LookupPasswordResetBodySchema = z.object({
  token: z.string({ required_error: 'token es obligatorio' }).min(1),
});

const AcceptPasswordResetBodySchema = z.object({
  token:       z.string({ required_error: 'token es obligatorio' }).min(1),
  newPassword: z.string({ required_error: 'newPassword es obligatorio' }).min(8, {
    message: 'newPassword debe tener al menos 8 caracteres',
  }),
});

/**
 * Mismo mensaje/forma de respuesta exista o no exista el email — A7.1/A7.2
 * y el mismo criterio que `AuthService.login()` (docblock de
 * `auth.service.ts`): revelar la diferencia es una superficie de
 * enumeración de cuentas. A diferencia del login, acá no hace falta un
 * hash dummy para tiempo constante (no hay verificación de contraseña de
 * por medio, las consultas son todas rápidas) — alcanza con que la
 * respuesta externa sea siempre idéntica.
 */
const GENERIC_REQUEST_RESPONSE = {
  message: 'Si el email existe, vas a recibir un link para restablecer tu contraseña.',
};

export function createPasswordResetRouter(
  platformRepo: PlatformRepository,
  emailSender: EmailSender,
  frontendUrl: string,
): Router {
  const router = Router();

  /**
   * Resuelve el nombre del negocio para el mail SOLO cuando hay exactamente
   * una membership activa (mismo criterio que el login para auto-resolver
   * negocio, `AuthService.resolveLoginOutcome`) — con 0 o 2+, no hay un
   * negocio único al que atribuirle la marca del mail, cae a
   * DEFAULT_SENDER_NAME. `getTenantClient` (no `req.db`: acá no hay sesión,
   * no pasó por tenantMiddleware) resuelve la conexión a la BD de ESE
   * negocio puntual.
   */
  async function resolveBusinessBranding(
    identityId: string,
  ): Promise<{ displayName: string | null; contactEmail?: string | null; businessId: string | null }> {
    const memberships = await platformRepo.findActiveMembershipsByIdentityId(identityId);
    if (memberships.length !== 1) return { displayName: null, businessId: null };

    const businessId = memberships[0]!.businessId;
    try {
      const client = await getTenantClient(businessId, platformRepo);
      const profile = await new SqlBusinessProfileRepository(client).get();
      return { displayName: profile.displayName, contactEmail: profile.contactEmail, businessId };
    } catch (err) {
      // Negocio suspendido/sin BD lista/lo que sea -- no es motivo para
      // fallar el pedido de reseteo entero, cae a DEFAULT_SENDER_NAME.
      logger.error({ err, businessId }, '[password-resets/request] no se pudo resolver el negocio para el mail');
      return { displayName: null, businessId };
    }
  }

  // ── POST /password-resets/request — self-service, L (23/08/2026) ───────────
  router.post('/request', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email } = RequestPasswordResetBodySchema.parse(req.body);

      // Deliberadamente sin `await` bloqueante del resultado hacia la
      // respuesta -- cualquier fallo interno (identity no existe, mail no
      // sale) se loguea pero NUNCA cambia la respuesta externa (anti-
      // enumeración, ver GENERIC_REQUEST_RESPONSE).
      try {
        const identity = await platformRepo.findIdentityByEmail(email);
        if (identity) {
          const branding = await resolveBusinessBranding(identity.id);
          const token = generatePasswordResetToken();
          const resetToken = await platformRepo.upsertPasswordResetToken({
            id: randomUUID(),
            identityId: identity.id,
            // Self-service: lo pide la propia persona, no un admin sobre
            // otra -- a diferencia de POST /users/:id/password-reset-link.
            requestedByIdentityId: identity.id,
            businessId: branding.businessId,
            tokenHash: hashPasswordResetToken(token),
            expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRES_HOURS * 60 * 60 * 1000),
          });
          await sendPasswordResetEmail(emailSender, frontendUrl, resetToken.identityEmail, token, branding);
        }
      } catch (err) {
        logger.error({ err }, '[password-resets/request] fallo interno, respuesta genérica igual');
      }

      res.json(GENERIC_REQUEST_RESPONSE);
    } catch (err) {
      next(err);
    }
  });

  async function findValidPendingToken(token: string): Promise<PasswordResetToken | undefined> {
    const resetToken = await platformRepo.findPasswordResetTokenByHash(hashPasswordResetToken(token));
    if (!resetToken || resetToken.status !== 'PENDING' || resetToken.expiresAt.getTime() < Date.now()) {
      return undefined;
    }
    return resetToken;
  }

  // ── POST /password-resets/lookup — preview antes de pedir la contraseña nueva ──
  router.post('/lookup', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { token } = LookupPasswordResetBodySchema.parse(req.body);
      const resetToken = await findValidPendingToken(token);
      if (!resetToken) {
        res.status(404).json({ code: 'PASSWORD_RESET_NOT_FOUND', message: 'Link inválido, ya usado o vencido.' });
        return;
      }
      res.json({ email: resetToken.identityEmail });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /password-resets/accept ────────────────────────────────────────
  router.post('/accept', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = AcceptPasswordResetBodySchema.parse(req.body);
      const resetToken = await findValidPendingToken(body.token);
      if (!resetToken) {
        res.status(404).json({ code: 'PASSWORD_RESET_NOT_FOUND', message: 'Link inválido, ya usado o vencido.' });
        return;
      }

      await platformRepo.updateIdentityPassword(resetToken.identityId, await hashPassword(body.newPassword));
      await platformRepo.markPasswordResetTokenUsed(resetToken.id);

      res.json({ email: resetToken.identityEmail, requiresLogin: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
