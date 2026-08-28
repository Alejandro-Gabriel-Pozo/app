import { describe, it, expect, beforeEach } from 'vitest';
import { ConsumptionDestinationService } from './consumption-destination.service.js';
import { ConsumptionDestinationNotFoundError } from '../domain/errors.js';
import { InMemoryConsumptionDestinationRepository } from '../repositories/in-memory.consumption-destination.repository.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

describe('ConsumptionDestinationService', () => {
  let consumptionDestinationRepo: InMemoryConsumptionDestinationRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: ConsumptionDestinationService;

  beforeEach(() => {
    consumptionDestinationRepo = new InMemoryConsumptionDestinationRepository();
    auditRepo                  = new InMemoryAuditLogRepository();
    service = new ConsumptionDestinationService(consumptionDestinationRepo, auditRepo, new InMemoryTransactionManager());
  });

  it('createDestination() crea un destino activo scoped al negocio', async () => {
    const destination = await service.createDestination('biz-1', 'Personal');
    expect(destination).toMatchObject({ businessId: 'biz-1', name: 'Personal', active: true });
  });

  it('listDestinations() solo devuelve destinos activos del negocio dado', async () => {
    const a = await service.createDestination('biz-1', 'Personal');
    await service.createDestination('biz-1', 'Degustación / cortesía');
    await service.createDestination('biz-2', 'De otro negocio');
    await consumptionDestinationRepo.deactivate(a.id);

    const destinations = await service.listDestinations('biz-1');
    expect(destinations.map((d) => d.name)).toEqual(['Degustación / cortesía']);
  });

  it('getDestinationById() lanza ConsumptionDestinationNotFoundError si no existe', async () => {
    await expect(service.getDestinationById('no-existe')).rejects.toBeInstanceOf(ConsumptionDestinationNotFoundError);
  });

  it('updateDestination() registra un audit_log entry por cada campo que cambió', async () => {
    const destination = await service.createDestination('biz-1', 'Personal');

    await service.updateDestination(destination.id, { name: 'Comida de personal' }, 'identity-1');

    const entries = await auditRepo.findByEntity('consumption_destinations', destination.id);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field: 'name',
      oldValue: 'Personal',
      newValue: 'Comida de personal',
      changedBy: 'identity-1',
    });
  });

  it('updateDestination() no registra nada si el patch no cambia ningún valor', async () => {
    const destination = await service.createDestination('biz-1', 'Personal');

    await service.updateDestination(destination.id, { name: 'Personal' }, 'identity-1');

    expect(await auditRepo.findByEntity('consumption_destinations', destination.id)).toHaveLength(0);
  });

  it('updateDestination() propaga ConsumptionDestinationNotFoundError sin escribir auditoría', async () => {
    await expect(
      service.updateDestination('no-existe', { name: 'x' }, 'identity-1'),
    ).rejects.toBeInstanceOf(ConsumptionDestinationNotFoundError);

    expect(auditRepo.all()).toHaveLength(0);
  });

  it('deactivateDestination() pone active=false', async () => {
    const destination = await service.createDestination('biz-1', 'Personal');

    await service.deactivateDestination(destination.id);

    const found = await consumptionDestinationRepo.findById(destination.id);
    expect(found?.active).toBe(false);
  });

  it('deactivateDestination() lanza ConsumptionDestinationNotFoundError si no existe', async () => {
    await expect(service.deactivateDestination('no-existe')).rejects.toBeInstanceOf(ConsumptionDestinationNotFoundError);
  });
});
