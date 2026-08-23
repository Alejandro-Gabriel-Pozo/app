/**
 * @file customer.delete.account.test.ts
 * @description Tests unitarios para el flujo de eliminación de cuenta (GDPR).
 *
 * Verifica la interacción completa: anonymize() + invalidación implícita
 * del login posterior via CustomerAuthService.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { InMemoryCustomerRepository } from '../../clientes-finanzas/in-memory.customer.repository.js';
import { CustomerAuthService } from '../../security/customer.auth.service.js';
import { InMemoryNumberSequenceRepository } from '../../repositories/in-memory.number-sequence.repository.js';

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
});

const setup = async () => {
  const repo = new InMemoryCustomerRepository();
  const service = new CustomerAuthService(repo, 'biz-test-1', new InMemoryNumberSequenceRepository());
  const { customer, token } = await service.register({
    fullName: 'Juan Pérez',
    email: 'juan@test.com',
    password: 'password123',
  });
  return { repo, service, customer, token };
};

describe('Flujo DELETE /api/customer/me — anonimización GDPR', () => {

  it('anonymize() devuelve true para cliente registrado', async () => {
    const { repo, customer } = await setup();
    expect(await repo.anonymize(customer.id)).toBe(true);
  });

  it('tras anonymize(), el login con credenciales originales falla con INVALID_CREDENTIALS', async () => {
    const { repo, service, customer } = await setup();
    await repo.anonymize(customer.id);

    await expect(
      service.login({ email: 'juan@test.com', password: 'password123' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('tras anonymize(), getById devuelve registro con PII borrada e ID intacto', async () => {
    const { repo, customer } = await setup();
    await repo.anonymize(customer.id);

    const stored = await repo.getById(customer.id);
    expect(stored).toBeDefined();
    expect(stored?.id).toBe(customer.id);
    expect(stored?.fullName).toBe('[eliminado]');
    expect(stored?.email).toMatch(/^deleted-.+@anon\.local$/);
  });

  it('segunda llamada a anonymize() es idempotente — devuelve false', async () => {
    const { repo, customer } = await setup();
    await repo.anonymize(customer.id);
    expect(await repo.anonymize(customer.id)).toBe(false);
  });

  it('anonymize() con ID inexistente devuelve false', async () => {
    const { repo } = await setup();
    expect(await repo.anonymize('id-fantasma')).toBe(false);
  });

  it('tras anonymize(), el email original queda libre para un nuevo registro', async () => {
    const { repo, service, customer } = await setup();
    await repo.anonymize(customer.id);

    // El email 'juan@test.com' ya no está en el índice → debe poder registrarse
    const result = await service.register({
      fullName: 'Otro Juan',
      email: 'juan@test.com',
      password: 'newpass123',
    });
    expect(result.customer.email).toBe('juan@test.com');
  });
});
