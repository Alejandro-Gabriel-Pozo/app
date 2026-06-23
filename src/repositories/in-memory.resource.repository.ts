import { ResourceType } from '../types/enums.js';
import { BookableResource } from '../domain/entities.js';
import { ResourceRepository } from './resource.repository.js';

/**
 * Implementación en memoria del repositorio de recursos.
 * Ideal para desarrollo y tests. No persiste entre reinicios.
 */
export class InMemoryResourceRepository implements ResourceRepository {
  private resources: Map<string, BookableResource> = new Map();

  async save(resource: BookableResource): Promise<void> {
    this.resources.set(resource.id, resource);
  }

  async getById(id: string): Promise<BookableResource | undefined> {
    return this.resources.get(id);
  }

  async getByType(type: ResourceType): Promise<BookableResource[]> {
    return Array.from(this.resources.values()).filter((r) => r.type === type);
  }

  async getAll(): Promise<BookableResource[]> {
    return Array.from(this.resources.values());
  }

  async delete(id: string): Promise<boolean> {
    return this.resources.delete(id);
  }
}
