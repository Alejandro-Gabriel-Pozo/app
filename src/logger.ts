/**
 * @file logger.ts
 * @description Logger estructurado (1.1, docs/auditoria-tecnica-infra-reservas.md
 * — 25/08/2026). Único punto de creación de `pino` en el proceso — todo el
 * resto del código importa `logger` de acá, nunca instancia `pino()` de
 * nuevo (mismo criterio que `sslConfig()` en `db/pg.client.ts`: una sola
 * fuente de verdad para la configuración).
 *
 * `NODE_ENV=production` → JSON de una línea por evento (lo que espera
 * Render/cualquier agregador de logs). Local/test → `pino-pretty`
 * (coloreado, legible en la terminal). `LOG_LEVEL` (opcional) pisa el
 * default (`info` en producción, `debug` en el resto).
 *
 * Los scripts de `src/scripts/*.ts` (CLI, corridos a mano por un humano
 * que lee la terminal) quedan A PROPÓSITO fuera de este reemplazo — con
 * `console.log` directo alcanza y sobra, no corren dentro del proceso del
 * servidor.
 */

import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (isProduction ? 'info' : 'debug'),
  ...(isProduction ? {} : {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  }),
});
