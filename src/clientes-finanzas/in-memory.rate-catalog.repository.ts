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

  async deactivate(id: string, businessId: string): Promise<boolean> {
    const entry = this.entries.find((e) => e.id === id && e.businessId === businessId && e.active);
    if (!entry) return false;
    entry.active = false;
    return true;
  }

  /** Helper de test. */
  seed(entries: RateCatalogEntry[]): void {
    this.entries.push(...entries);
  }
}
