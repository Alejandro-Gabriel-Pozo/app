/**
 * @file stay.repository.ts
 * @description Interfaz del repositorio de Stays + implementación PostgreSQL.
 */

import type { SqlClient } from './sql.client.js';
import type { StayProps, StayStatus } from '../domain/stay.js';
import { Stay } from '../domain/stay.js';

// ---------------------------------------------------------------------------
// Interfaz del repositorio (puerto)
// ---------------------------------------------------------------------------

export interface StayRepository {
  save(stay: Stay): Promise<void>;
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
  no_show_at, notes, created_at, updated_at
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
    createdAt:     new Date(row['created_at'] as string),
    updatedAt:     new Date(row['updated_at'] as string),
  } satisfies StayProps);
}

export class SqlStayRepository implements StayRepository {
  constructor(private readonly db: SqlClient) {}

  async save(stay: Stay): Promise<void> {
    await this.db.query(
      `INSERT INTO stays
         (id, business_id, reservation_id, resource_id, customer_id,
          assigned_by, status, checked_in_at, checked_out_at,
          no_show_at, notes, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        stay.id, stay.businessId, stay.reservationId, stay.resourceId,
        stay.customerId, stay.assignedBy, stay.status, stay.checkedInAt,
        stay.checkedOutAt, stay.noShowAt, stay.notes, stay.createdAt, stay.updatedAt,
      ],
    );
  }

  async update(stay: Stay): Promise<void> {
    await this.db.query(
      `UPDATE stays
       SET status=$1, checked_out_at=$2, no_show_at=$3, notes=$4, updated_at=$5
       WHERE id=$6 AND business_id=$7`,
      [
        stay.status, stay.checkedOutAt, stay.noShowAt,
        stay.notes, stay.updatedAt, stay.id, stay.businessId,
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
