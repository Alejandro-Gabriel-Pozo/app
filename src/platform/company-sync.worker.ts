/**
 * @file company-sync.worker.ts
 * @description Worker de propagación del catálogo compartido (17/08/2026,
 * docs/diseno-empresas-multipropiedad.md) — BD central → cada sucursal
 * hermana. A diferencia de OutboxWorker (uno por tenant, un solo destino
 * fijo por instancia), este worker es ÚNICO por proceso y, por cada fila
 * pendiente, se conecta a un tenant DISTINTO (el `target_business_id` de
 * esa fila) — decripta su connection string, aplica el cambio, cierra la
 * conexión. Nunca mantiene un pool abierto por tenant (no es el camino
 * crítico de venta, corre poco frecuente, una conexión de vida corta por
 * fila alcanza — mismo patrón que applyTenantSchema()/migrate-tenants.ts).
 */

import { randomUUID } from 'crypto';
import pg from 'pg';
import type { CompanyRepository, CompanyProduct, CompanyRecipeItem, PropagationQueueRow } from './company.repository.js';
import type { PlatformRepository } from './platform.repository.js';
import { decryptConnectionString } from './tenant-db.setup.js';

const BATCH_SIZE = 20;
const MAX_RETRIES = 5;

export class CompanyCatalogPropagationWorker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly platformRepo: PlatformRepository,
  ) {}

  start(intervalMs: number): void {
    if (this.timer) return; // ya arrancado -- no-op, evita duplicar el interval
    this.timer = setInterval(() => { void this.poll(); }, intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Público para poder testear/disparar un ciclo puntual sin esperar el interval. */
  async poll(): Promise<void> {
    if (this.running) return; // un poll anterior sigue en curso -- no solapar
    this.running = true;
    try {
      const pending = await this.companyRepo.getPendingPropagation(BATCH_SIZE);
      for (const row of pending) {
        await this.processOne(row);
      }
    } catch (err) {
      console.error('[CompanyCatalogPropagationWorker] Error en poll():', err);
    } finally {
      this.running = false;
    }
  }

  private async processOne(row: PropagationQueueRow): Promise<void> {
    try {
      const companyProduct = await this.companyRepo.getCompanyProduct(row.companyProductId);
      if (!companyProduct) {
        // El producto canónico ya no existe (borrado) -- nada que propagar.
        await this.companyRepo.markPropagationProcessed(row.id);
        return;
      }

      const targetBusiness = await this.platformRepo.findById(row.targetBusinessId);
      if (!targetBusiness?.dbUrlEncrypted) {
        throw new Error(`Sucursal destino ${row.targetBusinessId} sin connection string configurada todavía.`);
      }

      const canonicalRecipe = await this.companyRepo.getCompanyRecipeItems(row.companyProductId);

      const connectionString = await decryptConnectionString(targetBusiness.dbUrlEncrypted);
      const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
      try {
        await client.connect();
        await this.applyToTenant(client, companyProduct, canonicalRecipe, row.targetBusinessId);
      } finally {
        await client.end();
      }

      await this.companyRepo.markPropagationProcessed(row.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wentDeadLetter = await this.companyRepo.recordPropagationFailure(row.id, message, MAX_RETRIES);
      if (wentDeadLetter) {
        console.error(
          `[CompanyCatalogPropagationWorker] ⚠️ Propagación ${row.id} (company_product=${row.companyProductId}, target=${row.targetBusinessId}) pasó a dead-letter tras ${MAX_RETRIES} intentos:`,
          message,
        );
      }
    }
  }

  /**
   * Aplica el estado del maestro (precio + receta) al producto local del
   * tenant destino. Primera vez que ese tenant ve el producto -> lo crea,
   * sincronizado (INACTIVO) desde el día uno, y materializa la receta
   * canónica de una. Ya existe localmente: cada override (precio, receta)
   * se resuelve por separado con la MISMA regla:
   * - INACTIVO -> toma el valor/receta nueva directo.
   * - ACTIVO o ya PENDIENTE_DE_REVISION -> NO toca el valor local -- pasa
   *   (o mantiene) PENDIENTE_DE_REVISION con lo nuevo como pendiente
   *   (decisión 3 del diseño: nunca se aplica en silencio ni se ignora un
   *   cambio de maestro mientras hay override activo).
   */
  private async applyToTenant(
    client: pg.Client,
    companyProduct: CompanyProduct,
    canonicalRecipe: CompanyRecipeItem[],
    targetBusinessId: string,
  ): Promise<void> {
    const { rows } = await client.query<{ price_override_status: string; recipe_override_status: string }>(
      `SELECT price_override_status, recipe_override_status FROM products WHERE id = $1`,
      [companyProduct.id],
    );

    if (rows.length === 0) {
      await client.query(
        `INSERT INTO products (id, business_id, name, base_price, sku, has_variants, company_product_id)
         VALUES ($1, $2, $3, $4, $5, false, $1)`,
        [companyProduct.id, targetBusinessId, companyProduct.name, companyProduct.basePrice, companyProduct.sku],
      );
      await this.replaceLocalRecipe(client, companyProduct.id, canonicalRecipe);
      return;
    }

    if (rows[0]!.price_override_status === 'INACTIVO') {
      await client.query(
        `UPDATE products SET name = $2, sku = $3, base_price = $4, updated_at = NOW() WHERE id = $1`,
        [companyProduct.id, companyProduct.name, companyProduct.sku, companyProduct.basePrice],
      );
    } else {
      await client.query(
        `UPDATE products
         SET name = $2, sku = $3,
             price_override_status = 'PENDIENTE_DE_REVISION',
             price_pending_master_value = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [companyProduct.id, companyProduct.name, companyProduct.sku, companyProduct.basePrice],
      );
    }

    if (rows[0]!.recipe_override_status === 'INACTIVO') {
      await this.replaceLocalRecipe(client, companyProduct.id, canonicalRecipe);
    } else {
      await client.query(
        `UPDATE products
         SET recipe_override_status = 'PENDIENTE_DE_REVISION',
             recipe_pending_master_snapshot = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [companyProduct.id, JSON.stringify(canonicalRecipe.map((r) => ({ componentProductId: r.componentProductId, quantityPerUnit: r.quantityPerUnit })))],
      );
    }
  }

  /** DELETE + INSERT de recipe_items local -- mismo criterio de simplificación que CompanyRepository.replaceCompanyRecipeItems() (acción de baja frecuencia, no el camino crítico de venta). */
  private async replaceLocalRecipe(client: pg.Client, parentProductId: string, items: CompanyRecipeItem[]): Promise<void> {
    await client.query(`DELETE FROM recipe_items WHERE parent_product_id = $1`, [parentProductId]);
    for (const item of items) {
      await client.query(
        `INSERT INTO recipe_items (id, parent_product_id, component_product_id, quantity_per_unit)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), parentProductId, item.componentProductId, item.quantityPerUnit],
      );
    }
  }
}
