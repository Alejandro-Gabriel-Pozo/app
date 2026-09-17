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
 *
 * ## Redacción de secretos (D-02, 17/09/2026, Wave 8 del plan de ejecución
 * integral -- docs/auditoria-integral-fase15-2026-09-16.md, F9-02/F8-10)
 *
 * Hasta acá `app.ts` montaba `pinoHttp({ logger })` sin ninguna opción:
 * el serializer default de `pino-http` emite `req.headers` COMPLETO
 * (`Authorization: Bearer <jwt>`, cookies `rh_token`/`rh_customer_token`,
 * incluido el Bearer de SUPERADMIN porque `pinoHttp` se monta antes de
 * cualquier mount) y `req.url` COMPLETA (query string con PII real --
 * `GET /api/customers?email=...&name=...`) en CADA línea de tráfico.
 *
 * `redactedReqSerializer()` reemplaza el serializer default: nunca incluye
 * `headers` (no hace falta redactar lo que no se serializa) y recorta
 * `url` en el primer `?` -- mismo criterio que `error.middleware.ts`
 * (política MID-LOG-001, A7.2) ya aplica al loguear el path de un error
 * 409+, extendido acá al log de CADA request, no solo a los errores.
 * **Pérdida declarada, no efecto colateral:** se descarta
 * `remoteAddress`/`remotePort`, que el serializer default sí emitía --
 * con F9-11 abierto ("ningún evento de autenticación queda registrado")
 * era la única atribución por-request de cliente en todo el sistema. Se
 * acepta la pérdida a propósito: es PII-adyacente, y el canal que se está
 * limpiando acá es exactamente el que no debería cargar ese dato.
 *
 * ## Asimetría real entre `redact` y `serializers` frente a `pino-http`
 * (importa para no repetir el hueco de abajo con un path nuevo)
 *
 * `redact` SÍ se hereda al child logger que `pino-http` arma por request
 * (verificado: es parte del pipeline de escritura de la instancia base,
 * no algo que `pino-http` reconstruye) -- por eso `REDACT_PATHS` no
 * necesita cablearse de nuevo en `app.ts`. `serializers.req` NO se
 * hereda: `pino-http` arma SU PROPIO `req` serializer al crear el child
 * logger de cada request (verificado contra el código fuente de
 * `pino-http@11`, `logger.js::wrapChild()`/`opts.serializers` en
 * `logger.js:29-35`) y lo prioriza sobre el de la instancia base --
 * medido, no inferido: sin pasarle `serializers` a `pinoHttp()`
 * explícito en `app.ts`, la query string sigue filtrando pese a este
 * archivo. Por eso `redactedReqSerializer` se exporta y se cablea DOS
 * veces (acá y en `app.ts`), mientras que `REDACT_PATHS` solo vive acá.
 * Es una sola definición cada uno, con necesidad de cableado distinta
 * por asimetría real de la librería, no por descuido.
 *
 * `REDACT_PATHS` queda como defensa en profundidad, no como el mecanismo
 * principal para `req`/`res` -- para esos dos, la omisión del serializer
 * ya alcanza. Cubre 2 casos reales: (1) que alguien loguee `{ headers }`/
 * `{ cookie }` a mano en el futuro (hoy, verificado por grep, ningún
 * call-site de `src/` lo hace); (2) `res.headers["set-cookie"]` --
 * `pino-std-serializers`' `res` serializer (que SÍ sigue activo, no se
 * reemplazó como el de `req`) emite `res.getHeaders()` completo, y
 * `res.cookie(AUTH_COOKIE_NAME, token, ...)` -- la función que arma el
 * header vive en `auth.middleware.ts` (`setAuthCookie()`/`clearAuthCookie()`,
 * 4 call-sites ahí), pero la emiten 11 rutas reales en 6 archivos
 * (corregido 17/09/2026, gate `architecture-governor`: la cifra anterior
 * atribuía las 11 a `auth.middleware.ts` mismo, que solo define la función):
 * 9 emiten un JWT recién firmado (`business.routes.ts:218`;
 * `auth.routes.ts:178/228/273`; `me.routes.ts:93`;
 * `customer.routes.ts:389/424/461/704` -- login/refresh de staff, login de
 * negocio de SUPERADMIN, portal y magic-link) y 2 son logout que limpian la
 * cookie (`me.routes.ts:82`, `customer.routes.ts:545`). Cualquiera de las 9
 * deja el JWT recién emitido en la línea de CADA login/refresh -- un token
 * reutilizable hasta su `exp`.
 * Prescrito por la auditoría original (F9-02/F8-10) y omitido en la
 * primera vuelta de este bloque porque el banco de prueba de la
 * auditoría usaba un `GET` que nunca seteaba cookie.
 * **`REDACT_PATHS` es case-sensitive y de path exacto** -- cubre
 * `{headers:{authorization}}` pero NO `{headers:{Authorization}}` (Node
 * baja a lowercase los headers ENTRANTES, así que esto es irrelevante
 * para `pino-http`; un objeto de headers armado a mano por este proceso
 * hacia OTRO sistema, como el `Authorization: Bearer ${apiKey}` de
 * `neon-provisioning.ts:93` hacia la API de Neon, conserva su casing --
 * hoy nadie loguea ese objeto, verificado por grep, pero la cobertura de
 * esta capa no es "cualquier objeto de headers", es "ese path exacto,
 * en minúscula").
 *
 * **Lo que este cambio NO cierra, a propósito -- corregido acá porque
 * `docs/auditoria-integral-fase15-2026-09-16.md`/`fase16` afirmaban lo
 * contrario:** F8-06 (`neon-provisioning.ts:144-145` -- y un segundo
 * sitio de construcción sin documentar hasta ahora, `:101`, que dispara
 * con cualquier respuesta non-2xx de `/connection_uri` -- connection
 * string con contraseña dentro de un MENSAJE de error libre, logueado
 * con `logger.error({ err })`). Un `redact` de `pino` opera sobre paths
 * de un objeto estructurado, no puede recortar una subcadena dentro de
 * un string de mensaje. Podría redactar el path `err.message` ENTERO --
 * pero eso arrasaría el diagnóstico que la política MID-LOG-001 protege
 * en todo el resto del sistema, no es un fix aceptable para un caso
 * puntual. Ese hallazgo necesita su propio fix en el origen (no
 * construir el mensaje con la respuesta cruda que trae la contraseña),
 * no un ajuste acá. Registrado aparte en docs/pendientes-2026-09-12.md,
 * no reclamado como cerrado por este bloque.
 */

import pino from 'pino';
import type { IncomingMessage } from 'node:http';
import { isProduction as checkIsProduction, getLogLevel } from './config/env.js';

const isProduction = checkIsProduction();

/**
 * Reemplaza el `req` serializer default de `pino`/`pino-http`: nunca
 * incluye `headers` (Authorization/Cookie quedan afuera por construcción,
 * no por redacción) y recorta `url` en el primer `?` (fuera query string
 * con PII). `id` es el mismo `req.id` que `pino-http` ya generaba por
 * request (asignado por su propio middleware antes de serializar) --
 * **no es un UUID** (corregido 17/09/2026, gate `architecture-governor`,
 * segunda pasada de D-02): `pino-http@11`'s `reqIdGenFactory`
 * (`logger.js:233-239`) devuelve un entero incremental por proceso
 * (`(nextReqId + 1) & 2147483647`), no un UUID -- verificado emitiendo
 * `"id":1` en el primer request de un proceso nuevo. La misma afirmación
 * falsa preexistía en `app.ts` y se corrige en el mismo commit.
 */
export function redactedReqSerializer(req: IncomingMessage & { id?: string }): Record<string, unknown> {
  return {
    id: req.id,
    method: req.method,
    url: (req.url ?? '').split('?')[0],
  };
}

/**
 * Defensa en profundidad -- ver docblock del archivo. Exportado para que
 * `logger.test.ts` lo importe en vez de mantener una copia propia (una
 * copia inline no detecta si esta lista se queda corta de nuevo).
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  'cookie',
  'res.headers["set-cookie"]',
];

export const logger = pino({
  level: getLogLevel() ?? (isProduction ? 'info' : 'debug'),
  redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  serializers: { req: redactedReqSerializer },
  ...(isProduction ? {} : {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  }),
});
