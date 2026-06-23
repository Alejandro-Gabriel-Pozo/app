import { ResourceType } from '../types/enums.js';
import { TableResource } from '../domain/entities.js';
import { createBookableResource } from '../domain/resource.factory.js';
import { BookableResource } from '../domain/entities.js';
import { VisualMetadata } from '../types/visual.interface.js';
import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';

interface ResourceRow {
  id: string;
  name: string;
  type: ResourceType;
  base_price: number | string;
  visual_data: VisualMetadata | string | null;
}

/**
 * Implementación SQL del repositorio de recursos.
 *
 * Schema esperado (PostgreSQL):
 * ```sql
 * CREATE TABLE resources (
 *   id VARCHAR(255) PRIMARY KEY,
 *   name VARCHAR(255) NOT NULL,
 *   type VARCHAR(50) NOT NULL,
 *   base_price DECIMAL(10,2) NOT NULL,
 *   visual_data JSONB,
 *   active BOOLEAN DEFAULT TRUE
 * );
 *
 * CREATE INDEX idx_resources_type ON resources(type);
 * ```
 */
export class SqlResourceRepository implements ResourceRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async save(resource: BookableResource): Promise<void> {
    const visualData =
      resource instanceof TableResource
        ? JSON.stringify(resource.visualData)
        : null;

    const sql = `
      INSERT INTO resources (id, name, type, base_price, visual_data)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (id) DO UPDATE SET
        name = $2,
        type = $3,
        base_price = $4,
        visual_data = $5
    `.trim();

    await this.sqlClient.query(sql, [
      resource.id,
      resource.name,
      resource.type,
      resource.basePrice,
      visualData,
    ]);
  }

  async getById(id: string): Promise<BookableResource | undefined> {
    const sql = `SELECT * FROM resources WHERE id = $1 AND active IS NOT FALSE`;
    const result = await this.sqlClient.query(sql, [id]);
    const row = (result.rows as ResourceRow[])[0];
    return row ? this.rowToResource(row) : undefined;
  }

  async getByType(type: ResourceType): Promise<BookableResource[]> {
    const sql = `
      SELECT * FROM resources
      WHERE type = $1 AND active IS NOT FALSE
      ORDER BY name ASC
    `;
    const result = await this.sqlClient.query(sql, [type]);
    return (result.rows as ResourceRow[]).map((row) => this.rowToResource(row));
  }

  async getAll(): Promise<BookableResource[]> {
    const sql = `
      SELECT * FROM resources
      WHERE active IS NOT FALSE
      ORDER BY name ASC
    `;
    const result = await this.sqlClient.query(sql);
    return (result.rows as ResourceRow[]).map((row) => this.rowToResource(row));
  }

  async delete(id: string): Promise<boolean> {
    const sql = `
      UPDATE resources SET active = FALSE WHERE id = $1
    `;
    const result = await this.sqlClient.query(sql, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  private rowToResource(row: ResourceRow): BookableResource {
    const visualData =
      row.visual_data == null
        ? null
        : typeof row.visual_data === 'string'
          ? (JSON.parse(row.visual_data) as VisualMetadata)
          : row.visual_data;

    return createBookableResource({
      id: row.id,
      name: row.name,
      type: row.type,
      basePrice: Number(row.base_price),
      visualData,
    });
  }
}
