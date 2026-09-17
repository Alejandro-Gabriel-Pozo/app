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
 *
 * ## Header `From` — quoted-string RFC 5322 (EMAIL-FROMNAME-RFC5322-01)
 * `fromName` es texto libre (`business_profile.display_name`, sin límite de
 * charset más allá de `VARCHAR(255)`/zod `.max(255)`) interpolado en
 * `From: "<nombre>" <email>`. `formatFromDisplayName()` lo deja tal cual si
 * no tiene ningún carácter RFC 5322 "special" (caso común, sin cambio de
 * comportamiento) y lo quotea+escapa si tiene alguno — no solo los que
 * rompen el parsing de forma ruidosa (`,`/`;` — se leen como separador de
 * direcciones) sino también `(`/`)`, que abren un *comment* RFC 5322: sin
 * quotear, el texto entre paréntesis se DESCARTA del nombre visible en
 * silencio, sin ningún error que alguien reporte.
 * - **Caracteres de control (incluye CR/LF):** un quoted-string no puede
 *   contenerlos ni escapados (requerirían folding, que este formateo de una
 *   sola línea no hace) — se descartan (strip), no se rechaza el envío.
 *   Mismo criterio fail-open que el resto de este archivo: un nombre con
 *   basura de control no debe tumbar el mail de confirmación de reserva.
 *   Nota: el payload viaja como `JSON.stringify(...)` al REST API de Resend,
 *   así que un `\n` crudo ya llega JSON-escapado — el riesgo acá es
 *   parsing de dirección roto, no inyección de headers SMTP.
 * - **No-ASCII (ej. "Hotel Los Álamos"):** deliberadamente fuera de
 *   alcance — RFC 5322 es 7-bit ASCII y un nombre no-ASCII sin encoded-word
 *   (RFC 2047) no es estrictamente compliant. Funciona hoy porque Resend
 *   decodifica/acepta UTF-8 crudo en el campo `from` — dependencia del
 *   proveedor, no del spec, y ya está fijada por el test que verifica que
 *   `Hotel Los Álamos` pasa sin comillas. Agregar RFC 2047 es un ítem aparte.
 * - **`fromName` vacío o solo espacios:** no debería ser alcanzable — zod
 *   exige `.trim().min(1)` en el perfil y los 4 call sites usan
 *   `?? DEFAULT_SENDER_NAME` — pero `formatFromDisplayName()` es la última
 *   línea de defensa: un string vacío entra sin caracteres especiales y sale
 *   igual, vacío, sin comillas ni error.
 */

import { logger } from '../logger.js';
import { getResendApiKey, getResendFromEmail } from '../config/env.js';

/** Nombre de remitente por defecto cuando el negocio no cargó `display_name`. */
export const DEFAULT_SENDER_NAME = 'ZuluHub';

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

/**
 * Caracteres "special" de RFC 5322 que, sin quotear el display-name, rompen
 * el parsing del header `From` o (`(`/`)`) descartan texto en silencio —
 * ver docblock del archivo. Uso interno de este módulo, no exportado.
 */
const RFC5322_SPECIAL_CHARS = /["<>,;:\\()@[\]]/;

/** Caracteres de control (incluye CR/LF) — ver docblock: se descartan, no se rechazan. */
// eslint-disable-next-line no-control-regex -- intencional: barrido de control chars del display-name, no un bug.
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

/**
 * Formatea `fromName` para el header `From` — ver docblock del archivo
 * (EMAIL-FROMNAME-RFC5322-01). Sin caracteres especiales, lo devuelve tal
 * cual (sin comillas, caso común, sin cambio de comportamiento). Con
 * caracteres especiales, escapa `\` y `"` y lo envuelve en comillas dobles.
 */
function formatFromDisplayName(fromName: string): string {
  const stripped = fromName.replace(CONTROL_CHARS, '');
  if (!RFC5322_SPECIAL_CHARS.test(stripped)) return stripped;
  const escaped = stripped.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
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
        from: `${formatFromDisplayName(message.fromName)} <${this.fromEmail}>`,
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
    logger.warn('[EmailSender] RESEND_API_KEY/RESEND_FROM_EMAIL no configuradas -- mail NO enviado.');
  }
}

export function createEmailSender(): EmailSender {
  const apiKey = getResendApiKey();
  const fromEmail = getResendFromEmail();
  if (!apiKey || !fromEmail) return new NoopEmailSender();
  return new ResendEmailSender(apiKey, fromEmail);
}
