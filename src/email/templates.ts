/**
 * @file templates.ts
 * @description Plantillas de mails transaccionales. HTML armado a mano
 * (string simple) — no hace falta un motor de templates para un mail.
 *
 * `checkInLabel`/`checkOutLabel` llegan YA formateados por el caller
 * (email.handlers.ts) — este archivo no decide zona horaria ni si el
 * instante crudo de la reserva es un horario real o solo una marca de día
 * calendario (alojamiento, E1). Antes esta plantilla recibía
 * `startTime`/`endTime` + `timezone` y los formateaba acá mismo con
 * `Intl.DateTimeFormat`, tratándolos siempre como un instante real — para
 * una reserva de alojamiento eso rompía (bug reportado 19/08/2026:
 * `startTime`/`endTime` de alojamiento son "medianoche UTC del día",
 * convertirlas al huso del negocio corría el horario mostrado sin
 * relación con el check-in/check-out real configurado). Separar el
 * formateo del armado de HTML deja esa decisión en un solo lugar
 * (email.handlers.ts), no repetida si aparece un tercer tipo de mail.
 */

export interface ReservationConfirmedEmailParams {
  customerName: string;
  businessDisplayName: string;
  resourceName: string;
  /** Ya formateado para mostrar tal cual, ej. "lunes, 28 de septiembre de 2026, 15:00". */
  checkInLabel: string;
  /** Ídem, para el fin de la reserva. */
  checkOutLabel: string;
}

export function reservationConfirmedEmail(
  params: ReservationConfirmedEmailParams,
): { subject: string; html: string } {
  const { customerName, businessDisplayName, resourceName, checkInLabel, checkOutLabel } = params;

  return {
    subject: `Reserva confirmada — ${businessDisplayName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="margin-bottom: 4px;">¡Reserva confirmada!</h2>
        <p>Hola ${escapeHtml(customerName)},</p>
        <p>Tu reserva en <strong>${escapeHtml(businessDisplayName)}</strong> quedó confirmada.</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px 0; color: #666;">Recurso/Servicio</td>
            <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(resourceName)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Desde</td>
            <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(checkInLabel)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Hasta</td>
            <td style="padding: 8px 0; font-weight: 600;">${escapeHtml(checkOutLabel)}</td>
          </tr>
        </table>
        <p style="color: #666; font-size: 13px;">Si no reconocés esta reserva, respondé este mail.</p>
      </div>
    `.trim(),
  };
}

export interface UserInvitationEmailParams {
  businessDisplayName: string;
  roleName: string;
  /** Ya armada por el caller (user-invitation.routes.ts) — apunta al FRONTEND, no a esta API. */
  acceptUrl: string;
  expiresInDays: number;
}

export function userInvitationEmail(
  params: UserInvitationEmailParams,
): { subject: string; html: string } {
  const { businessDisplayName, roleName, acceptUrl, expiresInDays } = params;

  return {
    subject: `Te invitaron a sumarte a ${businessDisplayName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="margin-bottom: 4px;">Te invitaron a ${escapeHtml(businessDisplayName)}</h2>
        <p>Vas a sumarte con el rol <strong>${escapeHtml(roleName)}</strong>.</p>
        <p style="margin: 24px 0;">
          <a href="${acceptUrl}" style="background: #1a1a1a; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Aceptar invitación</a>
        </p>
        <p style="color: #666; font-size: 13px;">Este link vence en ${expiresInDays} días. Si no esperabas esta invitación, ignorá este mail.</p>
      </div>
    `.trim(),
  };
}

export interface PasswordResetEmailParams {
  businessDisplayName: string;
  /** Ya armada por el caller (password-reset.routes.ts) — apunta al FRONTEND, no a esta API. */
  resetUrl: string;
  expiresInHours: number;
}

