import { ReservationStatus } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationRepository, ReservationFilters } from './reservation.repository.js';
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
  customer_email: string | null;
  resource_id: string;
  status: ReservationStatus;
  start_time: string | Date;
  end_time: string | Date;
  details: string | Record<string, unknown>;
  service_id?: string | null;
  party_size?: number | null;
  notes?: string | null;
  order_item_id?: string | null;
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
 * - **Resource**: resuelto via `resourceRepository.getById()`.
 *
 * ## Política de email nulo
 * Se almacena NULL en la DB cuando el cliente no tiene email (en lugar de '').
 * Al leer, `null` se convierte en el array vacío de contactMethods,
 * dejando `email` como `undefined`.
 *
 * ## getFiltered()
 * Construye la cláusula WHERE dinámicamente con parámetros numerados
 * para evitar inyección SQL. Soporta filtros AND combinables:
 * status, resourceId, customerId, rango from/to (solapamiento de intervalos).
 * Sin filtros es equivalente a getAll().
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
      reservation.customer.email ?? null,
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

  /**
   * Devuelve reservas que satisfacen TODOS los filtros provistos (AND).
   * Sin filtros es equivalente a getAll().
   *
   * El rango from/to usa lógica de solapamiento de intervalos:
   * una reserva aparece si su intervalo [start_time, end_time) se
   * intersecta con [from, to), es decir:
   *   r.end_time > from AND r.start_time < to
   */
  async getFiltered(filters: ReservationFilters): Promise<Reservation[]> {
    const conditions: string[] = [];
    const params: unknown[]    = [];

    if (filters.status !== undefined) {
      params.push(filters.status);
      conditions.push(`r.status = $${params.length}`);
    }

    if (filters.resourceId !== undefined) {
      params.push(filters.resourceId);
      conditions.push(`r.resource_id = $${params.length}`);
    }

    if (filters.customerId !== undefined) {
      params.push(filters.customerId);
      conditions.push(`r.customer_id = $${params.length}`);
    }

    if (filters.from !== undefined && filters.to !== undefined) {
      params.push(filters.from.toISOString());
      conditions.push(`r.end_time > $${params.length}`);
      params.push(filters.to.toISOString());
      conditions.push(`r.start_time < $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql   = `${this.baseSelect()} ${where} ORDER BY r.start_time DESC`;

    const result = await this.sqlClient.query<ReservationRow>(sql, params);
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
        r.details,
        r.service_id,
        r.party_size,
        r.notes,
        r.order_item_id
      FROM reservations r
    `;
  }

  private async rowToReservation(row: ReservationRow): Promise<Reservation> {
    const customer = row.customer_email
      ? new Customer(row.customer_id, row.customer_name, row.customer_email)
      : new Customer(row.customer_id, row.customer_name, []);

    const resource = await this.resourceRepository.getById(row.resource_id);
    if (!resource) {
      throw new ResourceNotFoundError(row.resource_id);
    }

    const details =
      typeof row.details === 'string' ? JSON.parse(row.details) : row.details;

    return Reservation.restore({
      id:            row.id,
      customer,
      resource,
      startTime:     new Date(row.start_time),
      endTime:       new Date(row.end_time),
      details,
      initialStatus: row.status,
      serviceId:     row.service_id    ?? null,
      partySize:     row.party_size    ?? 1,
      notes:         row.notes         ?? null,
      orderItemId:   row.order_item_id ?? null,
    });
  }
}
