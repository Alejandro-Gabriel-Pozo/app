/**
 * @file housekeeping.repository.ts
 * @description Interfaz del repositorio de Housekeeping + implementación PostgreSQL.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { HousekeepingTaskProps, HousekeepingStatus } from './housekeeping-task.js';
import { HousekeepingTask } from './housekeeping-task.js';

// ---------------------------------------------------------------------------
// Interfaz del repositorio (puerto — independiente de infraestructura)
// ---------------------------------------------------------------------------

export interface HousekeepingRepository {
  save(task: HousekeepingTask): Promise<void>;
  update(task: HousekeepingTask): Promise<void>;
  findById(id: string, businessId: string): Promise<HousekeepingTask | null>;
  findByResource(resourceId: string, businessId: string): Promise<HousekeepingTask[]>;
  /** `date` es 'YYYY-MM-DD' (fecha de negocio, A4) — nunca un `Date`, ver housekeeping.service.ts. */
  findByDate(businessId: string, date: string): Promise<HousekeepingTask[]>;
  findByAssignee(userId: string, businessId: string): Promise<HousekeepingTask[]>;
  findByStatus(businessId: string, status: HousekeepingStatus): Promise<HousekeepingTask[]>;
  /**
   * True si el recurso tiene alguna tarea de housekeeping en estado
   * OUT_OF_SERVICE. Sin `businessId`: igual que `ResourceRepository.getById`,
   * un `resourceId` ya está scoped al tenant (una BD por negocio, sin
   * columna `business_id` en `resources`) — no hace falta el filtro extra.
   * Usado por ReservationService para no ofrecer/aceptar reservas sobre un
   * recurso que housekeeping marcó fuera de servicio.
   */
  isOutOfService(resourceId: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Implementación PostgreSQL
// ---------------------------------------------------------------------------

const COLUMNS = `
  id, business_id, resource_id, assigned_to, status, notes,
  shift, scheduled_for, started_at, completed_at,
  inspected_at, inspected_by, created_at, updated_at
`;

function rowToTask(row: Record<string, unknown>): HousekeepingTask {
  return HousekeepingTask.restore({
    id:           row['id'] as string,
    businessId:   row['business_id'] as string,
    resourceId:   row['resource_id'] as string,
    assignedTo:   (row['assigned_to'] as string | null) ?? null,
    status:       row['status'] as HousekeepingStatus,
    notes:        (row['notes'] as string | null) ?? null,
    shift:        row['shift'] as string,
    scheduledFor: new Date(row['scheduled_for'] as string),
    startedAt:    row['started_at'] ? new Date(row['started_at'] as string) : null,
    completedAt:  row['completed_at'] ? new Date(row['completed_at'] as string) : null,
    inspectedAt:  row['inspected_at'] ? new Date(row['inspected_at'] as string) : null,
    inspectedBy:  (row['inspected_by'] as string | null) ?? null,
    createdAt:    new Date(row['created_at'] as string),
    updatedAt:    new Date(row['updated_at'] as string),
  } satisfies HousekeepingTaskProps);
}

export class SqlHousekeepingRepository implements HousekeepingRepository {
  constructor(private readonly db: SqlClient) {}

  async save(task: HousekeepingTask): Promise<void> {
    await this.db.query(
      `INSERT INTO housekeeping_tasks
         (id, business_id, resource_id, assigned_to, status, notes,
          shift, scheduled_for, started_at, completed_at,
          inspected_at, inspected_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        task.id, task.businessId, task.resourceId, task.assignedTo,
        task.status, task.notes, task.shift, task.scheduledFor,
        task.startedAt, task.completedAt, task.inspectedAt, task.inspectedBy,
        task.createdAt, task.updatedAt,
      ],
    );
  }

  async update(task: HousekeepingTask): Promise<void> {
    await this.db.query(
      `UPDATE housekeeping_tasks
       SET assigned_to=$1, status=$2, notes=$3, started_at=$4,
           completed_at=$5, inspected_at=$6, inspected_by=$7, updated_at=$8
       WHERE id=$9 AND business_id=$10`,
      [
        task.assignedTo, task.status, task.notes, task.startedAt,
        task.completedAt, task.inspectedAt, task.inspectedBy, task.updatedAt,
        task.id, task.businessId,
      ],
    );
  }

  async findById(id: string, businessId: string): Promise<HousekeepingTask | null> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM housekeeping_tasks WHERE id=$1 AND business_id=$2`,
      [id, businessId],
    );
    if (!result.rows[0]) return null;
    return rowToTask(result.rows[0]);
  }

  async findByResource(resourceId: string, businessId: string): Promise<HousekeepingTask[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM housekeeping_tasks
       WHERE resource_id=$1 AND business_id=$2
       ORDER BY scheduled_for DESC`,
      [resourceId, businessId],
    );
    return result.rows.map(rowToTask);
  }

  async findByDate(businessId: string, date: string): Promise<HousekeepingTask[]> {
    // `date` viaja como string 'YYYY-MM-DD' — nunca como `Date` de JS. Un
    // `Date` acá se serializaría vía `pg` en la zona horaria LOCAL del
    // proceso, corriendo la fecha un día para atrás/adelante según el huso
    // del server (bug real: date=2026-08-18 no encontraba tareas de esa
    // fecha exacta). Postgres compara el literal de texto contra `::date`
    // sin ambigüedad, sin pasar por ningún objeto Date.
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM housekeeping_tasks
       WHERE business_id=$1 AND scheduled_for::date = $2::date
       ORDER BY shift, resource_id`,
      [businessId, date],
    );
    return result.rows.map(rowToTask);
  }

  async findByAssignee(userId: string, businessId: string): Promise<HousekeepingTask[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM housekeeping_tasks
       WHERE assigned_to=$1 AND business_id=$2 AND status NOT IN ('DONE','INSPECTED')
       ORDER BY scheduled_for`,
      [userId, businessId],
    );
    return result.rows.map(rowToTask);
  }

  async findByStatus(businessId: string, status: HousekeepingStatus): Promise<HousekeepingTask[]> {
    const result = await this.db.query<Record<string, unknown>>(
      `SELECT ${COLUMNS} FROM housekeeping_tasks
       WHERE business_id=$1 AND status=$2
       ORDER BY scheduled_for`,
      [businessId, status],
    );
    return result.rows.map(rowToTask);
  }

  async isOutOfService(resourceId: string): Promise<boolean> {
    const result = await this.db.query(
      `SELECT 1 FROM housekeeping_tasks WHERE resource_id=$1 AND status='OUT_OF_SERVICE' LIMIT 1`,
      [resourceId],
    );
    return (result.rowCount ?? result.rows.length) > 0;
  }
}
