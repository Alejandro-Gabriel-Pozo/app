import { ReservationStatus } from '../types/enums.js';
import {
  OccupancyRepository,
  OccupancySnapshot,
  OccupancyStats,
} from './occupancy.repository.js';
import { SqlClient } from './sql.client.js';

/**
 * Fila raw devuelta por PostgreSQL para las queries de ocupación.
 * Elimina la necesidad de `as any[]` en los mapeos de rows.
 */
interface OccupancyRow {
  resourceId: string;
  resourceName: string;
  date: string | Date;
  totalMinutes: number;
  bookedMinutes: number;
}

/**
 * Fila raw devuelta por PostgreSQL para las queries de estadísticas.
 */
interface OccupancyStatsRow {
  resourceId: string;
  resourceName: string;
  occupancyRate: string | number;
}

/**
 * Implementación SQL del repositorio de ocupación.
 * Funciona con PostgreSQL, MySQL, etc.
 *
 * Schema esperado (PostgreSQL):
 * ```sql
 * CREATE TABLE occupancy_records (
 *   id SERIAL PRIMARY KEY,
 *   resource_id VARCHAR(255) NOT NULL,
 *   resource_name VARCHAR(255) NOT NULL,
 *   date DATE NOT NULL,
 *   total_minutes INT NOT NULL DEFAULT 1440,
 *   booked_minutes INT NOT NULL,
 *   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *   UNIQUE(resource_id, date)
 * );
 *
 * CREATE INDEX idx_date ON occupancy_records(date);
 * CREATE INDEX idx_resource_date ON occupancy_records(resource_id, date);
 * ```
 */
export class SqlOccupancyRepository implements OccupancyRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async recordReservation(
    resourceId: string,
    resourceName: string,
    startTime: Date,
    endTime: Date,
    status: ReservationStatus,
  ): Promise<void> {
    // Solo registrar reservas confirmadas o completadas
    if (
      status !== ReservationStatus.CONFIRMED &&
      status !== ReservationStatus.COMPLETED
    ) {
      return;
    }

    // Insertar registro por cada día
    const currentDate = new Date(startTime);
    currentDate.setHours(0, 0, 0, 0);

    while (currentDate < endTime) {
      const dayEnd = new Date(currentDate);
      dayEnd.setDate(dayEnd.getDate() + 1);
      dayEnd.setHours(0, 0, 0, 0);

      // Calcular minutos en este día específico
      const dayStart = new Date(currentDate);
      const effectiveEnd = Math.min(endTime.getTime(), dayEnd.getTime());
      const effectiveStart = Math.max(dayStart.getTime(), startTime.getTime());
      const minInDay = Math.max(
        0,
        (effectiveEnd - effectiveStart) / (1000 * 60),
      );

      // SQL adaptable: funciona en PG y MySQL
      const dateStr = currentDate.toISOString().split('T')[0];
      const sql = `
        INSERT INTO occupancy_records 
          (resource_id, resource_name, date, total_minutes, booked_minutes)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (resource_id, date) DO UPDATE
        SET booked_minutes = occupancy_records.booked_minutes + $5
      `.trim();

      await this.sqlClient.query(sql, [
        resourceId,
        resourceName,
        dateStr,
        24 * 60,
        minInDay,
      ]);

      currentDate.setDate(currentDate.getDate() + 1);
    }
  }

  async getOccupancyByDateRange(
    startDate: Date,
    endDate: Date,
    resourceIds?: string[],
  ): Promise<OccupancySnapshot[]> {
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    let sql = `
      SELECT 
        resource_id as "resourceId",
        resource_name as "resourceName",
        date,
        total_minutes as "totalMinutes",
        booked_minutes as "bookedMinutes"
      FROM occupancy_records
      WHERE date >= $1 AND date < $2
    `;

    const params: unknown[] = [startStr, endStr];

    if (resourceIds && resourceIds.length > 0) {
      sql += ` AND resource_id = ANY($3)`;
      params.push(resourceIds);
    }

    sql += ` ORDER BY date DESC, resource_id ASC`;

    const result = await this.sqlClient.query<OccupancyRow>(sql, params);

    return result.rows.map((row) => ({
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      date: new Date(row.date),
      totalMinutes: row.totalMinutes,
      bookedMinutes: row.bookedMinutes,
    }));
  }

  async getAverageOccupancyByResource(
    startDate: Date,
    endDate: Date,
  ): Promise<OccupancyStats[]> {
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const sql = `
      SELECT 
        resource_id as "resourceId",
        resource_name as "resourceName",
        ROUND(
          100.0 * SUM(booked_minutes) / SUM(total_minutes),
          2
        ) as "occupancyRate"
      FROM occupancy_records
      WHERE date >= $1 AND date < $2
      GROUP BY resource_id, resource_name
      ORDER BY "occupancyRate" DESC
    `;

    const result = await this.sqlClient.query<OccupancyStatsRow>(sql, [startStr, endStr]);

    return result.rows.map((row) => ({
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      date: '',
      occupancyRate: parseFloat(String(row.occupancyRate)) || 0,
    }));
  }

  async getTopOccupiedResources(
    startDate: Date,
    endDate: Date,
    limit: number = 10,
  ): Promise<OccupancyStats[]> {
    const startStr = startDate.toISOString().split('T')[0];
    const endStr = endDate.toISOString().split('T')[0];

    const sql = `
      SELECT 
        resource_id as "resourceId",
        resource_name as "resourceName",
        ROUND(
          100.0 * SUM(booked_minutes) / SUM(total_minutes),
          2
        ) as "occupancyRate"
      FROM occupancy_records
      WHERE date >= $1 AND date < $2
      GROUP BY resource_id, resource_name
      ORDER BY "occupancyRate" DESC
      LIMIT $3
    `;

    const result = await this.sqlClient.query<OccupancyStatsRow>(sql, [
      startStr,
      endStr,
      limit,
    ]);

    return result.rows.map((row) => ({
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      date: '',
      occupancyRate: parseFloat(String(row.occupancyRate)) || 0,
    }));
  }

  async deleteOldRecords(beforeDate: Date): Promise<number> {
    const beforeStr = beforeDate.toISOString().split('T')[0];

    // En PostgreSQL usamos DELETE RETURNING para contar
    const sql = `DELETE FROM occupancy_records WHERE date < $1`;
    const result = await this.sqlClient.query(sql, [beforeStr]);

    // Algunos drivers retornan rowCount, otros rows.length
    return (result.rowCount ?? (result.rows as unknown[])?.length ?? 0);
  }

  async getAllSnapshots(): Promise<OccupancySnapshot[]> {
    const sql = `
      SELECT 
        resource_id as "resourceId",
        resource_name as "resourceName",
        date,
        total_minutes as "totalMinutes",
        booked_minutes as "bookedMinutes"
      FROM occupancy_records
      ORDER BY date DESC, resource_id ASC
    `;

    const result = await this.sqlClient.query<OccupancyRow>(sql);

    return result.rows.map((row) => ({
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      date: new Date(row.date),
      totalMinutes: row.totalMinutes,
      bookedMinutes: row.bookedMinutes,
    }));
  }
}
