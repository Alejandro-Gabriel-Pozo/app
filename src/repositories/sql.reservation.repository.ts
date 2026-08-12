import { ReservationStatus } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { ReservationRepository, ReservationFilters } from './reservation.repository.js';
import { Customer } from '../domain/entities.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import { SqlClient } from './sql.client.js';
import { ResourceRepository } from './resource.repository.js';

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
  total_price: string;
}

/**
 * Implementación SQL del repositorio de reservas.
 *
 * ## getFiltered() / countFiltered()
 * buildWhereClause() construye la cláusula WHERE dinámicamente.
 * getFiltered() aplica LIMIT/OFFSET cuando page+limit están presentes.
 * countFiltered() corre SELECT COUNT(*) con los mismos filtros (sin paginar)
 * para poder construir el envelope paginado { data, total, page, limit, totalPages }.
 *
 * ## getActiveForResourceInRangeWithLock()
 * Igual que getActiveForResourceInRange pero añade FOR UPDATE al final
 * de la query. Debe llamarse dentro de una transacción activa.
 * Bloquea las filas solapadas hasta COMMIT, serializando las escrituras
 * concurrentes al mismo slot de recurso.
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
      reservation.totalPrice,
    ];
  }

  // total_price es NOT NULL sin default en la tabla (db/schema.sql) — antes de
  // este fix no estaba en esta lista y CADA INSERT fallaba con una violación
  // de NOT NULL. También faltaba en el ON CONFLICT: un update de reserva
  // nunca actualizaba el precio aunque cambiara.
  private readonly UPSERT_SQL = `
    INSERT INTO reservations (
      id, customer_id, customer_name, customer_email,
      resource_id, status,
      start_time, end_time, details, updated_at, total_price
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, $10)
    ON CONFLICT (id) DO UPDATE SET
      status      = $6,
      details     = $9,
      updated_at  = CURRENT_TIMESTAMP,
      total_price = $10
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
  // Lectura — métodos específicos
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
      `${this.baseSelect()} WHERE r.start_time < $2 AND r.end_time > $1 ORDER BY r.start_time ASC`,
      [startDate.toISOString(), endDate.toISOString()],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  /**
   * Reservas PENDING + CONFIRMED que solapan el rango.
   * Usado en contextos de solo lectura (checkAvailability, GET /availability).
   * NO emite lock — no usar para chequeos que preceden a un INSERT/UPDATE.
   */
  async getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    const blockingStatuses = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()}
       WHERE r.resource_id = $1
         AND r.status = ANY($4)
         AND r.start_time < $3
         AND r.end_time   > $2
       ORDER BY r.start_time ASC`,
      [resourceId, startDate.toISOString(), endDate.toISOString(), blockingStatuses],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  /**
   * Igual que getActiveForResourceInRange pero añade FOR UPDATE.
   *
   * FOR UPDATE bloquea las filas que solapan el rango hasta que la
   * transacción actual haga COMMIT o ROLLBACK. Cualquier otra transacción
   * que quiera leer o escribir esas filas (o insertar una nueva que las
   * solape) debe esperar, serializando la verificación de disponibilidad
   * más el INSERT que sigue.
   *
   * @param client    - SqlClient dentro de la transacción activa (de transactionManager.run).
   * @param resourceId
   * @param startDate
   * @param endDate
   */
  async getActiveForResourceInRangeWithLock(
    client: SqlClient,
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    const blockingStatuses = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
    // baseSelect() usa `this.sqlClient` internamente para rowToReservation,
    // pero la QUERY de disponibilidad se emite sobre `client` (transaccional).
    const result = await client.query<ReservationRow>(
      `${this.baseSelect()}
       WHERE r.resource_id = $1
         AND r.status = ANY($4)
         AND r.start_time < $3
         AND r.end_time   > $2
       ORDER BY r.start_time ASC
       FOR UPDATE`,
      [resourceId, startDate.toISOString(), endDate.toISOString(), blockingStatuses],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  /** Ver doc en reservation.repository.ts — busca por r.service_id, no r.resource_id. */
  async getActiveForServiceInRange(
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    const blockingStatuses = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()}
       WHERE r.service_id = $1
         AND r.status = ANY($4)
         AND r.start_time < $3
         AND r.end_time   > $2
       ORDER BY r.start_time ASC`,
      [serviceId, startDate.toISOString(), endDate.toISOString(), blockingStatuses],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getActiveForServiceInRangeWithLock(
    client: SqlClient,
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    const blockingStatuses = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
    const result = await client.query<ReservationRow>(
      `${this.baseSelect()}
       WHERE r.service_id = $1
         AND r.status = ANY($4)
         AND r.start_time < $3
         AND r.end_time   > $2
       ORDER BY r.start_time ASC
       FOR UPDATE`,
      [serviceId, startDate.toISOString(), endDate.toISOString(), blockingStatuses],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  // -------------------------------------------------------------------------
  // Filtrado genérico + paginación
  // -------------------------------------------------------------------------

  /**
   * Construye WHERE y params compartidos entre getFiltered() y countFiltered().
   * El rango from/to usa solapamiento de intervalos:
   *   r.end_time > from AND r.start_time < to
   */
  private buildWhereClause(
    filters: Omit<ReservationFilters, 'page' | 'limit'>,
  ): { conditions: string[]; params: unknown[] } {
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

    return { conditions, params };
  }

  async getFiltered(filters: ReservationFilters): Promise<Reservation[]> {
    const { conditions, params } = this.buildWhereClause(filters);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    let sql = `${this.baseSelect()} ${where} ORDER BY r.start_time DESC`;

    if (filters.limit !== undefined && filters.page !== undefined) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
      params.push((filters.page - 1) * filters.limit);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await this.sqlClient.query<ReservationRow>(sql, params);
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async countFiltered(
    filters: Omit<ReservationFilters, 'page' | 'limit'>,
  ): Promise<number> {
    const { conditions, params } = this.buildWhereClause(filters);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await this.sqlClient.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM reservations r ${where}`,
      params,
    );
    return parseInt(result.rows[0]?.count ?? '0', 10);
  }

  /** @deprecated Usar getFiltered({}) para consistencia. Se mantiene por compatibilidad. */
  async getAll(): Promise<Reservation[]> {
    return this.getFiltered({});
  }

  // -------------------------------------------------------------------------
  // Helpers privados
  // -------------------------------------------------------------------------

  private baseSelect(): string {
    return `
      SELECT
        r.id, r.customer_id, r.customer_name, r.customer_email,
        r.resource_id, r.status, r.start_time, r.end_time, r.details,
        r.service_id, r.party_size, r.notes, r.order_item_id, r.total_price
      FROM reservations r
    `;
  }

  private async rowToReservation(row: ReservationRow): Promise<Reservation> {
    const customer = row.customer_email
      ? new Customer(row.customer_id, row.customer_name, row.customer_email)
      : new Customer(row.customer_id, row.customer_name, []);

    const resource = await this.resourceRepository.getById(row.resource_id);
    if (!resource) throw new ResourceNotFoundError(row.resource_id);

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
      totalPrice:    parseFloat(row.total_price),
    });
  }
}
