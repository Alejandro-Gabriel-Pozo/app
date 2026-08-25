/**
 * @file in-memory.maintenance-window.repository.ts
 * @description Implementación in-memory de MaintenanceWindowRepository — para tests.
 */

import type { MaintenanceWindowRepository } from './maintenance-window.repository.js';
import type { MaintenanceWindow } from './maintenance-window.js';

export class InMemoryMaintenanceWindowRepository implements MaintenanceWindowRepository {
  private readonly windows = new Map<string, MaintenanceWindow>();

  async save(window: MaintenanceWindow): Promise<void> {
    this.windows.set(window.id, window);
  }

  async update(window: MaintenanceWindow): Promise<void> {
    this.windows.set(window.id, window);
  }

  async findById(id: string, businessId: string): Promise<MaintenanceWindow | null> {
    const window = this.windows.get(id);
    return window && window.businessId === businessId ? window : null;
  }

  async findByResource(resourceId: string, businessId: string): Promise<MaintenanceWindow[]> {
    return [...this.windows.values()].filter(
      (w) => w.resourceId === resourceId && w.businessId === businessId,
    );
  }

  async findActiveByResource(resourceId: string, businessId: string, today: string): Promise<MaintenanceWindow[]> {
    return [...this.windows.values()].filter(
      (w) => w.resourceId === resourceId && w.businessId === businessId
        && (w.endDate === null || w.endDate >= today),
    );
  }

  async findActiveByResourceId(resourceId: string, today: string): Promise<MaintenanceWindow[]> {
    return [...this.windows.values()].filter(
      (w) => w.resourceId === resourceId && (w.endDate === null || w.endDate >= today),
    );
  }

  async findAllActive(businessId: string, today: string): Promise<MaintenanceWindow[]> {
    return [...this.windows.values()].filter(
      (w) => w.businessId === businessId && (w.endDate === null || w.endDate >= today),
    );
  }

  /** Helper de test — carga una ventana directo sin pasar por save(). */
  seed(window: MaintenanceWindow): void {
    this.windows.set(window.id, window);
  }
}
