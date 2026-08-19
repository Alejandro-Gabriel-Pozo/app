/**
 * @file email.handlers.ts
 * @description Handler de mail del OutboxWorker — punto 5/E5,
 * pendientes-2026-08-15.md. Hoy solo `reservation.confirmed`. Ver
 * email/email.sender.ts para el límite conocido de idempotencia (riesgo
 * aceptado: un reintento del outbox por OTRO handler puede reenviar el
 * mail).
 */

import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { EmailSender } from '../email/email.sender.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { reservationConfirmedEmail } from '../email/templates.js';
import type { OutboxWorker } from './outbox.worker.js';

const DEFAULT_SENDER_NAME = 'ZuluHub';

export function registerEmailHandlers(
  worker: OutboxWorker,
  emailSender: EmailSender,
  businessProfileRepo: BusinessProfileRepository,
): void {
  worker.on('reservation.confirmed', handleReservationConfirmedEmail(emailSender, businessProfileRepo));
}

export function handleReservationConfirmedEmail(
  emailSender: EmailSender,
  businessProfileRepo: BusinessProfileRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { customerEmail, customerName, resourceName, startTime, endTime, isLodging } = event.payload as {
      customerEmail?: string | null;
      customerName?: string;
      resourceName?: string;
      startTime?: string;
      endTime?: string;
      isLodging?: boolean;
    };

    // Cliente sin mail cargado (solo teléfono, ej.) -- nada que enviar, no es un error.
    if (!customerEmail || !resourceName || !startTime || !endTime) return;

    const profile = await businessProfileRepo.get();

    const { subject, html } = reservationConfirmedEmail({
      customerName: customerName ?? 'cliente',
      businessDisplayName: profile.displayName ?? DEFAULT_SENDER_NAME,
      resourceName,
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
