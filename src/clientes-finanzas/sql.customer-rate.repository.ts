/**
 * @file sql.customer-rate.repository.ts
 * @description Implementación SQL de ICustomerRateRepository.
 *
 * Lee/escribe `customer_rates` (db/schema.sql). Los 5 índices únicos
 * parciales (uno por columna de scope) garantizan que solo puede haber
 * UNA tarifa activa por cliente+valor EXACTO de scope; create() deja que
 * la violación de unicidad suba tal cual — la ruta HTTP la traduce a 409
 * CUSTOMER_RATE_CONFLICT.
 *
 * D5 (pendientes-2026-08-19.md, decisión confirmada con el dueño
 * 22/08/2026, corregida el mismo día ANTES de cualquier deploy real):
 * `rate_catalog_id` es una referencia VIVA. Todas las queries de lectura
 * hacen LEFT JOIN a `rate_catalog` y devuelven `discount_percentage`
 * EFECTIVO (`cr.discount_percentage` propio de la fila, o si es NULL el
 * de la entrada de catálogo referenciada) — nunca el crudo de la columna
 * sola. Ver docblock de `CustomerRate.discountPercentage` en
 * customer-rate.repository.ts.
 *
 * D9-Parte 1 (pendientes-2026-08-22.md,
 * docs/diseno-scope-multinivel-tarifas-2026-08-22.md): `findActiveFor*`
 * ya no busca una fila exacta por `resource_id`/`service_id` — busca
 * TODAS las candidatas que alcanzan al ítem concreto (ítem/categoría/
 * bucket) y devuelve la más específica (`ORDER BY specificity`, 1 = ítem,
 * 2 = categoría, 3 = bucket). El caller (`ReservationPricingService`) ya
 * resuelve `categoryId`/`isLodging` -- este repositorio solo compara.
 */

import type {
  ICustomerRateRepository,
  CustomerRate,
  CreateCustomerRateDto,
} from './customer-rate.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

/** `cr.*` explícito (no `SELECT *`) porque conviven con `rc.discount_percentage` bajo un alias distinto. */
const SELECT_WITH_CATALOG = `
  SELECT cr.id, cr.business_id, cr.customer_id, cr.resource_id, cr.service_id,
         cr.product_id, cr.category_id, cr.bucket,
         cr.fixed_price, cr.discount_percentage, cr.rate_catalog_id,
         cr.active, cr.notes, cr.created_at, cr.updated_at,
         rc.discount_percentage AS catalog_discount_percentage
  FROM customer_rates cr
  LEFT JOIN rate_catalog rc ON rc.id = cr.rate_catalog_id
`;

/** 1 = ítem (más específico), 2 = categoría, 3 = bucket (menos específico) — default #1 (pendientes-2026-08-22.md). */
const SPECIFICITY_ORDER = `
  CASE
    WHEN cr.resource_id IS NOT NULL OR cr.service_id IS NOT NULL OR cr.product_id IS NOT NULL THEN 1
    WHEN cr.category_id IS NOT NULL THEN 2
    ELSE 3
  END
`;

