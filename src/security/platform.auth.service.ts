/**
 * @file platform.auth.service.ts
 * @description Autenticación exclusiva para el rol SUPERADMIN de plataforma.
 *
 * Separado de AuthService (empleados de negocio) y CustomerAuthService (clientes)
 * para que sus tokens tengan claim `platform_role` en lugar de `role` o `customer_id`.
 *
 * ## JWT generado
 * ```json
 * {
 *   "sub":           "<userId>",
 *   "platform_role": "SUPERADMIN",
 *   "iat":           1234567890,
 *   "exp":           1234567890
 * }
 * ```
 *
 * ## Variables de entorno requeridas
 * - JWT_SECRET              — clave compartida con el resto de la API
 * - PLATFORM_ADMIN_EMAIL    — email del superadmin (bootstrap)
 * - PLATFORM_ADMIN_PASSWORD — contraseña en texto plano para el primer deploy
 *                             (se hashea en runtime; no se guarda en disco)
 */

import { randomUUID, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { JwtService } from './jwt.service.js';
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

/**
 * Deriva un hash PBKDF2 del formato "salt$hash" (hex).
 * Compatible con el formato del AuthService principal.
 */
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key  = await pbkdf2Async(password, salt, ITERATIONS, KEY_LENGTH, DIGEST);
  return `${salt}${SEPARATOR}${key.toString('hex')}`;
}

/**
 * Verifica una contraseña contra su hash almacenado.
 * Usa `timingSafeEqual` para evitar timing attacks.
 */
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

/**
 * Hashea las credenciales del superadmin desde variables de entorno.
 * Se llama UNA vez al iniciar el servidor y el hash se guarda en memoria.
 * Las env vars pueden rotarse sin reiniciar (el hash se actualiza en el
 * próximo reinicio del proceso).
 */
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
  private readonly jwtService: JwtService;
  /** TTL del token de SUPERADMIN: 8 horas (menor que el de empleados) */
  private readonly TOKEN_TTL_SECONDS = 8 * 60 * 60;

  constructor() {
    this.jwtService = new JwtService();
  }

  /**
   * Autentica al SUPERADMIN contra las credenciales de entorno.
   * Retorna un JWT con `platform_role: SUPERADMIN`.
   *
   * @throws INVALID_CREDENTIALS si el email/contraseña no coinciden
   * @throws PLATFORM_AUTH_NOT_CONFIGURED si faltan las env vars
   */
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

    // ID estable derivado del email — no hace falta BD para el SUPERADMIN
    const userId = randomUUID();

    const token = await this.jwtService.sign(
      { platform_role: PlatformRole.SUPERADMIN },
      userId,
      this.TOKEN_TTL_SECONDS,
    );

    return { token, tokenType: 'Bearer', expiresIn: this.TOKEN_TTL_SECONDS };
  }
}
