/**
 * @file helmet.middleware.ts
 * @description Security headers para la API REST + Swagger UI.
 *
 * ## Por qué un archivo dedicado y no helmet() directo en app.ts
 *
 * La configuración de Helmet para una API con Swagger UI tiene dos contextos
 * distintos:
 *   - /docs → necesita CSP permisiva (carga JS/CSS de unpkg.com)
 *   - /api  → CSP estrictísima (no debería cargar nada externo)
 *
 * Centralizar aquí permite ajustar sin tocar app.ts.
 *
 * ## Headers aplicados
 *
 * | Header                    | Valor                          | Protege contra            |
 * |---------------------------|--------------------------------|---------------------------|
 * | Strict-Transport-Security | max-age=31536000; includeSubDomains | Downgrade a HTTP     |
 * | X-Content-Type-Options    | nosniff                        | MIME-sniffing             |
 * | X-Frame-Options           | DENY                           | Clickjacking              |
 * | X-DNS-Prefetch-Control    | off                            | DNS leak                  |
 * | Referrer-Policy           | no-referrer                    | URL leak en Referer       |
 * | Permissions-Policy        | camera=(), microphone=(), ...  | Feature abuse             |
 * | Content-Security-Policy   | ver abajo                      | XSS / data injection      |
 * | X-Powered-By              | (eliminado)                    | Fingerprinting de stack   |
 *
 * ## CSP en /docs (Swagger UI)
 *
 * Swagger UI carga recursos de CDNs externos. La CSP base de Helmet
 * bloquearía la UI completamente. Se usa una CSP permisiva SOLO en /docs:
 *
 *   default-src 'self';
 *   script-src  'self' 'unsafe-inline' https://unpkg.com;
 *   style-src   'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com;
 *   img-src     'self' data: https:;
 *   font-src    'self' https://fonts.gstatic.com;
 *
 * 'unsafe-inline' en /docs es aceptable porque Swagger UI no procesa
 * datos de usuarios — es documentación estática de la API.
 *
 * ## CSP en /api y el resto
 *
 * Una API REST pura no necesita cargar scripts externos. CSP de máxima
 * restricción:
 *
 *   default-src 'none';
 *   frame-ancestors 'none';
 *
 * Esto bloquea cualquier intento de inyección de recursos externos.
 */

import helmet from 'helmet';
import type { RequestHandler } from 'express';

// ---------------------------------------------------------------------------
// Headers comunes a toda la app (sin CSP — se define por ruta)
// ---------------------------------------------------------------------------
const baseHelmet = helmet({
  // HSTS: fuerza HTTPS por 1 año en dominio + subdominios.
  // preload: false porque no estamos registrados en la HSTS preload list.
  strictTransportSecurity: {
    maxAge:            31_536_000,
    includeSubDomains: true,
    preload:           false,
  },

  // Anti MIME-sniffing: el browser NO debe adivinar el Content-Type.
  xContentTypeOptions: true,

  // Anti clickjacking: esta API no debe embeberse en iframes.
  xFrameOptions: { action: 'deny' },

  // DNS prefetch: off para evitar leaks de rutas internas.
  xDnsPrefetchControl: { allow: false },

  // Referrer: no enviar la URL actual como Referer a externos.
  referrerPolicy: { policy: 'no-referrer' },

  // Elimina "X-Powered-By: Express" — el primer dato que lee un attacker.
  xPoweredBy: false,

  // CSP lo manejamos manualmente por ruta (ver abajo).
  contentSecurityPolicy: false,

  // Cross-Origin headers — defaults de Helmet son correctos para una API.
  crossOriginEmbedderPolicy: false, // no necesario en API pura
  crossOriginOpenerPolicy:   { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-site' },
});

// ---------------------------------------------------------------------------
// CSP para /docs — permisiva, Swagger UI necesita recursos externos
// ---------------------------------------------------------------------------
const docsCSP = helmet.contentSecurityPolicy({
  directives: {
    defaultSrc:  ["'self'"],
    scriptSrc:   ["'self'", "'unsafe-inline'", 'https://unpkg.com'],
    styleSrc:    ["'self'", "'unsafe-inline'", 'https://unpkg.com', 'https://fonts.googleapis.com'],
    imgSrc:      ["'self'", 'data:', 'https:'],
    fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
    connectSrc:  ["'self'"],
    frameAncestors: ["'none'"],
  },
});

// ---------------------------------------------------------------------------
// CSP para /api y el resto — máxima restricción
// Una API REST pura no carga ningún recurso externo.
// ---------------------------------------------------------------------------
const apiCSP = helmet.contentSecurityPolicy({
  directives: {
    defaultSrc:     ["'none'"],
    frameAncestors: ["'none'"],
  },
});

// ---------------------------------------------------------------------------
// Permissions-Policy — desactiva features del browser que no usamos.
// No es parte de Helmet core; se inyecta como header manual.
// ---------------------------------------------------------------------------
const permissionsPolicy: RequestHandler = (_req, res, next) => {
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  );
  next();
};

// ---------------------------------------------------------------------------
// Exports: tres combinaciones listas para montar en app.ts
// ---------------------------------------------------------------------------

/** Aplica headers base + CSP estricta. Usar en /api/* y rutas generales. */
export const helmetApi: RequestHandler[] = [baseHelmet, apiCSP, permissionsPolicy];

/** Aplica headers base + CSP permisiva para Swagger UI. Usar en /docs. */
export const helmetDocs: RequestHandler[] = [baseHelmet, docsCSP, permissionsPolicy];

/** Solo headers base sin CSP. Útil para /health (sin recursos externos). */
export const helmetBase: RequestHandler[] = [baseHelmet, permissionsPolicy];
