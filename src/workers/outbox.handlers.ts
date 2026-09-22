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
 * - `reservation.completed`      → pasa CHARGE/ADJUSTMENT a SETTLED (por reservation_id, blanket
 *                                   update); City Ledger Bloque 3b (13/09/2026) además detecta y
 *                                   loguea (no bloquea, no revierte) si el saldo neto de la
 *                                   estadía no quedó en cero -- `evento:
 *                                   reservation_completed_ar_divergencia`
 * - `reservation.cancelled`      → pasa CHARGE/ADJUSTMENT a VOIDED (si existía); City Ledger
 *                                   Bloque 3a (13/09/2026) además detecta y loguea (no bloquea,
 *                                   no revierte) si la estadía tiene una AR no revertida en una
 *                                   empresa (incluye `COBRADO` a propósito) --
 *                                   `evento: reservation_cancelled_con_ar_viva`
 * - `reservation.price_adjusted` → crea ADJUSTMENT PENDING (19/08/2026, pendientes-2026-08-18.md punto I;
 *                                   monto con signo — positivo = cargo extra, negativo = nota de crédito)
 * - `order.confirmed`        → crea CHARGE PENDING (mismo mecanismo, por order_id)
 * - `order.completed`        → pasa CHARGE a SETTLED
 * - `order.cancelled`        → pasa CHARGE a VOIDED (si existía)
 */

import { randomUUID } from 'crypto';
import { round2 } from '../domain/money.js';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type {
  FinancialTransactionRepository,
  PaymentInfo,
  PaymentMethod,
  EfectoDesenlace,
  EfectoRechazo,
} from '../clientes-finanzas/financial-transaction.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { ChargeNotYetCreatedError, ChargeNeverCreatedError } from './outbox.worker.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { StayRepository } from '../pms-estadias/stay.repository.js';
import type { AccountsReceivableRepository } from '../clientes-finanzas/accounts-receivable.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { logger } from '../logger.js';
import type { OutboxWorker } from './outbox.worker.js';

/**
 * 3.3-d residual 2 (11/09/2026, gate `architecture-governor`,
 * docs/diseno-33d-residuales-2026-09-11.md §2) -- co-rechazos que NO
 * indican una anomalía cuando `voidByReservationId()`/`voidByOrderId()`
 * ya concluyeron `CARGO_CON_COMPROBANTE_VIVO` y el caller ya verificó (vía
 * `classify*LiveInvoice()`) que ese comprobante está reconciliado.
 *
 * **Esto es un allowlist POSITIVO, no un censo de todos los valores
 * posibles de `EfectoRechazo`.** Cualquier valor NO listado acá -- ya
 * exista hoy (ej. `ORDEN_SIN_CONFIRMAR`, que ni siquiera se analizó al
 * diseñar esto -- corrección del gate, ronda de cierre) o se agregue en el
 * futuro -- sigue escalando a `grave` por default: la conjunción de abajo
 * (`esComprobanteVivoConCoRechazosBenignos`) es `false` para cualquier
 * elemento fuera de este Set. Fail-closed por construcción, no por
 * exhaustividad de la lista.
 *
 * `TIPO_NO_LIQUIDABLE` -- el `UPDATE` de `voidByReservationId()`/
 * `voidByOrderId()` sólo toca filas `ft_type IN ('CHARGE','ADJUSTMENT')`
 * (`sql.financial-transaction.repository.ts:385`); `TIPO_NO_LIQUIDABLE` se
 * dispara por filas `ft_type NOT IN (...)` (`:431`) -- por construcción,
 * una fila que causa este rechazo es una fila que esta operación NUNCA
 * iba a tocar (un `PAYMENT`/`REFUND` histórico de la reserva/orden, sin
 * relación con el void en sí). No es "fallamos en anular algo": es "había
 * algo ahí que no correspondía anular".
 *
 * `CARGO_ANULADO` queda EXPLÍCITAMENTE FUERA (§2.4 del diseño, confirmado
 * por el gate): el contador que lo produce es un booleano agregado por
 * candidato-set, no un detalle por fila -- no se puede distinguir "la fila
 * anulada es la MISMA que quedó con comprobante vivo" (posible anomalía
 * real) de "son dos filas distintas" (el caso benigno de un reintento de
 * cargo fallido). Conservador hasta que el query se reescriba para
 * devolver detalle por fila -- bloque propio, no éste.
 */
