// =============================================================================
// repositories/sql.product.repository.ts — Implementación PostgreSQL
// Usa SqlClient.query(sql, params) — compatible con pg (node-postgres).
// NO usa tagged templates ni APIs de postgres.js (.unsafe, .json, etc.).
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
    id:            row['id'] as string,
    businessId:    row['business_id'] as string,
    categoryId:    (row['category_id'] as string | null) ?? null,
    name:          row['name'] as string,
    description:   (row['description'] as string | null) ?? null,
    basePrice:     Number(row['base_price']),
    sku:           (row['sku'] as string | null) ?? null,
    hasVariants:   Boolean(row['has_variants']),
    stockQuantity: Number(row['stock_quantity']),
    stockMinAlert: Number(row['stock_min_alert']),
    active:        Boolean(row['active']),
    createdAt:     new Date(row['created_at'] as string),
    updatedAt:     new Date(row['updated_at'] as string),
  };
}

function rowToVariant(row: Record<string, unknown>): ProductVariant {
  return {
    id:            row['id'] as string,
    productId:     row['product_id'] as string,
    name:          row['name'] as string,
    attributes:    (row['attributes'] as Record<string, string>) ?? {},
    sku:           (row['sku'] as string | null) ?? null,
    priceOverride: row['price_override'] != null ? Number(row['price_override']) : null,
    stockQuantity: Number(row['stock_quantity']),
    stockMinAlert: Number(row['stock_min_alert']),
    active:        Boolean(row['active']),
    createdAt:     new Date(row['created_at'] as string),
    updatedAt:     new Date(row['updated_at'] as string),
  };
}

// ---------------------------------------------------------------------------
// SqlProductRepository
// ---------------------------------------------------------------------------

export class SqlProductRepository implements IProductRepository {
  constructor(private readonly db: SqlClient) {}

