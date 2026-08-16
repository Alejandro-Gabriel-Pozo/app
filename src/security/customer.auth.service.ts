/**
 * @file customer.auth.service.ts
 * @description Servicio de autenticación para clientes del portal público.
 */

import { randomUUID } from 'node:crypto';
import type { CustomerRepository } from '../clientes-finanzas/customer.repository.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { hashPassword, verifyPassword } from './user.store.js';
import { signToken } from './auth.middleware.js';
import { verifyGoogleIdToken } from './google-oauth.js';
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
 */
const DUMMY_HASH = await hashPassword('dummy-constant-time-placeholder');

export class CustomerAuthService {
  private readonly jwtSecret: string;

  constructor(
    private readonly customerRepository: CustomerRepository,
    private readonly businessId: string,
  ) {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('[CustomerAuthService] JWT_SECRET no está definida en las variables de entorno.');
    }
    this.jwtSecret = secret;
  }

  async register(input: CustomerRegistrationInput): Promise<CustomerAuthResult> {
    const existing = await this.customerRepository.getByEmail(input.email);
    if (existing) {
      const err = new Error('El email ya está registrado');
      (err as NodeJS.ErrnoException).code = 'EMAIL_TAKEN';
      throw err;
    }

    const id = randomUUID();
    const passwordHash = await hashPassword(input.password);
    const customer = new Customer(id, input.fullName, [
      { id: `ccm-${id}`, channel: 'EMAIL', value: input.email, isPrimary: true },
    ]);

    await this.customerRepository.saveWithPassword(customer, passwordHash);

    const token = this.issueToken(id);
    return { token, customer: { id, fullName: input.fullName, email: input.email } };
  }

  async login(input: CustomerLoginInput): Promise<CustomerAuthResult> {
    const record = await this.customerRepository.getByEmailWithPassword(input.email);

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
        id:       record.customer.id,
        fullName: record.customer.fullName,
        email:    record.customer.email ?? '',
      },
    };
  }

  /**
   * Login con Google del portal (punto 5/E5, pendientes-2026-08-15.md) —
   * a diferencia del staff, SÍ auto-crea un customer nuevo si el email no
   * existe todavía (self-service, mismo criterio que register()).
   *
   * Matchea primero por `google_sub`; si es la primera vez, por el email
   * verificado de Google. Si YA existe un customer con ese email (cargado
   * a mano por el negocio, o autoregistrado antes por password) lo VINCULA
   * en vez de crear uno nuevo — es el camino de "reclamo" que hoy no
   * existe por otra vía (`register()` rechaza con `EMAIL_TAKEN` en ese
   * caso, sin ofrecer ninguna salida).
   */
  async loginWithGoogle(idToken: string): Promise<CustomerAuthResult> {
    const google = await verifyGoogleIdToken(idToken);

    let customer = await this.customerRepository.getByGoogleSub(google.sub);

    if (!customer) {
      customer = await this.customerRepository.getByEmail(google.email);
      if (customer) {
        await this.customerRepository.linkGoogleSub(customer.id, google.sub);
      } else {
        const id = randomUUID();
        customer = new Customer(id, google.name ?? google.email, [
          { id: `ccm-${id}`, channel: 'EMAIL', value: google.email, isPrimary: true },
        ]);
        await this.customerRepository.saveWithGoogle(customer, google.sub);
      }
    }

    const token = this.issueToken(customer.id);
    return { token, customer: { id: customer.id, fullName: customer.fullName, email: customer.email ?? '' } };
  }

  private issueToken(customerId: string): string {
    return signToken(
      { sub: customerId, role: UserRole.CUSTOMER, customer_id: customerId, business_id: this.businessId },
      this.jwtSecret,
    );
  }
}
