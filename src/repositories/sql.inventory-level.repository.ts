import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type { InventoryLevel, InventoryLevelKey, InventoryLevelRepository } from './inventory-level.repository.js';

function rowToLevel(row: Record<string, unknown>): InventoryLevel {
  return {
    id:                row['id'] as string,
    businessId:        row['business_id'] as string,
    productId:         (row['product_id'] as string | null) ?? null,
    productVariantId:  (row['product_variant_id'] as string | null) ?? null,
    locationId:        row['location_id'] as string,
    stockQuantity:     Number(row['stock_quantity']),
    reservedQuantity:  Number(row['reserved_quantity']),
    stockMinAlert:     Number(row['stock_min_alert']),
    createdAt:         new Date(row['created_at'] as string),
    updatedAt:         new Date(row['updated_at'] as string),
  };
}

/**
 * "Asegura" que exista una fila en 0/0/0 para esta clave — nunca pisa una
 * fila existente (ON CONFLICT DO NOTHING). El target de conflicto tiene que
 * coincidir exacto con uno de los dos índices únicos parciales de
 * schema.sql (BLOQUE 16) — por eso las dos ramas en vez de un solo INSERT
 * genérico.
 */
async function ensureRow(client: SqlClient, businessId: string, key: InventoryLevelKey): Promise<void> {
  if (key.productVariantId) {
    await client.query(
      `INSERT INTO inventory_levels (id, business_id, product_variant_id, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_variant_id, location_id) WHERE product_variant_id IS NOT NULL DO NOTHING`,
      [randomUUID(), businessId, key.productVariantId, key.locationId],
    );
  } else {
    await client.query(
      `INSERT INTO inventory_levels (id, business_id, product_id, location_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, location_id) WHERE product_id IS NOT NULL DO NOTHING`,
      [randomUUID(), businessId, key.productId, key.locationId],
    );
  }
}

function whereTarget(key: InventoryLevelKey, paramIdx: number): { clause: string; param: string } {
  return key.productVariantId
    ? { clause: `product_variant_id = $${paramIdx}`, param: key.productVariantId }
    : { clause: `product_id = $${paramIdx}`, param: key.productId! };
}

export class SqlInventoryLevelRepository implements InventoryLevelRepository {
  constructor(private readonly db: SqlClient) {}

