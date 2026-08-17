import { describe, it, expect, beforeEach } from 'vitest';
import { RecipeService } from './recipe.service.js';
import { InMemoryRecipeItemRepository } from '../repositories/in-memory.recipe-item.repository.js';
import {
  ProductNotCompositeError,
  RecipeCycleError,
  RecipeNotDefinedError,
} from '../domain/errors.js';
import { ProductNotFoundError, VariantNotFoundError } from './product.service.js';
import type {
  IProductRepository,
  IProductVariantRepository,
  ListProductsFilter,
  ListVariantsFilter,
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

/** Fake mínimo — mismo criterio que product.service.test.ts/order.service.test.ts. */
class FakeProductRepository implements IProductRepository {
  private readonly rows = new Map<string, Product>();

  seed(id: string, productType: ProductType, assembleOnDemand = false): void {
    const now = new Date();
    this.rows.set(id, {
      id, businessId: 'biz-1', categoryId: null, name: id, description: null,
      basePrice: 10, sku: null, hasVariants: false, productType, assembleOnDemand,
      active: true, createdAt: now, updatedAt: now,
    });
  }

  async getById(id: string): Promise<Product | undefined> { return this.rows.get(id); }
  async getAll(_filter: ListProductsFilter): Promise<Product[]> { return [...this.rows.values()]; }
  async getBySku(): Promise<Product | undefined> { return undefined; }
  async save(_product: Product): Promise<void> {}
  async create(_input: CreateProductInput): Promise<Product> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateProductInput): Promise<Product | undefined> { return undefined; }
  async delete(_id: string): Promise<boolean> { return false; }
}

class FakeProductVariantRepository implements IProductVariantRepository {
  private readonly rows = new Map<string, ProductVariant>();

  seed(v: ProductVariant): void { this.rows.set(v.id, v); }

  async getById(id: string): Promise<ProductVariant | undefined> { return this.rows.get(id); }
  async getByProduct(_filter: ListVariantsFilter): Promise<ProductVariant[]> { return []; }
  async getBySku(): Promise<ProductVariant | undefined> { return undefined; }
  async save(_variant: ProductVariant): Promise<void> {}
  async create(_input: CreateProductVariantInput): Promise<ProductVariant> { throw new Error('no usado en estos tests'); }
  async update(_id: string, _input: UpdateProductVariantInput): Promise<ProductVariant | undefined> { return undefined; }
  async delete(_id: string): Promise<boolean> { return false; }
}

