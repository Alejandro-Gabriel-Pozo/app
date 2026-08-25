import { describe, it, expect } from 'vitest';
import { PhysicalResource } from '../../reservas/resource.entities.js';
import { ReservationStatus } from '../../types/enums.js';
import type { ReservationSnapshot } from '../../reservas/reservation.types.js';
import type { VisualMetadata } from '../../types/visual.interface.js';

const NO_RESERVATIONS: ReservationSnapshot[] = [];
const start = new Date('2025-01-10T10:00:00Z');
const end   = new Date('2025-01-10T12:00:00Z');

const makeResource = (
  id = 'r1',
  categoryId = 'cat-cabin',
  basePrice  = 100,
  visualData: VisualMetadata | null = null,
) => new PhysicalResource(id, 'Recurso Test', basePrice, categoryId, visualData);

const makeSnapshot = (
  overrides: Partial<ReservationSnapshot> = {},
): ReservationSnapshot => ({
  id: 'res-1',
  resourceId: 'r1',
  status: ReservationStatus.PENDING,
  startTime: start,
  endTime:   end,
  serviceId: null,
  partySize: 1,
  orderItemId: null,
  ...overrides,
});

// ---------------------------------------------------------------------------
describe('PhysicalResource — construcción', () => {
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
    const vd: VisualMetadata = { shape: 'SQUARE', width: 50, height: 50, positionX: 10, positionY: 20, rotationDegrees: 0 };
    const r = makeResource('r1', 'cat-table', 50, vd);
    expect(r.visualData).toEqual(vd);
  });

  it('lanza si basePrice es negativo', () => {
    expect(() => new PhysicalResource('r1', 'X', -1, 'cat-x')).toThrow(
      'basePrice no puede ser negativo',
    );
  });

  it('lanza si categoryId está vacío', () => {
    expect(() => new PhysicalResource('r1', 'X', 0, '   ')).toThrow(
      'categoryId es obligatorio',
    );
  });
});

// ---------------------------------------------------------------------------
describe('PhysicalResource — isAvailable', () => {
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

// ---------------------------------------------------------------------------
// Bug 1 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md sección 5.2)
describe('PhysicalResource — availableSlots (cupo compartido)', () => {
  const makeShared = (capacity: number) =>
    new PhysicalResource('r1', 'Tour', 100, 'cat-tour', null, capacity);

  it('capacity completo libre sin reservas', () => {
    const r = makeShared(3);
    expect(r.availableSlots(start, end, NO_RESERVATIONS)).toBe(3);
  });

  it('resta partySize de reservas PENDING/CONFIRMED solapadas', () => {
    const r = makeShared(3);
    const reservations = [
      makeSnapshot({ id: 'a', partySize: 1, status: ReservationStatus.PENDING }),
      makeSnapshot({ id: 'b', partySize: 1, status: ReservationStatus.CONFIRMED }),
    ];
    expect(r.availableSlots(start, end, reservations)).toBe(1);
  });

  it('CANCELLED no ocupa lugar', () => {
    const r = makeShared(3);
    const reservations = [makeSnapshot({ partySize: 2, status: ReservationStatus.CANCELLED })];
    expect(r.availableSlots(start, end, reservations)).toBe(3);
  });

  it('COMPLETED tampoco ocupa lugar — bug real corregido esta sesión (antes solo excluía CANCELLED)', () => {
    const r = makeShared(3);
    const reservations = [makeSnapshot({ partySize: 2, status: ReservationStatus.COMPLETED })];
    expect(r.availableSlots(start, end, reservations)).toBe(3);
  });

  it('EXPIRED tampoco ocupa lugar (mismo isBlockingStatus que el resto del código)', () => {
    const r = makeShared(3);
    const reservations = [makeSnapshot({ partySize: 2, status: ReservationStatus.EXPIRED })];
    expect(r.availableSlots(start, end, reservations)).toBe(3);
  });

  it('nunca devuelve negativo aunque la ocupación supere capacity', () => {
    const r = makeShared(2);
    const reservations = [makeSnapshot({ partySize: 5, status: ReservationStatus.CONFIRMED })];
    expect(r.availableSlots(start, end, reservations)).toBe(0);
  });
});
