import type { SqlClient } from '../repositories/sql.client.js';
import type { IBillingPolicyRepository } from './billing-policy.repository.js';
import type {
  BillingPolicy,
  UpsertBillingPolicyInput,
  InvoicingScope,
  InvoicingTrigger,
  CycleFrequency,
} from './billing-policy.entities.js';

interface PolicyRow {
  customer_id: string;
  requires_sena_to_confirm: boolean;
  invoicing_scope: InvoicingScope;
  invoicing_trigger: InvoicingTrigger;
  cycle_frequency: CycleFrequency | null;
  cycle_custom_days: number | null;
  due_days: number;
  updated_at: Date;
}

function rowToPolicy(row: PolicyRow): BillingPolicy {
  return {
    customerId: row.customer_id,
    requiresSenaToConfirm: row.requires_sena_to_confirm,
    invoicingScope: row.invoicing_scope,
    invoicingTrigger: row.invoicing_trigger,
    cycleFrequency: row.cycle_frequency,
    cycleCustomDays: row.cycle_custom_days,
    dueDays: row.due_days,
    updatedAt: row.updated_at,
  };
}

export class SqlBillingPolicyRepository implements IBillingPolicyRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async getByCustomerId(customerId: string): Promise<BillingPolicy | null> {
    const { rows } = await this.sqlClient.query<PolicyRow>(
      `SELECT * FROM billing_policies WHERE customer_id = $1`,
      [customerId],
    );
    return rows[0] ? rowToPolicy(rows[0]) : null;
  }

  async upsert(customerId: string, input: UpsertBillingPolicyInput): Promise<BillingPolicy> {
    const { rows } = await this.sqlClient.query<PolicyRow>(
      `INSERT INTO billing_policies
         (customer_id, requires_sena_to_confirm, invoicing_scope, invoicing_trigger, cycle_frequency, cycle_custom_days, due_days, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (customer_id) DO UPDATE SET
         requires_sena_to_confirm = EXCLUDED.requires_sena_to_confirm,
         invoicing_scope          = EXCLUDED.invoicing_scope,
         invoicing_trigger        = EXCLUDED.invoicing_trigger,
         cycle_frequency          = EXCLUDED.cycle_frequency,
         cycle_custom_days        = EXCLUDED.cycle_custom_days,
         due_days                 = EXCLUDED.due_days,
         updated_at               = NOW()
       RETURNING *`,
      [
        customerId,
        input.requiresSenaToConfirm,
        input.invoicingScope,
        input.invoicingTrigger,
        input.cycleFrequency ?? null,
        input.cycleCustomDays ?? null,
        input.dueDays,
      ],
    );
    return rowToPolicy(rows[0]!);
  }
}
