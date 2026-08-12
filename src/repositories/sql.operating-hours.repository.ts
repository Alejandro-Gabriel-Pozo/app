/**
 * @file sql.operating-hours.repository.ts
 * @description Implementación SQL de IOperatingHoursRepository.
 * Lee/escribe `business_hours` y `resource_hours` (db/schema.sql).
 */

import type {
  IOperatingHoursRepository,
  OperatingWindow,
  CreateBusinessWindowDto,
  CreateResourceWindowDto,
} from './operating-hours.repository.js';
import type { SqlClient } from './sql.client.js';

interface WindowRow {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
}

function rowToWindow(r: WindowRow): OperatingWindow {
  return { id: r.id, dayOfWeek: r.day_of_week, startTime: r.start_time, endTime: r.end_time };
}

export class SqlOperatingHoursRepository implements IOperatingHoursRepository {
  constructor(private readonly db: SqlClient) {}

  async getAllBusinessWindows(): Promise<OperatingWindow[]> {
    const result = await this.db.query<WindowRow>(
      `SELECT id, day_of_week, start_time, end_time FROM business_hours
       ORDER BY day_of_week ASC, start_time ASC`,
    );
    return result.rows.map(rowToWindow);
  }

  async createBusinessWindow(dto: CreateBusinessWindowDto): Promise<OperatingWindow> {
    const result = await this.db.query<WindowRow>(
      `INSERT INTO business_hours (id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4)
       RETURNING id, day_of_week, start_time, end_time`,
      [dto.id, dto.dayOfWeek, dto.startTime, dto.endTime],
    );
    return rowToWindow(result.rows[0]!);
  }

  async deleteBusinessWindow(id: string): Promise<void> {
    await this.db.query(`DELETE FROM business_hours WHERE id = $1`, [id]);
  }

  async getResourceWindows(resourceId: string): Promise<OperatingWindow[]> {
    const result = await this.db.query<WindowRow>(
      `SELECT id, day_of_week, start_time, end_time FROM resource_hours
       WHERE resource_id = $1
       ORDER BY day_of_week ASC, start_time ASC`,
      [resourceId],
    );
    return result.rows.map(rowToWindow);
  }

  async createResourceWindow(dto: CreateResourceWindowDto): Promise<OperatingWindow> {
    const result = await this.db.query<WindowRow>(
      `INSERT INTO resource_hours (id, resource_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, day_of_week, start_time, end_time`,
      [dto.id, dto.resourceId, dto.dayOfWeek, dto.startTime, dto.endTime],
    );
    return rowToWindow(result.rows[0]!);
  }

  async deleteResourceWindow(id: string): Promise<void> {
    await this.db.query(`DELETE FROM resource_hours WHERE id = $1`, [id]);
  }

  async getEffectiveWindows(resourceId: string, dayOfWeek: number): Promise<OperatingWindow[]> {
    const resourceResult = await this.db.query<WindowRow>(
      `SELECT id, day_of_week, start_time, end_time FROM resource_hours
       WHERE resource_id = $1 AND day_of_week = $2
       ORDER BY start_time ASC`,
      [resourceId, dayOfWeek],
    );
    if (resourceResult.rows.length > 0) return resourceResult.rows.map(rowToWindow);

    const businessResult = await this.db.query<WindowRow>(
      `SELECT id, day_of_week, start_time, end_time FROM business_hours
       WHERE day_of_week = $1
       ORDER BY start_time ASC`,
      [dayOfWeek],
    );
    return businessResult.rows.map(rowToWindow);
  }
}
