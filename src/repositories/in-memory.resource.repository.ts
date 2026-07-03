/**
 * @file in-memory.resource.repository.ts
 * @description Implementación in-memory del repositorio de recursos.
 *
 * ## Cambios
 * - Se reemplaza `getByType(type: ResourceType)` por `getByCategory(categoryId: string)`.
 * - Se filtra por `r.categoryId` en lugar de `r.type`.
 * - Se agrega `countActive()` que cuenta el tamaño del mapa.
 */

import { BookableResource } from '../domain/entities.js';
import { ResourceRepository } from './resource.repository.js';

export class InMemoryResourceRepository implements ResourceRepository {
  private readonly resources = new Map<string, BookableResource>();

  async save(resource: BookableResource): Promise<void> {
    this.resources.set(resource.id, resource);
  }

  async getById(id: string): Promise<BookableResource | undefined> {
    return this.resources.get(id);
  }

  async getByCategory(categoryId: string): Promise<BookableResource[]> {
    return Array.from(this.resources.values()).filter(
      (r) => r.categoryId === categoryId,
    );
  }

  async getAll(): Promise<BookableResource[]> {
    return Array.from(this.resources.values());
  }

  async getByName(name: string): Promise<BookableResource | undefined> {
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
