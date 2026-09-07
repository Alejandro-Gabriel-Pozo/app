/**
 * @file dead-letter-notify.ts
 * @description O5 / D2-C (07/09/2026,
 * docs/diseno-order13-o5-dead-letter-2026-09-07.md, bloque 4) — arma el
 * callback `onDeadLetterBatch` del `OutboxWorker`: cuando uno o más eventos
 * transicionan a dead-letter en un ciclo de poll, avisa por email a los
 * usuarios `MANAGEMENT` del tenant.
 *
 * Refinamientos del review ERP (Q3):
 *  - UN email por ciclo con todos los eventos, no uno por evento (Odoo agrupa,
 *    account_move_send.py:487).
 *  - Solo en la transición — el `OutboxWorker` ya llama a este callback
 *    únicamente con los eventos que reciÉN pasaron a dead-letter.
 *  - Degrada honesto: sin destinatarios, o con `NoopEmailSender`, el aviso
 *    vive en el banner del panel (`OutboxAlertBanner`) y en el log. ERPNext
 *    condiciona igual a que haya cuenta de correo (repost_item_valuation.py:600).
 *  - Nunca PII en logs (A7.1): se loguean CONTEOS y `businessId`, jamás los
 *    emails ni el `last_error` crudo.
 */

import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { EmailSender } from '../email/email.sender.js';
import { deadLetterAlertEmail } from '../email/templates.js';
import { describeDeadLetter } from '../domain/dead-letter-describe.js';
import { logger } from '../logger.js';

export interface DeadLetterNotifierDeps {
  businessId: string;
  /** Resuelve los emails MANAGEMENT del tenant (platform DB). */
  getManagementEmails: (businessId: string) => Promise<string[]>;
  emailSender: EmailSender;
  /** Base del panel + `/dashboard` — para el link del email. */
  dashboardUrl: string;
}

export function makeDeadLetterEmailNotifier(
  deps: DeadLetterNotifierDeps,
): (events: DomainEvent[]) => Promise<void> {
  const { businessId, getManagementEmails, emailSender, dashboardUrl } = deps;

  return async (events: DomainEvent[]): Promise<void> => {
    if (events.length === 0) return;

    const emails = await getManagementEmails(businessId);

    if (emails.length === 0) {
      logger.warn(
        { businessId, count: events.length },
        '[outbox] Eventos en dead-letter sin destinatarios MANAGEMENT — el aviso queda solo en el banner del panel',
      );
      return;
    }

    const { subject, html } = deadLetterAlertEmail({
      dashboardUrl,
      items: events.map((e) => ({
        summary: describeDeadLetter({ eventType: e.eventType, lastError: e.lastError ?? null }).summary,
      })),
    });

    logger.warn(
      { businessId, count: events.length, recipients: emails.length },
      '[outbox] Eventos en dead-letter — notificando a MANAGEMENT',
    );

    const results = await Promise.allSettled(
      emails.map((to) => emailSender.send({ to, fromName: 'Panel del negocio', subject, html })),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      logger.error(
        { businessId, failed, total: emails.length },
        '[outbox] Fallaron envíos del aviso de dead-letter (el banner del panel sigue)',
      );
    }
  };
}
