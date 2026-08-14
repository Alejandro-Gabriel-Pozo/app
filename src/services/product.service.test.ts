import { describe, it, expect, beforeEach } from 'vitest';
import { ProductService } from './product.service.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type {
  IProductRepository,
  IProductVariantRepository,
  ListProductsFilter,
  ListVariantsFilter,
} from '../repositories/product.repository.js';
import type {
  Product,
  ProductVariant,
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from '../domain/product.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';

/**
 * Fakes mínimos — no hay InMemoryProductRepository en el repo todavía.
 * Alcanza con esto para probar el wiring de auditoría de ProductService,
 * sin depender de una BD. decrementStock/incrementStock no se ejercitan
 * en estos tests (son de otro flujo, ver order.service.test.ts).
 */
class FakeProductRepository implements IProductRepository {
  private readonly rows = new Map<string, Product>();

  seed(p: Product): void {
    this.rows.set(p.id, p);
  }

  async getById(id: string): Promise<Product | undefined> {
    return this.rows.get(id);
  }

  async getAll(_filter: ListProductsFilter): Promise<Product[]> {
    return [...this.rows.values()];
  }

  async getBySku(): Promise<Product | undefined> {
    return undefined;
  }

  async save(product: Product): Promise<void> {
    this.rows.set(product.id, product);
  }

  async create(input: CreateProductInput): Promise<Product> {
    const now = new Date();
    const product: Product = {
      id: `prod-${this.rows.size + 1}`,
      businessId: input.businessId,
      categoryId: input.categoryId ?? null,
      name: input.name,
      description: input.description ?? null,
      basePrice: input.basePrice,
      sku: input.sku ?? null,
      hasVariants: input.hasVariants ?? false,
      stockQuantity: input.stockQuantity ?? 0,
      stockMinAlert: input.stockMinAlert ?? 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(product.id, product);
    return product;
  }

  async update(id: string, input: UpdateProductInput): Promise<Product | undefined> {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const updated: Product = { ...current, ...input, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async decrementStock(_client: SqlClient, _productId: string, _quantity: number): Promise<void> {}
  async incrementStock(_client: SqlClient, _productId: string, _quantity: number): Promise<void> {}

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

class FakeProductVariantRepository implements IProductVariantRepository {
  private readonly rows = new Map<string, ProductVariant>();

  seed(v: ProductVariant): void {
    this.rows.set(v.id, v);
  }

  async getById(id: string): Promise<ProductVariant | undefined> {
    return this.rows.get(id);
  }

  async getByProduct(_filter: ListVariantsFilter): Promise<ProductVariant[]> {
    return [...this.rows.values()];
  }

  async getBySku(): Promise<ProductVariant | undefined> {
    return undefined;
  }

  async save(variant: ProductVariant): Promise<void> {
    this.rows.set(variant.id, variant);
  }

  async create(input: CreateProductVariantInput): Promise<ProductVariant> {
    const now = new Date();
    const variant: ProductVariant = {
      id: `var-${this.rows.size + 1}`,
      productId: input.productId,
      name: input.name,
      attributes: input.attributes ?? {},
      sku: input.sku ?? null,
      priceOverride: input.priceOverride ?? null,
      stockQuantity: input.stockQuantity ?? 0,
      stockMinAlert: input.stockMinAlert ?? 0,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(variant.id, variant);
    return variant;
  }

  async update(id: string, input: UpdateProductVariantInput): Promise<ProductVariant | undefined> {
    const current = this.rows.get(id);
    if (!current) return undefined;
    const updated: ProductVariant = { ...current, ...input, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }

  async decrementStock(_client: SqlClient, _variantId: string, _quantity: number): Promise<void> {}
  async incrementStock(_client: SqlClient, _variantId: string, _quantity: number): Promise<void> {}

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }
}

describe('ProductService — auditoría (R8/A9.4)', () => {
  let productRepo: FakeProductRepository;
  let variantRepo: FakeProductVariantRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: ProductService;

  beforeEach(() => {
    productRepo = new FakeProductRepository();
    variantRepo = new FakeProductVariantRepository();
    auditRepo   = new InMemoryAuditLogRepository();
    service     = new ProductService(productRepo, variantRepo, auditRepo);

    const now = new Date();
    productRepo.seed({
      id: 'prod-1',
      businessId: 'biz-1',
      categoryId: null,
      name: 'Coca-Cola 500ml',
      description: null,
      basePrice: 100,
      sku: 'COCA-500',
      hasVariants: false,
      stockQuantity: 10,
      stockMinAlert: 2,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    variantRepo.seed({
      id: 'var-1',
      productId: 'prod-1',
      name: 'Talle M',
      attributes: { talle: 'M' },
      sku: null,
      priceOverride: null,
      stockQuantity: 5,
      stockMinAlert: 1,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('audita un cambio de basePrice — el escenario que motivó R8', async () => {
    await service.updateProduct('prod-1', { basePrice: 150 }, 'identity-1');

    const entries = await auditRepo.findByEntity('products', 'prod-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field: 'basePrice',
      oldValue: '100',
      newValue: '150',
      changedBy: 'identity-1',
    });
  });

  it('no audita nada si updateProduct no encuentra el producto', async () => {
    const result = await service.updateProduct('prod-inexistente', { basePrice: 1 }, 'identity-1');
    expect(result).toBeNull();
    expect(auditRepo.all()).toHaveLength(0);
  });

  it('audita priceOverride de una variante (NULL → valor)', async () => {
    await service.updateVariant('var-1', { priceOverride: 120 }, 'identity-1');

    const entries = await auditRepo.findByEntity('product_variants', 'var-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field: 'priceOverride',
      oldValue: null,
      newValue: '120',
      changedBy: 'identity-1',
    });
  });

  it('no registra un campo que se "actualiza" al mismo valor', async () => {
    await service.updateProduct('prod-1', { basePrice: 100 }, 'identity-1');
    expect(auditRepo.all()).toHaveLength(0);
  });
});
