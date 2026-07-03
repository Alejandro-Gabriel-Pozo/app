/**
 * @file entities.ts
 * @description Entidades de dominio.
 *
 * ## Cambios respecto a la versión anterior
 * - Se elimina la jerarquía `BookableResource` (abstract) +
 *   `CabinResource` / `TableResource` / `SpaResource` / `TourSeatResource`.
 *   El tipo de recurso ya no es un enum estático — cada negocio define sus
 *   propias categorías en BD (`resource_categories`).
 * - `BookableResource` pasa a ser una clase concreta con `categoryId: string`
 *   en lugar de `type: ResourceType`.
 * - `visualData` se mueve a campo opcional sobre `BookableResource`
 *   (antes solo existía en `TableResource`).
 * - `Customer` no cambia.
 */

import { VisualMetadata } from '../types/visual.interface.js';
import { InvalidCustomerError } from './errors.js';
import { isResourceAvailable } from './availability.js';
import { ReservationSnapshot } from './reservation.types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// BookableResource
// ---------------------------------------------------------------------------

export class BookableResource {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly basePrice: number,
    /** FK a `resource_categories.id` — reemplaza el antiguo `type: ResourceType` */
    public readonly categoryId: string,
    /** Metadatos visuales opcionales (ej: posición de mesa en plano) */
    public readonly visualData: VisualMetadata | null = null,
  ) {
    if (basePrice < 0) {
      throw new Error('basePrice no puede ser negativo');
    }
    if (!categoryId.trim()) {
      throw new Error('categoryId es obligatorio');
    }
  }

  /**
   * Verifica si el recurso está disponible en el rango dado.
   *
   * @param start                - Inicio del rango
   * @param end                  - Fin del rango
   * @param reservations         - Reservas activas contra las que chequear solapamiento
   * @param excludeReservationId - ID a ignorar (para updates)
   */
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
