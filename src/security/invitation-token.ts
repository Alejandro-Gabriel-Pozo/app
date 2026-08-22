/**
 * @file invitation-token.ts
 * @description Token de invitación de usuario (D2, pendientes-2026-08-19.md).
 * Mismo principio que `password_hash` (user.store.ts): la base nunca
 * guarda el token en texto plano, solo su hash — si la BD se filtra, una
 * invitación pendiente no sirve para nada. `sha256` simple alcanza acá
 * (a diferencia de una password, no es un valor de baja entropía elegido
 * por una persona — son 256 bits aleatorios, no hay ataque de diccionario
 * posible, no hace falta salt ni una función costosa como pbkdf2).
 */

import { randomBytes, createHash } from 'node:crypto';

const TOKEN_BYTES = 32;

/** Token que se manda en el link del mail — nunca se persiste tal cual. */
export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** Lo que sí se persiste en `user_invitations.token_hash`. */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
