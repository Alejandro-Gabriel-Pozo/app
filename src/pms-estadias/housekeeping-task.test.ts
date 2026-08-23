import { describe, it, expect } from 'vitest';
import { HousekeepingTask, InvalidHousekeepingTransitionError } from './housekeeping-task.js';

describe('HousekeepingTask.allowedTransitions (A3, deuda estructural)', () => {
  function makeTask() {
    return HousekeepingTask.create({
      businessId: 'biz-1',
      resourceId: 'room-1',
      shift: 'MORNING',
      scheduledFor: new Date('2030-01-01T08:00:00Z'),
    });
  }

  it('PENDING permite ASSIGNED, IN_PROGRESS y OUT_OF_SERVICE', () => {
    const task = makeTask();
    expect(task.status).toBe('PENDING');
    expect(task.allowedTransitions).toEqual(['ASSIGNED', 'IN_PROGRESS', 'OUT_OF_SERVICE']);
  });

  it('ASSIGNED permite IN_PROGRESS y OUT_OF_SERVICE (no incluye reasignar)', () => {
    const task = makeTask();
    task.assign('user-1');
    expect(task.allowedTransitions).toEqual(['IN_PROGRESS', 'OUT_OF_SERVICE']);
  });

  it('IN_PROGRESS permite DONE y OUT_OF_SERVICE', () => {
    const task = makeTask();
    task.assign('user-1');
    task.start();
    expect(task.allowedTransitions).toEqual(['DONE', 'OUT_OF_SERVICE']);
  });

  it('DONE permite INSPECTED y OUT_OF_SERVICE', () => {
    const task = makeTask();
    task.assign('user-1');
    task.start();
    task.complete();
    expect(task.allowedTransitions).toEqual(['INSPECTED', 'OUT_OF_SERVICE']);
  });

  it('INSPECTED es terminal — sin transiciones', () => {
    const task = makeTask();
    task.assign('user-1');
    task.start();
    task.complete();
    task.inspect('user-2');
    expect(task.allowedTransitions).toEqual([]);
  });

  it('OUT_OF_SERVICE solo permite volver a PENDING', () => {
    const task = makeTask();
    task.setOutOfService('rota');
    expect(task.allowedTransitions).toEqual(['PENDING']);
  });

  it('toJSON() incluye allowedTransitions', () => {
    const task = makeTask();
    expect(task.toJSON().allowedTransitions).toEqual(['ASSIGNED', 'IN_PROGRESS', 'OUT_OF_SERVICE']);
  });
});

// J2 (23/08/2026, pendientes-2026-08-23.md) — no se puede planificar una
// tarea con scheduledFor ya pasado. Instante exacto (decisión confirmada).
describe('HousekeepingTask.create — scheduledFor en el pasado', () => {
  it('rechaza crear con scheduledFor en el pasado', () => {
    expect(() =>
      HousekeepingTask.create({
        businessId: 'biz-1',
        resourceId: 'room-1',
        shift: 'MORNING',
        scheduledFor: new Date('2020-01-01T08:00:00Z'),
      }),
    ).toThrow(InvalidHousekeepingTransitionError);
  });

  it('acepta crear con scheduledFor futuro', () => {
    const task = HousekeepingTask.create({
      businessId: 'biz-1',
      resourceId: 'room-1',
      shift: 'MORNING',
      scheduledFor: new Date('2030-01-01T08:00:00Z'),
    });
    expect(task.status).toBe('PENDING');
  });
});
