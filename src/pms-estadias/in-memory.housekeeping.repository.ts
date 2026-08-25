/**
 * @file in-memory.housekeeping.repository.ts
 * @description Implementación in-memory de HousekeepingRepository — para tests.
 */

import type { HousekeepingRepository } from './housekeeping.repository.js';
import type { HousekeepingTask, HousekeepingStatus } from './housekeeping-task.js';

export class InMemoryHousekeepingRepository implements HousekeepingRepository {
  private readonly tasks = new Map<string, HousekeepingTask>();

  async save(task: HousekeepingTask): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async update(task: HousekeepingTask): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async findById(id: string, businessId: string): Promise<HousekeepingTask | null> {
    const task = this.tasks.get(id);
    return task && task.businessId === businessId ? task : null;
  }

  async findByResource(resourceId: string, businessId: string): Promise<HousekeepingTask[]> {
    return [...this.tasks.values()].filter(
      (t) => t.resourceId === resourceId && t.businessId === businessId,
    );
  }

  async findByDate(businessId: string, date: string): Promise<HousekeepingTask[]> {
    // `date` es 'YYYY-MM-DD' — comparar contra el UTC del instante guardado
    // (toISOString().slice(0,10)), no contra toDateString() (usa la zona
    // horaria LOCAL del proceso, mismo bug de fondo que tenía la versión SQL).
    return [...this.tasks.values()].filter(
      (t) => t.businessId === businessId && t.scheduledFor.toISOString().slice(0, 10) === date,
    );
  }

  async findActiveByResourceAndDate(resourceId: string, businessId: string, date: string): Promise<HousekeepingTask | null> {
    const candidates = [...this.tasks.values()].filter(
      (t) => t.resourceId === resourceId && t.businessId === businessId
        && t.scheduledFor.toISOString().slice(0, 10) === date
        && t.status !== 'DONE' && t.status !== 'INSPECTED',
    );
    return candidates[0] ?? null;
  }

  async findByResourceAndDate(resourceId: string, businessId: string, date: string): Promise<HousekeepingTask | null> {
    const candidates = [...this.tasks.values()].filter(
      (t) => t.resourceId === resourceId && t.businessId === businessId
        && t.scheduledFor.toISOString().slice(0, 10) === date,
    );
    return candidates[0] ?? null;
  }

  async findByAssignee(userId: string, businessId: string): Promise<HousekeepingTask[]> {
    return [...this.tasks.values()].filter(
      (t) => t.assignedTo === userId && t.businessId === businessId,
    );
  }

  async findByStatus(businessId: string, status: HousekeepingStatus): Promise<HousekeepingTask[]> {
    return [...this.tasks.values()].filter(
      (t) => t.businessId === businessId && t.status === status,
    );
  }

  async isOutOfService(resourceId: string): Promise<boolean> {
    // J3 — mismo criterio que SqlHousekeepingRepository: la tarea más
    // reciente cuyo scheduled_for ya llegó (excluye mantenimiento
    // planificado a futuro, que no debe tapar un OUT_OF_SERVICE vigente).
    const now = Date.now();
    const candidates = [...this.tasks.values()]
      .filter((t) => t.resourceId === resourceId && t.scheduledFor.getTime() <= now)
      .sort((a, b) => {
        const byScheduled = b.scheduledFor.getTime() - a.scheduledFor.getTime();
        return byScheduled !== 0 ? byScheduled : b.updatedAt.getTime() - a.updatedAt.getTime();
      });
    return candidates[0]?.status === 'OUT_OF_SERVICE';
  }

  /** Helper de test — carga una tarea directo sin pasar por save(). */
  seed(task: HousekeepingTask): void {
    this.tasks.set(task.id, task);
  }
}
