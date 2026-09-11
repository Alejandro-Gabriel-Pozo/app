import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CompanyCatalogService } from './company-catalog.service.js';

const wakeCompanySyncWorkerMock = vi.fn();
vi.mock('../platform/company-sync.registry.js', () => ({
  wakeCompanySyncWorker: () => wakeCompanySyncWorkerMock(),
}));
import type { ICompanyCatalogRepository, IBusinessDirectory } from './company-catalog.service.js';
import { ProductNotFoundError } from './product.service.js';
import {
  BusinessNotInCompanyError,
  ProductNotSharedError,
  InvalidOverrideTransitionError,
  CompanyProductNotFoundError,
} from '../domain/errors.js';
import type { CompanyProduct, CompanyRecipeItem } from '../platform/company.repository.js';
import type { IProductRepository, CompanySyncStatePatch, ListProductsFilter } from './product.repository.js';
import type {
  Product,
  CreateProductInput,
  UpdateProductInput,
} from './product.entities.js';
import type {
  RecipeItemRepository,
  RecipeItem,
  CreateRecipeItemInput,
  UpdateRecipeItemInput,
} from '../repositories/recipe-item.repository.js';

/** Fake mínimo de IProductRepository -- mismo criterio que product.service.test.ts. */
class FakeProductRepository implements IProductRepository {
  private readonly rows = new Map<string, Product>();

  seed(p: Product): void { this.rows.set(p.id, p); }

  async getById(id: string): Promise<Product | undefined> { return this.rows.get(id); }
  async getAll(_filter: ListProductsFilter): Promise<Product[]> { return [...this.rows.values()]; }
  async getBySku(): Promise<Product | undefined> { return undefined; }
  async save(product: Product): Promise<void> { this.rows.set(product.id, product); }
  async create(_input: CreateProductInput): Promise<Product> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateProductInput): Promise<Product | undefined> { return undefined; }
  async updateCompanySyncState(id: string, patch: CompanySyncStatePatch): Promise<void> {
    const current = this.rows.get(id);
    if (current) this.rows.set(id, { ...current, ...patch });
  }
  async delete(_id: string): Promise<boolean> { return false; }
}

/** Fake en memoria de RecipeItemRepository -- solo lo que este servicio usa (getByParent/replaceForParent). */
class FakeRecipeItemRepository implements RecipeItemRepository {
  private readonly byParent = new Map<string, RecipeItem[]>();

  seed(parentProductId: string, items: Array<{ componentProductId: string; quantityPerUnit: number }>): void {
    const now = new Date();
    this.byParent.set(parentProductId, items.map((i) => ({
      id: `ri-${parentProductId}-${i.componentProductId}`,
      parentProductId,
      componentProductId: i.componentProductId,
      componentVariantId: null,
      quantityPerUnit: i.quantityPerUnit,
      costPerUnit: null,
      yieldPercentage: null,
      createdAt: now,
      updatedAt: now,
    })));
  }

  async getByParent(parentProductId: string): Promise<RecipeItem[]> { return this.byParent.get(parentProductId) ?? []; }
  async getById(_id: string): Promise<RecipeItem | null> { return null; }
  async create(_input: CreateRecipeItemInput): Promise<RecipeItem> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateRecipeItemInput): Promise<RecipeItem> { throw new Error('no usado en estos tests'); }
  async delete(_id: string): Promise<boolean> { return false; }

  async replaceForParent(parentProductId: string, items: Array<{ componentProductId: string; quantityPerUnit: number }>): Promise<void> {
    this.seed(parentProductId, items);
  }

  async wouldCreateCycle(): Promise<boolean> { return false; }
}

/** Fake en memoria de ICompanyCatalogRepository. */
class FakeCompanyCatalogRepository implements ICompanyCatalogRepository {
  public readonly products = new Map<string, CompanyProduct>();
  public readonly recipes = new Map<string, CompanyRecipeItem[]>();
  public readonly propagationCalls: Array<{ companyProductId: string; targetBusinessIds: string[] }> = [];

  async upsertCompanyProduct(input: { id: string; companyId: string; name: string; basePrice: number; sku: string | null }): Promise<CompanyProduct> {
    const product: CompanyProduct = { ...input, updatedAt: new Date() };
    this.products.set(input.id, product);
    return product;
  }

