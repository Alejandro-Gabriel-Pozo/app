/**
 * @file google-oauth.ts
 * @description Verificación server-side de ID tokens de Google Identity
 * Services (punto 5/E5, pendientes-2026-08-15.md) — sin SDK, mismo
 * criterio que el JWT propio hecho a mano con `node:crypto`
 * (auth.middleware.ts): el protocolo (JWT RS256 + JWKS) es estándar y no
 * amerita una dependencia nueva.
 *
 * ## Flujo (Google Identity Services, no OAuth code exchange)
 * El frontend usa el botón de Google, que devuelve un ID token (JWT RS256
 * firmado por Google) directo al browser — no hace falta client_secret ni
 * un intercambio de código en el backend. Acá solo se VERIFICA ese token:
 * 1. Decodificar el header (sin verificar) para sacar el `kid`.
 * 2. Buscar la clave pública correspondiente en el JWKS de Google
 *    (cacheado — Google rota las claves cada tanto, no en cada request).
 * 3. Verificar la firma RS256 con esa clave (`crypto.verify`, soporta
 *    JWK nativo desde Node 16+, sin parsear PEM a mano).
 * 4. Validar `exp`, `iss` y `aud` (`GOOGLE_CLIENT_ID` — obligatoria; sin
 *    esto CUALQUIER token de Google válido para OTRA app pasaría acá).
 *
 * ## Sin credenciales todavía
 * `GOOGLE_CLIENT_ID` no configurada → error explícito al primer intento
 * de login, no al arrancar el proceso (mismo criterio lazy que
 * `getJwtSecret()`). A diferencia del mail (fail-open), esto es un camino
 * de autenticación — fail-closed acá es lo correcto.
 */

import { createPublicKey, createVerify } from 'node:crypto';
import { getGoogleClientId } from '../config/env.js';

export interface GoogleIdentity {
  /** ID estable de la cuenta de Google — nunca cambia, a diferencia del email. */
  sub: string;
  /** Google solo deja crear el ID token si el email ya está verificado del lado de Google. */
  email: string;
  /**
   * A7.3 (criterios-negocio.md, minimización): se expone SOLO porque el
   * alta de un customer nuevo por Google necesita un displayName real (es
   * un campo obligatorio y USADO en toda la UI, no un extra) — no se usa
   * para nada más (staff no lo toca, no se persiste ningún otro claim del
   * token). `undefined` si Google no lo mandó.
   */
  name: string | undefined;
}

interface GoogleJwk {
  kid: string;
  n: string;
  e: string;
  kty: string;
  alg: string;
}

const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
const JWKS_CACHE_TTL_MS = 60 * 60 * 1_000; // Google rota las claves con poca frecuencia -- 1h alcanza.

/**
 * D-20 (17/09/2026, Wave 9 -- docs/auditoria-integral-fase15-2026-09-16.md:579-599).
 * Camino de login -- de las 3 contrapartes no-AFIP de este bloque, la más
 * sensible a latencia: un JWKS colgado cuelga el login (la cache mitiga
 * el caso repetido, no el primero ni un `forceRefresh`). El endpoint de
 * Google normalmente responde en milisegundos -- 5s es margen, no un
 * default sin pensar.
 */
const GOOGLE_JWKS_TIMEOUT_MS = 5_000;

let jwksCache: { keys: GoogleJwk[]; fetchedAt: number } | undefined;

