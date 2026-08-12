/**
 * @file in-memory.customer-rate.repository.ts
 * @description Implementación in-memory de ICustomerRateRepository — para tests.
 */

import type {
  ICustomerRateRepository,
  CustomerRate,
  CreateCustomerRateDto,
} from './customer-rate.repository.js';

export class InMemoryCustomerRateRepository implements ICustomerRateRepository {
  private readonly rates: CustomerRate[] = [];

  async findActiveForCustomerAndResource(customerId: string, resourceId: string): Promise<CustomerRate | undefined> {
    return this.rates.find(
      (r) => r.customerId === customerId && r.resourceId === resourceId && r.active,
    );
  }

  async findActiveForCustomerAndService(customerId: string, serviceId: string): Promise<CustomerRate | undefined> {
    return this.rates.find(
      (r) => r.customerId === customerId && r.serviceId === serviceId && r.active,
    );
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
      price: dto.price,
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
