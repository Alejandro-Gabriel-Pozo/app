/**
 * @file email.handlers.ts
 * @description Handler de mail del OutboxWorker — punto 5/E5,
 * pendientes-2026-08-15.md. Hoy solo `reservation.confirmed`.
 *
 * ## Idempotencia — resuelto el 28/08/2026 (antes: riesgo aceptado)
 * Este archivo decía que "un reintento del outbox por OTRO handler puede
 * reenviar el mail", y era literal: `reservation.confirmed` tiene dos
 * consumidores (este y el financiero de `outbox.handlers.ts`), el worker los
 * corre juntos con `Promise.all`, y si el financiero fallaba el evento
 * entero se reintentaba — reenviando la confirmación al huésped. A diferencia
 * de los otros handlers, este no tiene ninguna clave natural que reclamar:
 * mandar un mail no deja fila con la que chocar.
 *
 * Lo resuelve el casillero `processed_events` del worker (A10.3): el nombre
 * `email:reservation.confirmed` de abajo ES esa clave. Si el handler manda el
 * mail y termina bien, el casillero queda tomado y un reintento del evento lo
 * saltea. Si falla, el casillero se libera y se reintenta.
 *
 * Límite que SIGUE abierto: si el proceso muere entre `emailSender.send()` y
 * el commit del casillero, el mail se reenvía. Es la ventana irreducible de
 * cualquier efecto externo sin transacción — mucho más chica que la de antes
 * (que era "cada vez que otro handler falla"), pero no es cero.
 */

import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { EmailSender } from '../email/email.sender.js';
import { DEFAULT_SENDER_NAME } from '../email/email.sender.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { reservationConfirmedEmail } from '../email/templates.js';
import type { OutboxWorker } from './outbox.worker.js';

export function registerEmailHandlers(
  worker: OutboxWorker,
  emailSender: EmailSender,
  businessProfileRepo: BusinessProfileRepository,
): void {
  worker.on(
    'reservation.confirmed',
    handleReservationConfirmedEmail(emailSender, businessProfileRepo),
    { name: 'email:reservation.confirmed' },
  );
}

export function handleReservationConfirmedEmail(
  emailSender: EmailSender,
  businessProfileRepo: BusinessProfileRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { customerEmail, customerName, resourceName, startTime, endTime, isLodging, categoryName } = event.payload as {
      customerEmail?: string | null;
      customerName?: string;
      resourceName?: string;
      startTime?: string;
      endTime?: string;
      isLodging?: boolean;
      /** v11/Fase 1 (25/09/2026) -- solo presente para alojamiento; ver debajo. */
      categoryName?: string;
    };

    // Cliente sin mail cargado (solo teléfono, ej.) -- nada que enviar, no es un error.
    if (!customerEmail || !resourceName || !startTime || !endTime) return;

    const profile = await businessProfileRepo.get();

    // v11/Fase 1 (25/09/2026, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md
    // §6) -- solo para alojamiento se prefiere el nombre de la CATEGORÍA
    // ("Habitación Doble") al nombre del recurso concreto asignado
    // ("Hab. 204") -- el huésped reserva un tipo de unidad, no un recurso
    // puntual. `?? resourceName` es compatibilidad con eventos del outbox
    // reprocesados de antes de este cambio, que no traen `categoryName`.
    // Turnos (isLodging=false) siguen mostrando resourceName sin cambios.
    const displayName = isLodging ? (categoryName ?? resourceName) : resourceName;

    const { subject, html } = reservationConfirmedEmail({
      customerName: customerName ?? 'cliente',
      businessDisplayName: profile.displayName ?? DEFAULT_SENDER_NAME,
      resourceName: displayName,
      checkInLabel:  formatReservationBoundary(startTime, isLodging, profile.timezone, profile.defaultCheckInTime),
      checkOutLabel: formatReservationBoundary(endTime,   isLodging, profile.timezone, profile.defaultCheckOutTime),
    });

    await emailSender.send({
      to: customerEmail,
      fromName: profile.displayName ?? DEFAULT_SENDER_NAME,
      ...(profile.contactEmail && { replyTo: profile.contactEmail }),
      subject,
      html,
    });
  };
}

/**
 * Etiqueta a mostrar en el mail para el inicio/fin de una reserva.
 *
 * - **Alojamiento (E1):** `boundary` es "medianoche UTC del día calendario"
 *   (así lo guarda Reservas, appfrontend-main) -- no un horario real. Se
 *   muestra el día (leído en UTC, nunca con getters locales -- mismo
 *   motivo que el resto del sistema, ver housekeeping/calendario) más el
 *   horario ESTÁNDAR configurado en Mi Negocio para check-in/check-out.
 *   `standardTime` ("HH:MM[:SS]", columna TIME de Postgres) es ya la hora
 *   de pared del negocio -- se formatea tal cual, sin pasar por ninguna
 *   conversión de huso (no representa un instante, no tiene zona).
 * - **Turno con horario real** (`bookingMode='slot'`): `boundary` sí es un
 *   instante real -- se convierte al huso del negocio, como antes.
 */
function formatReservationBoundary(
  boundary: string,
  isLodging: boolean | undefined,
  timezone: string,
  standardTime: string | null,
): string {
  if (isLodging) {
    const dateLabel = new Intl.DateTimeFormat('es-AR', { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(boundary));
    if (!standardTime) return dateLabel;
    const [h = 0, m = 0] = standardTime.split(':').map(Number);
    const timeLabel = new Intl.DateTimeFormat('es-AR', { timeStyle: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h, m)));
    return `${dateLabel}, ${timeLabel}`;
  }

  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'full', timeStyle: 'short', timeZone: timezone }).format(new Date(boundary));
}
