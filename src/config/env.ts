/**
 * @file env.ts
 * @description Punto único de lectura de `process.env` para el proceso del
 * server (Wave 7 del plan de ejecución integral, bloque 3, D-15/P-11,
 * `docs/auditoria-integral-fase16-2026-09-16.md:539`).
 *
 * ## Por qué existe
 * Hasta este bloque, 38 accesos a `process.env` (con clave literal, medidos
 * por `src/tests/architecture/process-env-usage-count.test.ts` antes de
 * este cambio) estaban repartidos en 18 archivos, con al menos 2 casos de
 * la MISMA variable validada de forma distinta en cada sitio (`JWT_SECRET`:
 * 3 implementaciones de "tirar si falta", una sin chequear longitud mínima,
 * una sin chequear nada -- `business.routes.ts` usaba `process.env
 * .JWT_SECRET!`, sin runtime check) y 1 caso de la misma cuenta duplicada
 * carácter por carácter (`CORS_ORIGIN` → URL del frontend, en `app.ts` y en
 * `workers/outbox.registry.ts`). Ninguna decisión de diseño sostenía esas
 * diferencias -- era deriva, no intención. Este archivo no tiene
 * equivalente previo en el repo; la fuente de todo lo de abajo es la
 * lectura directa de cada call site, hecha antes de escribir esto.
 *
 * ## Regla de diseño no negociable: NADA se cachea a nivel módulo
 * Cada función de acá lee `process.env` FRESCO en cada llamada -- ninguna
 * computa un valor una sola vez al importarse. Motivo: varios tests de este
 * repo setean `process.env.X` en `beforeEach()` y recién ahí instancian el
 * servicio o llaman la función bajo prueba (ver `admin.routes.test.ts`,
 * `auth.middleware.ts` ya documentaba esto mismo para `getJwtSecret()`
 * antes de este bloque). Un `const X = process.env.X` a nivel módulo de
 * ESTE archivo se evaluaría en el momento en que Node importa `env.ts` por
 * primera vez -- casi siempre ANTES de que cualquier test tuviera
 * oportunidad de setear la variable -- y quedaría pegado a `undefined` para
 * el resto del proceso. Centralizar el LUGAR de lectura no debe cambiar el
 * MOMENTO de lectura (auditado explícitamente antes de escribir este
 * archivo, ver `docs/pendientes-2026-09-12.md`). Los módulos que ya leían
 * al nivel de su propio import (`logger.ts`, `tenant.middleware.ts`,
 * `server.ts`) siguen haciéndolo al mismo momento que antes -- llaman una
 * función de acá desde su propio top-level, en vez de leer `process.env`
 * directo; el momento no cambia, solo el lugar.
 *
 * ## Qué NO vive acá, a propósito
 * - `src/instrument.ts` -- lee `SENTRY_DSN`/`NODE_ENV` antes de inicializar
 *   Sentry, que tiene que correr antes que CUALQUIER otro módulo (incluido
 *   este) para poder capturar errores de carga de los demás. Depender de
 *   `env.ts` ahí invertiría esa precedencia.
 * - `src/scripts/**` -- CLI standalone, fuera del proceso del server
 *   (`docs/auditoria-integral-fase16-2026-09-16.md:541`).
 * - `src/api/docs-exposure.ts::shouldExposeApiDocs()` -- ya usaba un
 *   patrón MEJOR que el de acá para su caso puntual: recibe el entorno
 *   como parámetro inyectable (`env: NodeJS.ProcessEnv = process.env`),
 *   verificable en tests sin mutar estado global. Forzarlo a pasar por una
 *   función de acá sería downgrade, no mejora -- exención permanente, no
 *   pendiente de cerrar (gate `architecture-governor`, condición C7,
 *   16/09/2026, decisión explícita, no omisión).
 * - Tests (`*.test.ts`, `src/tests/**`) -- infraestructura de test, no
 *   superficie de configuración de producción.
 *
 * ## Consolidaciones hechas en este mismo bloque (no solo mover código)
 * - `JWT_SECRET`: las 4 validaciones distintas (2 completas, 1 sin chequeo
 *   de longitud, 1 sin chequeo de nada) se reemplazan por UNA sola,
 *   `getJwtSecret()` (movida acá desde `auth.middleware.ts`, que la
 *   exportaba). `business.routes.ts` pasa a validar por primera vez --
 *   antes de este cambio, un `JWT_SECRET` corto o ausente ahí emitía un
 *   token que `auth.middleware.ts::getJwtSecret()` iba a rechazar en la
 *   primera request autenticada, con un error confuso y tardío; ahora
 *   falla en el momento del alta, con el mensaje real. No es un cambio de
 *   comportamiento del camino feliz -- `JWT_SECRET` siempre tuvo que
 *   cumplir el mismo contrato para que el login funcionara.
 * - `JWT_EXPIRES_IN`: 3 call sites idénticos
 *   (`parseExpiresIn(process.env.JWT_EXPIRES_IN ?? '24h')`) se reemplazan
 *   por `getJwtExpiresInRaw()`, una sola vez.
 * - `PLATFORM_JWT_SECRET`: mismo patrón que `JWT_SECRET` (movida desde
 *   `platform.auth.middleware.ts`).
 * - `CORS_ORIGIN` → URL del frontend: `app.ts` y `workers/outbox.registry.ts`
 *   tenían la MISMA expresión (`CORS_ORIGIN && CORS_ORIGIN !== '*' ? ... :
 *   'http://localhost:3000'`) duplicada carácter por carácter →
 *   `getFrontendOrigin()`, una sola vez.
 * - `GOOGLE_CLIENT_ID`: movida desde `google-oauth.ts` (misma validación,
 *   sin cambios de comportamiento).
 *
 * ## Lo que NO se consolida en este bloque (deliberado, fuera de alcance)
 * - `NEON_API_KEY`/`NEON_PROJECT_ID`/`NEON_TEMPLATE_BRANCH_ID`
 *   (`neon-provisioning.ts`) SÍ se migran acá (cerraban uno de los 2
 *   blind spots de la cerca de conteo, gate 16/09/2026) -- pero el
 *   `NeonProvisioningError` que lanza `requireEnv()` queda en
 *   `neon-provisioning.ts`, no acá: este archivo no conoce tipos de error
 *   de dominios ajenos.
 * - `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD`/`RESEND_API_KEY`/
 *   `RESEND_FROM_EMAIL`: exponen getters RAW (sin validar) acá -- la
 *   decisión de qué hacer si faltan (503 fail-closed en un caso, fail-open
 *   con `NoopEmailSender` en el otro) sigue siendo de cada archivo dueño,
 *   documentada ahí, no acá.
 * - `business.routes.ts` sigue con `EXPIRES_IN_SECONDS = 86_400` HARDCODEADO
 *   para el token del alta pública -- moverlo a `getJwtExpiresInRaw()`
 *   (respetando `JWT_EXPIRES_IN` configurado) es un cambio de
 *   comportamiento observable declarado a propósito, alcance del bloque 4
 *   ("3 bloques chicos"), no de este.
 *
 * SI ESTO ROMPE (`process-env-usage-count.test.ts`): agregaste un acceso a
 * `process.env` fuera de este archivo y las zonas exentas de arriba.
 * Agregalo ACÁ, no en el call site.
 */

