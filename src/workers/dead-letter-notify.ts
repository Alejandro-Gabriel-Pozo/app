/**
 * @file dead-letter-notify.ts
 * @description O5 / D2-C (07/09/2026,
 * docs/diseno-order13-o5-dead-letter-2026-09-07.md, bloque 4) — arma el
 * callback `onDeadLetterBatch` del `OutboxWorker`: cuando uno o más eventos
 * transicionan a dead-letter en un ciclo de poll, avisa por email a los
 * usuarios `MANAGEMENT` del tenant.
 *
 * Refinamientos del review ERP (Q3) + gate del architecture-governor (07/09):
 *  - UN email por ciclo con todos los eventos, no uno por evento (Odoo agrupa,
 *    account_move_send.py:487).
 *  - **Throttle entre ciclos (B1):** a lo sumo un aviso por `cooldownMs`. Un
 *    error permanente dead-lettea un evento nuevo por ciclo (maxRetries=1,
 *    outbox.worker.ts) → sin cooldown serían N mails cada 5 s por manager, y
 *    el `RESEND_API_KEY` es compartido con las confirmaciones de reserva al
 *    cliente. El cooldown solo espacia el PUSH — el banner del panel
 *    (`OutboxAlertBanner`, pull) sigue mostrando todo, así que no se oculta
 *    estado.
 *  - **Identifica el negocio (B2):** subject/cuerpo/`fromName` llevan el
 *    `display_name` del negocio — un manager con membresías en varios negocios
 *    tiene que saber cuál falló.
 *  - Degrada honesto: sin destinatarios, o con `NoopEmailSender`, el aviso
 *    vive en el banner y en el log (ERPNext condiciona igual a que haya cuenta
 *    de correo, repost_item_valuation.py:600).
 *  - Nunca PII en logs (A7.1): se loguean CONTEOS y `businessId`, jamás los
 *    emails ni el `last_error` crudo.
 */

import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { EmailSender } from '../email/email.sender.js';
import { DEFAULT_SENDER_NAME } from '../email/email.sender.js';
import { deadLetterAlertEmail } from '../email/templates.js';
import { describeDeadLetter } from '../domain/dead-letter-describe.js';
import { logger } from '../logger.js';

/** Ventana por defecto entre avisos de dead-letter de un mismo tenant. 15 min:
 *  durante un outage sostenido el manager recibe ~4 mails/hora en vez de 720,
 *  y un incidente genuinamente nuevo 15 min después igual dispara un aviso. */
const DEFAULT_COOLDOWN_MS = 15 * 60_000;

export interface DeadLetterNotifierDeps {
  businessId: string;
  /** Resuelve los emails MANAGEMENT del tenant (platform DB). */
  getManagementEmails: (businessId: string) => Promise<string[]>;
  /** `business_profile.display_name` del tenant (tenant DB) para identificar el negocio (B2). */
  getBusinessDisplayName: () => Promise<string | null>;
  emailSender: EmailSender;
  /** Base del panel + `/dashboard` — para el link del email. */
  dashboardUrl: string;
  /** Throttle entre avisos, ms. Default 15 min. */
  cooldownMs?: number;
  /** Reloj inyectable para tests. Default `Date.now`. */
  now?: () => number;
}

export function makeDeadLetterEmailNotifier(
  deps: DeadLetterNotifierDeps,
): (events: DomainEvent[]) => Promise<void> {
  const { businessId, getManagementEmails, getBusinessDisplayName, emailSender, dashboardUrl } = deps;
  const cooldownMs = deps.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = deps.now ?? Date.now;

  let lastActedAt: number | null = null;

  return async (events: DomainEvent[]): Promise<void> => {
    if (events.length === 0) return;

    if (lastActedAt !== null && now() - lastActedAt < cooldownMs) {
      logger.warn(
        { businessId, count: events.length, sinceLastMs: now() - lastActedAt },
        '[outbox] Aviso de dead-letter suprimido por cooldown — el banner del panel sigue al día',
      );
      return;
    }
    // Entra en cooldown al DECIDIR actuar sobre este batch, cualquiera sea el
    // resultado (sin destinatarios, o el envío falla): no reintentar-storm.
    lastActedAt = now();

    const emails = await getManagementEmails(businessId);
    if (emails.length === 0) {
      logger.warn(
        { businessId, count: events.length },
        '[outbox] Eventos en dead-letter sin destinatarios MANAGEMENT — el aviso queda solo en el banner del panel',
      );
      return;
    }

    // El aviso NO puede depender de la tenant DB: getManagementEmails va contra
    // PLATAFORMA, y un outage del tenant es justamente cuando hay dead-letters.
    // Si el nombre no resuelve, se avisa con el default — nunca se pierde el mail
    // (y la ventana de cooldown ya está consumida: sin este try serían 15 min de
    // silencio, no un fallo puntual — governor 07/09).
    let businessName = DEFAULT_SENDER_NAME;
    try {
      businessName = (await getBusinessDisplayName()) ?? DEFAULT_SENDER_NAME;
    } catch (err) {
      logger.warn(
        { businessId, err },
        '[outbox] No se pudo resolver el nombre del negocio para el aviso — se usa el default',
      );
    }

    const { subject, html } = deadLetterAlertEmail({
      businessName,
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
      emails.map((to) => emailSender.send({ to, fromName: businessName, subject, html })),
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