export class SqlCustomerRateRepository implements ICustomerRateRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveForCustomerAndResource(
    customerId: string, resourceId: string, categoryId: string, isLodging: boolean,
  ): Promise<CustomerRate | undefined> {
    const bucket = isLodging ? 'ALOJAMIENTO' : 'TURNOS';
    const result = await this.db.query<CustomerRateRow>(
      `${SELECT_WITH_CATALOG}
       WHERE cr.customer_id = $1 AND cr.active = TRUE
         AND (cr.resource_id = $2 OR cr.category_id = $3 OR cr.bucket = $4)
       ORDER BY ${SPECIFICITY_ORDER} ASC
       LIMIT 1`,
      [customerId, resourceId, categoryId, bucket],
    );
    return result.rows[0] ? rowToRate(result.rows[0]) : undefined;
  }

  async findActiveForCustomerAndService(
    customerId: string, serviceId: string, categoryId: string,
  ): Promise<CustomerRate | undefined> {
    const result = await this.db.query<CustomerRateRow>(
      `${SELECT_WITH_CATALOG}
       WHERE cr.customer_id = $1 AND cr.active = TRUE
         AND (cr.service_id = $2 OR cr.category_id = $3 OR cr.bucket = 'SERVICIOS')
       ORDER BY ${SPECIFICITY_ORDER} ASC
       LIMIT 1`,
      [customerId, serviceId, categoryId],
    );
    return result.rows[0] ? rowToRate(result.rows[0]) : undefined;
  }

  async findActiveForCustomerAndProduct(
    customerId: string, productId: string, categoryId: string,
  ): Promise<CustomerRate | undefined> {
    const result = await this.db.query<CustomerRateRow>(
      `${SELECT_WITH_CATALOG}
       WHERE cr.customer_id = $1 AND cr.active = TRUE
         AND (cr.product_id = $2 OR cr.category_id = $3 OR cr.bucket = 'PRODUCTOS')
       ORDER BY ${SPECIFICITY_ORDER} ASC
       LIMIT 1`,
      [customerId, productId, categoryId],
    );
    return result.rows[0] ? rowToRate(result.rows[0]) : undefined;
  }

  /** `businessId` es guardia multi-tenant — sin filtro de `active`, a diferencia de las de arriba: se usa para auditar la desactivación, necesita poder leer el estado ANTES de apagarlo. */
  async findById(id: string, businessId: string): Promise<CustomerRate | undefined> {
    const result = await this.db.query<CustomerRateRow>(
      `${SELECT_WITH_CATALOG}
       WHERE cr.id = $1 AND cr.business_id = $2`,
      [id, businessId],
    );
    return result.rows[0] ? rowToRate(result.rows[0]) : undefined;
  }

  async getByCustomerId(customerId: string): Promise<CustomerRate[]> {
    const result = await this.db.query<CustomerRateRow>(
      `${SELECT_WITH_CATALOG}
       WHERE cr.customer_id = $1 AND cr.active = TRUE
       ORDER BY cr.created_at DESC`,
      [customerId],
    );
    return result.rows.map(rowToRate);
  }

  async create(dto: CreateCustomerRateDto): Promise<CustomerRate> {
    const result = await this.db.query<CustomerRateRow>(
      `WITH inserted AS (
         INSERT INTO customer_rates
           (id, business_id, customer_id, resource_id, service_id, product_id, category_id, bucket,
            fixed_price, discount_percentage, rate_catalog_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *
       )
       SELECT inserted.*, rc.discount_percentage AS catalog_discount_percentage
       FROM inserted
       LEFT JOIN rate_catalog rc ON rc.id = inserted.rate_catalog_id`,
      [
        dto.id, dto.businessId, dto.customerId, dto.resourceId ?? null, dto.serviceId ?? null,
        dto.productId ?? null, dto.categoryId ?? null, dto.bucket ?? null,
        dto.fixedPrice ?? null, dto.discountPercentage ?? null, dto.rateCatalogId ?? null, dto.notes ?? null,
      ],
    );
    return rowToRate(result.rows[0]!);
  }

  async deactivate(id: string): Promise<void> {
    await this.deactivateWith(this.db, id);
  }

  async deactivateWithClient(client: SqlClient, id: string): Promise<void> {
    await this.deactivateWith(client, id);
  }

  private async deactivateWith(client: SqlClient, id: string): Promise<void> {
    await client.query(
      `UPDATE customer_rates SET active = FALSE WHERE id = $1`,
      [id],
    );
  }
}

interface CustomerRateRow {
  id: string;
  business_id: string;
  customer_id: string;
  resource_id: string | null;
  service_id: string | null;
  product_id: string | null;
  category_id: string | null;
  bucket: string | null;
  fixed_price: string | null;
  discount_percentage: string | null;
  rate_catalog_id: string | null;
  active: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  /** Del LEFT JOIN a rate_catalog -- null si rate_catalog_id es null o la fila no tiene ese origen. */
  catalog_discount_percentage: string | null;
}

function rowToRate(r: CustomerRateRow): CustomerRate {
  const ownPercentage = r.discount_percentage !== null ? parseFloat(r.discount_percentage) : null;
  const catalogPercentage = r.catalog_discount_percentage !== null ? parseFloat(r.catalog_discount_percentage) : null;

  return {
    id: r.id,
    businessId: r.business_id,
    customerId: r.customer_id,
    resourceId: r.resource_id,
    serviceId: r.service_id,
    productId: r.product_id,
    categoryId: r.category_id,
    bucket: r.bucket,
    fixedPrice: r.fixed_price !== null ? parseFloat(r.fixed_price) : null,
    // Efectivo: propio de la fila (modo B) o resuelto en vivo desde el
    // catálogo (modo C) -- nunca los dos a la vez (chk_customer_rate_pricing_mode).
    discountPercentage: ownPercentage ?? catalogPercentage,
    rateCatalogId: r.rate_catalog_id,
    active: r.active,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
