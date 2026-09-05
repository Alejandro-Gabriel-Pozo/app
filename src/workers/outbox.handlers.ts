/**
 * @file outbox.handlers.ts
 * @description Handlers concretos del OutboxWorker.
 *
 * ## Idempotencia
 * Cada handler es idempotente. El worker tiene garantía at-least-once:
 * un evento puede procesarse más de una vez si el proceso muere después
 * del handler pero antes de `markDispatched`.
 *
 * - `handleReservationConfirmed`: pasa `idempotencyKey = "${event.id}:CHARGE"`
 *   al repo. ON CONFLICT DO NOTHING en SQL garantiza que el CHARGE se crea
 *   una sola vez aunque el handler se ejecute N veces.
 * - `handleReservationCompleted` y `handleReservationCancelled`: idempotentes
 *   por construcción (filtran por status).
 *
 * ## Handlers registrados
 * - `reservation.confirmed`      → crea CHARGE PENDING en financial_transactions
 * - `reservation.completed`      → pasa CHARGE/ADJUSTMENT a SETTLED (por reservation_id, blanket update)
 * - `reservation.cancelled`      → pasa CHARGE/ADJUSTMENT a VOIDED (si existía)
 * - `reservation.price_adjusted` → crea ADJUSTMENT PENDING (19/08/2026, pendientes-2026-08-18.md punto I;
 *                                   monto con signo — positivo = cargo extra, negativo = nota de crédito)
 * - `order.confirmed`        → crea CHARGE PENDING (mismo mecanismo, por order_id)
 * - `order.completed`        → pasa CHARGE a SETTLED
 * - `order.cancelled`        → pasa CHARGE a VOIDED (si existía)
 */

import { randomUUID } from 'crypto';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type {
  FinancialTransactionRepository,
  PaymentInfo,
  PaymentMethod,
  EfectoDesenlace,
} from '../clientes-finanzas/financial-transaction.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { ChargeNotYetCreatedError, ChargeNeverCreatedError } from './outbox.worker.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import { logger } from '../logger.js';
import type { OutboxWorker } from './outbox.worker.js';

/**
 * Registra todos los handlers financieros en el worker.
 * Llamar una sola vez al iniciar el servidor.
 *
 * @example
 * ```ts
 * registerFinancialHandlers(worker, financialTransactionRepository);
 * worker.start();
 * ```
 */
export function registerFinancialHandlers(
  worker: OutboxWorker,
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
  transactionManager: TransactionManager,
): void {
  // Los nombres (`financial:*`) son la clave del casillero en
  // `processed_events` (28/08/2026, A10.3). Renombrar uno equivale a declarar
  // que ese handler nunca corrió: todos los eventos pendientes lo volverían a
  // ejecutar. El prefijo `financial:` evita chocar con el handler de
  // inventario, que escucha los MISMOS `order.confirmed`/`order.cancelled`.
  worker
    .on('reservation.confirmed',      handleReservationConfirmed(financialRepo, businessProfileRepo), { name: 'financial:reservation.confirmed' })
    .on('reservation.completed',      handleReservationCompleted(financialRepo),                      { name: 'financial:reservation.completed' })
    .on('reservation.cancelled',      handleReservationCancelled(financialRepo),                      { name: 'financial:reservation.cancelled' })
    .on('reservation.price_adjusted', handleReservationPriceAdjusted(financialRepo, businessProfileRepo), { name: 'financial:reservation.price_adjusted' })
    .on('order.confirmed',       handleOrderConfirmed(financialRepo, businessProfileRepo, transactionManager), { name: 'financial:order.confirmed' })
    .on('order.completed',       handleOrderCompleted(financialRepo),                      { name: 'financial:order.completed' })
    .on('order.cancelled',       handleOrderCancelled(financialRepo),                      { name: 'financial:order.cancelled' });
}

// ---------------------------------------------------------------------------
// Handlers individuales (exportados para testear en aislamiento)
// ---------------------------------------------------------------------------

