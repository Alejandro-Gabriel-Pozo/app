import { randomUUID } from 'crypto';
import type { SqlClient } from './sql.client.js';
import type {
  RecipeItemRepository,
  RecipeItem,
  CreateRecipeItemInput,
  UpdateRecipeItemInput,
} from './recipe-item.repository.js';
import { RecipeItemNotFoundError } from '../domain/errors.js';

const RETURNING_COLS = `
  id, parent_product_id, component_product_id, component_variant_id,
  quantity_per_unit, cost_per_unit, yield_percentage, created_at, updated_at
`;

function mapRow(row: Record<string, unknown>): RecipeItem {
  return {
    id:                  row['id'] as string,
    parentProductId:     row['parent_product_id'] as string,
    componentProductId: (row['component_product_id'] as string | null) ?? null,
    componentVariantId: (row['component_variant_id'] as string | null) ?? null,
    quantityPerUnit:     Number(row['quantity_per_unit']),
    costPerUnit:         row['cost_per_unit']     != null ? Number(row['cost_per_unit'])     : null,
    yieldPercentage:     row['yield_percentage']  != null ? Number(row['yield_percentage'])  : null,
    createdAt:           new Date(row['created_at'] as string),
    updatedAt:           new Date(row['updated_at'] as string),
  };
}

export class SqlRecipeItemRepository implements RecipeItemRepository {
  constructor(private readonly db: SqlClient) {}

  async getByParent(parentProductId: string): Promise<RecipeItem[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM recipe_items WHERE parent_product_id = $1 ORDER BY created_at ASC`,
      [parentProductId],
    );
    return rows.map(mapRow);
  }

  async getById(id: string): Promise<RecipeItem | null> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT ${RETURNING_COLS} FROM recipe_items WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async create(input: CreateRecipeItemInput): Promise<RecipeItem> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO recipe_items
         (id, parent_product_id, component_product_id, component_variant_id,
          quantity_per_unit, cost_per_unit, yield_percentage)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING ${RETURNING_COLS}`,
      [
        id,
        input.parentProductId,
        input.componentProductId,
        input.componentVariantId,
        input.quantityPerUnit,
        input.costPerUnit     ?? null,
        input.yieldPercentage ?? null,
      ],
    );
    return mapRow(rows[0]!);
  }

  async update(id: string, input: UpdateRecipeItemInput): Promise<RecipeItem> {
    const fields: string[]  = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.quantityPerUnit !== undefined) { fields.push(`quantity_per_unit = $${idx++}`); params.push(input.quantityPerUnit); }
    if (input.costPerUnit     !== undefined) { fields.push(`cost_per_unit = $${idx++}`);     params.push(input.costPerUnit); }
    if (input.yieldPercentage !== undefined) { fields.push(`yield_percentage = $${idx++}`);  params.push(input.yieldPercentage); }

    if (fields.length === 0) {
      const item = await this.getById(id);
      if (!item) throw new RecipeItemNotFoundError(id);
      return item;
    }

    fields.push('updated_at = NOW()');
    params.push(id);

    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE recipe_items SET ${fields.join(', ')} WHERE id = $${idx} RETURNING ${RETURNING_COLS}`,
      params,
    );
    if (!rows[0]) throw new RecipeItemNotFoundError(id);
    return mapRow(rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `DELETE FROM recipe_items WHERE id = $1 RETURNING id`,
      [id],
    );
    return rows.length > 0;
  }

  /**
   * Un componente por VARIANTE nunca puede ciclar -- recipe_items.
   * parent_product_id solo referencia productos, nunca variantes, así que
   * una variante jamás puede ser padre de nada y no hace falta tocar la BD.
   */
  async wouldCreateCycle(parentProductId: string, componentProductId: string | null, componentVariantId: string | null): Promise<boolean> {
    if (!componentProductId) return false;
    if (componentProductId === parentProductId) return true;

    const { rows } = await this.db.query<{ product_id: string }>(
      `WITH RECURSIVE reachable AS (
         SELECT component_product_id AS product_id
         FROM recipe_items
         WHERE parent_product_id = $1 AND component_product_id IS NOT NULL
         UNION
         SELECT ri.component_product_id
         FROM recipe_items ri
         JOIN reachable r ON ri.parent_product_id = r.product_id
         WHERE ri.component_product_id IS NOT NULL
       )
       SELECT product_id FROM reachable WHERE product_id = $2 LIMIT 1`,
      [componentProductId, parentProductId],
    );
    void componentVariantId; // no aplica -- ver comentario del método
    return rows.length > 0;
  }
}
