import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryDepositPolicyRepository } from './in-memory.deposit-policy.repository.js';

describe('InMemoryDepositPolicyRepository', () => {
  let repo: InMemoryDepositPolicyRepository;

  beforeEach(() => {
    repo = new InMemoryDepositPolicyRepository();
  });

  it('sin políticas activas, devuelve undefined (cae al default del negocio)', async () => {
    expect(await repo.findActiveForResource('r1', 'cat-1', true)).toBeUndefined();
  });

  it('ítem gana sobre categoría y bucket', async () => {
    repo.seed({ id: 'p-bucket', businessId: 'biz', resourceId: null, serviceId: null, categoryId: null, bucket: 'ALOJAMIENTO', percentage: 10, active: true });
    repo.seed({ id: 'p-cat', businessId: 'biz', resourceId: null, serviceId: null, categoryId: 'cat-1', bucket: null, percentage: 20, active: true });
    repo.seed({ id: 'p-item', businessId: 'biz', resourceId: 'r1', serviceId: null, categoryId: null, bucket: null, percentage: 30, active: true });

    const result = await repo.findActiveForResource('r1', 'cat-1', true);
    expect(result?.percentage).toBe(30);
  });

  it('categoría gana sobre bucket cuando no hay override de ítem', async () => {
    repo.seed({ id: 'p-bucket', businessId: 'biz', resourceId: null, serviceId: null, categoryId: null, bucket: 'ALOJAMIENTO', percentage: 10, active: true });
    repo.seed({ id: 'p-cat', businessId: 'biz', resourceId: null, serviceId: null, categoryId: 'cat-1', bucket: null, percentage: 20, active: true });

    const result = await repo.findActiveForResource('r2', 'cat-1', true);
    expect(result?.percentage).toBe(20);
  });

  it('bucket TURNOS vs. ALOJAMIENTO según isLodging', async () => {
    repo.seed({ id: 'p-turnos', businessId: 'biz', resourceId: null, serviceId: null, categoryId: null, bucket: 'TURNOS', percentage: 15, active: true });
    repo.seed({ id: 'p-alojamiento', businessId: 'biz', resourceId: null, serviceId: null, categoryId: null, bucket: 'ALOJAMIENTO', percentage: 25, active: true });

    expect((await repo.findActiveForResource('r3', 'cat-x', true))?.percentage).toBe(25);
    expect((await repo.findActiveForResource('r3', 'cat-x', false))?.percentage).toBe(15);
  });

  it('una política inactiva no se considera', async () => {
    repo.seed({ id: 'p-inactive', businessId: 'biz', resourceId: 'r1', serviceId: null, categoryId: null, bucket: null, percentage: 50, active: false });

    expect(await repo.findActiveForResource('r1', 'cat-1', true)).toBeUndefined();
  });

  it('findActiveForService resuelve bucket SERVICIOS fijo', async () => {
    repo.seed({ id: 'p-servicios', businessId: 'biz', resourceId: null, serviceId: null, categoryId: null, bucket: 'SERVICIOS', percentage: 40, active: true });

    const result = await repo.findActiveForService('svc-1', 'cat-1');
    expect(result?.percentage).toBe(40);
  });
});
