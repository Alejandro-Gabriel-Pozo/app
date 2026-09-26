/**
 * @file credit-note-review-sla.worker.ts
 * @description Bloque 6 de `credit_note_request` (§6.5 bis, pregunta 2,
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`) -- avisa a
 * `MANAGEMENT` cuando una fila queda en `EN_REVISION_MANUAL` más de 48hs
 * (SLA resuelto por el dueño vía `AskUserQuestion`) sin que nadie la
 * resuelva. Mismo esqueleto que `ReservationHoldExpiryWorker`
 * (`setInterval` + `poll()`, cada fila en su propio `try/catch` para que
 * una falla no bloquee al resto del ciclo) -- razonado explícitamente en el
 * ADR contra `dead-letter-notify.ts` y descartado: ese otro worker
 * reacciona a ARRIBOS nuevos a un estado (piggybackea en el poll del
 * outbox), esto barre filas VIEJAS que no cambiaron de estado -- misma
 * forma que `getPendingWithExpiredDeposit()`, no la de un callback
 * reactivo. No se diseña infraestructura de colas/scheduling nueva: es el
 * tercer worker con esta forma en el repo.
 *
 * ## Por qué `sla_alert_sent_at` se persiste en la fila (no en memoria)
 * A diferencia del cooldown de `dead-letter-notify.ts` (variable de
 * proceso, se resetea en cada restart/redeploy), acá la fuente de verdad
 * de "¿ya se avisó esto?" es la columna: un restart de Render no tiene que
 * volver a mandar N alertas de filas ya notificadas hace 10 minutos.
 * `markSlaAlertSent()` es un compare-and-swap (`WHERE sla_alert_sent_at IS
 * NULL`) -- necesario porque más de una instancia del proceso podría
 * reclamar la misma fila en el mismo ciclo; solo la que gana el UPDATE
 * manda el mail.
 *
 * ## Por qué se marca ANTES de intentar enviar el mail, no después
 * Mismo criterio que `dead-letter-notify.ts` ("entra en cooldown al
 * DECIDIR actuar sobre este batch, cualquiera sea el resultado"): la
 * pregunta de negocio C (§6.5 bis) resolvió escalamiento ÚNICO, no
 * reiterado -- si el envío de mail falla (sin destinatarios, `EmailSender`
 * caído), la fila igual queda marcada. El endpoint `GET
 * /api/credit-note-requests?state=EN_REVISION_MANUAL` sigue devolviendo la
 * fila -- degradar el email no la borra de la API. **Pero hoy esto NO tiene
 * pantalla propia en `appfrontend-main`** (§6.5 bis planea una bandeja en
 * `dashboard/facturacion`, todavía sin construir -- ver
 * `docs/pendientes-2026-09-12.md`): si el envío falla o no hay
 * destinatarios, lo único que queda es la API cruda y los logs, no una
 * pantalla que un operador mire. Mismo argumento que D2-C usa para no
 * necesitar un "banner de respaldo" acá, acotado a lo que existe hoy.
 *
 * ## Batching -- un solo mail por ciclo, no uno por fila
 * Mismo criterio que `makeDeadLetterEmailNotifier()`: si varias filas
 * cruzan el SLA en el mismo poll, un solo mail lista todas -- evita spam a
 * MANAGEMENT si el poll estuvo caído un rato y varias filas vencen juntas.
 *
 * ## Aislamiento multi-tenant
 * Instanciado por tenant en `ensureTenantWorker()` (`workers/outbox.registry.ts`),
 * mismo `businessId`/`db` que el resto de los workers de ese registro
 * (DEFENSIVE_DEVELOPING §3) -- `creditNoteRequestRepo` ya viene construido
 * sobre el `SqlClient` del tenant correcto, este archivo no resuelve
 * ninguna conexión.
 */

import type { CreditNoteRequest } from '../facturacion/credit-note-request.entities.js';
import type { CreditNoteRequestRepository } from '../facturacion/credit-note-request.repository.js';
import type { EmailSender } from '../email/email.sender.js';
import { DEFAULT_SENDER_NAME } from '../email/email.sender.js';
import { creditNoteReviewSlaAlertEmail } from '../email/templates.js';
import { logger } from '../logger.js';

/**
 * SLA confirmado por el dueño (§6.5 bis, pregunta A) -- 48 horas desde que
 * la fila entra a `EN_REVISION_MANUAL`, tal como el dueño formuló la
 * decisión.
 *
 * **Lo que el código mide de verdad no es exactamente eso.**
 * `listEligibleForSlaAlert()` usa `created_at` como proxy de "hace cuánto
 * está en revisión" -- pero una fila nace `PENDIENTE`, y si `issue()` cae en
 * la rama `afipContacted: false` queda en `PENDIENTE` sin transición hasta
 * un `retryExisting()` posterior que recién ahí la mueve a
 * `EN_REVISION_MANUAL`, posiblemente días después. Con `created_at` como
 * proxy, el aviso puede salir ANTES de las 48hs reales de estar en revisión
 * (nunca después -- no es peligroso, pero tampoco cumple la decisión tal
 * cual se formuló). Decisión de negocio pendiente, sin resolver a propósito
 * en este bloque: ver `docs/pendientes-2026-09-12.md`.
 */
