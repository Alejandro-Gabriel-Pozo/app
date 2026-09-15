import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryServiceItemRepository } from './in-memory.service-item.repository.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';

describe('InMemoryServiceItemRepository', () => {
  let repo: InMemoryServiceItemRepository;

  beforeEach(() => {
    repo = new InMemoryServiceItemRepository();
  });

  it('create() guarda un ítem activo, sin categoría ni deletedAt por default', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });

    expect(item.active).toBe(true);
    expect(item.categoryId).toBeNull();
    expect(item.description).toBeNull();
    expect(item.deletedAt).toBeNull();
    expect(await repo.findById(item.id)).toEqual(item);
  });

  it('findAll() filtra por businessId y solo devuelve activos', async () => {
    const a = await repo.create({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });
    await repo.create({ businessId: 'biz-1', name: 'Diferencia de tarifa', price: 200 });
    await repo.create({ businessId: 'biz-2', name: 'De otro negocio', price: 100 });
    await repo.deactivate(a.id);

    const all = await repo.findAll('biz-1');
    expect(all.map((i) => i.name)).toEqual(['Diferencia de tarifa']);
  });

  it('findById() no filtra por active -- R2', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });
    await repo.deactivate(item.id);

    const found = await repo.findById(item.id);
    expect(found?.id).toBe(item.id);
    expect(found?.active).toBe(false);
  });

  it('findById() devuelve null si no existe', async () => {
    expect(await repo.findById('no-existe')).toBeNull();
  });

  it('update() no muta la referencia devuelta por un findById() anterior', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });
    const before = await repo.findById(item.id);

    await repo.update(item.id, { price: 999 });

    expect(before?.price).toBe(500); // el snapshot tomado antes no cambió
  });

  it('update() lanza ServiceItemNotFoundError si no existe', async () => {
    await expect(repo.update('no-existe', { price: 1 })).rejects.toBeInstanceOf(ServiceItemNotFoundError);
  });

  it('deactivate() pone active=false sin borrar la fila', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });

    await repo.deactivate(item.id);

    const found = await repo.findById(item.id);
    expect(found).not.toBeNull();
    expect(found?.active).toBe(false);
  });

  it('deactivate() lanza ServiceItemNotFoundError si no existe', async () => {
    await expect(repo.deactivate('no-existe')).rejects.toBeInstanceOf(ServiceItemNotFoundError);
  });
});
