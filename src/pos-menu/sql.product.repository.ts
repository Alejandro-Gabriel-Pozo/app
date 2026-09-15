// =============================================================================
// repositories/sql.product.repository.ts — Implementación PostgreSQL
// Usa SqlClient.query(sql, params) — compatible con pg (node-postgres).
// NO usa tagged templates ni APIs de postgres.js (.unsafe, .json, etc.).
//
// Fase 1 del carve-out de inventario (16/08/2026): sin métodos de stock —
// stock_quantity/reserved_quantity/stock_min_alert ya no viven en products/
// product_variants, ver repositories/sql.inventory-level.repository.ts.
// =============================================================================

import { randomUUID } from 'crypto';
import type { SqlClient } from '../repositories/sql.client.js';
import type {
  IProductRepository,
  IProductVariantRepository,
  ListProductsFilter,
  ListVariantsFilter,
  CompanySyncStatePatch,
} from './product.repository.js';
import type {
  Product,
  ProductVariant,
  ProductType,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from './product.entities.js';

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
    active:        Boolean(row['active']),
    productType:      row['product_type'] as ProductType,
    assembleOnDemand: Boolean(row['assemble_on_demand']),
    companyProductId:            (row['company_product_id'] as string | null) ?? null,
    priceOverrideStatus:         row['price_override_status'] as Product['priceOverrideStatus'],
    pricePendingMasterValue:     row['price_pending_master_value'] != null ? Number(row['price_pending_master_value']) : null,
    recipeOverrideStatus:        row['recipe_override_status'] as Product['recipeOverrideStatus'],
    recipePendingMasterSnapshot: (row['recipe_pending_master_snapshot'] as Product['recipePendingMasterSnapshot']) ?? null,
    ivaRate:       row['iva_rate'] != null ? Number(row['iva_rate']) : null,
    unit:          (row['unit'] as string | null) ?? null,
    arcaUnitCode:  row['arca_unit_code'] != null ? Number(row['arca_unit_code']) : null,
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

    // Desempate explícito (D-14, 15/09/2026,
    // docs/decisiones-auditoria-fase2-2026-09-15.md #12, `, id ASC`) --
    // sin él, dos productos con el mismo name pueden aparecer duplicados o
    // faltar entre páginas.
    const sql = `
      SELECT * FROM products
      WHERE ${conditions.join(' AND ')}
      ORDER BY name ASC, id ASC
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
         base_price, sku, has_variants, active, product_type, assemble_on_demand,
         company_product_id, price_override_status, price_pending_master_value,
         recipe_override_status, recipe_pending_master_snapshot,
         iva_rate, unit, arca_unit_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (id) DO UPDATE SET
         category_id                    = EXCLUDED.category_id,
         name                           = EXCLUDED.name,
         description                    = EXCLUDED.description,
         base_price                     = EXCLUDED.base_price,
         sku                            = EXCLUDED.sku,
         has_variants                   = EXCLUDED.has_variants,
         active                         = EXCLUDED.active,
         product_type                   = EXCLUDED.product_type,
         assemble_on_demand             = EXCLUDED.assemble_on_demand,
         company_product_id             = EXCLUDED.company_product_id,
         price_override_status          = EXCLUDED.price_override_status,
         price_pending_master_value     = EXCLUDED.price_pending_master_value,
         recipe_override_status         = EXCLUDED.recipe_override_status,
         recipe_pending_master_snapshot = EXCLUDED.recipe_pending_master_snapshot,
         iva_rate                       = EXCLUDED.iva_rate,
         unit                           = EXCLUDED.unit,
         arca_unit_code                 = EXCLUDED.arca_unit_code,
         updated_at                     = NOW()`,
      [
        product.id, product.businessId, product.categoryId,
        product.name, product.description, product.basePrice,
        product.sku, product.hasVariants, product.active,
        product.productType, product.assembleOnDemand,
        product.companyProductId, product.priceOverrideStatus, product.pricePendingMasterValue,
        product.recipeOverrideStatus,
        product.recipePendingMasterSnapshot !== null ? JSON.stringify(product.recipePendingMasterSnapshot) : null,
        product.ivaRate, product.unit, product.arcaUnitCode,
      ],
    );
  }

  async create(input: CreateProductInput): Promise<Product> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO products (
         id, business_id, category_id, name, description,
         base_price, sku, has_variants, product_type, assemble_on_demand,
         iva_rate, unit, arca_unit_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
        input.productType ?? 'RETAIL',
        input.assembleOnDemand ?? false,
        input.ivaRate ?? null,
        input.unit ?? null,
        input.arcaUnitCode ?? null,
      ],
    );
    return rowToProduct(rows[0]!);
  }

  async update(id: string, input: UpdateProductInput): Promise<Product | undefined> {
    return this.updateWith(this.db, id, input);
  }

  async updateWithClient(client: SqlClient, id: string, input: UpdateProductInput): Promise<Product | undefined> {
    return this.updateWith(client, id, input);
  }

  private async updateWith(client: SqlClient, id: string, input: UpdateProductInput): Promise<Product | undefined> {
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
      ['active',        'active'],
      ['productType',       'product_type'],
      ['assembleOnDemand',  'assemble_on_demand'],
      ['ivaRate',       'iva_rate'],
      ['unit',          'unit'],
      ['arcaUnitCode',  'arca_unit_code'],
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

    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE products SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    return rows[0] ? rowToProduct(rows[0]) : undefined;
  }

  /** Empresas multipropiedad (17/08/2026) — ver comentario del tipo en product.repository.ts. */
  async updateCompanySyncState(id: string, patch: CompanySyncStatePatch): Promise<void> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    const map: Array<[keyof CompanySyncStatePatch, string]> = [
      ['companyProductId',            'company_product_id'],
      ['basePrice',                   'base_price'],
      ['priceOverrideStatus',         'price_override_status'],
      ['pricePendingMasterValue',     'price_pending_master_value'],
      ['recipeOverrideStatus',        'recipe_override_status'],
      ['recipePendingMasterSnapshot', 'recipe_pending_master_snapshot'],
    ];

    for (const [key, col] of map) {
      if (patch[key] !== undefined) {
        fields.push(`${col} = $${idx++}`);
        params.push(
          key === 'recipePendingMasterSnapshot' && patch[key] !== null
            ? JSON.stringify(patch[key])
            : (patch[key] as unknown),
        );
      }
    }

    if (fields.length === 0) return;

    fields.push('updated_at = NOW()');
    params.push(id);

    await this.db.query(`UPDATE products SET ${fields.join(', ')} WHERE id = $${idx}`, params);
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
         id, product_id, name, attributes, sku, price_override, active
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         name            = EXCLUDED.name,
         attributes      = EXCLUDED.attributes,
         sku             = EXCLUDED.sku,
         price_override  = EXCLUDED.price_override,
         active          = EXCLUDED.active,
         updated_at      = NOW()`,
      [
        variant.id, variant.productId, variant.name,
        JSON.stringify(variant.attributes), variant.sku,
        variant.priceOverride, variant.active,
      ],
    );
  }

  async create(input: CreateProductVariantInput): Promise<ProductVariant> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO product_variants (
         id, product_id, name, attributes, sku, price_override
       ) VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        id,
        input.productId,
        input.name,
        JSON.stringify(input.attributes ?? {}),
        input.sku          ?? null,
        input.priceOverride ?? null,
      ],
    );
    return rowToVariant(rows[0]!);
  }

  async update(id: string, input: UpdateProductVariantInput): Promise<ProductVariant | undefined> {
    return this.updateWith(this.db, id, input);
  }

  async updateWithClient(client: SqlClient, id: string, input: UpdateProductVariantInput): Promise<ProductVariant | undefined> {
    return this.updateWith(client, id, input);
  }

  private async updateWith(client: SqlClient, id: string, input: UpdateProductVariantInput): Promise<ProductVariant | undefined> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.name          !== undefined) { fields.push(`name = $${idx++}`);            params.push(input.name); }
    if (input.attributes    !== undefined) { fields.push(`attributes = $${idx++}`);       params.push(JSON.stringify(input.attributes)); }
    if (input.sku           !== undefined) { fields.push(`sku = $${idx++}`);              params.push(input.sku); }
    if (input.priceOverride !== undefined) { fields.push(`price_override = $${idx++}`);   params.push(input.priceOverride); }
    if (input.active        !== undefined) { fields.push(`active = $${idx++}`);           params.push(input.active); }

    if (fields.length === 0) return this.getById(id);

    fields.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await client.query<Record<string, unknown>>(
      `UPDATE product_variants SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      params,
    );
    return rows[0] ? rowToVariant(rows[0]) : undefined;
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
