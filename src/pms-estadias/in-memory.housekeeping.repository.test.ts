import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryHousekeepingRepository } from './in-memory.housekeeping.repository.js';
import { HousekeepingTask } from './housekeeping-task.js';

/**
 * J3 (23/08/2026, pendientes-2026-08-23.md) — isOutOfService() antes miraba
 * CUALQUIER tarea OUT_OF_SERVICE del recurso sin importar antigüedad, así
 * que una tarea vieja sin resetear bloqueaba el recurso para siempre.
 * Mismo comportamiento esperado que SqlHousekeepingRepository (ver
 * housekeeping.repository.ts) — este test cubre la versión in-memory
 * directamente y documenta el contrato que ambas implementaciones comparten.
 */
describe('InMemoryHousekeepingRepository.isOutOfService', () => {
  let repo: InMemoryHousekeepingRepository;

  beforeEach(() => {
    repo = new InMemoryHousekeepingRepository();
  });

  function restoreTask(overrides: Partial<Parameters<typeof HousekeepingTask.restore>[0]>) {
    return HousekeepingTask.restore({
      id: 'hk-1', businessId: 'biz-1', resourceId: 'room-1',
      assignedTo: null, status: 'PENDING', notes: null,
      shift: 'MORNING', scheduledFor: new Date('2020-01-01T08:00:00Z'),
      startedAt: null, completedAt: null, inspectedAt: null, inspectedBy: null,
      notBefore: null, createdAt: new Date('2020-01-01T08:00:00Z'), updatedAt: new Date('2020-01-01T08:00:00Z'),
      ...overrides,
    });
  }

  it('sin ninguna tarea, no está fuera de servicio', async () => {
    expect(await repo.isOutOfService('room-1')).toBe(false);
  });

  it('una tarea OUT_OF_SERVICE vigente (scheduledFor ya pasó) bloquea el recurso', async () => {
    repo.seed(restoreTask({ id: 'hk-1', status: 'OUT_OF_SERVICE', scheduledFor: new Date('2020-01-01T08:00:00Z') }));
    expect(await repo.isOutOfService('room-1')).toBe(true);
  });

  it('una tarea OUT_OF_SERVICE vieja NO bloquea si hay una tarea PENDING más reciente (el bug real)', async () => {
    repo.seed(restoreTask({ id: 'hk-old', status: 'OUT_OF_SERVICE', scheduledFor: new Date('2020-01-01T08:00:00Z'), updatedAt: new Date('2020-01-01T08:00:00Z') }));
    repo.seed(restoreTask({ id: 'hk-new', status: 'PENDING', scheduledFor: new Date('2020-06-01T08:00:00Z'), updatedAt: new Date('2020-06-01T08:00:00Z') }));
    expect(await repo.isOutOfService('room-1')).toBe(false);
  });

  it('una tarea planificada a FUTURO no tapa un OUT_OF_SERVICE vigente de hoy', async () => {
    const now = Date.now();
    repo.seed(restoreTask({ id: 'hk-today', status: 'OUT_OF_SERVICE', scheduledFor: new Date(now - 60 * 60 * 1000), updatedAt: new Date(now - 60 * 60 * 1000) }));
    repo.seed(restoreTask({ id: 'hk-future', status: 'PENDING', scheduledFor: new Date(now + 7 * 24 * 60 * 60 * 1000), updatedAt: new Date(now + 7 * 24 * 60 * 60 * 1000) }));
    expect(await repo.isOutOfService('room-1')).toBe(true);
  });

  it('resetear la tarea vigente a PENDING desbloquea el recurso', async () => {
    const task = restoreTask({ id: 'hk-1', status: 'OUT_OF_SERVICE', scheduledFor: new Date('2020-01-01T08:00:00Z') });
    repo.seed(task);
    expect(await repo.isOutOfService('room-1')).toBe(true);

    task.resetToPending();
    await repo.update(task);
    expect(await repo.isOutOfService('room-1')).toBe(false);
  });

  it('no mezcla recursos distintos', async () => {
    repo.seed(restoreTask({ id: 'hk-1', resourceId: 'room-1', status: 'OUT_OF_SERVICE' }));
    expect(await repo.isOutOfService('room-2')).toBe(false);
  });
});
