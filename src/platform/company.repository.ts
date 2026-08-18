/**
 * @file company.repository.ts
 * @description Repositorio de empresas multipropiedad (17/08/2026,
 * docs/diseno-empresas-multipropiedad.md) — vive en la BD central de
 * plataforma (platform.schema.sql), nunca en una tenant DB. El `db` que
 * recibe apunta a la BD central, mismo criterio que PlatformRepository.
 */

import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../repositories/sql.client.js';

export interface Company {
  id: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompanyProduct {
  id: string;
  companyId: string;
  name: string;
  basePrice: number;
  sku: string | null;
  updatedAt: Date;
}

export interface CompanyRecipeItem {
  id: string;
  companyProductId: string;
  componentProductId: string;
  quantityPerUnit: number;
}

export interface PropagationQueueRow {
  id: string;
  companyProductId: string;
  targetBusinessId: string;
  createdAt: Date;
  retryCount: number;
}

function rowToCompany(row: Record<string, unknown>): Company {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
  };
}

function rowToCompanyProduct(row: Record<string, unknown>): CompanyProduct {
  return {
    id: row['id'] as string,
    companyId: row['company_id'] as string,
    name: row['name'] as string,
    basePrice: Number(row['base_price']),
    sku: (row['sku'] as string | null) ?? null,
    updatedAt: new Date(row['updated_at'] as string),
  };
}

function rowToRecipeItem(row: Record<string, unknown>): CompanyRecipeItem {
  return {
    id: row['id'] as string,
    companyProductId: row['company_product_id'] as string,
    componentProductId: row['component_product_id'] as string,
    quantityPerUnit: Number(row['quantity_per_unit']),
  };
}

export class CompanyRepository {
  constructor(private readonly db: SqlClient) {}

  // -------------------------------------------------------------------------
  // companies
  // -------------------------------------------------------------------------