  async get(key: InventoryLevelKey): Promise<InventoryLevel | undefined> {
    const target = whereTarget(key, 2);
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM inventory_levels WHERE location_id = $1 AND ${target.clause} LIMIT 1`,
      [key.locationId, target.param],
    );
    return rows[0] ? rowToLevel(rows[0]) : undefined;
  }

  async getAllByLocation(businessId: string, locationId: string): Promise<InventoryLevel[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM inventory_levels WHERE business_id = $1 AND location_id = $2`,
      [businessId, locationId],
    );
    return rows.map(rowToLevel);
  }

  async reserveStock(client: SqlClient, businessId: string, key: InventoryLevelKey, quantity: number): Promise<boolean> {
    await ensureRow(client, businessId, key);
    const target = whereTarget(key, 3);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE inventory_levels
       SET reserved_quantity = reserved_quantity + $1,
           updated_at        = NOW()
       WHERE location_id = $2 AND ${target.clause}
         AND (stock_quantity - reserved_quantity) >= $1
       RETURNING id`,
      [quantity, key.locationId, target.param],
    );
    return rows.length > 0;
  }

  async commitReservedStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void> {
    const target = whereTarget(key, 3);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE inventory_levels
       SET stock_quantity    = stock_quantity - $1,
           reserved_quantity = reserved_quantity - $1,
           updated_at        = NOW()
       WHERE location_id = $2 AND ${target.clause}
         AND stock_quantity >= $1
         AND reserved_quantity >= $1
       RETURNING id`,
      [quantity, key.locationId, target.param],
    );
    if (!rows[0]) {
      throw new Error(`No se pudo consolidar la reserva de stock (${JSON.stringify(key)}, quantity=${quantity}).`);
    }
  }

  async releaseReservedStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void> {
    const target = whereTarget(key, 3);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE inventory_levels
       SET reserved_quantity = reserved_quantity - $1,
           updated_at        = NOW()
       WHERE location_id = $2 AND ${target.clause}
         AND reserved_quantity >= $1
       RETURNING id`,
      [quantity, key.locationId, target.param],
    );
    if (!rows[0]) {
      throw new Error(`No se pudo liberar la reserva de stock (${JSON.stringify(key)}, quantity=${quantity}).`);
    }
  }

  async incrementStock(client: SqlClient, businessId: string, key: InventoryLevelKey, quantity: number): Promise<void> {
    await ensureRow(client, businessId, key);
    const target = whereTarget(key, 3);
    await client.query(
      `UPDATE inventory_levels
       SET stock_quantity = stock_quantity + $1,
           updated_at     = NOW()
       WHERE location_id = $2 AND ${target.clause}`,
      [quantity, key.locationId, target.param],
    );
  }

  async decrementStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void> {
    const target = whereTarget(key, 3);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE inventory_levels
       SET stock_quantity = stock_quantity - $1,
           updated_at     = NOW()
       WHERE location_id = $2 AND ${target.clause}
         AND stock_quantity >= $1
       RETURNING id`,
      [quantity, key.locationId, target.param],
    );
    if (!rows[0]) {
      throw new Error(`Stock insuficiente (${JSON.stringify(key)}).`);
    }
  }

  async getTotalPhysicalStock(key: { productId: string | null; productVariantId: string | null }): Promise<number> {
    const clause = key.productVariantId ? 'product_variant_id = $1' : 'product_id = $1';
    const param = key.productVariantId ?? key.productId;
    const { rows } = await this.db.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(stock_quantity), 0) AS total FROM inventory_levels WHERE ${clause}`,
      [param],
    );
    return Number(rows[0]?.total ?? 0);
  }

  async decrementAvailableStock(client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void> {
    const target = whereTarget(key, 3);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE inventory_levels
       SET stock_quantity = stock_quantity - $1,
           updated_at     = NOW()
       WHERE location_id = $2 AND ${target.clause}
         AND (stock_quantity - reserved_quantity) >= $1
       RETURNING id`,
      [quantity, key.locationId, target.param],
    );
    if (!rows[0]) {
      throw new Error(`Stock disponible insuficiente (${JSON.stringify(key)}, quantity=${quantity}).`);
    }
  }

  async transferStock(
    client: SqlClient,
    businessId: string,
    productId: string | null,
    productVariantId: string | null,
    fromLocationId: string,
    toLocationId: string,
    quantity: number,
  ): Promise<void> {
    const fromKey: InventoryLevelKey = { productId, productVariantId, locationId: fromLocationId };
    const toKey:   InventoryLevelKey = { productId, productVariantId, locationId: toLocationId };

    await ensureRow(client, businessId, toKey);

    // No reusa decrementStock() a propósito: esa condiciona solo contra
    // stock_quantity (mismo criterio que ya tenía el endpoint manual de
    // ajuste, sin tocar). Acá hace falta la condición más estricta contra
    // lo DISPONIBLE (stock - reservado) -- transferir stock que ya está
    // comprometido con una orden confirmada rompería el CHECK
    // reserved<=stock en vez de fallar limpio con un error de dominio.
    const target = whereTarget(fromKey, 3);
    const { rows } = await client.query<{ id: string }>(
      `UPDATE inventory_levels
       SET stock_quantity = stock_quantity - $1,
           updated_at     = NOW()
       WHERE location_id = $2 AND ${target.clause}
         AND (stock_quantity - reserved_quantity) >= $1
       RETURNING id`,
      [quantity, fromLocationId, target.param],
    );
    if (!rows[0]) {
      throw new Error(`Stock disponible insuficiente para transferir (${JSON.stringify(fromKey)}, quantity=${quantity}).`);
    }

    await this.incrementStock(client, businessId, toKey, quantity);
  }
}
