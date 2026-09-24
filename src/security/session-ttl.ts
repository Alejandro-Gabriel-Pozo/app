/**
 * @file session-ttl.ts
 * @description Resolución de TTL de sesión por tenant/audiencia — Wave 15
 * item 1 (24/09/2026, P-02(D-04)+D-07,
 * docs/diseno-wave15-sesion-saga-aprovisionamiento-2026-09-24.md §1).
 *
 * ## Qué resuelve, y qué NO resuelve (leer antes de usar)
 *
 * Esto es infraestructura de TTL: hace que la vida máxima de una sesión sea
 * configurable por tenant/audiencia en vez de una única constante fija
 * (`JWT_EXPIRES_IN`). **NO produce un idle-timeout real** — eso depende de
 * que el frontend llame a `/refresh` en respuesta a actividad genuina del
 * usuario (mouse/teclado/fetch), no en un timer de fondo mientras la
 * pestaña sigue abierta (estado actual de `AuthContext`, ver el docblock de
 * `api/routes/me.routes.ts::POST /api/auth/refresh`). Sin ese cambio en
 * `appfrontend-main` — fuera del alcance de este repo — achicar el TTL
 * resuelto acá acorta la sesión, pero no la hace expirar por inactividad
 * real: sigue siendo "la sesión sobrevive mientras la pestaña esté
 * abierta", una propiedad más corta pero distinta de un idle-timeout.
 * No describir este mecanismo como "idle timeout implementado" en ningún
 * lado — es TTL configurable, la pieza de detección de inactividad real
 * queda pendiente y no es alcanzable desde este repo.
 *
 * ## Mecanismo
 *
 * `businesses.session_ttl_seconds` (nullable, `platform.schema.sql`) es el
 * override por negocio. `NULL` = sin override, se usa la constante de
 * producto (`JWT_EXPIRES_IN` vía `parseExpiresIn()`, `auth.service.ts`).
 * Para `audience === 'platform'` (superadmin, sin `businessId`) o cuando no
 * se pasa `businessId`, siempre se devuelve el fallback — no hay concepto
 * de "por tenant" sin tenant.
 *
 * Wireado, por ahora, únicamente en los dos endpoints de refresh que ya
 * existían (`POST /api/auth/refresh`, `POST /api/customer/refresh`) — no en
 * la emisión de login/selectBusiness/loginWithGoogle, que siguen usando el
 * TTL fijo tal cual. Ampliar el alcance a esos otros call-sites es una
 * decisión de producto aparte, no incluida en este bloque.
 */

import type { PlatformRepository } from '../platform/platform.repository.js';

export type SessionAudience = 'staff' | 'customer' | 'platform';

/**
 * @param platformRepo - repo de la BD central, para leer el override del
 *   negocio (`businesses.session_ttl_seconds`).
 * @param audience - `'platform'` nunca tiene override (el superadmin no
 *   tiene `businessId`).
 * @param fallbackSeconds - TTL a usar si no hay override — el caller ya lo
 *   tiene resuelto (`parseExpiresIn(getJwtExpiresInRaw())`, típicamente
 *   cacheado en el constructor del servicio de auth), así esta función no
 *   necesita importar `auth.service.ts` de vuelta (evita un ciclo de
 *   módulos: `auth.service.ts` es quien llama a esta función).
 * @param businessId - ausente para `audience === 'platform'`.
 */
export async function resolveSessionTtl(
  platformRepo: PlatformRepository,
  audience: SessionAudience,
  fallbackSeconds: number,
  businessId?: string,
): Promise<number> {
  if (audience === 'platform' || !businessId) return fallbackSeconds;
  const override = await platformRepo.getSessionTtlSeconds(businessId);
  return override ?? fallbackSeconds;
}
