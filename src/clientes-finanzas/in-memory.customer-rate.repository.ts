/**
 * @file in-memory.customer-rate.repository.ts
 * @description Implementación in-memory de ICustomerRateRepository — para tests.
 */

import type {
  ICustomerRateRepository,
  CustomerRate,
  CreateCustomerRateDto,
} from './customer-rate.repository.js';

/** 1 = ítem (más específico), 2 = categoría, 3 = bucket -- mismo criterio que SPECIFICITY_ORDER en sql.customer-rate.repository.ts. */
function specificity(r: CustomerRate): number {
  if (r.resourceId || r.serviceId || r.productId) return 1;
  if (r.categoryId) return 2;
  return 3;
}

export class InMemoryCustomerRateRepository implements ICustomerRateRepository {
  private readonly rates: CustomerRate[] = [];

  async findActiveForCustomerAndResource(
    customerId: string, resourceId: string, categoryId: string, isLodging: boolean,
  ): Promise<CustomerRate | undefined> {
    const bucket = isLodging ? 'ALOJAMIENTO' : 'TURNOS';
    const candidates = this.rates.filter(
      (r) => r.customerId === customerId && r.active &&
        (r.resourceId === resourceId || r.categoryId === categoryId || r.bucket === bucket),
    );
    if (candidates.length === 0) return undefined;
    return [...candidates].sort((a, b) => specificity(a) - specificity(b))[0];
  }

  async findActiveForCustomerAndService(
    customerId: string, serviceId: string, categoryId: string,
  ): Promise<CustomerRate | undefined> {
    const candidates = this.rates.filter(
      (r) => r.customerId === customerId && r.active &&
        (r.serviceId === serviceId || r.categoryId === categoryId || r.bucket === 'SERVICIOS'),
    );
    if (candidates.length === 0) return undefined;
    return [...candidates].sort((a, b) => specificity(a) - specificity(b))[0];
  }

  // Copia, no la referencia interna -- un caller típico de findById() lee
  // el estado "antes" para auditar y después llama deactivate(), que muta
  // el objeto guardado acá adentro (mismo bug encontrado y corregido en
  // in-memory.rate-catalog.repository.ts, ver ese comentario).
  async findById(id: string, businessId: string): Promise<CustomerRate | undefined> {
    const rate = this.rates.find((r) => r.id === id && r.businessId === businessId);
    return rate ? { ...rate } : undefined;
  }

  async getByCustomerId(customerId: string): Promise<CustomerRate[]> {
    return this.rates.filter((r) => r.customerId === customerId && r.active);
  }

  async create(dto: CreateCustomerRateDto): Promise<CustomerRate> {
    const rate: CustomerRate = {
      id: dto.id,
      businessId: dto.businessId,
      customerId: dto.customerId,
      resourceId: dto.resourceId ?? null,
      serviceId: dto.serviceId ?? null,
      productId: dto.productId ?? null,
      categoryId: dto.categoryId ?? null,
      bucket: dto.bucket ?? null,
      fixedPrice: dto.fixedPrice ?? null,
      discountPercentage: dto.discountPercentage ?? null,
      rateCatalogId: dto.rateCatalogId ?? null,
      active: true,
      notes: dto.notes ?? null,
    };
    this.rates.push(rate);
    return rate;
  }

  async deactivate(id: string): Promise<void> {
    const rate = this.rates.find((r) => r.id === id);
    if (rate) rate.active = false;
  }

  /** Helper de test — carga tarifas directo sin pasar por create(). */
  seed(rates: CustomerRate[]): void {
    this.rates.push(...rates);
  }
}
