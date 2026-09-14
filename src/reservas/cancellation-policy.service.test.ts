import { describe, it, expect, beforeEach } from 'vitest';
import { CancellationPolicyService } from './cancellation-policy.service.js';
import { CancellationPolicyNotFoundError } from '../domain/errors.js';
import { InMemoryCancellationPolicyRepository } from './in-memory.cancellation-policy.repository.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

describe('CancellationPolicyService', () => {
  let policyRepo: InMemoryCancellationPolicyRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: CancellationPolicyService;

  beforeEach(() => {
    policyRepo = new InMemoryCancellationPolicyRepository();
    auditRepo  = new InMemoryAuditLogRepository();
    service    = new CancellationPolicyService(policyRepo, auditRepo, new InMemoryTransactionManager());
  });

  it('createPolicy() crea un tramo activo scoped al negocio', async () => {
    const policy = await service.createPolicy('biz-1', 7, 50);
    expect(policy).toMatchObject({ businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true });
  });

  // CANCEL-POLICY-SCOPE-BASE-001 (14/09/2026) -- default cuando el tenant no
  // configura nada explícitamente.
  it('createPolicy() sin policyResolutionTiming explícito usa el default SNAPSHOT_AT_BOOKING', async () => {
    const policy = await service.createPolicy('biz-1', 7, 50);
    expect(policy.policyResolutionTiming).toBe('SNAPSHOT_AT_BOOKING');
  });

  it('createPolicy() acepta policyResolutionTiming explícito -- el campo vive por tramo, no global', async () => {
    const policy = await service.createPolicy('biz-1', 7, 50, 'LIVE_AT_CANCELLATION');
    expect(policy.policyResolutionTiming).toBe('LIVE_AT_CANCELLATION');
  });

  it('updatePolicy() cambia policyResolutionTiming y lo audita', async () => {
    const policy = await service.createPolicy('biz-1', 7, 50);

    const updated = await service.updatePolicy(policy.id, { policyResolutionTiming: 'LIVE_AT_CANCELLATION' }, 'identity-1');

    expect(updated.policyResolutionTiming).toBe('LIVE_AT_CANCELLATION');
    const entries = await auditRepo.findByEntity('cancellation_policies', policy.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ field: 'policyResolutionTiming', oldValue: 'SNAPSHOT_AT_BOOKING', newValue: 'LIVE_AT_CANCELLATION' });
  });

  it('listPolicies() solo devuelve tramos del negocio dado', async () => {
    await service.createPolicy('biz-1', 7, 50);
    await service.createPolicy('biz-2', 7, 90);

    const policies = await service.listPolicies('biz-1');
    expect(policies).toHaveLength(1);
    expect(policies[0]?.businessId).toBe('biz-1');
  });

  it('getPolicyById() lanza CancellationPolicyNotFoundError si no existe', async () => {
    await expect(service.getPolicyById('no-existe')).rejects.toBeInstanceOf(CancellationPolicyNotFoundError);
  });

  it('updatePolicy() registra un audit_log entry por cada campo que cambió', async () => {
    const policy = await service.createPolicy('biz-1', 7, 50);

    await service.updatePolicy(policy.id, { refundPercentage: 75 }, 'identity-1');

    const entries = await auditRepo.findByEntity('cancellation_policies', policy.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ field: 'refundPercentage', oldValue: '50', newValue: '75', changedBy: 'identity-1' });
  });

  it('deactivatePolicy() pone active=false', async () => {
    const policy = await service.createPolicy('biz-1', 7, 50);

    await service.deactivatePolicy(policy.id);

    const found = await policyRepo.findById(policy.id);
    expect(found?.active).toBe(false);
  });

  it('deactivatePolicy() lanza CancellationPolicyNotFoundError si no existe', async () => {
    await expect(service.deactivatePolicy('no-existe')).rejects.toBeInstanceOf(CancellationPolicyNotFoundError);
  });
});
