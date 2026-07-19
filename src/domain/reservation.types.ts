import { ReservationStatus } from '../types/enums.js';

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
