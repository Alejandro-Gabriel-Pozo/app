/**
 * @file bookable-service.service.ts
 * @description Lógica de negocio para servicios agendables y sus horarios.
 */

import { randomUUID } from 'node:crypto';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type {
  BookableService,
  ServiceSchedule,
  RatePlan,
  CreateBookableServiceDTO,
  UpdateBookableServiceDTO,
  UpdateServiceScheduleDTO,
  UpdateRatePlanDTO,
} from '../types/bookable-service.types.js';
import { DomainError } from '../domain/errors.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import { diffFields } from '../domain/audit.js';

const AUDIT_ENTITY = 'bookable_services';

// ---------------------------------------------------------------------------
// Errores de dominio
//
// Extienden DomainError (no Error a secas) — ver nota en order.service.ts.
// ---------------------------------------------------------------------------

export class BookableServiceNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Servicio agendable '${id}' no encontrado.`, 'BOOKABLE_SERVICE_NOT_FOUND');
  }
}

export class ServiceScheduleNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Schedule '${id}' no encontrado.`, 'SERVICE_SCHEDULE_NOT_FOUND');
  }
}

export class ScheduleConflictError extends DomainError {
  constructor(dayOfWeek: number, startTime: string) {
    super(`Ya existe un schedule activo para día ${dayOfWeek} a las ${startTime}.`, 'SCHEDULE_CONFLICT');
  }
}

export class RatePlanNotFoundError extends DomainError {
  constructor(id: string) {
    super(`Tarifa '${id}' no encontrada.`, 'RATE_PLAN_NOT_FOUND');
  }
}

export class DuplicateRatePlanNameError extends DomainError {
  constructor(name: string) {
    super(`Ya existe una tarifa llamada '${name}' para este servicio.`, 'DUPLICATE_RATE_PLAN_NAME');
  }
}

export class InvalidRatePlanValidityError extends DomainError {
  constructor() {
    super('validTo no puede ser anterior a validFrom.', 'INVALID_RATE_PLAN_VALIDITY');
  }
}

// ---------------------------------------------------------------------------
// Servicio
// ---------------------------------------------------------------------------

export class BookableServiceService {
  constructor(
    private readonly repo: IBookableServiceRepository,
    /** Requerido para que updateService() deje rastro (R8/A9.4). */
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

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

  /**
   * `changedBy` es el identity_id (JWT sub) de quien hace el cambio — ver
   * docs/criterios-datos.md R8. createService()/deleteService() quedan
   * fuera de esta pasada, deliberado (mismo criterio que CategoryService/
   * ProductService). Schedules tampoco se auditan — son una entidad propia,
   * más chica, sin el caso de uso de precio que motivó R8.
   */
  async updateService(
    id: string,
    data: UpdateBookableServiceDTO,
    changedBy: string,
  ): Promise<BookableService> {
    const existing = await this.repo.findById(id);
    if (!existing) throw new BookableServiceNotFoundError(id);

    const updated = await this.repo.update(id, data);

    const changes = diffFields(existing, data);
    if (changes.length > 0) {
      await this.auditLogRepo.record(
        changes.map((c) => ({
          entity: AUDIT_ENTITY,
          entityId: id,
          field: c.field,
          oldValue: c.oldValue,
          newValue: c.newValue,
          changedBy,
        })),
      );
    }

    return updated;
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

  // ---- Rate Plans (18/08/2026, spec de mejoras PMS) ----

  async listRatePlans(serviceId: string): Promise<RatePlan[]> {
    const service = await this.repo.findById(serviceId);
    if (!service) throw new BookableServiceNotFoundError(serviceId);
    return this.repo.findRatePlansByService(serviceId);
  }

  async addRatePlan(
    serviceId: string,
    data: { name: string; price: number; includesBreakfast?: boolean | undefined; cancellationPolicy?: string | null | undefined; validFrom?: string | null | undefined; validTo?: string | null | undefined },
  ): Promise<RatePlan> {
    const service = await this.repo.findById(serviceId);
    if (!service) throw new BookableServiceNotFoundError(serviceId);

    assertValidRange(data.validFrom, data.validTo);

    const existing = await this.repo.findRatePlansByService(serviceId);
    if (existing.some((rp) => rp.name.toLowerCase() === data.name.toLowerCase())) {
      throw new DuplicateRatePlanNameError(data.name);
    }

    return this.repo.createRatePlan({ id: randomUUID(), serviceId, ...data });
  }

  async updateRatePlan(ratePlanId: string, data: UpdateRatePlanDTO): Promise<RatePlan> {
    const existing = await this.repo.findRatePlanById(ratePlanId);
    if (!existing) throw new RatePlanNotFoundError(ratePlanId);

    assertValidRange(
      data.validFrom !== undefined ? data.validFrom : existing.validFrom,
      data.validTo   !== undefined ? data.validTo   : existing.validTo,
    );

    if (data.name !== undefined && data.name.toLowerCase() !== existing.name.toLowerCase()) {
      const siblings = await this.repo.findRatePlansByService(existing.serviceId);
      if (siblings.some((rp) => rp.id !== ratePlanId && rp.name.toLowerCase() === data.name!.toLowerCase())) {
        throw new DuplicateRatePlanNameError(data.name);
      }
    }

    return this.repo.updateRatePlan(ratePlanId, data);
  }

  async removeRatePlan(ratePlanId: string): Promise<void> {
    const existing = await this.repo.findRatePlanById(ratePlanId);
    if (!existing) throw new RatePlanNotFoundError(ratePlanId);
    // MAESTRO (R2/R3) — deactivate, no hard-delete. Una reserva ya creada
    // con esta tarifa (reservations.rate_plan_id) sigue siendo válida e
    // intacta (R10) aunque la tarifa deje de ofrecerse para reservas nuevas.
    await this.repo.deactivateRatePlan(ratePlanId);
  }
}

function assertValidRange(validFrom: string | null | undefined, validTo: string | null | undefined): void {
  if (validFrom && validTo && validTo < validFrom) {
    throw new InvalidRatePlanValidityError();
  }
}
