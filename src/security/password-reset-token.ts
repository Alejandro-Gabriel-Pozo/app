/**
 * @file password-reset-token.ts
 * @description Token de reseteo de contraseña (K1, 23/08/2026,
 * pendientes-2026-08-23.md). Módulo aparte de `invitation-token.ts` a
 * propósito — mismo criterio que el resto del repo, un módulo por tipo de
 * token, no compartir semántica entre invitación y reseteo aunque la
 * implementación sea idéntica. Mismo principio que `password_hash`
 * (user.store.ts): la base nunca guarda el token en texto plano, solo su
 * hash — 256 bits aleatorios, sin ataque de diccionario posible, no hace
 * falta salt ni una función costosa como pbkdf2 (igual que
 * invitation-token.ts).
 */

import { randomBytes, createHash } from 'node:crypto';

const TOKEN_BYTES = 32;

/** Token que se manda en el link del mail — nunca se persiste tal cual. */
export function generatePasswordResetToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Lo que sí se persiste en `password_reset_tokens.token_hash`. */
export function hashPasswordResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
