import { randomUUID } from 'crypto';
import type {
  RecipeItemRepository,
  RecipeItem,
  CreateRecipeItemInput,
  UpdateRecipeItemInput,
} from './recipe-item.repository.js';
import { RecipeItemNotFoundError } from '../domain/errors.js';

/** Test double en memoria — mismo criterio que el resto de los InMemory*Repository. */
export class InMemoryRecipeItemRepository implements RecipeItemRepository {
  private readonly rows = new Map<string, RecipeItem>();

  async getByParent(parentProductId: string): Promise<RecipeItem[]> {
    return [...this.rows.values()].filter((r) => r.parentProductId === parentProductId);
  }

  async getById(id: string): Promise<RecipeItem | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: CreateRecipeItemInput): Promise<RecipeItem> {
    const now = new Date();
    const item: RecipeItem = {
      id: randomUUID(),
      parentProductId: input.parentProductId,
      componentProductId: input.componentProductId,
      componentVariantId: input.componentVariantId,
      quantityPerUnit: input.quantityPerUnit,
      costPerUnit: input.costPerUnit ?? null,
      yieldPercentage: input.yieldPercentage ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(item.id, item);
    return item;
  }

  async update(id: string, input: UpdateRecipeItemInput): Promise<RecipeItem> {
    const current = this.rows.get(id);
    if (!current) throw new RecipeItemNotFoundError(id);
    const updated: RecipeItem = {
      ...current,
      ...(input.quantityPerUnit !== undefined && { quantityPerUnit: input.quantityPerUnit }),
      ...(input.costPerUnit     !== undefined && { costPerUnit: input.costPerUnit }),
      ...(input.yieldPercentage !== undefined && { yieldPercentage: input.yieldPercentage }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  /** Mismo criterio que la versión SQL: una variante nunca puede ciclar. */
  async wouldCreateCycle(parentProductId: string, componentProductId: string | null, _componentVariantId: string | null): Promise<boolean> {
    if (!componentProductId) return false;
    if (componentProductId === parentProductId) return true;

    const visited = new Set<string>();
    const stack = [componentProductId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const item of this.rows.values()) {
        if (item.parentProductId !== current || !item.componentProductId) continue;
        if (item.componentProductId === parentProductId) return true;
        stack.push(item.componentProductId);
      }
    }
    return false;
  }
}
