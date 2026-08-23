import { randomUUID } from 'crypto';
import type {
  CancellationPolicy,
  CancellationPolicyRepository,
  CreateCancellationPolicyInput,
  UpdateCancellationPolicyInput,
} from './cancellation-policy.repository.js';
import { CancellationPolicyNotFoundError } from '../domain/errors.js';

export class InMemoryCancellationPolicyRepository implements CancellationPolicyRepository {
  private policies: CancellationPolicy[] = [];

  seed(policy: CancellationPolicy): void {
    this.policies.push(policy);
  }

  async findAll(businessId: string): Promise<CancellationPolicy[]> {
    return this.policies
      .filter((p) => p.businessId === businessId)
      .sort((a, b) => a.minDaysBeforeCheckin - b.minDaysBeforeCheckin);
  }

  async findById(id: string): Promise<CancellationPolicy | null> {
    return this.policies.find((p) => p.id === id) ?? null;
  }

  async create(input: CreateCancellationPolicyInput): Promise<CancellationPolicy> {
    const policy: CancellationPolicy = {
      id: randomUUID(),
      businessId: input.businessId,
      minDaysBeforeCheckin: input.minDaysBeforeCheckin,
      refundPercentage: input.refundPercentage,
      active: true,
    };
    this.policies.push(policy);
    return policy;
  }

  /**
   * Construye un objeto nuevo en vez de mutar la fila existente en el lugar
   * — findById() devuelve la misma referencia guardada en `policies`, así
   * que mutarla in-place invalidaría cualquier snapshot `before` que un
   * caller (ej. CancellationPolicyService.updatePolicy(), para
   * diffFields()) haya tomado antes de llamar a update() -- mismo criterio
   * que InMemoryWasteReasonRepository.
   */
  async update(id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicy> {
    const index = this.policies.findIndex((p) => p.id === id);
    if (index === -1) throw new CancellationPolicyNotFoundError(id);
    const updated: CancellationPolicy = {
      ...this.policies[index]!,
      ...(input.minDaysBeforeCheckin !== undefined && { minDaysBeforeCheckin: input.minDaysBeforeCheckin }),
      ...(input.refundPercentage     !== undefined && { refundPercentage:     input.refundPercentage }),
      ...(input.active               !== undefined && { active:               input.active }),
    };
    this.policies[index] = updated;
    return updated;
  }

  async deactivate(id: string): Promise<void> {
    const index = this.policies.findIndex((p) => p.id === id);
    if (index !== -1) this.policies[index] = { ...this.policies[index]!, active: false };
  }

  async findApplicableTier(businessId: string, daysBeforeCheckin: number): Promise<CancellationPolicy | null> {
    const candidates = this.policies.filter(
      (p) => p.businessId === businessId && p.active && p.minDaysBeforeCheckin <= daysBeforeCheckin,
    );
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => b.minDaysBeforeCheckin - a.minDaysBeforeCheckin)[0]!;
  }
}
