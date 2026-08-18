import { describe, it, expect, beforeEach } from 'vitest';
import { CategoryService } from './category.service.js';
import { CategoryNotFoundError, PlanLimitError } from '../domain/errors.js';
import { InMemoryAuditLogRepository } from '../repositories/in-memory.audit-log.repository.js';
import { BusinessPlan } from '../types/enums.js';
import type { ICategoryRepository } from './category.repository.js';
import type { PlanLimits } from '../config/plan-limits.js';
import type {
  ResourceCategory,
  CreateCategoryDTO,
  UpdateCategoryDTO,
} from '../types/resource-category.types.js';

/**
 * Fake mínimo de ICategoryRepository — no hay InMemoryCategoryRepository en
 * el repo todavía (los tests existentes de categorías se apoyan en SQL real
 * o en el router). Alcanza con esto para probar el wiring de auditoría de
 * CategoryService, sin depender de una BD.
 */
class FakeCategoryRepository implements ICategoryRepository {
  private readonly rows = new Map<string, ResourceCategory>();

  seed(cat: ResourceCategory): void {
    this.rows.set(cat.id, cat);
  }

  async findAll(): Promise<ResourceCategory[]> {
    return [...this.rows.values()];
  }

  async findById(id: string): Promise<ResourceCategory | null> {
    return this.rows.get(id) ?? null;
  }

  async countActive(): Promise<number> {
    return [...this.rows.values()].filter((c) => c.active).length;
  }

  async create(dto: CreateCategoryDTO): Promise<ResourceCategory> {
    const now = new Date();
    const cat: ResourceCategory = {
      id: dto.id,
      name: dto.name,
      ...(dto.description !== undefined && { description: dto.description }),
      fields: dto.fields,
      active: true,
      isLodging: dto.isLodging ?? false,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(cat.id, cat);
    return cat;
  }

  async update(id: string, dto: UpdateCategoryDTO): Promise<ResourceCategory> {
    const current = this.rows.get(id);
    if (!current) throw new CategoryNotFoundError(id);
    const updated: ResourceCategory = {
      ...current,
      ...(dto.name        !== undefined && { name: dto.name }),
      ...(dto.description !== undefined && { description: dto.description }),
      ...(dto.fields      !== undefined && { fields: dto.fields }),
      ...(dto.active      !== undefined && { active: dto.active }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async deactivate(id: string): Promise<void> {
    const current = this.rows.get(id);
    if (current) this.rows.set(id, { ...current, active: false });
  }
}

describe('CategoryService — auditoría (R8/A9.4)', () => {
  let categoryRepo: FakeCategoryRepository;
  let auditRepo: InMemoryAuditLogRepository;
  let service: CategoryService;

  beforeEach(() => {
    categoryRepo = new FakeCategoryRepository();
    auditRepo    = new InMemoryAuditLogRepository();
    service      = new CategoryService(categoryRepo, auditRepo);

    categoryRepo.seed({
      id: 'cat-salon-1',
      name: 'Salon',
      fields: [],
      active: true,
      isLodging: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  it('registra un audit_log entry por cada campo que cambió', async () => {
    await service.updateCategory('cat-salon-1', { name: 'Salon VIP' }, 'identity-1');

    const entries = await auditRepo.findByEntity('resource_categories', 'cat-salon-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      field: 'name',
      oldValue: 'Salon',
      newValue: 'Salon VIP',
      changedBy: 'identity-1',
    });
  });

  it('no registra nada si el patch no cambia ningún valor', async () => {
    await service.updateCategory('cat-salon-1', { name: 'Salon' }, 'identity-1');

    const entries = await auditRepo.findByEntity('resource_categories', 'cat-salon-1');
    expect(entries).toHaveLength(0);
  });

  it('registra varios campos cambiados en la misma llamada', async () => {
    await service.updateCategory(
      'cat-salon-1',
      { name: 'Salon VIP', active: false },
      'identity-1',
    );

    const entries = await auditRepo.findByEntity('resource_categories', 'cat-salon-1');
    expect(entries.map((e) => e.field).sort()).toEqual(['active', 'name']);
  });

  it('sigue devolviendo la categoría actualizada aunque no haya cambios auditables', async () => {
    const result = await service.updateCategory('cat-salon-1', {}, 'identity-1');
    expect(result.id).toBe('cat-salon-1');
  });

  it('propaga CategoryNotFoundError sin escribir auditoría', async () => {
    await expect(
      service.updateCategory('cat-inexistente', { name: 'x' }, 'identity-1'),
    ).rejects.toBeInstanceOf(CategoryNotFoundError);

    expect(auditRepo.all()).toHaveLength(0);
  });
});

/**
 * `limits` ahora lo resuelve la capa HTTP (categories.routes.ts, vía
 * AppContainer.getPlanLimits) y se lo pasa armado al service (18/08/2026,
 * PLAN_LIMITS pasó de constante TS a tabla `plan_limits`) — este test
 * verifica que CategoryService.createCategory() sigue respetando ese
 * límite sin importar de dónde salió el objeto `PlanLimits`.
 */
describe('CategoryService.createCategory() — límite de plan', () => {
  let categoryRepo: FakeCategoryRepository;
  let service: CategoryService;

  beforeEach(() => {
    categoryRepo = new FakeCategoryRepository();
    service      = new CategoryService(categoryRepo, new InMemoryAuditLogRepository());
  });

  const limitsFor = (maxCategories: number): PlanLimits => ({
    maxCategories,
    maxResources: Infinity,
    maxActiveMemberships: Infinity,
    allowedRoleNames: 'ALL',
  });

  it('crea la categoría si todavía no alcanzó el límite del plan', async () => {
    const category = await service.createCategory(
      { name: 'Salon', fields: [] },
      BusinessPlan.FREE,
      limitsFor(1),
    );
    expect(category.name).toBe('Salon');
  });

  it('rechaza con PlanLimitError si ya alcanzó maxCategories', async () => {
    await service.createCategory({ name: 'Salon', fields: [] }, BusinessPlan.FREE, limitsFor(1));

    await expect(
      service.createCategory({ name: 'Otra', fields: [] }, BusinessPlan.FREE, limitsFor(1)),
    ).rejects.toBeInstanceOf(PlanLimitError);
  });

  it('plan con maxCategories = Infinity nunca rechaza', async () => {
    for (let i = 0; i < 5; i++) {
      await service.createCategory({ name: `Cat ${i}`, fields: [] }, BusinessPlan.PRO, limitsFor(Infinity));
    }
    expect(await categoryRepo.countActive()).toBe(5);
  });
});
