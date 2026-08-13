import { ReservationStatus } from '../types/enums.js';
import { InvalidReservationError } from './errors.js';
import type { ReservationSnapshot } from './reservation.types.js';

export function hasTimeOverlap(
  aStart: Date,
  aEnd: Date,
  bStart: Date,
  bEnd: Date,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

export function assertValidTimeRange(start: Date, end: Date): void {
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
    throw new InvalidReservationError('startTime inválido');
  }
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
    throw new InvalidReservationError('endTime inválido');
  }
  if (start >= end) {
    throw new InvalidReservationError(
      'startTime debe ser anterior a endTime',
    );
  }
}

export function isBlockingStatus(status: ReservationStatus): boolean {
  return (
    status === ReservationStatus.PENDING ||
    status === ReservationStatus.CONFIRMED
  );
}

export function getActiveReservationsForResource(
  resourceId: string,
  reservations: ReservationSnapshot[],
): ReservationSnapshot[] {
  return reservations.filter(
    (reservation) =>
      reservation.resourceId === resourceId &&
      isBlockingStatus(reservation.status),
  );
}

export function isResourceAvailable(
  resourceId: string,
  start: Date,
  end: Date,
  reservations: ReservationSnapshot[],
  excludeReservationId?: string,
): boolean {
  assertValidTimeRange(start, end);

  const active = getActiveReservationsForResource(resourceId, reservations).filter(
    (reservation) => reservation.id !== excludeReservationId,
  );

  return !active.some((reservation) =>
    hasTimeOverlap(start, end, reservation.startTime, reservation.endTime),
  );
}