/**
 * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md) —
 * antes creaba UNA CHARGE PENDING por `totalPrice`. Ahora crea dos, con
 * ciclos de vida distintos:
 *   - CHARGE(depósito) `SETTLED` directo -- `ReservationService.
 *     confirmReservation()` ya verificó que está cobrado (regla de oro,
 *     gate `DepositNotPaidError`) antes de emitir este evento, así que acá
 *     es un hecho consumado, no algo "pendiente" de settlear después.
 *   - CHARGE(saldo = totalPrice - depositAmount) `PENDING` -- mismo rol que
 *     la única CHARGE de antes: sigue flotando durante la estadía, acepta
 *     ADJUSTMENTs (confirmPriceAdjustment) y se salda en bloque recién al
 *     completar (`handleReservationCompleted`, sin cambios). Si el saldo da
 *     0 (deposit_amount === totalPrice, seña 100%) no se crea -- mismo
 *     guard que ya existía para totalPrice <= 0.
 * Dos idempotencyKeys distintas ("${event.id}:CHARGE:DEPOSIT"/
 * "${event.id}:CHARGE:BALANCE") -- un mismo evento reintentado no duplica
 * ninguna de las dos.
 */
export function handleReservationConfirmed(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId, customerId, totalPrice, depositAmount } = event.payload as {
      reservationId: string;
      customerId: string;
      totalPrice: number | undefined;
      depositAmount: number | undefined;
    };

    // Sin precio (recursos sin costo) → no hay movimiento financiero.
    if (totalPrice == null || totalPrice <= 0) return;

    const { currency } = await businessProfileRepo.get();
    // depositAmount puede faltar en eventos viejos (antes de esta fase,
    // todavía en el outbox sin procesar) -- se tratan como "sin seña", todo
    // el total va al saldo, mismo comportamiento que tenían antes.
    const deposit = depositAmount ?? 0;
    const balance = totalPrice - deposit;

    if (deposit > 0) {
      await financialRepo.create({
        id:             randomUUID(),
        businessId:     event.businessId,
        customerId,
        reservationId,
        type:           'CHARGE',
        amount:         deposit,
        currency,
        status:         'SETTLED',
        idempotencyKey: `${event.id}:CHARGE:DEPOSIT`,
      });
    }

    if (balance > 0) {
      await financialRepo.create({
        id:             randomUUID(),
        businessId:     event.businessId,
        customerId,
        reservationId,
        type:           'CHARGE',
        amount:         balance,
        currency,
        status:         'PENDING',
        idempotencyKey: `${event.id}:CHARGE:BALANCE`,
      });
    }
  };
}

export function handleReservationCompleted(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId } = event.payload as { reservationId: string };
    await financialRepo.settleByReservationId(reservationId);
  };
}

export function handleReservationCancelled(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId } = event.payload as { reservationId: string };
    const desenlace = await financialRepo.voidByReservationId(reservationId, event.businessId);
    registrarDesenlace(event, 'financial:reservation.cancelled', reservationId, desenlace);
  };
}

/**
 * Ajuste de precio de una reserva CONFIRMED (19/08/2026, pendientes-2026-
 * 08-18.md punto I) — crea el `ADJUSTMENT` correspondiente al cargo/nota
 * de crédito que un empleado confirmó a mano
 * (`ReservationService.confirmPriceAdjustment`). `amount` viaja CON SIGNO
 * en el payload (positivo = cargo extra, negativo = nota de crédito) — se
 * pasa tal cual, `getNetBalanceByX` ya suma `amount` de ADJUSTMENT sin
 * `ABS()` (schema.sql BLOQUE financial_transactions, v22). Status PENDING
 * como el CHARGE original — `handleReservationCompleted`/`Cancelled` lo
 * arrastran a SETTLED/VOIDED junto con él (`settleByReservationId`/
 * `voidByReservationId` son un UPDATE por `reservation_id`, no por id de
 * transacción puntual, así que agarran cualquier PENDING de esa reserva).
 */
export function handleReservationPriceAdjusted(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId, customerId, amount, confirmedByUserId } = event.payload as {
      reservationId: string;
      customerId: string;
      amount: number;
      confirmedByUserId?: string;
    };

    if (amount === 0) return;

    const { currency } = await businessProfileRepo.get();

    // idempotencyKey: "${eventId}:ADJUSTMENT" — mismo criterio que
    // "${eventId}:CHARGE" en handleReservationConfirmed. confirmedBy queda
    // grabado en la fila (accountability — quién autorizó este movimiento,
    // no solo que "el sistema" lo hizo).
    await financialRepo.create({
      id:             randomUUID(),
      businessId:     event.businessId,
      customerId,
      reservationId,
      type:           'ADJUSTMENT',
      amount,
      currency,
      status:         'PENDING',
      idempotencyKey: `${event.id}:ADJUSTMENT`,
      confirmedBy:    confirmedByUserId ?? null,
    });
  };
}

