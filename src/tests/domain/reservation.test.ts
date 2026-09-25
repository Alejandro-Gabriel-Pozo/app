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

// v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §8 A6.1) —
// assignConcreteResource(): único punto de escritura que aplica la
// transición PENDING_ASSIGNMENT → ASSIGNED dentro de la entidad.
describe('Reservation — assignConcreteResource() (A6.1)', () => {
  const newResource = new PhysicalResource('res-final', 'Habitación 102', 18000, 'cat-1', null, 3);

  it('transiciona PENDING_ASSIGNMENT -> ASSIGNED, con el recurso e isExclusiveResource nuevos', () => {
    const r = new Reservation(validProps({ assignmentStatus: 'PENDING_ASSIGNMENT', isExclusiveResource: false }));
    const updated = r.assignConcreteResource(newResource, true);

    expect(updated.assignmentStatus).toBe('ASSIGNED');
    expect(updated.resource).toBe(newResource);
    expect(updated.isExclusiveResource).toBe(true);
  });

  it('no muta la instancia original — devuelve una entidad NUEVA', () => {
    const r = new Reservation(validProps({ assignmentStatus: 'PENDING_ASSIGNMENT' }));
    const updated = r.assignConcreteResource(newResource, true);

    expect(r).not.toBe(updated);
    expect(r.assignmentStatus).toBe('PENDING_ASSIGNMENT');
    expect(r.resource).not.toBe(newResource);
  });

  it('lanza InvalidReservationError si ya está ASSIGNED (A6.4 — terminal, sin arista de salida)', () => {
    const r = new Reservation(validProps({ assignmentStatus: 'ASSIGNED' }));
    expect(() => r.assignConcreteResource(newResource, true)).toThrow(InvalidReservationError);
  });

  // Test obligatorio de preservación de propiedades (A6.1, parte del
  // diseño) — construye una reserva con TODOS los campos seteados a
  // valores no-default, la pasa por assignConcreteResource(), y verifica
  // que TODOS los campos EXCEPTO resource/isExclusiveResource/
  // assignmentStatus quedaron IGUALES. Previene que un toProps() roto en
  // el futuro reintroduzca en silencio la misma familia de bug ya
  // documentada 4 veces en reservation.service.ts (requestedCheckInTime/
  // isExclusiveResource/needsMaintenanceReview/cancellationPolicySnapshot).
  it('preserva TODOS los demás campos (test de preservación de propiedades, A6.1)', () => {
    const fullProps = validProps({
      assignmentStatus: 'PENDING_ASSIGNMENT',
      serviceId: 'svc-1',
      partySize: 2,
      notes: 'nota del huésped',
      orderItemId: 'oi-1',
      totalPrice: 500,
      lines: [{ id: 'l1', reservationId: 'res-1', unitDate: new Date('2026-10-01'), price: 500 }],
      adultos: 2,
      ninos: 1,
      ratePlanId: 'rp-1',
      requestedCheckInTime: '15:00:00',
      requestedCheckOutTime: '11:00:00',
      scheduleApprovalStatus: 'APPROVED' as const,
      scheduleApprovedBy: 'staff-1',
      scheduleChargeAmount: 1000,
      depositAmount: 50,
      depositDueBy: new Date('2026-09-30T00:00:00Z'),
      reservationNumber: 42,
      appliedCustomerRateId: 'rate-1',
      needsMaintenanceReview: true,
      isExclusiveResource: false,
      cancellationPolicySnapshot: { version: 1, frozenAt: new Date('2026-09-01T00:00:00Z').toISOString(), tiers: [] },
    });
    const original = Reservation.restore(fullProps);

    const updated = original.assignConcreteResource(newResource, true);

    // Campos que SÍ cambian.
    expect(updated.resource).toBe(newResource);
    expect(updated.isExclusiveResource).toBe(true);
    expect(updated.assignmentStatus).toBe('ASSIGNED');

    // TODOS los demás campos preservados.
    expect(updated.id).toBe(original.id);
    expect(updated.customer).toEqual(original.customer);
    expect(updated.startTime).toEqual(original.startTime);
    expect(updated.endTime).toEqual(original.endTime);
    expect(updated.details).toEqual(original.details);
    expect(updated.status).toBe(original.status);
    expect(updated.serviceId).toBe(original.serviceId);
    expect(updated.partySize).toBe(original.partySize);
    expect(updated.notes).toBe(original.notes);
    expect(updated.orderItemId).toBe(original.orderItemId);
    expect(updated.totalPrice).toBe(original.totalPrice);
    expect(updated.lines).toEqual(original.lines);
    expect(updated.adultos).toBe(original.adultos);
    expect(updated.ninos).toBe(original.ninos);
    expect(updated.ratePlanId).toBe(original.ratePlanId);
    expect(updated.requestedCheckInTime).toBe(original.requestedCheckInTime);
    expect(updated.requestedCheckOutTime).toBe(original.requestedCheckOutTime);
    expect(updated.scheduleApprovalStatus).toBe(original.scheduleApprovalStatus);
    expect(updated.scheduleApprovedBy).toBe(original.scheduleApprovedBy);
    expect(updated.scheduleChargeAmount).toBe(original.scheduleChargeAmount);
    expect(updated.depositAmount).toBe(original.depositAmount);
    expect(updated.depositDueBy).toEqual(original.depositDueBy);
    expect(updated.reservationNumber).toBe(original.reservationNumber);
    expect(updated.appliedCustomerRateId).toBe(original.appliedCustomerRateId);
    expect(updated.needsMaintenanceReview).toBe(original.needsMaintenanceReview);
    expect(updated.cancellationPolicySnapshot).toEqual(original.cancellationPolicySnapshot);
  });
});
