/**
 * @file sql.bookable-service.repository.ts
 * @description Implementación PostgreSQL de IBookableServiceRepository.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type {
  BookableService,
  ServiceSchedule,
  CreateBookableServiceDTO,
  UpdateBookableServiceDTO,
  CreateServiceScheduleDTO,
  UpdateServiceScheduleDTO,
  BookingMode,
} from '../types/bookable-service.types.js';

function mapService(row: Record<string, unknown>): BookableService {
  return {
    id:              row['id'] as string,
    categoryId:      row['category_id'] as string,
    name:            row['name'] as string,
    ...(row['description'] != null && { description: row['description'] as string }),
    bookingMode:     row['booking_mode'] as BookingMode,
    durationMinutes: row['duration_minutes'] != null ? Number(row['duration_minutes']) : null,
    price:           Number(row['price']),
    active:          row['active'] as boolean,
    createdAt:       new Date(row['created_at'] as string),
    updatedAt:       new Date(row['updated_at'] as string),
  };
}

function mapSchedule(row: Record<string, unknown>): ServiceSchedule {
  return {
    id:          row['id'] as string,
    serviceId:   row['service_id'] as string,
    dayOfWeek:   Number(row['day_of_week']),
    startTime:   row['start_time'] as string,
    maxCapacity: Number(row['max_capacity']),
    active:      row['active'] as boolean,
  };
}

export class SqlBookableServiceRepository implements IBookableServiceRepository {
  constructor(private readonly db: SqlClient) {}

  // ---- Bookable Services ----

  async findAll(): Promise<BookableService[]> {
    const result = await this.db.query(
      `SELECT * FROM bookable_services WHERE active = TRUE ORDER BY created_at ASC`,
    );
    return (result.rows as Record<string, unknown>[]).map(mapService);
  }

  async findById(id: string): Promise<BookableService | null> {
    const result = await this.db.query(
      `SELECT * FROM bookable_services WHERE id = $1`,
      [id],
    );
    const rows = result.rows as Record<string, unknown>[];
    if (!rows.length) return null;
    const service = mapService(rows[0]!);
    const schedules = await this.findSchedulesByService(id);
    service.schedules = schedules;
    return service;
  }

  async create(dto: CreateBookableServiceDTO): Promise<BookableService> {
    const result = await this.db.query(
      `INSERT INTO bookable_services
         (id, category_id, name, description, booking_mode, duration_minutes, price)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        dto.id,
        dto.categoryId,
        dto.name,
        dto.description ?? null,
        dto.bookingMode,
        dto.durationMinutes ?? null,
        dto.price,
      ],
    );
    return mapService((result.rows as Record<string, unknown>[])[0]!);
  }

  async update(id: string, dto: UpdateBookableServiceDTO): Promise<BookableService> {
    const setClauses: string[] = [];
    const values: unknown[]   = [];
    let   idx = 1;

    if (dto.categoryId      !== undefined) { setClauses.push(`category_id = $${idx++}`);      values.push(dto.categoryId); }
    if (dto.name            !== undefined) { setClauses.push(`name = $${idx++}`);              values.push(dto.name); }
    if (dto.description     !== undefined) { setClauses.push(`description = $${idx++}`);       values.push(dto.description); }
    if (dto.bookingMode     !== undefined) { setClauses.push(`booking_mode = $${idx++}`);      values.push(dto.bookingMode); }
    if (dto.durationMinutes !== undefined) { setClauses.push(`duration_minutes = $${idx++}`);  values.push(dto.durationMinutes); }
    if (dto.price           !== undefined) { setClauses.push(`price = $${idx++}`);             values.push(dto.price); }
    if (dto.active          !== undefined) { setClauses.push(`active = $${idx++}`);            values.push(dto.active); }

    if (setClauses.length === 0) {
      const svc = await this.findById(id);
      if (!svc) throw new Error(`BookableService ${id} not found`);
      return svc;
    }

    values.push(id);
    const result = await this.db.query(
      `UPDATE bookable_services SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    const rows = result.rows as Record<string, unknown>[];
    if (!rows.length) throw new Error(`BookableService ${id} not found`);
    return mapService(rows[0]!);
  }

  async deactivate(id: string): Promise<void> {
    await this.db.query(
      `UPDATE bookable_services SET active = FALSE WHERE id = $1`,
      [id],
    );
  }

  // ---- Service Schedules ----

  async findSchedulesByService(serviceId: string): Promise<ServiceSchedule[]> {
    const result = await this.db.query(
      `SELECT * FROM service_schedules WHERE service_id = $1 AND active = TRUE ORDER BY day_of_week, start_time`,
      [serviceId],
    );
    return (result.rows as Record<string, unknown>[]).map(mapSchedule);
  }

  async findScheduleById(id: string): Promise<ServiceSchedule | null> {
    const result = await this.db.query(
      `SELECT * FROM service_schedules WHERE id = $1`,
      [id],
    );
    const rows = result.rows as Record<string, unknown>[];
    return rows.length ? mapSchedule(rows[0]!) : null;
  }

  async createSchedule(dto: CreateServiceScheduleDTO): Promise<ServiceSchedule> {
    const result = await this.db.query(
      `INSERT INTO service_schedules (id, service_id, day_of_week, start_time, max_capacity)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [dto.id, dto.serviceId, dto.dayOfWeek, dto.startTime, dto.maxCapacity],
    );
    return mapSchedule((result.rows as Record<string, unknown>[])[0]!);
  }

  async updateSchedule(id: string, dto: UpdateServiceScheduleDTO): Promise<ServiceSchedule> {
    const setClauses: string[] = [];
    const values: unknown[]   = [];
    let   idx = 1;

    if (dto.dayOfWeek   !== undefined) { setClauses.push(`day_of_week = $${idx++}`);   values.push(dto.dayOfWeek); }
    if (dto.startTime   !== undefined) { setClauses.push(`start_time = $${idx++}`);    values.push(dto.startTime); }
    if (dto.maxCapacity !== undefined) { setClauses.push(`max_capacity = $${idx++}`);  values.push(dto.maxCapacity); }
    if (dto.active      !== undefined) { setClauses.push(`active = $${idx++}`);        values.push(dto.active); }

    if (setClauses.length === 0) {
      const sch = await this.findScheduleById(id);
      if (!sch) throw new Error(`ServiceSchedule ${id} not found`);
      return sch;
    }

    values.push(id);
    const result = await this.db.query(
      `UPDATE service_schedules SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
      values,
    );
    const rows = result.rows as Record<string, unknown>[];
    if (!rows.length) throw new Error(`ServiceSchedule ${id} not found`);
    return mapSchedule(rows[0]!);
  }

  async deleteSchedule(id: string): Promise<void> {
    await this.db.query(
      `DELETE FROM service_schedules WHERE id = $1`,
      [id],
    );
  }
}
