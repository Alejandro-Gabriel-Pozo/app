import { describe, it, expect, beforeEach } from 'vitest';
import { WasteReasonService } from './waste-reason.service.js';
import { WasteReasonNotFoundError } from '../domain/errors.js';
import { InMemoryWasteReasonRepository } from '../repositories/in-memory.waste-reason.repository.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

describe('WasteReasonService', () => {
  let wasteReasonRepo: InMemoryWasteReasonRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: WasteReasonService;

  beforeEach(() => {
    wasteReasonRepo = new InMemoryWasteReasonRepository();
    auditRepo       = new InMemoryAuditLogRepository();
    service         = new WasteReasonService(wasteReasonRepo, auditRepo, new InMemoryTransactionManager());
  });

  it('createReason() crea un motivo activo scoped al negocio', async () => {
    const reason = await service.createReason('biz-1', 'Vencido');
    expect(reason).toMatchObject({ businessId: 'biz-1', name: 'Vencido', active: true });
  });

  it('listReasons() solo devuelve motivos activos del negocio dado', async () => {
    const a = await service.createReason('biz-1', 'Vencido');
    await service.createReason('biz-1', 'Roto');
    await service.createReason('biz-2', 'De otro negocio');
    await wasteReasonRepo.deactivate(a.id);

    const reasons = await service.listReasons('biz-1');
    expect(reasons.map((r) => r.name)).toEqual(['Roto']);
  });

  it('getReasonById() lanza WasteReasonNotFoundError si no existe', async () => {
    await expect(service.getReasonById('no-existe')).rejects.toBeInstanceOf(WasteReasonNotFoundError);
  });

  it('updateReason() registra un audit_log entry por cada campo que cambió', async () => {
    const reason = await service.createReason('biz-1', 'Vencido');

    await service.updateReason(reason.id, { name: 'Vencido / caducado' }, 'identity-1');

    const entries = await auditRepo.findByEntity('waste_reasons', reason.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field: 'name',
      oldValue: 'Vencido',
      newValue: 'Vencido / caducado',
      changedBy: 'identity-1',
    });
  });

  it('updateReason() no registra nada si el patch no cambia ningún valor', async () => {
    const reason = await service.createReason('biz-1', 'Vencido');

    await service.updateReason(reason.id, { name: 'Vencido' }, 'identity-1');

    expect(await auditRepo.findByEntity('waste_reasons', reason.id)).toHaveLength(0);
  });

  it('updateReason() propaga WasteReasonNotFoundError sin escribir auditoría', async () => {
    await expect(
      service.updateReason('no-existe', { name: 'x' }, 'identity-1'),
    ).rejects.toBeInstanceOf(WasteReasonNotFoundError);

    expect(auditRepo.all()).toHaveLength(0);
  });

  it('deactivateReason() pone active=false', async () => {
    const reason = await service.createReason('biz-1', 'Vencido');

    await service.deactivateReason(reason.id);

    const found = await wasteReasonRepo.findById(reason.id);
    expect(found?.active).toBe(false);
  });

  it('deactivateReason() lanza WasteReasonNotFoundError si no existe', async () => {
    await expect(service.deactivateReason('no-existe')).rejects.toBeInstanceOf(WasteReasonNotFoundError);
  });
});
