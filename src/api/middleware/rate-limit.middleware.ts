/**
 * @file rate-limit.middleware.ts
 * @description Limiters de tasa por capa de la aplicación.
 *
 * ## Estrategia de 4 capas
 *
 * 1. globalLimiter   — toda la app, baseline anti-DoS
 * 2. authLimiter     — /api/login + /register (brute-force)
 * 3. platformLimiter — /platform/* (provisioning de tenants)
 * 4. apiLimiter      — /api/* autenticado (uso normal por tenant)
 *
 * ## Por qué no un solo limiter global
 *
 * Un solo limiter de 200 req/min permitiría 200 intentos de login
 * por minuto sin problema. authLimiter baja ese techo a 10 por IP
 * en una ventana de 15 minutos, que es el vector de ataque real.
 *
 * ## trust proxy
 *
 * app.set('trust proxy', 1) ya está configurado en app.ts antes de
 * montar estos middlewares → req.ip resuelve a la IP real del cliente
 * (X-Forwarded-For de Render/Cloudflare), no a la IP interna del proxy.
 * Sin eso, todos los usuarios compartirían el mismo contador.
 *
 * ## Headers devueltos (RFC 6585 + draft-ietf-httpapi-ratelimit-headers)
 *
 * RateLimit-Limit:     límite máximo de la ventana
 * RateLimit-Remaining: requests restantes
 * RateLimit-Reset:     timestamp Unix cuando se resetea el contador
 * Retry-After:         segundos hasta que el cliente puede reintentar (solo en 429)
 */

import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';

// ---------------------------------------------------------------------------
// Handler de respuesta 429 compartido — formato consistente con errorHandler
// ---------------------------------------------------------------------------
const tooManyRequestsHandler = (
  _req: Request,
  res: Response,
  _next: unknown,
  options: { message: string },
) => {
  res.status(429).json({
    error:   'TOO_MANY_REQUESTS',
    message: options.message,
  });
};

// ---------------------------------------------------------------------------
// 1. Global limiter — baseline anti-DoS para toda la aplicación
//    500 req / 1 min por IP
// ---------------------------------------------------------------------------
export const globalLimiter = rateLimit({
  windowMs:              60 * 1_000,
  limit:                 500,
  standardHeaders:       'draft-7',
  legacyHeaders:         false,
  message:               'Demasiadas solicitudes. Intentá de nuevo en un minuto.',
  handler:               tooManyRequestsHandler,
});

// ---------------------------------------------------------------------------
// 2. Auth limiter — /api/login y /register
//    10 intentos / 15 min por IP
//    skipSuccessfulRequests: true → solo cuenta 4xx/5xx (errores reales)
//    Reduce el riesgo de bloquear a usuarios legítimos con contraseña correcta.
// ---------------------------------------------------------------------------
export const authLimiter = rateLimit({
  windowMs:               15 * 60 * 1_000,
  limit:                  10,
  standardHeaders:        'draft-7',
  legacyHeaders:          false,
  skipSuccessfulRequests: true,
  message:                'Demasiados intentos de autenticación. Esperá 15 minutos.',
  handler:                tooManyRequestsHandler,
});

// ---------------------------------------------------------------------------
// 3. Platform limiter — /platform/* (provisioning, creación de tenants)
//    30 req / 15 min por IP
//    El provisioning crea BDs en Neon → caro. Se limita más que el API normal.
// ---------------------------------------------------------------------------
export const platformLimiter = rateLimit({
  windowMs:              15 * 60 * 1_000,
  limit:                 30,
  standardHeaders:       'draft-7',
  legacyHeaders:         false,
  message:               'Demasiadas operaciones de plataforma. Esperá 15 minutos.',
  handler:               tooManyRequestsHandler,
});

// ---------------------------------------------------------------------------
// 4. API limiter — /api/* autenticado (uso normal de empleados)
//    200 req / 1 min por IP
//    Un recepcionista legítimo no supera esto; un script de scraping sí.
// ---------------------------------------------------------------------------
export const apiLimiter = rateLimit({
  windowMs:              60 * 1_000,
  limit:                 200,
  standardHeaders:       'draft-7',
  legacyHeaders:         false,
  message:               'Límite de API alcanzado. Esperá un minuto.',
  handler:               tooManyRequestsHandler,
});