  async createCompany(name: string): Promise<Company> {
    const id = randomUUID();
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO companies (id, name) VALUES ($1, $2) RETURNING id, name, created_at, updated_at`,
      [id, name],
    );
    return rowToCompany(rows[0]!);
  }

  async findCompanyById(id: string): Promise<Company | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, name, created_at, updated_at FROM companies WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToCompany(rows[0]) : undefined;
  }

  // -------------------------------------------------------------------------
  // company_products / company_recipe_items — catálogo canónico
  // -------------------------------------------------------------------------

  /**
   * `id` lo elige el CALLER (no se genera acá) -- para un producto
   * compartido, es el mismo valor que products.id en el tenant de origen
   * (ver diseño, sección "Vínculo en cada tenant").
   */
  async upsertCompanyProduct(input: { id: string; companyId: string; name: string; basePrice: number; sku: string | null }): Promise<CompanyProduct> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `INSERT INTO company_products (id, company_id, name, base_price, sku)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         name       = EXCLUDED.name,
         base_price = EXCLUDED.base_price,
         sku        = EXCLUDED.sku,
         updated_at = NOW()
       RETURNING id, company_id, name, base_price, sku, updated_at`,
      [input.id, input.companyId, input.name, input.basePrice, input.sku],
    );
    return rowToCompanyProduct(rows[0]!);
  }

  /**
   * Todo el catálogo canónico de una empresa -- pensado para que el panel
   * (fuera de alcance de este backend) muestre "¿ya existe esto en la
   * empresa?" al dar de alta un producto nuevo, y la sucursal elija
   * vincularse en vez de crear una identidad duplicada.
   */
  async getCompanyProductsByCompany(companyId: string): Promise<CompanyProduct[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, company_id, name, base_price, sku, updated_at FROM company_products WHERE company_id = $1 ORDER BY name ASC`,
      [companyId],
    );
    return rows.map(rowToCompanyProduct);
  }

  async getCompanyProduct(id: string): Promise<CompanyProduct | undefined> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, company_id, name, base_price, sku, updated_at FROM company_products WHERE id = $1`,
      [id],
    );
    return rows[0] ? rowToCompanyProduct(rows[0]) : undefined;
  }

  async getCompanyRecipeItems(companyProductId: string): Promise<CompanyRecipeItem[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, company_product_id, component_product_id, quantity_per_unit
       FROM company_recipe_items WHERE company_product_id = $1`,
      [companyProductId],
    );
    return rows.map(rowToRecipeItem);
  }

  /**
   * Reemplaza la receta canónica completa -- DELETE + INSERT, no dentro de
   * una transacción explícita (SqlClient de plataforma no expone
   * BEGIN/COMMIT a este nivel, mismo motivo que el resto de este
   * repositorio). Aceptado como simplificación deliberada: es una acción
   * administrativa de baja frecuencia, no el camino crítico de venta —
   * ver diseño, "Deliberadamente fuera".
   */
  async replaceCompanyRecipeItems(
    companyProductId: string,
    items: Array<{ componentProductId: string; quantityPerUnit: number }>,
  ): Promise<void> {
    await this.db.query(`DELETE FROM company_recipe_items WHERE company_product_id = $1`, [companyProductId]);
    for (const item of items) {
      await this.db.query(
        `INSERT INTO company_recipe_items (id, company_product_id, component_product_id, quantity_per_unit)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), companyProductId, item.componentProductId, item.quantityPerUnit],
      );
    }
  }

  // -------------------------------------------------------------------------
  // company_catalog_propagation_queue
  // -------------------------------------------------------------------------

  /**
   * Encola un "aviso de que hay que refrescar" para cada sucursal
   * hermana. ON CONFLICT DO NOTHING sobre el índice único parcial
   * (company_product_id, target_business_id) WHERE pendiente -- si ya hay
   * un aviso sin procesar para ese par, no hace falta uno nuevo (el
   * worker relee el estado más nuevo al procesar, ver comentario en
   * schema.sql BLOQUE EMPRESAS).
   */
  async enqueuePropagation(companyProductId: string, targetBusinessIds: string[]): Promise<void> {
    for (const targetBusinessId of targetBusinessIds) {
      await this.db.query(
        `INSERT INTO company_catalog_propagation_queue (id, company_product_id, target_business_id)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), companyProductId, targetBusinessId],
      );
    }
  }

  async getPendingPropagation(limit: number): Promise<PropagationQueueRow[]> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT id, company_product_id, target_business_id, created_at, retry_count
       FROM company_catalog_propagation_queue
       WHERE processed_at IS NULL AND failed_at IS NULL
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return rows.map((row) => ({
      id: row['id'] as string,
      companyProductId: row['company_product_id'] as string,
      targetBusinessId: row['target_business_id'] as string,
      createdAt: new Date(row['created_at'] as string),
      retryCount: Number(row['retry_count']),
    }));
  }

  async markPropagationProcessed(id: string): Promise<void> {
    await this.db.query(`UPDATE company_catalog_propagation_queue SET processed_at = NOW() WHERE id = $1`, [id]);
  }

  /**
   * Registra un intento fallido -- incremento atómico en la misma UPDATE
   * que decide si pasa a dead-letter (A8.2, mismo criterio que
   * DomainEventRepository.recordFailure). @returns true si este intento
   * lo dejó en dead-letter.
   */
  async recordPropagationFailure(id: string, error: string, maxRetries: number): Promise<boolean> {
    const { rows } = await this.db.query<{ retry_count: number }>(
      `UPDATE company_catalog_propagation_queue
       SET retry_count = retry_count + 1,
           last_error  = $2,
           failed_at   = CASE WHEN retry_count + 1 >= $3 THEN NOW() ELSE failed_at END
       WHERE id = $1
       RETURNING retry_count`,
      [id, error.slice(0, 200), maxRetries],
    );
    return (rows[0]?.retry_count ?? 0) >= maxRetries;
  }
}
