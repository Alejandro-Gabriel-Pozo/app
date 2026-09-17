import { describe, it, expect, beforeEach } from 'vitest';
import { BookableResource } from './resource.entities.js';
import { InMemoryResourceRepository } from './in-memory.resource.repository.js';

describe('InMemoryResourceRepository', () => {
  let repo: InMemoryResourceRepository;

  beforeEach(() => {
    repo = new InMemoryResourceRepository();
  });

  it('debe guardar y recuperar un recurso por id', async () => {
    const cabin = new BookableResource('c1', 'Cabaña A', 150, 'cat-cabin');
    await repo.save(cabin);

    const found = await repo.getById('c1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('c1');
    expect(found!.name).toBe('Cabaña A');
    expect(found!.categoryId).toBe('cat-cabin');
  });

  it('debe filtrar recursos por categoryId', async () => {
    await repo.save(new BookableResource('c1', 'Cabaña A', 150, 'cat-cabin'));
    await repo.save(new BookableResource('t1', 'Mesa 1', 30, 'cat-table', {
      shape: 'CIRCLE',
      width: 80,
      height: 80,
      positionX: 10,
      positionY: 20,
      rotationDegrees: 0,
    }));

    const all = await repo.getAll();
    const cabins = all.filter(r => r.categoryId === 'cat-cabin');
    expect(cabins).toHaveLength(1);
    expect(cabins[0]!.id).toBe('c1');
  });

  it('getManyByIds([]) devuelve [] sin tocar el mapa -- D-17', async () => {
    await repo.save(new BookableResource('c1', 'Cabaña A', 150, 'cat-cabin'));

    expect(await repo.getManyByIds([])).toEqual([]);
  });

  it('getManyByIds() devuelve los encontrados y omite los inexistentes -- D-17, misma semántica que getById() (sin filtrar por estado)', async () => {
    await repo.save(new BookableResource('c1', 'Cabaña A', 150, 'cat-cabin'));
    await repo.save(new BookableResource('c2', 'Cabaña B', 200, 'cat-cabin'));

    const found = await repo.getManyByIds(['c1', 'no-existe', 'c2']);

    expect(found.map((r) => r.id).sort()).toEqual(['c1', 'c2']);
  });

  it('debe eliminar un recurso', async () => {
    await repo.save(new BookableResource('c1', 'Cabaña A', 150, 'cat-cabin'));
    const deleted = await repo.delete('c1');

    expect(deleted).toBe(true);
    expect(await repo.getById('c1')).toBeUndefined();
  });

  it('debe listar todos los recursos', async () => {
    await repo.save(new BookableResource('c1', 'Cabaña A', 150, 'cat-cabin'));
    await repo.save(new BookableResource('c2', 'Cabaña B', 200, 'cat-cabin'));

    const all = await repo.getAll();
    expect(all).toHaveLength(2);
  });
});
