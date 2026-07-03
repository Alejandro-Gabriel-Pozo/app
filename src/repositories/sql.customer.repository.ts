/**
 * @file sql.customer.repository.ts
 * @description Repositorio SQL del cliente como agregado.
 *
 * Lee con JOIN sobre customer_contact_methods para construir
 * el Customer completo con sus ContactMethods.
 * Escribe en ambas tablas dentro del mismo bloque (o transacción
 * cuando se llama desde saveWithClient).
 *
 * Schema esperado: ver migration 005_customer_aggregate.sql
 */

import { randomUUID } from 'node:crypto';
import { Customer, ContactMethod } from '../domain/entities.js';
import { SqlClient } from './sql.client.js';
import { CustomerRepository, CustomerWithPassword } from './customer.repository.js';

// ── Tipos internos ──────────────────────────────────────────────────────────

interface CustomerRow {
  id:            string;
  display_name:  string;
  password_hash: string | null;
  ccm_id:        string | null;
  channel:       string | null;
  ccm_value:     string | null;
  is_primary:    boolean | null;
  verified_at:   Date | null;
}

// ── Base SELECT reutilizable ────────────────────────────────────────────────

const BASE_SELECT = `
  SELECT
    c.id,
    c.display_name,
    c.password_hash,
    ccm.id          AS ccm_id,
    ccm.channel,
    ccm.value       AS ccm_value,
    ccm.is_primary,
    ccm.verified_at
  FROM customers c
  LEFT JOIN customer_contact_methods ccm ON ccm.customer_id = c.id
`.trim();

// ── Implementación ──────────────────────────────────────────────────────────

export class SqlCustomerRepository implements CustomerRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  // ── Escritura ─────────────────────────────────────────────────────────────

  async save(customer: Customer): Promise<void> {
    await this._upsertCustomer(this.sqlClient, customer, null);
  }

  async saveWithPassword(customer: Customer, passwordHash: string): Promise<void> {
    await this._upsertCustomer(this.sqlClient, customer, passwordHash);
  }

  /** Versión transaccional — recibe el SqlClient ya dentro de BEGIN */
  async saveWithClient(
    client: SqlClient,
    customer: Customer,
    passwordHash: string,
  ): Promise<void> {
    await this._upsertCustomer(client, customer, passwordHash);
  }

  // ── Lectura ───────────────────────────────────────────────────────────────

  async getById(id: string): Promise<Customer | undefined> {
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT} WHERE c.id = $1`,
      [id],
    );
    return rows.length ? rowsToCustomer(rows) : undefined;
  }

  async getAll(): Promise<Customer[]> {
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT} ORDER BY c.display_name ASC`,
    );
    return groupByCustomer(rows);
  }

  async getByEmail(email: string): Promise<Customer | undefined> {
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT}
       WHERE ccm.channel = 'EMAIL' AND LOWER(ccm.ccm_value) = LOWER($1)`,
      [email],
    );
    return rows.length ? rowsToCustomer(rows) : undefined;
  }

  async getByEmailWithPassword(email: string): Promise<CustomerWithPassword | undefined> {
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT}
       WHERE ccm.channel = 'EMAIL' AND LOWER(ccm.ccm_value) = LOWER($1)`,
      [email],
    );
    if (!rows.length || !rows[0].password_hash) return undefined;
    return { customer: rowsToCustomer(rows), passwordHash: rows[0].password_hash };
  }

  async searchByName(name: string): Promise<Customer[]> {
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT}
       WHERE c.display_name ILIKE $1
       ORDER BY c.display_name ASC`,
      [`%${name}%`],
    );
    return groupByCustomer(rows);
  }

  // ── Eliminación ───────────────────────────────────────────────────────────

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.sqlClient.query(
      `DELETE FROM customers WHERE id = $1`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async anonymize(id: string): Promise<boolean> {
    const { withTransaction } = await import('../db/pg.client.js');
    const result = await withTransaction(async (tx) => {
      await tx.query(
        `DELETE FROM customer_contact_methods WHERE customer_id = $1`,
        [id],
      );
      await tx.query(
        `INSERT INTO customer_contact_methods
           (id, customer_id, channel, value, is_primary)
         VALUES ($1, $2, 'EMAIL', $3, TRUE)
         ON CONFLICT DO NOTHING`,
        [`ccm-anon-${id}`, id, `deleted-${id}@anon.local`],
      );
      return tx.query(
        `UPDATE customers SET
           display_name  = '[eliminado]',
           full_name     = '[eliminado]',
           email         = $1,
           password_hash = NULL,
           updated_at    = CURRENT_TIMESTAMP
         WHERE id = $2
           AND display_name != '[eliminado]'`,
        [`deleted-${id}@anon.local`, id],
      );
    });
    return (result.rowCount ?? 0) > 0;
  }

  // ── Helpers privados ──────────────────────────────────────────────────────

  private async _upsertCustomer(
    client: SqlClient,
    customer: Customer,
    passwordHash: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO customers (id, display_name, full_name, email, password_hash)
       VALUES ($1, $2, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         display_name  = $2,
         full_name     = $2,
         email         = $3,
         password_hash = COALESCE($4, customers.password_hash),
         updated_at    = CURRENT_TIMESTAMP`,
      [customer.id, customer.displayName, customer.email, passwordHash],
    );
    for (const cm of customer.contactMethods) {
      await client.query(
        `INSERT INTO customer_contact_methods
           (id, customer_id, channel, value, is_primary)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (customer_id, channel, value) DO UPDATE SET
           is_primary = EXCLUDED.is_primary`,
        [cm.id ?? `ccm-${randomUUID()}`, customer.id, cm.channel, cm.value, cm.isPrimary],
      );
    }
  }
}

// ── Helpers de mapeo (funciones puras) ────────────────────────────────────

function rowsToCustomer(rows: CustomerRow[]): Customer {
  const { id, display_name } = rows[0];
  const contactMethods: ContactMethod[] = rows
    .filter((r) => r.ccm_id !== null)
    .map((r) => ({
      id:         r.ccm_id!,
      channel:    r.channel as ContactMethod['channel'],
      value:      r.ccm_value!,
      isPrimary:  r.is_primary ?? false,
      verifiedAt: r.verified_at ?? undefined,
    }));
  return new Customer(id, display_name, contactMethods);
}

function groupByCustomer(rows: CustomerRow[]): Customer[] {
  const map = new Map<string, CustomerRow[]>();
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, []);
    map.get(row.id)!.push(row);
  }
  return [...map.values()].map(rowsToCustomer);
}
