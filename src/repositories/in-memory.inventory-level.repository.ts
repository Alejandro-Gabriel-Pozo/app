import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type { InventoryLevel, InventoryLevelKey, InventoryLevelRepository } from './inventory-level.repository.js';

function keyString(key: InventoryLevelKey): string {
  return `${key.productId ?? ''}|${key.productVariantId ?? ''}|${key.locationId}`;
}

/** Test double en memoria — mismo criterio que el resto de los InMemory*Repository. */
export class InMemoryInventoryLevelRepository implements InventoryLevelRepository {
  private readonly rows = new Map<string, InventoryLevel>();

  /** Solo para setup de tests -- fija un nivel de stock inicial. */
  seed(level: Omit<InventoryLevel, 'createdAt' | 'updatedAt'>): void {
    this.rows.set(keyString(level), { ...level, createdAt: new Date(), updatedAt: new Date() });
  }

  private ensure(businessId: string, key: InventoryLevelKey): InventoryLevel {
    const k = keyString(key);
    let row = this.rows.get(k);
    if (!row) {
      row = {
        id: randomUUID(),
        businessId,
        productId: key.productId,
        productVariantId: key.productVariantId,
        locationId: key.locationId,
        stockQuantity: 0,
        reservedQuantity: 0,
        stockMinAlert: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.rows.set(k, row);
    }
    return row;
  }

  async get(key: InventoryLevelKey): Promise<InventoryLevel | undefined> {
    return this.rows.get(keyString(key));
  }

  async getAllByLocation(businessId: string, locationId: string): Promise<InventoryLevel[]> {
    return [...this.rows.values()].filter((r) => r.businessId === businessId && r.locationId === locationId);
  }

  async reserveStock(_client: SqlClient, businessId: string, key: InventoryLevelKey, quantity: number): Promise<boolean> {
    const row = this.ensure(businessId, key);
    if (row.stockQuantity - row.reservedQuantity < quantity) return false;
    row.reservedQuantity += quantity;
    row.updatedAt = new Date();
    return true;
  }

  async commitReservedStock(_client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void> {
    const row = this.rows.get(keyString(key));
    if (!row || row.stockQuantity < quantity || row.reservedQuantity < quantity) {
      throw new Error(`No se pudo consolidar la reserva de stock (${JSON.stringify(key)}, quantity=${quantity}).`);
    }
    row.stockQuantity -= quantity;
    row.reservedQuantity -= quantity;
    row.updatedAt = new Date();
  }

  async releaseReservedStock(_client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void> {
    const row = this.rows.get(keyString(key));
    if (!row || row.reservedQuantity < quantity) {
      throw new Error(`No se pudo liberar la reserva de stock (${JSON.stringify(key)}, quantity=${quantity}).`);
    }
    row.reservedQuantity -= quantity;
    row.updatedAt = new Date();
  }

  async incrementStock(_client: SqlClient, businessId: string, key: InventoryLevelKey, quantity: number): Promise<void> {
    const row = this.ensure(businessId, key);
    row.stockQuantity += quantity;
    row.updatedAt = new Date();
  }

  async decrementStock(_client: SqlClient, key: InventoryLevelKey, quantity: number): Promise<void> {
    const row = this.rows.get(keyString(key));
    if (!row || row.stockQuantity < quantity) {
      throw new Error(`Stock insuficiente (${JSON.stringify(key)}).`);
    }
    row.stockQuantity -= quantity;
    row.updatedAt = new Date();
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
    this.ensure(businessId, toKey);

    const fromRow = this.rows.get(keyString(fromKey));
    if (!fromRow || fromRow.stockQuantity - fromRow.reservedQuantity < quantity) {
      throw new Error(`Stock disponible insuficiente para transferir (${JSON.stringify(fromKey)}, quantity=${quantity}).`);
    }
    fromRow.stockQuantity -= quantity;
    fromRow.updatedAt = new Date();

    await this.incrementStock(client, businessId, toKey, quantity);
  }
}
