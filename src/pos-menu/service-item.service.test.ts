import { describe, it, expect, beforeEach } from 'vitest';
import { ServiceItemService } from './service-item.service.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';
import { InMemoryServiceItemRepository } from './in-memory.service-item.repository.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

describe('ServiceItemService', () => {
  let serviceItemRepo: InMemoryServiceItemRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: ServiceItemService;

  beforeEach(() => {
    serviceItemRepo = new InMemoryServiceItemRepository();
    auditRepo       = new InMemoryAuditLogRepository();
    service         = new ServiceItemService(serviceItemRepo, auditRepo, new InMemoryTransactionManager());
  });

  it('createItem() crea un ítem activo scoped al negocio', async () => {
    const item = await service.createItem({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });
    expect(item).toMatchObject({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500, active: true, categoryId: null, deletedAt: null });
  });

  it('listItems() solo devuelve ítems activos del negocio dado', async () => {
    const a = await service.createItem({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });
    await service.createItem({ businessId: 'biz-1', name: 'Diferencia de tarifa', price: 200 });
    await service.createItem({ businessId: 'biz-2', name: 'De otro negocio', price: 100 });
    await serviceItemRepo.deactivate(a.id);

    const items = await service.listItems('biz-1');
    expect(items.map((i) => i.name)).toEqual(['Diferencia de tarifa']);
  });

  it('getItemById() lanza ServiceItemNotFoundError si no existe', async () => {
    await expect(service.getItemById('no-existe')).rejects.toBeInstanceOf(ServiceItemNotFoundError);
  });

  it('getItemById() NO filtra por active -- R2: encuentra un ítem pausado', async () => {
    const item = await service.createItem({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });
    await service.deactivateItem(item.id);

    const found = await service.getItemById(item.id);
    expect(found.id).toBe(item.id);
    expect(found.active).toBe(false);
  });

  it('updateItem() registra un audit_log entry por cada campo que cambió', async () => {
    const item = await service.createItem({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });

    await service.updateItem(item.id, { price: 600 }, 'identity-1');

    const entries = await auditRepo.findByEntity('service_items', item.id);
    expect(entries).toHaveLength(1);
    // InMemoryAuditLogRepository serializa valores numéricos a string
    // (serializeValue()) -- mismo criterio que el resto de los tests de
    // servicios de catálogo que auditan un campo string (waste-reason);
    // acá el campo auditado es numérico, así que el valor esperado también
    // lo es.
    expect(entries[0]).toMatchObject({
      field: 'price',
      oldValue: '500',
      newValue: '600',
      changedBy: 'identity-1',
    });
  });

  it('updateItem() no registra nada si el patch no cambia ningún valor', async () => {
    const item = await service.createItem({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });

    await service.updateItem(item.id, { price: 500 }, 'identity-1');

    expect(await auditRepo.findByEntity('service_items', item.id)).toHaveLength(0);
  });

  it('updateItem() propaga ServiceItemNotFoundError sin escribir auditoría', async () => {
    await expect(
      service.updateItem('no-existe', { price: 1 }, 'identity-1'),
    ).rejects.toBeInstanceOf(ServiceItemNotFoundError);

    expect(auditRepo.all()).toHaveLength(0);
  });

  it('deactivateItem() pone active=false (soft-delete, R3) -- nunca hard-delete', async () => {
    const item = await service.createItem({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });

    await service.deactivateItem(item.id);

    const found = await serviceItemRepo.findById(item.id);
    expect(found?.active).toBe(false);
    expect(found).not.toBeNull();
  });

  it('deactivateItem() lanza ServiceItemNotFoundError si no existe', async () => {
    await expect(service.deactivateItem('no-existe')).rejects.toBeInstanceOf(ServiceItemNotFoundError);
  });
});
