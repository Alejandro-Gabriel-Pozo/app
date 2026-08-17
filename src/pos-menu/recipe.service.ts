/**
 * @file recipe.service.ts
 * @description Lógica de negocio del BOM (bill of materials) — Fase 3 del
 * carve-out de inventario (17/08/2026, docs/diseno-inventario-carve-out.md).
 *
 * ## Regla de recursión (explodeRecipe)
 * Al explotar N unidades de un producto: si el producto es COMPOSITE con
 * `assembleOnDemand=true`, se recorre su receta; cada componente que a su
 * vez sea COMPOSITE+assembleOnDemand=true se explota recursivamente (ej.
 * "salsa base" dentro de "pizza"); cualquier otro caso (RAW_MATERIAL,
 * RETAIL, o COMPOSITE con assembleOnDemand=false) se trata como HOJA —
 * necesita su propio stock ya existente, no se sigue explotando. Esto es
 * lo que separa "pan" (assembleOnDemand=false: si no hay stock producido de
 * antemano, la venta falla, sin hornear en vivo) de "sándwich"
 * (assembleOnDemand=true: se arma en el momento con lo que haya de pan,
 * jamón, queso). La regla es una propiedad del árbol de productos, la
 * misma tanto si se dispara por una venta (OrderService.confirmOrder) como
 * por una Producción manual (POST /api/products/stock/production) — un
 * solo método, dos disparadores.
 *
 * ## Unidad de medida
 * `quantity_per_unit` es DECIMAL; `inventory_levels`/`stock_movements`.
 * quantity es INTEGER. Se redondea hacia arriba (Math.ceil) recién en la
 * cantidad FINAL agregada — nunca en cada paso de la recursión, para no
 * acumular error de redondeo — nunca reserva de menos. Conversión real de
 * unidad de medida (kg comprado -> g consumido) queda fuera de esta fase
 * (diseño, sección "Deliberadamente fuera").
 */

import type { IProductRepository, IProductVariantRepository } from './product.repository.js';
import type { RecipeItemRepository, RecipeItem, CreateRecipeItemInput, UpdateRecipeItemInput } from '../repositories/recipe-item.repository.js';
import { ProductNotFoundError, VariantNotFoundError } from './product.service.js';
import { ProductNotCompositeError, RecipeCycleError, RecipeNotDefinedError } from '../domain/errors.js';

const MAX_RECIPE_DEPTH = 20;

/**
 * `productId` nunca es null, ni siquiera cuando el componente hoja es una
 * variante (`productVariantId` set) — mismo criterio que un order_item
 * PRODUCT_VARIANT, que siempre lleva su product_id además del variant_id
 * (chk_order_item_polymorphic). Hace que esta forma calce 1:1 con
 * StockItemSnapshot (inventory.handlers.ts), sin ramas nuevas ahí.
 */
export interface ExplodedComponent {
  productId: string;
  productVariantId: string | null;
  quantity: number;
}

export class RecipeService {
  constructor(
    private readonly recipeItemRepo: RecipeItemRepository,
    private readonly productRepo: IProductRepository,
    private readonly variantRepo: IProductVariantRepository,
  ) {}

  async listRecipe(parentProductId: string): Promise<RecipeItem[]> {
    return this.recipeItemRepo.getByParent(parentProductId);
  }

  /**
   * `componentProductId` XOR `componentVariantId` ya lo valida el caller
   * (mismo criterio que el resto de los endpoints polimórficos). Acá se
   * valida lo que la BD no puede: que el padre exista y sea COMPOSITE
   * (chk_products_assemble_on_demand ya cierra el caso assembleOnDemand,
   * pero un producto RETAIL/RAW_MATERIAL con receta igual sería un dato sin
   * sentido) y que agregar este componente no cree un ciclo.
   */
  async addRecipeItem(input: CreateRecipeItemInput): Promise<RecipeItem> {
    const parent = await this.productRepo.getById(input.parentProductId);
    if (!parent) throw new ProductNotFoundError(input.parentProductId);
    if (parent.productType !== 'COMPOSITE') throw new ProductNotCompositeError(input.parentProductId);

    if (input.componentProductId) {
      const component = await this.productRepo.getById(input.componentProductId);
      if (!component) throw new ProductNotFoundError(input.componentProductId);

      const cycle = await this.recipeItemRepo.wouldCreateCycle(
        input.parentProductId, input.componentProductId, input.componentVariantId,
      );
      if (cycle) throw new RecipeCycleError(input.parentProductId, input.componentProductId);
    }

    return this.recipeItemRepo.create(input);
  }

  async updateRecipeItem(id: string, input: UpdateRecipeItemInput): Promise<RecipeItem> {
    return this.recipeItemRepo.update(id, input);
  }

