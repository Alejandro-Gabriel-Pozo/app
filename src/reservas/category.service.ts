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
 * Vive en domain/errors.ts (17/08/2026, F2 -- pendientes-2026-08-17.md:
 * ahora también lo usa usuarios-roles/users.routes.ts para el límite de
 * asientos por plan). Expone `plan`, `limit` y `resource` como campos
 * públicos para que la capa HTTP (categories.routes.ts) los incluya en
 * el body del 402 sin necesidad de hardcodear valores en el frontend.
 */

import type { ICategoryRepository } from './category.repository.js';
import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
  CategoryField,
} from './resource-category.types.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type { BusinessPlan } from '../types/enums.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { diffFields, recordFieldChanges } from '../domain/audit.js';
import { CategoryNotFoundError, PlanLimitError } from '../domain/errors.js';

const AUDIT_ENTITY = 'resource_categories';

// CategoryNotFoundError vive en domain/errors.ts (extiende DomainError,
// code CATEGORY_NOT_FOUND, ya mapeado a 404 en error.middleware.ts).
// Hasta el 14/08/2026 este archivo definía una clase local homónima que
// extendía Error a secas — dos clases con el mismo nombre, la de acá sin
// `.code`, así que categories.routes.ts no podía dejar de capturarla
// localmente sin que un 404 real cayera al 500 genérico (C2,
// pendientes-2026-08-13.md). Se unificó en una sola — sql.category.
// repository.ts y categories.routes.ts ahora importan directo de
// domain/errors.ts, no de acá (mismo criterio que C7: sin re-exports).

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
  constructor(
    private readonly categoryRepository: ICategoryRepository,
    /**
     * Requerido para que updateCategory() deje rastro (R8/A9.4). No se
     * exigió también en create/deactivate en esta primera pasada — ver nota
     * en updateCategory().
     */
    private readonly auditLogRepository: AuditLogRepository,
  ) {}

  async listCategories(): Promise<ResourceCategory[]> {
    return this.categoryRepository.findAll();
  }

  async getCategoryById(id: string): Promise<ResourceCategory> {
    const cat = await this.categoryRepository.findById(id);
    if (!cat) throw new CategoryNotFoundError(id);
    return cat;
  }

  /**
   * `limits` se resuelve en la capa HTTP (categories.routes.ts, vía
   * AppContainer.getPlanLimits) y se pasa ya armado -- este service NO
   * consulta la BD de plataforma directamente (queda tenant-only, mismo
   * criterio que ya regía `plan`).
   */
  async createCategory(
    dto: Omit<CreateCategoryDTO, 'id'>,
    plan: BusinessPlan,
    limits: PlanLimits,
  ): Promise<ResourceCategory> {
    const current = await this.categoryRepository.countActive();

    if (current >= limits.maxCategories) {
      throw new PlanLimitError(plan, limits.maxCategories, 'categories');
    }

    const id = `cat-${slugify(dto.name)}-${Date.now()}`;
    return this.categoryRepository.create({ ...dto, id });
  }

  /**
   * `changedBy` es el identity_id (JWT sub) de quien hace el cambio — ver
   * docs/criterios-datos.md R8. Solo se audita esta operación por ahora:
   * create() no compara contra nada previo (es el valor inicial, ya cubierto
   * por created_at) y deactivate()/delete() quedan fuera de esta primera
   * pasada, deliberado — ampliar cuando haga falta auditar bajas también.
   */
  async updateCategory(
    id: string,
    dto: UpdateCategoryDTO,
    changedBy: string,
  ): Promise<ResourceCategory> {
    const before = await this.getCategoryById(id); // throws if not found
    const updated = await this.categoryRepository.update(id, dto);

    const changes = diffFields(before, dto);
    await recordFieldChanges(this.auditLogRepository, AUDIT_ENTITY, id, changes, changedBy);

    return updated;
  }

  async deleteCategory(id: string): Promise<void> {
    await this.getCategoryById(id); // throws if not found
    await this.categoryRepository.deactivate(id);
  }
}