// ---------------------------------------------------------------------------
// Helpers internos de parseo -- sin estado, sin caché.
// ---------------------------------------------------------------------------

function readIntEnv(name: string, fallback: number): number {
  return parseInt(process.env[name] ?? String(fallback), 10);
}

// ---------------------------------------------------------------------------
// Entorno / runtime
// ---------------------------------------------------------------------------

export function getNodeEnv(): string | undefined {
  return process.env.NODE_ENV;
}

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function getPort(): number {
  return readIntEnv('PORT', 3000);
}

export function getLogLevel(): string | undefined {
  return process.env.LOG_LEVEL;
}

export function getHealthDbTtlMs(): number {
  return readIntEnv('HEALTH_DB_TTL_MS', 30_000);
}

export function getHealthDbFailTtlMs(): number {
  return readIntEnv('HEALTH_DB_FAIL_TTL_MS', 5_000);
}

// ---------------------------------------------------------------------------
// CORS / origen del frontend
// ---------------------------------------------------------------------------

export function getCorsOrigin(): string | undefined {
  return process.env.CORS_ORIGIN;
}

/**
 * Valor listo para pasarle a la opción `origin` de `cors()` -- `app.ts` es
 * el único consumidor de esta forma exacta (`false` en producción sin
 * `CORS_ORIGIN`, para no reflejar cualquier origen).
 */
export function getCorsOriginSetting(): string | false {
  return process.env.CORS_ORIGIN ?? (isProduction() ? false : '*');
}

/**
 * URL base del frontend para links que arma el propio proceso (mails de
 * invitación, aviso de dead-letter) -- reusa `CORS_ORIGIN` en vez de sumar
 * una segunda variable con el mismo dominio adentro (ver `render.yaml`).
 * Antes de este bloque, `app.ts` y `workers/outbox.registry.ts` tenían esta
 * misma expresión duplicada carácter por carácter.
 */
