import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryInventoryLevelRepository } from './in-memory.inventory-level.repository.js';
import type { SqlClient } from './sql.client.js';

/**
 * Cobertura acotada a decrementAvailableStock() (Fase 2 del carve-out de
 * inventario, 17/08/2026) — método nuevo, sin tests previos de
 * InventoryLevelRepository en el repo (ver comentario equivalente en
 * category.service.test.ts: no había InMemoryCategoryRepository tampoco).
 * No es una pasada retroactiva sobre el resto de los métodos, ya
 * verificados contra Postgres real en la Fase 1.
 */
describe('InMemoryInventoryLevelRepository.decrementAvailableStock', () => {
  let repo: InMemoryInventoryLevelRepository;
  const fakeClient = {} as SqlClient;

  beforeEach(() => {
    repo = new InMemoryInventoryLevelRepository();
  });

  it('decrementa stock físico cuando hay disponible suficiente', async () => {
    repo.seed({
      id: 'lvl-1', businessId: 'biz-1', productId: 'prod-1', productVariantId: null,
      locationId: 'loc-1', stockQuantity: 10, reservedQuantity: 2, stockMinAlert: 0,
    });

    await repo.decrementAvailableStock(fakeClient, { productId: 'prod-1', productVariantId: null, locationId: 'loc-1' }, 5);

    const level = await repo.get({ productId: 'prod-1', productVariantId: null, locationId: 'loc-1' });
    expect(level?.stockQuantity).toBe(5);
    expect(level?.reservedQuantity).toBe(2); // no toca lo reservado
  });

  it('lanza si lo disponible (stock - reservado) no alcanza, aunque el stock físico sí', async () => {
    repo.seed({
      id: 'lvl-1', businessId: 'biz-1', productId: 'prod-1', productVariantId: null,
      locationId: 'loc-1', stockQuantity: 10, reservedQuantity: 8, stockMinAlert: 0,
    });

    // Disponible = 10 - 8 = 2; pedir 5 debe fallar aunque el físico (10) alcance.
    await expect(
      repo.decrementAvailableStock(fakeClient, { productId: 'prod-1', productVariantId: null, locationId: 'loc-1' }, 5),
    ).rejects.toThrow('Stock disponible insuficiente');

    const level = await repo.get({ productId: 'prod-1', productVariantId: null, locationId: 'loc-1' });
    expect(level?.stockQuantity).toBe(10); // sin cambios
  });

  it('lanza si no existe ninguna fila para esa clave (equivale a stock 0)', async () => {
    await expect(
      repo.decrementAvailableStock(fakeClient, { productId: 'prod-inexistente', productVariantId: null, locationId: 'loc-1' }, 1),
    ).rejects.toThrow('Stock disponible insuficiente');
  });
});
