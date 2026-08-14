import { describe, it, expect, beforeEach } from 'vitest';
import { BookableServiceService, BookableServiceNotFoundError } from './bookable-service.service.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import type { IBookableServiceRepository } from '../repositories/bookable-service.repository.js';
import type {
  BookableService,
  ServiceSchedule,
  CreateBookableServiceDTO,
  UpdateBookableServiceDTO,
  CreateServiceScheduleDTO,
  UpdateServiceScheduleDTO,
} from '../types/bookable-service.types.js';

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
