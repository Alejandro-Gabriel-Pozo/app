/**
 * @file customer.auth.service.ts
 * @description Servicio de autenticación para clientes del portal público.
 *
 * ## Diferencia con AuthService (empleados)
 * - Los clientes se registran solos desde el portal.
 * - Sus credenciales se almacenan en la tabla `customers` con un campo
 *   `password_hash` adicional.
 * - El JWT resultante lleva `role: CUSTOMER` y `customer_id`.
 *
 * ## Hashing
 * Usa la misma implementación PBKDF2 del proyecto (hashPassword / verifyPassword
 * de user.store.ts) para consistencia.
 */

import { randomUUID } from 'node:crypto';
import { CustomerRepository } from '../repositories/customer.repository.js';
import { Customer } from '../domain/entities.js';
import { hashPassword, verifyPassword } from './user.store.js';
import { signToken } from './auth.middleware.js';
import { UserRole } from '../types/enums.js';

export interface CustomerRegistrationInput {
  fullName: string;
  email: string;
  password: string;
}

export interface CustomerLoginInput {
  email: string;
  password: string;
}

export interface CustomerAuthResult {
  token: string;
  customer: {
    id: string;
    fullName: string;
    email: string;
  };
}

/**
 * Hash dummy usado para mantener tiempo constante en login cuando el email
 * no existe — evita timing attack por enumeración de emails.
 * Generado una vez al importar el módulo.
 */
const DUMMY_HASH = await hashPassword('dummy-constant-time-placeholder');

export class CustomerAuthService {
  private readonly jwtSecret: string;

  constructor(
    private readonly customerRepository: CustomerRepository,
  ) {
    // Bug 1 fix: validar JWT_SECRET al construir el servicio (falla en startup,
    // no en el primer request de login).
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('[CustomerAuthService] JWT_SECRET no está definida en las variables de entorno.');
    }
    this.jwtSecret = secret;
  }

  /**
   * Registra un nuevo cliente.
   * @throws Error con code EMAIL_TAKEN si el email ya está en uso.
   */
  async register(input: CustomerRegistrationInput): Promise<CustomerAuthResult> {
    const existing = await this.customerRepository.getByEmail(input.email);
    if (existing) {
      const err = new Error('El email ya está registrado');
      (err as NodeJS.ErrnoException).code = 'EMAIL_TAKEN';
      throw err;
    }

    const id = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const customer = new Customer(id, input.fullName, input.email);

    // Persiste el cliente con su password hash
    await this.customerRepository.saveWithPassword(customer, passwordHash);

    const token = this.issueToken(id);
    return { token, customer: { id, fullName: input.fullName, email: input.email } };
  }

  /**
   * Autentica un cliente existente.
   *
   * ## Seguridad — timing-safe
   * verifyPassword (PBKDF2) se ejecuta siempre, incluso cuando el email no
   * existe, para que el tiempo de respuesta sea constante y no permita
   * enumerar emails registrados midiendo latencia.
   *
   * @throws Error con code INVALID_CREDENTIALS si email o contraseña no coinciden.
   */
  async login(input: CustomerLoginInput): Promise<CustomerAuthResult> {
    const record = await this.customerRepository.getByEmailWithPassword(input.email);

    // Bug 2 fix: ejecutar verifyPassword siempre para evitar timing attack.
    // Si el email no existe, comparamos contra DUMMY_HASH (resultado siempre false).
    const hashToVerify = record?.passwordHash ?? DUMMY_HASH;
    const valid = await verifyPassword(input.password, hashToVerify);

    if (!record || !valid) {
      const err = new Error('Credenciales inválidas');
      (err as NodeJS.ErrnoException).code = 'INVALID_CREDENTIALS';
      throw err;
    }

    const token = this.issueToken(record.customer.id);
    return {
      token,
      customer: {
        id: record.customer.id,
        fullName: record.customer.fullName,
        email: record.customer.email,
      },
    };
  }

  private issueToken(customerId: string): string {
    return signToken(
      { sub: customerId, role: UserRole.CUSTOMER, customer_id: customerId },
      this.jwtSecret,
    );
  }
}
