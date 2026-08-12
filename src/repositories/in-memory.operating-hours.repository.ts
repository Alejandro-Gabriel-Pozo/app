/**
 * @file in-memory.operating-hours.repository.ts
 * @description Implementación in-memory de IOperatingHoursRepository — para tests.
 */

import type {
  IOperatingHoursRepository,
  OperatingWindow,
  CreateBusinessWindowDto,
  CreateResourceWindowDto,
} from './operating-hours.repository.js';

interface ResourceWindowRecord extends OperatingWindow {
  resourceId: string;
}

export class InMemoryOperatingHoursRepository implements IOperatingHoursRepository {
  private readonly businessWindows: OperatingWindow[] = [];
  private readonly resourceWindows: ResourceWindowRecord[] = [];

  async getAllBusinessWindows(): Promise<OperatingWindow[]> {
    return [...this.businessWindows].sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
  }

  async createBusinessWindow(dto: CreateBusinessWindowDto): Promise<OperatingWindow> {
    const window: OperatingWindow = { id: dto.id, dayOfWeek: dto.dayOfWeek, startTime: dto.startTime, endTime: dto.endTime };
    this.businessWindows.push(window);
    return window;
  }

  async deleteBusinessWindow(id: string): Promise<void> {
    const idx = this.businessWindows.findIndex((w) => w.id === id);
    if (idx >= 0) this.businessWindows.splice(idx, 1);
  }

  async getResourceWindows(resourceId: string): Promise<OperatingWindow[]> {
    return this.resourceWindows
      .filter((w) => w.resourceId === resourceId)
      .sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime));
  }

  async createResourceWindow(dto: CreateResourceWindowDto): Promise<OperatingWindow> {
    const window: ResourceWindowRecord = {
      id: dto.id, resourceId: dto.resourceId, dayOfWeek: dto.dayOfWeek, startTime: dto.startTime, endTime: dto.endTime,
    };
    this.resourceWindows.push(window);
    return window;
  }

  async deleteResourceWindow(id: string): Promise<void> {
    const idx = this.resourceWindows.findIndex((w) => w.id === id);
    if (idx >= 0) this.resourceWindows.splice(idx, 1);
  }

  async getEffectiveWindows(resourceId: string, dayOfWeek: number): Promise<OperatingWindow[]> {
    const resourceSpecific = this.resourceWindows.filter((w) => w.resourceId === resourceId && w.dayOfWeek === dayOfWeek);
    if (resourceSpecific.length > 0) {
      return resourceSpecific.sort((a, b) => a.startTime.localeCompare(b.startTime));
    }
    return this.businessWindows
      .filter((w) => w.dayOfWeek === dayOfWeek)
      .sort((a, b) => a.startTime.localeCompare(b.startTime));
  }

  /** Helpers de test */
  seedBusiness(windows: OperatingWindow[]): void {
    this.businessWindows.push(...windows);
  }

  seedResource(resourceId: string, windows: OperatingWindow[]): void {
    this.resourceWindows.push(...windows.map((w) => ({ ...w, resourceId })));
  }
}
