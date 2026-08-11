/**
 * @file in-memory.resource.repository.ts
 * @description Implementación in-memory del repositorio de recursos físicos.
 *
 * ## Cambios
 * - Se reemplaza `getByType(type: ResourceType)` por `getByCategory(categoryId: string)`.
 * - Se filtra por `r.categoryId` en lugar de `r.type`.
 * - Se agrega `countActive()` que cuenta el tamaño del mapa.
 * - PhysicalResource reemplaza a BookableResource (alias mantenido en entities.ts).
 */

import { PhysicalResource } from '../domain/entities.js';
import { ResourceRepository } from './resource.repository.js';

export class InMemoryResourceRepository implements ResourceRepository {
  private readonly resources = new Map<string, PhysicalResource>();

  async save(resource: PhysicalResource): Promise<void> {
    this.resources.set(resource.id, resource);
  }

  async getById(id: string): Promise<PhysicalResource | undefined> {
    return this.resources.get(id);
  }

  async getByCategory(categoryId: string): Promise<PhysicalResource[]> {
    return Array.from(this.resources.values()).filter(
      (r) => r.categoryId === categoryId,
    );
  }

  async getAll(): Promise<PhysicalResource[]> {
    return Array.from(this.resources.values());
  }

  async getByName(name: string): Promise<PhysicalResource | undefined> {
    return Array.from(this.resources.values()).find(
      (r) => r.name.toLowerCase() === name.toLowerCase(),
    );
  }

  async countActive(): Promise<number> {
    return this.resources.size;
  }

  async delete(id: string): Promise<boolean> {
    return this.resources.delete(id);
  }
}
