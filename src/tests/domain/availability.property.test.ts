/**
 * @file availability.property.test.ts
 * @description Property-based testing (2.4, docs/auditoria-tecnica-infra-reservas.md
 * — 25/08/2026) para `availability.ts`. `availability.test.ts` ya cubre estos
 * mismos casos con ejemplos elegidos a mano; acá se generan cientos de rangos
 * de fecha y listas de reservas al azar en cada corrida para verificar
 * invariantes que tienen que valer SIEMPRE, no solo para los ejemplos que se
 * nos ocurrieron. `fast-check` reporta el caso mínimo que rompe la propiedad
 * si alguna falla (shrinking) — más útil que adivinar el próximo edge case a
 * mano.
 *
 * Generador de rangos: offset + duración en minutos enteros desde un epoch
 * fijo, nunca Dates al azar directo — así start < end queda garantizado por
 * construcción (duración siempre >= 1) y la aritmética de solapamiento da
 * resultados exactos, sin florituras de huso horario de por medio.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  hasTimeOverlap,
  isResourceAvailable,
  assertValidTimeRange,
} from '../../reservas/availability.js';
import { ReservationStatus } from '../../types/enums.js';
import { InvalidReservationError } from '../../domain/errors.js';
import type { ReservationSnapshot } from '../../reservas/reservation.types.js';

const EPOCH = Date.parse('2026-01-01T00:00:00Z');
const toDate = (offsetMinutes: number): Date => new Date(EPOCH + offsetMinutes * 60_000);

/** Un rango válido [start, end) como offset+duración -- start < end por construcción. */
const rangeArb = fc
  .record({
    offsetMinutes:   fc.integer({ min: 0, max: 100_000 }),
    durationMinutes: fc.integer({ min: 1, max: 2_000 }),
  })
  .map(({ offsetMinutes, durationMinutes }) => ({
    start: toDate(offsetMinutes),
    end:   toDate(offsetMinutes + durationMinutes),
  }));

const BLOCKING_STATUSES = [ReservationStatus.PENDING, ReservationStatus.CONFIRMED] as const;
const NON_BLOCKING_STATUSES = [ReservationStatus.CANCELLED, ReservationStatus.COMPLETED, ReservationStatus.EXPIRED] as const;

const snapshotArb = (resourceId: string): fc.Arbitrary<ReservationSnapshot> =>
  fc.record({
    id:     fc.uuid(),
    range:  rangeArb,
    status: fc.constantFrom(...BLOCKING_STATUSES, ...NON_BLOCKING_STATUSES),
  }).map(({ id, range, status }) => ({
    id,
    resourceId,
    status,
    startTime:   range.start,
    endTime:     range.end,
    serviceId:   null,
    partySize:   1,
    orderItemId: null,
  }));

describe('hasTimeOverlap — propiedades', () => {
  it('es simétrico: overlap(a,b) === overlap(b,a)', () => {
    fc.assert(
      fc.property(rangeArb, rangeArb, (a, b) => {
        expect(hasTimeOverlap(a.start, a.end, b.start, b.end))
          .toBe(hasTimeOverlap(b.start, b.end, a.start, a.end));
      }),
    );
  });

  it('todo rango se solapa consigo mismo', () => {
    fc.assert(
      fc.property(rangeArb, (r) => {
        expect(hasTimeOverlap(r.start, r.end, r.start, r.end)).toBe(true);
      }),
    );
  });

  it('dos rangos consecutivos (fin de A = inicio de B) nunca se solapan -- [start,end) es semiabierto', () => {
    fc.assert(
      fc.property(rangeArb, fc.integer({ min: 1, max: 2_000 }), (a, gapOrNextDuration) => {
        const b = { start: a.end, end: toDate((a.end.getTime() - EPOCH) / 60_000 + gapOrNextDuration) };
        expect(hasTimeOverlap(a.start, a.end, b.start, b.end)).toBe(false);
      }),
    );
  });

  it('coincide con la definición directa: NO se solapan sii uno termina antes de que el otro empiece', () => {
    fc.assert(
      fc.property(rangeArb, rangeArb, (a, b) => {
        const expected = !(a.end <= b.start || b.end <= a.start);
        expect(hasTimeOverlap(a.start, a.end, b.start, b.end)).toBe(expected);
      }),
    );
  });

  it('ensanchar cualquiera de los dos rangos no puede convertir un solapamiento en no-solapamiento (monotonía)', () => {
    fc.assert(
      fc.property(rangeArb, rangeArb, fc.integer({ min: 1, max: 500 }), (a, b, widen) => {
        fc.pre(hasTimeOverlap(a.start, a.end, b.start, b.end));
        const widerAEnd = new Date(a.end.getTime() + widen * 60_000);
        expect(hasTimeOverlap(a.start, widerAEnd, b.start, b.end)).toBe(true);
      }),
    );
  });
});