  async removeRecipeItem(id: string): Promise<boolean> {
    return this.recipeItemRepo.delete(id);
  }

  /**
   * Explota `quantity` unidades de `productId` a su lista plana de
   * componentes HOJA (ver regla de recursión arriba) — entry point de
   * VENTA/armado en vivo. Si el producto no es COMPOSITE+assembleOnDemand,
   * devuelve `[{ productId, productVariantId: null, quantity }]` -- el
   * producto mismo, sin cambios -- para que el caller (OrderService) pueda
   * tratar SIEMPRE el resultado como "la lista de cosas a reservar", sin
   * ramificar entre producto simple y compuesto.
   */
  async explodeRecipe(productId: string, quantity: number): Promise<ExplodedComponent[]> {
    return this.aggregate(await this.explodeRaw(productId, quantity, 0));
  }

  /**
   * Entry point de PRODUCCIÓN manual (POST /api/products/stock/production):
   * a diferencia de explodeRecipe(), explota SIEMPRE que el producto sea
   * COMPOSITE -- no mira su propio assembleOnDemand (producir por
   * adelantado es exactamente la acción que assembleOnDemand=false exige,
   * y nada impide producir en lote algo normalmente assembleOnDemand=true
   * también). Los componentes de ADENTRO siguen la regla de recursión de
   * siempre (explodeRaw).
   */
  async explodeRecipeForProduction(productId: string, quantity: number): Promise<ExplodedComponent[]> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);
    if (product.productType !== 'COMPOSITE') throw new ProductNotCompositeError(productId);

    return this.aggregate(await this.explodeRecipeItems(productId, quantity, 0));
  }

  /** ¿Este producto explota (COMPOSITE + assembleOnDemand=true)? Evita llamar a explodeRecipe() para el caso trivial cuando el caller ya tiene el Product en mano. */
  needsExplosion(product: { productType: string; assembleOnDemand: boolean }): boolean {
    return product.productType === 'COMPOSITE' && product.assembleOnDemand;
  }

  private aggregate(raw: ExplodedComponent[]): ExplodedComponent[] {
    const aggregated = new Map<string, ExplodedComponent>();
    for (const r of raw) {
      const key = `${r.productId}|${r.productVariantId ?? ''}`;
      const existing = aggregated.get(key);
      if (existing) existing.quantity += r.quantity;
      else aggregated.set(key, { ...r });
    }
    return [...aggregated.values()].map((c) => ({ ...c, quantity: Math.ceil(c.quantity) }));
  }

  /** ¿Este nodo (productId) explota o es hoja? Recursivo — llamado tanto desde explodeRecipe() (nivel 0) como desde explodeRecipeItems() (sub-componentes). */
  private async explodeRaw(productId: string, quantity: number, depth: number): Promise<ExplodedComponent[]> {
    const product = await this.productRepo.getById(productId);
    if (!product) throw new ProductNotFoundError(productId);

    if (!this.needsExplosion(product)) {
      return [{ productId, productVariantId: null, quantity }];
    }

    return this.explodeRecipeItems(productId, quantity, depth);
  }

  /** Explota UN nivel de recipe_items de un producto ya confirmado COMPOSITE, recursando en sub-componentes vía explodeRaw(). */
  private async explodeRecipeItems(productId: string, quantity: number, depth: number): Promise<ExplodedComponent[]> {
    if (depth > MAX_RECIPE_DEPTH) {
      // Defensa en profundidad -- wouldCreateCycle() ya debería haber
      // impedido esto al escribir la receta. Si igual se llega acá, es un
      // bug real, no un caso de negocio -- se aborta la operación entera
      // (mismo criterio que cualquier error no capturado dentro de la
      // transacción de confirmOrder()/producción: rollback completo).
      throw new Error(
        `Profundidad de receta excedida (>${MAX_RECIPE_DEPTH}) explotando ${productId} -- posible ciclo no detectado por wouldCreateCycle().`,
      );
    }

    const items = await this.recipeItemRepo.getByParent(productId);
    if (items.length === 0) throw new RecipeNotDefinedError(productId);

    const result: ExplodedComponent[] = [];
    for (const item of items) {
      const neededQty = item.quantityPerUnit * quantity;
      if (item.componentProductId) {
        const sub = await this.explodeRaw(item.componentProductId, neededQty, depth + 1);
        result.push(...sub);
      } else {
        // component_variant_id: resuelve al producto dueño -- una variante
        // nunca tiene receta propia (recipe_items.parent_product_id solo
        // referencia productos), así que siempre es hoja.
        const variant = await this.variantRepo.getById(item.componentVariantId!);
        if (!variant) throw new VariantNotFoundError(item.componentVariantId!);
        result.push({ productId: variant.productId, productVariantId: variant.id, quantity: neededQty });
      }
    }
    return result;
  }
}