async function getGoogleJwks(forceRefresh = false): Promise<GoogleJwk[]> {
  if (!forceRefresh && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return jwksCache.keys;
  }

  let res: Response;
  try {
    res = await fetch(JWKS_URL, { signal: AbortSignal.timeout(GOOGLE_JWKS_TIMEOUT_MS) });
  } catch (err) {
    // Deliberadamente NO se mapea a GOOGLE_TOKEN_INVALID (googleTokenInvalidError):
    // un timeout es una falla de DISPONIBILIDAD de Google, no un token de
    // cliente inválido -- mismo criterio que la rama !res.ok de abajo, que
    // ya lanzaba un Error plano en vez de GOOGLE_TOKEN_INVALID. Sin `code`,
    // auth.routes.ts/customer.routes.ts caen a next(err) -> 500, no 401.
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`[google-oauth] JWKS de Google no respondió en ${GOOGLE_JWKS_TIMEOUT_MS}ms`, { cause: err });
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`[google-oauth] No se pudo obtener el JWKS de Google (status ${res.status})`);
  }
  // LIMITACIÓN declarada (D-20, gate 17/09/2026): el try/catch de arriba
  // cubre solo la fase de headers. Si el signal vence MIENTRAS se lee el
  // body, el TimeoutError (DOMException) sale por acá SIN envolver --
  // verificado con un servidor local que manda headers y no cierra el
  // body. No cambia el comportamiento observable (sigue sin `code`, o sea
  // 500 y no 401), solo pierde contexto en el mensaje. Mover la lectura
  // del body adentro del try es un bloque aparte: necesita test propio.
  const body = (await res.json()) as { keys: GoogleJwk[] };
  jwksCache = { keys: body.keys, fetchedAt: Date.now() };
  return body.keys;
}

/**
 * Solo para tests. La cache es a nivel de módulo a propósito en producción
 * (no pegarle a Google en cada login) — pero eso mismo hace que, sin este
 * reset, un test que mockea el JWKS con una clave nueva silenciosamente
 * termine verificando contra la clave cacheada de OTRO test anterior (el
 * `kid` de prueba se repite entre tests). Descubierto escribiendo estos
 * mismos tests (15/08/2026): sin el reset, 6 de 7 casos "pasaban" por la
 * razón equivocada (cualquier fallo de firma devuelve el mismo código de
 * error, así que un mismatch de cache y un token realmente inválido eran
 * indistinguibles para las aserciones).
 */
export function __resetGoogleJwksCacheForTests(): void {
  jwksCache = undefined;
}

function base64UrlDecode(input: string): Buffer {
  const padded = input + '==='.slice((input.length + 3) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Verifica un ID token de Google Identity Services.
 * @throws Error con `code: 'GOOGLE_TOKEN_INVALID'` si la firma/claims no son válidas.
 */
export async function verifyGoogleIdToken(idToken: string): Promise<GoogleIdentity> {
  const clientId = getGoogleClientId();

  const parts = idToken.split('.');
  if (parts.length !== 3) throw googleTokenInvalidError('Token malformado');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  let header: { kid?: string; alg?: string };
  let payload: {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    iss?: string;
    aud?: string;
    exp?: number;
  };
  try {
    header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
  } catch {
    throw googleTokenInvalidError('Token malformado');
  }

  if (header.alg !== 'RS256' || !header.kid) throw googleTokenInvalidError('Algoritmo/kid inesperado');

  let jwks = await getGoogleJwks();
  let jwk = jwks.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Google puede haber rotado las claves después del último fetch cacheado
    // -- un solo reintento forzando refresh antes de rechazar de verdad.
    jwks = await getGoogleJwks(true);
    jwk = jwks.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw googleTokenInvalidError('Clave de verificación desconocida (JWKS)');

  const publicKey = createPublicKey({ key: { ...jwk, kty: 'RSA' }, format: 'jwk' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  const validSignature = verifier.verify(publicKey, base64UrlDecode(signatureB64));
  if (!validSignature) throw googleTokenInvalidError('Firma inválida');

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) throw googleTokenInvalidError('Token expirado');
  if (!payload.iss || !GOOGLE_ISSUERS.has(payload.iss)) throw googleTokenInvalidError('Issuer inesperado');
  if (payload.aud !== clientId) throw googleTokenInvalidError('Audience inesperado');
  if (!payload.sub || !payload.email) throw googleTokenInvalidError('Faltan claims obligatorias (sub/email)');
  if (payload.email_verified !== true) throw googleTokenInvalidError('Email no verificado del lado de Google');

  return { sub: payload.sub, email: payload.email.toLowerCase(), name: payload.name?.trim() || undefined };
}

function googleTokenInvalidError(message: string): Error {
  const err = new Error(`[google-oauth] ${message}`);
  (err as NodeJS.ErrnoException).code = 'GOOGLE_TOKEN_INVALID';
  return err;
}