export function getFrontendOrigin(): string {
  const corsOrigin = process.env.CORS_ORIGIN;
  return corsOrigin && corsOrigin !== '*' ? corsOrigin : 'http://localhost:3000';
}

// ---------------------------------------------------------------------------
// Bases de datos
// ---------------------------------------------------------------------------

export function getPlatformDatabaseUrl(): string | undefined {
  return process.env.PLATFORM_DATABASE_URL;
}

/** Mismo mensaje que ya usaban los 2 call sites de `container.ts`. */
export function requirePlatformDatabaseUrl(): string {
  const rawUrl = process.env.PLATFORM_DATABASE_URL;
  if (!rawUrl) {
    throw new Error(
      '[container] PLATFORM_DATABASE_URL no está definida. ' +
      'Configurá la variable de entorno en Render Dashboard → Environment Variables.',
    );
  }
  return rawUrl;
}

/**
 * `DATABASE_URL` sin prefijo -- LECTOR que sigue vivo en `db/pg.client.ts`
 * después de que D-06 (Wave 7) retiró el único ESCRITOR
 * (`repair-tenant-db`). Residuo declarado, no resuelto por este bloque:
 * `INCIDENT_LOG_2026-08-08.md:119` sigue en falso mientras este lector
 * exista -- ver `docs/pendientes-2026-09-12.md`.
 */
export function getDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL;
}

export function getNeonSsl(): boolean {
  return process.env.NEON_SSL === 'true';
}

export function getDbPoolMax(): number {
  return readIntEnv('DB_POOL_MAX', 10);
}

export function getDbPoolIdleMs(): number {
  return readIntEnv('DB_POOL_IDLE_MS', 30_000);
}

export function getMaxTenantPools(): number {
  return readIntEnv('MAX_TENANT_POOLS', 200);
}

export function getDbEncryptionKey(): string | undefined {
  return process.env.DB_ENCRYPTION_KEY;
}

export function getDbEncryptionKeyOld(): string | undefined {
  return process.env.DB_ENCRYPTION_KEY_OLD;
}

// ---------------------------------------------------------------------------
// JWT -- staff (tenant) y plataforma
// ---------------------------------------------------------------------------

/**
 * Lee y valida `JWT_SECRET` en el momento de llamarse (no al importar este
 * módulo). Canónica desde este bloque -- antes de él, `auth.middleware.ts`,
 * `auth.service.ts` y `customer.auth.service.ts` tenían 3 validaciones
 * ligeramente distintas de la MISMA variable, y `business.routes.ts` no
 * validaba nada (`process.env.JWT_SECRET!`). Ver el docblock de archivo
 * para el detalle de la consolidación.
 */
export function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('[env] JWT_SECRET no está definida.');
  if (secret.length < 32) throw new Error('[env] JWT_SECRET debe tener al menos 32 caracteres.');
  return secret;
}

/** `parseExpiresIn()` vive en `security/auth.service.ts` -- este archivo no
 * duplica el parser, solo el acceso a la variable que lo alimenta. */
export function getJwtExpiresInRaw(): string {
  return process.env.JWT_EXPIRES_IN ?? '24h';
}

export function getPlatformJwtSecret(): string {
  const secret = process.env.PLATFORM_JWT_SECRET;
  if (!secret) throw new Error('[env] PLATFORM_JWT_SECRET no está definida.');
  if (secret.length < 32) throw new Error('[env] PLATFORM_JWT_SECRET debe tener al menos 32 caracteres.');
  return secret;
}

export function getPlatformAdminEmail(): string | undefined {
  return process.env.PLATFORM_ADMIN_EMAIL;
}

export function getPlatformAdminPassword(): string | undefined {
  return process.env.PLATFORM_ADMIN_PASSWORD;
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

export function getGoogleClientId(): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    throw new Error('[env] GOOGLE_CLIENT_ID no está definida — login con Google no configurado todavía.');
  }
  return clientId;
}

// ---------------------------------------------------------------------------
// Mail (Resend)
// ---------------------------------------------------------------------------

export function getResendApiKey(): string | undefined {
  return process.env.RESEND_API_KEY;
}

export function getResendFromEmail(): string | undefined {
  return process.env.RESEND_FROM_EMAIL;
}

// ---------------------------------------------------------------------------
// Neon -- aprovisionamiento de tenant DB
// ---------------------------------------------------------------------------

export function getNeonApiKey(): string | undefined {
  return process.env.NEON_API_KEY;
}

export function getNeonProjectId(): string | undefined {
  return process.env.NEON_PROJECT_ID;
}

export function getNeonTemplateBranchId(): string | undefined {
  return process.env.NEON_TEMPLATE_BRANCH_ID;
}
