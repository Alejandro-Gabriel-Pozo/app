import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryCancellationPolicyRepository } from './in-memory.cancellation-policy.repository.js';

describe('InMemoryCancellationPolicyRepository', () => {
  let repo: InMemoryCancellationPolicyRepository;

  beforeEach(() => {
    repo = new InMemoryCancellationPolicyRepository();
  });

  it('sin tramos activos, findApplicableTier devuelve null (sin reembolso automático)', async () => {
    expect(await repo.findApplicableTier('biz', 10)).toBeNull();
  });

  it('elige el tramo con el umbral más alto que sea <= la anticipación real (ladder)', async () => {
    await repo.create({ businessId: 'biz', minDaysBeforeCheckin: 0, refundPercentage: 0 });
    await repo.create({ businessId: 'biz', minDaysBeforeCheckin: 3, refundPercentage: 50 });
    await repo.create({ businessId: 'biz', minDaysBeforeCheckin: 7, refundPercentage: 100 });

    expect((await repo.findApplicableTier('biz', 10))?.refundPercentage).toBe(100);
    expect((await repo.findApplicableTier('biz', 7))?.refundPercentage).toBe(100);
    expect((await repo.findApplicableTier('biz', 5))?.refundPercentage).toBe(50);
    expect((await repo.findApplicableTier('biz', 3))?.refundPercentage).toBe(50);
    expect((await repo.findApplicableTier('biz', 1))?.refundPercentage).toBe(0);
  });

  it('anticipación negativa (cancela después del check-in) sin tramo umbral 0 -- sin política aplicable', async () => {
    await repo.create({ businessId: 'biz', minDaysBeforeCheckin: 3, refundPercentage: 50 });
    expect(await repo.findApplicableTier('biz', -2)).toBeNull();
  });

  it('una política inactiva no se considera', async () => {
    const policy = await repo.create({ businessId: 'biz', minDaysBeforeCheckin: 0, refundPercentage: 20 });
    await repo.update(policy.id, { active: false });
    expect(await repo.findApplicableTier('biz', 5)).toBeNull();
  });

  it('no mezcla tramos de otro negocio', async () => {
    await repo.create({ businessId: 'biz-a', minDaysBeforeCheckin: 0, refundPercentage: 100 });
    expect(await repo.findApplicableTier('biz-b', 5)).toBeNull();
  });

  it('findById no filtra por active (R2)', async () => {
    const policy = await repo.create({ businessId: 'biz', minDaysBeforeCheckin: 0, refundPercentage: 20 });
    await repo.deactivate(policy.id);
    const found = await repo.findById(policy.id);
    expect(found?.active).toBe(false);
  });
});
