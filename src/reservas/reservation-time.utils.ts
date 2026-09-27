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
import type { BookableService, BookingMode } from './bookable-service.types.js';

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
 *   verano), que es la ocurrencia MÁS TARDÍA. Mismo criterio "cuando
 *   dudás, la hora que va a seguir valiendo el resto del año" que ya se
 *   usa para otras ambigüedades del sistema. **Esto se FUERZA acá abajo,
 *   no se delega en luxon:** cuál de las dos ocurrencias elige luxon por
 *   default depende del tzdata/ICU del runtime, no de la librería. Hasta la
 *   última corrida verde de CI (05/09/2026) ese default coincidía con la
 *   política; después el tzdata del runner cambió y con ICU 78 luxon
 *   resuelve `America/Santiago` 2024-04-06 23:00 al offset de VERANO
 *   (`02:00Z`), rompiendo el golden test que "pasaba" por coincidencia
 *   (TEST-DST-001, 06/09/2026). Odoo hace lo mismo que esto:
 *   `pytz.localize(..., is_dst=False)` (`account/.../ir_fields.py`).
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

  // Política A4.7 -- HORA AMBIGUA (vuelta de otoño): la misma hora de pared
  // ocurre dos veces. Luxon ya eligió una; cuál elige por default depende
  // del tzdata del runtime (ver docblock). Forzamos la ocurrencia ESTÁNDAR
  // (invierno = la más tardía), sin depender de ese default.
  //
  // Detección independiente del tzdata: se compara el offset de la zona 1h
  // ANTES y 1h DESPUÉS de esta hora de pared. En una vuelta de otoño el
  // reloj retrocede -> el offset baja (menos negativo -> más negativo),
  // así que `offsetPre > offsetPost`. En el salto de primavera el offset
  // sube, así que la condición es falsa y esta rama NUNCA toca una hora
  // inexistente (esa la resuelve el default de luxon, ver docblock). Fuera
  // de una transición, `offsetPre === offsetPost` y es no-op byte a byte.
  //
  // La sonda de 1h SOBRE-DETECTA en husos con salto sub-horario (Lord Howe,
  // 30'): una hora de pared entre 30' y 60' antes de la transición NO es
  // ambigua pero igual cae en `offsetPre > offsetPost && dt.offset !== offsetPost`.
  // Por eso el corrimiento se aplica SOLO si preserva la hora de pared (guarda
  // de A4.3 más abajo): si la cambiaría, la hora no era ambigua y se deja como
  // está. Con salto de 60' (lo normal) la ventana de sobre-detección es vacía
  // y la guarda es un no-op.
  const offsetPre  = dt.minus({ hours: 1 }).offset;
  const offsetPost = dt.plus({ hours: 1 }).offset;
  if (offsetPre > offsetPost && dt.offset !== offsetPost) {
    // Luxon eligió la ocurrencia de verano. La estándar es el MISMO
    // instante de pared corrido a futuro por la diferencia de offset (la
    // ocurrencia más tardía). `plus` con minutos suma tiempo absoluto y
    // conserva la zona IANA -- no se persiste ningún offset numérico (A4.2).
    const standard = dt.plus({ minutes: dt.offset - offsetPost });
    // Guarda de ambigüedad real (A4.3): el corrimiento vale SOLO si la hora
    // de pared no cambió. Si cambió, esta hora no ocurría dos veces.
    if (
      standard.year   === dt.year   && standard.month  === dt.month  &&
      standard.day    === dt.day    && standard.hour   === dt.hour   &&
      standard.minute === dt.minute && standard.second === dt.second
    ) {
      return standard.toJSDate();
    }
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

/**
 * J1-TZ (27/09/2026, docs/diseno-j1-fecha-alojamiento-huso-negocio-2026-09-27.md)
 * — ¿este `Date` es una "marca de fecha calendario" (medianoche UTC exacta,
 * la convención que usa el panel para alojamiento y para servicios
 * `bookingMode='block'`, ver el comentario E1 de `confirmReservation()` en
 * `reservation.service.ts` -- fechas de alojamiento en el email, citado por
 * nombre y no por línea, SCHEMA-ANCHOR-DRIFT-001) o un
 * instante real? Caso borde declarado, no resuelto acá: un instante real
 * que cae exactamente a las 21:00 hora Argentina (`datetime-local` de
 * precisión de minuto) produce el mismo valor que una marca — se lee como
 * marca, deuda conocida.
 */
export function isCalendarDateMarker(d: Date): boolean {
  const utc = DateTime.fromJSDate(d, { zone: 'utc' });
  return utc.hour === 0 && utc.minute === 0 && utc.second === 0 && utc.millisecond === 0;
}

/**
 * Deriva la fecha calendario (ISO `YYYY-MM-DD`) de un `startTime` que
 * PUEDE ser una marca de fecha: si lo es, se lee la fecha UTC tal cual (es
 * la convención con la que se guardó); si es un instante real, se convierte
 * al huso del negocio antes de tomar la fecha. Solo para `startTime` de una
 * reserva — para "ahora" usar `todayInBusinessTimezone()`, nunca esta
 * función (ver su docblock para el motivo).
 */
export function deriveCalendarDate(startTime: Date, timezone: string): string {
  const dt = isCalendarDateMarker(startTime)
    ? DateTime.fromJSDate(startTime, { zone: 'utc' })
    : DateTime.fromJSDate(startTime, { zone: 'utc' }).setZone(timezone);
  const iso = dt.toISODate();
  if (iso == null) {
    throw new Error(`deriveCalendarDate: huso horario inválido o fecha inválida (timezone=${timezone})`);
  }
  return iso;
}

/**
 * Fecha calendario de "ahora" en el huso del negocio. Deliberadamente
 * SEPARADA de `deriveCalendarDate()`: "ahora" nunca es una marca de fecha
 * guardada por el panel, es el reloj real — pasarlo por
 * `isCalendarDateMarker()` sería un bug (si el reloj cae justo en
 * `00:00:00.000Z`, que ocurre 1ms/día en producción pero es SISTEMÁTICO en
 * tests con reloj congelado a esa hora, se leería como si fuera una fecha
 * calendario en UTC en vez de convertirse al huso de negocio).
 */
export function todayInBusinessTimezone(now: Date, timezone: string): string {
  const iso = DateTime.fromJSDate(now, { zone: 'utc' }).setZone(timezone).toISODate();
  if (iso == null) {
    throw new Error(`todayInBusinessTimezone: huso horario inválido (timezone=${timezone})`);
  }
  return iso;
}

/**
 * ¿Esta combinación de categoría/servicio/startTime debe compararse por
 * FECHA CALENDARIO (huso de negocio) en vez de por INSTANTE crudo? `slot`
 * se excluye primero y siempre — un servicio con horario real (aunque el
 * recurso sea de alojamiento) manda un instante real, nunca una marca.
 * Alojamiento y `bookingMode='block'` (alquiler multi-día no-alojamiento,
 * decisión del dueño 27/09/2026) califican SOLO si el `startTime` es,
 * además, una marca exacta — un instante real en esas mismas categorías
 * (ej. servicio `event`/sin-servicio con horario a mano) sigue comparándose
 * por instante.
 */
export function qualifiesForDateComparison(
  isLodging: boolean,
  bookingMode: BookingMode | undefined,
  startTime: Date,
): boolean {
  if (bookingMode === 'slot') return false;
  return (isLodging || bookingMode === 'block') && isCalendarDateMarker(startTime);
}

/**
 * J1-TZ — reemplaza la comparación cruda de J1 cuando `qualifies` es
 * true (fecha calendario en huso de negocio); mantiene el comportamiento
 * original de J1 (instante crudo + tolerancia) en cualquier otro caso.
 */
export function isPastStart(
  startTime: Date,
  qualifies: boolean,
  businessTimezone: string,
  now: () => Date,
  pastToleranceMs: number,
): boolean {
  if (!qualifies) {
    return startTime.getTime() < now().getTime() - pastToleranceMs;
  }
  return deriveCalendarDate(startTime, businessTimezone) < todayInBusinessTimezone(now(), businessTimezone);
}
