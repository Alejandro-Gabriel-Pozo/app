/**
 * @file resource.repository.ts
 * @description Interfaz del repositorio de recursos.
 *
 * ## Cambios
 * - Se reemplaza `getByType(type: ResourceType)` por `getByCategory(categoryId: string)`.
 * - Se agrega `countActive()` para enforcement de límites por plan.
 * - Se elimina el import de `ResourceType`.
 */

import { BookableResource } from '../domain/entities.js';

export interface ResourceRepository {
  save(resource: BookableResource): Promise<void>;
  getById(id: string): Promise<BookableResource | undefined>;
  getByCategory(categoryId: string): Promise<BookableResource[]>;
  getAll(): Promise<BookableResource[]>;
  getByName(name: string): Promise<BookableResource | undefined>;
  countActive(): Promise<number>;
  delete(id: string): Promise<boolean>;
}