const CO_RECHAZOS_BENIGNOS_SI_RECONCILIADO: ReadonlySet<EfectoRechazo> = new Set([
  'TIPO_NO_LIQUIDABLE',
]);

/**
 * `true` cuando el único rechazo "grave" presente es `CARGO_CON_COMPROBANTE_VIVO`
 * -- cualquier otro rechazo presente tiene que estar en el allowlist de
 * arriba. Reemplaza el exact-match `rechazos.length === 1 && rechazos[0] ===
 * 'CARGO_CON_COMPROBANTE_VIVO'` que usaban, por separado y a mano, los 3
 * call sites de este archivo (`handleReservationCancelled`,
 * `handleOrderCancelled`, `registrarDesenlace()`) -- los 3 tienen que usar
 * esta MISMA función: ensanchar solo uno de los 3 (ej. sólo
 * `registrarDesenlace()`) deja `comprobanteReconciliado` en `false` para
 * siempre en presencia de un co-rechazo benigno, porque el pre-check de los
 * otros 2 nunca llega a llamar `classify*LiveInvoice()`.
 */
function esComprobanteVivoConCoRechazosBenignos(rechazos: readonly EfectoRechazo[]): boolean {
  return rechazos.includes('CARGO_CON_COMPROBANTE_VIVO')
    && rechazos.every((r) => r === 'CARGO_CON_COMPROBANTE_VIVO' || CO_RECHAZOS_BENIGNOS_SI_RECONCILIADO.has(r));
}

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
  // ADR común cancelar-con-NC sub-bloque 5 (b) -- `handleOrderCancelled` los
  // usa para clasificar el `CARGO_CON_COMPROBANTE_VIVO` post-escape. `db` es
  // el SqlClient del tenant (mismo que construye `invoiceRepo` en el registry).
  // Bloque 3.3-d (09/09/2026) -- `handleReservationCancelled` reusa el MISMO
  // `invoiceRepo`/`db`, sólo necesita el método hermano.
  invoiceRepo: Pick<InvoiceRepository, 'classifyOrderLiveInvoice' | 'classifyReservationLiveInvoice'>,
  db: SqlClient,
  // STAY-ADJUSTMENT-PRICE-001 (11/09/2026, gate `architecture-governor`) --
  // `handleReservationPriceAdjusted` lo usa para heredar `stay_id` desde la
  // Stay vigente de la reserva. `Pick` mínimo, mismo criterio que
  // `invoiceRepo` arriba. Bloque 3a de City Ledger (13/09/2026) lo reusa
  // en `handleReservationCancelled`, mismo `Pick`.
  stayRepo: Pick<StayRepository, 'findByReservation'>,
  // City Ledger Bloque 3a (13/09/2026, gate `architecture-governor`,
  // §4.5 de docs/diseno-reconciliacion-city-ledger-2026-09-12.md) --
  // detección de AR viva en `handleReservationCancelled`. `db` de tenant
  // (DEFENSIVE_DEVELOPING §3): `accounts_receivable` vive en
  // `src/db/schema.sql`, no en `platform.schema.sql`.
  accountsReceivableRepo: Pick<AccountsReceivableRepository, 'getByStayId'>,
): void {
  // Los nombres (`financial:*`) son la clave del casillero en
  // `processed_events` (28/08/2026, A10.3). Renombrar uno equivale a declarar
  // que ese handler nunca corrió: todos los eventos pendientes lo volverían a
  // ejecutar. El prefijo `financial:` evita chocar con el handler de
  // inventario, que escucha los MISMOS `order.confirmed`/`order.cancelled`.
  worker
    .on('reservation.confirmed',      handleReservationConfirmed(financialRepo, businessProfileRepo), { name: 'financial:reservation.confirmed' })
    .on('reservation.completed',      handleReservationCompleted(financialRepo, stayRepo, accountsReceivableRepo), { name: 'financial:reservation.completed' })
    .on('reservation.cancelled',      handleReservationCancelled(financialRepo, invoiceRepo, db, stayRepo, accountsReceivableRepo), { name: 'financial:reservation.cancelled' })
    .on('reservation.price_adjusted', handleReservationPriceAdjusted(financialRepo, businessProfileRepo, stayRepo), { name: 'financial:reservation.price_adjusted' })
    .on('order.confirmed',       handleOrderConfirmed(financialRepo, businessProfileRepo, transactionManager), { name: 'financial:order.confirmed' })
    .on('order.completed',       handleOrderCompleted(financialRepo),                      { name: 'financial:order.completed' })
    .on('order.cancelled',       handleOrderCancelled(financialRepo, invoiceRepo, db),     { name: 'financial:order.cancelled' });
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
  // City Ledger Bloque 3b (13/09/2026, gate `architecture-governor`, §4.6
  // de docs/diseno-reconciliacion-city-ledger-2026-09-12.md) -- detección
  // de divergencia de MONTO (no existencia, ver §4.6 para por qué
  // existencia no sirve acá) en el saldo de la estadía. Mismo `Pick` que
  // `handleReservationCancelled` reusa de `handleReservationPriceAdjusted`,
  // requeridos, no opcionales -- mismo criterio que Bloque 3a.
  stayRepo: Pick<StayRepository, 'findByReservation'>,
  accountsReceivableRepo: Pick<AccountsReceivableRepository, 'getByStayId'>,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId } = event.payload as { reservationId: string };
    await financialRepo.settleByReservationId(reservationId);

    // City Ledger Bloque 3b (§4.6) -- el invariante nace en
    // `transferStayBalanceToReceivable()` (`accounts-receivable.service.ts`,
    // cita por firma, no por línea -- mismo criterio que `17b54f5`), no en
    // `settleByReservationId()` de arriba (ese solo cambia
    // `status`, `getNetBalanceByStayId()` ya suma `PENDING`+`SETTLED` por
    // igual -- correr esto DESPUÉS es disciplina de orden -- el trabajo
    // real primero, la detección después, fail-open -- no parte del
    // cálculo). "0 exacto" es relativo al saldo que esa transferencia
    // leyó, no una garantía transaccional dura (§4.6 documenta por qué).
    //
    // Causas reales que mueven el saldo después de una transferencia:
    // un `ADJUSTMENT` de precio nuevo (`confirmPriceAdjustment()`), un
    // cargo nuevo a la habitación (`handleOrderConfirmed`), un `CHARGE`
    // de `approveScheduleChange()`, un `ADJUSTMENT` del escape de NC de
    // una orden de la estadía. Un `REFUND` real: ningún productor le
    // setea `stay_id` AL CREARLO, pero `linkStayToReservationCharges()`
    // (`sql.financial-transaction.repository.ts`) adopta cualquier fila
    // huérfana de la reserva sin filtrar por `type` -- incluido `REFUND`
    // -- y desde `CITY-LEDGER-OVERTRANSFER-PAYMENT-001` corre también al
    // momento de la transferencia, no solo en `checkIn()`. Un `REFUND`
    // adoptado suma en `getNetBalanceByStayId()`, así que puede mover
    // este saldo igual que un `CHARGE`. Positivo = la estadía quedó con
    // un cargo (o un `REFUND` adoptado) sin compensar; negativo = un
    // `ADJUSTMENT` de crédito posterior a la
    // transferencia, **o** (desde `CITY-LEDGER-OVERTRANSFER-PAYMENT-001`,
    // 13/09/2026) un pago del huésped posterior a la transferencia --
    // `recordPayment()` YA SETEA `stay_id` cuando la estadía está
    // `CHECKED_IN` al momento del pago, así que un sobrepago DEJÓ de ser
    // estructuralmente invisible para este cálculo. Sigue habiendo un
    // caso donde el pago no se vincula (estadía no `CHECKED_IN` al pagar
    // -- ver FP más abajo), así que "negativo" no distingue las dos
    // causas por sí solo.
    //
    // Falsos positivos DECLARADOS, no resueltos acá (§4.6): un pago
    // posterior a la transferencia hecho cuando la estadía NO estaba
    // `CHECKED_IN` (ej. ya hizo check-out) no se vincula, mismo hueco
    // que antes pero acotado a ese caso; una estadía cerrada con
    // `overridePendingBalance` ya revisada por un humano. Por eso el
    // mensaje describe LO MEDIDO, nunca afirma una causa como hecho
    // cierto. Fail-open, mismo criterio que Bloque 3a: el trabajo real
    // (el settle de arriba) ya commiteó -- una falla acá no puede
    // propagar y mandar a reintento algo que ya se completó.
    try {
      const stay = await stayRepo.findByReservation(reservationId, event.businessId);
      if (stay) {
        const arsEnRiesgo = (await accountsReceivableRepo.getByStayId(stay.id))
          .filter((ar) => (ar.status as string) !== 'REVERTIDO');
        if (arsEnRiesgo.length > 0) {
          const balance = round2(await financialRepo.getNetBalanceByStayId(stay.id));
          if (balance !== 0) {
            logger.warn(
              {
                evento: 'reservation_completed_ar_divergencia',
                tenant: event.businessId,
                reservationId,
                stayId: stay.id,
                balance,
                accountsReceivable: arsEnRiesgo.map((ar) => ({
                  accountsReceivableId: ar.id,
                  companyCustomerId: ar.companyCustomerId,
                  status: ar.status,
                  amount: ar.amount,
                })),
              },
              '[outbox] la estadía no quedó en saldo cero al completar la reserva -- puede ser un ajuste de precio posterior a la transferencia, un cargo nuevo a la habitación, una nota de crédito sobre una orden de la estadía, o un pago del huésped posterior a la transferencia',
            );
          }
        }
      }
    } catch (err) {
      logger.warn(
        {
          evento: 'reservation_completed_ar_deteccion_fallida',
          tenant: event.businessId,
          reservationId,
          err: err instanceof Error ? err.message : String(err),
        },
        '[outbox] detección de divergencia de AR post-completado falló -- la reserva ya se completó, esto solo afecta la visibilidad',
      );
    }
  };
}

