/**
 * @file availability.test.ts
 * @description Tests unitarios para la lógica de disponibilidad.
 */

import { describe, it, expect } from 'vitest';
import {
  hasTimeOverlap,
  isBlockingStatus,
  isResourceAvailable,
  assertValidTimeRange,
} from '../../domain/availability.js';
import { ReservationStatus } from '../../types/enums.js';
import { InvalidReservationError } from '../../domain/errors.js';
import type { ReservationSnapshot } from '../../domain/reservation.types.js';

// Helpers
const d = (iso: string) => new Date(iso);

const makeSnapshot = (
  overrides: Partial<ReservationSnapshot> = {},
): ReservationSnapshot => ({
  id: 'res-1',
  resourceId: 'resource-1',
  status: ReservationStatus.PENDING,
  startTime: d('2025-01-10T10:00:00Z'),
  endTime: d('2025-01-10T12:00:00Z'),
  ...overrides,
});

// ---------------------------------------------------------------------------
describe('hasTimeOverlap', () => {
  it('detecta solapamiento total', () => {
    expect(
      hasTimeOverlap(
        d('2025-01-10T09:00:00Z'), d('2025-01-10T13:00:00Z'),
        d('2025-01-10T10:00:00Z'), d('2025-01-10T12:00:00Z'),
      ),
    ).toBe(true);
  });

  it('detecta solapamiento parcial — inicio antes', () => {
    expect(
      hasTimeOverlap(
        d('2025-01-10T09:00:00Z'), d('2025-01-10T11:00:00Z'),
        d('2025-01-10T10:00:00Z'), d('2025-01-10T12:00:00Z'),
      ),
    ).toBe(true);
  });

  it('detecta solapamiento parcial — inicio después', () => {
    expect(
      hasTimeOverlap(
        d('2025-01-10T11:00:00Z'), d('2025-01-10T13:00:00Z'),
        d('2025-01-10T10:00:00Z'), d('2025-01-10T12:00:00Z'),
      ),
    ).toBe(true);
  });

  it('no hay solapamiento — bloque antes', () => {
    expect(
      hasTimeOverlap(
        d('2025-01-10T07:00:00Z'), d('2025-01-10T09:00:00Z'),
        d('2025-01-10T10:00:00Z'), d('2025-01-10T12:00:00Z'),
      ),
    ).toBe(false);
  });

  it('no hay solapamiento — bloque después', () => {
    expect(
      hasTimeOverlap(
        d('2025-01-10T13:00:00Z'), d('2025-01-10T15:00:00Z'),
        d('2025-01-10T10:00:00Z'), d('2025-01-10T12:00:00Z'),
      ),
    ).toBe(false);
  });

  it('rangos que se tocan exactamente en el límite NO solapan', () => {
    // [10:00-12:00] y [12:00-14:00] — end === start: sin solapamiento
    expect(
      hasTimeOverlap(
        d('2025-01-10T10:00:00Z'), d('2025-01-10T12:00:00Z'),
        d('2025-01-10T12:00:00Z'), d('2025-01-10T14:00:00Z'),
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('isBlockingStatus', () => {
  it('PENDING bloquea', () => expect(isBlockingStatus(ReservationStatus.PENDING)).toBe(true));
  it('CONFIRMED bloquea', () => expect(isBlockingStatus(ReservationStatus.CONFIRMED)).toBe(true));
  it('CANCELLED no bloquea', () => expect(isBlockingStatus(ReservationStatus.CANCELLED)).toBe(false));
  it('COMPLETED no bloquea', () => expect(isBlockingStatus(ReservationStatus.COMPLETED)).toBe(false));
});

// ---------------------------------------------------------------------------
describe('assertValidTimeRange', () => {
  it('no lanza para rango válido', () => {
    expect(() =>
      assertValidTimeRange(d('2025-01-10T10:00:00Z'), d('2025-01-10T12:00:00Z')),
    ).not.toThrow();
  });

  it('lanza si start === end', () => {
    const t = d('2025-01-10T10:00:00Z');
    expect(() => assertValidTimeRange(t, t)).toThrow(InvalidReservationError);
  });

  it('lanza si start > end', () => {
    expect(() =>
      assertValidTimeRange(d('2025-01-10T12:00:00Z'), d('2025-01-10T10:00:00Z')),
    ).toThrow(InvalidReservationError);
  });
});

// ---------------------------------------------------------------------------
describe('isResourceAvailable', () => {
  const resourceId = 'resource-1';

  it('disponible cuando no hay reservas', () => {
    expect(
      isResourceAvailable(
        resourceId,
        d('2025-01-10T10:00:00Z'),
        d('2025-01-10T12:00:00Z'),
        [],
      ),
    ).toBe(true);
  });

  it('no disponible cuando hay reserva PENDING que solapa', () => {
    const reservations = [makeSnapshot()];
    expect(
      isResourceAvailable(
        resourceId,
        d('2025-01-10T10:00:00Z'),
        d('2025-01-10T12:00:00Z'),
        reservations,
      ),
    ).toBe(false);
  });

  it('disponible cuando la reserva solapante está CANCELLED', () => {
    const reservations = [makeSnapshot({ status: ReservationStatus.CANCELLED })];
    expect(
      isResourceAvailable(
        resourceId,
        d('2025-01-10T10:00:00Z'),
        d('2025-01-10T12:00:00Z'),
        reservations,
      ),
    ).toBe(true);
  });

  it('disponible cuando la reserva solapante es de otro recurso', () => {
    const reservations = [makeSnapshot({ resourceId: 'otro-resource' })];
    expect(
      isResourceAvailable(
        resourceId,
        d('2025-01-10T10:00:00Z'),
        d('2025-01-10T12:00:00Z'),
        reservations,
      ),
    ).toBe(true);
  });

  it('disponible cuando se excluye la propia reserva (para edición)', () => {
    const reservations = [makeSnapshot({ id: 'res-edit' })];
    expect(
      isResourceAvailable(
        resourceId,
        d('2025-01-10T10:00:00Z'),
        d('2025-01-10T12:00:00Z'),
        reservations,
        'res-edit',
      ),
    ).toBe(true);
  });

  it('disponible en slot contiguo inmediatamente después', () => {
    const reservations = [makeSnapshot()] ; // 10:00-12:00
    expect(
      isResourceAvailable(
        resourceId,
        d('2025-01-10T12:00:00Z'),
        d('2025-01-10T14:00:00Z'),
        reservations,
      ),
    ).toBe(true);
  });
});
