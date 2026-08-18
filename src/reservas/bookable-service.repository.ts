/**
 * @file bookable-service.repository.ts
 * @description Interfaz del repositorio de servicios agendables y schedules.
 */

import type {
  BookableService,
  ServiceSchedule,
  RatePlan,
  CreateBookableServiceDTO,
  UpdateBookableServiceDTO,
  CreateServiceScheduleDTO,
  UpdateServiceScheduleDTO,
  CreateRatePlanDTO,
  UpdateRatePlanDTO,
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

  // ---- Rate Plans (18/08/2026, spec de mejoras PMS) ----
  // MAESTRO (docs/criterios-datos.md R2/R3): nunca hard-delete, por eso
  // "deactivateRatePlan" y no "deleteRatePlan" — distinto criterio que
  // deleteSchedule() de arriba (schedules no son MAESTRO).
  findRatePlansByService(serviceId: string): Promise<RatePlan[]>;
  findRatePlanById(id: string): Promise<RatePlan | null>;
  createRatePlan(dto: CreateRatePlanDTO): Promise<RatePlan>;
  updateRatePlan(id: string, dto: UpdateRatePlanDTO): Promise<RatePlan>;
  deactivateRatePlan(id: string): Promise<void>;
}
