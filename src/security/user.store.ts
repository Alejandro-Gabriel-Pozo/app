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
 *   ADMIN_BUSINESS_ID   = "<uuid del negocio en la BD>"
 *
 *   RECEP_USER_ID       = "recep-001"
 *   RECEP_USER_EMAIL    = "recepcion@tuempresa.com"
 *   RECEP_PASSWORD_HASH = "<salida de hashPassword()>"
 *   RECEP_BUSINESS_ID   = "<uuid del negocio en la BD>"
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
 
import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
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
  /** ID del negocio al que pertenece (multi-tenant) — ausente en modo single-tenant */
  businessId?: string;
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
  const id           = process.env[`${prefix}_USER_ID`];
  const email        = process.env[`${prefix}_USER_EMAIL`];
  const passwordHash = process.env[`${prefix}_PASSWORD_HASH`];
  const businessId   = process.env[`${prefix}_BUSINESS_ID`];
 
  if (!id || !email || !passwordHash) return undefined;
 
  return { id, email, role, passwordHash, ...(businessId && { businessId }) };
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
 * ⚠️  En demo, businessId apunta al negocio real 'biz-demo-01' en la BD central.
 *     Para producción define ADMIN_BUSINESS_ID (y RECEP_BUSINESS_ID) en
 *     Render Dashboard con el ID real del negocio.
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
    const DEMO_BUSINESS_ID = 'biz-demo-01';
    const demoUsers: SystemUser[] = envUsers.length > 0 ? [] : [
      {
        id: 'demo-admin-001',
        email: 'admin@demo.com',
        role: UserRole.ADMIN,
        businessId: DEMO_BUSINESS_ID,
        // hash de "admin123" — solo para desarrollo
        passwordHash:
          'eacd2ec131cc27483111fd162a820d5a:' +
          'c9d36d745334e44f36da17224499fc92f7340f74fd17ba4deedaa284a9752db1' +
          'ec07ce9622456c071becfa40158888bd994e724549f87598e2a94fc51ff3731b',
      },
      {
        id: 'demo-recep-001',
        email: 'recepcion@demo.com',
        role: UserRole.RECEPTIONIST,
        businessId: DEMO_BUSINESS_ID,
        passwordHash:
          '829280e6baa346e556e93a4aa1297ae0:' +
          '09293eff08b0114d7330e7a895c3770e65d7a2fe39bf2c480e92010fad0f029e' +
          'a00c4d70e52378d74bbfc7d95aabc27e0349692d4237b6e83e1b625d09bd9113',
      },
      {
        id: 'demo-waiter-001',
        email: 'mesero@demo.com',
        role: UserRole.WAITER,
        businessId: DEMO_BUSINESS_ID,
        passwordHash:
          '55e9c9188fedb31713ea77573814e946:' +
          '6a1f9c19d673ac6103f7bc9b7c0b68c1b786a4bc56e1844017dd61c453c29c88' +
          'ac907ea38b52cdb199257e0077bd28fee9ed5d70b3502f04144a4c072613d44a',
      },
    ];
 
    const allUsers = [...envUsers, ...demoUsers];
    this.users = new Map(allUsers.map((u) => [u.email.toLowerCase(), u]));
 
    if (envUsers.length === 0) {
      console.warn(
        '[UserStore] ⚠️  Usando usuarios de DEMO. ' +
        'Define ADMIN_USER_ID, ADMIN_USER_EMAIL, ADMIN_PASSWORD_HASH, ADMIN_BUSINESS_ID ' +
        '(y RECEP_/WAITER_) en Render Dashboard para producción.',
      );
    }
  }
 
  async findByEmail(email: string): Promise<SystemUser | undefined> {
    return this.users.get(email.toLowerCase());
  }
}
