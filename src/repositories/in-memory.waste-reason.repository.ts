import { randomUUID } from 'crypto';
import type {
  WasteReasonRepository,
  WasteReason,
  CreateWasteReasonInput,
  UpdateWasteReasonInput,
} from './waste-reason.repository.js';
import { WasteReasonNotFoundError } from '../domain/errors.js';
import type { SqlClient } from './sql.client.js';

/** Test double en memoria — mismo criterio que el resto de los InMemory*Repository. */
export class InMemoryWasteReasonRepository implements WasteReasonRepository {
  private readonly rows = new Map<string, WasteReason>();

  async findAll(businessId: string): Promise<WasteReason[]> {
    return [...this.rows.values()].filter((r) => r.businessId === businessId && r.active);
  }

  async findById(id: string): Promise<WasteReason | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: CreateWasteReasonInput): Promise<WasteReason> {
    const now = new Date();
    const reason: WasteReason = {
      id: randomUUID(),
      businessId: input.businessId,
      name: input.name,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(reason.id, reason);
    return reason;
  }

  /**
   * Construye un objeto nuevo en vez de mutar la fila existente en el lugar
   * — findById() devuelve la misma referencia guardada en `rows`, así que
   * mutarla in-place invalidaría cualquier snapshot `before` que un caller
   * (ej. WasteReasonService.updateReason(), para diffFields()) haya tomado
   * antes de llamar a update(). Mismo criterio que FakeCategoryRepository
   * en category.service.test.ts.
   */
  async update(id: string, input: UpdateWasteReasonInput): Promise<WasteReason> {
    const current = this.rows.get(id);
    if (!current) throw new WasteReasonNotFoundError(id);
    const updated: WasteReason = {
      ...current,
      ...(input.name   !== undefined && { name:   input.name }),
      ...(input.active !== undefined && { active: input.active }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  /** En memoria no hay transacción real — delega a `update()`, el `client` se ignora. */
  async updateWithClient(_client: SqlClient, id: string, input: UpdateWasteReasonInput): Promise<WasteReason> {
    return this.update(id, input);
  }

  async deactivate(id: string): Promise<void> {
    const current = this.rows.get(id);
    if (!current) throw new WasteReasonNotFoundError(id);
    this.rows.set(id, { ...current, active: false, updatedAt: new Date() });
  }
}
