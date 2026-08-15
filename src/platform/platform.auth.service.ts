/**
 * @file platform.auth.service.ts
 * @description Autenticación exclusiva para el rol SUPERADMIN de plataforma.
 *
 * Separado de AuthService (empleados de negocio) y CustomerAuthService (clientes)
 * — usa PLATFORM_JWT_SECRET (no JWT_SECRET) vía signPlatformToken()
 * (platform.auth.middleware.ts), la misma función que authenticatePlatform()
 * usa para verificar. Antes (hasta el 15/08/2026) esto firmaba con
 * JWT_SECRET y un payload {platform_role} propio, distinto del que
 * authenticatePlatform() esperaba — el login "funcionaba" (devolvía 200)
 * pero el token nunca pasaba la verificación de la siguiente request.
 *
 * ## Variables de entorno requeridas
 * - PLATFORM_JWT_SECRET     — ver platform.auth.middleware.ts
 * - PLATFORM_ADMIN_EMAIL    — email del superadmin (bootstrap)
 * - PLATFORM_ADMIN_PASSWORD — contraseña en texto plano para el primer deploy
 *                             (se hashea en runtime; no se guarda en disco)
 */

import { randomUUID, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { signPlatformToken } from './platform.auth.middleware.js';
import { PlatformRole } from '../types/enums.js';

const pbkdf2Async = promisify(pbkdf2);

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface PlatformLoginInput {
  email: string;
  password: string;
}

export interface PlatformLoginResult {
  token: string;
  tokenType: 'Bearer';
  expiresIn: number;
}

// ---------------------------------------------------------------------------
// Helpers de hash
// ---------------------------------------------------------------------------

const ITERATIONS  = 310_000;
const KEY_LENGTH  = 32;
const DIGEST      = 'sha256';
const SEPARATOR   = '$';

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key  = await pbkdf2Async(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return `${salt}${SEPARATOR}${key.toString('hex')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, storedHex] = stored.split(SEPARATOR);
  if (!salt || !storedHex) return false;
  const key     = await pbkdf2Async(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  const stored_ = Buffer.from(storedHex, 'hex');
  if (key.length !== stored_.length) return false;
  return timingSafeEqual(key, stored_);
}

// ---------------------------------------------------------------------------
// Credenciales bootstrap (env vars → hash en memoria al arrancar)
// ---------------------------------------------------------------------------

let _bootstrapHash: string | null = null;
let _bootstrapEmail: string | null = null;

async function getBootstrapCredentials(): Promise<{ email: string; hash: string } | null> {
  const email    = process.env.PLATFORM_ADMIN_EMAIL;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;

  if (!email || !password) return null;

  if (!_bootstrapHash || _bootstrapEmail !== email) {
    _bootstrapHash  = await hashPassword(password);
    _bootstrapEmail = email;
  }

  return { email: email.toLowerCase(), hash: _bootstrapHash };
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export class PlatformAuthService {
  /** TTL del token de SUPERADMIN: 8 horas (menor que el de empleados) */
  private readonly TOKEN_TTL_SECONDS = 8 * 60 * 60;

  async login(input: PlatformLoginInput): Promise<PlatformLoginResult> {
    const creds = await getBootstrapCredentials();

    if (!creds) {
      const err = new Error(
        'PLATFORM_ADMIN_EMAIL y PLATFORM_ADMIN_PASSWORD no están configuradas. ' +
        'Definí ambas variables de entorno en Render Dashboard.',
      );
      (err as NodeJS.ErrnoException).code = 'PLATFORM_AUTH_NOT_CONFIGURED';
      throw err;
    }

    const emailMatch = input.email.toLowerCase() === creds.email;
    const passMatch  = await verifyPassword(input.password, creds.hash);

    if (!emailMatch || !passMatch) {
      const err = new Error('Email o contraseña incorrectos');
      (err as NodeJS.ErrnoException).code = 'INVALID_CREDENTIALS';
      throw err;
    }

    const userId = randomUUID();

    // Antes esto firmaba con getJwtSecret() (JWT_SECRET, el de empleados) y
    // un payload {platform_role} — authenticatePlatform() verifica contra
    // PLATFORM_JWT_SECRET y espera {role, email}, así que NINGÚN token
    // emitido acá pasaba la verificación de firma en la siguiente request.
    // signPlatformToken() ya existe para esto (platform.auth.middleware.ts)
    // y usa la clave/payload correctos — no reimplementarlo acá.
    const token = signPlatformToken(
      { sub: userId, role: PlatformRole.SUPERADMIN, email: creds.email },
      this.TOKEN_TTL_SECONDS,
    );

    return { token, tokenType: 'Bearer', expiresIn: this.TOKEN_TTL_SECONDS };
  }
}
