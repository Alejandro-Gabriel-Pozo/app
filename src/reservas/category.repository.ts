/**
 * @file category.repository.ts
 * @description Interfaz del repositorio de categorías de recursos.
 */

import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
} from './resource-category.types.js';

export interface ICategoryRepository {
  /** Devuelve todas las categorías activas */
  findAll(): Promise<ResourceCategory[]>;

  /** Devuelve una categoría por id, o null si no existe */
  findById(id: string): Promise<ResourceCategory | null>;

  /** Cuenta categorías activas (para enforcement de plan) */
  countActive(): Promise<number>;

  /** Crea una categoría nueva */
  create(dto: CreateCategoryDTO): Promise<ResourceCategory>;

  /** Actualiza campos de una categoría existente */
  update(id: string, dto: UpdateCategoryDTO): Promise<ResourceCategory>;

  /** Soft-delete: activa = false */
  deactivate(id: string): Promise<void>;
}
