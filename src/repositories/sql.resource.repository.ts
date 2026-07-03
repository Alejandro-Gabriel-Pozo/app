/**
 * @file sql.resource.repository.ts
 * @description Implementación PostgreSQL del repositorio de recursos.
 */

import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';
import { BookableResource } from '../domain/entities.js';
import { VisualMetadata } from '../types/visual.interface.js';

interface ResourceRow {
  id: string;
  name: string;
  category_id: string;
  base_price: number | string;
  visual_data: Record<string, unknown> | string | null;
  active: boolean;
}

export class SqlResourceRepository implements ResourceRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async save(resource: BookableResource): Promise<void> {
    const visualData = resource.visualData
      ? JSON.stringify(resource.visualData)
      : null;

    await this.sqlClient.query(
      `INSERT INTO resources (id, name, category_id, base_price, visual_data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name        = EXCLUDED.name,
         category_id = EXCLUDED.category_id,
         base_price  = EXCLUDED.base_price,
         visual_data = COALESCE(EXCLUDED.visual_data, resources.visual_data)`,
      [resource.id, resource.name, resource.categoryId, resource.basePrice, visualData],
    );
  }

  async getById(id: string): Promise<BookableResource | undefined> {
    const result = await this.sqlClient.query<ResourceRow>(
      `SELECT * FROM resources WHERE id = $1 AND active IS NOT FALSE`,
      [id],
    );
    return result.rows[0] ? this.rowToResource(result.rows[0]) : undefined;
  }

  async getByCategory(categoryId: string): Promise<BookableResource[]> {
    const result = await this.sqlClient.query<ResourceRow>(
      `SELECT * FROM resources
       WHERE category_id = $1 AND active IS NOT FALSE
       ORDER BY name ASC`,
      [categoryId],
    );
    return result.rows.map((row) => this.rowToResource(row));
  }

  async getAll(): Promise<BookableResource[]> {
    const result = await this.sqlClient.query<ResourceRow>(
      `SELECT * FROM resources WHERE active IS NOT FALSE ORDER BY name ASC`,
    );
    return result.rows.map((row) => this.rowToResource(row));
  }

  async getByName(name: string): Promise<BookableResource | undefined> {
    const result = await this.sqlClient.query<ResourceRow>(
      `SELECT * FROM resources
       WHERE LOWER(name) = LOWER($1) AND active IS NOT FALSE`,
      [name],
    );
    return result.rows[0] ? this.rowToResource(result.rows[0]) : undefined;
  }

  async countActive(): Promise<number> {
    const result = await this.sqlClient.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM resources WHERE active IS NOT FALSE`,
    );
    return result.rows[0].total;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.sqlClient.query(
      `UPDATE resources SET active = FALSE WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private rowToResource(row: ResourceRow): BookableResource {
    let visualData: VisualMetadata | null = null;

    if (row.visual_data != null) {
      // Parsear si viene como string (pg puede devolver JSONB como string o como objeto)
      const raw: unknown =
        typeof row.visual_data === 'string'
          ? JSON.parse(row.visual_data)
          : row.visual_data;
      // Cast via unknown para satisfacer el type-checker; el schema SQL garantiza la forma
      visualData = raw as unknown as VisualMetadata;
    }

    return new BookableResource(
      row.id,
      row.name,
      Number(row.base_price),
      row.category_id,
      visualData,
    );
  }
}
