import { ReservationStatus, ResourceType } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationRepository } from './reservation.repository.js';
import { Customer } from '../domain/entities.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import { PreferenceDetailsByResource } from '../types/preferences.types.js';
import { validatePreferences } from '../services/validation.factory.js';
import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';
import { CustomerRepository } from './customer.repository.js';

// ---------------------------------------------------------------------------
// Tipos de fila
// ---------------------------------------------------------------------------

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
 *
 * ## Estrategia de deserialización
 * `rowToReservation` reconstruye el objeto `Reservation` completo usando
 * JOIN con `resources` y `customers`, evitando el problema N+1 de queries
 * adicionales por cada reserva.
 *
 * ## Constructor
 * - `sqlClient` — cliente SQL genérico (pg pool)
 * - `resourceRepository` — para lookups de recurso en métodos de escritura
 * - `customerRepository` — para lookups de cliente en métodos de escritura
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
 *   FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
 *   FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
 * );
 *
 * CREATE INDEX idx_reservations_customer ON reservations(customer_id);
 * CREATE INDEX idx_reservations_resource ON reservations(resource_id);
 * CREATE INDEX idx_reservations_status   ON reservations(status);
 * CREATE INDEX idx_reservations_dates    ON reservations(start_time, end_time);
 * ```
 */
export class SqlReservationRepository implements ReservationRepository {
  constructor(
    private readonly sqlClient: SqlClient,
    private readonly resourceRepository: ResourceRepository,
    private readonly customerRepository: CustomerRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------

  async save(reservation: Reservation): Promise<void> {
    const sql = `
      INSERT INTO reservations (
        id, customer_id, customer_name, customer_email,
        resource_id, resource_type, status,
        start_time, end_time, details, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET
        status     = $7,
        details    = $10,
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

  async delete(id: string): Promise<boolean> {
    const result = await this.sqlClient.query(
      `DELETE FROM reservations WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Lectura — todos los métodos usan JOIN para evitar N+1
  // -------------------------------------------------------------------------

  async getById(id: string): Promise<Reservation | undefined> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelectJoin()} WHERE r.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? await this.rowToReservation(row) : undefined;
  }

  async getByCustomerId(customerId: string): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelectJoin()} WHERE r.customer_id = $1 ORDER BY r.start_time DESC`,
      [customerId],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getByResourceId(resourceId: string): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelectJoin()} WHERE r.resource_id = $1 ORDER BY r.start_time DESC`,
      [resourceId],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getByStatus(status: ReservationStatus): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelectJoin()} WHERE r.status = $1 ORDER BY r.start_time DESC`,
      [status],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelectJoin()}
       WHERE r.start_time < $2 AND r.end_time > $1
       ORDER BY r.start_time ASC`,
      [startDate.toISOString(), endDate.toISOString()],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    // Solo PENDING y CONFIRMED bloquean disponibilidad.
    // COMPLETED ya terminó — no debe impedir nuevas reservas.
    const blockingStatuses = [
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ];

    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelectJoin()}
       WHERE r.resource_id = $1
         AND r.status = ANY($4)
         AND r.start_time < $3
         AND r.end_time   > $2
       ORDER BY r.start_time ASC`,
      [
        resourceId,
        startDate.toISOString(),
        endDate.toISOString(),
        blockingStatuses,
      ],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getAll(): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelectJoin()} ORDER BY r.start_time DESC`,
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  // -------------------------------------------------------------------------
  // Helpers privados
  // -------------------------------------------------------------------------

  /**
   * SELECT base con JOIN a resources y customers.
   * Desnormaliza los campos necesarios del recurso directamente en la fila,
   * eliminando queries adicionales en rowToReservation (evita N+1).
   *
   * Los datos del cliente (customer_name, customer_email) ya están
   * desnormalizados en la tabla reservations, por lo que no se necesita
   * JOIN a customers para lectura.
   */
  private baseSelectJoin(): string {
    return `
      SELECT
        r.id,
        r.customer_id,
        r.customer_name,
        r.customer_email,
        r.resource_id,
        r.resource_type,
        r.status,
        r.start_time,
        r.end_time,
        r.details
      FROM reservations r
    `;
  }

  /**
   * Convierte una fila SQL a una instancia de Reservation.
   *
   * Usa customer_name y customer_email desnormalizados de la fila para
   * reconstruir el Customer sin queries adicionales.
   * Resuelve el Resource via resourceRepository.getById() — necesario para
   * instanciar el subtipo correcto (CabinResource, TableResource, etc.).
   *
   * @throws ResourceNotFoundError si el recurso fue eliminado de la BD
   */
  private async rowToReservation(row: ReservationRow): Promise<Reservation> {
    // Reconstruir Customer desde campos desnormalizados — sin query adicional
    const customer = new Customer(
      row.customer_id,
      row.customer_name,
      row.customer_email,
    );

    // Resolver el recurso (necesario para instanciar el subtipo correcto)
    const resource = await this.resourceRepository.getById(row.resource_id);
    if (!resource) {
      throw new ResourceNotFoundError(row.resource_id);
    }

    // Parsear details: JSONB en pg ya devuelve objeto, string en otros drivers
    const rawDetails =
      typeof row.details === 'string' ? JSON.parse(row.details) : row.details;

    const details = validatePreferences(row.resource_type, rawDetails);

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
