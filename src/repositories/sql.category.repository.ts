/**
 * @file sql.category.repository.ts
 * @description Implementación PostgreSQL del repositorio de categorías.
 * Usa SqlClient (interfaz genérica) en lugar del Pool de pg directamente.
 */

import type { SqlClient } from './sql.client.js';
import type { ICategoryRepository } from './category.repository.js';
import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
  CategoryField,
} from '../types/resource-category.types.js';

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
      `SELECT * FROM resource_categories WHERE active = TRUE ORDER BY created_at ASC`,
    );
    return (result.rows as Record<string, unknown>[]).map(mapRow);
  }

  async findById(id: string): Promise<ResourceCategory | null> {
    const result = await this.sqlClient.query(
      `SELECT * FROM resource_categories WHERE id = $1`,
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
       RETURNING *`,
      [dto.id, dto.name, dto.description ?? null, JSON.stringify(dto.fields ?? [])],
    );
    const rows = result.rows as Record<string, unknown>[];
    return mapRow(rows[0] ?? {});
  }

  async update(id: string, dto: UpdateCategoryDTO): Promise<ResourceCategory> {
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.name !== undefined)        { setClauses.push(`name = $${idx++}`);        values.push(dto.name); }
    if (dto.description !== undefined) { setClauses.push(`description = $${idx++}`); values.push(dto.description); }
    if (dto.fields !== undefined)      { setClauses.push(`fields = $${idx++}`);      values.push(JSON.stringify(dto.fields)); }
    if (dto.active !== undefined)      { setClauses.push(`active = $${idx++}`);      values.push(dto.active); }

    if (setClauses.length === 0) {
      const cat = await this.findById(id);
      if (!cat) throw new Error(`Category ${id} not found`);
      return cat;
    }

    values.push(id);
    const result = await this.sqlClient.query(
      `UPDATE resource_categories SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    const rows = result.rows as Record<string, unknown>[];
    if (!rows.length) throw new Error(`Category ${id} not found`);
    return mapRow(rows[0] ?? {});
  }

  async deactivate(id: string): Promise<void> {
    await this.sqlClient.query(
      `UPDATE resource_categories SET active = FALSE WHERE id = $1`,
      [id],
    );
  }
}
