import type { SqlClient } from '../repositories/sql.client.js';
import type { DepositPolicy, IDepositPolicyRepository } from './deposit-policy.repository.js';

interface DepositPolicyRow {
  id: string;
  business_id: string;
  resource_id: string | null;
  service_id: string | null;
  category_id: string | null;
  bucket: 'ALOJAMIENTO' | 'TURNOS' | 'SERVICIOS' | null;
  percentage: string;
  active: boolean;
}

function rowToPolicy(row: DepositPolicyRow): DepositPolicy {
  return {
    id:         row.id,
    businessId: row.business_id,
    resourceId: row.resource_id,
    serviceId:  row.service_id,
    categoryId: row.category_id,
    bucket:     row.bucket,
    percentage: parseFloat(row.percentage),
    active:     row.active,
  };
}

// Mismo criterio de especificidad que D9 (sql.customer-rate.repository.ts):
// ítem gana sobre categoría, categoría gana sobre bucket.
const SPECIFICITY_ORDER = `
  CASE
    WHEN resource_id IS NOT NULL OR service_id IS NOT NULL THEN 1
    WHEN category_id IS NOT NULL THEN 2
    ELSE 3
  END
`;

export class SqlDepositPolicyRepository implements IDepositPolicyRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveForResource(
    resourceId: string, categoryId: string, isLodging: boolean,
  ): Promise<DepositPolicy | undefined> {
    const bucket = isLodging ? 'ALOJAMIENTO' : 'TURNOS';
    const result = await this.db.query<DepositPolicyRow>(
      `SELECT * FROM deposit_policies
       WHERE active = TRUE
         AND (resource_id = $1 OR category_id = $2 OR bucket = $3)
       ORDER BY ${SPECIFICITY_ORDER} ASC
       LIMIT 1`,
      [resourceId, categoryId, bucket],
    );
    return result.rows[0] ? rowToPolicy(result.rows[0]) : undefined;
  }

  async findActiveForService(
    serviceId: string, categoryId: string,
  ): Promise<DepositPolicy | undefined> {
    const result = await this.db.query<DepositPolicyRow>(
      `SELECT * FROM deposit_policies
       WHERE active = TRUE
         AND (service_id = $1 OR category_id = $2 OR bucket = 'SERVICIOS')
       ORDER BY ${SPECIFICITY_ORDER} ASC
       LIMIT 1`,
      [serviceId, categoryId],
    );
    return result.rows[0] ? rowToPolicy(result.rows[0]) : undefined;
  }
}
