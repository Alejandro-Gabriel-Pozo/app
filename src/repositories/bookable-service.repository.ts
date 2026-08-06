/**
 * @file bookable-service.repository.ts
 * @description Interfaz del repositorio de servicios agendables y schedules.
 */

import type {
  BookableService,
  ServiceSchedule,
  CreateBookableServiceDTO,
  UpdateBookableServiceDTO,
  CreateServiceScheduleDTO,
  UpdateServiceScheduleDTO,
} from '../types/bookable-service.types.js';

export interface IBookableServiceRepository {
  // ---- Bookable Services ----
  findAll(): Promise<BookableService[]>;
  findById(id: string): Promise<BookableService | null>;
  create(dto: CreateBookableServiceDTO): Promise<BookableService>;
  update(id: string, dto: UpdateBookableServiceDTO): Promise<BookableService>;
  deactivate(id: string): Promise<void>;

  // ---- Service Schedules ----
  findSchedulesByService(serviceId: string): Promise<ServiceSchedule[]>;
  findScheduleById(id: string): Promise<ServiceSchedule | null>;
  createSchedule(dto: CreateServiceScheduleDTO): Promise<ServiceSchedule>;
  updateSchedule(id: string, dto: UpdateServiceScheduleDTO): Promise<ServiceSchedule>;
  deleteSchedule(id: string): Promise<void>;
}
