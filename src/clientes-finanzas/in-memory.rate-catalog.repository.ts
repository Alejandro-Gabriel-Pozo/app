/**
 * @file in-memory.rate-catalog.repository.ts
 * @description Implementación in-memory de IRateCatalogRepository — para tests.
 */

import type {
  IRateCatalogRepository,
  RateCatalogEntry,
  CreateRateCatalogEntryDto,
  UpdateRateCatalogEntryDto,
} from './rate-catalog.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

export class InMemoryRateCatalogRepository implements IRateCatalogRepository {
  private readonly entries: RateCatalogEntry[] = [];

  // Devuelve copias, no la referencia interna -- mismo comportamiento que
  // un SELECT real (cada lectura es un snapshot independiente). Sin esto,
  // un `before = await findById(...)` seguido de `update(...)` que muta el
  // objeto en memoria corrompería el snapshot ya leído (encontrado
  // escribiendo rate-catalog.service.test.ts: el diff de auditoría daba
  // vacío porque `before`/`entry` eran el mismo objeto).
  async findById(id: string, businessId: string): Promise<RateCatalogEntry | undefined> {
    const entry = this.entries.find((e) => e.id === id && e.businessId === businessId);
    return entry ? { ...entry } : undefined;
  }

  async listActiveByBusiness(businessId: string): Promise<RateCatalogEntry[]> {
    return this.entries
      .filter((e) => e.businessId === businessId && e.active)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ ...e }));
  }

  async create(dto: CreateRateCatalogEntryDto): Promise<RateCatalogEntry> {
    const now = new Date();
    const entry: RateCatalogEntry = {
      id: dto.id,
      businessId: dto.businessId,
      name: dto.name,
      discountPercentage: dto.discountPercentage,
      resourceId: dto.resourceId ?? null,
      serviceId: dto.serviceId ?? null,
      productId: dto.productId ?? null,
      categoryId: dto.categoryId ?? null,
      bucket: dto.bucket ?? null,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.entries.push(entry);
    return { ...entry };
  }

  async update(id: string, businessId: string, dto: UpdateRateCatalogEntryDto): Promise<RateCatalogEntry | undefined> {
    const entry = this.entries.find((e) => e.id === id && e.businessId === businessId);
    if (!entry) return undefined;
    if (dto.name !== undefined) entry.name = dto.name;
    if (dto.discountPercentage !== undefined) entry.discountPercentage = dto.discountPercentage;
    entry.updatedAt = new Date();
    return { ...entry };
  }

  /** En memoria no hay transacción real — delega a `update()`, el `client` se ignora. */
  async updateWithClient(_client: SqlClient, id: string, businessId: string, dto: UpdateRateCatalogEntryDto): Promise<RateCatalogEntry | undefined> {
    return this.update(id, businessId, dto);
  }

  async deactivate(id: string, businessId: string): Promise<boolean> {
    const entry = this.entries.find((e) => e.id === id && e.businessId === businessId && e.active);
    if (!entry) return false;
    entry.active = false;
    return true;
  }

  /** En memoria no hay transacción real — delega a `deactivate()`, el `client` se ignora. */
  async deactivateWithClient(_client: SqlClient, id: string, businessId: string): Promise<boolean> {
    return this.deactivate(id, businessId);
  }

  /** Helper de test. */
  seed(entries: RateCatalogEntry[]): void {
    this.entries.push(...entries);
  }
}
