/**
 * @file entities.ts
 * @description Entidades de dominio.
 *
 * ## Cambios v2 — Customer como agregado
 * - ContactMethod interface: canal de contacto tipado (EMAIL, PHONE, WHATSAPP)
 * - Constructor sobrecargado: acepta string (legacy) o ContactMethod[]
 * - Getters email/fullName para compatibilidad con código existente
 * - BookableResource sin cambios
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

  /**
   * @param id              - UUID del cliente
   * @param displayName     - Nombre para mostrar (era fullName)
   * @param emailOrContacts - string legacy (email) o ContactMethod[]
   *
   * Compatibilidad hacia atrás:
   *   new Customer(id, name, 'user@mail.com')  ← sigue funcionando
   *   new Customer(id, name, [{ channel: 'EMAIL', ... }])  ← nuevo
   */
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

  /** Email primario — compatibilidad con todo el código existente */
  get email(): string {
    return (
      this.contactMethods.find((c) => c.channel === 'EMAIL' && c.isPrimary)?.value ??
      this.contactMethods.find((c) => c.channel === 'EMAIL')?.value ??
      ''
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
