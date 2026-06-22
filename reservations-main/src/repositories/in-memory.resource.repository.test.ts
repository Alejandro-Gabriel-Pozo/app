import { describe, it, expect, beforeEach } from 'vitest';
import { ResourceType, TableShape } from '../types/enums.js';
import { CabinResource, TableResource } from '../domain/entities.js';
import { InMemoryResourceRepository } from './in-memory.resource.repository.js';

describe('InMemoryResourceRepository', () => {
  let repo: InMemoryResourceRepository;

  beforeEach(() => {
    repo = new InMemoryResourceRepository();
  });

  it('debe guardar y recuperar un recurso por id', async () => {
    const cabin = new CabinResource('c1', 'Cabaña A', 150);
    await repo.save(cabin);

    const found = await repo.getById('c1');
    expect(found).toBeDefined();
    expect(found!.id).toBe('c1');
    expect(found!.name).toBe('Cabaña A');
    expect(found!.type).toBe(ResourceType.CABIN);
  });

  it('debe filtrar recursos por tipo', async () => {
    await repo.save(new CabinResource('c1', 'Cabaña A', 150));
    await repo.save(
      new TableResource('t1', 'Mesa 1', 30, {
        shape: TableShape.CIRCLE,
        width: 80,
        height: 80,
        positionX: 10,
        positionY: 20,
        rotationDegrees: 0,
      }),
    );

    const cabins = await repo.getByType(ResourceType.CABIN);
    expect(cabins).toHaveLength(1);
    expect(cabins[0].id).toBe('c1');
  });

  it('debe eliminar un recurso', async () => {
    await repo.save(new CabinResource('c1', 'Cabaña A', 150));
    const deleted = await repo.delete('c1');

    expect(deleted).toBe(true);
    expect(await repo.getById('c1')).toBeUndefined();
  });

  it('debe listar todos los recursos', async () => {
    await repo.save(new CabinResource('c1', 'Cabaña A', 150));
    await repo.save(new CabinResource('c2', 'Cabaña B', 200));

    const all = await repo.getAll();
    expect(all).toHaveLength(2);
  });
});
