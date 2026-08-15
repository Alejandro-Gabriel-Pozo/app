/**
 * @file sql.resource.repository.ts
 * @description Implementación PostgreSQL del repositorio de recursos físicos.
 *
 * ## Cambios — fix/report-group-by-category
 * - Las queries que devuelven recursos ahora hacen LEFT JOIN con
 *   resource_categories para poblar PhysicalResource.categoryName.
 *   save() y delete() no se modifican (no leen la entidad de vuelta).
 *
 * ## Cambios — fix/catalog-integrity (13/08/2026, docs/criterios-datos.md)
 * - getById() YA NO filtra por active. Antes filtraba `active IS NOT FALSE`
 *   (que además colaba los NULL, inconsistente con category_repository) —
 *   esto rompía SqlReservationRepository.rowToReservation(), que usa
 *   getById() para reconstruir el resource de CUALQUIER reserva leída: una
 *   reserva histórica cuyo recurso se desactivaba se volvía completamente
 *   ilegible (ResourceNotFoundError al listar/leer). R2 + R10.
 * - getAll()/getByCategory()/getByName()/countActive() excluyen
 *   deleted_at IS NOT NULL — esos sí son listados, ahí el filtro corresponde.
 * - rowToResource() ahora pasa `row.active` al dominio — antes la columna
 *   se leía de la fila pero nunca llegaba a PhysicalResource.
 */

import type { SqlClient } from './sql.client.js';
import type { ResourceRepository } from './resource.repository.js';
import { PhysicalResource } from '../domain/resource.entities.js';
import type { VisualMetadata } from '../types/visual.interface.js';

interface ResourceRow {
  id: string;
  name: string;
  category_id: string;
  category_name: string | null;
  base_price: number | string;
  visual_data: Record<string, unknown> | string | null;
  active: boolean;
  location_id: string | null;
}

const SELECT_WITH_CATEGORY = `
  SELECT
    r.id,
    r.name,
    r.category_id,
    rc.name AS category_name,
    r.base_price,
    r.visual_data,
    r.active,
    r.location_id
  FROM resources r
  LEFT JOIN resource_categories rc ON rc.id = r.category_id
`;

export class SqlResourceRepository implements ResourceRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async save(resource: PhysicalResource): Promise<void> {
    const visualData = resource.visualData
      ? JSON.stringify(resource.visualData)
      : null;

    // location_id: en el INSERT, `resource.locationId` nulo cae a
    // 'loc-default' (red de seguridad si algún caller no lo resolvió antes
    // de llegar acá — resources.routes.ts sí lo hace). En el UPDATE
    // (ON CONFLICT) un valor nulo NO pisa la location ya guardada — evita
    // que un PUT que no toca locationId resetee el recurso a la default.
    await this.sqlClient.query(
      `INSERT INTO resources (id, name, category_id, base_price, visual_data, location_id)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'loc-default'))
       ON CONFLICT (id) DO UPDATE SET
         name        = EXCLUDED.name,
         category_id = EXCLUDED.category_id,
         base_price  = EXCLUDED.base_price,
         visual_data = COALESCE(EXCLUDED.visual_data, resources.visual_data),
         location_id = COALESCE(EXCLUDED.location_id, resources.location_id)`,
      [resource.id, resource.name, resource.categoryId, resource.basePrice, visualData, resource.locationId],
    );
  }

  /**
   * NO filtra por active/deleted_at — ver docs/criterios-datos.md R2.
   * Buscar por ID es "dame esta fila", no "dame esta fila si todavía me
   * gusta". El caller decide qué hacer con un recurso pausado o borrado
   * (ej. ReservationService rechaza explícitamente usarlo en una reserva
   * NUEVA, pero una reserva EXISTENTE que ya lo referencia sigue
   * pudiendo leerlo).
   */
  async getById(id: string): Promise<PhysicalResource | undefined> {
    const result = await this.sqlClient.query<ResourceRow>(
      `${SELECT_WITH_CATEGORY} WHERE r.id = $1`,
      [id],
    );
    return result.rows[0] ? this.rowToResource(result.rows[0]) : undefined;
  }

  async getByCategory(categoryId: string): Promise<PhysicalResource[]> {
    const result = await this.sqlClient.query<ResourceRow>(
      `${SELECT_WITH_CATEGORY}
       WHERE r.category_id = $1 AND r.active IS NOT FALSE AND r.deleted_at IS NULL
       ORDER BY r.name ASC`,
      [categoryId],
    );
    return result.rows.map((row) => this.rowToResource(row));
  }

  async getAll(): Promise<PhysicalResource[]> {
    const result = await this.sqlClient.query<ResourceRow>(
      `${SELECT_WITH_CATEGORY} WHERE r.active IS NOT FALSE AND r.deleted_at IS NULL ORDER BY r.name ASC`,
    );
    return result.rows.map((row) => this.rowToResource(row));
  }

  async getByName(name: string): Promise<PhysicalResource | undefined> {
    const result = await this.sqlClient.query<ResourceRow>(
      `${SELECT_WITH_CATEGORY}
       WHERE LOWER(r.name) = LOWER($1) AND r.active IS NOT FALSE AND r.deleted_at IS NULL`,
      [name],
    );
    return result.rows[0] ? this.rowToResource(result.rows[0]) : undefined;
  }

  async countActive(): Promise<number> {
    const result = await this.sqlClient.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM resources WHERE active IS NOT FALSE AND deleted_at IS NULL`,
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

  private rowToResource(row: ResourceRow): PhysicalResource {
    let visualData: VisualMetadata | null = null;

    if (row.visual_data != null) {
      const raw: unknown =
        typeof row.visual_data === 'string'
          ? JSON.parse(row.visual_data)
          : row.visual_data;
      visualData = raw as unknown as VisualMetadata;
    }

    return new PhysicalResource(
      row.id,
      row.name,
      Number(row.base_price),
      row.category_id,
      visualData,
      /* capacity    */ 1,
      /* description */ null,
      row.category_name ?? null,
      row.location_id,
      row.active,
    );
  }
}
