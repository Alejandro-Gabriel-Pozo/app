import { describe, it, expect, beforeEach } from 'vitest';
import { ProductService } from './product.service.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import { InMemoryInventoryLevelRepository } from '../repositories/in-memory.inventory-level.repository.js';
import { ProductHasStockError } from '../domain/errors.js';
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
  CreateProductInput,
  UpdateProductInput,
  CreateProductVariantInput,
  UpdateProductVariantInput,
} from './product.entities.js';

/**
 * Fakes mínimos — no hay InMemoryProductRepository en el repo todavía.
 * Alcanza con esto para probar el wiring de auditoría de ProductService,
 * sin depender de una BD. Fase 1 del carve-out de inventario (16/08/2026):
 * ya no cargan stock — eso vive en InMemoryInventoryLevelRepository, ver
 * inventory.handlers.test.ts para los tests que sí ejercitan ese flujo.
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
      productType: input.productType ?? 'RETAIL',
      assembleOnDemand: input.assembleOnDemand ?? false,
      companyProductId: null,
      priceOverrideStatus: 'INACTIVO',
      pricePendingMasterValue: null,
      recipeOverrideStatus: 'INACTIVO',
      recipePendingMasterSnapshot: null,
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

  async updateCompanySyncState(id: string, patch: CompanySyncStatePatch): Promise<void> {
    const current = this.rows.get(id);
    if (current) this.rows.set(id, { ...current, ...patch });
  }

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
    service     = new ProductService(productRepo, variantRepo, auditRepo, new InMemoryInventoryLevelRepository());

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
      productType: 'RETAIL',
      assembleOnDemand: false,
      companyProductId: null,
      priceOverrideStatus: 'INACTIVO',
      pricePendingMasterValue: null,
      recipeOverrideStatus: 'INACTIVO',
      recipePendingMasterSnapshot: null,
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

describe('ProductService — bloqueo de desactivación por stock físico (17/08/2026, diseno-empresas-multipropiedad.md decisión 4)', () => {
  let productRepo: FakeProductRepository;
  let variantRepo: FakeProductVariantRepository;
  let inventoryLevelRepo: InMemoryInventoryLevelRepository;
  let service: ProductService;

  beforeEach(() => {
    productRepo        = new FakeProductRepository();
    variantRepo         = new FakeProductVariantRepository();
    inventoryLevelRepo  = new InMemoryInventoryLevelRepository();
    service             = new ProductService(productRepo, variantRepo, new InMemoryAuditLogRepository(), inventoryLevelRepo);

    const now = new Date();
    productRepo.seed({
      id: 'prod-simple', businessId: 'biz-1', categoryId: null, name: 'Simple',
      description: null, basePrice: 10, sku: null, hasVariants: false,
      productType: 'RETAIL', assembleOnDemand: false,
      companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
      recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
      active: true, createdAt: now, updatedAt: now,
    });
    productRepo.seed({
      id: 'prod-con-variantes', businessId: 'biz-1', categoryId: null, name: 'Con variantes',
      description: null, basePrice: 10, sku: null, hasVariants: true,
      productType: 'RETAIL', assembleOnDemand: false,
      companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
      recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
      active: true, createdAt: now, updatedAt: now,
    });
    variantRepo.seed({
      id: 'var-a', productId: 'prod-con-variantes', name: 'A', attributes: {}, sku: null,
      priceOverride: null, active: true, createdAt: now, updatedAt: now,
    });
    variantRepo.seed({
      id: 'var-b', productId: 'prod-con-variantes', name: 'B', attributes: {}, sku: null,
      priceOverride: null, active: true, createdAt: now, updatedAt: now,
    });
  });

  it('deleteProduct(): permite desactivar un producto simple sin stock', async () => {
    inventoryLevelRepo.seed({
      id: 'lvl-1', businessId: 'biz-1', productId: 'prod-simple', productVariantId: null,
      locationId: 'loc-default', stockQuantity: 0, reservedQuantity: 0, stockMinAlert: 0,
    });

    await expect(service.deleteProduct('prod-simple')).resolves.toBeUndefined();
  });

  it('deleteProduct(): bloquea un producto simple con stock físico > 0, aunque esté todo disponible', async () => {
    inventoryLevelRepo.seed({
      id: 'lvl-1', businessId: 'biz-1', productId: 'prod-simple', productVariantId: null,
      locationId: 'loc-default', stockQuantity: 5, reservedQuantity: 0, stockMinAlert: 0,
    });

    await expect(service.deleteProduct('prod-simple')).rejects.toBeInstanceOf(ProductHasStockError);
  });

  it('deleteProduct(): suma el stock físico de TODAS las ubicaciones, no solo una', async () => {
    inventoryLevelRepo.seed({
      id: 'lvl-1', businessId: 'biz-1', productId: 'prod-simple', productVariantId: null,
      locationId: 'loc-a', stockQuantity: 0, reservedQuantity: 0, stockMinAlert: 0,
    });
    inventoryLevelRepo.seed({
      id: 'lvl-2', businessId: 'biz-1', productId: 'prod-simple', productVariantId: null,
      locationId: 'loc-b', stockQuantity: 3, reservedQuantity: 0, stockMinAlert: 0,
    });

    await expect(service.deleteProduct('prod-simple')).rejects.toBeInstanceOf(ProductHasStockError);
  });

  it('deleteProduct() con hasVariants=true: bloquea si CUALQUIER variante tiene stock', async () => {
    inventoryLevelRepo.seed({
      id: 'lvl-a', businessId: 'biz-1', productId: null, productVariantId: 'var-a',
      locationId: 'loc-default', stockQuantity: 0, reservedQuantity: 0, stockMinAlert: 0,
    });
    inventoryLevelRepo.seed({
      id: 'lvl-b', businessId: 'biz-1', productId: null, productVariantId: 'var-b',
      locationId: 'loc-default', stockQuantity: 2, reservedQuantity: 0, stockMinAlert: 0,
    });

    await expect(service.deleteProduct('prod-con-variantes')).rejects.toBeInstanceOf(ProductHasStockError);
  });

  it('deleteProduct() con hasVariants=true: permite desactivar si NINGUNA variante tiene stock', async () => {
    inventoryLevelRepo.seed({
      id: 'lvl-a', businessId: 'biz-1', productId: null, productVariantId: 'var-a',
      locationId: 'loc-default', stockQuantity: 0, reservedQuantity: 0, stockMinAlert: 0,
    });

    await expect(service.deleteProduct('prod-con-variantes')).resolves.toBeUndefined();
  });

  it('deleteProduct(): no-opea silenciosamente si el producto no existe (mismo criterio de siempre)', async () => {
    await expect(service.deleteProduct('no-existe')).resolves.toBeUndefined();
  });

  it('deleteVariant(): bloquea con stock físico > 0', async () => {
    inventoryLevelRepo.seed({
      id: 'lvl-a', businessId: 'biz-1', productId: null, productVariantId: 'var-a',
      locationId: 'loc-default', stockQuantity: 1, reservedQuantity: 0, stockMinAlert: 0,
    });

    await expect(service.deleteVariant('var-a')).rejects.toBeInstanceOf(ProductHasStockError);
  });

  it('deleteVariant(): stock DISPONIBLE (no reservado) no importa -- lo que bloquea es el físico', async () => {
    // stock=4, reservado=4 -> disponible=0, pero físico sigue siendo 4.
    inventoryLevelRepo.seed({
      id: 'lvl-a', businessId: 'biz-1', productId: null, productVariantId: 'var-a',
      locationId: 'loc-default', stockQuantity: 4, reservedQuantity: 4, stockMinAlert: 0,
    });

    await expect(service.deleteVariant('var-a')).rejects.toBeInstanceOf(ProductHasStockError);
  });

  it('deleteVariant(): permite desactivar sin stock', async () => {
    await expect(service.deleteVariant('var-a')).resolves.toBeUndefined();
  });
});
