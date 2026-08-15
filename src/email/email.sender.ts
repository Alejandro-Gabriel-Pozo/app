/**
 * @file email.sender.ts
 * @description Envío de mails transaccionales (punto 5/E5,
 * pendientes-2026-08-15.md) — hoy solo confirmación de reserva.
 *
 * ## Remitente: infraestructura de la plataforma, no del tenant (A2.9)
 * Un dominio de envío verificado (SPF/DKIM) por cada negocio no es
 * realista — la mayoría no tiene dominio propio. `RESEND_FROM_EMAIL` es
 * infraestructura técnica de ZuluHub, fija. Lo que SÍ es config por
 * tenant es el nombre para mostrar (`fromName`, viene de
 * `business_profile.display_name`) y el reply-to (`contact_email`) — así
 * un cliente ve "Hotel Los Álamos <notificaciones@zuluhub.com.ar>" y, si
 * responde, le llega al negocio real, no a la plataforma.
 *
 * ## Sin credenciales todavía → NoopEmailSender
 * `createEmailSender()` no explota si `RESEND_API_KEY`/`RESEND_FROM_EMAIL`
 * no están seteadas — usa un sender que solo loguea (mismo criterio
 * fail-open que el aprovisionamiento de Neon: sin credenciales, el
 * negocio queda operativo, solo sin esta feature puntual).
 *
 * ## Por qué Resend
 * API REST simple (un solo `fetch`, sin SDK) — mismo criterio que el JWT
 * hecho a mano con `node:crypto`: minimizar dependencias donde el
 * protocolo es simple. `EmailSender` es la interfaz — cambiar de
 * proveedor es un adapter nuevo, no un rewrite.
 *
 * ## Idempotencia — límite conocido, no resuelto
 * A diferencia de `stock_movements`/`financial_transactions`, este envío
 * NO tiene protección contra reintento at-least-once del OutboxWorker: si
 * OTRO handler del mismo evento falla (ej. el financiero) y el evento se
 * reintenta, este handler vuelve a correr y el mail se reenvía. Riesgo
 * aceptado a propósito por ahora — el peor caso es un mail de confirmación
 * duplicado, no una pérdida de dinero/stock. Si se vuelve un problema real,
 * la solución es la misma que ya usa `stock_movements`: una tabla de
 * envíos con índice único por (aggregateId, eventType).
 */

export interface EmailMessage {
  to: string;
  /** Nombre para mostrar en el remitente — el del negocio, o un default de plataforma. */
  fromName: string;
  /** Reply-to — si no se carga, las respuestas van a la casilla de la plataforma (config de Resend). */
  replyTo?: string;
  subject: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    /** Dirección verificada en Resend — infraestructura fija, no por tenant. */
    private readonly fromEmail: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${message.fromName} <${this.fromEmail}>`,
        to: [message.to],
        ...(message.replyTo && { reply_to: message.replyTo }),
        subject: message.subject,
        html: message.html,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[ResendEmailSender] Resend respondió ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}

/** Sin credenciales configuradas — loguea y no falla (fail-open, ver docblock). */
export class NoopEmailSender implements EmailSender {
  async send(message: EmailMessage): Promise<void> {
    // A7.1 (criterios-negocio.md): nunca PII en logs -- ni `message.to` (email
    // del cliente) ni el asunto (puede llevar el nombre del negocio/cliente).
    void message;
    console.warn(
      '[EmailSender] RESEND_API_KEY/RESEND_FROM_EMAIL no configuradas -- mail NO enviado.',
    );
  }
}

export function createEmailSender(): EmailSender {
  const apiKey = process.env.RESEND_API_KEY;
  const fromEmail = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !fromEmail) return new NoopEmailSender();
  return new ResendEmailSender(apiKey, fromEmail);
}
