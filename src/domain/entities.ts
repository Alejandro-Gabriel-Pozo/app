import { ResourceType } from '../types/enums.js';
import { VisualMetadata } from '../types/visual.interface.js';
import { InvalidCustomerError } from './errors.js';
import { isResourceAvailable } from './availability.js';
import { ReservationSnapshot } from './reservation.types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class Customer {
  constructor(
    public readonly id: string,
    public readonly fullName: string,
    public readonly email: string,
  ) {
    if (!id.trim()) {
      throw new InvalidCustomerError('id es obligatorio');
    }
    if (!fullName.trim()) {
      throw new InvalidCustomerError('fullName es obligatorio');
    }
    if (!EMAIL_PATTERN.test(email)) {
      throw new InvalidCustomerError('email inválido');
    }
  }
}

export abstract class BookableResource {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly basePrice: number,
    public readonly type: ResourceType,
  ) {
    if (basePrice < 0) {
      throw new Error('basePrice no puede ser negativo');
    }
  }

  abstract isAvailable(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
    excludeReservationId?: string,
  ): boolean;
}

export class CabinResource extends BookableResource {
  constructor(id: string, name: string, price: number) {
    super(id, name, price, ResourceType.CABIN);
  }

  isAvailable(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
    excludeReservationId?: string,
  ): boolean {
    return isResourceAvailable(
      this.id, start, end, reservations, excludeReservationId,
    );
  }
}

export class TableResource extends BookableResource {
  constructor(
    id: string,
    name: string,
    price: number,
    public readonly visualData: VisualMetadata,
  ) {
    super(id, name, price, ResourceType.RESTAURANT_TABLE);
  }

  isAvailable(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
    excludeReservationId?: string,
  ): boolean {
    return isResourceAvailable(
      this.id, start, end, reservations, excludeReservationId,
    );
  }
}

export class SpaResource extends BookableResource {
  constructor(id: string, name: string, price: number) {
    super(id, name, price, ResourceType.SPA);
  }

  isAvailable(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
    excludeReservationId?: string,
  ): boolean {
    return isResourceAvailable(
      this.id, start, end, reservations, excludeReservationId,
    );
  }
}

export class TourSeatResource extends BookableResource {
  constructor(id: string, name: string, price: number) {
    super(id, name, price, ResourceType.TOUR_SEAT);
  }

  isAvailable(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
    excludeReservationId?: string,
  ): boolean {
    return isResourceAvailable(
      this.id, start, end, reservations, excludeReservationId,
    );
  }
}