export function handleReservationCancelled(
  financialRepo: FinancialTransactionRepository,
  // Bloque 3.3-d (09/09/2026, gate `architecture-governor`) -- espejo de
  // `handleOrderCancelled` de más abajo, para clasificar el
  // `CARGO_CON_COMPROBANTE_VIVO` post-escape de reservas
  // (`cancelReservationWithCreditNote()`, 3.3-b1/b2). `db` es el `SqlClient`
  // del tenant (lo cablea `outbox.registry.ts`); lectura sin lock (ver el
  // docblock de `classifyReservationLiveInvoice`).
  invoiceRepo: Pick<InvoiceRepository, 'classifyReservationLiveInvoice'>,
  db: SqlClient,
  // City Ledger Bloque 3a (13/09/2026, gate `architecture-governor`,
  // §4.5 bullet 1 de docs/diseno-reconciliacion-city-ledger-2026-09-12.md)
  // -- detección de AR viva colgada de la estadía de esta reserva. NO
  // opcionales: el precedente del escape de NC (`accountsReceivableRepo`
  // ahí sí es opcional) dejaría el detector apagado en silencio si algún
  // caller nuevo se olvida del wiring -- acá no hay ese caller alternativo
  // todavía, así que no hace falta la puerta de escape.
  stayRepo: Pick<StayRepository, 'findByReservation'>,
  accountsReceivableRepo: Pick<AccountsReceivableRepository, 'getByStayId'>,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { reservationId } = event.payload as { reservationId: string };
    const desenlace = await financialRepo.voidByReservationId(reservationId, event.businessId);

    // 3.3-d residual 2 (11/09/2026) -- allowlist de co-rechazos benignos,
    // ya no exact-match. Antes: una reserva con un `PAYMENT` propio
    // (`recordPayment()`, algo que NO puede pasarle a una orden) producía
    // `['TIPO_NO_LIQUIDABLE', 'CARGO_CON_COMPROBANTE_VIVO']` -- 2 rechazos,
    // la rama exact-match no disparaba, seguía `grave` aunque el
    // comprobante estuviera reconciliado. `esComprobanteVivoConCoRechazosBenignos()`
    // (ver docblock al inicio del archivo) cubre ese caso sin abrir la
    // puerta a cualquier combinación.
    let comprobanteReconciliado = false;
    if (
      desenlace.tipo === 'RECHAZADO'
      && esComprobanteVivoConCoRechazosBenignos(desenlace.rechazos)
    ) {
      try {
        comprobanteReconciliado =
          (await invoiceRepo.classifyReservationLiveInvoice(db, reservationId)) === 'RECONCILED';
      } catch (err) {
        // Fail-closed: si la clasificación falla (error técnico), NO se
        // degrada -- queda `grave`. El ruido de log es más barato que una
        // anomalía de integridad silenciada.
        comprobanteReconciliado = false;
        logger.warn(
          { tenant: event.businessId, reservationId, err: err instanceof Error ? err.message : String(err) },
          '[outbox] classifyReservationLiveInvoice falló -- se mantiene grave',
        );
      }
    }

    registrarDesenlace(event, 'financial:reservation.cancelled', reservationId, desenlace, { comprobanteReconciliado });

    // City Ledger Bloque 3a (13/09/2026, gate `architecture-governor`,
    // §4.5 bullet 1) -- si la estadía de esta reserva ya se transfirió a
    // una empresa (`transferStayBalanceToReceivable()`), `voidByReservationId()`
    // arriba anula el `CHARGE`/`ADJUSTMENT` de la RESERVA, pero la fila
    // `accounts_receivable` de la EMPRESA no se toca -- puede quedar
    // cobrándole a la empresa una deuda que el ledger del huésped ya
    // anuló (§1.2 del diseño). Detección por EXISTENCIA de AR no-terminal,
    // NO por comparación de montos (eso queda para cuando se diseñe el
    // lado `handleReservationCompleted`, ver docblock de
    // `transferStayBalanceToReceivable()`). Filtro `!== 'REVERTIDO'`
    // (cast a `string`, mismo criterio que evita `ROLES-CATALOG-DRIFT-001`
    // -- corrección 14/09/2026, Bloque 3c-ii, gate `architecture-governor`:
    // `AccountsReceivableStatus` YA declara `REVERTIDO` desde ese commit
    // -- el cast queda a propósito de todos modos, sin angostar: §7.2 del
    // diseño reserva su propio gate para tocar este archivo, angostarlo
    // acá sería un efecto colateral de un commit que no lo revisó) e
    // INTENCIONALMENTE incluye `COBRADO`: una empresa que YA PAGÓ un
    // cargo que el ledger acaba de anular es el caso más grave, no el más
    // benigno -- corrige la ambigüedad de "estados no-terminales" del
    // texto original de §4.5 (`COBRADO` es terminal en el flujo normal,
    // pero no acá). NO bloquea el handler, NO revierte nada -- la
    // decisión sigue siendo del operador (mismo principio que
    // `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md`: la
    // app no decide por el negocio, solo se lo muestra). Puede duplicar
    // en el log el `nc_escape_con_ar_viva` síncrono de
    // `cancelReservationWithCreditNote()` (`0f2aa24`) cuando la
    // cancelación vino por ese camino -- declarado, no corregido acá: dos
    // señales del mismo incidente por dos caminos distintos (uno síncrono
    // en el servicio, uno asíncrono en el outbox) no es el mismo bug que
    // "nunca se detecta".
    // Envuelto en try/catch a propósito: `voidByReservationId()` y
    // `registrarDesenlace()` de arriba YA COMMITEARON -- el trabajo real
    // de este handler terminó. Una falla acá (timeout de conexión, etc.)
    // es un problema de la LECTURA de detección, no de la cancelación en
    // sí; dejarla propagar tiraría el evento entero a reintento/dead-letter
    // por algo que no es la cancelación, violando "NO bloquea el handler"
    // (§4.5). Fail-open: se loguea el fallo y el handler completa igual --
    // distinto del fail-closed de `classifyReservationLiveInvoice` de más
    // arriba, que sí protege una decisión real (grave vs. reconciliado).
    try {
      const stay = await stayRepo.findByReservation(reservationId, event.businessId);
      if (stay) {
        const arsEnRiesgo = (await accountsReceivableRepo.getByStayId(stay.id))
          .filter((ar) => (ar.status as string) !== 'REVERTIDO');
        if (arsEnRiesgo.length > 0) {
          logger.warn(
            {
              evento: 'reservation_cancelled_con_ar_viva',
              tenant: event.businessId,
              reservationId,
              stayId: stay.id,
              accountsReceivable: arsEnRiesgo.map((ar) => ({
                accountsReceivableId: ar.id,
                companyCustomerId: ar.companyCustomerId,
                status: ar.status,
                amount: ar.amount,
              })),
            },
            '[outbox] reserva cancelada con cuenta por cobrar viva en la empresa -- revisar si el cargo de la empresa quedó desalineado con el ledger del huésped',
          );
        }
      }
    } catch (err) {
      // `evento` propio, distinto de `reservation_cancelled_con_ar_viva` --
      // sin esto, "no hay AR viva" y "el detector tiró y nunca miramos"
      // quedan indistinguibles para quien busca por nombre de evento.
      logger.warn(
        {
          evento: 'reservation_cancelled_ar_deteccion_fallida',
          tenant: event.businessId,
          reservationId,
          err: err instanceof Error ? err.message : String(err),
        },
        '[outbox] detección de AR viva post-cancelación falló -- la cancelación ya se completó, esto solo afecta la visibilidad',
      );
    }
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
 * transacción puntual, así que agarran cualquier PENDING de esa reserva
 * — **con una excepción, agregada 22/09/2026, Opción A/BLQ-29:**
 * `voidByReservationId` (no `settleByReservationId`, que no cambia) deja
 * afuera cualquier `ADJUSTMENT` con `reversed_invoice_id` no nulo — el
 * de este ajuste de precio nunca lo tiene, así que no le afecta; el que sí
 * queda excluido es el `ADJUSTMENT` del escape fiscal con Nota de Crédito
 * (`cancel-reservation-with-credit-note.service.ts`), ver el docblock de
 * `voidByReservationId` para el detalle completo).
 *
 * ## `stayId` (STAY-ADJUSTMENT-PRICE-001, 11/09/2026, gate `architecture-governor`)
 * Se resuelve ACÁ, en el momento del INSERT -- no desde el payload del
 * evento (a diferencia de `handleOrderConfirmed`, que sí lo toma del
 * payload porque `orders.stay_id` es una columna del propio agregado).
 * `ReservationService` no tiene ese campo: la única fuente es preguntarle
 * al `StayRepository` la Stay vigente de la reserva, y hacerlo en el
 * momento del INSERT (no al emitir el evento) cierra la ventana de carrera
 * check-in-entre-emisión-y-dispatch en los dos órdenes posibles -- si el
 * handler corre ANTES del check-in, esta fila queda con `stay_id` NULL y
 * `StayService.checkIn()` la adopta después vía
 * `linkStayToReservationCharges()` (mismo mecanismo que ya cubre el CHARGE
 * original, `financial_transaction.repository.ts`); si corre DESPUÉS
 * (huésped ya adentro), `linkStayToReservationCharges()` ya corrió una
 * sola vez en el pasado y nunca vuelve a adoptar nada -- por eso hace
 * falta resolverlo acá.
 *
 * Mismo patrón ya usado en `StayService.approveScheduleChange()`
 * (`stay.service.ts`, `stayId: stay?.id ?? null`) para el mismo problema
 * general ("movimiento financiero de una reserva creado en un momento
 * arbitrario"): sin Stay, `stayId: null` sin error (no hay estadía que
 * inflar/desinflar, y queda adoptable después); con una Stay CHECKED_OUT
 * o NO_SHOW, se atribuye igual (no diverge de ese precedente -- cambiar
 * esa regla es una decisión de producto que afecta a los dos sitios, no
 * a éste). `findByReservation()` devuelve una sola fila (o ninguna) por
 * `LIMIT 1` -- no hay conjunto del que pueda salir un valor "mixto", así
 * que no aplica ningún guard tipo `CreditNoteMixedStayError`.
 */
