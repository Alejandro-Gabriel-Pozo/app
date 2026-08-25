/**
 * @file instrument.ts
 * @description Inicializa Sentry (1.2, docs/auditoria-tecnica-infra-reservas.md
 * — 25/08/2026, cuenta creada por el dueño). Tiene que ser el PRIMER import
 * de `server.ts`, antes que cualquier otro módulo (express, pg, etc.) —
 * Sentry instrumenta esos paquetes CommonJS enganchándose al cache de
 * `require()`, y eso solo funciona si `Sentry.init()` corrió antes de que
 * algo los importe por primera vez.
 *
 * Sin `SENTRY_DSN` seteada (dev local, o si todavía no se configuró en
 * Render), `Sentry.init()` con `dsn: undefined` deja el SDK en no-op — el
 * proceso arranca igual, no hay try/catch necesario acá (fail-open a
 * propósito, mismo criterio que RESEND_API_KEY/NEON_API_KEY en render.yaml).
 */

import * as Sentry from '@sentry/node';

Sentry.init({
  dsn:         process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV ?? 'development',
  // Trazas de performance, no solo errores -- 10% de las requests alcanza
  // para tener una idea de latencia sin pagar el volumen de mandar el 100%.
  tracesSampleRate: 0.1,
});