  async getCompanyProduct(id: string): Promise<CompanyProduct | undefined> {
    return this.products.get(id);
  }

  async getCompanyProductsByCompany(companyId: string): Promise<CompanyProduct[]> {
    return [...this.products.values()].filter((p) => p.companyId === companyId);
  }

  async getCompanyRecipeItems(companyProductId: string): Promise<CompanyRecipeItem[]> {
    return this.recipes.get(companyProductId) ?? [];
  }

  async replaceCompanyRecipeItems(companyProductId: string, items: Array<{ componentProductId: string; quantityPerUnit: number }>): Promise<void> {
    const now = new Date();
    this.recipes.set(companyProductId, items.map((i) => ({
      id: `cri-${companyProductId}-${i.componentProductId}`,
      companyProductId,
      componentProductId: i.componentProductId,
      quantityPerUnit: i.quantityPerUnit,
      createdAt: now,
      updatedAt: now,
    })));
  }

  async enqueuePropagation(companyProductId: string, targetBusinessIds: string[]): Promise<void> {
    this.propagationCalls.push({ companyProductId, targetBusinessIds });
  }
}

/** Fake en memoria de IBusinessDirectory. */
class FakeBusinessDirectory implements IBusinessDirectory {
  private readonly businesses = new Map<string, { id: string; companyId: string | null }>();

  seed(id: string, companyId: string | null): void { this.businesses.set(id, { id, companyId }); }

  async findById(id: string): Promise<{ id: string; companyId: string | null } | undefined> {
    return this.businesses.get(id);
  }

  async findBusinessesByCompanyId(companyId: string): Promise<Array<{ id: string }>> {
    return [...this.businesses.values()].filter((b) => b.companyId === companyId).map((b) => ({ id: b.id }));
  }
}

