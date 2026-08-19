/**
 * @file auth.service.ts
 * @description Servicio de autenticación: valida credenciales y emite JWT.
 *
 * ## Modelo identity + membership
 *
 * Separa "quién sos" (`Identity`: email + password, único en toda la
 * plataforma) de "a qué negocio pertenecés y con qué rol" (`Membership`).
 * Reemplaza el viejo modelo `platform_users`, donde el mismo email podía
 * existir en negocios distintos y el login no tenía forma de desambiguar
 * cuál de los dos elegir (hallazgo C1 del code review de agosto 2026).
 *
 * ## Flujo de login en dos pasos
 *
 * ```
 * POST /api/login { email, password }
 *   → identity resuelta sin ambigüedad (email es UNIQUE global)
 *   → 1 sola membership activa → LoginResult directo (caso común, sin fricción)
 *   → 2+ memberships activas   → BusinessSelectionRequired (identityToken corto)
 *
 * POST /api/login/select-business { identityToken, businessId }
 *   → valida identityToken + membership activa en ese negocio
 *   → LoginResult
 * ```
 *
 * ## Seguridad del login
 *
 * 1. **Timing attack en "usuario no encontrado"**: se ejecuta siempre
 *    `verifyPassword` aunque la identity no exista (contra un hash dummy).
 * 2. **Mensaje de error genérico**: "Credenciales inválidas" tanto si el
 *    email no existe como si la contraseña es incorrecta.
 * 3. **identityToken de selección de negocio**: JWT de vida corta (5 min)
 *    con `purpose: 'BUSINESS_SELECTION'`, firmado con el mismo JWT_SECRET
 *    pero sin `role`/`business_id` — no sirve como token de acceso a la API,
 *    solo como prueba de que el paso 1 (email+password) ya se completó.
 */

import { signToken, verifyToken } from './auth.middleware.js';
import { verifyPassword } from './user.store.js';
import { verifyGoogleIdToken } from './google-oauth.js';
import type { PlatformRepository, Identity, Membership } from '../platform/platform.repository.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Respuesta exitosa del login — token de acceso listo para usar. */
export interface LoginResult {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: {
    id: string;
    email: string;
    role: string;
  };
}

/** El email+password son correctos, pero hay más de un negocio para elegir. */
export interface BusinessSelectionRequired {
  needsBusinessSelection: true;
  /** JWT de 5 min — se reenvía tal cual a POST /api/login/select-business */
  identityToken: string;
  businesses: Array<{ businessId: string; businessName: string; role: string }>;
}

export type LoginOutcome = LoginResult | BusinessSelectionRequired;

interface IdentityTokenPayload {
  sub: string;
  purpose: 'BUSINESS_SELECTION';
}

