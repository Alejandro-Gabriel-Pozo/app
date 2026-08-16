/**
 * @file in-memory-customer.repository.anonymize.test.ts
 * @description Tests unitarios para InMemoryCustomerRepository.anonymize()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCustomerRepository } from '../../clientes-finanzas/in-memory.customer.repository.js';
import { Customer } from '../../clientes-finanzas/customer.entities.js';

const makeCustomer = (overrides: Partial<{ id: string; fullName: string; email: string }> = {}) =>
  new Customer(
    overrides.id ?? 'cust-1',
    overrides.fullName ?? 'Ana García',
    overrides.email ?? 'ana@example.com',
  );

describe('InMemoryCustomerRepository — anonymize()', () => {
  let repo: InMemoryCustomerRepository;

  beforeEach(() => {
    repo = new InMemoryCustomerRepository();
  });

  it('reemplaza nombre y email con valores neutros', async () => {
    const c = makeCustomer();
    await repo.saveWithPassword(c, 'hash-original');

    const ok = await repo.anonymize(c.id);
    expect(ok).toBe(true);

    const stored = await repo.getById(c.id);
    expect(stored?.fullName).toBe('[eliminado]');
    expect(stored?.email).toBe(`deleted-${c.id}@anon.local`);
  });

  it('limpia el passwordHash — getByEmailWithPassword devuelve undefined', async () => {
    const c = makeCustomer();
    await repo.saveWithPassword(c, 'hash-original');
    await repo.anonymize(c.id);

    const record = await repo.getByEmailWithPassword(`deleted-${c.id}@anon.local`);
    expect(record).toBeUndefined();
  });

  it('el email original deja de ser buscable en el índice', async () => {
    const c = makeCustomer();
    await repo.save(c);
    await repo.anonymize(c.id);

    expect(await repo.getByEmail('ana@example.com')).toBeUndefined();
  });

  it('el ID se preserva — getById sigue encontrando el registro', async () => {
    const c = makeCustomer();
    await repo.save(c);
    await repo.anonymize(c.id);

    const stored = await repo.getById(c.id);
    expect(stored).toBeDefined();
    expect(stored?.id).toBe(c.id);
  });

  it('devuelve false para ID inexistente', async () => {
    expect(await repo.anonymize('no-existe')).toBe(false);
  });

  it('es idempotente — segunda llamada devuelve false', async () => {
    const c = makeCustomer();
    await repo.save(c);

    expect(await repo.anonymize(c.id)).toBe(true);
    expect(await repo.anonymize(c.id)).toBe(false);
  });

  it('anonymize no afecta a otros clientes en el store', async () => {
    const c1 = makeCustomer({ id: 'c1', email: 'uno@test.com' });
    const c2 = makeCustomer({ id: 'c2', email: 'dos@test.com' });
    await repo.save(c1);
    await repo.save(c2);

    await repo.anonymize(c1.id);

    const c2stored = await repo.getById(c2.id);
    expect(c2stored?.email).toBe('dos@test.com');
    expect(c2stored?.fullName).toBe('Ana García');
  });
});
