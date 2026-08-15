import { describe, it, expect, beforeEach } from 'vitest';
import { ResourceLockService } from './resource-lock.service.js';
import { BookableServiceNotFoundError } from './bookable-service.service.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import { InMemoryResourceLockRepository } from '../repositories/in-memory.resource-lock.repository.js';
import { InMemoryBookableServiceRepository } from '../repositories/in-memory.bookable-service.repository.js';
import { InMemoryResourceRepository } from '../repositories/in-memory.resource.repository.js';
import { BookableResource } from '../domain/resource.entities.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };
    return work(noopClient);
  }
}

describe('ResourceLockService', () => {
  let lockRepo: InMemoryResourceLockRepository;
  let serviceRepo: InMemoryBookableServiceRepository;
  let resourceRepo: InMemoryResourceRepository;
  let service: ResourceLockService;

  beforeEach(async () => {
    lockRepo = new InMemoryResourceLockRepository();
    serviceRepo = new InMemoryBookableServiceRepository();
    resourceRepo = new InMemoryResourceRepository();
    service = new ResourceLockService(lockRepo, serviceRepo, resourceRepo, new InMemoryTransactionManager());

    serviceRepo.seed({
      id: 'svc-1', categoryId: 'cat-1', name: 'Corte',
      bookingMode: 'slot', durationMinutes: 30, price: 20,
      active: true, createdAt: new Date(), updatedAt: new Date(),
    });
    await resourceRepo.save(new BookableResource('silla-1', 'Silla 1', 0, 'cat-1', null));
    await resourceRepo.save(new BookableResource('estilista-ana', 'Estilista Ana', 0, 'cat-1', null));
  });

  describe('listForService', () => {
    it('lanza BookableServiceNotFoundError si el servicio no existe', async () => {
      await expect(service.listForService('missing')).rejects.toThrow(BookableServiceNotFoundError);
    });

    it('devuelve [] si el servicio no tiene locks', async () => {
      expect(await service.listForService('svc-1')).toEqual([]);
    });
  });

  describe('replaceForService', () => {
    it('lanza BookableServiceNotFoundError si el servicio no existe', async () => {
      await expect(service.replaceForService('missing', ['silla-1'])).rejects.toThrow(BookableServiceNotFoundError);
    });

    it('lanza ResourceNotFoundError si algún resourceId no existe', async () => {
      await expect(
        service.replaceForService('svc-1', ['silla-1', 'inexistente']),
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it('reemplaza el set completo de locks', async () => {
      await service.replaceForService('svc-1', ['silla-1', 'estilista-ana']);
      const locks = await service.listForService('svc-1');
      expect(locks.map((l) => l.resourceId).sort()).toEqual(['estilista-ana', 'silla-1']);

      // Segunda llamada reemplaza, no acumula
      await service.replaceForService('svc-1', ['silla-1']);
      const updated = await service.listForService('svc-1');
      expect(updated.map((l) => l.resourceId)).toEqual(['silla-1']);
    });

    it('un array vacío saca todos los locks', async () => {
      await service.replaceForService('svc-1', ['silla-1']);
      await service.replaceForService('svc-1', []);
      expect(await service.listForService('svc-1')).toEqual([]);
    });
  });
});
