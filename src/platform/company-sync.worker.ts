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
 *
 * Importa `AdaptivePoller` de `src/workers/` (`platform/ → workers/`) --
 * dependencia entre capas aceptada por el gate `architecture-governor`
 * para el bloque de polling adaptativo (10/09/2026,
 * docs/diseno-polling-adaptativo-neon-2026-09-10.md): el helper es
 * infraestructura transversal (scheduling puro, sin repo/pool/SqlClient),
 * no un worker de negocio del que `platform/` dependa.
 */

import { randomUUID } from 'crypto';
import pg from 'pg';
import type { CompanyRepository, CompanyProduct, CompanyRecipeItem, PropagationQueueRow } from './company.repository.js';
import type { PlatformRepository } from './platform.repository.js';
import { decryptConnectionString } from './tenant-db.setup.js';
import { logger } from '../logger.js';
import { AdaptivePoller } from '../workers/adaptive-poller.js';
import { stripSslMode, sslConfig } from '../db/pg.client.js';
import { getDbStatementTimeoutMs, getDbIdleInTransactionTimeoutMs } from '../config/env.js';

const BATCH_SIZE = 20;
const MAX_RETRIES = 5;

/**
 * Cadencia de polling (docs/diseno-polling-adaptativo-neon-2026-09-10.md,
 * bloque 1 -- el único de los tres workers migrado hasta ahora al
 * scheduler adaptativo de `AdaptivePoller`). `ACTIVE_INTERVAL_MS` sin
 * cambio respecto del valor histórico; `IDLE_INTERVAL_MS` (10 min, no 5)
 * dejar un colchón real de inactividad facturable por encima de la
 * ventana fija de scale-to-zero de Neon.
 */
const ACTIVE_INTERVAL_MS = 10_000;
const IDLE_INTERVAL_MS = 600_000;

export class CompanyCatalogPropagationWorker {
  private poller: AdaptivePoller | null = null;
  private running = false;

  constructor(
    private readonly companyRepo: CompanyRepository,
    private readonly platformRepo: PlatformRepository,
  ) {}

  /**
   * Los parámetros son opcionales (con los valores de producción como
   * default) para que los tests puedan pasar intervalos chicos sin
   * esperar minutos reales bajo fake timers.
   */
  start(activeIntervalMs = ACTIVE_INTERVAL_MS, idleIntervalMs = IDLE_INTERVAL_MS): void {
    if (this.poller) return; // ya arrancado -- no-op, evita duplicar el scheduler
    this.poller = new AdaptivePoller(() => this.poll(), activeIntervalMs, idleIntervalMs);
    this.poller.start();
  }

  async stop(): Promise<void> {
    if (!this.poller) return;
    const poller = this.poller;
    this.poller = null;
    await poller.stop();
  }

  /**
   * Despierta el worker al instante en vez de esperar hasta
   * `idleIntervalMs` -- pensado para el endpoint que encola una fila de
   * propagación nueva (§3.1 del diseño). Best-effort: si hay un poll en
   * vuelo justo en este momento, no hace nada (ver docblock de
   * `AdaptivePoller.wake()`).
   */
  wake(): void {
    this.poller?.wake();
  }

  /**
   * Público para poder testear/disparar un ciclo puntual sin esperar el
   * intervalo. @returns true si encontró filas pendientes -- usado por
   * `AdaptivePoller` para decidir el próximo intervalo (activo vs idle).
   */
  async poll(): Promise<boolean> {
    if (this.running) return false; // un poll anterior sigue en curso -- no solapar
    this.running = true;
    let foundWork = false;
    try {
      const pending = await this.companyRepo.getPendingPropagation(BATCH_SIZE);
      foundWork = pending.length > 0;
      for (const row of pending) {
        await this.processOne(row);
      }
    } catch (err) {
      // C2 (gate, ronda 3): un error acá deja foundWork=false -> el próximo
      // intervalo es IDLE_INTERVAL_MS (10 min), no ACTIVE_INTERVAL_MS (10s)
      // como antes de este bloque. Aceptado a propósito para este worker
      // (no es el camino crítico de venta, no vale martillar una BD caída
      // cada 10s) -- no asumir el mismo criterio al migrar OutboxWorker,
      // donde reintentar rápido tras un error transitorio sí importa.
      logger.error({ err }, '[CompanyCatalogPropagationWorker] Error en poll()');
    } finally {
      this.running = false;
    }
    return foundWork;
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
      const client = new pg.Client({
        connectionString: stripSslMode(connectionString),
        ssl: sslConfig(),
        // D-20 sub-bloque 4 (17/09/2026, F12-12) -- applyToTenant() es
        // SELECT/INSERT/UPDATE acotado por fila (DML, no DDL) -- distinto
        // de applyTenantSchema()/migrate-tenants.ts pese a la nota del
        // docblock del archivo (esa nota habla de "conexión de vida
        // corta", no de que corra DDL). Seguro de acotar con
        // statement_timeout, igual que los pools que sirven requests.
        statement_timeout: getDbStatementTimeoutMs(),
        idle_in_transaction_session_timeout: getDbIdleInTransactionTimeoutMs(),
      });
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
        logger.error(
          { propagationId: row.id, companyProductId: row.companyProductId, targetBusinessId: row.targetBusinessId, maxRetries: MAX_RETRIES, message },
          '[CompanyCatalogPropagationWorker] Propagación pasó a dead-letter',
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
