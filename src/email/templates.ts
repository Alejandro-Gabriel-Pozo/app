/**
 * @file templates.ts
 * @description Plantillas de mails transaccionales. HTML armado a mano
 * (string simple) — no hace falta un motor de templates para un mail.
 *
 * Fechas en `America/Argentina/Buenos_Aires` fijo — toda la plataforma es
 * hoy Argentina-only (A4.7, criterios-negocio.md). El día que haya
 * tenants en otro huso, esto necesita el `timezone` por negocio que A4.2
 * ya pide y todavía no está modelado — no es un problema nuevo de este
 * archivo.
 */

const DATE_FORMAT = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  dateStyle: 'full',
  timeStyle: 'short',
});

export interface ReservationConfirmedEmailParams {
  customerName: string;
  businessDisplayName: string;
  resourceName: string;
  startTime: Date;
  endTime: Date;
}

export function reservationConfirmedEmail(
  params: ReservationConfirmedEmailParams,
): { subject: string; html: string } {
  const { customerName, businessDisplayName, resourceName, startTime, endTime } = params;

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
            <td style="padding: 8px 0; font-weight: 600;">${DATE_FORMAT.format(startTime)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; color: #666;">Hasta</td>
            <td style="padding: 8px 0; font-weight: 600;">${DATE_FORMAT.format(endTime)}</td>
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