// ---------------------------------------------------------------------------
// Handlers de Order — cierra el gap de "Order nunca toca el ledger"
// (auditoría de deuda estructural, item #3). Mismo mecanismo que Reservation:
// CHARGE PENDING al confirmar, SETTLED al completar, VOIDED al cancelar.
// ---------------------------------------------------------------------------

/**
 * O2 (03/09/2026) — techo propio de reintentos para T-01.
 *
 * Con el poll de 5 s son ~1 min. Sin un techo propio, T-01 heredaría los 60
 * del worker: un orden de magnitud de más para una carrera de despacho que,
 * si no se resolvió en un minuto, no es una carrera sino una inconsistencia.
 */
const UMBRAL_T01 = 12;

/**
 * Registro estructurado de un desenlace que no fue el camino feliz.
 *
 * LIMITACIÓN DECLARADA: esto es un log de proceso. No es durable, ni
 * consultable, ni accionable — `processed_events` no puede representar el
 * resultado de un handler (es `(domain_event_id, handler_name)` con PK en las
 * dos, sin columna de resultado), así que desde la base un rechazo de negocio
 * es indistinguible de un éxito. La señal durable es O5.
 */
function registrarDesenlace(
  event: DomainEvent,
  proceso: string,
  // RESERVA-10 (05/09/2026) -- reusado también por handleReservationCancelled();
  // renombrado de `orderId` a `aggregateId` porque ya no es siempre una orden.
  aggregateId: string,
  desenlace: EfectoDesenlace,
): void {
  const base = {
    tenant:        event.businessId,
    aggregateId,
    proceso,
    timestamp:     new Date().toISOString(),
    correlationId: event.correlationId ?? event.eventId ?? String(event.id ?? ''),
    intento:       event.retryCount ?? 0,
  };

  if (desenlace.tipo === 'APLICADO') {
    if (desenlace.rechazos.length === 0) return;
    // Aplicó lo que correspondía y dejó algo afuera: un PAYMENT de la misma
    // orden, por ejemplo. No es una falla, pero no puede pasar en silencio.
    logger.info({ ...base, evento: 'efecto_parcial', causa: desenlace.rechazos, filas: desenlace.filas },
      '[outbox] efecto aplicado con rechazos parciales');
    return;
  }
  if (desenlace.tipo === 'NADA_QUE_HACER') {
    logger.debug({ ...base, evento: 'sin_efecto' }, '[outbox] nada que aplicar');
    return;
  }
  if (desenlace.tipo === 'DEPENDENCIA_PENDIENTE') return;  // lo maneja el caller

  // Un reintento benigno del at-least-once no abre incidente: si cada
  // redelivery normal generara uno, la bandeja se vuelve inútil.
  const soloBenigno = desenlace.rechazos.length === 1 && desenlace.rechazos[0] === 'CARGO_YA_SETTLED';
  // CARGO_CON_COMPROBANTE_VIVO (ORDER-10, 05/09/2026) es grave acá: si este
  // handler la ve, significa que `voidByOrderId()` frenó una anulación con
  // una Factura B viva -- pero la orden ya llegó a CANCELLED (este evento
  // sólo se dispara post-transición). El guard de la puerta de entrada
  // (`OrderService.cancelOrder()`) debería haberlo frenado ANTES; verlo acá
  // es evidencia de que algún otro camino llegó a CANCELLED sin pasar por
  // esa puerta.
  // RESERVA_INEXISTENTE (RESERVA-10) -- mismo criterio que ORDEN_INEXISTENTE:
  // un cargo referenciando una reserva que no existe es anomalía de
  // integridad, no una decisión de negocio normal.
  const grave = desenlace.rechazos.some((r) =>
    r === 'ORDEN_DE_OTRO_NEGOCIO' || r === 'ESTADO_DESCONOCIDO' || r === 'ORDEN_INEXISTENTE'
      || r === 'CARGO_CON_COMPROBANTE_VIVO' || r === 'RESERVA_INEXISTENTE');

  const cuerpo = { ...base, evento: 'efecto_rechazado', causa: desenlace.rechazos, reintentable: false };
  if (soloBenigno)  logger.info(cuerpo,  '[outbox] efecto ya aplicado, nada que hacer');
  else if (grave)   logger.error(cuerpo, '[outbox] efecto rechazado por anomalía de integridad');
  else              logger.warn(cuerpo,  '[outbox] efecto rechazado por estado de negocio');
}

