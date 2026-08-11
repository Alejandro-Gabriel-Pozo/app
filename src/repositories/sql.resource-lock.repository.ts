/**
 * @file sql.resource-lock.repository.ts
 * @description Implementación SQL de IResourceLockRepository.
 *
 * Lee de la tabla `resource_locks` (creada en 007_resource_locks.sql).
 * El índice idx_resource_locks_resource cubre las queries por resource_id
 * (futuras verificaciones inversas). Esta query filtra por service_id.
 */

import { IResourceLockRepository, ResourceLock } from './resource-lock.repository.js';
import { SqlClient }                               from './sql.client.js';

export class SqlResourceLockRepository implements IResourceLockRepository {
  constructor(private readonly db: SqlClient) {}

  async getByServiceId(serviceId: string): Promise<ResourceLock[]> {
    const rows = await this.db.query<{
      service_id:  string;
      resource_id: string;
      sort_order:  number;
    }>(
      `SELECT service_id, resource_id, sort_order
       FROM   resource_locks
       WHERE  service_id = $1
       ORDER  BY sort_order ASC, resource_id ASC`,
      [serviceId],
    );

    return rows.map((r) => ({
      serviceId:  r.service_id,
      resourceId: r.resource_id,
      sortOrder:  r.sort_order,
    }));
  }
}
