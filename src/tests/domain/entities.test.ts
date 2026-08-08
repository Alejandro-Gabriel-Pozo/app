import { describe, it, expect } from 'vitest';
import { BookableResource } from '../../domain/entities.js';
import { ReservationStatus } from '../../types/enums.js';
import type { ReservationSnapshot } from '../../domain/reservation.types.js';

const NO_RESERVATIONS: ReservationSnapshot[] = [];
const start = new Date('2025-01-10T10:00:00Z');
const end   = new Date('2025-01-10T12:00:00Z');

const makeResource = (
  id = 'r1',
  categoryId = 'cat-cabin',
  basePrice  = 100,
  visualData: Record<string, unknown> | null = null,
) => new BookableResource(id, 'Recurso Test', basePrice, categoryId, visualData);

const makeSnapshot = (
  overrides: Partial<ReservationSnapshot> = {},
): ReservationSnapshot => ({
  id: 'res-1',
  resourceId: 'r1',
  status: ReservationStatus.PENDING,
  startTime: start,
  endTime:   end,
  ...overrides,
});

// ---------------------------------------------------------------------------
describe('BookableResource — construcción', () => {
  it('crea instancia con categoryId correcto', () => {
    const r = makeResource('r1', 'cat-spa');
    expect(r.categoryId).toBe('cat-spa');
    expect(r.basePrice).toBe(100);
  });

  it('visualData es null por defecto', () => {
    const r = makeResource();
    expect(r.visualData).toBeNull();
  });

  it('acepta visualData cuando se provee', () => {
    const vd = { x: 10, y: 20, width: 50, height: 50, rotation: 0 };
    const r = makeResource('r1', 'cat-table', 50, vd);
    expect(r.visualData).toEqual(vd);
  });

  it('lanza si basePrice es negativo', () => {
    expect(() => new BookableResource('r1', 'X', -1, 'cat-x')).toThrow(
      'basePrice no puede ser negativo',
    );
  });

  it('lanza si categoryId está vacío', () => {
    expect(() => new BookableResource('r1', 'X', 0, '   ')).toThrow(
      'categoryId es obligatorio',
    );
  });
});

// ---------------------------------------------------------------------------
describe('BookableResource — isAvailable', () => {
  it('devuelve true cuando no hay reservas', () => {
    const r = makeResource();
    expect(r.isAvailable(start, end, NO_RESERVATIONS)).toBe(true);
  });

  it('devuelve false cuando hay reserva PENDING que solapa', () => {
    const r = makeResource();
    expect(r.isAvailable(start, end, [makeSnapshot()])).toBe(false);
  });

  it('devuelve true cuando la reserva solapante está CANCELLED', () => {
    const r = makeResource();
    const snap = makeSnapshot({ status: ReservationStatus.CANCELLED });
    expect(r.isAvailable(start, end, [snap])).toBe(true);
  });

  it('devuelve true cuando la reserva solapante es de otro recurso', () => {
    const r = makeResource();
    const snap = makeSnapshot({ resourceId: 'otro-r' });
    expect(r.isAvailable(start, end, [snap])).toBe(true);
  });

  it('excluye reserva propia al actualizar (excludeReservationId)', () => {
    const r = makeResource();
    const snap = makeSnapshot({ id: 'res-edit' });
    expect(r.isAvailable(start, end, [snap], 'res-edit')).toBe(true);
  });

  it('devuelve true para slot contiguo inmediatamente después', () => {
    const r = makeResource();
    const snap = makeSnapshot(); // 10:00-12:00
    const start2 = new Date('2025-01-10T12:00:00Z');
    const end2   = new Date('2025-01-10T14:00:00Z');
    expect(r.isAvailable(start2, end2, [snap])).toBe(true);
  });
});
