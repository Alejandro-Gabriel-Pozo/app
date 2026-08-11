/**
 * @file in-memory.bookable-service.repository.ts
 * @description Implementación in-memory de IBookableServiceRepository — para tests.
 */

import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type {
  BookableService,
  ServiceSchedule,
  CreateBookableServiceDTO,
  UpdateBookableServiceDTO,
  CreateServiceScheduleDTO,
  UpdateServiceScheduleDTO,
} from '../types/bookable-service.types.js';

export class InMemoryBookableServiceRepository implements IBookableServiceRepository {
  private readonly services = new Map<string, BookableService>();
  private readonly schedules = new Map<string, ServiceSchedule>();

  async findAll(): Promise<BookableService[]> {
    return [...this.services.values()].filter((s) => s.active);
  }

  async findById(id: string): Promise<BookableService | null> {
    return this.services.get(id) ?? null;
  }

  async create(dto: CreateBookableServiceDTO): Promise<BookableService> {
    const service: BookableService = {
      id: dto.id,
      categoryId: dto.categoryId,
      name: dto.name,
      ...(dto.description !== undefined && { description: dto.description }),
      bookingMode: dto.bookingMode,
      durationMinutes: dto.durationMinutes ?? null,
      price: dto.price,
      active: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.services.set(service.id, service);
    return service;
  }

  async update(id: string, dto: UpdateBookableServiceDTO): Promise<BookableService> {
    const existing = this.services.get(id);
    if (!existing) throw new Error(`BookableService ${id} not found`);
    const updated: BookableService = {
      ...existing,
      ...(dto.categoryId !== undefined && { categoryId: dto.categoryId }),
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.bookingMode !== undefined && { bookingMode: dto.bookingMode }),
      ...(dto.durationMinutes !== undefined && { durationMinutes: dto.durationMinutes }),
      ...(dto.price !== undefined && { price: dto.price }),
      ...(dto.active !== undefined && { active: dto.active }),
      updatedAt: new Date(),
    };
    this.services.set(id, updated);
    return updated;
  }

  async deactivate(id: string): Promise<void> {
    const existing = this.services.get(id);
    if (existing) this.services.set(id, { ...existing, active: false });
  }

  async findSchedulesByService(serviceId: string): Promise<ServiceSchedule[]> {
    return [...this.schedules.values()].filter((s) => s.serviceId === serviceId && s.active);
  }

  async findScheduleById(id: string): Promise<ServiceSchedule | null> {
    return this.schedules.get(id) ?? null;
  }

  async createSchedule(dto: CreateServiceScheduleDTO): Promise<ServiceSchedule> {
    const schedule: ServiceSchedule = { ...dto, active: true };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async updateSchedule(id: string, dto: UpdateServiceScheduleDTO): Promise<ServiceSchedule> {
    const existing = this.schedules.get(id);
    if (!existing) throw new Error(`ServiceSchedule ${id} not found`);
    const updated: ServiceSchedule = {
      ...existing,
      ...(dto.dayOfWeek !== undefined && { dayOfWeek: dto.dayOfWeek }),
      ...(dto.startTime !== undefined && { startTime: dto.startTime }),
      ...(dto.maxCapacity !== undefined && { maxCapacity: dto.maxCapacity }),
      ...(dto.active !== undefined && { active: dto.active }),
    };
    this.schedules.set(id, updated);
    return updated;
  }

  async deleteSchedule(id: string): Promise<void> {
    this.schedules.delete(id);
  }

  /** Helper de test — carga un servicio directo sin pasar por create(). */
  seed(service: BookableService): void {
    this.services.set(service.id, service);
  }
}
