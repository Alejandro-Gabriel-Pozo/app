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
import { CustomerRepository, CustomerWithPassword, Tag } from './customer.repository.js';

// ── Tipos internos ──────────────────────────────────────────────────────────

interface CustomerRow {
  id:            string;
  display_name:  string;
  password_hash: string | null;
  kind:          string;
  active:        boolean;
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
    c.kind,
    c.active,
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
       WHERE ccm.channel = 'EMAIL' AND LOWER(ccm.value) = LOWER($1)`,
      [email],
    );
    return rows.length ? rowsToCustomer(rows) : undefined;
  }

  async getByEmailWithPassword(email: string): Promise<CustomerWithPassword | undefined> {
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT}
       WHERE ccm.channel = 'EMAIL' AND LOWER(ccm.value) = LOWER($1)`,
      [email],
    );
    if (!rows.length || !rows[0]?.password_hash) return undefined;
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

  // ── Clientes especiales (kind/active/tags) ──────────────────────────────

  async updateKindAndActive(customerId: string, kind: 'INDIVIDUAL' | 'COMPANY', active: boolean): Promise<void> {
    await this.sqlClient.query(
      `UPDATE customers SET kind = $2, active = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [customerId, kind, active],
    );
  }

  async getTagsByCustomerId(customerId: string): Promise<Tag[]> {
    const { rows } = await this.sqlClient.query<Tag>(
      `SELECT t.id, t.name
       FROM tags t
       JOIN customer_tags ct ON ct.tag_id = t.id
       WHERE ct.customer_id = $1
       ORDER BY t.name ASC`,
      [customerId],
    );
    return rows;
  }

  async getAllTags(): Promise<Tag[]> {
    const { rows } = await this.sqlClient.query<Tag>(
      `SELECT id, name FROM tags ORDER BY name ASC`,
    );
    return rows;
  }

  async findOrCreateTagByName(name: string): Promise<Tag> {
    const inserted = await this.sqlClient.query<Tag>(
      `INSERT INTO tags (id, name) VALUES ($1, $2)
       ON CONFLICT (name) DO NOTHING
       RETURNING id, name`,
      [`tag-${randomUUID()}`, name],
    );
    if (inserted.rows[0]) return inserted.rows[0];

    // ON CONFLICT DO NOTHING no devuelve fila cuando ya existía — se busca aparte.
    const existing = await this.sqlClient.query<Tag>(
      `SELECT id, name FROM tags WHERE name = $1`,
      [name],
    );
    return existing.rows[0]!;
  }

  async addTag(customerId: string, tagId: string): Promise<void> {
    await this.sqlClient.query(
      `INSERT INTO customer_tags (customer_id, tag_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [customerId, tagId],
    );
  }

  async removeTag(customerId: string, tagId: string): Promise<void> {
    await this.sqlClient.query(
      `DELETE FROM customer_tags WHERE customer_id = $1 AND tag_id = $2`,
      [customerId, tagId],
    );
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
  const first = rows[0];
  if (!first) throw new Error('rowsToCustomer llamado con array vacío');
  const { id, display_name, kind, active } = first;
  const contactMethods: ContactMethod[] = rows
    .filter((r) => r.ccm_id !== null)
    .map((r) => ({
      id:        r.ccm_id!,
      channel:   r.channel as ContactMethod['channel'],
      value:     r.ccm_value!,
      isPrimary: r.is_primary ?? false,
      ...(r.verified_at !== null && r.verified_at !== undefined && { verifiedAt: r.verified_at }),
    }));
  return new Customer(id, display_name, contactMethods, kind as 'INDIVIDUAL' | 'COMPANY', active);
}

function groupByCustomer(rows: CustomerRow[]): Customer[] {
  const map = new Map<string, CustomerRow[]>();
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, []);
    map.get(row.id)!.push(row);
  }
  return [...map.values()].map(rowsToCustomer);
}
