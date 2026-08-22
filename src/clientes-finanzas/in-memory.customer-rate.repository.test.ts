/**
 * @file in-memory.customer-rate.repository.test.ts
 * @description D9-Parte 1 (pendientes-2026-08-22.md,
 * docs/diseno-scope-multinivel-tarifas-2026-08-22.md) — resolución de la
 * tarifa MÁS ESPECÍFICA entre las candidatas que alcanzan a un ítem
 * concreto (ítem > categoría > bucket), default confirmado con el dueño.
 */

import { describe, it, expect } from 'vitest';
import { InMemoryCustomerRateRepository } from './in-memory.customer-rate.repository.js';
import type { CustomerRate } from './customer-rate.repository.js';

const now = new Date();

function makeRate(overrides: Partial<CustomerRate> = {}): CustomerRate {
  return {
    id: 'rate-x', businessId: 'biz-1', customerId: 'cust-1',
    resourceId: null, serviceId: null, productId: null, categoryId: null, bucket: null,
    fixedPrice: null, discountPercentage: 10, rateCatalogId: null,
    active: true, notes: null, createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe('InMemoryCustomerRateRepository.findActiveForCustomerAndResource — especificidad multi-nivel', () => {
  it('sin ninguna candidata, no devuelve nada', async () => {
    const repo = new InMemoryCustomerRateRepository();
    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1', 'cat-1', false);
    expect(rate).toBeUndefined();
  });

  it('solo bucket activo (TURNOS): lo devuelve', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([makeRate({ id: 'r-bucket', bucket: 'TURNOS', discountPercentage: 5 })]);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1', 'cat-1', false);

    expect(rate?.id).toBe('r-bucket');
  });

  it('bucket ALOJAMIENTO no matchea un recurso TURNOS (isLodging=false)', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([makeRate({ id: 'r-aloj', bucket: 'ALOJAMIENTO' })]);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1', 'cat-1', false);

    expect(rate).toBeUndefined();
  });

  it('categoría le gana a bucket (más específico)', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([
      makeRate({ id: 'r-bucket', bucket: 'TURNOS', discountPercentage: 5 }),
      makeRate({ id: 'r-categoria', categoryId: 'cat-1', discountPercentage: 15 }),
    ]);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1', 'cat-1', false);

    expect(rate?.id).toBe('r-categoria');
  });

  it('ítem le gana a categoría Y a bucket (el más específico de los 3)', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([
      makeRate({ id: 'r-bucket', bucket: 'TURNOS', discountPercentage: 5 }),
      makeRate({ id: 'r-categoria', categoryId: 'cat-1', discountPercentage: 15 }),
      makeRate({ id: 'r-item', resourceId: 'r1', discountPercentage: 25 }),
    ]);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1', 'cat-1', false);

    expect(rate?.id).toBe('r-item');
  });

  it('una tarifa INACTIVA no compite, aunque sea más específica', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([
      makeRate({ id: 'r-item-inactivo', resourceId: 'r1', discountPercentage: 25, active: false }),
      makeRate({ id: 'r-categoria', categoryId: 'cat-1', discountPercentage: 15 }),
    ]);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1', 'cat-1', false);

    expect(rate?.id).toBe('r-categoria');
  });

  it('una tarifa de OTRO cliente no compite', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([makeRate({ id: 'r-otro-cliente', customerId: 'cust-2', resourceId: 'r1' })]);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1', 'cat-1', false);

    expect(rate).toBeUndefined();
  });
});

describe('InMemoryCustomerRateRepository.findActiveForCustomerAndService — bucket fijo SERVICIOS', () => {
  it('bucket SERVICIOS matchea sin importar la categoría del servicio', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([makeRate({ id: 'r-servicios', bucket: 'SERVICIOS' })]);

    const rate = await repo.findActiveForCustomerAndService('cust-1', 's1', 'cat-spa');

    expect(rate?.id).toBe('r-servicios');
  });

  it('categoría de servicio le gana al bucket SERVICIOS', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([
      makeRate({ id: 'r-bucket', bucket: 'SERVICIOS', discountPercentage: 5 }),
      makeRate({ id: 'r-categoria', categoryId: 'cat-spa', discountPercentage: 15 }),
    ]);

    const rate = await repo.findActiveForCustomerAndService('cust-1', 's1', 'cat-spa');

    expect(rate?.id).toBe('r-categoria');
  });

  it('ítem (serviceId) le gana a categoría y bucket', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([
      makeRate({ id: 'r-bucket', bucket: 'SERVICIOS' }),
      makeRate({ id: 'r-categoria', categoryId: 'cat-spa' }),
      makeRate({ id: 'r-item', serviceId: 's1' }),
    ]);

    const rate = await repo.findActiveForCustomerAndService('cust-1', 's1', 'cat-spa');

    expect(rate?.id).toBe('r-item');
  });
});

describe('InMemoryCustomerRateRepository.findActiveForCustomerAndProduct — bucket fijo PRODUCTOS (D9-Parte 2)', () => {
  it('bucket PRODUCTOS matchea sin importar la categoría del producto', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([makeRate({ id: 'r-productos', bucket: 'PRODUCTOS' })]);

    const rate = await repo.findActiveForCustomerAndProduct('cust-1', 'p1', 'cat-bebidas');

    expect(rate?.id).toBe('r-productos');
  });

  it('categoría de producto le gana al bucket PRODUCTOS', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([
      makeRate({ id: 'r-bucket', bucket: 'PRODUCTOS', discountPercentage: 5 }),
      makeRate({ id: 'r-categoria', categoryId: 'cat-bebidas', discountPercentage: 15 }),
    ]);

    const rate = await repo.findActiveForCustomerAndProduct('cust-1', 'p1', 'cat-bebidas');

    expect(rate?.id).toBe('r-categoria');
  });

  it('ítem (productId) le gana a categoría y bucket', async () => {
    const repo = new InMemoryCustomerRateRepository();
    repo.seed([
      makeRate({ id: 'r-bucket', bucket: 'PRODUCTOS' }),
      makeRate({ id: 'r-categoria', categoryId: 'cat-bebidas' }),
      makeRate({ id: 'r-item', productId: 'p1' }),
    ]);

    const rate = await repo.findActiveForCustomerAndProduct('cust-1', 'p1', 'cat-bebidas');

    expect(rate?.id).toBe('r-item');
  });

  it('sin ninguna candidata, no devuelve nada', async () => {
    const repo = new InMemoryCustomerRateRepository();
    const rate = await repo.findActiveForCustomerAndProduct('cust-1', 'p1', 'cat-bebidas');
    expect(rate).toBeUndefined();
  });
});
