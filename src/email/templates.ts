/**
 * @file templates.ts
 * @description Plantillas de mails transaccionales. HTML armado a mano
 * (string simple) — no hace falta un motor de templates para un mail.
 *
 * Fechas formateadas con el `timezone` del negocio (`business_profile.
 * timezone`, 17/08/2026 — auditoría de hardcodes, pendientes-2026-08-17.md
 * sección F3). Antes era `America/Argentina/Buenos_Aires` fijo acá mismo;
 * ahora lo resuelve el caller (email.handlers.ts) leyendo el perfil del
 * negocio y lo pasa como parámetro. Locale de formato ('es-AR') sigue fijo
 * a propósito — es una decisión de idioma del mail, no de huso horario, y
 * no se pidió resolverla en esta ronda.
 */

export interface ReservationConfirmedEmailParams {
  customerName: string;
  businessDisplayName: string;
  resourceName: string;
  startTime: Date;
  endTime: Date;
  /** IANA (ej. America/Argentina/Buenos_Aires) — ver business_profile.timezone. */
  timezone: string;
}

export function reservationConfirmedEmail(
  params: ReservationConfirmedEmailParams,
): { subject: string; html: string } {
  const { customerName, businessDisplayName, resourceName, startTime, endTime, timezone } = params;
  const dateFormat = new Intl.DateTimeFormat('es-AR', {
    timeZone: timezone,
    dateStyle: 'full',
    timeStyle: 'short',
  });

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
            <td style="padding: 8px 0; font-weight: 600;">${dateFormat.format(startTime)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Hasta</td>
            <td style="padding: 8px 0; font-weight: 600;">${dateFormat.format(endTime)}</td>
          </tr>
        </table>
        <p style="color: #666; font-size: 13px;">Si no reconocés esta reserva, respondé este mail.</p>
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
