import { Customer } from '../domain/entities.js';
import { SqlClient } from './sql.client.js';
import { CustomerRepository } from './customer.repository.js';

interface CustomerRow {
  id: string;
  full_name: string;
  email: string;
}

/**
 * Implementación SQL del repositorio de clientes.
 *
 * Schema esperado (PostgreSQL):
 * ```sql
 * CREATE TABLE customers (
 *   id VARCHAR(255) PRIMARY KEY,
 *   full_name VARCHAR(255) NOT NULL,
 *   email VARCHAR(255) NOT NULL UNIQUE,
 *   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
 * );
 *
 * -- Índice funcional necesario para que getByEmail() use el índice B-tree.
 * -- Sin él, WHERE LOWER(email) = LOWER($1) fuerza un seq-scan.
 * CREATE UNIQUE INDEX idx_customers_email_lower ON customers(LOWER(email));
 *
 * -- Para searchByName eficiente en producción:
 * -- CREATE EXTENSION IF NOT EXISTS pg_trgm;
 * -- CREATE INDEX idx_customers_name_trgm ON customers USING gin(full_name gin_trgm_ops);
 * ```
 */
export class SqlCustomerRepository implements CustomerRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async save(customer: Customer): Promise<void> {
    // updated_at se omite del INSERT — la columna tiene DEFAULT CURRENT_TIMESTAMP
    // en el schema. Solo se actualiza explícitamente en el ON CONFLICT.
    const sql = `
      INSERT INTO customers (id, full_name, email)
      VALUES ($1, $2, $3)
      ON CONFLICT (id) DO UPDATE SET
        full_name  = $2,
        email      = $3,
        updated_at = CURRENT_TIMESTAMP
    `.trim();
    await this.sqlClient.query(sql, [customer.id, customer.fullName, customer.email]);
  }

  async getById(id: string): Promise<Customer | undefined> {
    const result = await this.sqlClient.query<CustomerRow>(
      `SELECT id, full_name, email FROM customers WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? this.rowToCustomer(row) : undefined;
  }

  async getAll(): Promise<Customer[]> {
    const result = await this.sqlClient.query<CustomerRow>(
      `SELECT id, full_name, email FROM customers ORDER BY full_name ASC`,
    );
    return result.rows.map((r) => this.rowToCustomer(r));
  }

  /**
   * Lookup por email case-insensitive.
   * Requiere el índice funcional `idx_customers_email_lower` (ver schema).
   * Sin ese índice el query hace seq-scan en tablas grandes.
   */
  async getByEmail(email: string): Promise<Customer | undefined> {
    const result = await this.sqlClient.query<CustomerRow>(
      `SELECT id, full_name, email FROM customers WHERE LOWER(email) = LOWER($1)`,
      [email],
    );
    const row = result.rows[0];
    return row ? this.rowToCustomer(row) : undefined;
  }

  /**
   * Búsqueda parcial por nombre (ILIKE).
   * Nota: usa un índice GIN con pg_trgm si está disponible;
   * sin él hace seq-scan en tablas grandes.
   */
  async searchByName(name: string): Promise<Customer[]> {
    const result = await this.sqlClient.query<CustomerRow>(
      `SELECT id, full_name, email
       FROM customers
       WHERE full_name ILIKE $1
       ORDER BY full_name ASC`,
      [`%${name}%`],
    );
    return result.rows.map((r) => this.rowToCustomer(r));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.sqlClient.query(
      `DELETE FROM customers WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private rowToCustomer(row: CustomerRow): Customer {
    return new Customer(row.id, row.full_name, row.email);
  }
}
