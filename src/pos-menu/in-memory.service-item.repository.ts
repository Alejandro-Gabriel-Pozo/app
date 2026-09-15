import { randomUUID } from 'crypto';
import type { ServiceItemRepository } from './service-item.repository.js';
import type {
  ServiceItem,
  CreateServiceItemInput,
  UpdateServiceItemInput,
} from './service-item.entities.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';
import type { SqlClient } from '../repositories/sql.client.js';

/** Test double en memoria — mismo criterio que el resto de los InMemory*Repository (ej. InMemoryWasteReasonRepository). */
export class InMemoryServiceItemRepository implements ServiceItemRepository {
  private readonly rows = new Map<string, ServiceItem>();

  async findAll(businessId: string): Promise<ServiceItem[]> {
    return [...this.rows.values()].filter(
      (r) => r.businessId === businessId && r.active && r.deletedAt === null,
    );
  }

  async findById(id: string): Promise<ServiceItem | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: CreateServiceItemInput): Promise<ServiceItem> {
    const now = new Date();
    const item: ServiceItem = {
      id: randomUUID(),
      businessId: input.businessId,
      categoryId: input.categoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      price: input.price,
      active: true,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(item.id, item);
    return item;
  }

  /**
   * Construye un objeto nuevo en vez de mutar la fila existente en el lugar
   * — mismo criterio que InMemoryWasteReasonRepository.update(): findById()
   * devuelve la misma referencia guardada en `rows`, mutarla in-place
   * invalidaría cualquier snapshot `before` que un caller (ej.
   * ServiceItemService.updateItem(), para diffFields()) haya tomado antes.
   */
  async update(id: string, input: UpdateServiceItemInput): Promise<ServiceItem> {
    const current = this.rows.get(id);
    if (!current) throw new ServiceItemNotFoundError(id);
    const updated: ServiceItem = {
      ...current,
      ...(input.categoryId  !== undefined && { categoryId: input.categoryId }),
      ...(input.name        !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.price       !== undefined && { price: input.price }),
      ...(input.active      !== undefined && { active: input.active }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  /** En memoria no hay transacción real — delega a `update()`, el `client` se ignora. */
  async updateWithClient(_client: SqlClient, id: string, input: UpdateServiceItemInput): Promise<ServiceItem> {
    return this.update(id, input);
  }

  async deactivate(id: string): Promise<void> {
    const current = this.rows.get(id);
    if (!current) throw new ServiceItemNotFoundError(id);
    this.rows.set(id, { ...current, active: false, updatedAt: new Date() });
  }
}
