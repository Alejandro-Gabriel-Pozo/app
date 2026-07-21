/**
 * @file entities.ts
 * @description Entidades de dominio — bounded context de Reservas.
 *
 * ## Cambios v2 — Customer como agregado
 * - ContactMethod interface: canal de contacto tipado (EMAIL, PHONE, WHATSAPP)
 * - Constructor sobrecargado: acepta string (legacy) o ContactMethod[]
 * - Getters email/fullName para compatibilidad con código existente
 *
 * ## Cambios v3
 * - `email` getter retorna `string | undefined` en lugar de ''.
 *
 * ## Cambios v5 — Limpieza de bounded contexts
 * - Product, Order, OrderItem y OrderStatus removidos de este archivo.
 *   Product vive en `product.entities.ts`.
 *   Order vive en `order.entities.ts`.
 */

import { VisualMetadata } from '../types/visual.interface.js';
import { InvalidCustomerError } from './errors.js';
import { isResourceAvailable } from './availability.js';
import { ReservationSnapshot } from './reservation.types.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export interface ContactMethod {
  id: string;
  channel: 'EMAIL' | 'PHONE' | 'WHATSAPP';
  value: string;
  isPrimary: boolean;
  verifiedAt?: Date;
}

export class Customer {
  public readonly displayName: string;
  public readonly contactMethods: ContactMethod[];

  constructor(
    public readonly id: string,
    displayName: string,
    emailOrContacts: string | ContactMethod[] = [],
  ) {
    if (!id.trim()) throw new InvalidCustomerError('id es obligatorio');
    if (!displayName.trim()) throw new InvalidCustomerError('fullName es obligatorio');

    this.displayName = displayName;

    if (typeof emailOrContacts === 'string') {
      if (!EMAIL_PATTERN.test(emailOrContacts)) {
        throw new InvalidCustomerError('email inválido');
      }
      this.contactMethods = [
        { id: `ccm-${id}`, channel: 'EMAIL', value: emailOrContacts, isPrimary: true },
      ];
    } else {
      for (const cm of emailOrContacts) {
        if (cm.channel === 'EMAIL' && !EMAIL_PATTERN.test(cm.value)) {
          throw new InvalidCustomerError('email inválido');
        }
      }
      this.contactMethods = emailOrContacts;
    }
  }

  get email(): string | undefined {
    return (
      this.contactMethods.find((c) => c.channel === 'EMAIL' && c.isPrimary)?.value ??
      this.contactMethods.find((c) => c.channel === 'EMAIL')?.value
    );
  }

  /** Alias de displayName — compatibilidad con tests y servicios */
  get fullName(): string {
    return this.displayName;
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
    /** FK a `resource_categories.id` */
    public readonly categoryId: string,
    /** Metadatos visuales opcionales (posición en plano) */
    public readonly visualData: VisualMetadata | null = null,
    /**
     * Máximo de reservas/personas simultáneas.
     * 1 = uso exclusivo (barbería, spa, hotel).
     * N > 1 = uso compartido (clases grupales, tours).
     */
    public readonly capacity: number = 1,
    /** Descripción opcional visible al cliente */
    public readonly description: string | null = null,
  ) {
    if (basePrice < 0) throw new Error('basePrice no puede ser negativo');
    if (!categoryId.trim()) throw new Error('categoryId es obligatorio');
    if (capacity < 1) throw new Error('capacity debe ser al menos 1');
  }

  isAvailable(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
    excludeReservationId?: string,
  ): boolean {
    return isResourceAvailable(this.id, start, end, reservations, excludeReservationId);
  }

  /**
   * Para recursos con capacity > 1 (clases, tours).
   * Retorna cuántos lugares quedan en el rango dado.
   */
  availableSlots(
    start: Date,
    end: Date,
    reservations: ReservationSnapshot[],
  ): number {
    const overlapping = reservations.filter(
      (r) =>
        r.resourceId === this.id &&
        r.status !== 'CANCELLED' &&
        r.startTime < end &&
        r.endTime > start,
    );
    const occupied = overlapping.reduce((sum, r) => sum + (r.partySize ?? 1), 0);
    return Math.max(0, this.capacity - occupied);
  }
}

// ---------------------------------------------------------------------------
// BookableService
// ---------------------------------------------------------------------------

/** Modo de reserva que define la semántica de tiempo del servicio. */
export type BookingMode = 'slot' | 'block' | 'event';

/**
 * Servicio ofrecido sobre un recurso (corte, masaje, tour, noche de hotel, etc.).
 * Pertenece a una `resource_category` y puede estar restringido a ciertos resources
 * mediante la tabla `resource_services`.
 */
export interface BookableService {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  /**
   * Duración en minutos.
   * - `slot`: obligatorio (define el bloqueo en el calendario).
   * - `block`: ignorado — la duración se calcula por fechas completas.
   * - `event`: ignorado — el horario lo fija `ServiceSchedule`.
   */
  durationMinutes: number | null;
  price: number;
  active: boolean;
}

/**
 * Turno fijo de un servicio con `bookingMode = 'event'`.
 * Mapea a la tabla `service_schedules`.
 */
export interface ServiceSchedule {
  id: string;
  serviceId: string;
  /** 0 = Domingo … 6 = Sábado */
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  startTime: string; // 'HH:MM:SS'
  maxCapacity: number;
  active: boolean;
}