describe('RecipeService', () => {
  let productRepo: FakeProductRepository;
  let variantRepo: FakeProductVariantRepository;
  let recipeItemRepo: InMemoryRecipeItemRepository;
  let service: RecipeService;

  beforeEach(() => {
    productRepo    = new FakeProductRepository();
    variantRepo    = new FakeProductVariantRepository();
    recipeItemRepo = new InMemoryRecipeItemRepository();
    service        = new RecipeService(recipeItemRepo, productRepo, variantRepo);
  });

  describe('addRecipeItem()', () => {
    it('lanza ProductNotFoundError si el producto padre no existe', async () => {
      await expect(
        service.addRecipeItem({ parentProductId: 'no-existe', componentProductId: 'x', componentVariantId: null, quantityPerUnit: 1 }),
      ).rejects.toBeInstanceOf(ProductNotFoundError);
    });

    it('lanza ProductNotCompositeError si el padre no es COMPOSITE', async () => {
      productRepo.seed('prod-retail', 'RETAIL');
      productRepo.seed('prod-flour', 'RAW_MATERIAL');

      await expect(
        service.addRecipeItem({ parentProductId: 'prod-retail', componentProductId: 'prod-flour', componentVariantId: null, quantityPerUnit: 1 }),
      ).rejects.toBeInstanceOf(ProductNotCompositeError);
    });

    it('lanza ProductNotFoundError si el componente no existe', async () => {
      productRepo.seed('prod-pizza', 'COMPOSITE');

      await expect(
        service.addRecipeItem({ parentProductId: 'prod-pizza', componentProductId: 'no-existe', componentVariantId: null, quantityPerUnit: 1 }),
      ).rejects.toBeInstanceOf(ProductNotFoundError);
    });

    it('lanza RecipeCycleError si el componente es el propio padre', async () => {
      productRepo.seed('prod-pizza', 'COMPOSITE');

      await expect(
        service.addRecipeItem({ parentProductId: 'prod-pizza', componentProductId: 'prod-pizza', componentVariantId: null, quantityPerUnit: 1 }),
      ).rejects.toBeInstanceOf(RecipeCycleError);
    });

    it('lanza RecipeCycleError ante un ciclo transitivo (A contiene B, se intenta que B contenga A)', async () => {
      productRepo.seed('prod-a', 'COMPOSITE');
      productRepo.seed('prod-b', 'COMPOSITE');

      await service.addRecipeItem({ parentProductId: 'prod-a', componentProductId: 'prod-b', componentVariantId: null, quantityPerUnit: 1 });

      await expect(
        service.addRecipeItem({ parentProductId: 'prod-b', componentProductId: 'prod-a', componentVariantId: null, quantityPerUnit: 1 }),
      ).rejects.toBeInstanceOf(RecipeCycleError);
    });

    it('crea el ítem cuando todo es válido', async () => {
      productRepo.seed('prod-pizza', 'COMPOSITE');
      productRepo.seed('prod-flour', 'RAW_MATERIAL');

      const item = await service.addRecipeItem({
        parentProductId: 'prod-pizza', componentProductId: 'prod-flour', componentVariantId: null, quantityPerUnit: 0.3,
      });

      expect(item.parentProductId).toBe('prod-pizza');
      expect(item.componentProductId).toBe('prod-flour');
    });
  });

  describe('explodeRecipe() — venta / armado en vivo', () => {
    it('un producto RETAIL simple se devuelve a sí mismo sin explotar', async () => {
      productRepo.seed('prod-cola', 'RETAIL');

      const result = await service.explodeRecipe('prod-cola', 3);

      expect(result).toEqual([{ productId: 'prod-cola', productVariantId: null, quantity: 3 }]);
    });

    it('un COMPOSITE con assembleOnDemand=false NO explota (necesita stock propio, ver Producción)', async () => {
      productRepo.seed('prod-pan', 'COMPOSITE', false);

      const result = await service.explodeRecipe('prod-pan', 2);

      expect(result).toEqual([{ productId: 'prod-pan', productVariantId: null, quantity: 2 }]);
    });

    it('un COMPOSITE con assembleOnDemand=true explota a sus componentes hoja', async () => {
      productRepo.seed('prod-sandwich', 'COMPOSITE', true);
      productRepo.seed('prod-jamon', 'RAW_MATERIAL');
      productRepo.seed('prod-queso', 'RAW_MATERIAL');
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 2 });
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-queso', componentVariantId: null, quantityPerUnit: 1 });

      const result = await service.explodeRecipe('prod-sandwich', 3);

      expect(result).toContainEqual({ productId: 'prod-jamon', productVariantId: null, quantity: 6 });
      expect(result).toContainEqual({ productId: 'prod-queso', productVariantId: null, quantity: 3 });
      expect(result).toHaveLength(2);
    });

    it('recurre a través de un componente que a su vez es COMPOSITE+assembleOnDemand=true', async () => {
      productRepo.seed('prod-pizza', 'COMPOSITE', true);
      productRepo.seed('prod-salsa', 'COMPOSITE', true); // "salsa base": receta propia Y componente
      productRepo.seed('prod-tomate', 'RAW_MATERIAL');
      productRepo.seed('prod-queso', 'RAW_MATERIAL');
      await recipeItemRepo.create({ parentProductId: 'prod-pizza', componentProductId: 'prod-salsa', componentVariantId: null, quantityPerUnit: 1 });
      await recipeItemRepo.create({ parentProductId: 'prod-pizza', componentProductId: 'prod-queso', componentVariantId: null, quantityPerUnit: 1 });
      await recipeItemRepo.create({ parentProductId: 'prod-salsa', componentProductId: 'prod-tomate', componentVariantId: null, quantityPerUnit: 4 });

      const result = await service.explodeRecipe('prod-pizza', 2);

      // pizza x2 -> salsa x2 -> tomate x8 (2 * 1 * 4); queso x2 directo. "salsa" nunca aparece -- no es hoja.
      expect(result).toContainEqual({ productId: 'prod-tomate', productVariantId: null, quantity: 8 });
      expect(result).toContainEqual({ productId: 'prod-queso', productVariantId: null, quantity: 2 });
      expect(result.find((r) => r.productId === 'prod-salsa')).toBeUndefined();
    });

    it('se detiene en un componente COMPOSITE+assembleOnDemand=false -- lo trata como hoja, no lo explota', async () => {
      productRepo.seed('prod-sandwich', 'COMPOSITE', true);
      productRepo.seed('prod-pan', 'COMPOSITE', false); // necesita stock propio, no se hornea en vivo
      productRepo.seed('prod-harina', 'RAW_MATERIAL');
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-pan', componentVariantId: null, quantityPerUnit: 2 });
      await recipeItemRepo.create({ parentProductId: 'prod-pan', componentProductId: 'prod-harina', componentVariantId: null, quantityPerUnit: 5 }); // no debería usarse

      const result = await service.explodeRecipe('prod-sandwich', 1);

      expect(result).toEqual([{ productId: 'prod-pan', productVariantId: null, quantity: 2 }]);
    });

    it('agrega cantidades de un mismo componente que aparece en dos ramas distintas y redondea hacia arriba', async () => {
      productRepo.seed('prod-combo', 'COMPOSITE', true);
      productRepo.seed('prod-a', 'COMPOSITE', true);
      productRepo.seed('prod-b', 'COMPOSITE', true);
      productRepo.seed('prod-sal', 'RAW_MATERIAL');
      await recipeItemRepo.create({ parentProductId: 'prod-combo', componentProductId: 'prod-a', componentVariantId: null, quantityPerUnit: 1 });
      await recipeItemRepo.create({ parentProductId: 'prod-combo', componentProductId: 'prod-b', componentVariantId: null, quantityPerUnit: 1 });
      await recipeItemRepo.create({ parentProductId: 'prod-a', componentProductId: 'prod-sal', componentVariantId: null, quantityPerUnit: 0.3 });
      await recipeItemRepo.create({ parentProductId: 'prod-b', componentProductId: 'prod-sal', componentVariantId: null, quantityPerUnit: 0.3 });

      const result = await service.explodeRecipe('prod-combo', 1);

      // 0.3 + 0.3 = 0.6 -> redondeado hacia arriba a 1, una sola fila (agregado).
      expect(result).toEqual([{ productId: 'prod-sal', productVariantId: null, quantity: 1 }]);
    });

    it('lanza RecipeNotDefinedError si un COMPOSITE+assembleOnDemand=true no tiene receta', async () => {
      productRepo.seed('prod-vacio', 'COMPOSITE', true);

      await expect(service.explodeRecipe('prod-vacio', 1)).rejects.toBeInstanceOf(RecipeNotDefinedError);
    });

    it('un componente por variante resuelve al producto dueño de la variante (nunca productId null)', async () => {
      productRepo.seed('prod-sandwich', 'COMPOSITE', true);
      productRepo.seed('prod-pan', 'RETAIL');
      const now = new Date();
      variantRepo.seed({ id: 'var-pan-integral', productId: 'prod-pan', name: 'Integral', attributes: {}, sku: null, priceOverride: null, active: true, createdAt: now, updatedAt: now });
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: null, componentVariantId: 'var-pan-integral', quantityPerUnit: 2 });

      const result = await service.explodeRecipe('prod-sandwich', 1);

      expect(result).toEqual([{ productId: 'prod-pan', productVariantId: 'var-pan-integral', quantity: 2 }]);
    });

    it('lanza VariantNotFoundError si el componente-variante no existe', async () => {
      productRepo.seed('prod-sandwich', 'COMPOSITE', true);
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: null, componentVariantId: 'var-no-existe', quantityPerUnit: 1 });

      await expect(service.explodeRecipe('prod-sandwich', 1)).rejects.toBeInstanceOf(VariantNotFoundError);
    });
  });

  describe('explodeRecipeForProduction() — producción manual', () => {
    it('explota un COMPOSITE con assembleOnDemand=false (el caso normal de Producción: pan)', async () => {
      productRepo.seed('prod-pan', 'COMPOSITE', false);
      productRepo.seed('prod-harina', 'RAW_MATERIAL');
      await recipeItemRepo.create({ parentProductId: 'prod-pan', componentProductId: 'prod-harina', componentVariantId: null, quantityPerUnit: 0.5 });

      const result = await service.explodeRecipeForProduction('prod-pan', 10);

      expect(result).toEqual([{ productId: 'prod-harina', productVariantId: null, quantity: 5 }]);
    });

    it('también funciona para un COMPOSITE con assembleOnDemand=true (producir en lote algo normalmente armado en vivo)', async () => {
      productRepo.seed('prod-sandwich', 'COMPOSITE', true);
      productRepo.seed('prod-jamon', 'RAW_MATERIAL');
      await recipeItemRepo.create({ parentProductId: 'prod-sandwich', componentProductId: 'prod-jamon', componentVariantId: null, quantityPerUnit: 1 });

      const result = await service.explodeRecipeForProduction('prod-sandwich', 5);

      expect(result).toEqual([{ productId: 'prod-jamon', productVariantId: null, quantity: 5 }]);
    });

    it('lanza ProductNotCompositeError para un producto RETAIL', async () => {
      productRepo.seed('prod-cola', 'RETAIL');

      await expect(service.explodeRecipeForProduction('prod-cola', 1)).rejects.toBeInstanceOf(ProductNotCompositeError);
    });

    it('lanza RecipeNotDefinedError si el COMPOSITE no tiene receta', async () => {
      productRepo.seed('prod-vacio', 'COMPOSITE', false);

      await expect(service.explodeRecipeForProduction('prod-vacio', 1)).rejects.toBeInstanceOf(RecipeNotDefinedError);
    });
  });
});