describe('assertValidTimeRange — propiedades', () => {
  it('nunca lanza para start < end', () => {
    fc.assert(
      fc.property(rangeArb, (r) => {
        expect(() => assertValidTimeRange(r.start, r.end)).not.toThrow();
      }),
    );
  });

  it('siempre lanza InvalidReservationError cuando start >= end', () => {
    fc.assert(
      fc.property(rangeArb, fc.integer({ min: 0, max: 500 }), (r, backwards) => {
        // r.start es siempre <= r.end acá -- forzamos start >= end invirtiendo.
        const start = r.end;
        const end = new Date(r.start.getTime() - backwards * 60_000);
        fc.pre(start.getTime() >= end.getTime());
        expect(() => assertValidTimeRange(start, end)).toThrow(InvalidReservationError);
      }),
    );
  });
});

describe('isResourceAvailable — propiedades', () => {
  it('sin ninguna reserva activa, cualquier rango está disponible', () => {
    fc.assert(
      fc.property(fc.uuid(), rangeArb, (resourceId, r) => {
        expect(isResourceAvailable(resourceId, r.start, r.end, [])).toBe(true);
      }),
    );
  });

  it('reservas de OTRO resourceId nunca afectan la disponibilidad del que se está chequeando', () => {
    fc.assert(
      fc.property(
        fc.uuid(), fc.uuid(), rangeArb, fc.array(snapshotArb('otro-recurso'), { maxLength: 10 }),
        (resourceId, otherResourceId, r, otherReservations) => {
          fc.pre(resourceId !== otherResourceId);
          const reservations = otherReservations.map((s) => ({ ...s, resourceId: otherResourceId }));
          expect(isResourceAvailable(resourceId, r.start, r.end, reservations)).toBe(true);
        },
      ),
    );
  });

  it('reservas CANCELLED/COMPLETED/EXPIRED nunca bloquean, sin importar cuánto se solapen', () => {
    fc.assert(
      fc.property(
        fc.uuid(), rangeArb, fc.constantFrom(...NON_BLOCKING_STATUSES),
        (resourceId, r, status) => {
          const blocker: ReservationSnapshot = {
            id: 'blocker', resourceId, status,
            startTime: r.start, endTime: r.end,
            serviceId: null, partySize: 1, orderItemId: null,
          };
          expect(isResourceAvailable(resourceId, r.start, r.end, [blocker])).toBe(true);
        },
      ),
    );
  });

  it('una reserva PENDING/CONFIRMED con el mismo rango exacto siempre bloquea', () => {
    fc.assert(
      fc.property(
        fc.uuid(), rangeArb, fc.constantFrom(...BLOCKING_STATUSES),
        (resourceId, r, status) => {
          const blocker: ReservationSnapshot = {
            id: 'blocker', resourceId, status,
            startTime: r.start, endTime: r.end,
            serviceId: null, partySize: 1, orderItemId: null,
          };
          expect(isResourceAvailable(resourceId, r.start, r.end, [blocker])).toBe(false);
        },
      ),
    );
  });

  it('excludeReservationId siempre libera exactamente esa reserva, sin afectar al resto', () => {
    fc.assert(
      fc.property(
        fc.uuid(), rangeArb, fc.constantFrom(...BLOCKING_STATUSES),
        (resourceId, r, status) => {
          const own: ReservationSnapshot = {
            id: 'self', resourceId, status,
            startTime: r.start, endTime: r.end,
            serviceId: null, partySize: 1, orderItemId: null,
          };
          // Sola en la lista: excluirla a sí misma siempre da disponible.
          expect(isResourceAvailable(resourceId, r.start, r.end, [own], 'self')).toBe(true);
        },
      ),
    );
  });

  it('coincide con el chequeo directo: disponible sii ninguna reserva activa (mismo resourceId, no excluida) se solapa', () => {
    fc.assert(
      fc.property(
        fc.uuid(), rangeArb, fc.array(snapshotArb('r'), { maxLength: 8 }), fc.option(fc.uuid(), { nil: undefined }),
        (resourceId, r, reservations, excludeId) => {
          const scoped = reservations.map((s) => ({ ...s, resourceId }));
          const expected = !scoped.some((s) =>
            (s.status === ReservationStatus.PENDING || s.status === ReservationStatus.CONFIRMED) &&
            s.id !== excludeId &&
            hasTimeOverlap(r.start, r.end, s.startTime, s.endTime),
          );
          expect(isResourceAvailable(resourceId, r.start, r.end, scoped, excludeId)).toBe(expected);
        },
      ),
    );
  });
});
