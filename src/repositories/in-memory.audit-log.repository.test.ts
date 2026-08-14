import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryAuditLogRepository } from './in-memory.audit-log.repository.js';

describe('InMemoryAuditLogRepository', () => {
  let repo: InMemoryAuditLogRepository;

  beforeEach(() => {
    repo = new InMemoryAuditLogRepository();
  });

  it('no escribe nada si record() recibe un array vacío', async () => {
    await repo.record([]);
    expect(repo.all()).toHaveLength(0);
  });

  it('registra un cambio con old/new value serializados', async () => {
    await repo.record([
      {
        entity: 'resource_categories',
        entityId: 'cat-salon-1',
        field: 'name',
        oldValue: 'Salon',
        newValue: 'Salon VIP',
        changedBy: 'identity-1',
      },
    ]);

    const entries = await repo.findByEntity('resource_categories', 'cat-salon-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entity: 'resource_categories',
      entityId: 'cat-salon-1',
      field: 'name',
      oldValue: 'Salon',
      newValue: 'Salon VIP',
      changedBy: 'identity-1',
    });
    expect(entries[0]!.changedAt).toBeInstanceOf(Date);
  });

  it('serializa números y objetos a string, y null se mantiene null', async () => {
    await repo.record([
      {
        entity: 'products',
        entityId: 'prod-1',
        field: 'basePrice',
        oldValue: 100,
        newValue: 150,
        changedBy: 'identity-1',
      },
      {
        entity: 'products',
        entityId: 'prod-1',
        field: 'description',
        oldValue: null,
        newValue: 'nueva descripcion',
        changedBy: 'identity-1',
      },
    ]);

    const entries = await repo.findByEntity('products', 'prod-1');
    const price = entries.find((e) => e.field === 'basePrice')!;
    const desc  = entries.find((e) => e.field === 'description')!;

    expect(price.oldValue).toBe('100');
    expect(price.newValue).toBe('150');
    expect(desc.oldValue).toBeNull();
    expect(desc.newValue).toBe('nueva descripcion');
  });

  it('findByEntity filtra por entity + entityId y no mezcla otras entidades', async () => {
    await repo.record([
      { entity: 'resource_categories', entityId: 'cat-1', field: 'name', oldValue: 'a', newValue: 'b', changedBy: 'u1' },
      { entity: 'products',            entityId: 'cat-1', field: 'name', oldValue: 'x', newValue: 'y', changedBy: 'u1' },
    ]);

    const entries = await repo.findByEntity('resource_categories', 'cat-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entity).toBe('resource_categories');
  });

  it('findByEntity devuelve más reciente primero', async () => {
    await repo.record([{ entity: 'products', entityId: 'p1', field: 'a', oldValue: 1, newValue: 2, changedBy: 'u1' }]);
    await repo.record([{ entity: 'products', entityId: 'p1', field: 'b', oldValue: 1, newValue: 2, changedBy: 'u1' }]);

    const entries = await repo.findByEntity('products', 'p1');
    expect(entries).toHaveLength(2);
    // ambos entries del mismo record() comparten timestamp; entre llamadas
    // separadas, la más reciente debe listarse primero o empatada.
    expect(entries[0]!.changedAt.getTime()).toBeGreaterThanOrEqual(entries[1]!.changedAt.getTime());
  });
});
