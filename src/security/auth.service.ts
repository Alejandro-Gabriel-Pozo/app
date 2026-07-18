/**
 * @file auth.service.ts
 * @description Servicio de autenticación: valida credenciales y emite JWT.
 *
 * ## Por qué un servicio separado del middleware
 *
 * `auth.middleware.ts` resuelve la identidad desde un token ya emitido (verificación).
 * `auth.service.ts` emite tokens nuevos validando credenciales (autenticación).
 * Son responsabilidades distintas y mantenerlas separadas facilita testear cada una.
 *
 * ## Seguridad del login
 *
 * 1. **Timing attack en "usuario no encontrado"**: si el lookup es más rápido
 *    que la verificación de contraseña, un atacante puede inferir si un email
 *    existe midiendo tiempos de respuesta. Lo resolvemos ejecutando siempre
 *    `verifyPassword` aunque el usuario no exista (contra un hash dummy).
 *
 * 2. **Mensaje de error genérico**: el endpoint devuelve siempre
 *    "Credenciales inválidas" tanto si el email no existe como si la contraseña
 *    es incorrecta. Nunca se revela cuál de las dos falló.
 */
 
import { signToken } from './auth.middleware.js';
import { UserStore, InMemoryUserStore, verifyPassword } from './user.store.js';
 
// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
 
/**
 * Respuesta exitosa del login.
 */
export interface LoginResult {
  /** JWT firmado con HS256 */
  token: string;
  /** Tipo de token — siempre "Bearer" para incluir en el header Authorization */
  tokenType: 'Bearer';
  /** Segundos hasta la expiración del token */
  expiresIn: number;
  /** Datos básicos del usuario autenticado (sin datos sensibles) */
  user: {
    id: string;
    email: string;
    role: string;
  };
}
 
// ---------------------------------------------------------------------------
// Hash dummy para la comparación constante anti-timing
// Formato válido: "salt_hex:hash_hex" de 16+64 bytes
// ---------------------------------------------------------------------------
const DUMMY_HASH =
  'ffffffffffffffffffffffffffffffff:' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' +
  'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
 
// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------
 
/**
 * Servicio de autenticación.
 *
 * Recibe el `UserStore` por inyección (o null para fallback a InMemoryUserStore)
 * para facilitar tests y para que el router no dependa de una implementación concreta.
 */
export class AuthService {
  /**
   * Duración del token en segundos. Lee `JWT_EXPIRES_IN` del entorno:
   * - "24h" → 86 400 s
   * - "7d"  → 604 800 s
   * - Número puro → se usa directamente en segundos
   * - No definida → 86 400 s (24 horas)
   */
  private readonly tokenTtlSeconds: number;
  private readonly store: UserStore;
 
  constructor(userStore: UserStore | null) {
    this.store = userStore ?? new InMemoryUserStore();
    this.tokenTtlSeconds = parseExpiresIn(process.env.JWT_EXPIRES_IN ?? '24h');
  }
 
  /**
   * Intenta autenticar con email + contraseña.
   *
   * Siempre ejecuta `verifyPassword` para prevenir timing attacks,
   * incluso si el email no existe.
   *
   * @param email    - Email del usuario (insensible a mayúsculas)
   * @param password - Contraseña en texto plano
   * @returns `LoginResult` con el JWT y datos básicos del usuario
   * @throws `Error` con `code: 'INVALID_CREDENTIALS'` si las credenciales son incorrectas
   *
   * @example
   * ```ts
   * const result = await authService.login('admin@demo.com', 'admin123');
   * // result.token → "eyJ..."
   * // result.user  → { id: 'demo-admin-001', email: '...', role: 'ADMIN' }
   * ```
   */
  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.store.findByEmail(email);
 
    // Siempre hasheamos — aunque el usuario no exista — para tiempo constante
    const hashToVerify = user?.passwordHash ?? DUMMY_HASH;
    const passwordMatches = await verifyPassword(password, hashToVerify);
 
    if (!user || !passwordMatches) {
      const err = new Error('Credenciales inválidas');
      (err as NodeJS.ErrnoException).code = 'INVALID_CREDENTIALS';
      throw err;
    }
 
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new Error('[AuthService] JWT_SECRET no está definida');
    }
 
    const token = signToken(
      { sub: user.id, role: user.role, ...(user.businessId && { business_id: user.businessId }) },
      jwtSecret,
      this.tokenTtlSeconds,
    );
 
    return {
      token,
      tokenType: 'Bearer',
      expiresIn: this.tokenTtlSeconds,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
      },
    };
  }
}
 
// ---------------------------------------------------------------------------
// Helper: parsear JWT_EXPIRES_IN
// ---------------------------------------------------------------------------
 
/**
 * Convierte la cadena de `JWT_EXPIRES_IN` a segundos.
 *
 * Soporta:
 * - `"Nh"`  → N horas   (ej. "24h" → 86400)
 * - `"Nd"`  → N días    (ej. "7d"  → 604800)
 * - `"Nm"`  → N minutos (ej. "30m" → 1800)
 * - `"N"`   → N segundos directos
 *
 * @param value - Valor de la variable de entorno JWT_EXPIRES_IN
 * @returns Duración en segundos (mínimo 60, máximo 30 días)
 */
function parseExpiresIn(value: string): number {
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

