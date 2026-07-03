/**
 * @file sql.resource.repository.ts
 * @description Implementación PostgreSQL del repositorio de recursos.
 *
 * ## Cambios respecto a la versión anterior
 * - Se reemplaza `type` por `category_id` en todas las queries.
 *   El antiguo enum `ResourceType` ya no existe — el tipo de recurso
 *   es una FK a `resource_categories` definida por cada negocio.
 * - Se agrega `countActive()` para enforcement de plan en `ResourceService`.
 * - `rowToResource` ya no usa `createBookableResource()` (factory acoplada
 *   a ResourceType). Devuelve un objeto plano compatible con `BookableResource`.
 */

import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';
import { BookableResource } from '../domain/entities.js';

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
    const visualData =
      row.visual_data == null
        ? null
        : typeof row.visual_data === 'string'
          ? (JSON.parse(row.visual_data) as Record<string, unknown>)
          : row.visual_data;

    return {
      id:         row.id,
      name:       row.name,
      categoryId: row.category_id,
      basePrice:  Number(row.base_price),
      visualData,
      isAvailable: BookableResourceMixin.isAvailable,
    } as BookableResource;
  }
}

/**
 * Mixin para el método isAvailable — necesario porque BookableResource
 * ya no se construye via factory acoplada a ResourceType.
 * La lógica real de disponibilidad vive en la entidad de dominio;
 * aquí solo delegamos al método estático que ya existía.
 */
const BookableResourceMixin = {
  isAvailable(
    this: BookableResource,
    startTime: Date,
    endTime: Date,
    activeReservations: Array<{ startTime: Date; endTime: Date; id: string }>,
    excludeId?: string,
  ): boolean {
    const relevant = excludeId
      ? activeReservations.filter((r) => r.id !== excludeId)
      : activeReservations;
    return !relevant.some(
      (r) => startTime < r.endTime && endTime > r.startTime,
    );
  },
};
