import { ResourceType } from '../types/enums.js';
import { VisualMetadata } from '../types/visual.interface.js';
import {
  BookableResource,
  CabinResource,
  SpaResource,
  TableResource,
  TourSeatResource,
} from './entities.js';
import { InvalidResourceError } from './errors.js';

export interface ResourceData {
  id: string;
  name: string;
  type: ResourceType;
  basePrice: number;
  visualData?: VisualMetadata | null;
}

export function createBookableResource(data: ResourceData): BookableResource {
  const { id, name, type, basePrice, visualData } = data;

  switch (type) {
    case ResourceType.CABIN:
      return new CabinResource(id, name, basePrice);
    case ResourceType.RESTAURANT_TABLE:
      if (!visualData) {
        throw new InvalidResourceError(
          `El recurso ${id} (RESTAURANT_TABLE) requiere visualData`,
        );
      }
      return new TableResource(id, name, basePrice, visualData);
    case ResourceType.SPA:
      return new SpaResource(id, name, basePrice);
    case ResourceType.TOUR_SEAT:
      return new TourSeatResource(id, name, basePrice);
    default:
      throw new InvalidResourceError(`Tipo de recurso desconocido: ${type}`);
  }
}
