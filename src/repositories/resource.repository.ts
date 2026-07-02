import { ResourceType } from '../types/enums.js';
import { BookableResource } from '../domain/entities.js';

/**
 * Interfaz de repositorio para recursos reservables.
 * Implementaciones:
 * - InMemoryResourceRepository (dev/tests)
 * - SqlResourceRepository (PostgreSQL)
 *
 * Nota: Crítico para deserializar objetos Reservation desde BD,
 * ya que el tipo concreto (Cabin, Table, etc.) no se puede inferir
 * solo del enum ResourceType.
 */
export interface ResourceRepository {
  /** Guarda o actualiza un recurso (upsert). */
  save(resource: BookableResource): Promise<void>;

  /** Obtiene un recurso por ID. */
  getById(id: string): Promise<BookableResource | undefined>;

  /** Obtiene recursos por tipo. */
  getByType(type: ResourceType): Promise<BookableResource[]>;

  /** Obtiene todos los recursos activos. */
  getAll(): Promise<BookableResource[]>;

  /** Obtiene un recurso por nombre exacto (case-insensitive). */
  getByName(name: string): Promise<BookableResource | undefined>;

  /** Soft-delete de un recurso. */
  delete(id: string): Promise<boolean>;
}
