import type { SqlClient } from './sql.client.js';
import type { BusinessProfileRepository } from './business-profile.repository.js';
import type { BusinessProfile, UpdateBusinessProfileInput } from '../domain/business-profile.entities.js';

function rowToProfile(row: Record<string, unknown>): BusinessProfile {
  return {
    id:           row['id'] as string,
    displayName:  (row['display_name']  as string | null) ?? null,
    contactEmail: (row['contact_email'] as string | null) ?? null,
    currency:     row['currency'] as string,
    timezone:     row['timezone'] as string,
    defaultCheckInTime:  row['default_check_in_time']  as string,
    defaultCheckOutTime: row['default_check_out_time'] as string,
    legalName:               (row['legal_name']                 as string | null) ?? null,
    taxId:                   (row['tax_id']                     as string | null) ?? null,
    taxIdType:               (row['tax_id_type']                as string | null) ?? null,
    taxCondition:            (row['tax_condition']               as string | null) ?? null,
    fiscalAddressLine1:      (row['fiscal_address_line1']        as string | null) ?? null,
    fiscalAddressCity:       (row['fiscal_address_city']         as string | null) ?? null,
    fiscalAddressState:      (row['fiscal_address_state']        as string | null) ?? null,
    fiscalAddressPostalCode: (row['fiscal_address_postal_code']  as string | null) ?? null,
    fiscalAddressCountry:    (row['fiscal_address_country']      as string | null) ?? null,
    afipSalesPoint:          (row['afip_sales_point']            as number | null) ?? null,
    afipCuit:                (row['afip_cuit']                   as string | null) ?? null,
    defaultIvaRate:          parseFloat(row['default_iva_rate'] as string),
    pricesIncludeIva:        row['prices_include_iva'] as boolean,
    defaultDepositPercentage: row['default_deposit_percentage'] != null ? parseFloat(row['default_deposit_percentage'] as string) : null,
    depositHoldHours:         (row['deposit_hold_hours'] as number | null) ?? null,
    customerNumberPrefix:    row['customer_number_prefix']    as string,
    reservationNumberPrefix: row['reservation_number_prefix'] as string,
    createdAt:    new Date(row['created_at'] as string),
    updatedAt:    new Date(row['updated_at'] as string),
  };
}

export class SqlBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly db: SqlClient) {}

  async get(): Promise<BusinessProfile> {
    const { rows } = await this.db.query<Record<string, unknown>>(
      `SELECT * FROM business_profile WHERE id = 'default' LIMIT 1`,
    );
    if (!rows[0]) {
      throw new Error("business_profile sin la fila 'default' -- ¿se corrió schema.sql?");
    }
    return rowToProfile(rows[0]);
  }

  async update(input: UpdateBusinessProfileInput): Promise<BusinessProfile> {
    const fields: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (input.displayName !== undefined) {
      fields.push(`display_name = $${idx++}`);
      params.push(input.displayName?.trim() || null);
    }
    if (input.contactEmail !== undefined) {
      fields.push(`contact_email = $${idx++}`);
      params.push(input.contactEmail?.trim() || null);
    }
    if (input.currency !== undefined) {
      fields.push(`currency = $${idx++}`);
      params.push(input.currency);
    }
    if (input.timezone !== undefined) {
      fields.push(`timezone = $${idx++}`);
      params.push(input.timezone);
    }
    if (input.defaultCheckInTime !== undefined) {
      fields.push(`default_check_in_time = $${idx++}`);
      params.push(input.defaultCheckInTime);
    }
    if (input.defaultCheckOutTime !== undefined) {
      fields.push(`default_check_out_time = $${idx++}`);
      params.push(input.defaultCheckOutTime);
    }
    if (input.legalName !== undefined) {
      fields.push(`legal_name = $${idx++}`);
      params.push(input.legalName?.trim() || null);
    }
    if (input.taxId !== undefined) {
      fields.push(`tax_id = $${idx++}`);
      params.push(input.taxId?.trim() || null);
    }
    if (input.taxIdType !== undefined) {
      fields.push(`tax_id_type = $${idx++}`);
      params.push(input.taxIdType?.trim() || null);
    }
    if (input.taxCondition !== undefined) {
      fields.push(`tax_condition = $${idx++}`);
      params.push(input.taxCondition?.trim() || null);
    }
    if (input.fiscalAddressLine1 !== undefined) {
      fields.push(`fiscal_address_line1 = $${idx++}`);
      params.push(input.fiscalAddressLine1?.trim() || null);
    }
    if (input.fiscalAddressCity !== undefined) {
      fields.push(`fiscal_address_city = $${idx++}`);
      params.push(input.fiscalAddressCity?.trim() || null);
    }
    if (input.fiscalAddressState !== undefined) {
      fields.push(`fiscal_address_state = $${idx++}`);
      params.push(input.fiscalAddressState?.trim() || null);
    }
    if (input.fiscalAddressPostalCode !== undefined) {
      fields.push(`fiscal_address_postal_code = $${idx++}`);
      params.push(input.fiscalAddressPostalCode?.trim() || null);
    }
    if (input.fiscalAddressCountry !== undefined) {
      fields.push(`fiscal_address_country = $${idx++}`);
      params.push(input.fiscalAddressCountry?.trim() || null);
    }
    if (input.afipSalesPoint !== undefined) {
      fields.push(`afip_sales_point = $${idx++}`);
      params.push(input.afipSalesPoint);
    }
    if (input.afipCuit !== undefined) {
      fields.push(`afip_cuit = $${idx++}`);
      params.push(input.afipCuit?.trim() || null);
    }
    if (input.defaultIvaRate !== undefined) {
      fields.push(`default_iva_rate = $${idx++}`);
      params.push(input.defaultIvaRate);
    }
    if (input.pricesIncludeIva !== undefined) {
      fields.push(`prices_include_iva = $${idx++}`);
      params.push(input.pricesIncludeIva);
    }
    if (input.defaultDepositPercentage !== undefined) {
      fields.push(`default_deposit_percentage = $${idx++}`);
      params.push(input.defaultDepositPercentage);
    }
    if (input.depositHoldHours !== undefined) {
      fields.push(`deposit_hold_hours = $${idx++}`);
      params.push(input.depositHoldHours);
    }
    if (input.customerNumberPrefix !== undefined) {
      fields.push(`customer_number_prefix = $${idx++}`);
      params.push(input.customerNumberPrefix);
    }
    if (input.reservationNumberPrefix !== undefined) {
      fields.push(`reservation_number_prefix = $${idx++}`);
      params.push(input.reservationNumberPrefix);
    }

    if (fields.length === 0) return this.get();

    fields.push('updated_at = NOW()');

    const { rows } = await this.db.query<Record<string, unknown>>(
      `UPDATE business_profile SET ${fields.join(', ')} WHERE id = 'default' RETURNING *`,
      params,
    );
    return rowToProfile(rows[0]!);
  }
}