  async getById(id: string): Promise<Product | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM products WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  }

  async getAll(filter: ListProductsFilter): Promise<Product[]> {
    const conditions: string[] = ['business_id = $1'];
    const params: unknown[]    = [filter.businessId];
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
      conditions.push(`(name ILIKE $${idx} OR sku ILIKE $${idx})`);
      params.push(`%${filter.search}%`);
      idx++;
    }

    const limit  = filter.limit  ?? 100;
    const offset = filter.offset ?? 0;
    params.push(limit, offset);

    const sql = `
      SELECT * FROM products
      WHERE ${conditions.join(' AND ')}
      ORDER BY name ASC
      LIMIT $${idx} OFFSET $${idx + 1}
    `;

    const { rows } = await this.db.query<Record<string, unknown>>(sql, params);
    return rows.map(rowToProduct);
  }

  async getBySku(businessId: string, sku: string): Promise<Product | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM products WHERE business_id = $1 AND sku = $2 LIMIT 1',
      [businessId, sku],
    );
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  }

  async save(product: Product): Promise<void> {
    await this.db.query(
      `INSERT INTO products (
         id, business_id, category_id, name, description,
         base_price, sku, has_variants, stock_quantity, stock_min_alert, active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         category_id     = EXCLUDED.category_id,
         name            = EXCLUDED.name,
         description     = EXCLUDED.description,
         base_price      = EXCLUDED.base_price,
         sku             = EXCLUDED.sku,
         has_variants    = EXCLUDED.has_variants,
         stock_quantity  = EXCLUDED.stock_quantity,
         stock_min_alert = EXCLUDED.stock_min_alert,
         active          = EXCLUDED.active,
         updated_at      = NOW()`,
      [
        product.id, product.businessId, product.categoryId,
        product.name, product.description, product.basePrice,
        product.sku, product.hasVariants, product.stockQuantity,
        product.stockMinAlert, product.active,
      ],
    );
  }

  async create(input: CreateProductInput): Promise<Product> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO products (
         id, business_id, category_id, name, description,
         base_price, sku, has_variants, stock_quantity, stock_min_alert
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [
        id,
        input.businessId,
        input.categoryId  ?? null,
        input.name,
        input.description ?? null,
        input.basePrice,
        input.sku         ?? null,
        input.hasVariants ?? false,
        input.stockQuantity ?? 0,
        input.stockMinAlert ?? 0,
      ],
    );
    return rowToProduct(rows[0]!);
  }

  async update(id: string, input: UpdateProductInput): Promise<Product | undefined> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const map: Array<[keyof UpdateProductInput, string]> = [
      ['categoryId',    'category_id'],
      ['name',          'name'],
      ['description',   'description'],
      ['basePrice',     'base_price'],
      ['sku',           'sku'],
      ['hasVariants',   'has_variants'],
      ['stockQuantity', 'stock_quantity'],
      ['stockMinAlert', 'stock_min_alert'],
      ['active',        'active'],
    ];

    for (const [key, col] of map) {
      if (input[key] !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(input[key] as unknown);
      }
    }

    if (fields.length === 0) return this.getById(id);

    fields.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  }

  async decrementStock(client: SqlClient, productId: string, quantity: number): Promise<void> {
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE products
       SET stock_quantity = stock_quantity - $1,
           updated_at     = NOW()
       WHERE id = $2
         AND has_variants = false
         AND stock_quantity >= $1
       RETURNING id`,
      [quantity, productId],
    );
    if (!rows[0]) {
      throw new Error(`Stock insuficiente o producto usa variantes (id=${productId}).`);
    }
  }

  async incrementStock(client: SqlClient, productId: string, quantity: number): Promise<void> {
    await client.query(
      `UPDATE products
       SET stock_quantity = stock_quantity + $1,
           updated_at     = NOW()
       WHERE id = $2 AND has_variants = false`,
      [quantity, productId],
    );
  }

  async delete(id: string): Promise<boolean> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE products SET active = false, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// SqlProductVariantRepository
// ---------------------------------------------------------------------------

export class SqlProductVariantRepository implements IProductVariantRepository {
  constructor(private readonly db: SqlClient) {}

  async getById(id: string): Promise<ProductVariant | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      'SELECT * FROM product_variants WHERE id = $1 LIMIT 1',
      [id],
    );
    return rows[0] ? rowToVariant(rows[0]) : undefined;
  }

  async getByProduct(filter: ListVariantsFilter): Promise<ProductVariant[]> {
    if (filter.active !== undefined) {
      const { rows } = await this.db.query<Record<string, unknown>>(
        `SELECT * FROM product_variants
         WHERE product_id = $1 AND active = $2
         ORDER BY name ASC`,
        [filter.productId, filter.active],
      );
      return rows.map(rowToVariant);
    }
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM product_variants
       WHERE product_id = $1
       ORDER BY name ASC`,
      [filter.productId],
    );
    return rows.map(rowToVariant);
  }

  async getBySku(productId: string, sku: string): Promise<ProductVariant | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM product_variants
       WHERE product_id = $1 AND sku = $2 LIMIT 1`,
      [productId, sku],
    );
    return rows[0] ? rowToVariant(rows[0]) : undefined;
  }

  async save(variant: ProductVariant): Promise<void> {
    await this.db.query(
      `INSERT INTO product_variants (
         id, product_id, name, attributes, sku,
         price_override, stock_quantity, stock_min_alert, active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         name            = EXCLUDED.name,
         attributes      = EXCLUDED.attributes,
         sku             = EXCLUDED.sku,
         price_override  = EXCLUDED.price_override,
         stock_quantity  = EXCLUDED.stock_quantity,
         stock_min_alert = EXCLUDED.stock_min_alert,
         active          = EXCLUDED.active,
         updated_at      = NOW()`,
      [
        variant.id, variant.productId, variant.name,
        JSON.stringify(variant.attributes), variant.sku,
        variant.priceOverride, variant.stockQuantity,
        variant.stockMinAlert, variant.active,
      ],
    );
  }

  async create(input: CreateProductVariantInput): Promise<ProductVariant> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO product_variants (
         id, product_id, name, attributes, sku,
         price_override, stock_quantity, stock_min_alert
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        id,
        input.productId,
        input.name,
        JSON.stringify(input.attributes ?? {}),
        input.sku          ?? null,
        input.priceOverride ?? null,
        input.stockQuantity ?? 0,
        input.stockMinAlert ?? 0,
      ],
    );
    return rowToVariant(rows[0]!);
  }

  async update(id: string, input: UpdateProductVariantInput): Promise<ProductVariant | undefined> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.name          !== undefined) { fields.push(`name = $${idx++}`);            params.push(input.name); }
    if (input.attributes    !== undefined) { fields.push(`attributes = $${idx++}`);       params.push(JSON.stringify(input.attributes)); }
    if (input.sku           !== undefined) { fields.push(`sku = $${idx++}`);              params.push(input.sku); }
    if (input.priceOverride !== undefined) { fields.push(`price_override = $${idx++}`);   params.push(input.priceOverride); }
    if (input.stockQuantity !== undefined) { fields.push(`stock_quantity = $${idx++}`);   params.push(input.stockQuantity); }
    if (input.stockMinAlert !== undefined) { fields.push(`stock_min_alert = $${idx++}`);  params.push(input.stockMinAlert); }
    if (input.active        !== undefined) { fields.push(`active = $${idx++}`);           params.push(input.active); }

    if (fields.length === 0) return this.getById(id);

    fields.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE product_variants SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    return rows[0] ? rowToVariant(rows[0]) : undefined;
  }

  async decrementStock(client: SqlClient, variantId: string, quantity: number): Promise<void> {
    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE product_variants
       SET stock_quantity = stock_quantity - $1,
           updated_at     = NOW()
       WHERE id = $2
         AND stock_quantity >= $1
       RETURNING id`,
      [quantity, variantId],
    );
    if (!rows[0]) {
      throw new Error(`Stock insuficiente en variante (id=${variantId}).`);
    }
  }

  async incrementStock(client: SqlClient, variantId: string, quantity: number): Promise<void> {
    await client.query(
      `UPDATE product_variants
       SET stock_quantity = stock_quantity + $1,
           updated_at     = NOW()
       WHERE id = $2`,
      [quantity, variantId],
    );
  }

  async delete(id: string): Promise<boolean> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE product_variants SET active = false, updated_at = NOW()
       WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }
}
