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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
