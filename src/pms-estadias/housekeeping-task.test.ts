import { describe, it, expect, vi, afterEach } from 'vitest';
import { HousekeepingTask, InvalidHousekeepingTransitionError } from './housekeeping-task.js';

const TZ = 'America/Argentina/Buenos_Aires';

describe('HousekeepingTask.allowedTransitions (A3, deuda estructural)', () => {
  function makeTask() {
    return HousekeepingTask.create({
      businessId: 'biz-1',
      resourceId: 'room-1',
      shift: 'MORNING',
      scheduledFor: new Date('2030-01-01T08:00:00Z'),
      businessTimezone: TZ,
    });
  }

  it('PENDING permite ASSIGNED e IN_PROGRESS', () => {
    const task = makeTask();
    expect(task.status).toBe('PENDING');
    expect(task.allowedTransitions).toEqual(['ASSIGNED', 'IN_PROGRESS']);
  });

  it('ASSIGNED permite IN_PROGRESS (no incluye reasignar)', () => {
    const task = makeTask();
    task.assign('user-1');
    expect(task.allowedTransitions).toEqual(['IN_PROGRESS']);
  });

  it('IN_PROGRESS permite DONE', () => {
    const task = makeTask();
    task.assign('user-1');
    task.start();
    expect(task.allowedTransitions).toEqual(['DONE']);
  });

  it('DONE permite INSPECTED', () => {
    const task = makeTask();
    task.assign('user-1');
    task.start();
    task.complete();
    expect(task.allowedTransitions).toEqual(['INSPECTED']);
  });

  it('INSPECTED es terminal — sin transiciones', () => {
    const task = makeTask();
    task.assign('user-1');
    task.start();
    task.complete();
    task.inspect('user-2');
    expect(task.allowedTransitions).toEqual([]);
  });

  // 25/08/2026 -- OUT_OF_SERVICE ya no tiene ningún comando que
  // transicione hacia/desde ese status (setOutOfService()/resetToPending()
  // se borraron, huérfanos desde que maintenance_window los reemplazó el
  // 24/08/2026) -- una fila histórica con ese status queda sin transiciones.
  it('OUT_OF_SERVICE (histórico) no tiene transiciones -- sin comando que lo alcance', () => {
    const task = HousekeepingTask.restore({
      id: 'task-legacy', businessId: 'biz-1', resourceId: 'room-1',
      assignedTo: null, status: 'OUT_OF_SERVICE', notes: 'rota', shift: 'MORNING',
      scheduledFor: new Date('2026-01-01T08:00:00Z'),
      startedAt: null, completedAt: null, inspectedAt: null, inspectedBy: null,
      notBefore: null, createdAt: new Date(), updatedAt: new Date(),
    });
    expect(task.allowedTransitions).toEqual([]);
  });

  it('toJSON() incluye allowedTransitions', () => {
    const task = makeTask();
    expect(task.toJSON().allowedTransitions).toEqual(['ASSIGNED', 'IN_PROGRESS']);
  });
});

// J2 (23/08/2026, pendientes-2026-08-23.md) — no se puede planificar una
// tarea con scheduledFor ya pasado.
//
// 25/08/2026 (pendientes-2026-08-25.md) — el guard pasó de comparar
// instante exacto a comparar DÍA DE NEGOCIO (A4.4) en el huso del negocio
// (A4.2): la pantalla manual "Planificar tarea" siempre manda medianoche
// como hora, así que "hoy" tiene que ser válido sin importar qué hora es
// ahora -- ver el test "acepta scheduledFor de hoy después de medianoche
// local" de abajo, que es exactamente el caso que rompía antes.
describe('HousekeepingTask.create — scheduledFor en el pasado', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rechaza crear con scheduledFor en el pasado', () => {
    expect(() =>
      HousekeepingTask.create({
        businessId: 'biz-1',
        resourceId: 'room-1',
        shift: 'MORNING',
        scheduledFor: new Date('2020-01-01T08:00:00Z'),
        businessTimezone: TZ,
      }),
    ).toThrow(InvalidHousekeepingTransitionError);
  });

  it('acepta crear con scheduledFor futuro', () => {
    const task = HousekeepingTask.create({
      businessId: 'biz-1',
      resourceId: 'room-1',
      shift: 'MORNING',
      scheduledFor: new Date('2030-01-01T08:00:00Z'),
      businessTimezone: TZ,
    });
    expect(task.status).toBe('PENDING');
  });

  it('acepta scheduledFor de hoy después de medianoche local (bug real, 25/08/2026)', () => {
    // "Ahora" = hoy 21:18 hora de Argentina (mucho después de medianoche
    // local) -- reloj real que disparó el bug en producción, según quedó
    // documentado en pendientes-2026-08-25.md.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T21:18:00-03:00'));

    // scheduledFor = medianoche de HOY en huso local -- exactamente lo que
    // manda `handleCreate` de housekeeping/page.tsx (`${date}T00:00`).
    const scheduledFor = new Date('2026-08-25T00:00:00-03:00');

    const task = HousekeepingTask.create({
      businessId: 'biz-1',
      resourceId: 'room-1',
      shift: 'MORNING',
      scheduledFor,
      businessTimezone: TZ,
    });
    expect(task.status).toBe('PENDING');
  });

  it('rechaza scheduledFor de ayer aunque sea antes de la hora actual de hoy', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-25T21:18:00-03:00'));

    expect(() =>
      HousekeepingTask.create({
        businessId: 'biz-1',
        resourceId: 'room-1',
        shift: 'MORNING',
        scheduledFor: new Date('2026-08-24T08:00:00-03:00'),
        businessTimezone: TZ,
      }),
    ).toThrow(InvalidHousekeepingTransitionError);
  });
});
