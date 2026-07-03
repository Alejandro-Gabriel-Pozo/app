import { describe, it, expect } from 'vitest';
import {
  CabinResource,
  SpaResource,
  TableResource,
  TourSeatResource,
} from '../../domain/entities.js';
import { ResourceType } from '../../types/enums.js';

const NO_RESERVATIONS: never[] = [];
const start = new Date('2025-01-10T10:00:00Z');
const end = new Date('2025-01-10T12:00:00Z');

// ---------------------------------------------------------------------------
describe('CabinResource', () => {
  it('crea instancia con tipo CABIN', () => {
    const r = new CabinResource('c1', 'Cabaña Norte', 100);
    expect(r.type).toBe(ResourceType.CABIN);
    expect(r.basePrice).toBe(100);
  });

  it('isAvailable devuelve true cuando no hay reservas', () => {
    const r = new CabinResource('c1', 'Cabaña Norte', 100);
    expect(r.isAvailable(start, end, NO_RESERVATIONS)).toBe(true);
  });

  it('lanza si basePrice es negativo', () => {
    expect(() => new CabinResource('c1', 'X', -1)).toThrow('basePrice no puede ser negativo');
  });
});

// ---------------------------------------------------------------------------
describe('SpaResource', () => {
  it('crea instancia con tipo SPA', () => {
    const r = new SpaResource('s1', 'Spa Relax', 200);
    expect(r.type).toBe(ResourceType.SPA);
  });

  it('isAvailable devuelve true cuando no hay reservas', () => {
    const r = new SpaResource('s1', 'Spa Relax', 200);
    expect(r.isAvailable(start, end, NO_RESERVATIONS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('TourSeatResource', () => {
  it('crea instancia con tipo TOUR_SEAT', () => {
    const r = new TourSeatResource('t1', 'Tour Patagonia', 150);
    expect(r.type).toBe(ResourceType.TOUR_SEAT);
  });

  it('isAvailable devuelve true cuando no hay reservas', () => {
    const r = new TourSeatResource('t1', 'Tour Patagonia', 150);
    expect(r.isAvailable(start, end, NO_RESERVATIONS)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('TableResource', () => {
  const visualData = { x: 10, y: 20, width: 50, height: 50, rotation: 0 };

  it('crea instancia con tipo RESTAURANT_TABLE', () => {
    const r = new TableResource('tb1', 'Mesa 1', 50, visualData);
    expect(r.type).toBe(ResourceType.RESTAURANT_TABLE);
    expect(r.visualData).toEqual(visualData);
  });

  it('isAvailable devuelve true cuando no hay reservas', () => {
    const r = new TableResource('tb1', 'Mesa 1', 50, visualData);
    expect(r.isAvailable(start, end, NO_RESERVATIONS)).toBe(true);
  });
});
