/**
 * @file reservation-time.utils.ts
 * @description Funciones puras de fecha/hora usadas por más de una pieza
 * del módulo de reservas (Fase 6, docs/auditoria-modularidad.md, hallazgo
 * B1) — ninguna de las dos depende de repositorios ni de estado de
 * instancia, así que no pertenecen a ninguna de las clases de servicio en
 * particular (`ReservationService`, `ReservationAvailabilityService`,
 * `ReservationScheduleService`), solo se llaman desde varias.
 */

import { DateTime } from 'luxon';
import { InvalidReservationError } from '../domain/errors.js';
import type { BookableService } from './bookable-service.types.js';

/**
 * Combina la fecha calendario (leída en UTC, para no depender de la zona
 * horaria del proceso — mismo criterio que `calculateNights` en
 * reservation-pricing.service.ts) con una hora "HH:MM" o "HH:MM:SS" (tal
 * cual llega de una columna TIME de Postgres), interpretando esa hora en
 * el huso IANA del negocio (`business_profile.timezone`, ver
 * domain/business-profile.entities.ts — A4.2).
 *
 * Antes (hasta el 18/08/2026) tenía el huso de Argentina hardcodeado
 * (`-03:00` fijo) — correcto solo para Argentina, que no aplica horario de
 * verano desde 2009, pero roto para cualquier negocio en un huso con DST
 * (Chile, Brasil hasta 2019, Paraguay). `Date` nativo no sabe convertir
 * "hora de pared + nombre de huso IANA" a instante UTC (solo acepta un
 * offset numérico fijo) — se usa `luxon` para eso, primera dependencia de
 * fechas del proyecto (deliberadamente liviano en dependencias hasta
 * ahora: manejar DST a mano con `Intl` es fácil de hacer sutilmente mal, y
 * este es un camino crítico de disponibilidad).
 *
 * **Política A4.7 (`criterios-negocio.md`) — hora que no existe o que
 * ocurre dos veces por un cambio de horario:**
 * - **Hora inexistente** (ej. el salto de primavera en Chile: 23:59:59
 *   del 7-sep-2024 pasa directo a 01:00:00 del 8-sep — 00:00 a 00:59 no
 *   existen ese día): se avanza por el mismo tamaño del salto, aterrizando
 *   en un instante válido después del corte (ej. 00:30 inexistente → se
 *   toma como 01:30 real). Es el comportamiento default de
 *   `DateTime.fromObject` de luxon — no hace falta código adicional,
 *   verificado con las transiciones reales de America/Santiago 2024 (ver
 *   `reservation.service.test.ts`, describe "combineDateAndTime — DST").
 * - **Hora ambigua** (ej. la vuelta de otoño: 23:00-23:59 del 6-abr-2024
 *   en Chile ocurre dos veces, una en horario de verano y otra en
 *   estándar): se toma el offset ESTÁNDAR (el de invierno, no el de
 *   verano) — también el default de luxon, que resuelve a la ocurrencia
 *   más tardía de las dos. Mismo criterio "cuando dudás, la hora que va a
 *   seguir valiendo el resto del año" que ya se usa para otras
 *   ambigüedades del sistema.
 *
 * Ninguna de las dos ramas lanza ni deja `isValid: false` — confirmado
 * empíricamente contra luxon 3.7, no es una garantía documentada de la
 * librería, por eso está fijado con test de regresión (golden values
 * contra transiciones reales, no fechas relativas a "hoy").
 */
export function combineDateAndTime(date: Date, time: string, timezone: string): Date {
  const parts = time.split(':').map(Number);
  const hour   = parts[0] ?? 0;
  const minute = parts[1] ?? 0;
  const second = parts[2] ?? 0;

  const dt = DateTime.fromObject(
    {
      year:  date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day:   date.getUTCDate(),
      hour, minute, second,
    },
    { zone: timezone },
  );

  if (!dt.isValid) {
    throw new InvalidReservationError(
      `No se pudo interpretar "${time}" en el huso horario "${timezone}": ${dt.invalidReason} (${dt.invalidExplanation}).`,
    );
  }

  return dt.toJSDate();
}

/**
 * Resuelve el endTime efectivo: el que vino explícito, o derivado de
 * `duration_minutes` del servicio si solo vino `startTime` + `serviceId`.
 * `service` ya viene resuelto por el caller (`ReservationService.
 * createReservation()`, `ReservationAvailabilityService.
 * findAvailableResourceInCategory()`) — evita una segunda consulta al
 * mismo servicio. Sigue `async` por compatibilidad de firma con esos dos
 * call sites (`await resolveEndTime(...)`), aunque no espera nada.
 */
export async function resolveEndTime(
  serviceId: string | undefined,
  startTime: Date,
  endTime: Date | undefined,
  service: BookableService | null,
): Promise<Date> {
  if (endTime) return endTime;

  if (!serviceId) {
    throw new InvalidReservationError('endTime es obligatorio cuando no se especifica serviceId');
  }

  if (!service || service.durationMinutes == null) {
    throw new InvalidReservationError(
      `endTime es obligatorio: el servicio '${serviceId}' no tiene duration_minutes configurado`,
    );
  }

  return new Date(startTime.getTime() + service.durationMinutes * 60_000);
}
