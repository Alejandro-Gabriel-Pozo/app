import { describe, it, expect, beforeEach } from 'vitest';
import {
  BookableServiceService,
  BookableServiceNotFoundError,
  RatePlanNotFoundError,
  DuplicateRatePlanNameError,
  InvalidRatePlanValidityError,
} from './bookable-service.service.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import { InMemoryBookableServiceRepository } from './in-memory.bookable-service.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
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
} from './bookable-service.types.js';

/**
 * Fake mínimo de IBookableServiceRepository — no hay
 * InMemoryBookableServiceRepository en el repo todavía. Alcanza con esto
 * para probar el wiring de auditoría de updateService(), sin depender de
 * una BD. Schedules no se ejercitan en estos tests (no se auditan, ver
 * nota en bookable-service.service.ts).
 */
class FakeBookableServiceRepository implements IBookableServiceRepository {
  private readonly rows = new Map<string, BookableService>();

  seed(s: BookableService): void {
    this.rows.set(s.id, s);
  }

  async findAll(): Promise<BookableService[]> {
    return [...this.rows.values()];
  }

  async findById(id: string): Promise<BookableService | null> {
    return this.rows.get(id) ?? null;
  }

  async create(dto: CreateBookableServiceDTO): Promise<BookableService> {
    const now = new Date();
    const service: BookableService = {
      id: dto.id,
      categoryId: dto.categoryId,
      name: dto.name,
      ...(dto.description !== undefined && { description: dto.description }),
      bookingMode: dto.bookingMode,
      durationMinutes: dto.durationMinutes ?? null,
      price: dto.price,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(service.id, service);
    return service;
  }

  async update(id: string, dto: UpdateBookableServiceDTO): Promise<BookableService> {
    const current = this.rows.get(id);
    if (!current) throw new BookableServiceNotFoundError(id);
    const updated: BookableService = {
      ...current,
      ...(dto.categoryId       !== undefined && { categoryId: dto.categoryId }),
      ...(dto.name             !== undefined && { name: dto.name }),
      ...(dto.description      !== undefined && { description: dto.description }),
      ...(dto.bookingMode      !== undefined && { bookingMode: dto.bookingMode }),
      ...(dto.durationMinutes  !== undefined && { durationMinutes: dto.durationMinutes }),
      ...(dto.price            !== undefined && { price: dto.price }),
      ...(dto.active           !== undefined && { active: dto.active }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async deactivate(id: string): Promise<void> {
    const current = this.rows.get(id);
    if (current) this.rows.set(id, { ...current, active: false });
  }

  // ---- Schedules — no ejercitados en estos tests ----
  async findSchedulesByService(): Promise<ServiceSchedule[]> { return []; }
  async findScheduleById(): Promise<ServiceSchedule | null> { return null; }
  async createSchedule(dto: CreateServiceScheduleDTO): Promise<ServiceSchedule> {
    return { id: dto.id, serviceId: dto.serviceId, dayOfWeek: dto.dayOfWeek, startTime: dto.startTime, maxCapacity: dto.maxCapacity, active: true };
  }
  async updateSchedule(id: string, dto: UpdateServiceScheduleDTO): Promise<ServiceSchedule> {
    return { id, serviceId: 'x', dayOfWeek: dto.dayOfWeek ?? 0, startTime: dto.startTime ?? '00:00:00', maxCapacity: dto.maxCapacity ?? 1, active: dto.active ?? true };
  }
  async deleteSchedule(): Promise<void> {}

  // ---- Rate Plans — no ejercitados en estos tests ----
  async findRatePlansByService(): Promise<RatePlan[]> { return []; }
  async findRatePlanById(): Promise<RatePlan | null> { return null; }
  async createRatePlan(dto: CreateRatePlanDTO): Promise<RatePlan> {
    const now = new Date();
    return {
      id: dto.id, serviceId: dto.serviceId, name: dto.name, price: dto.price,
      includesBreakfast: dto.includesBreakfast ?? false,
      cancellationPolicy: dto.cancellationPolicy ?? null,
      validFrom: dto.validFrom ?? null, validTo: dto.validTo ?? null,
      active: true, createdAt: now, updatedAt: now,
    };
  }
  async updateRatePlan(id: string, dto: UpdateRatePlanDTO): Promise<RatePlan> {
    const now = new Date();
    return {
      id, serviceId: 'x', name: dto.name ?? 'x', price: dto.price ?? 0,
      includesBreakfast: dto.includesBreakfast ?? false,
      cancellationPolicy: dto.cancellationPolicy ?? null,
      validFrom: dto.validFrom ?? null, validTo: dto.validTo ?? null,
      active: dto.active ?? true, createdAt: now, updatedAt: now,
    };
  }
  async deactivateRatePlan(): Promise<void> {}
}

describe('BookableServiceService — auditoría (R8/A9.4)', () => {
  let repo: FakeBookableServiceRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: BookableServiceService;

  beforeEach(() => {
    repo      = new FakeBookableServiceRepository();
    auditRepo = new InMemoryAuditLogRepository();
    service   = new BookableServiceService(repo, auditRepo);

    const now = new Date();
    repo.seed({
      id: 'svc-corte-1',
      categoryId: 'cat-peluqueria',
      name: 'Corte de pelo',
      bookingMode: 'slot',
      durationMinutes: 30,
      price: 5000,
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  });

  it('audita un cambio de price — el escenario que motivó R8', async () => {
    await service.updateService('svc-corte-1', { price: 6000 }, 'identity-1');

    const entries = await auditRepo.findByEntity('bookable_services', 'svc-corte-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field: 'price',
      oldValue: '5000',
      newValue: '6000',
      changedBy: 'identity-1',
    });
  });

  it('no registra nada si el patch no cambia ningún valor', async () => {
    await service.updateService('svc-corte-1', { price: 5000 }, 'identity-1');
    expect(auditRepo.all()).toHaveLength(0);
  });

  it('propaga BookableServiceNotFoundError sin escribir auditoría', async () => {
    await expect(
      service.updateService('svc-inexistente', { price: 1 }, 'identity-1'),
    ).rejects.toBeInstanceOf(BookableServiceNotFoundError);

    expect(auditRepo.all()).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------
// Rate Plans (18/08/2026, spec de mejoras PMS) — usa
// InMemoryBookableServiceRepository (implementación real, no el fake
// mínimo de arriba) porque acá sí importa que las tarifas persistan de
// verdad entre llamadas dentro del mismo test.
// -----------------------------------------------------------------------
describe('BookableServiceService — Rate Plans', () => {
  let repo: InMemoryBookableServiceRepository;
  let service: BookableServiceService;

  beforeEach(() => {
    repo = new InMemoryBookableServiceRepository();
    service = new BookableServiceService(repo, new InMemoryAuditLogRepository());

    repo.seed({
      id: 'svc-doble', categoryId: 'cat-doble', name: 'Habitación Doble',
      bookingMode: 'block', durationMinutes: null, price: 15000,
      active: true, createdAt: new Date(), updatedAt: new Date(),
    });
  });

  it('crea una tarifa para un servicio existente', async () => {
    const rp = await service.addRatePlan('svc-doble', { name: 'Rack', price: 20000 });
    expect(rp.serviceId).toBe('svc-doble');
    expect(rp.price).toBe(20000);
    expect(rp.includesBreakfast).toBe(false);
  });

  it('permite varias tarifas simultáneas para el mismo servicio (el motivo de la tabla separada)', async () => {
    await service.addRatePlan('svc-doble', { name: 'Rack', price: 20000 });
    await service.addRatePlan('svc-doble', { name: 'Corporativa', price: 17000 });
    await service.addRatePlan('svc-doble', { name: 'No reembolsable', price: 15000 });

    const plans = await service.listRatePlans('svc-doble');
    expect(plans).toHaveLength(3);
  });

  it('rechaza un nombre de tarifa duplicado para el mismo servicio', async () => {
    await service.addRatePlan('svc-doble', { name: 'Rack', price: 20000 });
    await expect(
      service.addRatePlan('svc-doble', { name: 'rack', price: 21000 }), // case-insensitive
    ).rejects.toBeInstanceOf(DuplicateRatePlanNameError);
  });

  it('rechaza si el servicio no existe', async () => {
    await expect(
      service.addRatePlan('svc-inexistente', { name: 'Rack', price: 20000 }),
    ).rejects.toBeInstanceOf(BookableServiceNotFoundError);
  });

  it('rechaza validTo anterior a validFrom', async () => {
    await expect(
      service.addRatePlan('svc-doble', { name: 'Temporada', price: 25000, validFrom: '2026-12-01', validTo: '2026-11-01' }),
    ).rejects.toBeInstanceOf(InvalidRatePlanValidityError);
  });

  it('updateRatePlan cambia el precio sin tocar el nombre', async () => {
    const created = await service.addRatePlan('svc-doble', { name: 'Rack', price: 20000 });
    const updated = await service.updateRatePlan(created.id, { price: 22000 });
    expect(updated.price).toBe(22000);
    expect(updated.name).toBe('Rack');
  });

  it('updateRatePlan propaga RatePlanNotFoundError', async () => {
    await expect(
      service.updateRatePlan('rp-inexistente', { price: 1 }),
    ).rejects.toBeInstanceOf(RatePlanNotFoundError);
  });

  it('removeRatePlan desactiva (MAESTRO, R2/R3) — no la borra, deja de listarse como activa', async () => {
    const created = await service.addRatePlan('svc-doble', { name: 'Rack', price: 20000 });
    await service.removeRatePlan(created.id);

    const plans = await service.listRatePlans('svc-doble');
    expect(plans).toHaveLength(0);

    const stillThere = await repo.findRatePlanById(created.id);
    expect(stillThere).not.toBeNull();
    expect(stillThere!.active).toBe(false);
  });
});
