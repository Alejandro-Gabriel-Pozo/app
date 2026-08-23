/**
 * @file password-reset.routes.ts
 * @description Aceptación pública de un link de reseteo de contraseña (K1,
 * 23/08/2026, pendientes-2026-08-23.md). Complementa
 * `POST /users/:id/password-reset-link` (users.routes.ts, MANAGEMENT) —
 * ese endpoint dispara el mail, este acepta el token que llega en el link.
 *
 * Router PÚBLICO, montado en `/api/password-resets` ANTES de authenticate()
 * — mismo motivo que `/api/invitations`: quien todavía no puso su
 * contraseña nueva no tiene ningún JWT. El token viaja siempre en el BODY
 * de los POST, nunca en la URL/query string de esta API (A7.2) — el link
 * del MAIL sí lo lleva en su query string, apunta al FRONTEND, no acá.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { z, ZodError } from 'zod';
import { hashPasswordResetToken } from '../security/password-reset-token.js';
import { hashPassword } from '../security/user.store.js';
import type { PlatformRepository, PasswordResetToken } from '../platform/platform.repository.js';

const LookupPasswordResetBodySchema = z.object({
  token: z.string({ required_error: 'token es obligatorio' }).min(1),
});

const AcceptPasswordResetBodySchema = z.object({
  token:       z.string({ required_error: 'token es obligatorio' }).min(1),
  newPassword: z.string({ required_error: 'newPassword es obligatorio' }).min(8, {
    message: 'newPassword debe tener al menos 8 caracteres',
  }),
});

export function createPasswordResetAcceptanceRouter(platformRepo: PlatformRepository): Router {
  const router = Router();

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
      if (err instanceof ZodError) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Datos inválidos', errors: err.flatten() });
        return;
      }
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
      if (err instanceof ZodError) {
        res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Datos inválidos', errors: err.flatten() });
        return;
      }
      next(err);
    }
  });

  return router;
}
