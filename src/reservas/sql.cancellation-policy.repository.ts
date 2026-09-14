import { randomUUID } from 'crypto';
import type { SqlClient } from '../repositories/sql.client.js';
import type {
  CancellationPolicy,
  CancellationPolicyRepository,
  CreateCancellationPolicyInput,
  UpdateCancellationPolicyInput,
  PolicyResolutionTiming,
} from './cancellation-policy.repository.js';
import { CancellationPolicyNotFoundError } from '../domain/errors.js';

const RETURNING_COLS = `id, business_id, min_days_before_checkin, refund_percentage, active, policy_resolution_timing`;

function mapRow(row: Record<string, unknown>): CancellationPolicy {
  return {
    id:                    row['id'] as string,
    businessId:            row['business_id'] as string,
    minDaysBeforeCheckin:  row['min_days_before_checkin'] as number,
    refundPercentage:      parseFloat(row['refund_percentage'] as string),
    active:                row['active'] as boolean,
    policyResolutionTiming:     row['policy_resolution_timing'] as PolicyResolutionTiming,
  };
}

export class SqlCancellationPolicyRepository implements CancellationPolicyRepository {
  constructor(private readonly db: SqlClient) {}

  async findAll(businessId: string): Promise<CancellationPolicy[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM cancellation_policies
       WHERE business_id = $1
       ORDER BY min_days_before_checkin ASC`,
      [businessId],
    );
    return rows.map(mapRow);
  }

  async findById(id: string): Promise<CancellationPolicy | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM cancellation_policies WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(input: CreateCancellationPolicyInput): Promise<CancellationPolicy> {
    const id = randomUUID();
    // policyResolutionTiming es opcional en el input -- si no se manda, se pasa
    // explícito igual (en vez de omitir la columna del INSERT) para que el
    // valor devuelto en `RETURNING` sea siempre el que el caller ve, sin
    // depender de un segundo round-trip. Coincide con el DEFAULT de la BD
    // (schema.sql), no lo duplica con un criterio distinto.
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO cancellation_policies (id, business_id, min_days_before_checkin, refund_percentage, policy_resolution_timing)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${RETURNING_COLS}`,
      [id, input.businessId, input.minDaysBeforeCheckin, input.refundPercentage, input.policyResolutionTiming ?? 'SNAPSHOT_AT_BOOKING'],
    );
    return mapRow(rows[0]!);
  }

  async update(id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicy> {
    return this.updateWith(this.db, id, input);
  }

  async updateWithClient(client: SqlClient, id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicy> {
    return this.updateWith(client, id, input);
  }

  private async updateWith(client: SqlClient, id: string, input: UpdateCancellationPolicyInput): Promise<CancellationPolicy> {
    const fields: string[]  = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.minDaysBeforeCheckin !== undefined) { fields.push(`min_days_before_checkin = $${idx++}`); params.push(input.minDaysBeforeCheckin); }
    if (input.refundPercentage     !== undefined) { fields.push(`refund_percentage = $${idx++}`);        params.push(input.refundPercentage); }
    if (input.active               !== undefined) { fields.push(`active = $${idx++}`);                   params.push(input.active); }
    if (input.policyResolutionTiming    !== undefined) { fields.push(`policy_resolution_timing = $${idx++}`);      params.push(input.policyResolutionTiming); }

    if (fields.length === 0) {
      const policy = await this.findById(id);
      if (!policy) throw new CancellationPolicyNotFoundError(id);
      return policy;
    }

    fields.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE cancellation_policies SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${RETURNING_COLS}`,
      params,
    );
    if (!rows[0]) throw new CancellationPolicyNotFoundError(id);
    return mapRow(rows[0]);
  }

  async deactivate(id: string): Promise<void> {
    await this.db.query(
      `UPDATE cancellation_policies SET active = FALSE, updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async findApplicableTier(businessId: string, daysBeforeCheckin: number): Promise<CancellationPolicy | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM cancellation_policies
       WHERE business_id = $1 AND active = TRUE AND min_days_before_checkin <= $2
       ORDER BY min_days_before_checkin DESC
       LIMIT 1`,
      [businessId, daysBeforeCheckin],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }
}
