/**
 * @file sql.resource.repository.ts
 * @description Implementación PostgreSQL del repositorio de recursos.
 *
 * ## Cambios — fix/report-group-by-category
 * - Las queries que devuelven recursos ahora hacen LEFT JOIN con
 *   resource_categories para poblar BookableResource.categoryName.
 *   save() y delete() no se modifican (no leen la entidad de vuelta).
 */

import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';
import { BookableResource } from '../domain/entities.js';
import { VisualMetadata } from '../types/visual.interface.js';

interface ResourceRow {
  id: string;
  name: string;
  category_id: string;
  category_name: string | null;
  base_price: number | string;
  visual_data: Record<string, unknown> | string | null;
  active: boolean;
}

const SELECT_WITH_CATEGORY = `
  SELECT
    r.id,
    r.name,
    r.category_id,
    rc.name AS category_name,
    r.base_price,
    r.visual_data,
    r.active
  FROM resources r
  LEFT JOIN resource_categories rc ON rc.id = r.category_id
`;

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
      `${SELECT_WITH_CATEGORY} WHERE r.id = $1 AND r.active IS NOT FALSE`,
      [id],
    );
    return result.rows[0] ? this.rowToResource(result.rows[0]) : undefined;
  }

  async getByCategory(categoryId: string): Promise<BookableResource[]> {
    const result = await this.sqlClient.query<ResourceRow>(
      `${SELECT_WITH_CATEGORY}
       WHERE r.category_id = $1 AND r.active IS NOT FALSE
       ORDER BY r.name ASC`,
      [categoryId],
    );
    return result.rows.map((row) => this.rowToResource(row));
  }

  async getAll(): Promise<BookableResource[]> {
    const result = await this.sqlClient.query<ResourceRow>(
      `${SELECT_WITH_CATEGORY} WHERE r.active IS NOT FALSE ORDER BY r.name ASC`,
    );
    return result.rows.map((row) => this.rowToResource(row));
  }

  async getByName(name: string): Promise<BookableResource | undefined> {
    const result = await this.sqlClient.query<ResourceRow>(
      `${SELECT_WITH_CATEGORY}
       WHERE LOWER(r.name) = LOWER($1) AND r.active IS NOT FALSE`,
      [name],
    );
    return result.rows[0] ? this.rowToResource(result.rows[0]) : undefined;
  }

  async countActive(): Promise<number> {
    const result = await this.sqlClient.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM resources WHERE active IS NOT FALSE`,
    );
    return result.rows[0]?.total ?? 0;
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
      const raw: unknown =
        typeof row.visual_data === 'string'
          ? JSON.parse(row.visual_data)
          : row.visual_data;
      visualData = raw as unknown as VisualMetadata;
    }

    return new BookableResource(
      row.id,
      row.name,
      Number(row.base_price),
      row.category_id,
      visualData,
      /* capacity    */ 1,
      /* description */ null,
      row.category_name ?? null,
    );
  }
}