export const CREDIT_NOTE_REVIEW_SLA_MS = 48 * 60 * 60 * 1000;

/**
 * Intervalo de poll. A diferencia de `ReservationHoldExpiryWorker` (60s --
 * la precisión importa para un depósito que puede vencer en minutos), acá
 * el SLA es de 48hs -- un poll cada 15 minutos no le hace perder precisión
 * práctica al aviso y evita 96 queries/hora/tenant sin necesidad.
 */
const DEFAULT_POLL_INTERVAL_MS = 15 * 60_000;

export interface CreditNoteReviewSlaWorkerDeps {
  businessId: string;
  creditNoteRequestRepo: Pick<CreditNoteRequestRepository, 'listEligibleForSlaAlert' | 'markSlaAlertSent'>;
  /** Resuelve los emails MANAGEMENT del tenant (platform DB) -- pregunta B de §6.5 bis, RESUELTA. */
  getManagementEmails: (businessId: string) => Promise<string[]>;
  /** `business_profile.display_name` del tenant (tenant DB), mismo patrón que `dead-letter-notify.ts`. */
  getBusinessDisplayName: () => Promise<string | null>;
  emailSender: EmailSender;
  /** Base del panel + `/dashboard/facturacion` -- deep link a la bandeja de revisión, no al banner de outbox. */
  dashboardUrl: string;
  /** SLA en ms. Default `CREDIT_NOTE_REVIEW_SLA_MS` (48hs). */
  slaMs?: number;
  /** Intervalo de poll en ms. Default `DEFAULT_POLL_INTERVAL_MS` (15 min). */
  pollIntervalMs?: number;
  /** Reloj inyectable para tests. Default `Date.now`. */
  now?: () => number;
}

export class CreditNoteReviewSlaWorker {
  private intervalId: ReturnType<typeof setInterval> | undefined = undefined;
  private polling = false;

  private readonly businessId: string;
  private readonly creditNoteRequestRepo: CreditNoteReviewSlaWorkerDeps['creditNoteRequestRepo'];
  private readonly getManagementEmails: CreditNoteReviewSlaWorkerDeps['getManagementEmails'];
  private readonly getBusinessDisplayName: CreditNoteReviewSlaWorkerDeps['getBusinessDisplayName'];
  private readonly emailSender: EmailSender;
  private readonly dashboardUrl: string;
  private readonly slaMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;

