/**
 * @file sql.category.repository.ts
 * @description Implementación PostgreSQL del repositorio de categorías.
 */

import type { Pool } from 'pg';
import type { ICategoryRepository } from './category.repository.js';
import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
  CategoryField,
} from '../types/resource-category.types.js';

function mapRow(row: Record<string, unknown>): ResourceCategory {
  return {
    id:          row.id as string,
    name:        row.name as string,
    description: row.description as string | undefined,
    fields:      (row.fields as CategoryField[]) ?? [],
    active:      row.active as boolean,
    createdAt:   new Date(row.created_at as string),
    updatedAt:   new Date(row.updated_at as string),
  };
}

export class SqlCategoryRepository implements ICategoryRepository {
  constructor(private readonly pool: Pool) {}

  async findAll(): Promise<ResourceCategory[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM resource_categories WHERE active = TRUE ORDER BY created_at ASC`,
    );
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<ResourceCategory | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM resource_categories WHERE id = $1`,
      [id],
    );
    return rows.length ? mapRow(rows[0]) : null;
  }

  async countActive(): Promise<number> {
    const { rows } = await this.pool.query(
      `SELECT COUNT(*)::int AS total FROM resource_categories WHERE active = TRUE`,
    );
    return rows[0].total as number;
  }

  async create(dto: CreateCategoryDTO): Promise<ResourceCategory> {
    const { rows } = await this.pool.query(
      `INSERT INTO resource_categories (id, name, description, fields)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [dto.id, dto.name, dto.description ?? null, JSON.stringify(dto.fields)],
    );
    return mapRow(rows[0]);
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
    const { rows } = await this.pool.query(
      `UPDATE resource_categories SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    if (!rows.length) throw new Error(`Category ${id} not found`);
    return mapRow(rows[0]);
  }

  async deactivate(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE resource_categories SET active = FALSE WHERE id = $1`,
      [id],
    );
  }
}
