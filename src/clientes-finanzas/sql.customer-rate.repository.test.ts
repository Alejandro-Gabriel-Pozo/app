/**
 * @file sql.customer-rate.repository.test.ts
 * @description D5 (pendientes-2026-08-19.md) — `rateCatalogId` es una
 * referencia VIVA (decisión del dueño, corregida 22/08/2026 antes de
 * cualquier deploy real): el % efectivo de una tarifa creada desde el
 * catálogo se resuelve con JOIN a `rate_catalog` en cada lectura, no se
 * copia a la fila. Estos tests verifican ese cómputo (`rowToRate`) contra
 * la forma exacta que devuelve la query (columna propia +
 * `catalog_discount_percentage` del JOIN), sin depender de una BD real.
 */

import { describe, it, expect, vi } from 'vitest';
import { SqlCustomerRateRepository } from './sql.customer-rate.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

function mockClient(rows: unknown[] = []): SqlClient {
  return { query: vi.fn(async () => ({ rows })) as unknown as SqlClient['query'] };
}

function rateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rate-1', business_id: 'biz-1', customer_id: 'cust-1',
    resource_id: 'r1', service_id: null,
    fixed_price: null, discount_percentage: null, rate_catalog_id: null,
    active: true, notes: null,
    created_at: new Date(), updated_at: new Date(),
    catalog_discount_percentage: null,
    ...overrides,
  };
}

describe('SqlCustomerRateRepository — % efectivo (propio vs. catálogo en vivo)', () => {
  it('rate_catalog_id seteado, sin % propio: usa el % del catálogo (JOIN)', async () => {
    const client = mockClient([rateRow({ rate_catalog_id: 'cat-1', catalog_discount_percentage: '10.00' })]);
    const repo = new SqlCustomerRateRepository(client);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1');

    expect(rate?.discountPercentage).toBe(10);
    expect(rate?.rateCatalogId).toBe('cat-1');
  });

  it('sin rate_catalog_id, con % propio: usa el % de la fila', async () => {
    const client = mockClient([rateRow({ discount_percentage: '15.00' })]);
    const repo = new SqlCustomerRateRepository(client);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1');

    expect(rate?.discountPercentage).toBe(15);
  });

  it('monto fijo: discountPercentage null aunque el JOIN devuelva algo (no debería, pero no lo prioriza)', async () => {
    const client = mockClient([rateRow({ fixed_price: '40.00', catalog_discount_percentage: null })]);
    const repo = new SqlCustomerRateRepository(client);

    const rate = await repo.findActiveForCustomerAndResource('cust-1', 'r1');

    expect(rate?.fixedPrice).toBe(40);
    expect(rate?.discountPercentage).toBeNull();
  });

  it('findActiveForCustomerAndService hace LEFT JOIN a rate_catalog', async () => {
    const client = mockClient([]);
    const repo = new SqlCustomerRateRepository(client);

    await repo.findActiveForCustomerAndService('cust-1', 'svc-1');

    const sql = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(sql).toContain('LEFT JOIN rate_catalog rc ON rc.id = cr.rate_catalog_id');
    expect(sql).toContain('cr.service_id = $2');
  });

  it('create() con rateCatalogId no manda discount_percentage propio, y el SELECT final igual resuelve el % vía JOIN', async () => {
    const client = mockClient([rateRow({ rate_catalog_id: 'cat-1', catalog_discount_percentage: '20.00' })]);
    const repo = new SqlCustomerRateRepository(client);

    const rate = await repo.create({
      id: 'rate-2', businessId: 'biz-1', customerId: 'cust-1', resourceId: 'r1', rateCatalogId: 'cat-1',
    });

    const [sql, params] = (client.query as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(sql).toContain('WITH inserted AS');
    expect(sql).toContain('LEFT JOIN rate_catalog rc ON rc.id = inserted.rate_catalog_id');
    expect(params).toEqual(['rate-2', 'biz-1', 'cust-1', 'r1', null, null, null, 'cat-1', null]);
    expect(rate.discountPercentage).toBe(20);
  });
});
