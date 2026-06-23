import { ReservationStatus, ResourceType } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationRepository } from './reservation.repository.js';
import { Customer } from '../domain/entities.js';
import {
  ResourceNotFoundError,
} from '../domain/errors.js';
import { PreferenceDetailsByResource } from '../types/preferences.types.js';
import { validatePreferences } from '../services/validation.factory.js';
import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';

interface ReservationRow {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_email: string;
  resource_id: string;
  resource_type: ResourceType;
  status: ReservationStatus;
  start_time: string | Date;
  end_time: string | Date;
  details: string | Record<string, unknown>;
}

/**
 * Implementación SQL del repositorio de reservas.
 * Funciona con PostgreSQL, MySQL, etc.
 *
 * Schema esperado (PostgreSQL):
 * ```sql
 * CREATE TABLE reservations (
 *   id VARCHAR(255) PRIMARY KEY,
 *   customer_id VARCHAR(255) NOT NULL,
 *   customer_name VARCHAR(255) NOT NULL,
 *   customer_email VARCHAR(255) NOT NULL,
 *   resource_id VARCHAR(255) NOT NULL,
 *   resource_type VARCHAR(50) NOT NULL,
 *   status VARCHAR(50) NOT NULL,
 *   start_time TIMESTAMP NOT NULL,
 *   end_time TIMESTAMP NOT NULL,
 *   details JSONB NOT NULL,
 *   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *   FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE
 * );
 *
 * CREATE INDEX idx_customer_id ON reservations(customer_id);
 * CREATE INDEX idx_resource_id ON reservations(resource_id);
 * CREATE INDEX idx_status ON reservations(status);
 * CREATE INDEX idx_date_range ON reservations(start_time, end_time);
 * ```
 */
export class SqlReservationRepository implements ReservationRepository {
  constructor(
    private readonly sqlClient: SqlClient,
    private readonly resourceRepository: ResourceRepository,
  ) {}

  async save(reservation: Reservation): Promise<void> {
    const sql = `
      INSERT INTO reservations (
        id, customer_id, customer_name, customer_email,
        resource_id, resource_type, status,
        start_time, end_time, details, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        status = $7,
        details = $10,
        updated_at = CURRENT_TIMESTAMP
    `.trim();

    await this.sqlClient.query(sql, [
      reservation.id,
      reservation.customer.id,
      reservation.customer.fullName,
      reservation.customer.email,
      reservation.resource.id,
      reservation.resourceType,
      reservation.status,
      reservation.startTime.toISOString(),
      reservation.endTime.toISOString(),
      JSON.stringify(reservation.details),
    ]);
  }

  async getById(id: string): Promise<Reservation | undefined> {
    const sql = `SELECT * FROM reservations WHERE id = $1`;
    const result = await this.sqlClient.query(sql, [id]);
    const row = (result.rows as ReservationRow[])[0];
    return row ? await this.rowToReservation(row) : undefined;
  }

  async getByCustomerId(customerId: string): Promise<Reservation[]> {
    const sql = `
      SELECT * FROM reservations
      WHERE customer_id = $1
      ORDER BY start_time DESC
    `;
    const result = await this.sqlClient.query(sql, [customerId]);
    return Promise.all(
      (result.rows as ReservationRow[]).map((row) => this.rowToReservation(row)),
    );
  }

  async getByResourceId(resourceId: string): Promise<Reservation[]> {
    const sql = `
      SELECT * FROM reservations
      WHERE resource_id = $1
      ORDER BY start_time DESC
    `;
    const result = await this.sqlClient.query(sql, [resourceId]);
    return Promise.all(
      (result.rows as ReservationRow[]).map((row) => this.rowToReservation(row)),
    );
  }

  async getByStatus(status: ReservationStatus): Promise<Reservation[]> {
    const sql = `
      SELECT * FROM reservations
      WHERE status = $1
      ORDER BY start_time DESC
    `;
    const result = await this.sqlClient.query(sql, [status]);
    return Promise.all(
      (result.rows as ReservationRow[]).map((row) => this.rowToReservation(row)),
    );
  }

  async getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    const sql = `
      SELECT * FROM reservations
      WHERE start_time < $2 AND end_time > $1
      ORDER BY start_time ASC
    `;
    const result = await this.sqlClient.query(sql, [
      startDate.toISOString(),
      endDate.toISOString(),
    ]);
    return Promise.all(
      (result.rows as ReservationRow[]).map((row) => this.rowToReservation(row)),
    );
  }

  async getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    const blockingStatuses = [
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ];

    const sql = `
      SELECT * FROM reservations
      WHERE resource_id = $1
        AND status = ANY($4)
        AND start_time < $3
        AND end_time > $2
      ORDER BY start_time ASC
    `;

    const result = await this.sqlClient.query(sql, [
      resourceId,
      startDate.toISOString(),
      endDate.toISOString(),
      blockingStatuses,
    ]);
    return Promise.all(
      (result.rows as ReservationRow[]).map((row) => this.rowToReservation(row)),
    );
  }

  async delete(id: string): Promise<boolean> {
    const sql = `DELETE FROM reservations WHERE id = $1`;
    const result = await this.sqlClient.query(sql, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getAll(): Promise<Reservation[]> {
    const sql = `
      SELECT * FROM reservations
      ORDER BY start_time DESC
    `;
    const result = await this.sqlClient.query(sql);
    return Promise.all(
      (result.rows as ReservationRow[]).map((row) => this.rowToReservation(row)),
    );
  }

  private async rowToReservation(row: ReservationRow): Promise<Reservation> {
    const resource = await this.resourceRepository.getById(row.resource_id);
    if (!resource) {
      throw new ResourceNotFoundError(row.resource_id);
    }

    const rawDetails =
      typeof row.details === 'string' ? JSON.parse(row.details) : row.details;

    const details = validatePreferences(row.resource_type, rawDetails);

    const customer = new Customer(
      row.customer_id,
      row.customer_name,
      row.customer_email,
    );

    const reservation = new Reservation(
      row.resource_type,
      row.id,
      customer,
      resource,
      new Date(row.start_time),
      new Date(row.end_time),
      details as PreferenceDetailsByResource[typeof row.resource_type],
    );

    if (row.status !== reservation.status) {
      reservation.status = row.status;
    }

    return reservation;
  }
}
