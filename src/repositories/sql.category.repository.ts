/**
 * @file sql.category.repository.ts
 * @description Implementación PostgreSQL del repositorio de categorías.
 * Usa SqlClient (interfaz genérica) en lugar del Pool de pg directamente.
 *
 * ## Cambios
 * - findById() filtra active = TRUE para no retornar categorías soft-deleted.
 *   Sin este filtro, un recurso podía crearse con una categoría borrada
 *   porque el check de FK en resources.routes.ts pasaba igual.
 * - update() lanza CategoryNotFoundError (tipado) en vez de Error genérico
 *   para que el instanceof en categories.routes.ts lo capture como 404.
 * - create() y update() usan columnas explícitas en RETURNING en lugar
 *   de RETURNING * para no filtrar columnas futuras sin procesar.
 */

import type { SqlClient } from './sql.client.js';
import type { ICategoryRepository } from './category.repository.js';
import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
  CategoryField,
} from '../types/resource-category.types.js';
import { CategoryNotFoundError } from '../services/category.service.js';

const RETURNING_COLS = `
  id, name, description, fields, active, created_at, updated_at
`;

function mapRow(row: Record<string, unknown>): ResourceCategory {
  const description = row['description'] as string | undefined;
  return {
    id:        row['id'] as string,
    name:      row['name'] as string,
    ...(description !== undefined && { description }),
    fields:    (row['fields'] as CategoryField[]) ?? [],
    active:    row['active'] as boolean,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

export class SqlCategoryRepository implements ICategoryRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async findAll(): Promise<ResourceCategory[]> {
    const result = await this.sqlClient.query(
      `SELECT id, name, description, fields, active, created_at, updated_at
       FROM resource_categories
       WHERE active = TRUE
       ORDER BY created_at ASC`,
    );
    return (result.rows as Record<string, unknown>[]).map(mapRow);
  }

  /**
   * Retorna null si la categoría no existe O si fue soft-deleted (active = FALSE).
   * Esto evita que recursos se creen apuntando a categorías borradas.
   */
  async findById(id: string): Promise<ResourceCategory | null> {
    const result = await this.sqlClient.query(
      `SELECT id, name, description, fields, active, created_at, updated_at
       FROM resource_categories
       WHERE id = $1 AND active = TRUE`,
      [id],
    );
    const rows = result.rows as Record<string, unknown>[];
    return rows.length ? mapRow(rows[0] ?? {}) : null;
  }

  async countActive(): Promise<number> {
    const result = await this.sqlClient.query(
      `SELECT COUNT(*)::int AS total FROM resource_categories WHERE active = TRUE`,
    );
    const rows = result.rows as Array<{ total: number }>;
    return rows[0]?.total ?? 0;
  }

  async create(dto: CreateCategoryDTO): Promise<ResourceCategory> {
    const result = await this.sqlClient.query(
      `INSERT INTO resource_categories (id, name, description, fields)
       VALUES ($1, $2, $3, $4)
       RETURNING ${RETURNING_COLS}`,
      [dto.id, dto.name, dto.description ?? null, JSON.stringify(dto.fields ?? [])],
    );
    const rows = result.rows as Record<string, unknown>[];
    return mapRow(rows[0] ?? {});
  }

  async update(id: string, dto: UpdateCategoryDTO): Promise<ResourceCategory> {
    const setClauses: string[] = [];
    const values: unknown[]    = [];
    let idx = 1;

    if (dto.name        !== undefined) { setClauses.push(`name = $${idx++}`);        values.push(dto.name); }
    if (dto.description !== undefined) { setClauses.push(`description = $${idx++}`); values.push(dto.description); }
    if (dto.fields      !== undefined) { setClauses.push(`fields = $${idx++}`);      values.push(JSON.stringify(dto.fields)); }
    if (dto.active      !== undefined) { setClauses.push(`active = $${idx++}`);      values.push(dto.active); }

    if (setClauses.length === 0) {
      const cat = await this.findById(id);
      if (!cat) throw new CategoryNotFoundError(id);
      return cat;
    }

    values.push(id);
    const result = await this.sqlClient.query(
      `UPDATE resource_categories
       SET ${setClauses.join(', ')}
       WHERE id = $${idx} AND active = TRUE
       RETURNING ${RETURNING_COLS}`,
      values,
    );
    const rows = result.rows as Record<string, unknown>[];
    if (!rows.length) throw new CategoryNotFoundError(id);
    return mapRow(rows[0] ?? {});
  }

  async deactivate(id: string): Promise<void> {
    await this.sqlClient.query(
      `UPDATE resource_categories SET active = FALSE WHERE id = $1`,
      [id],
    );
  }
}