export function passwordResetEmail(
  params: PasswordResetEmailParams,
): { subject: string; html: string } {
  const { businessDisplayName, resetUrl, expiresInHours } = params;

  return {
    subject: `Restablecer tu contraseña — ${businessDisplayName}`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="margin-bottom: 4px;">Restablecer tu contraseña</h2>
        <p>Alguien de <strong>${escapeHtml(businessDisplayName)}</strong> pidió un link para restablecer tu contraseña.</p>
        <p style="margin: 24px 0;">
          <a href="${resetUrl}" style="background: #1a1a1a; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Restablecer contraseña</a>
        </p>
        <p style="color: #666; font-size: 13px;">Este link vence en ${expiresInHours} horas. Si no lo pediste vos, ignorá este mail — tu contraseña actual sigue funcionando.</p>
      </div>
    `.trim(),
  };
}

/**
 * O5 / D2-C (07/09/2026, docs/diseno-order13-o5-dead-letter-2026-09-07.md,
 * bloque 4) — aviso a los usuarios con permisos de gestión de que hay eventos
 * que el sistema no pudo procesar y requieren revisión desde el panel.
 *
 * `items[].summary` viene de `describeDeadLetter()` — frases fijas sin PII
 * (A7.1). Este template NO recibe el `last_error` crudo ni el payload del
 * evento.
 */
export interface DeadLetterAlertEmailParams {
  /** Nombre del negocio — un manager puede tener membresías en varios (B2). */
  businessName: string;
  /** URL del panel (base + /dashboard) — el banner de dead-letter vive en toda página del panel. */
  dashboardUrl: string;
  /** Un ítem por evento que transicionó a dead-letter en el ciclo. */
  items: { summary: string }[];
}

export function deadLetterAlertEmail(
  params: DeadLetterAlertEmailParams,
): { subject: string; html: string } {
  const { businessName, dashboardUrl, items } = params;
  const n = items.length;
  const evento = n === 1 ? 'un evento' : `${n} eventos`;

  return {
    subject: `${businessName} — hay ${evento} sin procesar en el panel`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="margin-bottom: 4px;">El sistema no pudo procesar ${evento}</h2>
        <p>En el panel de <strong>${escapeHtml(businessName)}</strong>. Se reintentaron automáticamente y no se resolvieron solos — requieren una revisión.</p>
        <ul style="padding-left: 18px; margin: 16px 0;">
          ${items.map((it) => `<li style="margin: 6px 0;">${escapeHtml(it.summary)}</li>`).join('')}
        </ul>
        <p style="margin: 24px 0;">
          <a href="${escapeHtml(dashboardUrl)}" style="background: #1a1a1a; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Abrir el panel</a>
        </p>
        <p style="color: #666; font-size: 13px;">Este aviso se envía a los usuarios con permisos de gestión del negocio.</p>
      </div>
    `.trim(),
  };
}

/**
 * Bloque 6 del ADR común cancelar-con-NC (§6.5 bis, pregunta 2, RESUELTA
 * 15/09/2026: SLA 48hs, destinatario MANAGEMENT, escalamiento único no
 * reiterado) -- aviso a los usuarios de gestión de que hay solicitudes de
 * Nota de Crédito (`credit_note_request`) trabadas en revisión manual hace
 * más de lo esperado. `items[].summary` lo arma el worker
 * (`workers/credit-note-review-sla.worker.ts`) -- mismo criterio que
 * `deadLetterAlertEmail`: sin datos crudos de la factura ni del cliente,
 * solo el id de la solicitud, a qué orden/reserva pertenece y hace cuánto
 * está abierta (A7.1, nada de eso es PII).
 */
export interface CreditNoteReviewSlaAlertEmailParams {
  /** Nombre del negocio -- mismo motivo que en DeadLetterAlertEmailParams (B2). */
  businessName: string;
  /** URL de la bandeja de revisión (`dashboard/facturacion/...`), no del banner de outbox. */
  dashboardUrl: string;
  /** Una solicitud `credit_note_request` que cruzó el SLA en este ciclo de poll. */
  items: { summary: string }[];
}

export function creditNoteReviewSlaAlertEmail(
  params: CreditNoteReviewSlaAlertEmailParams,
): { subject: string; html: string } {
  const { businessName, dashboardUrl, items } = params;
  const n = items.length;
  const solicitud = n === 1 ? 'una solicitud de Nota de Crédito' : `${n} solicitudes de Nota de Crédito`;

  return {
    subject: `${businessName} — hay ${solicitud} esperando revisión manual`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; color: #1a1a1a;">
        <h2 style="margin-bottom: 4px;">Revisión manual pendiente</h2>
        <p>En el panel de <strong>${escapeHtml(businessName)}</strong> hay ${solicitud} que lleva más del tiempo esperado sin resolverse.</p>
        <ul style="padding-left: 18px; margin: 16px 0;">
          ${items.map((it) => `<li style="margin: 6px 0;">${escapeHtml(it.summary)}</li>`).join('')}
        </ul>
        <p style="margin: 24px 0;">
          <a href="${escapeHtml(dashboardUrl)}" style="background: #1a1a1a; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; display: inline-block;">Abrir la bandeja</a>
        </p>
        <p style="color: #666; font-size: 13px;">Este es un único aviso por solicitud -- no se repite mientras siga sin resolver. Este aviso se envía a los usuarios con permisos de gestión del negocio.</p>
      </div>
    `.trim(),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
