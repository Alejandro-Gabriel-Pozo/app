import type { SqlClient } from './sql.client.js';
import type { BusinessProfileRepository } from './business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

function rowToProfile(row: Record<string, unknown>): BusinessProfile {
  return {
    id:           row['id'] as string,
    displayName:  (row['display_name']  as string | null) ?? null,
    contactEmail: (row['contact_email'] as string | null) ?? null,
    currency:     row['currency'] as string,
    timezone:     row['timezone'] as string,
    defaultCheckInTime:  row['default_check_in_time']  as string,
    defaultCheckOutTime: row['default_check_out_time'] as string,
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
    if (input.currency !== undefined) {
      fields.push(`currency = $${idx++}`);
      params.push(input.currency);
    }
    if (input.timezone !== undefined) {
      fields.push(`timezone = $${idx++}`);
      params.push(input.timezone);
    }
    if (input.defaultCheckInTime !== undefined) {
      fields.push(`default_check_in_time = $${idx++}`);
      params.push(input.defaultCheckInTime);
    }
    if (input.defaultCheckOutTime !== undefined) {
      fields.push(`default_check_out_time = $${idx++}`);
      params.push(input.defaultCheckOutTime);
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
