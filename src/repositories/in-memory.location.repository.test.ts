import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryLocationRepository } from './in-memory.location.repository.js';

describe('InMemoryLocationRepository', () => {
  let repo: InMemoryLocationRepository;

  beforeEach(() => {
    repo = new InMemoryLocationRepository();
  });

  it('debe crear y recuperar una location por id', async () => {
    const created = await repo.create({ id: 'loc-1', name: 'Sucursal Centro' });

    expect(created.id).toBe('loc-1');
    expect(created.active).toBe(true);

    const found = await repo.findById('loc-1');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Sucursal Centro');
  });

  it('findById debe devolver null si no existe', async () => {
    expect(await repo.findById('missing')).toBeNull();
  });

  it('findAll debe listar todas las locations activas', async () => {
    await repo.create({ id: 'loc-1', name: 'Sucursal Centro' });
    await repo.create({ id: 'loc-2', name: 'Sucursal Norte' });

    const all = await repo.findAll();
    expect(all).toHaveLength(2);
    expect(all.map(l => l.id).sort()).toEqual(['loc-1', 'loc-2']);
  });
});
