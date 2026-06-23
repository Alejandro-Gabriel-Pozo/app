import { ResourceType } from '../types/enums.js';
import { BookableResource } from '../domain/entities.js';

/**
 * Interfaz de repositorio para recursos reservables.
 * Implementaciones:
 * - InMemoryResourceRepository (dev/tests)
 * - SqlResourceRepository (PostgreSQL/MySQL)
 */
export interface ResourceRepository {
  save(resource: BookableResource): Promise<void>;

  getById(id: string): Promise<BookableResource | undefined>;

  getByType(type: ResourceType): Promise<BookableResource[]>;

  getAll(): Promise<BookableResource[]>;

  delete(id: string): Promise<boolean>;
}
