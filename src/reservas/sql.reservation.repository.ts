import { ReservationStatus } from '../types/enums.js';
import { Reservation } from './Reservation.js';
import type { ReservationRepository, ReservationFilters } from './reservation.repository.js';
import { resolveReservationsLimit } from './reservation.repository.js';
import type { ReservationCustomer } from './reservation-customer.entities.js';
import { ResourceNotFoundError } from '../domain/errors.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { ResourceRepository } from './resource.repository.js';
import type { ReservationLine } from './reservation.types.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';
import type { CancellationPolicySnapshot } from './cancellation-policy.repository.js';

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
  adultos?: number | null;
  ninos?: number | null;
  rate_plan_id?: string | null;
  requested_check_in_time?: string | null;
  requested_check_out_time?: string | null;
  schedule_approval_status?: 'PENDING' | 'APPROVED' | 'REJECTED' | null;
  schedule_approved_by?: string | null;
  schedule_charge_amount?: string | null;
  deposit_amount: string;
  deposit_due_by?: string | Date | null;
  reservation_number: number;
  applied_customer_rate_id: string | null;
  needs_maintenance_review?: boolean | null;
  is_exclusive_resource?: boolean | null;
  cancellation_policy_snapshot?: string | CancellationPolicySnapshot | null;
}

