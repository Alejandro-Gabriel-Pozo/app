/**
 * @file resource-lock.service.ts
 * @description Gestión de qué recursos físicos bloquea un servicio agendable.
 *
 * Antes de este archivo, `resource_locks` solo se podía leer
 * (`IResourceLockRepository.getByServiceId`, ya consumido por
 * `ReservationService`) — no existía forma de crear/editar locks salvo SQL
 * a mano. Este servicio expone esa gestión, reusando los errores de dominio
 * ya mapeados en `error.middleware.ts` (`BookableServiceNotFoundError`,
 * `ResourceNotFoundError`) para no tener que tocar ese switch.
 */

import type { IResourceLockRepository, ResourceLock } from '../repositories/resource-lock.repository.js';
import type { IBookableServiceRepository } from '../repositories/bookable-service.repository.js';
import type { ResourceRepository } from '../repositories/resource.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import { BookableServiceNotFoundError } from './bookable-service.service.js';

export class ResourceLockService {
  constructor(
    private readonly lockRepo: IResourceLockRepository,
    private readonly bookableServiceRepo: IBookableServiceRepository,
    private readonly resourceRepo: ResourceRepository,
    private readonly transactionManager: TransactionManager,
  ) {}

  async listForService(serviceId: string): Promise<ResourceLock[]> {
    const service = await this.bookableServiceRepo.findById(serviceId);
    if (!service) throw new BookableServiceNotFoundError(serviceId);
    return this.lockRepo.getByServiceId(serviceId);
  }

  /**
   * Reemplaza el set completo de recursos bloqueados por el servicio.
   * `resourceIds` vacío es válido — saca todos los locks.
   */
  async replaceForService(serviceId: string, resourceIds: string[]): Promise<ResourceLock[]> {
    const service = await this.bookableServiceRepo.findById(serviceId);
    if (!service) throw new BookableServiceNotFoundError(serviceId);

    for (const resourceId of new Set(resourceIds)) {
      const resource = await this.resourceRepo.getById(resourceId);
      if (!resource) throw new ResourceNotFoundError(resourceId);
    }

    return this.transactionManager.run((client) =>
      this.lockRepo.replaceForServiceWithClient(client, serviceId, resourceIds),
    );
  }
}
