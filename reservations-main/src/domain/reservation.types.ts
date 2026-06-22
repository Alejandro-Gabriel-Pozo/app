import { ReservationStatus } from '../types/enums.js';

/** Vista mínima de una reserva para comprobar disponibilidad sin acoplar al agregado completo. */
export interface ReservationSnapshot {
  id: string;
  resourceId: string;
  startTime: Date;
  endTime: Date;
  status: ReservationStatus;
}