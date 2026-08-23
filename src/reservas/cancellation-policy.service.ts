/**
 * @file cancellation-policy.service.ts
 * @description Lógica de negocio para el catálogo de tramos de cancelación
 * (C2, docs/diseno-cancelacion-notas-credito-c2-2026-08-23.md). Mismo
 * patrón que WasteReasonService (catálogo simple, sin límites de plan).
 */

import type {
  CancellationPolicyRepository,
  CancellationPolicy,
} from './cancellation-policy.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { diffFields, recordFieldChanges } from '../domain/audit.js';
import { CancellationPolicyNotFoundError } from '../domain/errors.js';

const AUDIT_ENTITY = 'cancellation_policies';

export class CancellationPolicyService {
  constructor(
    private readonly policyRepo: CancellationPolicyRepository,
    /** Requerido para que updatePolicy() deje rastro (R8/A9.4) — mismo criterio que WasteReasonService. */
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  async listPolicies(businessId: string): Promise<CancellationPolicy[]> {
    return this.policyRepo.findAll(businessId);
  }

  async getPolicyById(id: string): Promise<CancellationPolicy> {
    const policy = await this.policyRepo.findById(id);
    if (!policy) throw new CancellationPolicyNotFoundError(id);
    return policy;
  }

  async createPolicy(
    businessId: string,
    minDaysBeforeCheckin: number,
    refundPercentage: number,
  ): Promise<CancellationPolicy> {
    return this.policyRepo.create({ businessId, minDaysBeforeCheckin, refundPercentage });
  }

  async updatePolicy(
    id: string,
    input: { minDaysBeforeCheckin?: number; refundPercentage?: number; active?: boolean },
    changedBy: string,
  ): Promise<CancellationPolicy> {
    const before  = await this.getPolicyById(id); // throws if not found
    const updated = await this.policyRepo.update(id, input);

    const changes = diffFields(before, input);
    await recordFieldChanges(this.auditLogRepo, AUDIT_ENTITY, id, changes, changedBy);

    return updated;
  }

  async deactivatePolicy(id: string): Promise<void> {
    await this.getPolicyById(id); // throws if not found
    await this.policyRepo.deactivate(id);
  }
}
