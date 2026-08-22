/**
 * @file sql.customer-rate.repository.ts
 * @description Implementación SQL de ICustomerRateRepository.
 *
 * Lee/escribe `customer_rates` (db/schema.sql). Los dos índices únicos
 * parciales (uq_customer_rates_customer_resource / _service) garantizan que
 * solo puede haber UNA tarifa activa por cliente+recurso o cliente+servicio;
 * create() deja que la violación de unicidad suba tal cual — la ruta HTTP
 * (Fase 3) la traduce a 409 CUSTOMER_RATE_CONFLICT.
 *
 * D5 (pendientes-2026-08-19.md, decisión confirmada con el dueño
 * 22/08/2026, corregida el mismo día ANTES de cualquier deploy real):
 * `rate_catalog_id` es una referencia VIVA. Todas las queries de lectura
 * hacen LEFT JOIN a `rate_catalog` y devuelven `discount_percentage`
 * EFECTIVO (`cr.discount_percentage` propio de la fila, o si es NULL el
 * de la entrada de catálogo referenciada) — nunca el crudo de la columna
 * sola. Ver docblock de `CustomerRate.discountPercentage` en
 * customer-rate.repository.ts.
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
         cr.fixed_price, cr.discount_percentage, cr.rate_catalog_id,
         cr.active, cr.notes, cr.created_at, cr.updated_at,
         rc.discount_percentage AS catalog_discount_percentage
  FROM customer_rates cr
  LEFT JOIN rate_catalog rc ON rc.id = cr.rate_catalog_id
`;

export class SqlCustomerRateRepository implements ICustomerRateRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveForCustomerAndResource(customerId: string, resourceId: string): Promise<CustomerRate | undefined> {
    const result = await this.db.query<CustomerRateRow>(
      `${SELECT_WITH_CATALOG}
       WHERE cr.customer_id = $1 AND cr.resource_id = $2 AND cr.active = TRUE
       LIMIT 1`,
      [customerId, resourceId],
    );
    return result.rows[0] ? rowToRate(result.rows[0]) : undefined;
  }

  async findActiveForCustomerAndService(customerId: string, serviceId: string): Promise<CustomerRate | undefined> {
    const result = await this.db.query<CustomerRateRow>(
      `${SELECT_WITH_CATALOG}
       WHERE cr.customer_id = $1 AND cr.service_id = $2 AND cr.active = TRUE
       LIMIT 1`,
      [customerId, serviceId],
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
           (id, business_id, customer_id, resource_id, service_id, fixed_price, discount_percentage, rate_catalog_id, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *
       )
       SELECT inserted.*, rc.discount_percentage AS catalog_discount_percentage
       FROM inserted
       LEFT JOIN rate_catalog rc ON rc.id = inserted.rate_catalog_id`,
      [
        dto.id, dto.businessId, dto.customerId, dto.resourceId ?? null, dto.serviceId ?? null,
        dto.fixedPrice ?? null, dto.discountPercentage ?? null, dto.rateCatalogId ?? null, dto.notes ?? null,
      ],
    );
    return rowToRate(result.rows[0]!);
  }

  async deactivate(id: string): Promise<void> {
    await this.db.query(
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
