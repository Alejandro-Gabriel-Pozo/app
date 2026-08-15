import type { SqlClient } from './sql.client.js';
import type { BusinessProfileRepository } from './business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

function rowToProfile(row: Record<string, unknown>): BusinessProfile {
  return {
    id:           row['id'] as string,
    displayName:  (row['display_name']  as string | null) ?? null,
    contactEmail: (row['contact_email'] as string | null) ?? null,
    createdAt:    new Date(row['created_at'] as string),
    updatedAt:    new Date(row['updated_at'] as string),
  };
}

export class SqlBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly db: SqlClient) {}

  async get(): Promise<BusinessProfile> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM business_profile WHERE id = 'default' LIMIT 1`,
    );
    if (!rows[0]) {
      throw new Error("business_profile sin la fila 'default' -- ¿se corrió schema.sql?");
    }
    return rowToProfile(rows[0]);
  }

  async update(input: UpdateBusinessProfileInput): Promise<BusinessProfile> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.displayName !== undefined) {
      fields.push(`display_name = $${idx++}`);
      params.push(input.displayName?.trim() || null);
    }
    if (input.contactEmail !== undefined) {
      fields.push(`contact_email = $${idx++}`);
      params.push(input.contactEmail?.trim() || null);
    }

    if (fields.length === 0) return this.get();

    fields.push('updated_at = NOW()');

    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE business_profile SET ${fields.join(', ')} WHERE id = 'default' RETURNING *`,
      params,
    );
    return rowToProfile(rows[0]!);
  }
}