// ---------------------------------------------------------------------------
// Hash dummy para la comparación constante anti-timing
// Formato válido: "salt_hex:hash_hex" de 16+64 bytes
// ---------------------------------------------------------------------------
const DUMMY_HASH =
  'ffffffffffffffffffffffffffffffff:' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const IDENTITY_TOKEN_TTL_SECONDS = 5 * 60;

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export class AuthService {
  /**
   * Duración del token de acceso en segundos. Lee `JWT_EXPIRES_IN` del
   * entorno — ver `parseExpiresIn()`.
   */
  private readonly tokenTtlSeconds: number;

  constructor(private readonly platformRepo: PlatformRepository) {
    this.tokenTtlSeconds = parseExpiresIn(process.env.JWT_EXPIRES_IN ?? '24h');
  }

  /**
   * Paso 1: valida email + password.
   *
   * @throws `Error` con `code: 'INVALID_CREDENTIALS'` si las credenciales
   *   son incorrectas, o si la identity no tiene ninguna membership activa
   *   (mismo mensaje genérico — no revela cuál de los casos ocurrió).
   */
  async login(email: string, password: string): Promise<LoginOutcome> {
    const identity = await this.platformRepo.findIdentityByEmail(email);

    // Siempre hasheamos — aunque la identity no exista — para tiempo constante
    const hashToVerify = identity?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await verifyPassword(password, hashToVerify);

    if (!identity || !passwordMatches) {
      throw invalidCredentialsError();
    }

    return this.resolveLoginOutcome(identity);
  }

  /**
   * Login con Google (punto 5/E5, pendientes-2026-08-15.md) — método
   * ADICIONAL sobre una identity que YA existe (creada por un admin vía el
   * ABM de usuarios). No auto-crea cuentas de staff nuevas: a diferencia
   * del portal de clientes, un alta de staff es una decisión del negocio,
   * no self-service.
   *
   * Matchea primero por `google_sub` (estable de por vida); si es la
   * primera vez, por el email verificado de Google y recién ahí vincula el
   * `sub` — ver platform.schema.sql para el porqué de las dos vías.
   *
   * @throws `Error` con `code: 'GOOGLE_ACCOUNT_NOT_LINKED'` si no hay
   *   ninguna identity de staff con ese email — a diferencia de
   *   INVALID_CREDENTIALS, acá SÍ tiene sentido decir la verdad: Google ya
   *   probó que el email es real, no es una superficie de adivinar
   *   contraseñas.
   */
  async loginWithGoogle(idToken: string): Promise<LoginOutcome> {
    const google = await verifyGoogleIdToken(idToken);

    let identity = await this.platformRepo.findIdentityByGoogleSub(google.sub);

    if (!identity) {
      identity = await this.platformRepo.findIdentityByEmail(google.email);
      if (!identity) throw googleAccountNotLinkedError();
      await this.platformRepo.linkGoogleAccount(identity.id, google.sub);
    }

    return this.resolveLoginOutcome(identity);
  }

  /** Común a login() y loginWithGoogle() una vez resuelta la identity. */
  private async resolveLoginOutcome(identity: Identity): Promise<LoginOutcome> {
    const memberships = await this.platformRepo.findActiveMembershipsByIdentityId(identity.id);

    if (memberships.length === 0) {
      throw invalidCredentialsError();
    }

    if (memberships.length === 1) {
      return this.issueTenantToken(identity, memberships[0]!);
    }

    const identityToken = signToken<IdentityTokenPayload>(
      { sub: identity.id, purpose: 'BUSINESS_SELECTION' },
      requireJwtSecret(),
      IDENTITY_TOKEN_TTL_SECONDS,
    );

    return {
      needsBusinessSelection: true,
      identityToken,
      businesses: memberships.map((m) => ({
        businessId: m.businessId,
        businessName: m.businessName,
        role: m.roleName,
      })),
    };
  }

  /**
   * Paso 2 (solo si el login devolvió `needsBusinessSelection`): confirma
   * el negocio elegido y emite el token de acceso tenant-scoped.
   *
   * @throws `Error` con `code: 'INVALID_BUSINESS_SELECTION'` si el
   *   identityToken expiró/es inválido, o si la identity no tiene una
   *   membership activa en ese negocio.
   */
  async selectBusiness(identityToken: string, businessId: string): Promise<LoginResult> {
    let payload: IdentityTokenPayload & { exp: number; iat: number };
    try {
      payload = verifyToken<IdentityTokenPayload & { exp: number; iat: number }>(
        identityToken,
        requireJwtSecret(),
      );
    } catch {
      throw invalidBusinessSelectionError();
    }

    if (payload.purpose !== 'BUSINESS_SELECTION') {
      throw invalidBusinessSelectionError();
    }

    const identity = await this.platformRepo.findIdentityById(payload.sub);
    if (!identity) throw invalidBusinessSelectionError();

    const membership = await this.platformRepo.findMembership(identity.id, businessId);
    if (!membership || !membership.active) throw invalidBusinessSelectionError();

    return this.issueTenantToken(identity, membership);
  }

  /**
   * Renueva el token de un usuario YA autenticado — mismo secret/TTL que
   * login, sin re-pedir credenciales (punto 3, pendientes-2026-08-15.md:
   * la sesión duraba 24h fijas sin forma de extenderla). `authenticate()`
   * ya confirmó, para ESTA request, que la membership sigue activa
   * (`resolveMembershipContext` en el middleware global) — no hace falta
   * repetir esa consulta acá, solo re-firmar con un `exp` nuevo.
   */
  refreshTenantToken(identityId: string, businessId: string): { token: string; tokenType: 'Bearer'; expiresIn: number } {
    const token = signToken(
      { sub: identityId, business_id: businessId },
      requireJwtSecret(),
      this.tokenTtlSeconds,
    );
    return { token, tokenType: 'Bearer', expiresIn: this.tokenTtlSeconds };
  }

  /**
   * El JWT de staff YA NO lleva `role` (14/08/2026, ver security/roles.ts)
   * — solo `sub`/`business_id`. Los permisos se resuelven en cada request
   * contra `role_permission_groups`, no se congelan acá. `user.role` en la
   * respuesta sigue existiendo (es solo texto para mostrar en la UI, nunca
   * se usó como fuente de autorización desde el frontend).
   */
  private issueTenantToken(identity: Identity, membership: Membership): LoginResult {
    const token = signToken(
      { sub: identity.id, business_id: membership.businessId },
      requireJwtSecret(),
      this.tokenTtlSeconds,
    );

    return {
      token,
      tokenType: 'Bearer',
      expiresIn: this.tokenTtlSeconds,
      user: {
        id: identity.id,
        email: identity.email,
        role: membership.roleName,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('[AuthService] JWT_SECRET no está definida');
  return secret;
}

function invalidCredentialsError(): Error {
  const err = new Error('Credenciales inválidas');
  (err as NodeJS.ErrnoException).code = 'INVALID_CREDENTIALS';
  return err;
}

function googleAccountNotLinkedError(): Error {
  const err = new Error('No hay ninguna cuenta de staff con ese email. Pedile a un administrador que te dé de alta primero.');
  (err as NodeJS.ErrnoException).code = 'GOOGLE_ACCOUNT_NOT_LINKED';
  return err;
}

function invalidBusinessSelectionError(): Error {
  const err = new Error('Selección de negocio inválida o expirada');
  (err as NodeJS.ErrnoException).code = 'INVALID_BUSINESS_SELECTION';
  return err;
}

/**
 * Convierte la cadena de `JWT_EXPIRES_IN` a segundos.
 *
 * Soporta:
 * - `"Nh"`  → N horas   (ej. "24h" → 86400)
 * - `"Nd"`  → N días    (ej. "7d"  → 604800)
 * - `"Nm"`  → N minutos (ej. "30m" → 1800)
 * - `"N"`   → N segundos directos
 *
 * Exportada (19/08/2026) porque `CustomerAuthService` y el refresh del
 * portal (`customer.routes.ts`) la reusan — mismo TTL configurable que
 * staff, un solo parser en vez de reimplementarlo.
 *
 * @param value - Valor de la variable de entorno JWT_EXPIRES_IN
 * @returns Duración en segundos (mínimo 60, máximo 30 días)
 */
export function parseExpiresIn(value: string): number {
  const lower = value.trim().toLowerCase();
  const num = parseFloat(lower);

  let seconds: number;
  if (lower.endsWith('h')) {
    seconds = num * 3_600;
  } else if (lower.endsWith('d')) {
    seconds = num * 86_400;
  } else if (lower.endsWith('m')) {
    seconds = num * 60;
  } else {
    seconds = num;
  }

  if (!Number.isFinite(seconds) || seconds < 60) {
    console.warn(`[AuthService] JWT_EXPIRES_IN="${value}" inválido, usando 24h`);
    return 86_400;
  }

  const MAX_TTL = 30 * 86_400;
  if (seconds > MAX_TTL) {
    console.warn(`[AuthService] JWT_EXPIRES_IN supera 30 días, limitando a 30d`);
    return MAX_TTL;
  }

  return Math.floor(seconds);
}