export function handleReservationPriceAdjusted(
  financialRepo: FinancialTransactionRepository,
  businessProfileRepo: BusinessProfileRepository,
  stayRepo: Pick<StayRepository, 'findByReservation'>,
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
    const stay = await stayRepo.findByReservation(reservationId, event.businessId);

    // idempotencyKey: "${eventId}:ADJUSTMENT" — mismo criterio que
    // "${eventId}:CHARGE" en handleReservationConfirmed. confirmedBy queda
    // grabado en la fila (accountability — quién autorizó este movimiento,
    // no solo que "el sistema" lo hizo).
    await financialRepo.create({
      id:             randomUUID(),
      businessId:     event.businessId,
      customerId,
      reservationId,
      stayId:         stay?.id ?? null,
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
  // ADR común cancelar-con-NC sub-bloque 5 (b) -- SOLO lo pasa
  // `handleOrderCancelled`, tras clasificar con
  // `InvoiceRepository.classifyOrderLiveInvoice()`. `true` = el
  // `CARGO_CON_COMPROBANTE_VIVO` que `voidByOrderId()` concluyó
  // (conclusión CORRECTA, queda intacta en `causa`) es el estado esperado
  // de un escape reconciliado: NC `ISSUED` que compensa del todo la Factura B
  // Y filas revertidoras `SETTLED`. Los otros 3 callers no lo pasan ->
  // comportamiento idéntico al previo.
  opts?: { comprobanteReconciliado?: boolean },
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

  // ADR común cancelar-con-NC sub-bloque 5 (b) -- el ÚNICO rechazo es
  // `CARGO_CON_COMPROBANTE_VIVO` y el caller ya verificó (via
  // `classifyOrderLiveInvoice`) que la Factura B viva está TOTALMENTE
  // compensada por NC `ISSUED` y las filas revertidoras están `SETTLED`.
  // `voidByOrderId()` concluyó bien -- no anular el par CHARGE/ADJUSTMENT
  // SETTLED es LO CORRECTO (doctrina grondeada contra ERPNext/Odoo,
  // af2b2b5: los dos asientos quedan en pie neteados, la reversión de GL
  // sólo ocurre al cancelar la factura misma). Lo único que cambia es la
  // severidad: esto NO es una anomalía de integridad, es el estado esperado
  // de un escape reconciliado. El hecho crudo queda en `causa`, con
  // `reconciliado: true` al lado -- forense sin perder la conclusión real.
  if (
    opts?.comprobanteReconciliado
    && esComprobanteVivoConCoRechazosBenignos(desenlace.rechazos)
  ) {
    logger.info(
      { ...base, evento: 'efecto_rechazado', causa: desenlace.rechazos, reintentable: false, reconciliado: true },
      '[outbox] cargo con comprobante vivo, reconciliado por Nota de Crédito -- sin acción',
    );
    return;
  }

  // Un reintento benigno del at-least-once no abre incidente: si cada
  // redelivery normal generara uno, la bandeja se vuelve inútil.
  const soloBenigno = desenlace.rechazos.length === 1 && desenlace.rechazos[0] === 'CARGO_YA_SETTLED';
  // CARGO_CON_COMPROBANTE_VIVO (ORDER-10, 05/09/2026) es grave acá: si este
  // handler la ve, significa que `voidByOrderId()` frenó una anulación con
  // una Factura B viva -- pero la orden ya llegó a CANCELLED (este evento
  // sólo se dispara post-transición). El guard de la puerta de entrada
  // (`OrderService.cancelOrder()`) debería haberlo frenado ANTES; verlo acá
  // es evidencia de que algún otro camino llegó a CANCELLED sin pasar por
  // esa puerta -- SALVO el escape `cancelOrderWithCreditNote()` (sub-bloque 4),
  // que bypassa ese guard a propósito y cuya reconciliación cubre la rama
  // `opts.comprobanteReconciliado` de arriba. Una TERCERA puerta desconocida
  // que llegue a CANCELLED sin emitir su NC completa NO pasa por esa rama
  // (`classifyOrderLiveInvoice` da `NOT_RECONCILED`) -> sigue `grave`.
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
  // ADR común cancelar-con-NC sub-bloque 5 (b) -- para clasificar el
  // `CARGO_CON_COMPROBANTE_VIVO` post-escape. `db` es el SqlClient del
  // tenant (lo cablea outbox.registry.ts); lectura sin lock (ver el docblock
  // de `classifyOrderLiveInvoice`).
  invoiceRepo: Pick<InvoiceRepository, 'classifyOrderLiveInvoice'>,
  db: SqlClient,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { orderId } = event.payload as { orderId: string };
    const desenlace = await financialRepo.voidByOrderId(orderId, event.businessId);

    // 3.3-d residual 2 (11/09/2026) -- allowlist de co-rechazos benignos,
    // ya no exact-match. Con cualquier rechazo FUERA del allowlist
    // (`ORDEN_INEXISTENTE`, `ESTADO_DESCONOCIDO`, ...) no se consulta la
    // clasificación y `registrarDesenlace` lo trata como siempre. Para el
    // 99% de las cancelaciones (sin factura viva) `voidByOrderId` devuelve
    // `APLICADO`/`NADA_QUE_HACER` y esto ni corre.
    let comprobanteReconciliado = false;
    if (
      desenlace.tipo === 'RECHAZADO'
      && esComprobanteVivoConCoRechazosBenignos(desenlace.rechazos)
    ) {
      try {
        comprobanteReconciliado =
          (await invoiceRepo.classifyOrderLiveInvoice(db, orderId)) === 'RECONCILED';
      } catch (err) {
        // Fail-closed: si la clasificación falla (error técnico), NO se
        // degrada -- queda `grave`. El ruido de log es más barato que una
        // anomalía de integridad silenciada.
        comprobanteReconciliado = false;
        logger.warn(
          { tenant: event.businessId, orderId, err: err instanceof Error ? err.message : String(err) },
          '[outbox] classifyOrderLiveInvoice falló -- se mantiene grave',
        );
      }
    }

    registrarDesenlace(event, 'financial:order.cancelled', orderId, desenlace, { comprobanteReconciliado });
  };
}
