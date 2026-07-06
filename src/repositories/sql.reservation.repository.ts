import { ReservationStatus } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationRepository } from './reservation.repository.js';
import { Customer } from '../domain/entities.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';

// ---------------------------------------------------------------------------
// Tipos de fila
// ---------------------------------------------------------------------------

interface ReservationRow {
  id: string;
  customer_id: string;
  customer_name: string;
  customer_email: string | null;  // NULL en DB cuando el cliente no tiene email
  resource_id: string;
  status: ReservationStatus;
  start_time: string | Date;
  end_time: string | Date;
  details: string | Record<string, unknown>;
}

/**
 * Implementación SQL del repositorio de reservas.
 *
 * ## Estrategia de deserialización
 * `rowToReservation` reconstruye el objeto `Reservation` completo sin
 * queries adicionales:
 * - **Customer**: reconstruido desde los campos desnormalizados
 *   `customer_name` y `customer_email` que viven en la tabla `reservations`.
 *   No se necesita un `CustomerRepository` para lectura.
 * - **Resource**: resuelto via `resourceRepository.getById()` — necesario
 *   para instanciar el recurso correcto.
 *
 * ## Política de email nulo
 * Se almacena NULL en la DB cuando el cliente no tiene email (en lugar de '').
 * Esto alinea la persistencia con el dominio, donde `Customer.email` es
 * `string | undefined`. Al leer, `null` se convierte en el array vacío de
 * contactMethods, dejando `email` como `undefined`.
 *
 * ## Constructor
 * - `sqlClient`          — cliente SQL genérico (pg pool)
 * - `resourceRepository` — para resolver el recurso en lectura
 *
 * Schema esperado (PostgreSQL):
 * ```sql
 * CREATE TABLE reservations (
 *   id VARCHAR(255) PRIMARY KEY,
 *   customer_id VARCHAR(255) NOT NULL,
 *   customer_name VARCHAR(255) NOT NULL,
 *   customer_email VARCHAR(255),        -- nullable
 *   resource_id VARCHAR(255) NOT NULL,
 *   status VARCHAR(50) NOT NULL,
 *   start_time TIMESTAMP NOT NULL,
 *   end_time TIMESTAMP NOT NULL,
 *   details JSONB NOT NULL,
 *   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *   updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *   FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE CASCADE,
 *   FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
 * );
 * ```
 */
export class SqlReservationRepository implements ReservationRepository {
  constructor(
    private readonly sqlClient: SqlClient,
    private readonly resourceRepository: ResourceRepository,
  ) {}

  // -------------------------------------------------------------------------
  // Escritura
  // -------------------------------------------------------------------------

  private buildSaveParams(reservation: Reservation): unknown[] {
    return [
      reservation.id,
      reservation.customer.id,
      reservation.customer.fullName,
      reservation.customer.email ?? null,   // NULL en DB, no string vacío
      reservation.resource.id,
      reservation.status,
      reservation.startTime.toISOString(),
      reservation.endTime.toISOString(),
      JSON.stringify(reservation.details),
    ];
  }

  private readonly UPSERT_SQL = `
    INSERT INTO reservations (
      id, customer_id, customer_name, customer_email,
      resource_id, status,
      start_time, end_time, details, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP)
    ON CONFLICT (id) DO UPDATE SET
      status     = $6,
      details    = $9,
      updated_at = CURRENT_TIMESTAMP
  `.trim();

  async save(reservation: Reservation): Promise<void> {
    await this.sqlClient.query(this.UPSERT_SQL, this.buildSaveParams(reservation));
  }

  /**
   * Versión transaccional de save().
   * Usa el SqlClient recibido — no adquiere una conexión nueva.
   * Llamar solo desde dentro de TransactionManager.run().
   */
  async saveWithClient(client: SqlClient, reservation: Reservation): Promise<void> {
    await client.query(this.UPSERT_SQL, this.buildSaveParams(reservation));
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.sqlClient.query(
      `DELETE FROM reservations WHERE id = $1`,
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  async getById(id: string): Promise<Reservation | undefined> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()} WHERE r.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? await this.rowToReservation(row) : undefined;
  }

  async getByCustomerId(customerId: string): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()} WHERE r.customer_id = $1 ORDER BY r.start_time DESC`,
      [customerId],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getByResourceId(resourceId: string): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()} WHERE r.resource_id = $1 ORDER BY r.start_time DESC`,
      [resourceId],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getByStatus(status: ReservationStatus): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()} WHERE r.status = $1 ORDER BY r.start_time DESC`,
      [status],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getByDateRange(startDate: Date, endDate: Date): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()}
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
    const blockingStatuses = [
      ReservationStatus.PENDING,
      ReservationStatus.CONFIRMED,
    ];

    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()}
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
      `${this.baseSelect()} ORDER BY r.start_time DESC`,
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  // -------------------------------------------------------------------------
  // Helpers privados
  // -------------------------------------------------------------------------

  private baseSelect(): string {
    return `
      SELECT
        r.id,
        r.customer_id,
        r.customer_name,
        r.customer_email,
        r.resource_id,
        r.status,
        r.start_time,
        r.end_time,
        r.details
      FROM reservations r
    `;
  }

  private async rowToReservation(row: ReservationRow): Promise<Reservation> {
    // customer_email puede ser NULL — se pasa como string o como array vacío
    // para que Customer quede con email === undefined (sin contact EMAIL).
    const customer = row.customer_email
      ? new Customer(row.customer_id, row.customer_name, row.customer_email)
      : new Customer(row.customer_id, row.customer_name, []);

    const resource = await this.resourceRepository.getById(row.resource_id);
    if (!resource) {
      throw new ResourceNotFoundError(row.resource_id);
    }

    const details =
      typeof row.details === 'string' ? JSON.parse(row.details) : row.details;

    return Reservation.restore(
      row.id,
      customer,
      resource,
      new Date(row.start_time),
      new Date(row.end_time),
      details,
      row.status,
    );
  }
}
