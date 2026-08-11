/**
 * @file in-memory.resource-lock.repository.ts
 * @description Implementación in-memory de IResourceLockRepository — para tests.
 */

import { IResourceLockRepository, ResourceLock } from './resource-lock.repository.js';
import { SqlClient } from './sql.client.js';

export class InMemoryResourceLockRepository implements IResourceLockRepository {
  private readonly locks: ResourceLock[] = [];

  async getByServiceId(serviceId: string): Promise<ResourceLock[]> {
    return this.locks
      .filter((l) => l.serviceId === serviceId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.resourceId.localeCompare(b.resourceId));
  }

  async getByResourceId(resourceId: string): Promise<ResourceLock[]> {
    return this.locks
      .filter((l) => l.resourceId === resourceId)
      .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async replaceForServiceWithClient(_client: SqlClient, serviceId: string, resourceIds: string[]): Promise<ResourceLock[]> {
    for (let i = this.locks.length - 1; i >= 0; i--) {
      if (this.locks[i]!.serviceId === serviceId) this.locks.splice(i, 1);
    }
    const created = resourceIds.map((resourceId, sortOrder) => ({ serviceId, resourceId, sortOrder }));
    this.locks.push(...created);
    return created;
  }

  /** Helper de test — carga locks directo sin pasar por replaceForServiceWithClient. */
  seed(locks: ResourceLock[]): void {
    this.locks.push(...locks);
  }
}
