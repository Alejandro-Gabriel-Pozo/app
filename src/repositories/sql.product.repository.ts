// =============================================================================
// repositories/sql.product.repository.ts — Implementación PostgreSQL
// =============================================================================

import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type {
  IProductRepository,
  IProductVariantRepository,
  ListProductsFilter,
  ListVariantsFilter,
} from './product.repository.js';
import type {
  Product,
  ProductVariant,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from '../domain/product.entities.js';

// ---------------------------------------------------------------------------
// Helpers de mapeo DB → dominio
// ---------------------------------------------------------------------------

function rowToProduct(row: Record<string, unknown>): Product {
  return {
    id: row['id'] as string,
    businessId: row['business_id'] as string,
    categoryId: (row['category_id'] as string | null) ?? null,
    name: row['name'] as string,
    description: (row['description'] as string | null) ?? null,
    basePrice: Number(row['base_price']),
    sku: (row['sku'] as string | null) ?? null,
    hasVariants: row['has_variants'] as boolean,
    stockQuantity: Number(row['stock_quantity']),
    stockMinAlert: Number(row['stock_min_alert']),
    active: row['active'] as boolean,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

function rowToVariant(row: Record<string, unknown>): ProductVariant {
  return {
    id: row['id'] as string,
    productId: row['product_id'] as string,
    name: row['name'] as string,
    attributes: (row['attributes'] as Record<string, string>) ?? {},
    sku: (row['sku'] as string | null) ?? null,
    priceOverride:
      row['price_override'] != null ? Number(row['price_override']) : null,
    stockQuantity: Number(row['stock_quantity']),
    stockMinAlert: Number(row['stock_min_alert']),
    active: row['active'] as boolean,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

// ---------------------------------------------------------------------------
// SqlProductRepository
// ---------------------------------------------------------------------------

export class SqlProductRepository implements IProductRepository {
  constructor(private readonly db: SqlClient) {}

  async getById(id: string): Promise<Product | undefined> {
    const rows = await this.db`
      SELECT * FROM products WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  }

  async getAll(filter: ListProductsFilter): Promise<Product[]> {
    const conditions: string[] = ['business_id = $1'];
    const params: unknown[] = [filter.businessId];
    let idx = 2;

    if (filter.categoryId !== undefined) {
      conditions.push(`category_id = $${idx++}`);
      params.push(filter.categoryId);
    }
    if (filter.hasVariants !== undefined) {
      conditions.push(`has_variants = $${idx++}`);
      params.push(filter.hasVariants);
    }
    if (filter.active !== undefined) {
      conditions.push(`active = $${idx++}`);
      params.push(filter.active);
    }
    if (filter.search) {
      conditions.push(
        `(name ILIKE $${idx} OR sku ILIKE $${idx})`,
      );
      params.push(`%${filter.search}%`);
      idx++;
    }

    const where = conditions.join(' AND ');
    const limit = filter.limit ?? 100;
    const offset = filter.offset ?? 0;

    // Usamos tagged-template para la parte fija y parámetros para los valores
    const rows = await this.db.unsafe(
      `SELECT * FROM products WHERE ${where} ORDER BY name ASC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    );
    return rows.map(rowToProduct);
  }

  async getBySku(
    businessId: string,
    sku: string,
  ): Promise<Product | undefined> {
    const rows = await this.db`
      SELECT * FROM products
      WHERE business_id = ${businessId} AND sku = ${sku}
      LIMIT 1
    `;
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  }

  async save(product: Product): Promise<void> {
    await this.db`
      INSERT INTO products (
        id, business_id, category_id, name, description,
        base_price, sku, has_variants, stock_quantity, stock_min_alert, active
      ) VALUES (
        ${product.id}, ${product.businessId}, ${product.categoryId},
        ${product.name}, ${product.description}, ${product.basePrice},
        ${product.sku}, ${product.hasVariants}, ${product.stockQuantity},
        ${product.stockMinAlert}, ${product.active}
      )
      ON CONFLICT (id) DO UPDATE SET
        category_id    = EXCLUDED.category_id,
        name           = EXCLUDED.name,
        description    = EXCLUDED.description,
        base_price     = EXCLUDED.base_price,
        sku            = EXCLUDED.sku,
        has_variants   = EXCLUDED.has_variants,
        stock_quantity = EXCLUDED.stock_quantity,
        stock_min_alert= EXCLUDED.stock_min_alert,
        active         = EXCLUDED.active,
        updated_at     = NOW()
    `;
  }

  async create(input: CreateProductInput): Promise<Product> {
    const id = randomUUID();
    const rows = await this.db`
      INSERT INTO products (
        id, business_id, category_id, name, description,
        base_price, sku, has_variants, stock_quantity, stock_min_alert
      ) VALUES (
        ${id},
        ${input.businessId},
        ${input.categoryId ?? null},
        ${input.name},
        ${input.description ?? null},
        ${input.basePrice},
        ${input.sku ?? null},
        ${input.hasVariants ?? false},
        ${input.stockQuantity ?? 0},
        ${input.stockMinAlert ?? 0}
      )
      RETURNING *
    `;
    return rowToProduct(rows[0]);
  }

  async update(
    id: string,
    input: UpdateProductInput,
  ): Promise<Product | undefined> {
    // Construimos el SET dinámicamente solo con los campos proporcionados
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const map: Array<[keyof UpdateProductInput, string]> = [
      ['categoryId', 'category_id'],
      ['name', 'name'],
      ['description', 'description'],
      ['basePrice', 'base_price'],
      ['sku', 'sku'],
      ['hasVariants', 'has_variants'],
      ['stockQuantity', 'stock_quantity'],
      ['stockMinAlert', 'stock_min_alert'],
      ['active', 'active'],
    ];

    for (const [key, col] of map) {
      if (input[key] !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(input[key] as unknown);
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push(`updated_at = NOW()`);
    params.push(id); // $idx = WHERE id

    const rows = await this.db.unsafe(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  }

  async decrementStock(
    client: SqlClient,
    productId: string,
    quantity: number,
  ): Promise<void> {
    const rows = await client`
      UPDATE products
      SET stock_quantity = stock_quantity - ${quantity},
          updated_at     = NOW()
      WHERE id = ${productId}
        AND has_variants = false
        AND stock_quantity >= ${quantity}
      RETURNING id
    `;
    if (!rows[0]) {
      throw new Error(
        `Stock insuficiente o producto usa variantes (id=${productId}).`,
      );
    }
  }

  async incrementStock(
    client: SqlClient,
    productId: string,
    quantity: number,
  ): Promise<void> {
    await client`
      UPDATE products
      SET stock_quantity = stock_quantity + ${quantity},
          updated_at     = NOW()
      WHERE id = ${productId} AND has_variants = false
    `;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db`
      UPDATE products SET active = false, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// SqlProductVariantRepository
// ---------------------------------------------------------------------------

export class SqlProductVariantRepository implements IProductVariantRepository {
  constructor(private readonly db: SqlClient) {}

  async getById(id: string): Promise<ProductVariant | undefined> {
    const rows = await this.db`
      SELECT * FROM product_variants WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? rowToVariant(rows[0]) : undefined;
  }

  async getByProduct(filter: ListVariantsFilter): Promise<ProductVariant[]> {
    if (filter.active !== undefined) {
      const rows = await this.db`
        SELECT * FROM product_variants
        WHERE product_id = ${filter.productId}
          AND active = ${filter.active}
        ORDER BY name ASC
      `;
      return rows.map(rowToVariant);
    }
    const rows = await this.db`
      SELECT * FROM product_variants
      WHERE product_id = ${filter.productId}
      ORDER BY name ASC
    `;
    return rows.map(rowToVariant);
  }

  async getBySku(
    productId: string,
    sku: string,
  ): Promise<ProductVariant | undefined> {
    const rows = await this.db`
      SELECT * FROM product_variants
      WHERE product_id = ${productId} AND sku = ${sku}
      LIMIT 1
    `;
    return rows[0] ? rowToVariant(rows[0]) : undefined;
  }

  async save(variant: ProductVariant): Promise<void> {
    await this.db`
      INSERT INTO product_variants (
        id, product_id, name, attributes, sku,
        price_override, stock_quantity, stock_min_alert, active
      ) VALUES (
        ${variant.id}, ${variant.productId}, ${variant.name},
        ${this.db.json(variant.attributes)}, ${variant.sku},
        ${variant.priceOverride}, ${variant.stockQuantity},
        ${variant.stockMinAlert}, ${variant.active}
      )
      ON CONFLICT (id) DO UPDATE SET
        name            = EXCLUDED.name,
        attributes      = EXCLUDED.attributes,
        sku             = EXCLUDED.sku,
        price_override  = EXCLUDED.price_override,
        stock_quantity  = EXCLUDED.stock_quantity,
        stock_min_alert = EXCLUDED.stock_min_alert,
        active          = EXCLUDED.active,
        updated_at      = NOW()
    `;
  }

  async create(input: CreateProductVariantInput): Promise<ProductVariant> {
    const id = randomUUID();
    const rows = await this.db`
      INSERT INTO product_variants (
        id, product_id, name, attributes, sku,
        price_override, stock_quantity, stock_min_alert
      ) VALUES (
        ${id},
        ${input.productId},
        ${input.name},
        ${this.db.json(input.attributes ?? {})},
        ${input.sku ?? null},
        ${input.priceOverride ?? null},
        ${input.stockQuantity ?? 0},
        ${input.stockMinAlert ?? 0}
      )
      RETURNING *
    `;
    return rowToVariant(rows[0]);
  }

  async update(
    id: string,
    input: UpdateProductVariantInput,
  ): Promise<ProductVariant | undefined> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.name !== undefined) {
      fields.push(`name = $${idx++}`);
      params.push(input.name);
    }
    if (input.attributes !== undefined) {
      fields.push(`attributes = $${idx++}`);
      params.push(JSON.stringify(input.attributes));
    }
    if (input.sku !== undefined) {
      fields.push(`sku = $${idx++}`);
      params.push(input.sku);
    }
    if (input.priceOverride !== undefined) {
      fields.push(`price_override = $${idx++}`);
      params.push(input.priceOverride);
    }
    if (input.stockQuantity !== undefined) {
      fields.push(`stock_quantity = $${idx++}`);
      params.push(input.stockQuantity);
    }
    if (input.stockMinAlert !== undefined) {
      fields.push(`stock_min_alert = $${idx++}`);
      params.push(input.stockMinAlert);
    }
    if (input.active !== undefined) {
      fields.push(`active = $${idx++}`);
      params.push(input.active);
    }

    if (fields.length === 0) return this.getById(id);

    fields.push(`updated_at = NOW()`);
    params.push(id);

    const rows = await this.db.unsafe(
      `UPDATE product_variants SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    return rows[0] ? rowToVariant(rows[0]) : undefined;
  }

  async decrementStock(
    client: SqlClient,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    const rows = await client`
      UPDATE product_variants
      SET stock_quantity = stock_quantity - ${quantity},
          updated_at     = NOW()
      WHERE id = ${variantId}
        AND stock_quantity >= ${quantity}
      RETURNING id
    `;
    if (!rows[0]) {
      throw new Error(`Stock insuficiente en variante (id=${variantId}).`);
    }
  }

  async incrementStock(
    client: SqlClient,
    variantId: string,
    quantity: number,
  ): Promise<void> {
    await client`
      UPDATE product_variants
      SET stock_quantity = stock_quantity + ${quantity},
          updated_at     = NOW()
      WHERE id = ${variantId}
    `;
  }

  async delete(id: string): Promise<boolean> {
    const rows = await this.db`
      UPDATE product_variants SET active = false, updated_at = NOW()
      WHERE id = ${id}
      RETURNING id
    `;
    return rows.length > 0;
  }
}
