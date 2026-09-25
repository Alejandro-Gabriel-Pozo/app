/**
 * @file reservation.test.ts
 * @description Tests unitarios para la entidad `Reservation` — constructor/
 * `restore()` en aislamiento. No existía ningún test dedicado al
 * constructor de esta entidad antes de este archivo (verificado con
 * `grep -rlnE "new Reservation\(|Reservation\.restore\("` contra
 * `src/**\/*.test.ts` — solo usos de setup en otros archivos, ninguno
 * ejercitando las validaciones del constructor).
 *
 * Alcance de este archivo: Fase 1 de "reserva por tipo de unidad con
 * asignación diferida" (Wave 14 ítem 4.3,
 * docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6/§8, condición G-1
 * del gate `architecture-governor`, gate 18) — la validación de VALOR de
 * `assignmentStatus` contra `ASSIGNMENT_STATUS_TRANSITIONS`, distinta de
 * la validación de TRANSICIÓN que resuelve la operación de dominio de
 * Fase 2 (no existe todavía).
 */

import { describe, it, expect } from 'vitest';
import { Reservation, ASSIGNMENT_STATUS_TRANSITIONS } from '../../reservas/Reservation.js';
import type { AssignmentStatus } from '../../reservas/Reservation.js';
import { InvalidReservationError } from '../../domain/errors.js';
import { PhysicalResource } from '../../reservas/resource.entities.js';
import { Customer } from '../../clientes-finanzas/customer.entities.js';

const resource = new PhysicalResource('res-1', 'Habitación 101', 15000, 'cat-1', null, 2);
const customer = new Customer('cust-1', 'Ana García', 'ana@example.com');

const start = new Date('2026-10-01T10:00:00Z');
const end   = new Date('2026-10-01T12:00:00Z');

/** Props válidas mínimas — cada test override solo lo que le importa. */
function validProps(overrides: Partial<Parameters<typeof Reservation.restore>[0]> = {}) {
  return {
    id: 'res-1',
    customer,
    resource,
    startTime: start,
    endTime: end,
    details: {},
    totalPrice: 100,
    reservationNumber: 1,
    appliedCustomerRateId: null,
    assignmentStatus: 'ASSIGNED' as AssignmentStatus,
    ...overrides,
  };
}

describe('Reservation — ASSIGNMENT_STATUS_TRANSITIONS (A6.1)', () => {
  it('es una máquina de dos estados con una sola arista permitida', () => {
    expect(ASSIGNMENT_STATUS_TRANSITIONS).toEqual({
      PENDING_ASSIGNMENT: ['ASSIGNED'],
      ASSIGNED: [],
    });
  });

  it('ASSIGNED es terminal (A6.4 — los estados terminales no se reabren)', () => {
    expect(ASSIGNMENT_STATUS_TRANSITIONS.ASSIGNED).toEqual([]);
  });
});

describe('Reservation — constructor/restore(): assignmentStatus válido', () => {
  it('acepta ASSIGNED', () => {
    expect(() => new Reservation(validProps({ assignmentStatus: 'ASSIGNED' }))).not.toThrow();
  });

  it('acepta PENDING_ASSIGNMENT', () => {
    const r = new Reservation(validProps({ assignmentStatus: 'PENDING_ASSIGNMENT' }));
    expect(r.assignmentStatus).toBe('PENDING_ASSIGNMENT');
  });

  it('Reservation.restore() valida igual que el constructor (comparte la misma ruta)', () => {
    const r = Reservation.restore(validProps({ assignmentStatus: 'ASSIGNED' }));
    expect(r.assignmentStatus).toBe('ASSIGNED');
  });
});

describe('Reservation — constructor/restore(): assignmentStatus inválido (G-1, gate 18)', () => {
  it('lanza InvalidReservationError si assignmentStatus es undefined (columna faltante en un SELECT, o caller que se olvida del campo)', () => {
    expect(() =>
      new Reservation(
        validProps({ assignmentStatus: undefined as unknown as AssignmentStatus }),
      ),
    ).toThrow(InvalidReservationError);
  });

  it('lanza InvalidReservationError si assignmentStatus es un string arbitrario', () => {
    expect(() =>
      new Reservation(
        validProps({ assignmentStatus: 'FOO' as unknown as AssignmentStatus }),
      ),
    ).toThrow(InvalidReservationError);
  });

  it('lanza InvalidReservationError si assignmentStatus es null', () => {
    expect(() =>
      new Reservation(
        validProps({ assignmentStatus: null as unknown as AssignmentStatus }),
      ),
    ).toThrow(InvalidReservationError);
  });

  it('Reservation.restore() también rechaza un valor inválido (misma ruta que el constructor)', () => {
    expect(() =>
      Reservation.restore(
        validProps({ assignmentStatus: 'BOGUS' as unknown as AssignmentStatus }),
      ),
    ).toThrow(InvalidReservationError);
  });
});
