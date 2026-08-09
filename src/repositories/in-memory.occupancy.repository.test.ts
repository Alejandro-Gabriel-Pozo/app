import { describe, it, expect, beforeEach } from 'vitest';
import { ReservationStatus } from '../types/enums.js';
import { InMemoryOccupancyRepository } from './in-memory.occupancy.repository.js';
import type { OccupancyRepository } from './occupancy.repository.js';

const CAT_ID   = 'cat-mesas';
const CAT_NAME = 'Mesas';

describe('OccupancyRepository (In-Memory)', () => {
  let repo: OccupancyRepository;

  beforeEach(() => {
    repo = new InMemoryOccupancyRepository();
  });

  describe('recordReservation', () => {
    it('debe registrar una reserva confirmada', async () => {
      const start = new Date('2026-06-21T10:00:00');
      const end = new Date('2026-06-21T12:00:00');

      await repo.recordReservation('r1', 'Mesa A', CAT_ID, CAT_NAME, start, end, ReservationStatus.CONFIRMED);

      const snapshots = await repo.getAllSnapshots();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.resourceId).toBe('r1');
      expect(snapshots[0]!.categoryName).toBe(CAT_NAME);
      expect(snapshots[0]!.bookedMinutes).toBe(120); // 2 horas
    });

    it('debe ignorar reservas pendientes', async () => {
      const start = new Date('2026-06-21T10:00:00');
      const end = new Date('2026-06-21T12:00:00');

      await repo.recordReservation('r1', 'Mesa A', CAT_ID, CAT_NAME, start, end, ReservationStatus.PENDING);

      const snapshots = await repo.getAllSnapshots();
      expect(snapshots).toHaveLength(0);
    });

    it('debe ignorar reservas canceladas', async () => {
      const start = new Date('2026-06-21T10:00:00');
      const end = new Date('2026-06-21T12:00:00');

      await repo.recordReservation('r1', 'Mesa A', CAT_ID, CAT_NAME, start, end, ReservationStatus.CANCELLED);

      const snapshots = await repo.getAllSnapshots();
      expect(snapshots).toHaveLength(0);
    });

    it('debe registrar una reserva que cruza múltiples días', async () => {
      const start = new Date('2026-06-21T20:00:00');
      const end = new Date('2026-06-22T10:00:00');

      await repo.recordReservation('r1', 'Cabaña A', 'cat-cabanas', 'Cabañas', start, end, ReservationStatus.CONFIRMED);

      const snapshots = await repo.getAllSnapshots();
      expect(snapshots).toHaveLength(2); // 2 días

      // Día 1: 21 jun - 4 horas (20:00 a 00:00)
      expect(snapshots[0]!.bookedMinutes).toBe(240);

      // Día 2: 22 jun - 10 horas (00:00 a 10:00)
      expect(snapshots[1]!.bookedMinutes).toBe(600);
    });
  });

  describe('getOccupancyByDateRange', () => {
    beforeEach(async () => {
      const start1 = new Date('2026-06-21T10:00:00');
      const end1 = new Date('2026-06-21T12:00:00');
      await repo.recordReservation('r1', 'Mesa A', CAT_ID, CAT_NAME, start1, end1, ReservationStatus.CONFIRMED);

      const start2 = new Date('2026-06-22T14:00:00');
      const end2 = new Date('2026-06-22T16:00:00');
      await repo.recordReservation('r2', 'Mesa B', CAT_ID, CAT_NAME, start2, end2, ReservationStatus.CONFIRMED);
    });

    it('debe retornar ocupación en rango de fechas', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-23');

      const result = await repo.getOccupancyByDateRange(startDate, endDate);

      expect(result).toHaveLength(2);
    });

    it('debe filtrar por resourceIds', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-23');

      const result = await repo.getOccupancyByDateRange(startDate, endDate, ['r1']);

      expect(result).toHaveLength(1);
      expect(result[0]!.resourceId).toBe('r1');
    });

    it('debe retornar vacío si no hay ocupación en rango', async () => {
      const startDate = new Date('2026-06-25');
      const endDate = new Date('2026-06-26');

      const result = await repo.getOccupancyByDateRange(startDate, endDate);

      expect(result).toHaveLength(0);
    });
  });

  describe('getAverageOccupancyByResource', () => {
    beforeEach(async () => {
      const start1 = new Date('2026-06-21T10:00:00');
      const end1 = new Date('2026-06-21T12:00:00');
      await repo.recordReservation('r1', 'Mesa A', CAT_ID, CAT_NAME, start1, end1, ReservationStatus.CONFIRMED);

      const start2 = new Date('2026-06-22T10:00:00');
      const end2 = new Date('2026-06-22T14:00:00');
      await repo.recordReservation('r1', 'Mesa A', CAT_ID, CAT_NAME, start2, end2, ReservationStatus.CONFIRMED);

      const start3 = new Date('2026-06-21T14:00:00');
      const end3 = new Date('2026-06-21T15:00:00');
      await repo.recordReservation('r2', 'Mesa B', CAT_ID, CAT_NAME, start3, end3, ReservationStatus.CONFIRMED);
    });

    it('debe calcular ocupación promedio por recurso', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-23');

      const result = await repo.getAverageOccupancyByResource(startDate, endDate);

      expect(result).toHaveLength(2);

      // r1: (120 + 240) / (1440 + 1440) = 360/2880 = 12.5%
      const r1 = result.find((r) => r.resourceId === 'r1');
      expect(r1?.occupancyRate).toBeCloseTo(12.5, 1);
      expect(r1?.categoryName).toBe(CAT_NAME);

      // r2: 60 / 1440 = 4.17%
      const r2 = result.find((r) => r.resourceId === 'r2');
      expect(r2?.occupancyRate).toBeCloseTo(4.17, 1);
    });

    it('debe ordenar descendente por ocupación', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-23');

      const result = await repo.getAverageOccupancyByResource(startDate, endDate);

      expect(result[0]!.resourceId).toBe('r1');
      expect(result[1]!.resourceId).toBe('r2');
    });
  });

  describe('getTopOccupiedResources', () => {
    beforeEach(async () => {
      await repo.recordReservation(
        'r1', 'Recurso Alto', CAT_ID, CAT_NAME,
        new Date('2026-06-21T08:00:00'),
        new Date('2026-06-21T20:00:00'),
        ReservationStatus.CONFIRMED,
      );

      await repo.recordReservation(
        'r2', 'Recurso Medio', CAT_ID, CAT_NAME,
        new Date('2026-06-21T10:00:00'),
        new Date('2026-06-21T14:00:00'),
        ReservationStatus.CONFIRMED,
      );

      await repo.recordReservation(
        'r3', 'Recurso Bajo', CAT_ID, CAT_NAME,
        new Date('2026-06-21T15:00:00'),
        new Date('2026-06-21T17:00:00'),
        ReservationStatus.CONFIRMED,
      );
    });

    it('debe retornar top N recursos por ocupación', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const result = await repo.getTopOccupiedResources(startDate, endDate, 2);

      expect(result).toHaveLength(2);
      expect(result[0]!.resourceId).toBe('r1');
      expect(result[1]!.resourceId).toBe('r2');
    });

    it('debe respetar límite por defecto (10)', async () => {
      const startDate = new Date('2026-06-21');
      const endDate = new Date('2026-06-22');

      const result = await repo.getTopOccupiedResources(startDate, endDate);

      expect(result.length).toBeLessThanOrEqual(10);
    });
  });

  describe('deleteOldRecords', () => {
    beforeEach(async () => {
      await repo.recordReservation(
        'r1', 'Mesa A', CAT_ID, CAT_NAME,
        new Date('2026-06-15T10:00:00'),
        new Date('2026-06-15T12:00:00'),
        ReservationStatus.CONFIRMED,
      );

      await repo.recordReservation(
        'r2', 'Mesa B', CAT_ID, CAT_NAME,
        new Date('2026-06-21T10:00:00'),
        new Date('2026-06-21T12:00:00'),
        ReservationStatus.CONFIRMED,
      );
    });

    it('debe eliminar registros anteriores a una fecha', async () => {
      const beforeDate = new Date('2026-06-20');

      const deleted = await repo.deleteOldRecords(beforeDate);

      expect(deleted).toBe(1);

      const remaining = await repo.getAllSnapshots();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.resourceId).toBe('r2');
    });

    it('debe retornar 0 si no hay registros para eliminar', async () => {
      const beforeDate = new Date('2026-06-10');

      const deleted = await repo.deleteOldRecords(beforeDate);

      expect(deleted).toBe(0);
    });
  });

  describe('getAllSnapshots', () => {
    it('debe retornar todos los snapshots', async () => {
      await repo.recordReservation(
        'r1', 'Mesa A', CAT_ID, CAT_NAME,
        new Date('2026-06-21T10:00:00'),
        new Date('2026-06-21T12:00:00'),
        ReservationStatus.CONFIRMED,
      );

      const snapshots = await repo.getAllSnapshots();

      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.resourceId).toBe('r1');
    });

    it('debe retornar copia (no referencia directa)', async () => {
      await repo.recordReservation(
        'r1', 'Mesa A', CAT_ID, CAT_NAME,
        new Date('2026-06-21T10:00:00'),
        new Date('2026-06-21T12:00:00'),
        ReservationStatus.CONFIRMED,
      );

      const snapshots1 = await repo.getAllSnapshots();
      const snapshots2 = await repo.getAllSnapshots();

      expect(snapshots1).not.toBe(snapshots2);
      expect(snapshots1).toEqual(snapshots2);
    });
  });
});
