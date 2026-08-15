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
    const { customerEmail, customerName, resourceName, startTime, endTime } = event.payload as {
      customerEmail?: string | null;
      customerName?: string;
      resourceName?: string;
      startTime?: string;
      endTime?: string;
    };

    // Cliente sin mail cargado (solo teléfono, ej.) -- nada que enviar, no es un error.
    if (!customerEmail || !resourceName || !startTime || !endTime) return;

    const profile = await businessProfileRepo.get();

    const { subject, html } = reservationConfirmedEmail({
      customerName: customerName ?? 'cliente',
      businessDisplayName: profile.displayName ?? DEFAULT_SENDER_NAME,
      resourceName,
      startTime: new Date(startTime),
      endTime: new Date(endTime),
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
