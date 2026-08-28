import { randomUUID } from 'crypto';
import type {
  ConsumptionDestinationRepository,
  ConsumptionDestination,
  CreateConsumptionDestinationInput,
  UpdateConsumptionDestinationInput,
} from './consumption-destination.repository.js';
import { ConsumptionDestinationNotFoundError } from '../domain/errors.js';
import type { SqlClient } from './sql.client.js';

/** Test double en memoria — mismo criterio que el resto de los InMemory*Repository. */
export class InMemoryConsumptionDestinationRepository implements ConsumptionDestinationRepository {
  private readonly rows = new Map<string, ConsumptionDestination>();

  async findAll(businessId: string): Promise<ConsumptionDestination[]> {
    return [...this.rows.values()].filter((r) => r.businessId === businessId && r.active);
  }

  async findById(id: string): Promise<ConsumptionDestination | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: CreateConsumptionDestinationInput): Promise<ConsumptionDestination> {
    const now = new Date();
    const destination: ConsumptionDestination = {
      id: randomUUID(),
      businessId: input.businessId,
      name: input.name,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(destination.id, destination);
    return destination;
  }

  /**
   * Construye un objeto nuevo en vez de mutar la fila existente en el lugar
   * — mismo criterio que InMemoryWasteReasonRepository.update() (ver ese
   * docblock): un snapshot `before` tomado antes de llamar a update() no
   * debe invalidarse.
   */
  async update(id: string, input: UpdateConsumptionDestinationInput): Promise<ConsumptionDestination> {
    const current = this.rows.get(id);
    if (!current) throw new ConsumptionDestinationNotFoundError(id);
    const updated: ConsumptionDestination = {
      ...current,
      ...(input.name   !== undefined && { name:   input.name }),
      ...(input.active !== undefined && { active: input.active }),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  /** En memoria no hay transacción real — delega a `update()`, el `client` se ignora. */
  async updateWithClient(_client: SqlClient, id: string, input: UpdateConsumptionDestinationInput): Promise<ConsumptionDestination> {
    return this.update(id, input);
  }

  async deactivate(id: string): Promise<void> {
    const current = this.rows.get(id);
    if (!current) throw new ConsumptionDestinationNotFoundError(id);
    this.rows.set(id, { ...current, active: false, updatedAt: new Date() });
  }
}