/**
 * O2 — crea el CHARGE de una orden confirmada.
 *
 * La identidad del acto económico es el `order_id`, no el `event.id`: una
 * orden se confirma como máximo una vez, así que el acto y la orden son la
 * misma cosa. Dos eventos distintos del mismo hecho creaban dos cargos porque
 * la clave era del mensaje.
 *
 * Corre dentro de una transacción para que el lock de la fila de la orden y
 * el INSERT compartan conexión: el `NOT EXISTS` solo no es a prueba de
 * carreras.
 */
export function handleOrderConfirmed(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
  transactionManager: TransactionManager,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { orderId, customerId, totalAmount, stayId } = event.payload as {
      orderId: string;
      customerId: string;
      totalAmount: number | undefined;
      stayId?: string | null;
    };

    // Orden sin ítems con precio (ej. solo notas) → no hay movimiento financiero.
    if (totalAmount == null || totalAmount <= 0) return;

    const { currency } = await businessProfileRepo.get();

    const desenlace = await transactionManager.run((client) =>
      financialRepo.createOrderChargeIfConfirmed(client, {
        id:         randomUUID(),
        businessId: event.businessId,
        customerId,
        orderId,
        // "Cargo a la habitación" (A1, paso 4) — si la orden se asoció a una
        // Stay, el CHARGE hereda stayId para que getNetBalanceByStayId lo cuente.
        stayId:     stayId ?? null,
        amount:     totalAmount,
        currency,
      }));

    registrarDesenlace(event, 'financial:order.confirmed', orderId, desenlace);
  };
}

export function handleOrderCompleted(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { orderId, paymentMethod, cardInstallments, cardSurchargeAmount } = event.payload as {
      orderId: string;
      paymentMethod?: PaymentMethod | null;
      cardInstallments?: number | null;
      cardSurchargeAmount?: number | null;
    };
    const paymentInfo: PaymentInfo = {
      paymentMethod: paymentMethod ?? null,
      cardInstallments: cardInstallments ?? null,
      cardSurchargeAmount: cardSurchargeAmount ?? null,
    };

    const desenlace = await financialRepo.settleChargesByOrderId(orderId, event.businessId, paymentInfo);

    // T-01 (ORDER-13) — el CHARGE todavía no existe porque `order.confirmed`
    // no se procesó. `dispatch()` no relanza cuando un handler falla, así que
    // `poll()` sigue con el evento siguiente y `order.completed` puede
    // adelantarse. NO es un rechazo definitivo ni un éxito: es dependencia
    // pendiente, y es lo único que justifica reintentar.
    if (desenlace.tipo === 'DEPENDENCIA_PENDIENTE') {
      const intento = event.retryCount ?? 0;
      const detalle = { orden: orderId, intento, umbral: UMBRAL_T01,
        correlationId: event.correlationId ?? null, esperando: 'financial:order.confirmed' };

      if (intento < UMBRAL_T01) {
        // Lanza: el worker libera el casillero y reintenta al próximo ciclo.
        // No es reencolado inmediato ni sin control -- hay intervalo fijo (5 s,
        // NO backoff: espaciado creciente necesita `next_attempt_at`, que es
        // DDL) y hay tope.
        throw new ChargeNotYetCreatedError(detalle);
      }
      // Agotado el techo: ya no es una carrera. Lanza un error DISTINTO, que
      // el worker mapea a dead-letter inmediato. El evento sale de la cola (no
      // hay loop) y queda con failed_at y last_error (no hay falsa
      // resolución). La resolución operativa durable sigue siendo O5.
      throw new ChargeNeverCreatedError(detalle);
    }

    registrarDesenlace(event, 'financial:order.completed', orderId, desenlace);
  };
}

export function handleOrderCancelled(
  financialRepo: FinancialTransactionRepository,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { orderId } = event.payload as { orderId: string };
    const desenlace = await financialRepo.voidByOrderId(orderId, event.businessId);
    registrarDesenlace(event, 'financial:order.cancelled', orderId, desenlace);
  };
}