  constructor(deps: CreditNoteReviewSlaWorkerDeps) {
    this.businessId = deps.businessId;
    this.creditNoteRequestRepo = deps.creditNoteRequestRepo;
    this.getManagementEmails = deps.getManagementEmails;
    this.getBusinessDisplayName = deps.getBusinessDisplayName;
    this.emailSender = deps.emailSender;
    this.dashboardUrl = deps.dashboardUrl;
    this.slaMs = deps.slaMs ?? CREDIT_NOTE_REVIEW_SLA_MS;
    this.pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
    logger.info(
      { businessId: this.businessId, pollIntervalMs: this.pollIntervalMs, slaMs: this.slaMs },
      '[CreditNoteReviewSlaWorker] Iniciado',
    );
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const olderThan = new Date(this.now() - this.slaMs);
      const eligible = await this.creditNoteRequestRepo.listEligibleForSlaAlert(olderThan);
      if (eligible.length === 0) return;

      // Orden a propósito (BLOCKING 2 del gate `architecture-governor`,
      // 26/09/2026): resolver destinatarios ANTES de reclamar filas. Si
      // `getManagementEmails()` (BD de plataforma) tira, no se reclama
      // ninguna fila -- el escalamiento es único (§6.5 bis, pregunta C), así
      // que marcar una fila sin haber podido avisar la dejaría marcada para
      // siempre sin aviso real. No reclamar nada deja el próximo poll (15
      // min) reintentando sobre las mismas filas.
      let emails: string[];
      try {
        emails = await this.getManagementEmails(this.businessId);
      } catch (err) {
        logger.error(
          { err, businessId: this.businessId, count: eligible.length },
          '[CreditNoteReviewSlaWorker] No se pudieron resolver destinatarios MANAGEMENT -- no se reclama ninguna fila, se reintenta en el próximo poll',
        );
        return;
      }

      const claimed: CreditNoteRequest[] = [];
      for (const row of eligible) {
        try {
          const wasClaimed = await this.creditNoteRequestRepo.markSlaAlertSent(row.id);
          if (wasClaimed) claimed.push(row);
        } catch (err) {
          logger.error(
            { err, businessId: this.businessId, creditNoteRequestId: row.id },
            '[CreditNoteReviewSlaWorker] Error marcando sla_alert_sent_at',
          );
        }
      }
      if (claimed.length === 0) return;

      if (emails.length === 0) {
        // D2-C: sin destinatarios, las filas igual quedan marcadas -- el
        // aviso queda solo en la bandeja, no se reintenta (mismo criterio
        // que el resto de este worker).
        logger.warn(
          { businessId: this.businessId, count: claimed.length },
          '[CreditNoteReviewSlaWorker] Filas que cruzaron el SLA sin destinatarios MANAGEMENT — el aviso queda solo en la bandeja',
        );
        return;
      }

      await this.notify(claimed, emails);
    } catch (err) {
      this.handlePollError(err);
    } finally {
      this.polling = false;
    }
  }

  /**
   * Mismo patrón que `OutboxWorker.handlePollError()` (`workers/outbox.worker.ts`):
   * un `catch` a nivel de `poll()` para que una falla no atrapada en
   * `listEligibleForSlaAlert()` (BD de tenant) o en `getManagementEmails()`
   * (BD de plataforma, ya cubierta por el `try/catch` de arriba pero
   * defensivo igual -- cualquier otra falla imprevista del ciclo cae acá)
   * no rechace la promesa de `poll()` sin handler y tumbe el proceso
   * (BLOCKING 1 del gate `architecture-governor`, 26/09/2026, confirmado con
   * una prueba real). A diferencia de `OutboxWorker`, este worker no tiene
   * un caso especial de "tabla no existe" que pausar -- `credit_note_request`
   * ya existe desde el Bloque 1 (v57 de `schema.sql`), así que cualquier
   * error simplemente se loguea y se reintenta en el próximo poll (15 min).
   */
  private handlePollError(err: unknown): void {
    logger.error(
      { err, businessId: this.businessId },
      '[CreditNoteReviewSlaWorker] Error en el ciclo de poll -- se reintenta en el próximo ciclo',
    );
  }

  private async notify(claimed: CreditNoteRequest[], emails: string[]): Promise<void> {
    // Mismo criterio que dead-letter-notify.ts: el nombre no puede
    // bloquear el aviso -- si no resuelve, se manda con el default.
    let businessName = DEFAULT_SENDER_NAME;
    try {
      businessName = (await this.getBusinessDisplayName()) ?? DEFAULT_SENDER_NAME;
    } catch (err) {
      logger.warn(
        { businessId: this.businessId, err },
        '[CreditNoteReviewSlaWorker] No se pudo resolver el nombre del negocio para el aviso — se usa el default',
      );
    }

    const nowMs = this.now();
    const { subject, html } = creditNoteReviewSlaAlertEmail({
      businessName,
      dashboardUrl: this.dashboardUrl,
      items: claimed.map((r) => ({ summary: describeCreditNoteRequestForAlert(r, nowMs) })),
    });

    logger.warn(
      { businessId: this.businessId, count: claimed.length, recipients: emails.length },
      '[CreditNoteReviewSlaWorker] Solicitudes cruzaron el SLA de revisión manual — notificando a MANAGEMENT',
    );

    const results = await Promise.allSettled(
      emails.map((to) => this.emailSender.send({ to, fromName: businessName, subject, html })),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      logger.error(
        { businessId: this.businessId, failed, total: emails.length },
        '[CreditNoteReviewSlaWorker] Fallaron envíos del aviso de SLA (la bandeja sigue al día)',
      );
    }
  }
}

/**
 * Texto sin PII (A7.1) -- id de la solicitud, a qué orden/reserva
 * pertenece (ids, no nombres de cliente) y hace cuántos días está abierta.
 * `id`/`orderId`/`reservationId` son identificadores internos, nunca datos
 * de contacto.
 *
 * "Abierta hace N días", no "N días en revisión manual" -- `createdAt` es
 * la fecha de creación de la fila (que puede haber nacido `PENDIENTE`
 * antes de pasar a `EN_REVISION_MANUAL`, ver el docblock de
 * `CREDIT_NOTE_REVIEW_SLA_MS`), no necesariamente el momento en que entró a
 * revisión.
 */
function describeCreditNoteRequestForAlert(request: CreditNoteRequest, nowMs: number): string {
  const subject = request.orderId ? `orden ${request.orderId}` : `reserva ${request.reservationId}`;
  const daysOpen = Math.max(1, Math.floor((nowMs - request.createdAt.getTime()) / (24 * 60 * 60 * 1000)));
  const dias = daysOpen === 1 ? '1 día' : `${daysOpen} días`;
  return `Solicitud ${request.id} (${subject}) — abierta hace ${dias}`;
}
