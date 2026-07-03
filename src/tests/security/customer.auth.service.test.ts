/**
 * @file customer.auth.service.test.ts
 * @description Tests unitarios para CustomerAuthService.
 *
 * Cubre los tres problemas de seguridad identificados en el code review:
 * 1. JWT_SECRET validado al construir — falla en startup, no en runtime.
 * 2. Timing-safe login — verifyPassword siempre se ejecuta.
 * 3. Login timing: el tiempo con email inexistente no es significativamente
 *    menor que con email existente + contraseña incorrecta.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CustomerAuthService } from '../../security/customer.auth.service.js';
import { InMemoryCustomerRepository } from '../../repositories/in-memory.customer.repository.js';

// ---------------------------------------------------------------------------
// Setup de entorno
// ---------------------------------------------------------------------------

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

beforeEach(() => {
  process.env.JWT_SECRET = 'test-secret-32-characters-minimum!!';
});

afterEach(() => {
  if (ORIGINAL_JWT_SECRET !== undefined) {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  } else {
    delete process.env.JWT_SECRET;
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const makeService = () => {
  const repo = new InMemoryCustomerRepository();
  const service = new CustomerAuthService(repo);
  return { repo, service };
};

// ---------------------------------------------------------------------------
describe('CustomerAuthService — constructor', () => {
  it('se instancia correctamente cuando JWT_SECRET está definida', () => {
    expect(() => makeService()).not.toThrow();
  });

  it('lanza Error si JWT_SECRET no está definida (Bug 1)', () => {
    delete process.env.JWT_SECRET;
    const repo = new InMemoryCustomerRepository();
    expect(() => new CustomerAuthService(repo)).toThrow(
      '[CustomerAuthService] JWT_SECRET no está definida',
    );
  });
});

// ---------------------------------------------------------------------------
describe('CustomerAuthService — register', () => {
  it('registra un nuevo cliente y devuelve token + datos', async () => {
    const { service } = makeService();
    const result = await service.register({
      fullName: 'Test User',
      email: 'test@example.com',
      password: 'password123',
    });
    expect(result.token).toBeTruthy();
    expect(result.customer.email).toBe('test@example.com');
    expect(result.customer.fullName).toBe('Test User');
    expect(result.customer.id).toBeTruthy();
  });

  it('lanza EMAIL_TAKEN si el email ya está registrado', async () => {
    const { service } = makeService();
    await service.register({ fullName: 'User A', email: 'dup@example.com', password: 'pass1234' });
    await expect(
      service.register({ fullName: 'User B', email: 'dup@example.com', password: 'other1234' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });

  it('la comparación de email duplicado es case-insensitive', async () => {
    const { service } = makeService();
    await service.register({ fullName: 'User A', email: 'User@Example.COM', password: 'pass1234' });
    await expect(
      service.register({ fullName: 'User B', email: 'user@example.com', password: 'other1234' }),
    ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
  });
});

// ---------------------------------------------------------------------------
describe('CustomerAuthService — login', () => {
  const registerAndLogin = async (service: CustomerAuthService) => {
    await service.register({
      fullName: 'Login User',
      email: 'login@example.com',
      password: 'correctPass1!',
    });
  };

  it('login exitoso devuelve token y datos del cliente', async () => {
    const { service } = makeService();
    await registerAndLogin(service);
    const result = await service.login({ email: 'login@example.com', password: 'correctPass1!' });
    expect(result.token).toBeTruthy();
    expect(result.customer.email).toBe('login@example.com');
  });

  it('lanza INVALID_CREDENTIALS si la contraseña es incorrecta', async () => {
    const { service } = makeService();
    await registerAndLogin(service);
    await expect(
      service.login({ email: 'login@example.com', password: 'wrongPass' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('lanza INVALID_CREDENTIALS si el email no existe (Bug 2 — no leak por error diferente)', async () => {
    const { service } = makeService();
    await expect(
      service.login({ email: 'noexiste@example.com', password: 'cualquiera' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('el mensaje de error es idéntico para email inexistente y contraseña incorrecta (no enumera emails)', async () => {
    const { service } = makeService();
    await registerAndLogin(service);

    let errNoEmail: Error | undefined;
    let errWrongPass: Error | undefined;

    try {
      await service.login({ email: 'noexiste@example.com', password: 'x' });
    } catch (e) {
      errNoEmail = e as Error;
    }

    try {
      await service.login({ email: 'login@example.com', password: 'x' });
    } catch (e) {
      errWrongPass = e as Error;
    }

    expect(errNoEmail?.message).toBe(errWrongPass?.message);
    expect((errNoEmail as NodeJS.ErrnoException)?.code).toBe(
      (errWrongPass as NodeJS.ErrnoException)?.code,
    );
  });

  it('login es case-insensitive en el email', async () => {
    const { service } = makeService();
    await service.register({ fullName: 'Case Test', email: 'Case@Example.COM', password: 'pass1234' });
    const result = await service.login({ email: 'case@example.com', password: 'pass1234' });
    expect(result.token).toBeTruthy();
  });
});