/**
 * Implementación SQL del repositorio de reservas.
 *
 * ## getFiltered() / countFiltered()
 * buildWhereClause() construye la cláusula WHERE dinámicamente.
 * getFiltered() SIEMPRE aplica LIMIT/OFFSET (D-14, limit/offset con default
 * 50 y tope 200 -- ver resolveReservationsLimit() en reservation.repository.ts).
 * countFiltered() corre SELECT COUNT(*) con los mismos filtros (sin paginar)
 * para poder construir el envelope { data, limit, offset, total, hasMore }.
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
      reservation.serviceId,
      reservation.partySize,
      reservation.notes,
      reservation.orderItemId,
      reservation.adultos,
      reservation.ninos,
      reservation.ratePlanId,
      reservation.requestedCheckInTime,
      reservation.requestedCheckOutTime,
      reservation.scheduleApprovalStatus,
      reservation.scheduleApprovedBy,
      reservation.scheduleChargeAmount,
      reservation.depositAmount,
      reservation.depositDueBy ? reservation.depositDueBy.toISOString() : null,
      reservation.reservationNumber,
      reservation.appliedCustomerRateId,
      reservation.needsMaintenanceReview,
      reservation.isExclusiveResource,
      // CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) -- JSONB o NULL,
      // mismo criterio que `details` ($9) más arriba: serializado acá,
      // parseado de vuelta en rowToReservation(). `null` viaja tal cual
      // (columna nullable) -- no hay "sin política" vs. "política vacía"
      // que distinguir en este nivel.
      reservation.cancellationPolicySnapshot ? JSON.stringify(reservation.cancellationPolicySnapshot) : null,
    ];
  }

  // total_price es NOT NULL sin default en la tabla (db/schema.sql) — antes de
  // este fix no estaba en esta lista y CADA INSERT fallaba con una violación
  // de NOT NULL. También faltaba en el ON CONFLICT: un update de reserva
  // nunca actualizaba el precio aunque cambiara.
  //
  // resource_id/start_time/end_time faltaban también en el ON CONFLICT
  // (bug encontrado 18/08/2026 al agregar drag-to-move/resize al calendario):
  // updateReservation() pasaba estos valores en buildSaveParams() pero el
  // UPDATE nunca los tocaba, así que mover o redimensionar una reserva no
  // persistía nada — el 200 que devolvía la API era el objeto en memoria, no
  // una relectura de la fila. La UI mostraba el cambio hasta el próximo
  // fetch, donde volvían las fechas viejas.
  //
  // service_id/party_size/notes/order_item_id faltaban del INSERT Y DEL
  // ON CONFLICT ENTEROS (bug encontrado 18/08/2026, de paso, al agregar
  // adultos/ninos a este mismo INSERT) — no es que se desincronizaran entre
  // sí como el bug de arriba, directamente NUNCA se escribían. `baseSelect()`
  // sí los lee, así que toda reserva quedaba en la base con `service_id`/
  // `notes`/`order_item_id` NULL y `party_size` en su DEFAULT (1) para
  // siempre, sin importar qué valor tuviera en memoria. Efecto real:
  // `getActiveForServiceInRange()`/`WithLock()` (resource_locks por
  // servicio) nunca podían matchear nada porque `r.service_id` era NULL en
  // toda fila — el chequeo de disponibilidad de recursos bloqueados por
  // servicio quedaba roto en silencio. Test de regresión: mismo patrón que
  // el de resource_id/start_time/end_time (inspecciona el SQL literal).
  // reservation_number ($25) -- número operativo (D6, 22/08/2026). Va en el
  // ON CONFLICT SET igual que el resto de las columnas (convención de este
  // UPSERT: todo lo que está en el INSERT también está en el SET, ver el
  // historial de bugs arriba) -- es seguro porque `Reservation.reservationNumber`
  // es OBLIGATORIO en el constructor (Reservation.ts) y todo restore() que
  // reconstruye una reserva existente reenvía `existing.reservationNumber`
  // tal cual, nunca uno nuevo. Se resuelve una única vez, en
  // ReservationService.createReservation() (NumberSequenceRepository.next()),
  // antes de la primera vez que este UPSERT corre para esa reserva.
  private readonly UPSERT_SQL = `
    INSERT INTO reservations (
      id, customer_id, customer_name, customer_email,
      resource_id, status,
      start_time, end_time, details, updated_at, total_price,
      service_id, party_size, notes, order_item_id, adultos, ninos, rate_plan_id,
      requested_check_in_time, requested_check_out_time, schedule_approval_status,
      schedule_approved_by, schedule_charge_amount, deposit_amount, deposit_due_by,
      reservation_number, applied_customer_rate_id, needs_maintenance_review,
      is_exclusive_resource, cancellation_policy_snapshot
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_TIMESTAMP, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29)
    ON CONFLICT (id) DO UPDATE SET
      resource_id   = $5,
      status        = $6,
      start_time    = $7,
      end_time      = $8,
      details       = $9,
      updated_at    = CURRENT_TIMESTAMP,
      total_price   = $10,
      service_id    = $11,
      party_size    = $12,
      notes         = $13,
      order_item_id = $14,
      adultos       = $15,
      ninos         = $16,
      rate_plan_id  = $17,
      requested_check_in_time  = $18,
      requested_check_out_time = $19,
      schedule_approval_status = $20,
      schedule_approved_by     = $21,
      schedule_charge_amount   = $22,
      deposit_amount           = $23,
      deposit_due_by           = $24,
      reservation_number       = $25,
      applied_customer_rate_id = $26,
      needs_maintenance_review = $27,
      is_exclusive_resource    = $28,
      cancellation_policy_snapshot = $29
  `.trim();

  async save(reservation: Reservation): Promise<void> {
    await this.sqlClient.query(this.UPSERT_SQL, this.buildSaveParams(reservation));
    await this.syncLines(this.sqlClient, reservation);
  }

  async saveWithClient(client: SqlClient, reservation: Reservation): Promise<void> {
    await client.query(this.UPSERT_SQL, this.buildSaveParams(reservation));
    await this.syncLines(client, reservation);
  }

  /**
   * Sincroniza reservation_lines con `reservation.lines`: borra lo que
   * había y reinserta. Se llama en CADA save/saveWithClient (incluidas
   * transiciones de estado que no tocan las líneas) — reinserta filas
   * idénticas en esos casos, intencionalmente simple en vez de optimizado
   * (son pocas filas por reserva, no vale la pena comparar antes de
   * escribir). Si `reservation.lines` viene vacío no toca nada — pasa en
   * reservas legacy restauradas antes del backfill de reservation_lines,
   * o en tests que construyen una Reservation sin pasar `lines`.
   */
  private async syncLines(client: SqlClient, reservation: Reservation): Promise<void> {
    if (reservation.lines.length === 0) return;

    await client.query(`DELETE FROM reservation_lines WHERE reservation_id = $1`, [reservation.id]);
    for (const line of reservation.lines) {
      await client.query(
        `INSERT INTO reservation_lines (id, reservation_id, unit_date, price)
         VALUES ($1, $2, $3, $4)`,
        [line.id, reservation.id, line.unitDate.toISOString().slice(0, 10), line.price],
      );
    }
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

  /**
   * Bug 3 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md) — igual
   * que getById pero con SELECT ... FOR UPDATE. Debe llamarse dentro de una
   * transacción activa (`client` de transactionManager.run()), justo antes
   * de mutar el estado — sin esto, confirmar/cancelar/completar leían la
   * reserva FUERA de la transacción (o, en el worker de expiración, en una
   * conexión distinta a la de la transacción), así que dos transiciones
   * concurrentes sobre la misma reserva podían perder una en silencio.
   */
  async getByIdWithLock(client: SqlClient, id: string): Promise<Reservation | undefined> {
    const result = await client.query<ReservationRow>(
      `${this.baseSelect()} WHERE r.id = $1 FOR UPDATE`,
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

  async getApprovedLateCheckoutsForDate(date: string): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()}
       WHERE r.end_time::date = $1::date
         AND r.schedule_approval_status = 'APPROVED'
         AND r.requested_check_out_time IS NOT NULL
       ORDER BY r.end_time ASC`,
      [date],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getPendingWithExpiredDeposit(now: Date): Promise<Reservation[]> {
    const result = await this.sqlClient.query<ReservationRow>(
      `${this.baseSelect()}
       WHERE r.status = $1 AND r.deposit_due_by IS NOT NULL AND r.deposit_due_by < $2
       ORDER BY r.deposit_due_by ASC`,
      [ReservationStatus.PENDING, now.toISOString()],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  /**
   * Reservas PENDING + CONFIRMED que solapan el rango.
   * Usado en contextos de solo lectura (checkAvailability, GET /availability).
   * NO emite lock — no usar para chequeos que preceden a un INSERT/UPDATE.
   */
  /**
   * Reservas PENDING/CONFIRMED que solapan un rango, filtradas por recurso
   * o por servicio. Único query-builder para las 4 variantes públicas de
   * abajo (con/sin recurso vs. servicio, con/sin FOR UPDATE) — antes cada
   * combinación repetía la misma query armada a mano (jscpd C5,
   * docs/analysis/duplication/).
   *
   * FOR UPDATE bloquea las filas que solapan el rango hasta que la
   * transacción actual haga COMMIT o ROLLBACK — serializa la verificación
   * de disponibilidad más el INSERT que sigue. Debe llamarse dentro de una
   * transacción activa, pasando el `client` transaccional (no `this.sqlClient`).
   */
  private async getActiveInRange(
    column: 'resource_id' | 'service_id',
    id: string,
    startDate: Date,
    endDate: Date,
    client: SqlClient,
    forUpdate: boolean,
  ): Promise<Reservation[]> {
    const blockingStatuses = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED];
    const result = await client.query<ReservationRow>(
      `${this.baseSelect()}
       WHERE r.${column} = $1
         AND r.status = ANY($4)
         AND r.start_time < $3
         AND r.end_time   > $2
       ORDER BY r.start_time ASC
       ${forUpdate ? 'FOR UPDATE' : ''}`,
      [id, startDate.toISOString(), endDate.toISOString(), blockingStatuses],
    );
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async getActiveForResourceInRange(
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    return this.getActiveInRange('resource_id', resourceId, startDate, endDate, this.sqlClient, false);
  }

  /** @param client - SqlClient dentro de la transacción activa (de transactionManager.run). */
  async getActiveForResourceInRangeWithLock(
    client: SqlClient,
    resourceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    return this.getActiveInRange('resource_id', resourceId, startDate, endDate, client, true);
  }

  /** Ver doc en reservation.repository.ts — busca por r.service_id, no r.resource_id. */
  async getActiveForServiceInRange(
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    return this.getActiveInRange('service_id', serviceId, startDate, endDate, this.sqlClient, false);
  }

  async getActiveForServiceInRangeWithLock(
    client: SqlClient,
    serviceId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<Reservation[]> {
    return this.getActiveInRange('service_id', serviceId, startDate, endDate, client, true);
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
    filters: Omit<ReservationFilters, 'limit' | 'offset'>,
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
    if (filters.isLodging !== undefined) {
      // EXISTS en vez de JOIN en el FROM principal a propósito — baseSelect()
      // es `FROM reservations r` sin joins (la usan getById/getByCustomerId/
      // etc., no solo getFiltered) y un JOIN ahí multiplicaría filas si algún
      // día resources/resource_categories deja de ser 1:1.
      params.push(filters.isLodging);
      conditions.push(`EXISTS (
        SELECT 1 FROM resources res
        JOIN resource_categories rc ON rc.id = res.category_id
        WHERE res.id = r.resource_id AND rc.is_lodging = $${params.length}
      )`);
    }
    if (filters.search !== undefined && filters.search.trim() !== '') {
      params.push(`%${filters.search.trim()}%`);
      conditions.push(`(r.customer_name ILIKE $${params.length} OR r.customer_email ILIKE $${params.length})`);
    }

    return { conditions, params };
  }

  async getFiltered(filters: ReservationFilters): Promise<Reservation[]> {
    const { conditions, params } = this.buildWhereClause(filters);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // D-14 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md #12)
    // — contrato canónico limit/offset, SIEMPRE con LIMIT/OFFSET (antes,
    // sin page/limit, esta query no tenía NINGUNA cota — devolvía la tabla
    // entera). `, r.id DESC` es el desempate explícito que pide el
    // grounding: sin él, dos reservas con el mismo start_time pueden
    // aparecer duplicadas o faltar entre páginas (mismo bug shape que
    // erpnext#49037, citado en el grounding).
    let sql = `${this.baseSelect()} ${where} ORDER BY r.start_time DESC, r.id DESC`;

    const limit  = resolveReservationsLimit(filters.limit);
    const offset = filters.offset ?? 0;
    params.push(limit);
    sql += ` LIMIT $${params.length}`;
    params.push(offset);
    sql += ` OFFSET $${params.length}`;

    const result = await this.sqlClient.query<ReservationRow>(sql, params);
    return Promise.all(result.rows.map((row) => this.rowToReservation(row)));
  }

  async countFiltered(
    filters: Omit<ReservationFilters, 'limit' | 'offset'>,
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
        r.service_id, r.party_size, r.notes, r.order_item_id, r.total_price,
        r.adultos, r.ninos, r.rate_plan_id,
        r.requested_check_in_time, r.requested_check_out_time,
        r.schedule_approval_status, r.schedule_approved_by, r.schedule_charge_amount,
        r.deposit_amount, r.deposit_due_by, r.reservation_number, r.applied_customer_rate_id,
        r.needs_maintenance_review, r.is_exclusive_resource, r.cancellation_policy_snapshot
      FROM reservations r
    `;
  }

  private async rowToReservation(row: ReservationRow): Promise<Reservation> {
    // customer_id/customer_name/customer_email son el "congelado" de R9
    // (criterios-datos.md) -- reservas ya no envuelve esto en la clase
    // Customer completa de clientes-finanzas (Fase 7, D1), es su propia
    // proyección mínima. Ver reservation-customer.entities.ts.
    const customer: ReservationCustomer = {
      id:       row.customer_id,
      fullName: row.customer_name,
      email:    row.customer_email ?? undefined,
    };

    const resource = await this.resourceRepository.getById(row.resource_id);
    if (!resource) throw new ResourceNotFoundError(row.resource_id);

    const details =
      typeof row.details === 'string' ? JSON.parse(row.details) : row.details;

    const lines = await this.getLines(row.id);

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
      lines,
      adultos:       row.adultos ?? null,
      ninos:         row.ninos   ?? null,
      ratePlanId:    row.rate_plan_id ?? null,
      requestedCheckInTime:   row.requested_check_in_time  ?? null,
      requestedCheckOutTime:  row.requested_check_out_time ?? null,
      scheduleApprovalStatus: row.schedule_approval_status ?? null,
      scheduleApprovedBy:     row.schedule_approved_by     ?? null,
      scheduleChargeAmount:   row.schedule_charge_amount != null ? parseFloat(row.schedule_charge_amount) : null,
      depositAmount: parseFloat(row.deposit_amount),
      depositDueBy:  row.deposit_due_by ? new Date(row.deposit_due_by) : null,
      reservationNumber: row.reservation_number,
      appliedCustomerRateId: row.applied_customer_rate_id,
      needsMaintenanceReview: row.needs_maintenance_review ?? false,
      isExclusiveResource: row.is_exclusive_resource ?? false,
      // CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 -- mismo patrón que `details`
      // más arriba (pg puede devolver JSONB ya parseado o como string,
      // según el driver/tipo de columna). `null`/undefined -- reserva
      // vieja o sin tramo SNAPSHOT_AT_BOOKING vigente al confirmar -- cae
      // al default `null` de Reservation.ts, que CancellationRefundService
      // trata como "resolver contra la tabla en vivo".
      cancellationPolicySnapshot:
        typeof row.cancellation_policy_snapshot === 'string'
          ? JSON.parse(row.cancellation_policy_snapshot)
          : row.cancellation_policy_snapshot ?? null,
    });
  }

  /**
   * N+1 a propósito — mismo criterio que `resourceRepository.getById()`
   * unas líneas más arriba en este mismo método: son pocas filas por
   * reserva y esto ya no es la primera consulta N+1 de `rowToReservation`.
   * Si en algún momento esto pesa, se resuelve con un JOIN + agregación,
   * no antes.
   */
  private async getLines(reservationId: string): Promise<ReservationLine[]> {
    const result = await this.sqlClient.query<{ id: string; unit_date: string; price: string }>(
      `SELECT id, unit_date, price FROM reservation_lines
       WHERE reservation_id = $1 ORDER BY unit_date ASC`,
      [reservationId],
    );
    return result.rows.map((row) => ({
      id:            row.id,
      reservationId,
      unitDate:      new Date(row.unit_date),
      price:         parseFloat(row.price),
    }));
  }

  /** D7 (22/08/2026) — ver docblock de `AppliedRateReportRow` (customer-rate.repository.ts). */
  async getAppliedRatesReport(from: Date, to: Date): Promise<AppliedRateReportRow[]> {
    const { rows } = await this.sqlClient.query<{
      customer_rate_id: string;
      customer_id: string;
      customer_name: string;
      times_applied: string;
      total_amount: string;
    }>(
      `SELECT
         r.applied_customer_rate_id AS customer_rate_id,
         cr.customer_id,
         c.display_name AS customer_name,
         COUNT(*) AS times_applied,
         SUM(r.total_price) AS total_amount
       FROM reservations r
       JOIN customer_rates cr ON cr.id = r.applied_customer_rate_id
       JOIN customers c ON c.id = cr.customer_id
       WHERE r.applied_customer_rate_id IS NOT NULL
         AND r.status IN ('CONFIRMED', 'COMPLETED')
         AND r.created_at >= $1 AND r.created_at <= $2
       GROUP BY r.applied_customer_rate_id, cr.customer_id, c.display_name
       ORDER BY times_applied DESC`,
      [from, to],
    );

    return rows.map((row) => ({
      customerRateId: row.customer_rate_id,
      customerId:     row.customer_id,
      customerName:   row.customer_name,
      timesApplied:   parseInt(row.times_applied, 10),
      totalAmount:    parseFloat(row.total_amount),
    }));
  }
}
