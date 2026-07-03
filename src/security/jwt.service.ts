/**
 * @file jwt.service.ts
 * @description Wrapper de clase sobre las funciones `signToken` / `verifyToken`
 * de `auth.middleware.ts`.
 *
 * Existe para que `platform.auth.service.ts` (y cualquier servicio que
 * necesite emitir tokens sin depender directamente del middleware de Express)
 * pueda instanciar un objeto `JwtService` con una interfaz orientada a objetos.
 *
 * La implementación real sigue viviendo en `auth.middleware.ts` — este archivo
 * solo expone esa lógica como una clase inyectable.
 */

import { signToken, verifyToken, JwtPayload } from './auth.middleware.js';

export type { JwtPayload };

export class JwtService {
  /**
   * Firma un nuevo JWT.
   *
   * @param payload    - Claims adicionales (sin iat/exp — se agregan aquí)
   * @param subject    - Valor del claim `sub`
   * @param expiresIn  - TTL en segundos (default 86 400 = 24 h)
   * @returns JWT firmado con HS256
   */
  async sign(
    payload: Record<string, unknown>,
    subject: string,
    expiresIn = 86_400,
  ): Promise<string> {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('[JwtService] JWT_SECRET no está definida.');

    return signToken(
      { sub: subject, ...payload } as Omit<JwtPayload, 'iat' | 'exp'>,
      secret,
      expiresIn,
    );
  }

  /**
   * Verifica y decodifica un JWT.
   *
   * @throws Error con code JWT_EXPIRED | JWT_INVALID_SIGNATURE | JWT_MALFORMED
   */
  verify(token: string): JwtPayload {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('[JwtService] JWT_SECRET no está definida.');
    return verifyToken(token, secret);
  }
}
