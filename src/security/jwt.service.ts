/**
 * @file jwt.service.ts — DEPRECADO (fix C6)
 * @description Este archivo ya no tiene consumidores activos.
 *
 * platform.auth.service.ts fue modificado para firmar tokens de plataforma
 * usando signPlatformToken() de platform.auth.middleware.ts, que utiliza
 * PLATFORM_JWT_SECRET en lugar de JWT_SECRET.
 *
 * Este archivo puede eliminarse del proyecto una vez confirmado que
 * ningún import lo referencia (ver hallazgo C6 del code review).
 *
 * @deprecated Usar signPlatformToken / verifyPlatformToken para tokens
 * de plataforma, y signToken / verifyToken de auth.middleware.ts para
 * tokens de empleados y clientes.
 */

export {};
