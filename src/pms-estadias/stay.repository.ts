/**
 * @file stay.repository.ts
 * @description Interfaz del repositorio de Stays + implementación PostgreSQL.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { StayProps, StayStatus } from './stay.js';
import { Stay } from './stay.js';

// ---------------------------------------------------------------------------
// Interfaz del repositorio (puerto)
// ---------------------------------------------------------------------------

export interface StayRepository {
  save(stay: Stay): Promise<void>;
  /**
   * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6/§7
   * ítem 8) — igual que `save()` pero corre sobre un `SqlClient` de una
   * transacción ya abierta. `StayService.checkIn()` pasa a componer el
   * `INSERT` de `Stay` con `assignDeferred()`/`linkStayToReservationCharges()`
   * en una sola operación atómica.
   */
  saveWithClient(client: SqlClient, stay: Stay): Promise<void>;
  update(stay: Stay): Promise<void>;
  findById(id: string, businessId: string): Promise<Stay | null>;
  findByReservation(reservationId: string, businessId: string): Promise<Stay | null>;
  findActiveByResource(resourceId: string, businessId: string): Promise<Stay | null>;
  findActiveByCustomer(customerId: string, businessId: string): Promise<Stay[]>;
  findByStatus(businessId: string, status: StayStatus): Promise<Stay[]>;
}

// ---------------------------------------------------------------------------
// Implementación PostgreSQL
// ---------------------------------------------------------------------------

const COLUMNS = `
  id, business_id, reservation_id, resource_id, customer_id,
  assigned_by, status, checked_in_at, checked_out_at,
  no_show_at, notes, housekeeping_override_by, housekeeping_override_at,
  housekeeping_status_at_override, balance_override_by, balance_override_at,
  balance_at_override, created_at, updated_at
`;

function rowToStay(row: Record<string, unknown>): Stay {
  return Stay.restore({
    id:            row['id'] as string,
    businessId:    row['business_id'] as string,
    reservationId: row['reservation_id'] as string,
    resourceId:    row['resource_id'] as string,
    customerId:    row['customer_id'] as string,
    assignedBy:    row['assigned_by'] as string,
    status:        row['status'] as StayStatus,
    checkedInAt:   new Date(row['checked_in_at'] as string),
    checkedOutAt:  row['checked_out_at'] ? new Date(row['checked_out_at'] as string) : null,
    noShowAt:      row['no_show_at'] ? new Date(row['no_show_at'] as string) : null,
    notes:         (row['notes'] as string | null) ?? null,
    housekeepingOverrideBy:       (row['housekeeping_override_by'] as string | null) ?? null,
    housekeepingOverrideAt:       row['housekeeping_override_at'] ? new Date(row['housekeeping_override_at'] as string) : null,
    housekeepingStatusAtOverride: (row['housekeeping_status_at_override'] as StayProps['housekeepingStatusAtOverride']) ?? null,
    balanceOverrideBy: (row['balance_override_by'] as string | null) ?? null,
    balanceOverrideAt: row['balance_override_at'] ? new Date(row['balance_override_at'] as string) : null,
    balanceAtOverride: row['balance_at_override'] !== null && row['balance_at_override'] !== undefined
      ? parseFloat(row['balance_at_override'] as string)
      : null,
    createdAt:     new Date(row['created_at'] as string),
    updatedAt:     new Date(row['updated_at'] as string),
  } satisfies StayProps);
}

export class SqlStayRepository implements StayRepository {
  constructor(private readonly db: SqlClient) {}

  async save(stay: Stay): Promise<void> {
    await this.saveWithClient(this.db, stay);
  }

  /**
   * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6/§7
   * ítem 8) — igual que `save()`, pero corre sobre el `client` que se le
   * pasa (dentro de una transacción de `TransactionManager.run()`) en vez
   * de `this.db`. `save()` delega acá con `this.db` para no duplicar el
   * SQL.
   */
  async saveWithClient(client: SqlClient, stay: Stay): Promise<void> {
    await client.query(
      `INSERT INTO stays
         (id, business_id, reservation_id, resource_id, customer_id,
          assigned_by, status, checked_in_at, checked_out_at,
          no_show_at, notes, housekeeping_override_by, housekeeping_override_at,
          housekeeping_status_at_override, balance_override_by, balance_override_at,
          balance_at_override, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [
        stay.id, stay.businessId, stay.reservationId, stay.resourceId,
        stay.customerId, stay.assignedBy, stay.status, stay.checkedInAt,
        stay.checkedOutAt, stay.noShowAt, stay.notes,
        stay.housekeepingOverrideBy, stay.housekeepingOverrideAt, stay.housekeepingStatusAtOverride,
        stay.balanceOverrideBy, stay.balanceOverrideAt, stay.balanceAtOverride,
        stay.createdAt, stay.updatedAt,
      ],
    );
  }

  async update(stay: Stay): Promise<void> {
    await this.db.query(
      `UPDATE stays
       SET status=$1, checked_out_at=$2, no_show_at=$3, notes=$4,
           balance_override_by=$5, balance_override_at=$6, balance_at_override=$7,
           updated_at=$8
       WHERE id=$9 AND business_id=$10`,
      [
        stay.status, stay.checkedOutAt, stay.noShowAt, stay.notes,
        stay.balanceOverrideBy, stay.balanceOverrideAt, stay.balanceAtOverride,
        stay.updatedAt, stay.id, stay.businessId,
      ],
    );
  }

  async findById(id: string, businessId: string): Promise<Stay | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM stays WHERE id=$1 AND business_id=$2`,
      [id, businessId],
    );
    return r.rows[0] ? rowToStay(r.rows[0]) : null;
  }

  async findByReservation(reservationId: string, businessId: string): Promise<Stay | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM stays
       WHERE reservation_id=$1 AND business_id=$2
       ORDER BY created_at DESC LIMIT 1`,
      [reservationId, businessId],
    );
    return r.rows[0] ? rowToStay(r.rows[0]) : null;
  }

  async findActiveByResource(resourceId: string, businessId: string): Promise<Stay | null> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM stays
       WHERE resource_id=$1 AND business_id=$2 AND status='CHECKED_IN'
       LIMIT 1`,
      [resourceId, businessId],
    );
    return r.rows[0] ? rowToStay(r.rows[0]) : null;
  }

  async findActiveByCustomer(customerId: string, businessId: string): Promise<Stay[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM stays
       WHERE customer_id=$1 AND business_id=$2 AND status='CHECKED_IN'
       ORDER BY checked_in_at DESC`,
      [customerId, businessId],
    );
    return r.rows.map(rowToStay);
  }

  async findByStatus(businessId: string, status: StayStatus): Promise<Stay[]> {
    const r = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM stays
       WHERE business_id=$1 AND status=$2
       ORDER BY checked_in_at DESC`,
      [businessId, status],
    );
    return r.rows.map(rowToStay);
  }
}
