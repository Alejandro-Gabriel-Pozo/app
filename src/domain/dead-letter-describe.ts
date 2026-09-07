/**
 * @file dead-letter-describe.ts
 * @description ORDER-13 / O5 (07/09/2026,
 * docs/diseno-order13-o5-dead-letter-2026-09-07.md) — traduce la categoría
 * técnica de un evento en dead-letter a una frase de negocio y a un tipo de
 * acción para la UI.
 *
 * Se DERIVA en tiempo de display de `(eventType, lastError)` — NUNCA se
 * persiste (A7.1 / D4-c: `last_error` guarda solo la categoría, el mensaje
 * crudo de AFIP/PG puede traer PII del cliente). Función pura, sin deps de
 * runtime — vive en `domain/` porque la consumen dos direcciones ya
 * sancionadas: `api/routes/system.routes.ts` (enriquece
 * `GET /api/system/outbox/dead-letter`) y, más adelante, el lado worker (bloque
 * 4, email). El frontend no re-deriva.
 *
 * La clase transitorio/permanente/other de un SQLSTATE sale de
 * `outbox-error-class.ts` — misma fuente de verdad que `OutboxWorker.classifyError`.
 * Odoo hace lo análogo: convierte el fallo crudo en un mensaje titulado
 * (`account_move_send.py:_format_error_html`, `:366-375`).
 */

import { classifyPgSqlState } from './outbox-error-class.js';

export type DeadLetterActionKind = 'retryable' | 'needs_manual_action';

export interface DeadLetterDescription {
  /** Frase legible por alguien sin perfil técnico. Templates fijos, sin PII. */
  summary: string;
  /**
   * `needs_manual_action`: "Reintentar" es un no-op garantizado — la UI debe
   * ofrecer otra acción (link al agregado), no el botón genérico. Odoo siempre
   * empareja "no puedo auto-arreglar" con una acción distinta de retry
   * (rescue session, ajuste de inventario).
   */
  kind: DeadLetterActionKind;
}

/** Nombre legible de cada tipo de evento — default: el tipo entre comillas. */
const EVENT_LABEL: Record<string, string> = {
  'order.completed': 'el cobro de una orden completada',
  'order.confirmed': 'la confirmación de una orden',
  'order.cancelled': 'la cancelación de una orden',
  'reservation.confirmed': 'la confirmación de una reserva',
  'reservation.completed': 'el cobro de una reserva completada',
  'reservation.cancelled': 'la cancelación de una reserva',
  'reservation.expired': 'el vencimiento de una reserva',
  'customer.created': 'el alta de un cliente',
};

function label(eventType: string): string {
  return EVENT_LABEL[eventType] ?? `«${eventType}»`;
}

export function describeDeadLetter(input: {
  eventType: string;
  lastError: string | null;
}): DeadLetterDescription {
  const ev = label(input.eventType);
  const cat = input.lastError ?? '';

  // Categorías de negocio conocidas (nombre de clase de error).
  if (cat === 'ChargeNeverCreatedError') {
    return {
      summary:
        'La orden se completó pero no se le generó el cargo. El cliente no debe nada por esta ' +
        'orden; hace falta crear el cargo a mano o cerrar la orden. Reintentar no lo resuelve.',
      kind: 'needs_manual_action',
    };
  }
  if (cat === 'UnsupportedEventVersionError') {
    return {
      summary:
        `Llegó un evento (${ev}) de una versión que esta instalación no entiende. ` +
        'Requiere una actualización del sistema, no un reintento.',
      kind: 'needs_manual_action',
    };
  }

  // Códigos Postgres — la clase sale de la MISMA fuente que el worker.
  if (cat.startsWith('PG_')) {
    const pgClass = classifyPgSqlState(cat.slice(3));
    if (pgClass === 'permanent') {
      return {
        summary:
          `Conflicto de datos al procesar ${ev}. Reintentar no lo va a resolver solo — ` +
          'hace falta revisar el caso.',
        kind: 'needs_manual_action',
      };
    }
    if (pgClass === 'transient') {
      return {
        summary:
          `Falla temporal de base de datos al procesar ${ev}. ` +
          'Reintentá; si vuelve a pasar, avisá a soporte.',
        kind: 'retryable',
      };
    }
    // 'other' (sintaxis, objeto inexistente, dato inválido…) -> NO es "falla
    // temporal": reintentar no lo va a arreglar, pero tampoco es un conflicto
    // de datos del negocio. Genérico, sin prometer que el reintento sirve.
  }

  return {
    summary: `Error al procesar ${ev}${cat ? ` (${cat})` : ''}. Requiere revisión.`,
    kind: 'needs_manual_action',
  };
}
