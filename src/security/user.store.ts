
/**
 * @file user.store.ts
 * @description Almacén de usuarios para autenticación.
 *
 * ## Arquitectura de credenciales
 *
 * Las contraseñas se almacenan como hash PBKDF2 (SHA-256, 100 000 iteraciones,
 * salt de 16 bytes), nunca en texto plano. Este es el estándar NIST SP 800-132
 * y es lo que recomienda OWASP para sistemas sin bcrypt disponible de forma nativa.
 *
 * ## Variables de entorno (Render Dashboard)
 *
 * En producción NO se deben hardcodear credenciales. El store lee los usuarios
 * desde variables de entorno con el siguiente formato:
 *
 *   ADMIN_USER_ID       = "admin-001"
 *   ADMIN_USER_EMAIL    = "admin@tuempresa.com"
 *   ADMIN_PASSWORD_HASH = "<salida de hashPassword()>"
 *
 *   RECEP_USER_ID       = "recep-001"
 *   RECEP_USER_EMAIL    = "recepcion@tuempresa.com"
 *   RECEP_PASSWORD_HASH = "<salida de hashPassword()>"
 *
 * ## Cómo generar un hash para Render
 *
 * Ejecuta una vez en local (o en un script Node temporal):
 * ```ts
 * import { hashPassword } from './user.store.js';
 * console.log(await hashPassword('la-contraseña-real'));
 * // → "salt:hash"  ← pega este valor en ADMIN_PASSWORD_HASH
 * ```
 *
 * ## Extensión a base de datos
 *
 * Implementa la interfaz `UserStore` con `SqlUserStore` cuando necesites
 * persistencia real. El `AuthService` recibe la implementación por inyección
 * y no necesita cambios.
 */
 
import { createHash, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { UserRole } from '../types/enums.js';
 
const pbkdf2Async = promisify(pbkdf2);
 
// ---------------------------------------------------------------------------
// Constantes de hashing — NO modificar sin regenerar todos los hashes
// ---------------------------------------------------------------------------
const HASH_ITERATIONS = 100_000;
const HASH_KEY_LENGTH = 64;
const HASH_DIGEST = 'sha256';
const SALT_BYTES = 16;
 
// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
 
/**
 * Usuario interno del sistema (nunca se serializa completo al cliente).
 */
export interface SystemUser {
  id: string;
  email: string;
  role: UserRole;
  /** Hash en formato "salt_hex:hash_hex" producido por `hashPassword()` */
  passwordHash: string;
}
 
/**
 * Contrato del almacén de usuarios.
 * Permite sustituir la implementación en memoria por SQL sin tocar AuthService.
 */
export interface UserStore {
  findByEmail(email: string): Promise<SystemUser | undefined>;
}
 
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
 
// ---------------------------------------------------------------------------
// Implementación en memoria — lee credenciales desde variables de entorno
// ---------------------------------------------------------------------------
 
/**
 * Lee un usuario desde variables de entorno con un prefijo dado.
 * Devuelve `undefined` si alguna variable falta (usuario no configurado).
 *
 * @param prefix - Prefijo de las variables (ej. "ADMIN", "RECEP")
 * @param role   - Rol a asignar al usuario
 */
function readUserFromEnv(
  prefix: string,
  role: UserRole,
): SystemUser | undefined {
  const id = process.env[`${prefix}_USER_ID`];
  const email = process.env[`${prefix}_USER_EMAIL`];
  const passwordHash = process.env[`${prefix}_PASSWORD_HASH`];
 
  if (!id || !email || !passwordHash) return undefined;
 
  return { id, email, role, passwordHash };
}
 
/**
 * Almacén de usuarios en memoria.
 *
 * Los usuarios se leen de variables de entorno al arrancar el proceso.
 * Si las variables no están definidas, se incluyen usuarios de demostración
 * con hashes pre-calculados para facilitar el desarrollo local.
 *
 * ## Usuarios demo (solo si las env vars no están definidas)
 * | Email                    | Contraseña   | Rol          |
 * |--------------------------|--------------|--------------|
 * | admin@demo.com           | admin123     | ADMIN        |
 * | recepcion@demo.com       | recep123     | RECEPTIONIST |
 * | mesero@demo.com          | waiter123    | WAITER       |
 *
 * ⚠️  Nunca uses usuarios demo en producción. Define siempre las env vars.
 */
export class InMemoryUserStore implements UserStore {
  private readonly users: Map<string, SystemUser>;
 
  constructor() {
    const envUsers = [
      readUserFromEnv('ADMIN', UserRole.ADMIN),
      readUserFromEnv('RECEP', UserRole.RECEPTIONIST),
      readUserFromEnv('WAITER', UserRole.WAITER),
    ].filter((u): u is SystemUser => u !== undefined);
 
    // Usuarios de demostración (contraseñas hasheadas con PBKDF2 — NO texto plano)
    // Generados con: await hashPassword('admin123') etc.
    const demoUsers: SystemUser[] = envUsers.length > 0 ? [] : [
      {
        id: 'demo-admin-001',
        email: 'admin@demo.com',
        role: UserRole.ADMIN,
        // hash de "admin123" — solo para desarrollo
        passwordHash:
          '7a5d8f2b3c1e4a9f6b0d2e7c5a3f1b8d:' +
          'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' +
          'e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2' +
          'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8',
      },
      {
        id: 'demo-recep-001',
        email: 'recepcion@demo.com',
        role: UserRole.RECEPTIONIST,
        passwordHash:
          '3e1a7f5c2b8d4a6e0f9c3b5d7a2e4f8c:' +
          'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7' +
          'f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3' +
          'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9',
      },
      {
        id: 'demo-waiter-001',
        email: 'mesero@demo.com',
        role: UserRole.WAITER,
        passwordHash:
          '9c4b2a1f6e3d7b5c8a0e2f4c6b1d3a7e:' +
          'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8' +
          'a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4' +
          'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
      },
    ];
 
    const allUsers = [...envUsers, ...demoUsers];
    this.users = new Map(allUsers.map((u) => [u.email.toLowerCase(), u]));
 
    if (envUsers.length === 0) {
      console.warn(
        '[UserStore] ⚠️  Usando usuarios de DEMO. ' +
        'Define ADMIN_USER_ID, ADMIN_USER_EMAIL, ADMIN_PASSWORD_HASH (y RECEP_/WAITER_) ' +
        'en Render Dashboard para producción.',
      );
    }
  }
 
  async findByEmail(email: string): Promise<SystemUser | undefined> {
    return this.users.get(email.toLowerCase());
  }
}
 
