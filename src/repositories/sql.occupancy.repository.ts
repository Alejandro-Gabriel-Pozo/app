import { ReservationStatus } from '../types/enums.js';
import {
  splitDateRangeIntoDailyMinutes,
  type OccupancyRepository,
  type OccupancySnapshot,
  type OccupancyStats,
} from './occupancy.repository.js';
import type { SqlClient } from './sql.client.js';

/**
 * Fila raw devuelta por PostgreSQL para las queries de ocupación.
 */
interface OccupancyRow {
  resourceId: string;
  resourceName: string;
  categoryId: string;
  categoryName: string;
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
  categoryId: string;
  categoryName: string;
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
 *   category_id VARCHAR(255) NOT NULL DEFAULT '',
 *   category_name VARCHAR(255) NOT NULL DEFAULT '',
 *   date DATE NOT NULL,
 *   total_minutes INT NOT NULL DEFAULT 1440,
 *   booked_minutes INT NOT NULL,
 *   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
 *   UNIQUE(resource_id, date)
 * );
 *
 * CREATE INDEX idx_date ON occupancy_records(date);
 * CREATE INDEX idx_resource_date ON occupancy_records(resource_id, date);
 * CREATE INDEX idx_category ON occupancy_records(category_id);
 * ```
 *
 * Migración para datos existentes (antes del fix):
 * ```sql
 * ALTER TABLE occupancy_records
 *   ADD COLUMN IF NOT EXISTS category_id   VARCHAR(255) NOT NULL DEFAULT '',
 *   ADD COLUMN IF NOT EXISTS category_name VARCHAR(255) NOT NULL DEFAULT '';
 * ```
 */
export class SqlOccupancyRepository implements OccupancyRepository {
  constructor(private readonly sqlClient: SqlClient) {}

  async recordReservation(
    resourceId: string,
    resourceName: string,
    categoryId: string,
    categoryName: string,
    startTime: Date,
    endTime: Date,
    status: ReservationStatus,
  ): Promise<void> {
    if (
      status !== ReservationStatus.CONFIRMED &&
      status !== ReservationStatus.COMPLETED
    ) {
      return;
    }

    const sql = `
      INSERT INTO occupancy_records
        (resource_id, resource_name, category_id, category_name, date, total_minutes, booked_minutes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (resource_id, date) DO UPDATE
      SET booked_minutes = occupancy_records.booked_minutes + $7
    `.trim();

    for (const { date, minutes } of splitDateRangeIntoDailyMinutes(startTime, endTime)) {
      const dateStr = date.toISOString().split('T')[0];
      await this.sqlClient.query(sql, [
        resourceId,
        resourceName,
        categoryId,
        categoryName,
        dateStr,
        24 * 60,
        minutes,
      ]);
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
        category_id as "categoryId",
        category_name as "categoryName",
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
      categoryId: row.categoryId,
      categoryName: row.categoryName,
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
        category_id as "categoryId",
        category_name as "categoryName",
        ROUND(
          100.0 * SUM(booked_minutes) / SUM(total_minutes),
          2
        ) as "occupancyRate"
      FROM occupancy_records
      WHERE date >= $1 AND date < $2
      GROUP BY resource_id, resource_name, category_id, category_name
      ORDER BY "occupancyRate" DESC
    `;

    const result = await this.sqlClient.query<OccupancyStatsRow>(sql, [startStr, endStr]);

    return result.rows.map((row) => ({
      resourceId: row.resourceId,
      resourceName: row.resourceName,
      categoryId: row.categoryId,
      categoryName: row.categoryName,
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
        category_id as "categoryId",
        category_name as "categoryName",
        ROUND(
          100.0 * SUM(booked_minutes) / SUM(total_minutes),
          2
        ) as "occupancyRate"
      FROM occupancy_records
      WHERE date >= $1 AND date < $2
      GROUP BY resource_id, resource_name, category_id, category_name
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
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      date: '',
      occupancyRate: parseFloat(String(row.occupancyRate)) || 0,
    }));
  }

  async deleteOldRecords(beforeDate: Date): Promise<number> {
    const beforeStr = beforeDate.toISOString().split('T')[0];
    const sql = `DELETE FROM occupancy_records WHERE date < $1`;
    const result = await this.sqlClient.query(sql, [beforeStr]);
    return (result.rowCount ?? (result.rows as unknown[])?.length ?? 0);
  }

  async getAllSnapshots(): Promise<OccupancySnapshot[]> {
    const sql = `
      SELECT 
        resource_id as "resourceId",
        resource_name as "resourceName",
        category_id as "categoryId",
        category_name as "categoryName",
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
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      date: new Date(row.date),
      totalMinutes: row.totalMinutes,
      bookedMinutes: row.bookedMinutes,
    }));
  }
}
