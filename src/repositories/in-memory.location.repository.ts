/**
 * @file in-memory.location.repository.ts
 * @description Implementación in-memory de LocationRepository — para tests.
 */

import type { Location, LocationRepository, CreateLocationInput } from './location.repository.js';

export class InMemoryLocationRepository implements LocationRepository {
  private readonly locations = new Map<string, Location>();

  async findAll(): Promise<Location[]> {
    return [...this.locations.values()].filter((l) => l.active);
  }

  async findById(id: string): Promise<Location | null> {
    return this.locations.get(id) ?? null;
  }

  async create(input: CreateLocationInput): Promise<Location> {
    const now = new Date();
    const location: Location = { id: input.id, name: input.name, active: true, createdAt: now, updatedAt: now };
    this.locations.set(location.id, location);
    return location;
  }

  /** Helper de test — carga una location directo sin pasar por create(). */
  seed(location: Location): void {
    this.locations.set(location.id, location);
  }
}
