import type { NumberSequenceRepository, NumberSequenceEntityType } from './number-sequence.repository.js';

export class InMemoryNumberSequenceRepository implements NumberSequenceRepository {
  private readonly counters = new Map<NumberSequenceEntityType, number>();

  async next(entityType: NumberSequenceEntityType): Promise<number> {
    const current = this.counters.get(entityType) ?? 1;
    this.counters.set(entityType, current + 1);
    return current;
  }
}
