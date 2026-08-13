/**
 * @file resource.repository.ts
 * @description Interfaz del repositorio de recursos físicos.
 *
 * ## Cambios
 * - Se reemplaza `getByType(type: ResourceType)` por `getByCategory(categoryId: string)`.
 * - Se agrega `countActive()` para enforcement de límites por plan.
 * - Se elimina el import de `ResourceType`.
 * - PhysicalResource reemplaza a BookableResource (alias mantenido en entities.ts).
 */

import type { PhysicalResource } from '../domain/entities.js';

export interface ResourceRepository {
  save(resource: PhysicalResource): Promise<void>;
  getById(id: string): Promise<PhysicalResource | undefined>;
  getByCategory(categoryId: string): Promise<PhysicalResource[]>;
  getAll(): Promise<PhysicalResource[]>;
  getByName(name: string): Promise<PhysicalResource | undefined>;
  countActive(): Promise<number>;
  delete(id: string): Promise<boolean>;
}
