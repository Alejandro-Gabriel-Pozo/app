// =============================================================================
// repositories/sql.service-item.repository.ts — Implementación PostgreSQL
// =============================================================================

import { randomUUID } from 'crypto';
import type { SqlClient } from '../repositories/sql.client.js';
import type { ServiceItemRepository } from './service-item.repository.js';
import type {
  ServiceItem,
  CreateServiceItemInput,
  UpdateServiceItemInput,
} from './service-item.entities.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';

const RETURNING_COLS = `id, business_id, category_id, name, description, price, active, deleted_at, created_at, updated_at`;

function mapRow(row: Record<string, unknown>): ServiceItem {
  return {
    id:          row['id'] as string,
    businessId:  row['business_id'] as string,
    categoryId:  (row['category_id'] as string | null) ?? null,
    name:        row['name'] as string,
    description: (row['description'] as string | null) ?? null,
    price:       Number(row['price']),
    active:      row['active'] as boolean,
    deletedAt:   row['deleted_at'] != null ? new Date(row['deleted_at'] as string) : null,
    createdAt:   new Date(row['created_at'] as string),
    updatedAt:   new Date(row['updated_at'] as string),
  };
}

export class SqlServiceItemRepository implements ServiceItemRepository {
  constructor(private readonly db: SqlClient) {}

  async findAll(businessId: string): Promise<ServiceItem[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM service_items
       WHERE business_id = $1 AND active = TRUE AND deleted_at IS NULL
       ORDER BY name ASC`,
      [businessId],
    );
    return rows.map(mapRow);
  }

  /**
   * No filtra por active ni por deleted_at — ver docs/criterios-datos.md R2
   * y el comentario en service-item.repository.ts.
   */
  async findById(id: string): Promise<ServiceItem | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM service_items WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(input: CreateServiceItemInput): Promise<ServiceItem> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO service_items (id, business_id, category_id, name, description, price)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING ${RETURNING_COLS}`,
      [
        id,
        input.businessId,
        input.categoryId ?? null,
        input.name,
        input.description ?? null,
        input.price,
      ],
    );
    return mapRow(rows[0]!);
  }

  async update(id: string, input: UpdateServiceItemInput): Promise<ServiceItem> {
    return this.updateWith(this.db, id, input);
  }

  async updateWithClient(client: SqlClient, id: string, input: UpdateServiceItemInput): Promise<ServiceItem> {
    return this.updateWith(client, id, input);
  }

  // Sin "AND active = TRUE" -- editar (o reactivar, vía input.active = true)
  // un ítem pausado tiene que funcionar, mismo criterio que
  // SqlCategoryRepository.updateWith().
  private async updateWith(client: SqlClient, id: string, input: UpdateServiceItemInput): Promise<ServiceItem> {
    const fields: string[]  = [];
    const params: unknown[] = [];
    let idx = 1;

    const map: Array<[keyof UpdateServiceItemInput, string]> = [
      ['categoryId',  'category_id'],
      ['name',        'name'],
      ['description', 'description'],
      ['price',       'price'],
      ['active',      'active'],
    ];

    for (const [key, col] of map) {
      if (input[key] !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(input[key] as unknown);
      }
    }

    if (fields.length === 0) {
      const item = await this.findById(id);
      if (!item) throw new ServiceItemNotFoundError(id);
      return item;
    }

    fields.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE service_items SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${RETURNING_COLS}`,
      params,
    );
    if (!rows[0]) throw new ServiceItemNotFoundError(id);
    return mapRow(rows[0]);
  }

  async deactivate(id: string): Promise<void> {
    await this.db.query(
      `UPDATE service_items SET active = FALSE, updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }
}
