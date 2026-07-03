import { describe, it, expect } from 'vitest';
import { createBookableResource } from '../../domain/resource.factory.js';
import {
  CabinResource,
  SpaResource,
  TableResource,
  TourSeatResource,
} from '../../domain/entities.js';
import { ResourceType } from '../../types/enums.js';

const visualData = { x: 0, y: 0, width: 60, height: 60, rotation: 0 };

describe('createBookableResource', () => {
  it('crea CabinResource para CABIN', () => {
    const r = createBookableResource({ id: 'c1', name: 'Cabaña', type: ResourceType.CABIN, basePrice: 100 });
    expect(r).toBeInstanceOf(CabinResource);
  });

  it('crea TableResource para RESTAURANT_TABLE con visualData', () => {
    const r = createBookableResource({ id: 't1', name: 'Mesa 1', type: ResourceType.RESTAURANT_TABLE, basePrice: 50, visualData });
    expect(r).toBeInstanceOf(TableResource);
  });

  it('lanza InvalidResourceError para RESTAURANT_TABLE sin visualData', () => {
    expect(() =>
      createBookableResource({ id: 't1', name: 'Mesa 1', type: ResourceType.RESTAURANT_TABLE, basePrice: 50 }),
    ).toThrow('requiere visualData');
  });

  it('crea SpaResource para SPA', () => {
    const r = createBookableResource({ id: 's1', name: 'Spa', type: ResourceType.SPA, basePrice: 200 });
    expect(r).toBeInstanceOf(SpaResource);
  });

  it('crea TourSeatResource para TOUR_SEAT', () => {
    const r = createBookableResource({ id: 'ts1', name: 'Tour', type: ResourceType.TOUR_SEAT, basePrice: 80 });
    expect(r).toBeInstanceOf(TourSeatResource);
  });

  it('lanza InvalidResourceError para tipo desconocido', () => {
    expect(() =>
      createBookableResource({ id: 'x1', name: 'X', type: 'UNKNOWN' as ResourceType, basePrice: 0 }),
    ).toThrow('Tipo de recurso desconocido');
  });
});
