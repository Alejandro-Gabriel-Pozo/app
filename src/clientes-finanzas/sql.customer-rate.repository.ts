/**
 * @file sql.customer-rate.repository.ts
 * @description Implementación SQL de ICustomerRateRepository.
 *
 * Lee/escribe `customer_rates` (db/schema.sql). Los dos índices únicos
 * parciales (uq_customer_rates_customer_resource / _service) garantizan que
 * solo puede haber UNA tarifa activa por cliente+recurso o cliente+servicio;
 * create() deja que la violación de unicidad suba tal cual — la ruta HTTP
 * (Fase 3) la traduce a 409 CUSTOMER_RATE_CONFLICT.
 */

import type {
  ICustomerRateRepository,
  CustomerRate,
  CreateCustomerRateDto,
} from './customer-rate.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

export class SqlCustomerRateRepository implements ICustomerRateRepository {
  constructor(private readonly db: SqlClient) {}

  async findActiveForCustomerAndResource(customerId: string, resourceId: string): Promise<CustomerRate | undefined> {
    const result = await this.db.query<CustomerRateRow>(
      `SELECT * FROM customer_rates
       WHERE customer_id = $1 AND resource_id = $2 AND active = TRUE
       LIMIT 1`,
      [customerId, resourceId],
    );
    return result.rows[0] ? rowToRate(result.rows[0]) : undefined;
  }

  async findActiveForCustomerAndService(customerId: string, serviceId: string): Promise<CustomerRate | undefined> {
    const result = await this.db.query<CustomerRateRow>(
      `SELECT * FROM customer_rates
       WHERE customer_id = $1 AND service_id = $2 AND active = TRUE
       LIMIT 1`,
      [customerId, serviceId],
    );
    return result.rows[0] ? rowToRate(result.rows[0]) : undefined;
  }

  async getByCustomerId(customerId: string): Promise<CustomerRate[]> {
    const result = await this.db.query<CustomerRateRow>(
      `SELECT * FROM customer_rates
       WHERE customer_id = $1 AND active = TRUE
       ORDER BY created_at DESC`,
      [customerId],
    );
    return result.rows.map(rowToRate);
  }

  async create(dto: CreateCustomerRateDto): Promise<CustomerRate> {
    const result = await this.db.query<CustomerRateRow>(
      `INSERT INTO customer_rates (id, business_id, customer_id, resource_id, service_id, price, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [dto.id, dto.businessId, dto.customerId, dto.resourceId ?? null, dto.serviceId ?? null, dto.price, dto.notes ?? null],
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
  price: string;
  active: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRate(r: CustomerRateRow): CustomerRate {
  return {
    id: r.id,
    businessId: r.business_id,
    customerId: r.customer_id,
    resourceId: r.resource_id,
    serviceId: r.service_id,
    price: parseFloat(r.price),
    active: r.active,
    notes: r.notes,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}
