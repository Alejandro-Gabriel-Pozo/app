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

import type { PhysicalResource } from './resource.entities.js';
import type { ResourceRepository } from './resource.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

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

  /** No-op — no hay concurrencia real cross-conexión en los tests que usan este repo. */
  async lockByIds(_client: SqlClient, _ids: string[]): Promise<void> {
    return;
  }
}
