/**
 * @file sql.rate-catalog.repository.ts
 * @description Implementación SQL de IRateCatalogRepository.
 *
 * `businessId` como guardia multi-tenant en findById/deactivate — mismo
 * criterio que SqlCategoryRepository/PlatformRepository.getRoleById.
 */

import type {
  IRateCatalogRepository,
  RateCatalogEntry,
  CreateRateCatalogEntryDto,
  UpdateRateCatalogEntryDto,
} from './rate-catalog.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

export class SqlRateCatalogRepository implements IRateCatalogRepository {
  constructor(private readonly db: SqlClient) {}

  async findById(id: string, businessId: string): Promise<RateCatalogEntry | undefined> {
    const result = await this.db.query<RateCatalogRow>(
      `SELECT * FROM rate_catalog WHERE id = $1 AND business_id = $2`,
      [id, businessId],
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : undefined;
  }

  async listActiveByBusiness(businessId: string): Promise<RateCatalogEntry[]> {
    const result = await this.db.query<RateCatalogRow>(
      `SELECT * FROM rate_catalog WHERE business_id = $1 AND active = TRUE ORDER BY name ASC`,
      [businessId],
    );
    return result.rows.map(rowToEntry);
  }

  async create(dto: CreateRateCatalogEntryDto): Promise<RateCatalogEntry> {
    const result = await this.db.query<RateCatalogRow>(
      `INSERT INTO rate_catalog (id, business_id, name, discount_percentage, resource_id, service_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [dto.id, dto.businessId, dto.name, dto.discountPercentage, dto.resourceId ?? null, dto.serviceId ?? null],
    );
    return rowToEntry(result.rows[0]!);
  }

  async update(id: string, businessId: string, dto: UpdateRateCatalogEntryDto): Promise<RateCatalogEntry | undefined> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (dto.name !== undefined) { fields.push(`name = $${idx++}`); values.push(dto.name); }
    if (dto.discountPercentage !== undefined) { fields.push(`discount_percentage = $${idx++}`); values.push(dto.discountPercentage); }
    if (fields.length === 0) return this.findById(id, businessId);

    values.push(id, businessId);
    const result = await this.db.query<RateCatalogRow>(
      `UPDATE rate_catalog SET ${fields.join(', ')}
       WHERE id = $${idx++} AND business_id = $${idx++}
       RETURNING *`,
      values,
    );
    return result.rows[0] ? rowToEntry(result.rows[0]) : undefined;
  }

  async deactivate(id: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE rate_catalog SET active = FALSE WHERE id = $1 AND business_id = $2 AND active = TRUE`,
      [id, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

interface RateCatalogRow {
  id: string;
  business_id: string;
  name: string;
  discount_percentage: string;
  resource_id: string | null;
  service_id: string | null;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

function rowToEntry(r: RateCatalogRow): RateCatalogEntry {
  return {
    id: r.id,
    businessId: r.business_id,
    name: r.name,
    discountPercentage: parseFloat(r.discount_percentage),
    resourceId: r.resource_id,
    serviceId: r.service_id,
    active: r.active,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
