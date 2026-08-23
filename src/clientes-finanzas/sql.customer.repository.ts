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
import type { ContactMethod } from './customer.entities.js';
import { Customer } from './customer.entities.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { CustomerRepository, CustomerWithPassword, Tag, NewVsRecurringReport } from './customer.repository.js';

// ── Tipos internos ──────────────────────────────────────────────────────────

interface CustomerRow {
  id:              string;
  display_name:    string;
  password_hash:   string | null;
  kind:            string;
  active:          boolean;
  customer_number: number;
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
    c.customer_number,
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

  async getByGoogleSub(sub: string): Promise<Customer | undefined> {
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT} WHERE c.google_sub = $1`,
      [sub],
    );
    return rows.length ? rowsToCustomer(rows) : undefined;
  }

  async linkGoogleSub(customerId: string, sub: string): Promise<void> {
    await this.sqlClient.query(
      `UPDATE customers SET google_sub = $1, updated_at = NOW() WHERE id = $2`,
      [sub, customerId],
    );
  }

  async saveWithGoogle(customer: Customer, googleSub: string): Promise<void> {
    await this.sqlClient.query(
      `INSERT INTO customers (id, display_name, full_name, email, google_sub)
       VALUES ($1, $2, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         display_name = $2,
         full_name    = $2,
         email        = $3,
         google_sub   = $4,
         updated_at   = CURRENT_TIMESTAMP`,
      [customer.id, customer.displayName, customer.email, googleSub],
    );
    for (const cm of customer.contactMethods) {
      await this.sqlClient.query(
        `INSERT INTO customer_contact_methods
           (id, customer_id, channel, value, is_primary)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (customer_id, channel, value) DO UPDATE SET
           is_primary = EXCLUDED.is_primary`,
        [cm.id ?? `ccm-${randomUUID()}`, customer.id, cm.channel, cm.value, cm.isPrimary],
      );
    }
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

  async searchByTaxId(taxId: string): Promise<Customer[]> {
    const normalized = taxId.replace(/[-\s.]/g, '');
    const { rows } = await this.sqlClient.query<CustomerRow>(
      `${BASE_SELECT}
       WHERE EXISTS (
         SELECT 1 FROM customer_tax_profiles ctp
         WHERE ctp.customer_id = c.id AND ctp.tax_id = $1
       )
       ORDER BY c.display_name ASC`,
      [normalized],
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

  /**
   * Bug real encontrado y arreglado de paso (19/08/2026, sesión de la
   * cookie httpOnly del portal): usaba `withTransaction()` de
   * `db/pg.client.js`, que resuelve el pool desde `DATABASE_URL` — una
   * variable de entorno de la era single-tenant que ya no existe en
   * producción (`refactor: eliminar soporte single-tenant`). Cualquier
   * llamada real a `DELETE /api/customer/me` tiraba 500
   * ("DATABASE_URL no está definida"), sin importar la cookie/token —
   * este bug es previo y no tiene relación con la migración de auth.
   * Corregido usando `this.sqlClient` (el pool del TENANT, ya inyectado
   * por el constructor) igual que el resto de los métodos de esta clase
   * — ninguno de ellos envuelve sus escrituras multi-statement en una
   * transacción explícita tampoco, mismo criterio.
   */
  async anonymize(id: string): Promise<boolean> {
    await this.sqlClient.query(
      `DELETE FROM customer_contact_methods WHERE customer_id = $1`,
      [id],
    );
    await this.sqlClient.query(
      `INSERT INTO customer_contact_methods
         (id, customer_id, channel, value, is_primary)
       VALUES ($1, $2, 'EMAIL', $3, TRUE)
       ON CONFLICT DO NOTHING`,
      [`ccm-anon-${id}`, id, `deleted-${id}@anon.local`],
    );
    const result = await this.sqlClient.query(
      `UPDATE customers SET
         display_name  = '[eliminado]',
         full_name     = '[eliminado]',
         email         = $1,
         password_hash = NULL,
         google_sub    = NULL,
         updated_at    = CURRENT_TIMESTAMP
       WHERE id = $2
         AND display_name != '[eliminado]'`,
      [`deleted-${id}@anon.local`, id],
    );
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

  /**
   * D7 (22/08/2026) — ver docblock de la interfaz para las definiciones de
   * "activo"/"nuevo"/"recurrente". `lifetime_counts` cuenta TODA la
   * historia (sin filtro de fecha) a propósito -- "recurrente" es un
   * estado del cliente, no algo limitado a [from, to].
   */
  async getNewVsRecurringReport(from: Date, to: Date): Promise<NewVsRecurringReport> {
    const { rows } = await this.sqlClient.query<{
      new_customers: string;
      recurring_customers: string;
      active_customers: string;
    }>(
      `WITH active_customers AS (
         SELECT DISTINCT customer_id FROM reservations
           WHERE status IN ('CONFIRMED', 'COMPLETED') AND created_at >= $1 AND created_at <= $2
         UNION
         SELECT DISTINCT customer_id FROM orders
           WHERE status IN ('CONFIRMED', 'COMPLETED') AND confirmed_at >= $1 AND confirmed_at <= $2
       ),
       lifetime_counts AS (
         SELECT customer_id, COUNT(*) AS cnt FROM (
           SELECT customer_id FROM reservations WHERE status IN ('CONFIRMED', 'COMPLETED')
           UNION ALL
           SELECT customer_id FROM orders WHERE status IN ('CONFIRMED', 'COMPLETED')
         ) all_tx
         GROUP BY customer_id
       )
       SELECT
         COUNT(*) FILTER (WHERE c.created_at >= $1 AND c.created_at <= $2) AS new_customers,
         COUNT(*) FILTER (WHERE COALESCE(lc.cnt, 0) > 1) AS recurring_customers,
         COUNT(*) AS active_customers
       FROM active_customers ac
       JOIN customers c ON c.id = ac.customer_id
       LEFT JOIN lifetime_counts lc ON lc.customer_id = ac.customer_id`,
      [from, to],
    );

    const row = rows[0]!;
    return {
      newCustomersCount:       parseInt(row.new_customers, 10),
      recurringCustomersCount: parseInt(row.recurring_customers, 10),
      activeCustomersCount:    parseInt(row.active_customers, 10),
    };
  }

  // ── Helpers privados ──────────────────────────────────────────────────────

  /**
   * `customer_number` ($5, D6 22/08/2026) va en el INSERT pero A PROPÓSITO
   * NO en el ON CONFLICT SET -- distinto de sql.reservation.repository.ts
   * (que SÍ lo pone en las dos ramas). Ahí es seguro porque
   * `Reservation.reservationNumber` es obligatorio en el constructor; acá
   * `Customer.customerNumber` es opcional (varias decenas de
   * `new Customer(...)` posicionales en el repo, forzarlo a obligatorio
   * rompería todos). Esta rama del UPSERT se usa tanto para el alta real
   * como para CADA edición (PATCH /customers/:id, etc.) -- si
   * `customer_number` estuviera en el SET, un `Customer` reconstruido sin
   * pasar el número (ej. el PATCH de displayName) lo pisaría con NULL en
   * cada edición. Omitirlo del SET hace que la base ignore $5 salvo en el
   * INSERT real -- ninguna edición puede tocarlo, sin importar qué traiga
   * el objeto en memoria.
   */
  private async _upsertCustomer(
    client: SqlClient,
    customer: Customer,
    passwordHash: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO customers (id, display_name, full_name, email, password_hash, customer_number)
       VALUES ($1, $2, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         display_name  = $2,
         full_name     = $2,
         email         = $3,
         password_hash = COALESCE($4, customers.password_hash),
         updated_at    = CURRENT_TIMESTAMP`,
      [customer.id, customer.displayName, customer.email, passwordHash, customer.customerNumber],
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
  const { id, display_name, kind, active, customer_number } = first;
  const contactMethods: ContactMethod[] = rows
    .filter((r) => r.ccm_id !== null)
    .map((r) => ({
      id:        r.ccm_id!,
      channel:   r.channel as ContactMethod['channel'],
      value:     r.ccm_value!,
      isPrimary: r.is_primary ?? false,
      ...(r.verified_at !== null && r.verified_at !== undefined && { verifiedAt: r.verified_at }),
    }));
  return new Customer(id, display_name, contactMethods, kind as 'INDIVIDUAL' | 'COMPANY', active, customer_number);
}

function groupByCustomer(rows: CustomerRow[]): Customer[] {
  const map = new Map<string, CustomerRow[]>();
  for (const row of rows) {
    if (!map.has(row.id)) map.set(row.id, []);
    map.get(row.id)!.push(row);
  }
  return [...map.values()].map(rowsToCustomer);
}
