import type { DepositPolicy, IDepositPolicyRepository } from './deposit-policy.repository.js';

function specificity(p: DepositPolicy): number {
  if (p.resourceId || p.serviceId) return 1;
  if (p.categoryId) return 2;
  return 3;
}

export class InMemoryDepositPolicyRepository implements IDepositPolicyRepository {
  private policies: DepositPolicy[] = [];

  seed(policy: DepositPolicy): void {
    this.policies.push(policy);
  }

  async findActiveForResource(
    resourceId: string, categoryId: string, isLodging: boolean,
  ): Promise<DepositPolicy | undefined> {
    const bucket = isLodging ? 'ALOJAMIENTO' : 'TURNOS';
    const candidates = this.policies.filter(
      (p) => p.active && (p.resourceId === resourceId || p.categoryId === categoryId || p.bucket === bucket),
    );
    if (candidates.length === 0) return undefined;
    return [...candidates].sort((a, b) => specificity(a) - specificity(b))[0];
  }

  async findActiveForService(
    serviceId: string, categoryId: string,
  ): Promise<DepositPolicy | undefined> {
    const candidates = this.policies.filter(
      (p) => p.active && (p.serviceId === serviceId || p.categoryId === categoryId || p.bucket === 'SERVICIOS'),
    );
    if (candidates.length === 0) return undefined;
    return [...candidates].sort((a, b) => specificity(a) - specificity(b))[0];
  }
}
