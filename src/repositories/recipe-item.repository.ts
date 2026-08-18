/**
 * @file recipe-item.repository.ts
 * @description Contrato de repositorio del BOM (bill of materials).
 * Fase 3 del carve-out de inventario (17/08/2026,
 * docs/diseno-inventario-carve-out.md) — pivote/config entre productos
 * (parecido a `resource_locks`, no un MAESTRO ni una TRANSACCIÓN de
 * docs/criterios-datos.md Parte 1: es una línea de una receta, se edita
 * libremente mientras se ajusta el BOM, no tiene ciclo de vida propio ni
 * historial que preservar). Hard-delete, no soft-delete.
 */

export interface RecipeItem {
  id: string;
  parentProductId: string;
  /** Uno de los dos, nunca ambos (mismo patrón polimórfico que stock_movements/inventory_levels). */
  componentProductId: string | null;
  componentVariantId: string | null;
  quantityPerUnit: number;
  /** Capturado desde el día uno aunque el cálculo de COGS teórico-vs-real siga pospuesto. */
  costPerUnit: number | null;
  yieldPercentage: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateRecipeItemInput {
  parentProductId: string;
  componentProductId: string | null;
  componentVariantId: string | null;
  quantityPerUnit: number;
  costPerUnit?: number | null;
  yieldPercentage?: number | null;
}

export interface UpdateRecipeItemInput {
  quantityPerUnit?: number;
  costPerUnit?: number | null;
  yieldPercentage?: number | null;
}

export interface RecipeItemRepository {
  /** Todas las líneas de la receta de un producto (no recursivo — un solo nivel). */
  getByParent(parentProductId: string): Promise<RecipeItem[]>;

  getById(id: string): Promise<RecipeItem | null>;

  create(input: CreateRecipeItemInput): Promise<RecipeItem>;

  update(id: string, input: UpdateRecipeItemInput): Promise<RecipeItem>;

  /** Hard-delete — ver nota de clasificación arriba. */
  delete(id: string): Promise<boolean>;

  /**
   * Reemplaza TODA la receta de un producto -- DELETE + INSERT. Usado por
   * empresas multipropiedad (17/08/2026, docs/diseno-empresas-
   * multipropiedad.md) para materializar la receta canónica localmente
   * (al vincular un producto ya existente, o al aceptar una revisión
   * pendiente) — no pasa por wouldCreateCycle() porque la receta canónica
   * ya se validó al escribirla del lado que la originó.
   */
  replaceForParent(parentProductId: string, items: Array<{ componentProductId: string; quantityPerUnit: number }>): Promise<void>;

  /**
   * ¿Agregar un recipe_item con este componente como hijo de
   * `parentProductId` crearía un ciclo? Verdadero si `componentProductId`
   * (resolviendo `componentVariantId` a su producto dueño si aplica) ya
   * puede llegar transitivamente a `parentProductId` a través de
   * recipe_items existentes — en ese caso, agregar la vuelta haría que la
   * receta se refiriera a sí misma. CTE recursiva, no recorrido en memoria
   * (docs/diseno-inventario-carve-out.md Fase 3, "Prevención de ciclos").
   */
  wouldCreateCycle(parentProductId: string, componentProductId: string | null, componentVariantId: string | null): Promise<boolean>;
}