function makeProduct(overrides: Partial<Product> = {}): Product {
  const now = new Date();
  return {
    id: 'prod-1', businessId: 'biz-a', categoryId: null, name: 'Masaje', description: null,
    basePrice: 5000, sku: null, hasVariants: false, active: true,
    productType: 'RETAIL', assembleOnDemand: false,
    companyProductId: null, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null,
    recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null,
    ivaRate: null, unit: null, arcaUnitCode: null,
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe('CompanyCatalogService', () => {
  let productRepo: FakeProductRepository;
  let recipeItemRepo: FakeRecipeItemRepository;
  let companyRepo: FakeCompanyCatalogRepository;
  let businessDirectory: FakeBusinessDirectory;
  let service: CompanyCatalogService;

  beforeEach(() => {
    vi.clearAllMocks();
    productRepo = new FakeProductRepository();
    recipeItemRepo = new FakeRecipeItemRepository();
    companyRepo = new FakeCompanyCatalogRepository();
    businessDirectory = new FakeBusinessDirectory();
    service = new CompanyCatalogService(productRepo, recipeItemRepo, companyRepo, businessDirectory);

    businessDirectory.seed('biz-a', 'company-1');
    businessDirectory.seed('biz-b', 'company-1');
    businessDirectory.seed('biz-c', 'company-1');
    businessDirectory.seed('biz-solo', null);
  });

  describe('listCompanyCatalog()', () => {
    it('devuelve [] si el negocio no tiene empresa', async () => {
      await expect(service.listCompanyCatalog('biz-solo')).resolves.toEqual([]);
    });

    it('devuelve el catálogo canónico completo de la empresa del negocio', async () => {
      await companyRepo.upsertCompanyProduct({ id: 'prod-1', companyId: 'company-1', name: 'Jamón', basePrice: 100, sku: null });
      await companyRepo.upsertCompanyProduct({ id: 'prod-2', companyId: 'company-1', name: 'Queso', basePrice: 200, sku: null });
      await companyRepo.upsertCompanyProduct({ id: 'prod-otra-empresa', companyId: 'company-2', name: 'Otro', basePrice: 1, sku: null });

      const catalog = await service.listCompanyCatalog('biz-a');

      expect(catalog.map((p) => p.id).sort()).toEqual(['prod-1', 'prod-2']);
    });
  });

  describe('createLinkedProduct()', () => {
    it('lanza CompanyProductNotFoundError si el canónico no existe', async () => {
      await expect(service.createLinkedProduct('biz-a', 'no-existe')).rejects.toBeInstanceOf(CompanyProductNotFoundError);
    });

    it('lanza BusinessNotInCompanyError si el negocio no pertenece a la empresa del canónico', async () => {
      await companyRepo.upsertCompanyProduct({ id: 'prod-1', companyId: 'company-1', name: 'Jamón', basePrice: 100, sku: null });
      await expect(service.createLinkedProduct('biz-solo', 'prod-1')).rejects.toBeInstanceOf(BusinessNotInCompanyError);
    });

    it('crea la fila local con el MISMO id que el canónico', async () => {
      await companyRepo.upsertCompanyProduct({ id: 'prod-1', companyId: 'company-1', name: 'Jamón', basePrice: 100, sku: 'JAM' });

      const result = await service.createLinkedProduct('biz-a', 'prod-1');

      expect(result).toMatchObject({ id: 'prod-1', name: 'Jamón', basePrice: 100, sku: 'JAM', companyProductId: 'prod-1' });
    });

    it('materializa la receta canónica local si el producto ya tiene una', async () => {
      await companyRepo.upsertCompanyProduct({ id: 'prod-1', companyId: 'company-1', name: 'Combo', basePrice: 100, sku: null });
      await companyRepo.replaceCompanyRecipeItems('prod-1', [{ componentProductId: 'comp-1', quantityPerUnit: 2 }]);

      await service.createLinkedProduct('biz-a', 'prod-1');

      const localRecipe = await recipeItemRepo.getByParent('prod-1');
      expect(localRecipe).toHaveLength(1);
      expect(localRecipe[0]).toMatchObject({ componentProductId: 'comp-1', quantityPerUnit: 2 });
    });

    it('es idempotente: si ya está vinculado localmente, no-opea y devuelve el existente', async () => {
      const existing = makeProduct({ id: 'prod-1', companyProductId: 'prod-1' });
      productRepo.seed(existing);

      const result = await service.createLinkedProduct('biz-a', 'prod-1');

      expect(result).toEqual(existing);
    });
  });

  describe('autoShareIfLinked()', () => {
    it('no-opea silenciosamente si el negocio no tiene empresa', async () => {
      productRepo.seed(makeProduct({ id: 'prod-1', businessId: 'biz-solo' }));

      await service.autoShareIfLinked('biz-solo', 'prod-1');

      expect(await companyRepo.getCompanyProduct('prod-1')).toBeUndefined();
      expect(companyRepo.propagationCalls).toHaveLength(0);
      expect(wakeCompanySyncWorkerMock).not.toHaveBeenCalled();
    });

    it('sube el producto nuevo al catálogo canónico y propaga a las sucursales hermanas', async () => {
      productRepo.seed(makeProduct({ id: 'prod-1', businessId: 'biz-a' }));

      await service.autoShareIfLinked('biz-a', 'prod-1');

      const canon = await companyRepo.getCompanyProduct('prod-1');
      expect(canon).toMatchObject({ id: 'prod-1', companyId: 'company-1', name: 'Masaje', basePrice: 5000 });
      expect(companyRepo.propagationCalls).toHaveLength(1);
      expect(companyRepo.propagationCalls[0]!.targetBusinessIds.sort()).toEqual(['biz-b', 'biz-c']);

      const local = await productRepo.getById('prod-1');
      expect(local?.companyProductId).toBe('prod-1');

      // Despierta el worker de propagación de inmediato -- si no,
      // esperaría hasta idleIntervalMs (docs/diseno-polling-adaptativo-neon-2026-09-10.md §3.1).
      expect(wakeCompanySyncWorkerMock).toHaveBeenCalledOnce();
    });

    it('sin sucursales hermanas (única en su empresa), NO despierta el worker -- no hay nada que propagar', async () => {
      businessDirectory.seed('biz-unica', 'company-sola');
      productRepo.seed(makeProduct({ id: 'prod-1', businessId: 'biz-unica' }));

      await service.autoShareIfLinked('biz-unica', 'prod-1');

      expect(companyRepo.propagationCalls).toHaveLength(0);
      expect(wakeCompanySyncWorkerMock).not.toHaveBeenCalled();
    });
  });

  describe('shareProduct()', () => {
    it('lanza ProductNotFoundError si el producto no existe', async () => {
      await expect(service.shareProduct('biz-a', 'no-existe')).rejects.toBeInstanceOf(ProductNotFoundError);
    });

    it('lanza BusinessNotInCompanyError si el negocio no tiene company_id', async () => {
      productRepo.seed(makeProduct({ id: 'prod-1', businessId: 'biz-solo' }));
      await expect(service.shareProduct('biz-solo', 'prod-1')).rejects.toBeInstanceOf(BusinessNotInCompanyError);
    });

    it('crea el company_product canónico con la identidad/precio actuales', async () => {
      productRepo.seed(makeProduct());

      await service.shareProduct('biz-a', 'prod-1');

      const canon = await companyRepo.getCompanyProduct('prod-1');
      expect(canon).toMatchObject({ id: 'prod-1', companyId: 'company-1', name: 'Masaje', basePrice: 5000 });
    });

    it('vincula el producto local (companyProductId = mismo id)', async () => {
      productRepo.seed(makeProduct());

      const result = await service.shareProduct('biz-a', 'prod-1');

      expect(result.companyProductId).toBe('prod-1');
    });

    it('propaga a las sucursales HERMANAS, nunca a la de origen', async () => {
      productRepo.seed(makeProduct());

      await service.shareProduct('biz-a', 'prod-1');

      expect(companyRepo.propagationCalls).toHaveLength(1);
      expect(companyRepo.propagationCalls[0]!.targetBusinessIds.sort()).toEqual(['biz-b', 'biz-c']);
      expect(wakeCompanySyncWorkerMock).toHaveBeenCalledOnce();
    });

    it('es idempotente: compartir un producto ya compartido lo re-sincroniza sin duplicar el vínculo', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1' }));

      const result = await service.shareProduct('biz-a', 'prod-1');

      expect(result.companyProductId).toBe('prod-1');
      expect(companyRepo.propagationCalls).toHaveLength(1);
    });

    it('sube también la receta local (componentes de producto, no de variante)', async () => {
      productRepo.seed(makeProduct({ productType: 'COMPOSITE' }));
      recipeItemRepo.seed('prod-1', [{ componentProductId: 'comp-1', quantityPerUnit: 3 }]);

      await service.shareProduct('biz-a', 'prod-1');

      const canonRecipe = await companyRepo.getCompanyRecipeItems('prod-1');
      expect(canonRecipe).toHaveLength(1);
      expect(canonRecipe[0]).toMatchObject({ componentProductId: 'comp-1', quantityPerUnit: 3 });
    });
  });

  describe('publishUpdate()', () => {
    it('no-opea silenciosamente si el producto no está compartido', async () => {
      productRepo.seed(makeProduct());
      await expect(service.publishUpdate('biz-a', 'prod-1')).resolves.toBeUndefined();
      expect(companyRepo.propagationCalls).toHaveLength(0);
    });

    it('publica el precio nuevo cuando el override está INACTIVO', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', basePrice: 6000, priceOverrideStatus: 'INACTIVO' }));
      await companyRepo.upsertCompanyProduct({ id: 'prod-1', companyId: 'company-1', name: 'Masaje', basePrice: 5000, sku: null });

      await service.publishUpdate('biz-a', 'prod-1');

      const canon = await companyRepo.getCompanyProduct('prod-1');
      expect(canon?.basePrice).toBe(6000);
      expect(companyRepo.propagationCalls).toHaveLength(1);
    });

    it('NO publica el precio local cuando el override está ACTIVO -- mantiene el del maestro', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', basePrice: 9999, priceOverrideStatus: 'ACTIVO' }));
      await companyRepo.upsertCompanyProduct({ id: 'prod-1', companyId: 'company-1', name: 'Masaje', basePrice: 5000, sku: null });

      await service.publishUpdate('biz-a', 'prod-1');

      const canon = await companyRepo.getCompanyProduct('prod-1');
      expect(canon?.basePrice).toBe(5000); // no 9999 -- el override local no se filtra al maestro
    });

    it('NO publica la receta local cuando el override de receta está ACTIVO -- mantiene la del maestro', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', recipeOverrideStatus: 'ACTIVO' }));
      recipeItemRepo.seed('prod-1', [{ componentProductId: 'comp-local', quantityPerUnit: 9 }]);
      await companyRepo.replaceCompanyRecipeItems('prod-1', [{ componentProductId: 'comp-maestro', quantityPerUnit: 1 }]);

      await service.publishUpdate('biz-a', 'prod-1');

      const canonRecipe = await companyRepo.getCompanyRecipeItems('prod-1');
      expect(canonRecipe).toHaveLength(1);
      expect(canonRecipe[0]).toMatchObject({ componentProductId: 'comp-maestro' });
    });
  });

  describe('acceptPriceReview() / rejectPriceReview()', () => {
    it('lanza ProductNotSharedError si el producto no está compartido', async () => {
      productRepo.seed(makeProduct());
      await expect(service.acceptPriceReview('prod-1')).rejects.toBeInstanceOf(ProductNotSharedError);
    });

    it('lanza InvalidOverrideTransitionError si no hay revisión pendiente', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', priceOverrideStatus: 'ACTIVO' }));
      await expect(service.acceptPriceReview('prod-1')).rejects.toBeInstanceOf(InvalidOverrideTransitionError);
      await expect(service.rejectPriceReview('prod-1')).rejects.toBeInstanceOf(InvalidOverrideTransitionError);
    });

    it('aceptar: adopta el valor pendiente del maestro y vuelve a INACTIVO', async () => {
      productRepo.seed(makeProduct({
        companyProductId: 'prod-1', basePrice: 5000,
        priceOverrideStatus: 'PENDIENTE_DE_REVISION', pricePendingMasterValue: 7000,
      }));

      const result = await service.acceptPriceReview('prod-1');

      expect(result).toMatchObject({ basePrice: 7000, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null });
    });

    it('rechazar: se queda con el valor local y vuelve a ACTIVO', async () => {
      productRepo.seed(makeProduct({
        companyProductId: 'prod-1', basePrice: 5000,
        priceOverrideStatus: 'PENDIENTE_DE_REVISION', pricePendingMasterValue: 7000,
      }));

      const result = await service.rejectPriceReview('prod-1');

      expect(result).toMatchObject({ basePrice: 5000, priceOverrideStatus: 'ACTIVO', pricePendingMasterValue: null });
    });
  });

  describe('activatePriceOverride() / deactivatePriceOverride()', () => {
    it('activar: pasa de INACTIVO a ACTIVO sin tocar el precio', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', basePrice: 5000, priceOverrideStatus: 'INACTIVO' }));

      const result = await service.activatePriceOverride('prod-1');

      expect(result).toMatchObject({ basePrice: 5000, priceOverrideStatus: 'ACTIVO' });
    });

    it('activar: lanza InvalidOverrideTransitionError si ya no está INACTIVO', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', priceOverrideStatus: 'ACTIVO' }));
      await expect(service.activatePriceOverride('prod-1')).rejects.toBeInstanceOf(InvalidOverrideTransitionError);
    });

    it('desactivar: relee el valor actual del maestro y lo aplica', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', basePrice: 9999, priceOverrideStatus: 'ACTIVO' }));
      await companyRepo.upsertCompanyProduct({ id: 'prod-1', companyId: 'company-1', name: 'Masaje', basePrice: 5000, sku: null });

      const result = await service.deactivatePriceOverride('prod-1');

      expect(result).toMatchObject({ basePrice: 5000, priceOverrideStatus: 'INACTIVO', pricePendingMasterValue: null });
    });

    it('desactivar: no-opea si ya estaba INACTIVO', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', basePrice: 5000, priceOverrideStatus: 'INACTIVO' }));

      const result = await service.deactivatePriceOverride('prod-1');

      expect(result.basePrice).toBe(5000);
    });
  });

  describe('acceptRecipeReview() / rejectRecipeReview()', () => {
    it('lanza ProductNotSharedError si el producto no está compartido', async () => {
      productRepo.seed(makeProduct());
      await expect(service.acceptRecipeReview('prod-1')).rejects.toBeInstanceOf(ProductNotSharedError);
    });

    it('lanza InvalidOverrideTransitionError si no hay revisión pendiente', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', recipeOverrideStatus: 'ACTIVO' }));
      await expect(service.acceptRecipeReview('prod-1')).rejects.toBeInstanceOf(InvalidOverrideTransitionError);
      await expect(service.rejectRecipeReview('prod-1')).rejects.toBeInstanceOf(InvalidOverrideTransitionError);
    });

    it('aceptar: materializa el snapshot pendiente como receta local y vuelve a INACTIVO', async () => {
      productRepo.seed(makeProduct({
        companyProductId: 'prod-1',
        recipeOverrideStatus: 'PENDIENTE_DE_REVISION',
        recipePendingMasterSnapshot: [{ componentProductId: 'comp-maestro', quantityPerUnit: 4 }],
      }));

      const result = await service.acceptRecipeReview('prod-1');

      expect(result).toMatchObject({ recipeOverrideStatus: 'INACTIVO', recipePendingMasterSnapshot: null });
      const localRecipe = await recipeItemRepo.getByParent('prod-1');
      expect(localRecipe).toHaveLength(1);
      expect(localRecipe[0]).toMatchObject({ componentProductId: 'comp-maestro', quantityPerUnit: 4 });
    });

    it('rechazar: descarta el snapshot pendiente, se queda con la receta local, vuelve a ACTIVO', async () => {
      recipeItemRepo.seed('prod-1', [{ componentProductId: 'comp-local', quantityPerUnit: 1 }]);
      productRepo.seed(makeProduct({
        companyProductId: 'prod-1',
        recipeOverrideStatus: 'PENDIENTE_DE_REVISION',
        recipePendingMasterSnapshot: [{ componentProductId: 'comp-maestro', quantityPerUnit: 4 }],
      }));

      const result = await service.rejectRecipeReview('prod-1');

      expect(result).toMatchObject({ recipeOverrideStatus: 'ACTIVO', recipePendingMasterSnapshot: null });
      const localRecipe = await recipeItemRepo.getByParent('prod-1');
      expect(localRecipe[0]).toMatchObject({ componentProductId: 'comp-local' });
    });
  });

  describe('activateRecipeOverride() / deactivateRecipeOverride()', () => {
    it('activar: pasa de INACTIVO a ACTIVO', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', recipeOverrideStatus: 'INACTIVO' }));

      const result = await service.activateRecipeOverride('prod-1');

      expect(result.recipeOverrideStatus).toBe('ACTIVO');
    });

    it('activar: lanza InvalidOverrideTransitionError si ya no está INACTIVO', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', recipeOverrideStatus: 'ACTIVO' }));
      await expect(service.activateRecipeOverride('prod-1')).rejects.toBeInstanceOf(InvalidOverrideTransitionError);
    });

    it('desactivar: relee la receta actual del maestro y la materializa local', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', recipeOverrideStatus: 'ACTIVO' }));
      recipeItemRepo.seed('prod-1', [{ componentProductId: 'comp-local', quantityPerUnit: 1 }]);
      await companyRepo.replaceCompanyRecipeItems('prod-1', [{ componentProductId: 'comp-maestro', quantityPerUnit: 2 }]);

      const result = await service.deactivateRecipeOverride('prod-1');

      expect(result.recipeOverrideStatus).toBe('INACTIVO');
      const localRecipe = await recipeItemRepo.getByParent('prod-1');
      expect(localRecipe).toHaveLength(1);
      expect(localRecipe[0]).toMatchObject({ componentProductId: 'comp-maestro', quantityPerUnit: 2 });
    });

    it('desactivar: no-opea si ya estaba INACTIVO', async () => {
      productRepo.seed(makeProduct({ companyProductId: 'prod-1', recipeOverrideStatus: 'INACTIVO' }));
      recipeItemRepo.seed('prod-1', [{ componentProductId: 'comp-local', quantityPerUnit: 1 }]);

      const result = await service.deactivateRecipeOverride('prod-1');

      expect(result.recipeOverrideStatus).toBe('INACTIVO');
      const localRecipe = await recipeItemRepo.getByParent('prod-1');
      expect(localRecipe[0]).toMatchObject({ componentProductId: 'comp-local' });
    });
  });
});
