import type { ReservationStatus } from '../types/enums.js';

/**
 * Vista mínima de una reserva para comprobar disponibilidad
 * sin acoplar al agregado completo.
 *
 * ## Cambios v4
 * - `+serviceId`   : para filtrar disponibilidad por servicio.
 * - `+partySize`   : para calcular ocupación parcial en resources con capacity > 1.
 * - `+orderItemId` : trazabilidad hacia la orden que originó la reserva.
 */
export interface ReservationSnapshot {
  id: string;
  resourceId: string;
  startTime: Date;
  endTime: Date;
  status: ReservationStatus;
  /** v4: servicio contratado (nullable para restaurantes o legacy) */
  serviceId: string | null;
  /**
   * v4: personas que ocupa esta reserva.
   * Usado por `BookableResource.availableSlots()` para calcular
   * disponibilidad parcial cuando `capacity > 1`.
   */
  partySize: number;
  /** v4: FK a order_items; null en reservas legacy pre-v4 */
  orderItemId: string | null;
}

/**
 * Una unidad temporal facturable de la reserva: una noche (bookingMode
 * 'block') o la única unidad de un turno/evento (slot/event). Ver el
 * comentario de `reservation_lines` en db/schema.sql para el porqué de
 * este modelo y sus límites actuales (sin estado propio, sin
 * recotización al editar fechas).
 */
export interface ReservationLine {
  id: string;
  reservationId: string;
  unitDate: Date;
  price: number;
}

/**
 * Fase 3, "Auto Assign All"
 * (docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md §5) — resultado
 * de procesar UNA reserva `PENDING_ASSIGNMENT` dentro del batch.
 */
export interface AutoAssignAllItemResult {
  reservationId: string;
  previousResourceId: string;
  outcome: 'CONFIRMED_SAME_RESOURCE' | 'REASSIGNED' | 'SKIPPED_ALREADY_ASSIGNED' | 'FAILED';
  /** presente si CONFIRMED_SAME_RESOURCE (== previousResourceId) o REASSIGNED */
  newResourceId?: string;
  /** presente si SKIPPED_ALREADY_ASSIGNED o FAILED -- el `code` del DomainError real */
  code?: string;
  /** idem -- nunca datos de cliente (mismo criterio de logging que error.middleware.ts, A7.1) */
  message?: string;
  /**
   * (N1, v3 del diseño) presente y en `false` SOLO si la transacción hizo
   * commit pero `recordOccupancy()` post-commit falló -- nunca aparece en
   * `true` (el caso normal no necesita el campo), nunca aparece junto con
   * FAILED/SKIPPED_ALREADY_ASSIGNED.
   */
  occupancyRecorded?: false;
}

/** Fase 3, "Auto Assign All" (§5 del diseño) — resultado completo del batch. */
export interface AutoAssignAllResult {
  categoryId: string;
  categoryName: string;
  /** (B1, v3) `filtered.length` -- filas que pasaron el filtro EXACTO de capa 2 (deriveCalendarDate === hoy), nunca el conteo aproximado de SQL. */
  totalPending: number;
  /** min(totalPending, RESERVATIONS_MAX_LIMIT) -- sobre el totalPending ya exacto. */
  processed: number;
  /** true si totalPending > processed, o si el LIMIT de seguridad de la capa SQL se alcanzó -- honest-degradation, nunca implícito. */
  truncated: boolean;
  confirmedSameResource: number;
  reassigned: number;
  skippedAlreadyAssigned: number;
  failed: number;
  items: AutoAssignAllItemResult[];
}
