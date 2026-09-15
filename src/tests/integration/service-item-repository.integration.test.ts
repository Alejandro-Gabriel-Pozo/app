/**
 * @file service-item-repository.integration.test.ts
 * @description Integration test contra Postgres real para
 * SqlServiceItemRepository -- Bloque B de `service_items`
 * (docs/diseno-factura-borrador-2026-08-31.md §29.7). No hay integration
 * test previo de `products`/`waste-reasons`/categorías para copiar 1:1 (no
 * existen en este repo) -- sigue el patrón general de
 * `src/tests/integration/`: `createTestDatabase()`/`dropTestDatabase()`,
 * `describe.skipIf(skipIfNoDb)`, seeds de `helpers/seed.ts`.
 *
 * Cubre contra la BD real lo que los tests unitarios (mock de SqlClient)
 * no pueden: el CHECK (price >= 0), la FK category_id -> resource_categories
 * ON DELETE RESTRICT, y R2/R3 (findById sin filtro de estado, deactivate
 * sin DELETE real) contra el schema.sql aplicado tal cual.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createTestDatabase, dropTestDatabase, skipIfNoDb } from './helpers/db.js';
import { seedCategory } from './helpers/seed.js';
import { SqlServiceItemRepository } from '../../pos-menu/sql.service-item.repository.js';
import { ServiceItemNotFoundError } from '../../domain/errors.js';
import type { SqlClient } from '../../repositories/sql.client.js';

describe.skipIf(skipIfNoDb)('SqlServiceItemRepository (integración, Postgres real)', () => {
  let db: SqlClient;
  let dbName: string;
  let pool: pg.Pool;
  let repo: SqlServiceItemRepository;

  beforeAll(async () => {
    ({ db, dbName, pool } = await createTestDatabase());
    repo = new SqlServiceItemRepository(db);
  }, 30_000);

  afterAll(async () => {
    await dropTestDatabase(dbName, pool);
  });

  it('create() + findById() -- persiste y recupera contra el schema real', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'Cargo por cancelación', price: 500 });

    const found = await repo.findById(item.id);
    expect(found).toMatchObject({
      id: item.id, businessId: 'biz-1', name: 'Cargo por cancelación',
      price: 500, active: true, categoryId: null, deletedAt: null,
    });
  });

  it('category_id acepta una categoría real de resource_categories (FK ON DELETE RESTRICT)', async () => {
    const category = await seedCategory(db, { name: 'Cargos administrativos' });

    const item = await repo.create({ businessId: 'biz-1', name: 'Costo de envío', price: 100, categoryId: category.id });

    expect(item.categoryId).toBe(category.id);
  });

  it('CHECK (price >= 0) rechaza un precio negativo a nivel de BD', async () => {
    await expect(
      repo.create({ businessId: 'biz-1', name: 'Precio inválido', price: -1 }),
    ).rejects.toThrow();
  });

  it('A2.8 -- findAll() aísla por business_id', async () => {
    await repo.create({ businessId: 'biz-a', name: 'Ítem de A', price: 10 });
    await repo.create({ businessId: 'biz-b', name: 'Ítem de B', price: 20 });

    const itemsA = await repo.findAll('biz-a');
    expect(itemsA.map((i) => i.name)).toContain('Ítem de A');
    expect(itemsA.map((i) => i.name)).not.toContain('Ítem de B');
  });

  it('R2 -- findById() encuentra un ítem desactivado (sin filtro de estado)', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'Pausado', price: 50 });
    await repo.deactivate(item.id);

    const found = await repo.findById(item.id);
    expect(found?.active).toBe(false);
  });

  it('R3 -- deactivate() hace UPDATE (active=false), nunca DELETE -- la fila sigue existiendo', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'A desactivar', price: 50 });

    await repo.deactivate(item.id);

    const { rows } = await db.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM service_items WHERE id = $1',
      [item.id],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('findAll() excluye ítems desactivados', async () => {
    const item = await repo.create({ businessId: 'biz-c', name: 'Para pausar', price: 10 });
    await repo.deactivate(item.id);

    const items = await repo.findAll('biz-c');
    expect(items.map((i) => i.id)).not.toContain(item.id);
  });

  it('update() persiste el cambio y actualiza updated_at', async () => {
    const item = await repo.create({ businessId: 'biz-1', name: 'A editar', price: 10 });

    const updated = await repo.update(item.id, { price: 999, name: 'Editado' });

    expect(updated.price).toBe(999);
    expect(updated.name).toBe('Editado');
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(item.updatedAt.getTime());
  });

  it('update() lanza ServiceItemNotFoundError contra un id inexistente', async () => {
    await expect(repo.update(randomUUID(), { price: 1 })).rejects.toBeInstanceOf(ServiceItemNotFoundError);
  });
});
