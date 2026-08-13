/**
 * @file sql.resource-lock.repository.ts
 * @description Implementación SQL de IResourceLockRepository.
 *
 * Lee de la tabla `resource_locks` (creada en 007_resource_locks.sql).
 * El índice idx_resource_locks_resource cubre las queries por resource_id
 * (futuras verificaciones inversas). Esta query filtra por service_id.
 */

import type { IResourceLockRepository, ResourceLock } from './resource-lock.repository.js';
import type { SqlClient }                               from './sql.client.js';

export class SqlResourceLockRepository implements IResourceLockRepository {
  constructor(private readonly db: SqlClient) {}

  async getByServiceId(serviceId: string): Promise<ResourceLock[]> {
    const result = await this.db.query<ResourceLockRow>(
      `SELECT service_id, resource_id, sort_order
       FROM   resource_locks
       WHERE  service_id = $1
       ORDER  BY sort_order ASC, resource_id ASC`,
      [serviceId],
    );

    return result.rows.map(rowToLock);
  }

  async getByResourceId(resourceId: string): Promise<ResourceLock[]> {
    const result = await this.db.query<ResourceLockRow>(
      `SELECT service_id, resource_id, sort_order
       FROM   resource_locks
       WHERE  resource_id = $1
       ORDER  BY service_id ASC`,
      [resourceId],
    );

    return result.rows.map(rowToLock);
  }

  async replaceForServiceWithClient(
    client: SqlClient,
    serviceId: string,
    resourceIds: string[],
  ): Promise<ResourceLock[]> {
    await client.query(`DELETE FROM resource_locks WHERE service_id = $1`, [serviceId]);

    if (resourceIds.length === 0) return [];

    const values: string[] = [];
    const params: unknown[] = [];
    resourceIds.forEach((resourceId, i) => {
      const base = i * 3;
      values.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      params.push(serviceId, resourceId, i);
    });

    const result = await client.query<ResourceLockRow>(
      `INSERT INTO resource_locks (service_id, resource_id, sort_order)
       VALUES ${values.join(', ')}
       RETURNING service_id, resource_id, sort_order`,
      params,
    );

    return result.rows.map(rowToLock);
  }
}

interface ResourceLockRow {
  service_id:  string;
  resource_id: string;
  sort_order:  number;
}

function rowToLock(r: ResourceLockRow): ResourceLock {
  return { serviceId: r.service_id, resourceId: r.resource_id, sortOrder: r.sort_order };
}
