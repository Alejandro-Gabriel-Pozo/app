/**
 * @file bookable-service.service.ts
 * @description Lógica de negocio para servicios agendables y sus horarios.
 */

import { randomUUID } from 'node:crypto';
import type { IBookableServiceRepository } from '../repositories/bookable-service.repository.js';
import type {
  BookableService,
  ServiceSchedule,
  CreateBookableServiceDTO,
  UpdateBookableServiceDTO,
  UpdateServiceScheduleDTO,
} from '../types/bookable-service.types.js';

// ---------------------------------------------------------------------------
// Errores de dominio
// ---------------------------------------------------------------------------

export class BookableServiceNotFoundError extends Error {
  constructor(id: string) {
    super(`Servicio agendable '${id}' no encontrado.`);
    this.name = 'BookableServiceNotFoundError';
  }
}

export class ServiceScheduleNotFoundError extends Error {
  constructor(id: string) {
    super(`Schedule '${id}' no encontrado.`);
    this.name = 'ServiceScheduleNotFoundError';
  }
}

export class ScheduleConflictError extends Error {
  constructor(dayOfWeek: number, startTime: string) {
    super(`Ya existe un schedule activo para día ${dayOfWeek} a las ${startTime}.`);
    this.name = 'ScheduleConflictError';
  }
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export class BookableServiceService {
  constructor(private readonly repo: IBookableServiceRepository) {}

  async listServices(): Promise<BookableService[]> {
    return this.repo.findAll();
  }

  async getServiceById(id: string): Promise<BookableService> {
    const service = await this.repo.findById(id);
    if (!service) throw new BookableServiceNotFoundError(id);
    return service;
  }

  async createService(data: Omit<CreateBookableServiceDTO, 'id'>): Promise<BookableService> {
    return this.repo.create({ ...data, id: randomUUID() });
  }

  async updateService(id: string, data: UpdateBookableServiceDTO): Promise<BookableService> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new BookableServiceNotFoundError(id);
    return this.repo.update(id, data);
  }

  async deleteService(id: string): Promise<void> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new BookableServiceNotFoundError(id);
    await this.repo.deactivate(id);
  }

  // ---- Schedules ----

  async listSchedules(serviceId: string): Promise<ServiceSchedule[]> {
    const service = await this.repo.findById(serviceId);
    if (!service) throw new BookableServiceNotFoundError(serviceId);
    return this.repo.findSchedulesByService(serviceId);
  }

  async addSchedule(
    serviceId: string,
    data: { dayOfWeek: number; startTime: string; maxCapacity: number },
  ): Promise<ServiceSchedule> {
    const service = await this.repo.findById(serviceId);
    if (!service) throw new BookableServiceNotFoundError(serviceId);

    // Prevenir duplicados: mismo día + hora dentro del servicio
    const existing = await this.repo.findSchedulesByService(serviceId);
    const conflict = existing.find(
      (s) => s.dayOfWeek === data.dayOfWeek && s.startTime === data.startTime,
    );
    if (conflict) throw new ScheduleConflictError(data.dayOfWeek, data.startTime);

    return this.repo.createSchedule({
      id: randomUUID(),
      serviceId,
      ...data,
    });
  }

  async updateSchedule(scheduleId: string, data: UpdateServiceScheduleDTO): Promise<ServiceSchedule> {
    const existing = await this.repo.findScheduleById(scheduleId);
    if (!existing) throw new ServiceScheduleNotFoundError(scheduleId);
    return this.repo.updateSchedule(scheduleId, data);
  }

  async removeSchedule(scheduleId: string): Promise<void> {
    const existing = await this.repo.findScheduleById(scheduleId);
    if (!existing) throw new ServiceScheduleNotFoundError(scheduleId);
    await this.repo.deleteSchedule(scheduleId);
  }
}
