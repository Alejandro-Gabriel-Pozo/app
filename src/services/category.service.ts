/**
 * @file category.service.ts
 * @description Lógica de negocio para categorías de recursos.
 *
 * Responsabilidades:
 * - Validar límites de plan antes de crear categorías
 * - Delegar persistencia al repositorio
 * - Generar IDs deterministas a partir del nombre
 *
 * ## PlanLimitError
 * Expone `plan`, `limit` y `resource` como campos públicos para que
 * la capa HTTP (categories.routes.ts) los incluya en el body del 402
 * sin necesidad de hardcodear valores en el frontend.
 */

import type { ICategoryRepository } from '../repositories/category.repository.js';
import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
  CategoryField,
} from '../types/resource-category.types.js';
import { PLAN_LIMITS } from '../config/plan-limits.js';
import type { BusinessPlan } from '../types/enums.js';

export class PlanLimitError extends Error {
  constructor(
    public readonly plan: BusinessPlan,
    public readonly limit: number,
    public readonly resource: 'categories' | 'resources',
  ) {
    super(
      `Tu plan ${plan} permite hasta ${
        limit === Infinity ? 'ilimitadas' : limit
      } ${resource}. Actualizá tu plan para agregar más.`,
    );
    this.name = 'PlanLimitError';
  }
}

export class CategoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Categoría "${id}" no encontrada.`);
    this.name = 'CategoryNotFoundError';
  }
}

/** Genera un id slug a partir del nombre: "Turno de Baño" → "turno-de-bano" */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Valida que el objeto details de una reserva cumpla con los fields
 * definidos en la categoría. Lanza un Error descriptivo si hay campos
 * requeridos faltantes o valores de select inválidos.
 */
export function validateDetailsAgainstFields(
  details: unknown,
  fields: CategoryField[],
): void {
  const data = (details ?? {}) as Record<string, unknown>;

  for (const field of fields) {
    const value = data[field.name];

    if (field.required && (value === undefined || value === null || value === '')) {
      throw new Error(`El campo "${field.label}" es obligatorio.`);
    }

    if (value !== undefined && value !== null && field.type === 'select' && field.options) {
      if (!field.options.includes(String(value))) {
        throw new Error(
          `El campo "${field.label}" debe ser uno de: ${field.options.join(', ')}.`,
        );
      }
    }
  }
}

export class CategoryService {
  constructor(private readonly categoryRepository: ICategoryRepository) {}

  async listCategories(): Promise<ResourceCategory[]> {
    return this.categoryRepository.findAll();
  }

  async getCategoryById(id: string): Promise<ResourceCategory> {
    const cat = await this.categoryRepository.findById(id);
    if (!cat) throw new CategoryNotFoundError(id);
    return cat;
  }

  async createCategory(
    dto: Omit<CreateCategoryDTO, 'id'>,
    plan: BusinessPlan,
  ): Promise<ResourceCategory> {
    const limits  = PLAN_LIMITS[plan];
    const current = await this.categoryRepository.countActive();

    if (current >= limits.maxCategories) {
      throw new PlanLimitError(plan, limits.maxCategories, 'categories');
    }

    const id = `cat-${slugify(dto.name)}-${Date.now()}`;
    return this.categoryRepository.create({ ...dto, id });
  }

  async updateCategory(
    id: string,
    dto: UpdateCategoryDTO,
  ): Promise<ResourceCategory> {
    await this.getCategoryById(id); // throws if not found
    return this.categoryRepository.update(id, dto);
  }

  async deleteCategory(id: string): Promise<void> {
    await this.getCategoryById(id); // throws if not found
    await this.categoryRepository.deactivate(id);
  }
}
