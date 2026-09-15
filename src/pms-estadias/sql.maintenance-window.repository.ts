/**
 * @file sql.maintenance-window.repository.ts
 * @description Implementación PostgreSQL del repositorio de ventanas de mantenimiento.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { MaintenanceWindowRepository } from './maintenance-window.repository.js';
import { MaintenanceWindow, type MaintenanceWindowProps } from './maintenance-window.js';

const COLUMNS = `
  id, business_id, resource_id, start_date, end_date, reason,
  created_by, closed_by, closed_at, created_at, updated_at
`;

interface Row {
  id: string;
  business_id: string;
  resource_id: string;
  start_date: string;
  end_date: string | null;
  reason: string | null;
  created_by: string;
  closed_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
}

// `start_date`/`end_date` son DATE en Postgres -- el driver `pg` los
// devuelve como `Date` de JS por default (medianoche UTC), no como string.
// Se fuerza el ida y vuelta por string 'YYYY-MM-DD' explícito acá para no
// heredar ese comportamiento -- mismo motivo que el resto del archivo.
function toDateOnlyString(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  throw new Error(`toDateOnlyString: valor inesperado ${String(value)}`);
}

function rowToWindow(row: Row): MaintenanceWindow {
  return MaintenanceWindow.restore({
    id:         row.id,
    businessId: row.business_id,
    resourceId: row.resource_id,
    startDate:  toDateOnlyString(row.start_date),
    endDate:    row.end_date != null ? toDateOnlyString(row.end_date) : null,
    reason:     row.reason,
    createdBy:  row.created_by,
    closedBy:   row.closed_by,
    closedAt:   row.closed_at ? new Date(row.closed_at) : null,
    createdAt:  new Date(row.created_at),
    updatedAt:  new Date(row.updated_at),
  } satisfies MaintenanceWindowProps);
}

export class SqlMaintenanceWindowRepository implements MaintenanceWindowRepository {
  constructor(private readonly db: SqlClient) {}

  private async insert(client: SqlClient, window: MaintenanceWindow): Promise<void> {
    await client.query(
      `INSERT INTO maintenance_windows
         (id, business_id, resource_id, start_date, end_date, reason,
          created_by, closed_by, closed_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        window.id, window.businessId, window.resourceId, window.startDate, window.endDate,
        window.reason, window.createdBy, window.closedBy, window.closedAt,
        window.createdAt, window.updatedAt,
      ],
    );
  }

  async save(window: MaintenanceWindow): Promise<void> {
    await this.insert(this.db, window);
  }

  /** D-03 (15/09/2026) — ver docblock en maintenance-window.repository.ts. */
  async saveWithClient(client: SqlClient, window: MaintenanceWindow): Promise<void> {
    await this.insert(client, window);
  }

  async update(window: MaintenanceWindow): Promise<void> {
    await this.db.query(
      `UPDATE maintenance_windows
       SET end_date=$1, closed_by=$2, closed_at=$3, updated_at=$4
       WHERE id=$5 AND business_id=$6`,
      [window.endDate, window.closedBy, window.closedAt, window.updatedAt, window.id, window.businessId],
    );
  }

  async findById(id: string, businessId: string): Promise<MaintenanceWindow | null> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM maintenance_windows WHERE id=$1 AND business_id=$2`,
      [id, businessId],
    );
    return result.rows[0] ? rowToWindow(result.rows[0]) : null;
  }

  async findByResource(resourceId: string, businessId: string): Promise<MaintenanceWindow[]> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM maintenance_windows
       WHERE resource_id=$1 AND business_id=$2
       ORDER BY start_date DESC`,
      [resourceId, businessId],
    );
    return result.rows.map(rowToWindow);
  }

  async findActiveByResource(resourceId: string, businessId: string, today: string): Promise<MaintenanceWindow[]> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM maintenance_windows
       WHERE resource_id=$1 AND business_id=$2
         AND (end_date IS NULL OR end_date >= $3::date)
       ORDER BY start_date`,
      [resourceId, businessId, today],
    );
    return result.rows.map(rowToWindow);
  }

  async findActiveByResourceId(resourceId: string, today: string): Promise<MaintenanceWindow[]> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM maintenance_windows
       WHERE resource_id=$1
         AND (end_date IS NULL OR end_date >= $2::date)
       ORDER BY start_date`,
      [resourceId, today],
    );
    return result.rows.map(rowToWindow);
  }

  async findAllActive(businessId: string, today: string): Promise<MaintenanceWindow[]> {
    const result = await this.db.query<Row>(
      `SELECT ${COLUMNS} FROM maintenance_windows
       WHERE business_id=$1
         AND (end_date IS NULL OR end_date >= $2::date)
       ORDER BY start_date`,
      [businessId, today],
    );
    return result.rows.map(rowToWindow);
  }
}
