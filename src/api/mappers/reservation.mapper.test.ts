/**
 * @file reservation.mapper.test.ts
 * @description Regresión: reservations.routes.ts respondía con
 * `res.json(reservation)` (el objeto de dominio crudo) en vez de pasar por
 * este mapper. `Reservation.status` es un getter sobre el campo privado
 * `_status`, y `Customer.fullName`/`email` también son getters —
 * `JSON.stringify` de una clase NO serializa getters, solo propiedades
 * propias. El JSON que salía por HTTP tenía `_status` (nunca `status`) y el
 * `customer` sin `fullName`/`email`, aunque el frontend siempre esperó esas
 * claves. Este test verifica el DTO tal como sale después de un roundtrip
 * JSON real (igual que por HTTP), no solo el objeto en memoria.
 */

import { describe, it, expect } from 'vitest';
import { toReservationDto } from './reservation.mapper.js';
import { Reservation } from '../../domain/Reservation.js';
import { Customer, PhysicalResource } from '../../domain/entities.js';

describe('toReservationDto', () => {
  const resource = new PhysicalResource('silla-1', 'Silla 1', 20, 'cat-1', null, 2);
  const customer = new Customer('cust-1', 'Ana García', 'ana@example.com');

  const reservation = new Reservation({
    id: 'res-1',
    customer,
    resource,
    startTime: new Date('2026-07-01T10:00:00Z'),
    endTime: new Date('2026-07-01T10:30:00Z'),
    details: { nota: 'ventana' },
    serviceId: 'svc-1',
    partySize: 2,
    notes: 'Pidió silla junto a la ventana',
  });

  it('el status sobrevive un roundtrip JSON real (antes se perdía: _status vs status)', () => {
    const roundtripped = JSON.parse(JSON.stringify(toReservationDto(reservation)));
    expect(roundtripped.status).toBe('PENDING');
    expect(roundtripped._status).toBeUndefined();
  });

  it('resourceId viaja plano, no solo anidado dentro de resource', () => {
    const dto = toReservationDto(reservation);
    expect(dto.resourceId).toBe('silla-1');
  });

  it('customer.fullName y customer.email sobreviven el roundtrip (antes eran getters, se perdían)', () => {
    const roundtripped = JSON.parse(JSON.stringify(toReservationDto(reservation)));
    expect(roundtripped.customer.fullName).toBe('Ana García');
    expect(roundtripped.customer.email).toBe('ana@example.com');
    expect(roundtripped.customer.displayName).toBeUndefined();
    expect(roundtripped.customer.contactMethods).toBeUndefined();
  });

  it('incluye serviceId, partySize y notes', () => {
    const dto = toReservationDto(reservation);
    expect(dto.serviceId).toBe('svc-1');
    expect(dto.partySize).toBe(2);
    expect(dto.notes).toBe('Pidió silla junto a la ventana');
  });
});
