/**
 * @file sql.customer-tax-profile.repository.ts
 * @description Repositorio SQL del perfil fiscal de cliente.
 *
 * `customer_tax_profiles` referencia `customer_addresses` por
 * `address_id` — ninguna de las dos tablas tenía repositorio propio hasta
 * ahora (19/08/2026). En vez de construir un módulo genérico de
 * direcciones que nadie pidió, `upsert()` administra la fila de
 * `customer_addresses` (kind='BILLING') como parte de guardar el perfil
 * fiscal completo — es lo que hace falta hoy, no una API de direcciones
 * de propósito general.
 */

import { randomUUID } from 'node:crypto';
import type { SqlClient } from '../repositories/sql.client.js';
import type { ICustomerTaxProfileRepository } from './customer-tax-profile.repository.js';
import type {
  CustomerTaxProfile,
  CustomerTaxProfileAddress,
  UpsertCustomerTaxProfileInput,
} from './customer-tax-profile.entities.js';

interface ProfileRow {
  id: string;
  customer_id: string;
  legal_name: string;
  tax_id: string;
  tax_id_type: string;
  tax_condition: string | null;
  is_default: boolean;
  created_at: Date;
  address_id: string | null;
  addr_line1: string | null;
  addr_line2: string | null;
  addr_city: string | null;
  addr_state: string | null;
  addr_postal_code: string | null;
  addr_country: string | null;
}

const SELECT_SQL = `
  SELECT
    ctp.id, ctp.customer_id, ctp.legal_name, ctp.tax_id, ctp.tax_id_type,
    ctp.tax_condition, ctp.is_default, ctp.created_at, ctp.address_id,
    ca.line1 AS addr_line1, ca.line2 AS addr_line2, ca.city AS addr_city,
    ca.state AS addr_state, ca.postal_code AS addr_postal_code, ca.country AS addr_country
  FROM customer_tax_profiles ctp
  LEFT JOIN customer_addresses ca ON ca.id = ctp.address_id
`;

function rowToProfile(row: ProfileRow): CustomerTaxProfile {
  const address: CustomerTaxProfileAddress | null = row.address_id
    ? {
        line1: row.addr_line1 ?? '',
        line2: row.addr_line2,
        city: row.addr_city,
        state: row.addr_state,
        postalCode: row.addr_postal_code,
        country: row.addr_country ?? '',
      }
    : null;

  return {
    id: row.id,
    customerId: row.customer_id,
    legalName: row.legal_name,
    taxId: row.tax_id,
    taxIdType: row.tax_id_type,
    taxCondition: row.tax_condition,
    address,
    isDefault: row.is_default,
    createdAt: row.created_at,
  };
}

export class SqlCustomerTaxProfileRepository implements ICustomerTaxProfileRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async getByCustomerId(customerId: string): Promise<CustomerTaxProfile | null> {
    const { rows } = await this.sqlClient.query<ProfileRow>(
      `${SELECT_SQL} WHERE ctp.customer_id = $1 LIMIT 1`,
      [customerId],
    );
    return rows[0] ? rowToProfile(rows[0]) : null;
  }

  async upsert(customerId: string, input: UpsertCustomerTaxProfileInput): Promise<CustomerTaxProfile> {
    const { rows: existingRows } = await this.sqlClient.query<{ id: string; address_id: string | null }>(
      `SELECT id, address_id FROM customer_tax_profiles WHERE customer_id = $1 LIMIT 1`,
      [customerId],
    );
    const existing = existingRows[0];

    const addressId = input.address
      ? await this.saveAddress(customerId, existing?.address_id ?? null, input.address)
      : (existing?.address_id ?? null);

    const id = existing?.id ?? randomUUID();
    await this.sqlClient.query(
      `INSERT INTO customer_tax_profiles (id, customer_id, legal_name, tax_id, tax_id_type, tax_condition, address_id, is_default)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       ON CONFLICT (customer_id) DO UPDATE SET
         legal_name    = EXCLUDED.legal_name,
         tax_id        = EXCLUDED.tax_id,
         tax_id_type   = EXCLUDED.tax_id_type,
         tax_condition = EXCLUDED.tax_condition,
         address_id    = EXCLUDED.address_id`,
      [id, customerId, input.legalName, input.taxId, input.taxIdType, input.taxCondition ?? null, addressId],
    );

    return (await this.getByCustomerId(customerId))!;
  }

  private async saveAddress(
    customerId: string,
    existingAddressId: string | null,
    address: CustomerTaxProfileAddress,
  ): Promise<string> {
    if (existingAddressId) {
      await this.sqlClient.query(
        `UPDATE customer_addresses SET line1=$2, line2=$3, city=$4, state=$5, postal_code=$6, country=$7 WHERE id=$1`,
        [existingAddressId, address.line1, address.line2, address.city, address.state, address.postalCode, address.country],
      );
      return existingAddressId;
    }
    const id = randomUUID();
    await this.sqlClient.query(
      `INSERT INTO customer_addresses (id, customer_id, kind, line1, line2, city, state, postal_code, country, is_primary)
       VALUES ($1, $2, 'BILLING', $3, $4, $5, $6, $7, $8, TRUE)`,
      [id, customerId, address.line1, address.line2, address.city, address.state, address.postalCode, address.country],
    );
    return id;
  }
}
