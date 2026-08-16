/**
 * @file stay.ts
 * @description Entidad de dominio: Stay (Estadía).
 *
 * Una Stay representa la ocupación real de una habitación por un huésped.
 * Es distinta de la Reservation:
 *
 *   Reservation → intención de reservar (puede cancelarse)
 *   Stay        → ocupación activa, comienza con el check-in y termina con el check-out
 *
 * ## Estados
 *
 *   CHECKED_IN → CHECKED_OUT
 *   CHECKED_IN → NO_SHOW (huésped no se presentó)
 *
 * ## Invariantes
 *
 * - Solo se puede hacer check-out desde CHECKED_IN.
 * - No se puede reabrir una Stay CHECKED_OUT o NO_SHOW.
 * - `actualCheckOut` solo existe en estado CHECKED_OUT.
 * - Una Stay siempre tiene una `reservationId` que la originó.
 */

import { randomUUID } from 'node:crypto';
import { DomainError } from '../domain/errors.js';

/** Ver nota equivalente en domain/housekeeping-task.ts — antes era Error plano. */
export class InvalidStayTransitionError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_TRANSITION');
  }
}

export type StayStatus = 'CHECKED_IN' | 'CHECKED_OUT' | 'NO_SHOW';

export interface StayProps {
  id: string;
  businessId: string;
  reservationId: string;
  resourceId: string;     // habitación asignada para la estadía actual
  customerId: string;
  assignedBy: string;     // userId del empleado que hizo el check-in
  status: StayStatus;
  /** Fecha/hora del check-in efectivo */
  checkedInAt: Date;
  /** Fecha/hora del check-out efectivo. Null hasta que se realice. */
  checkedOutAt: Date | null;
  /** Queda registrado si fue NO_SHOW */
  noShowAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export class Stay {
  private constructor(private readonly props: StayProps) {}

  // ---------------------------------------------------------------------------
  // Factory — check-in (crea una nueva estadía)
  // ---------------------------------------------------------------------------

  static checkIn(input: {
    businessId: string;
    reservationId: string;
    resourceId: string;
    customerId: string;
    assignedBy: string;
    notes?: string;
  }): Stay {
    const now = new Date();
    return new Stay({
      id: randomUUID(),
      businessId: input.businessId,
      reservationId: input.reservationId,
      resourceId: input.resourceId,
      customerId: input.customerId,
      assignedBy: input.assignedBy,
      status: 'CHECKED_IN',
      checkedInAt: now,
      checkedOutAt: null,
      noShowAt: null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  // ---------------------------------------------------------------------------
  // Factory — rehydratación desde persistencia
  // ---------------------------------------------------------------------------

  static restore(props: StayProps): Stay {
    return new Stay({ ...props });
  }

  // ---------------------------------------------------------------------------
  // Comandos de dominio
  // ---------------------------------------------------------------------------

  checkOut(notes?: string): void {
    if (this.props.status !== 'CHECKED_IN') {
      throw new InvalidStayTransitionError(
        `No se puede hacer check-out desde el estado ${this.props.status}.`,
      );
    }
    this.props.status = 'CHECKED_OUT';
    this.props.checkedOutAt = new Date();
    if (notes) this.props.notes = notes;
    this.props.updatedAt = new Date();
  }

  markNoShow(): void {
    if (this.props.status !== 'CHECKED_IN') {
      throw new InvalidStayTransitionError(
        `Solo se puede marcar NO_SHOW desde CHECKED_IN. Estado actual: ${this.props.status}.`,
      );
    }
    this.props.status = 'NO_SHOW';
    this.props.noShowAt = new Date();
    this.props.updatedAt = new Date();
  }

  updateNotes(notes: string): void {
    this.props.notes = notes;
    this.props.updatedAt = new Date();
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  get id(): string              { return this.props.id; }
  get businessId(): string      { return this.props.businessId; }
  get reservationId(): string   { return this.props.reservationId; }
  get resourceId(): string      { return this.props.resourceId; }
  get customerId(): string      { return this.props.customerId; }
  get assignedBy(): string      { return this.props.assignedBy; }
  get status(): StayStatus      { return this.props.status; }
  get checkedInAt(): Date       { return this.props.checkedInAt; }
  get checkedOutAt(): Date|null { return this.props.checkedOutAt; }
  get noShowAt(): Date|null     { return this.props.noShowAt; }
  get notes(): string|null      { return this.props.notes; }
  get createdAt(): Date         { return this.props.createdAt; }
  get updatedAt(): Date         { return this.props.updatedAt; }

  toJSON(): StayProps { return { ...this.props }; }
}
