/**
 * @file user.store.ts
 * @description Helpers de hashing de contraseñas — PBKDF2 (NIST SP 800-132).
 *
 * Las contraseñas se almacenan como hash PBKDF2 (SHA-256, 100 000 iteraciones,
 * salt de 16 bytes), nunca en texto plano.
 *
 * El almacenamiento real de credenciales vive en `identities` (BD de
 * plataforma) — ver `PlatformRepository.createIdentity()` /
 * `findIdentityByEmail()` en `src/platform/platform.repository.ts`.
 * Este archivo solo expone las primitivas de hashing, reutilizadas tanto
 * al crear una identity como al hacer login.
 */

import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2Async = promisify(pbkdf2);

// ---------------------------------------------------------------------------
// Constantes de hashing — NO modificar sin regenerar todos los hashes
// ---------------------------------------------------------------------------
const HASH_ITERATIONS = 100_000;
const HASH_KEY_LENGTH = 64;
const HASH_DIGEST = 'sha256';
const SALT_BYTES = 16;

// ---------------------------------------------------------------------------
// Helpers de hashing — exportados para el script de generación de hashes
// ---------------------------------------------------------------------------
 
/**
 * Genera un hash PBKDF2 de la contraseña.
 * Formato de salida: `"salt_hex:hash_hex"`
 *
 * @param password - Contraseña en texto plano
 * @returns Hash listo para almacenar en la variable de entorno
 *
 * @example
 * ```ts
 * const hash = await hashPassword('MiClave123!');
 * // Resultado: "a3f1...16bytes_hex:b7c2...64bytes_hex"
 * ```
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2Async(
    password,
    salt,
    HASH_ITERATIONS,
    HASH_KEY_LENGTH,
    HASH_DIGEST,
  );
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
 
/**
 * Verifica una contraseña contra su hash almacenado.
 * Usa comparación en tiempo constante para prevenir timing attacks.
 *
 * @param password     - Contraseña candidata (texto plano)
 * @param storedHash   - Hash almacenado en formato "salt_hex:hash_hex"
 * @returns `true` si la contraseña es correcta
 */
export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;
 
  const salt = Buffer.from(saltHex, 'hex');
  const expectedHash = Buffer.from(hashHex, 'hex');
 
  const candidateHash = await pbkdf2Async(
    password,
    salt,
    HASH_ITERATIONS,
    HASH_KEY_LENGTH,
    HASH_DIGEST,
  );
 
  // timingSafeEqual requiere buffers del mismo tamaño
  if (candidateHash.length !== expectedHash.length) return false;
  return timingSafeEqual(candidateHash, expectedHash);
}
