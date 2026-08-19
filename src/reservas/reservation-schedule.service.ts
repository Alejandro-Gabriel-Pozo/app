/**
 * @file reservation-schedule.service.ts
 * @description Turnos disponibles de un servicio `slot` — grupo "horarios
 * de turno" extraído de `reservation.service.ts` (Fase 6,
 * docs/auditoria-modularidad.md, hallazgo B1). Única razón de cambio: cómo
 * se genera la GRILLA de horarios candidatos a partir del horario de
 * atención de un recurso. Distinto de `ReservationAvailabilityService`
 * (responde "¿está libre este rango puntual?"): este servicio arma la
 * lista de rangos candidatos y le pregunta a `checkAvailability()` cuáles
 * sobreviven — no reimplementa el chequeo de conflictos.
 */

import { InvalidReservationError, ResourceNotFoundError } from '../domain/errors.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type { IOperatingHoursRepository } from '../platform/operating-hours.repository.js';
import type { ResourceRepository } from './resource.repository.js';
import type { ReservationAvailabilityService } from './reservation-availability.service.js';
import { combineDateAndTime } from './reservation-time.utils.js';

export class ReservationScheduleService {
  constructor(
    private readonly bookableServiceRepository: IBookableServiceRepository,
    private readonly operatingHoursRepository:  IOperatingHoursRepository,
    private readonly resourceRepository:        ResourceRepository,
    private readonly availabilityService:       ReservationAvailabilityService,
  ) {}

  /**
   * Turnos disponibles de un servicio `slot` para un recurso puntual, un día
   * dado. Resuelve el horario aplicable vía `operatingHoursRepository.
   * getEffectiveWindows()` (propio del recurso si tiene, si no el del
   * negocio), genera candidatos cada `durationMinutes` dentro de esas
   * ventanas, y filtra los que ya están ocupados reusando
   * `availabilityService.checkAvailability()` (misma lógica de conflictos
   * que create/update, incluye resource_locks).
   */
  async getAvailableSlots(serviceId: string, resourceId: string, date: Date, timezone: string): Promise<string[]> {
    const service = await this.bookableServiceRepository.findById(serviceId);
    // Solo 'slot' tiene sentido acá -- 'block' se reserva por rango de
    // noches, no por turnos de duración fija. 'event' tampoco: es una
    // decisión explícita (confirmada con el dueño, 18/08/2026,
    // docs/auditoria-modularidad.md Fase 4) que un evento (ej. salón o
    // mesa reservada en exclusiva) se agenda a mano por el organizador
    // (fecha/hora/duración explícitas), no eligiendo de una grilla de
    // turnos sugeridos como un corte de pelo.
    if (!service || service.bookingMode !== 'slot' || service.durationMinutes == null) {
      throw new InvalidReservationError('El servicio no tiene turnos por horario configurables');
    }

    const resource = await this.resourceRepository.getById(resourceId);
    if (!resource) throw new ResourceNotFoundError(resourceId);

    const dayOfWeek = (date.getUTCDay() + 6) % 7; // JS: domingo=0 → 0=lunes
    const windows = await this.operatingHoursRepository.getEffectiveWindows(resourceId, dayOfWeek);
    if (windows.length === 0) return [];

    const durationMs = service.durationMinutes * 60_000;
    const slots: Date[] = [];
    for (const w of windows) {
      let cursor = combineDateAndTime(date, w.startTime, timezone);
      const windowEnd = combineDateAndTime(date, w.endTime, timezone);
      while (cursor.getTime() + durationMs <= windowEnd.getTime()) {
        slots.push(new Date(cursor));
        cursor = new Date(cursor.getTime() + durationMs);
      }
    }

    const available = await Promise.all(
      slots.map(async (start) => {
        const end = new Date(start.getTime() + durationMs);
        const ok = await this.availabilityService.checkAvailability(resourceId, start, end, undefined, serviceId);
        return ok ? start.toISOString() : null;
      }),
    );
    return available.filter((s): s is string => s !== null);
  }
}
