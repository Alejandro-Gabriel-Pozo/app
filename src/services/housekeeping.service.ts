/**
 * @file housekeeping.service.ts
 * @description Casos de uso del módulo Housekeeping.
 *
 * Responsabilidades:
 * - Crear y planificar tareas de limpieza por turno
 * - Asignar tareas a personal de housekeeping
 * - Transicionar estados: start → complete → inspect
 * - Marcar recursos como fuera de servicio / volver a PENDING
 * - Consultar tablero por fecha, recurso o empleado asignado
 */

import { HousekeepingTask, HousekeepingStatus } from '../domain/housekeeping-task.js';
import type { HousekeepingRepository } from '../repositories/housekeeping.repository.js';
import { DomainError } from '../domain/errors.js';

export class HousekeepingTaskNotFoundError extends DomainError {
  constructor(taskId: string) {
    super(`Tarea de housekeeping no encontrada: ${taskId}`, 'HOUSEKEEPING_TASK_NOT_FOUND');
  }
}

export interface CreateTaskInput {
  businessId: string;
  resourceId: string;
  shift: string;
  scheduledFor: Date;
  notes?: string;
}

export interface AssignTaskInput {
  taskId: string;
  userId: string;
  businessId: string;
}

export class HousekeepingService {
  constructor(
    private readonly housekeepingRepository: HousekeepingRepository,
  ) {}

  // ---------------------------------------------------------------------------
  // Crear tarea
  // ---------------------------------------------------------------------------

  async createTask(input: CreateTaskInput): Promise<HousekeepingTask> {
    const task = HousekeepingTask.create(input);
    await this.housekeepingRepository.save(task);
    return task;
  }

  // ---------------------------------------------------------------------------
  // Asignar empleado
  // ---------------------------------------------------------------------------

  async assignTask(input: AssignTaskInput): Promise<HousekeepingTask> {
    const task = await this.getTaskOrThrow(input.taskId, input.businessId);
    task.assign(input.userId);
    await this.housekeepingRepository.update(task);
    return task;
  }

  // ---------------------------------------------------------------------------
  // Transiciones de estado
  // ---------------------------------------------------------------------------

  async startTask(taskId: string, businessId: string): Promise<HousekeepingTask> {
    const task = await this.getTaskOrThrow(taskId, businessId);
    task.start();
    await this.housekeepingRepository.update(task);
    return task;
  }

  async completeTask(taskId: string, businessId: string, notes?: string): Promise<HousekeepingTask> {
    const task = await this.getTaskOrThrow(taskId, businessId);
    task.complete(notes);
    await this.housekeepingRepository.update(task);
    return task;
  }

  async inspectTask(taskId: string, businessId: string, inspectorId: string): Promise<HousekeepingTask> {
    const task = await this.getTaskOrThrow(taskId, businessId);
    task.inspect(inspectorId);
    await this.housekeepingRepository.update(task);
    return task;
  }

  // ---------------------------------------------------------------------------
  // Fuera de servicio
  // ---------------------------------------------------------------------------

  async setOutOfService(taskId: string, businessId: string, reason?: string): Promise<HousekeepingTask> {
    const task = await this.getTaskOrThrow(taskId, businessId);
    task.setOutOfService(reason);
    await this.housekeepingRepository.update(task);
    return task;
  }

  async resetToPending(taskId: string, businessId: string): Promise<HousekeepingTask> {
    const task = await this.getTaskOrThrow(taskId, businessId);
    task.resetToPending();
    await this.housekeepingRepository.update(task);
    return task;
  }

  // ---------------------------------------------------------------------------
  // Consultas (tablero)
  // ---------------------------------------------------------------------------

  async getTaskById(taskId: string, businessId: string): Promise<HousekeepingTask | null> {
    return this.housekeepingRepository.findById(taskId, businessId);
  }

  async getTasksByDate(businessId: string, date: Date): Promise<HousekeepingTask[]> {
    return this.housekeepingRepository.findByDate(businessId, date);
  }

  async getTasksByResource(resourceId: string, businessId: string): Promise<HousekeepingTask[]> {
    return this.housekeepingRepository.findByResource(resourceId, businessId);
  }

  async getTasksByAssignee(userId: string, businessId: string): Promise<HousekeepingTask[]> {
    return this.housekeepingRepository.findByAssignee(userId, businessId);
  }

  async getTasksByStatus(businessId: string, status: HousekeepingStatus): Promise<HousekeepingTask[]> {
    return this.housekeepingRepository.findByStatus(businessId, status);
  }

  // ---------------------------------------------------------------------------
  // Privado
  // ---------------------------------------------------------------------------

  private async getTaskOrThrow(taskId: string, businessId: string): Promise<HousekeepingTask> {
    const task = await this.housekeepingRepository.findById(taskId, businessId);
    if (!task) {
      throw new HousekeepingTaskNotFoundError(taskId);
    }
    return task;
  }
}
