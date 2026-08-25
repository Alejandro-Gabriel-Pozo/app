import { describe, it, expect } from 'vitest';
import {
  MaintenanceWindow,
  InvalidMaintenanceWindowDatesError,
  MaintenanceWindowAlreadyClosedError,
} from './maintenance-window.js';

describe('MaintenanceWindow.create', () => {
  it('crea una ventana ABIERTA cuando no se pasa endDate', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', createdBy: 'user-1',
    });
    expect(window.endDate).toBeNull();
    expect(window.isOpenEnded).toBe(true);
    expect(window.closedAt).toBeNull();
    expect(window.closedBy).toBeNull();
  });

  it('crea una ventana con endDate fijo cuando endDate >= startDate', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', endDate: '2026-08-30', createdBy: 'user-1',
    });
    expect(window.endDate).toBe('2026-08-30');
    expect(window.isOpenEnded).toBe(false);
  });

  it('rechaza si endDate es anterior a startDate', () => {
    expect(() =>
      MaintenanceWindow.create({
        businessId: 'biz-1', resourceId: 'room-1',
        startDate: '2026-08-24', endDate: '2026-08-01', createdBy: 'user-1',
      }),
    ).toThrow(InvalidMaintenanceWindowDatesError);
  });

  it('acepta endDate igual a startDate (ventana de un solo día)', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', endDate: '2026-08-24', createdBy: 'user-1',
    });
    expect(window.endDate).toBe('2026-08-24');
  });
});

describe('MaintenanceWindow.close', () => {
  it('cierra una ventana ABIERTA -- endDate pasa de null a closeDate', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', createdBy: 'user-1',
    });
    window.close('user-2', '2026-09-01');
    expect(window.endDate).toBe('2026-09-01');
    expect(window.closedBy).toBe('user-2');
    expect(window.closedAt).not.toBeNull();
  });

  it('adelanta el cierre de una ventana que ya tenía endDate fijo a futuro', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', endDate: '2026-12-31', createdBy: 'user-1',
    });
    window.close('user-2', '2026-09-01');
    expect(window.endDate).toBe('2026-09-01');
  });

  it('rechaza cerrar una ventana ya cerrada', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', createdBy: 'user-1',
    });
    window.close('user-2', '2026-09-01');
    expect(() => window.close('user-3', '2026-09-05')).toThrow(MaintenanceWindowAlreadyClosedError);
  });

  it('rechaza cerrar con una fecha anterior a startDate', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', createdBy: 'user-1',
    });
    expect(() => window.close('user-2', '2026-08-01')).toThrow(InvalidMaintenanceWindowDatesError);
  });
});

describe('MaintenanceWindow.restore/toJSON', () => {
  it('restore() rehidrata sin re-ejecutar las validaciones de create()', () => {
    const now = new Date();
    const window = MaintenanceWindow.restore({
      id: 'mw-1', businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', endDate: null, reason: null,
      createdBy: 'user-1', closedBy: null, closedAt: null,
      createdAt: now, updatedAt: now,
    });
    expect(window.id).toBe('mw-1');
    expect(window.isOpenEnded).toBe(true);
  });

  it('toJSON() incluye isOpenEnded calculado', () => {
    const window = MaintenanceWindow.create({
      businessId: 'biz-1', resourceId: 'room-1',
      startDate: '2026-08-24', endDate: '2026-08-30', createdBy: 'user-1',
    });
    expect(window.toJSON().isOpenEnded).toBe(false);
  });
});
