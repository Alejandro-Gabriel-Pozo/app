/**
 * @file accounts-receivable.service.ts
 * @description Transferencia del saldo de una estadía a cuenta por cobrar
 * de una empresa (A1, paso 2 — ver docs/pendientes-2026-08-13.md).
 *
 * ## Cuándo se usa
 * StayService.checkOut() bloquea si la estadía tiene saldo pendiente
 * (paso 3, todavía no implementado). La única forma de saldar sin cobrar
 * en el momento es transferir la deuda a una empresa con pago diferido —
 * eso es lo que hace este servicio.
 *
 * ## Mecánica del ledger
 * No se reasigna el `customer_id` de los CHARGE ya existentes (violaría
 * R9 — una transacción congela el hecho que la originó). En cambio: se
 * crea un PAYMENT que salda el folio de la estadía a $0 (mismo criterio
 * que CustomerAccountService.recordPayment — se asienta SETTLED directo,
 * sin PENDING intermedio) y, en la misma transacción, la fila de
 * `accounts_receivable` que registra la deuda contra la empresa.
 */

import { randomUUID } from 'node:crypto';
import type { AccountsReceivableRepository, AccountReceivable, AccountsReceivableStatus } from './accounts-receivable.repository.js';
import type { FinancialTransactionRepository } from './financial-transaction.repository.js';
import type { StayRepository } from '../pms-estadias/stay.repository.js';
import type { CustomerRepository } from './customer.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import { DomainError, CustomerNotFoundError, ReceivableInvoiceNotIssuedError, ReceivableInvoiceReconciliationPendingError } from '../domain/errors.js';
import { StayNotFoundError } from '../pms-estadias/stay.service.js';
import { applyCappedPaymentToInvoice, createIdempotentPaymentWithClient } from './payment-application.js';
import { logger } from '../logger.js';

/**
 * `getByIdWithLock` es OPCIONAL en `ReservationRepository` (mismo criterio
 * que los orquestadores de NC, `cancel-reservation-with-credit-note.service.ts`).
 * Acá se lo exige presente -- un fake sin este método no compila contra el
 * guard de §9.1.
 */
export type ReservationRepoForTransfer = {
  getByIdWithLock: NonNullable<ReservationRepository['getByIdWithLock']>;
};

export class CompanyCustomerRequiredError extends DomainError {
  constructor(customerId: string) {
    super(
      `El cliente "${customerId}" no es una empresa (kind != 'COMPANY') — no se le puede transferir una deuda.`,
      'COMPANY_CUSTOMER_REQUIRED',
    );
  }
}

export class NoBalanceToTransferError extends DomainError {
  constructor(stayId: string) {
    super(`La estadía "${stayId}" no tiene saldo pendiente para transferir.`, 'NO_BALANCE_TO_TRANSFER');
  }
}

/**
 * Bloque 6, §9.1 (13/09/2026, gate `architecture-governor`, docs/diseno-
 * reconciliacion-city-ledger-2026-09-12.md, decisión del dueño --
 * `AskUserQuestion`, predicado fuerte). Precedente Cloudbeds: "Locked
 * transaction" -- no se puede rutear/transferir un cargo con comprobante
 * fiscal vivo encima. Rechaza `transferStayBalanceToReceivable()` si algún
 * `CHARGE` de la estadía tiene una Factura B `ISSUED` que NO está
 * compensada al 100% por NC (`classifyReservationLiveInvoice()`/
 * `classifyOrderLiveInvoice()` da `NOT_RECONCILED`) -- previene el crédito
 * fantasma de §9.2 en vez de solo exponerlo después.
 *
 * Extendido (13/09/2026, gate `architecture-governor`, decisión del dueño
 * -- `AskUserQuestion`, `CITY-LEDGER-GUARD-INVOICE-INFLIGHT-001`) para
 * cubrir también el comprobante EN VUELO -- mismo predicado que el guard
 * hermano `ReservationService.findBlockingInvoiceLinkage()`
 * (`reservas/reservation.service.ts:864-875`): `NOT_ISSUED` con
 * `status: 'PENDING'`, o `FAILED_UNCERTAIN` con `afipContacted: true`.
 * `REJECTED` nunca bloquea (acá ni en el hermano) -- AFIP ya dijo que no,
 * no hay comprobante real que proteger. El mensaje conserva el texto
 * `ISSUED` verbatim (ya shippeado, visible tal cual al staff via
 * `extractErrorMessage()` en el frontend) y agrega uno nuevo para el caso
 * en vuelo -- no lo reemplaza por uno genérico.
 */
export class StayChargeAlreadyInvoicedError extends DomainError {
  constructor(stayId: string, invoiceId: string, invoiceStatus: 'ISSUED' | 'PENDING' | 'FAILED_UNCERTAIN') {
    const message = invoiceStatus === 'ISSUED'
      ? `La estadía "${stayId}" tiene un cargo con la factura "${invoiceId}" emitida y vigente (no compensada del todo por Nota de Crédito) a nombre del huésped -- no se puede transferir el saldo a una empresa mientras ese comprobante siga vivo.`
      : `La estadía "${stayId}" tiene un cargo con la factura "${invoiceId}" en trámite (estado: ${invoiceStatus}, todavía sin confirmar con AFIP) a nombre del huésped -- no se puede transferir el saldo a una empresa hasta que AFIP confirme la emisión o el comprobante se rechace.`;
    super(message, 'STAY_CHARGE_ALREADY_INVOICED');
  }
}

/** F1-Pieza 3 (23/08/2026) — markInvoiced/markCollected sobre un id inexistente. */
export class AccountReceivableNotFoundError extends DomainError {
  constructor(id: string) {
    super(`No existe una cuenta por cobrar con id "${id}".`, 'ACCOUNT_RECEIVABLE_NOT_FOUND');
  }
}

/**
 * F1-Pieza 3 (23/08/2026) — markInvoiced/markCollected sobre una fila que no
 * está en el estado previo requerido (R12: solo avanza, nunca vuelve atrás).
 * Reusa el code 'INVALID_TRANSITION' (ya mapeado a 409 en error.middleware.ts,
 * mismo patrón que InvalidOrderTransitionError).
 */
export class InvalidAccountsReceivableTransitionError extends DomainError {
  constructor(id: string, from: AccountsReceivableStatus, to: AccountsReceivableStatus) {
    super(
      `La cuenta por cobrar "${id}" está en estado "${from}" — no se puede pasar a "${to}" directo.`,
      'INVALID_TRANSITION',
    );
  }
}

/**
 * H-A (05/09/2026) -- resultado de `markCollected()`, aditivo sobre
 * `AccountReceivable`. `collection` NO es una columna persistida -- solo
 * viaja en la respuesta HTTP cuando esta llamada detectó que la factura
 * vinculada ya estaba cubierta parcial o totalmente por el otro camino de
 * cobro (`recordPayment`). El cliente ignora campos desconocidos
 * (`appfrontend-main/src/lib/finanzas/api.ts` tipa la respuesta como
 * `AccountReceivable`), así que agregar este campo es compatible sin
 * cambios del lado del frontend.
 */
export interface AccountReceivableMarkCollectedResult extends AccountReceivable {
  collection?: {
    invoiceId: string;
    appliedAmount: number;
    excessAmount: number;
  };
}

export interface TransferStayBalanceInput {
  stayId: string;
  businessId: string;
  companyCustomerId: string;
  /** identity_id (JWT sub) del usuario MANAGEMENT que autoriza — validado por el rol en la ruta, no acá. */
  transferredBy: string;
  notes?: string | null;
}

export class AccountsReceivableService {
  constructor(
    private readonly arRepo: AccountsReceivableRepository,
    private readonly financialRepo: FinancialTransactionRepository,
    private readonly stayRepo: StayRepository,
    private readonly customerRepo: CustomerRepository,
    private readonly transactionManager: TransactionManager,
    private readonly businessProfileRepo: BusinessProfileRepository,
    /**
     * O2-F2 (03/09/2026) -- resolver a qué factura corresponde el
     * `financial_transaction_id` de una fila AR, y capar/lockear el pago
     * contra ella en `markCollected()`. `classifyReservationLiveInvoice`/
     * `classifyOrderLiveInvoice` (Bloque 6, §9.1) -- predicado fuerte del
     * guard de `transferStayBalanceToReceivable()`, ver
     * `StayChargeAlreadyInvoicedError`.
     */
    private readonly invoiceRepo: Pick<
      InvoiceRepository,
      'getOutstandingForUpdate' | 'resolveInvoiceLinkage' | 'classifyReservationLiveInvoice' | 'classifyOrderLiveInvoice'
    >,
    /** Bloque 6, §9.1 -- lock de `reservations` como primera operación de
     * la transacción, serializa contra `InvoiceService.requestInvoice()`
     * (mismo lock, `invoice.service.ts:451-453`/`:604-606`). `stays.reservation_id`
     * es `NOT NULL` (schema.sql), así que siempre hay algo que lockear. */
    private readonly reservationRepo: ReservationRepoForTransfer,
  ) {}

  /**
   * Riesgo de reconciliación -- residuo Q2 del caso 3, DECIDIDO (13/09/2026,
   * docs/pendientes-2026-09-12.md, sección "🔴 Bloqueado en una decisión del
   * dueño", bullet "Caso 3, residuo Q2"): `getNetBalanceByStayId()` ahora
   * incluye `PENDING`, así que esta transferencia puede mover un saldo que
   * todavía no es final (ej. un `ADJUSTMENT` de precio que recién liquida en
   * `reservation.completed`). Si después de transferir algo ajusta el saldo
   * de la estadía hacia abajo (o la reserva se cancela), el folio del
   * huésped puede quedar negativo mientras la empresa ya recibió el CHARGE
   * completo, `SETTLED`, por el monto viejo. Antes del fix esto NO podía
   * pasar con montos `PENDING` (la transferencia los ignoraba igual que
   * `checkOut()`) -- es un riesgo real que el fix introduce, no una
   * regresión de algo que ya funcionaba. NO bloquea esta transferencia --
   * el fix de checkOut() (Q1, sí decidido) es inseparable de este cambio de
   * comportamiento porque comparten la misma función. El guard del Bloque 6
   * (§9.1 de docs/diseno-reconciliacion-city-ledger-2026-09-12.md,
   * implementado más abajo en el cuerpo de este método vía
   * `resolveInvoiceLinkage()`/`classify*LiveInvoice()`) ya cubre el caso de
   * un `CHARGE` con factura `ISSUED` viva o en vuelo -- lo que sigue sin
   * cubrir acá es el `ADJUSTMENT` `PENDING` sin comprobante emitido
   * todavía, que es lo que este comentario describe.
   *
   * Mecanismo de reconciliación decidido: construir `reverseTransfer()` +
   * detección, diseñado en
   * `docs/diseno-reconciliacion-city-ledger-2026-09-12.md` §4.3 (servicio) y
   * §4.5. La mitad de §4.5 para `handleReservationCancelled` ya está
   * IMPLEMENTADA (Bloque 3a, 13/09/2026, `d48a6e8`) -- detección por
   * EXISTENCIA de AR no revertida (`!== 'REVERTIDO'`, `COBRADO` incluido
   * a propósito) + `logger.warn({evento: reservation_cancelled_con_ar_viva})`,
   * NO una comparación de montos. La otra mitad, `handleReservationCompleted`,
   * SIGUE SIN DISEÑAR -- detección por existencia no sirve ahí (dispararía
   * siempre en el camino feliz, ver §4.5); falta decidir si se diseña la
   * comparación de montos, se mide el falso positivo, o se declara fuera
   * de alcance. Secuenciado en §8. El schema (Bloque 1, estado `REVERTIDO`)
   * ya está implementado -- commit `b82d828`, `CURRENT_SCHEMA_VERSION = 52`
   * (`platform/tenant-db.setup.ts:445`) y CHECK de 4 valores en
   * `db/schema.sql`. `reverseTransfer()` en sí (Bloque 2) todavía NO existe
   * en este archivo -- no por falta de decisión: §7.8 del diseño (cómo
   * `listByCompany()`/`getByCompanyCustomerId()` muestran las filas
   * `REVERTIDO`) ya está decidido (§3.8, 13/09/2026, sin filtro nuevo en
   * el contrato de listado). El motivo es simplemente que el Bloque 2
   * todavía no se implementó.
   */
  async transferStayBalanceToReceivable(input: TransferStayBalanceInput): Promise<AccountReceivable> {
    const stay = await this.stayRepo.findById(input.stayId, input.businessId);
    if (!stay) throw new StayNotFoundError(input.stayId);

    const company = await this.customerRepo.getById(input.companyCustomerId);
    if (!company) throw new CustomerNotFoundError(input.companyCustomerId);
    if (company.kind !== 'COMPANY') throw new CompanyCustomerRequiredError(input.companyCustomerId);

    const balance = await this.financialRepo.getNetBalanceByStayId(input.stayId);
    if (balance <= 0) throw new NoBalanceToTransferError(input.stayId);

    // Una sola lectura para las dos filas de esta operación -- ambas
    // registran el mismo movimiento, tienen que quedar en la misma moneda.
    const { currency } = await this.businessProfileRepo.get();

    return this.transactionManager.run(async (client) => {
      // Bloque 6, §9.1 -- lock PRIMERO (serializa contra requestInvoice()
      // concurrente sobre la misma reserva), guard DESPUÉS. `stay.reservationId`
      // es NOT NULL -- toda estadía tiene una reserva de origen.
      await this.reservationRepo.getByIdWithLock(client, stay.reservationId);

      // Guard: ¿algún CHARGE de esta estadía tiene una Factura B ISSUED
      // vigente (no compensada del todo por NC), o EN VUELO (todavía sin
      // confirmar con AFIP)? Cloudbeds "Locked transaction" -- no se
      // rutea/transfiere un cargo con comprobante fiscal vivo o en trámite
      // encima.
      //
      // Rama ISSUED: `resolveInvoiceLinkage()` primero (existencia -- ISSUED
      // o no) y SOLO SI hay factura viva, `classify*LiveInvoice()`
      // (reconciliación real): los dos predicados juntos, nunca uno solo --
      // `classify*` por sí solo da `NOT_RECONCILED` también para "nunca se
      // facturó" (fail-closed documentado en su propio docblock), así que
      // usarlo sin el filtro de existencia bloquearía TODA transferencia,
      // no solo las que tienen un comprobante vivo sin conciliar.
      //
      // Rama NOT_ISSUED en vuelo (`PENDING`, o `FAILED_UNCERTAIN` con
      // `afipContacted`): NO se llama a `classify*` -- ese método pregunta
      // "¿esta Factura B YA VIVA fue compensada al 100% por NC?", y una NC
      // solo puede compensar una factura `ISSUED` (no hay nada que
      // reconciliar sobre un comprobante que ni siquiera se sabe si AFIP
      // emitió). Bloquea directo, mismo predicado que el guard hermano
      // `ReservationService.findBlockingInvoiceLinkage()`
      // (`reservas/reservation.service.ts:864-875`). `REJECTED` nunca
      // bloquea (ni acá ni en el hermano) -- AFIP ya dijo que no.
      //
      // Camino de salida de cada estado en vuelo (doctrina de la ronda 1 de
      // este mismo bloque -- nada bloquea sin salida): `PENDING` se
      // resuelve solo a `ISSUED` (vía `retryExisting()`, idempotente por
      // `invoice:<ftId>` -- una fila `PENDING` huérfana por un proceso
      // muerto se destraba reintentando la emisión, no queda huérfana para
      // siempre) o a `REJECTED` (deja de bloquear); `FAILED_UNCERTAIN` con
      // `afipContacted` se destraba con la reconciliación humana que este
      // repo ya modela para ese estado (contactar a AFIP para confirmar).
      //
      // Por qué esto NO se unifica con el guard de `markInvoiced()`/
      // `markCollected()` de este mismo archivo (que sí bloquean con
      // CUALQUIER `NOT_ISSUED`, incluido `REJECTED`): miran un SUJETO
      // distinto -- ahí es `ar.financialTransactionId` (el CHARGE contra la
      // EMPRESA que este mismo método crea más abajo), acá son los CHARGE
      // del HUÉSPED. Predicados distintos a propósito, no una
      // inconsistencia a limpiar.
      const stayCharges = (await this.financialRepo.getByStayId(input.stayId)).filter((t) => t.type === 'CHARGE');
      for (const charge of stayCharges) {
        const linkage = await this.invoiceRepo.resolveInvoiceLinkage(charge.id);

        if (linkage.kind === 'ISSUED') {
          // Cargo *solo-estadía* (sin reservationId NI orderId -- legal por
          // el CHECK `chk_financial_transactions_order_or_reservation`, "a
          // lo sumo uno", no "exactamente uno"): no hay entidad contra la
          // cual llamar classify*. Fail-closed -- no se puede verificar
          // reconciliación, se trata como comprobante vivo sin conciliar.
          const classification = charge.reservationId
            ? await this.invoiceRepo.classifyReservationLiveInvoice(client, charge.reservationId)
            : charge.orderId
              ? await this.invoiceRepo.classifyOrderLiveInvoice(client, charge.orderId)
              : 'NOT_RECONCILED' as const;
          if (classification === 'NOT_RECONCILED') {
            throw new StayChargeAlreadyInvoicedError(input.stayId, linkage.invoiceId, 'ISSUED');
          }
          continue;
        }

        if (linkage.kind === 'NOT_ISSUED' && (linkage.status === 'PENDING' || (linkage.status === 'FAILED_UNCERTAIN' && linkage.afipContacted))) {
          throw new StayChargeAlreadyInvoicedError(input.stayId, linkage.invoiceId, linkage.status);
        }
      }

      await this.financialRepo.createWithClient(client, {
        id:         randomUUID(),
        businessId: input.businessId,
        customerId: stay.customerId,
        stayId:     input.stayId,
        type:       'PAYMENT',
        amount:     balance,
        currency,
        status:     'SETTLED',
        notes:      `Transferido a cuenta por cobrar — empresa ${input.companyCustomerId}`,
      });

      // F1-Pieza 3 (23/08/2026, pendientes-2026-08-23.md) — pedido explícito
      // del dueño: la deuda tiene que aparecer en la cuenta corriente de la
      // EMPRESA (CustomerAccountService.getStatement()) desde el momento de
      // la transferencia, no recién cuando se facture — hasta ahora la
      // deuda vivía solo en `accounts_receivable`, invisible en el ledger
      // normal. `stayId` A PROPÓSITO NO va acá (a diferencia del PAYMENT de
      // arriba): `getNetBalanceByStayId()` suma por `stay_id` sin filtrar
      // por `customer_id` -- si este CHARGE llevara el mismo `stayId` que el
      // PAYMENT que acaba de saldar el folio del huésped, el saldo de la
      // ESTADÍA volvería a quedar positivo (el PAYMENT lo neutraliza, este
      // CHARGE lo reabriría) y el check-out que la transferencia recién
      // desbloqueó volvería a rechazar con StayBalanceOwedError. `reservationId`
      // (F1-Pieza 2: documento de origen obligatorio) cumple el mismo rol de
      // trazabilidad sin ese efecto colateral -- no participa en ningún
      // cálculo de saldo por estadía.
      // C1-Fase C (23/08/2026) -- el id se genera ACÁ (no se lee del
      // resultado de createWithClient) para poder guardarlo en la fila de
      // accounts_receivable de abajo sin depender del tipo de retorno
      // nullable de createWithClient (solo es null en el path idempotente,
      // que esta llamada no usa).
      const companyChargeId = randomUUID();
      await this.financialRepo.createWithClient(client, {
        id:            companyChargeId,
        businessId:    input.businessId,
        customerId:    input.companyCustomerId,
        reservationId: stay.reservationId,
        type:          'CHARGE',
        amount:        balance,
        currency,
        status:        'SETTLED',
        notes:         `Cargo por estadía transferida a cuenta por cobrar — estadía ${input.stayId}`,
      });

      return this.arRepo.createWithClient(client, {
        id:                randomUUID(),
        businessId:        input.businessId,
        stayId:            input.stayId,
        companyCustomerId: input.companyCustomerId,
        financialTransactionId: companyChargeId,
        amount:            balance,
        currency,
        status:            'PENDIENTE_FACTURAR',
        transferredBy:     input.transferredBy,
        notes:             input.notes ?? null,
      });
    });
  }

  /** Todo lo transferido a una empresa -- para el panel de gestión de cuentas por cobrar. */
  async listByCompany(companyCustomerId: string): Promise<AccountReceivable[]> {
    return this.arRepo.getByCompanyCustomerId(companyCustomerId);
  }

  /**
   * F1-Pieza 3 (23/08/2026) — PENDIENTE_FACTURAR → FACTURADO. Decisión
   * explícita del dueño: es solo un cambio de estado, NO genera ninguna
   * factura AFIP real ni toca el ledger -- la emisión de la factura contra
   * la empresa sigue siendo manual/externa (queda para C1-Fase C,
   * BillingEntity + facturación corporate consolidada, sin diseñar todavía).
   */
  async markInvoiced(id: string, invoiceRef?: string | null): Promise<AccountReceivable> {
    const ar = await this.arRepo.getById(id);
    if (!ar) throw new AccountReceivableNotFoundError(id);

    // AR-FACT-NO-ISSUED-01 (05/09/2026) -- mismo guard que markCollected(),
    // en el punto de entrada anterior: espeja el `if (issued.status === 'ISSUED')`
    // que el camino automático (InvoiceService.requestConsolidatedInvoice())
    // ya tiene, y que el camino manual era el único sin él. NONE (sin
    // factura interna en absoluto -- §5.1(b) permanente) sigue pasando.
    const linkage = ar.financialTransactionId
      ? await this.invoiceRepo.resolveInvoiceLinkage(ar.financialTransactionId)
      : ({ kind: 'NONE' } as const);
    if (linkage.kind === 'NOT_ISSUED') {
      if (linkage.status === 'FAILED_UNCERTAIN' && linkage.afipContacted) {
        throw new ReceivableInvoiceReconciliationPendingError(id, linkage.invoiceId);
      }
      throw new ReceivableInvoiceNotIssuedError(id, linkage.invoiceId, linkage.status);
    }

    const updated = await this.arRepo.markInvoiced(id, invoiceRef);
    if (!updated) throw new InvalidAccountsReceivableTransitionError(id, ar.status, 'FACTURADO');
    return updated;
  }

  /**
   * F1-Pieza 3 (23/08/2026) — FACTURADO → COBRADO. A diferencia de
   * markInvoiced, ESTE paso sí toca el ledger: crea un PAYMENT contra la
   * empresa (mismo patrón que CustomerAccountService.recordPayment, SETTLED
   * directo sin PENDING intermedio -- un cobro real ya recibido) que cierra
   * el CHARGE que `transferStayBalanceToReceivable` le había abierto. Sin
   * `stayId` ni `reservationId`: es un cobro genérico contra la cuenta de la
   * empresa, no un cargo nuevo (mismo criterio que un PAYMENT sin
   * `allocations` en CustomerAccountService.recordPayment) -- no necesita
   * documento de origen (F1-Pieza 2 no lo exige para PAYMENT/REFUND).
   *
   * O2-F2 (03/09/2026, docs/diseno-o2-f2-cierre-completo-2026-09-03.md) --
   * antes este PAYMENT no llevaba `settledInvoiceId`: la factura nunca se
   * enteraba de que la empresa ya había pagado por este camino, y un cobro
   * posterior por `CustomerAccountService.recordPayment()` la veía con
   * saldo completo y aplicaba de nuevo -- doble cobro real, reproducido
   * contra Postgres. Ahora:
   *  1. Si `ar.financialTransactionId` resuelve a una factura ISSUED
   *     (individual o consolidada, `invoiceRepo.resolveInvoiceLinkage`),
   *     el PAYMENT se capa al saldo vigente de esa factura, con el MISMO
   *     lock (`SELECT ... FOR UPDATE`, sin `OF i` desde §7.1) que usa
   *     `recordPayment()` -- serializa los
   *     dos caminos entre sí (A8.1/A8.2).
   *  2. Si no resuelve (fila legacy sin `financial_transaction_id`, o
   *     facturación manual permanente sin documento real -- ver
   *     §5.1 del diseño): fallback legacy sin cambios -- PAYMENT sin
   *     vínculo por el monto completo de `ar.amount`.
   *  3. Idempotente vía `idempotencyKey = ar-collect:${id}` -- repetir el
   *     cobro (reintento de red, o una carrera real donde otra transacción
   *     ya commiteó entre nuestra lectura y esta) no crea un segundo
   *     PAYMENT ni relanza un 409: devuelve el resultado ya aplicado.
   *
   * H-A (05/09/2026, erp-audit-orchestrator + auditor-circuitos-erp,
   * architecture-governor "Paquete B'") -- CUANDO invoiceId resuelve Y el
   * saldo real de esa factura es menor a `ar.amount`, el excedente NO se
   * acredita como PAYMENT sin asignar. Antes (hasta el commit 5856306) sí
   * se acreditaba -- eso inventaba un crédito a favor de la empresa sin
   * ningún ingreso real detrás: `ar.amount` es un monto CONGELADO del
   * momento de `transferStayBalanceToReceivable`, no una declaración de
   * caja de ESTA llamada (a diferencia del excedente de `recordPayment()`,
   * que sí es plata real que el operador tipeó -- A3.9 de
   * criterios-negocio.md, la contrapartida ahí no existe). NO se afirma
   * por qué el saldo es menor -- `getOutstandingForUpdate()` resta tanto
   * PAYMENT como REFUND (`sql.invoice.repository.ts`), así que la causa
   * puede ser `recordPayment()`, un REFUND/nota de crédito, o un desfase
   * entre `ar.amount` y la porción de una factura consolidada (ver el log
   * de más abajo, que enumera las tres). La AR pasa a COBRADO igual -- el
   * hecho de negocio (la deuda ya no está pendiente) ya ocurrió. La
   * colisión se expone en la respuesta (`collection`, aditivo, no
   * persistido -- solo viaja en la llamada que la detecta, un reintento
   * no la repite) y se deja un log estructurado -- no `domain/audit.ts`:
   * `audit_log.changed_by` es `NOT NULL` y esta operación no recibe actor
   * todavía (H-E, abierto).
   */
  async markCollected(id: string): Promise<AccountReceivableMarkCollectedResult> {
    const ar = await this.arRepo.getById(id);
    if (!ar) throw new AccountReceivableNotFoundError(id);
    if (ar.status === 'COBRADO') {
      // Idempotente -- ya se cobró (por esta misma llamada en un intento
      // anterior, o por una carrera concurrente ya resuelta). No es un
      // error de negocio: un reintento de red no debe verse como un 409.
      return ar;
    }
    if (ar.status !== 'FACTURADO') {
      throw new InvalidAccountsReceivableTransitionError(id, ar.status, 'COBRADO');
    }

    const linkage = ar.financialTransactionId
      ? await this.invoiceRepo.resolveInvoiceLinkage(ar.financialTransactionId)
      : ({ kind: 'NONE' } as const);
    // AR-FACT-NO-ISSUED-01 (05/09/2026, architecture-governor, Opción A
    // fail-closed) -- NONE sigue cayendo al fallback legacy sin cambios
    // (§5.1(b), facturación manual permanente sancionada -- ahí NO hay
    // ninguna fila `invoices`, no hay nada que bloquear). NOT_ISSUED sí
    // bloquea: hay una factura interna real que todavía no llegó a
    // ISSUED, y dejar que markCollected() capée contra el fallback legacy
    // es exactamente el vector que reabre el doble cobro que O2-F2 cerró
    // (la factura puede llegar a ISSUED después, con outstanding entero).
    // Dos códigos de error distintos a propósito -- ver docblock de cada
    // clase en domain/errors.ts: PENDING/REJECTED/FAILED_UNCERTAIN-sin-
    // contactar son reintentables sin riesgo; FAILED_UNCERTAIN CON AFIP
    // contactada no, porque el comprobante puede existir ya en AFIP.
    if (linkage.kind === 'NOT_ISSUED') {
      if (linkage.status === 'FAILED_UNCERTAIN' && linkage.afipContacted) {
        throw new ReceivableInvoiceReconciliationPendingError(id, linkage.invoiceId);
      }
      throw new ReceivableInvoiceNotIssuedError(id, linkage.invoiceId, linkage.status);
    }
    const invoiceId = linkage.kind === 'ISSUED' ? linkage.invoiceId : null;
    const idempotencyKey = `ar-collect:${id}`;
    const notes = `Cobro de cuenta por cobrar — estadía ${ar.stayId}`;
    let collection: AccountReceivableMarkCollectedResult['collection'];

    const updatedAr = await this.transactionManager.run(async (client) => {
      // O2F2-A (erp-audit-orchestrator, 03/09/2026, reproducido 2/6
      // corridas) -- el chequeo de idempotencia del fix anterior (H1)
      // corría ANTES de tomar cualquier lock: dos markCollected() GENUINAMENTE
      // concurrentes sobre la MISMA fila (dos pestañas, dos operadores, un
      // reintento en vuelo) leen `ar.status = 'FACTURADO'` los dos antes de
      // que ninguno commitee, así que ninguno ve la guarda de arriba
      // (`status === 'COBRADO'`); el chequeo de `getByIdempotencyKey` de
      // acá abajo, si corre ANTES de que el ganador de la carrera por el
      // lock de la factura haya commiteado, tampoco lo encuentra -- los dos
      // siguen adelante. El perdedor, tras esperar el lock de la factura,
      // relee outstanding=0 (fresco, correcto gracias al fix de
      // getOutstandingForUpdate) y recalcula excessAmount = ar.amount
      // COMPLETO otra vez -- crédito fantasma, con una clave
      // (`...:sin-asignar`) que el ganador nunca creó.
      //
      // Fix real: lockear la fila `accounts_receivable` PRIMERO -- es el
      // recurso que de verdad compite en esta carrera (1:1 con el
      // `idempotencyKey`, que se deriva de `id`), a diferencia del lock de
      // la factura (que sólo sirve para serializar `markCollected()` contra
      // `recordPayment()`, una carrera distinta, ya cubierta). Con la fila
      // AR lockeada, el chequeo de idempotencia que sigue ya no puede correr
      // en paralelo con el commit que lo volvería obsoleto: el perdedor
      // espera ACÁ, no en el lock de la factura, y cuando lo obtiene el
      // ganador ya commiteó de punta a punta.
      await this.arRepo.lockForUpdate(client, id);

      const existingPayment = await this.financialRepo.getByIdempotencyKey(idempotencyKey);
      if (!existingPayment) {
        if (invoiceId) {
          const { appliedAmount, excessAmount } = await applyCappedPaymentToInvoice(
            this.invoiceRepo, client, invoiceId, ar.amount,
          );
          await createIdempotentPaymentWithClient(this.financialRepo, client, {
            id: randomUUID(),
            businessId: ar.businessId,
            customerId: ar.companyCustomerId,
            type: 'PAYMENT',
            amount: appliedAmount,
            currency: ar.currency,
            status: 'SETTLED',
            idempotencyKey,
            notes,
            settledInvoiceId: invoiceId,
          });
          // H-A: NO se crea un PAYMENT por `excessAmount` -- ver docblock
          // del método. Solo se expone en la respuesta y se deja rastro
          // en el log; la fila AR pasa a COBRADO más abajo igual.
          if (excessAmount > 0) {
            collection = { invoiceId, appliedAmount, excessAmount };
            // No se afirma la causa -- getOutstandingForUpdate() resta
            // PAYMENT y REFUND del saldo, así que el excedente puede venir
            // de recordPayment(), de un REFUND/nota de crédito aplicado a
            // la misma factura, o de un desfase entre ar.amount (congelado
            // en transferStayBalanceToReceivable) y la porción que esta AR
            // representa dentro de una factura consolidada.
            logger.warn(
              {
                evento: 'cobro_ar_factura_ya_cubierta',
                accountsReceivableId: id,
                businessId: ar.businessId,
                companyCustomerId: ar.companyCustomerId,
                invoiceId,
                arAmount: ar.amount,
                appliedAmount,
                excessAmount,
                currency: ar.currency,
              },
              '[AccountsReceivableService] markCollected(): la factura vinculada ya estaba cubierta -- no se acreditó el excedente. La causa no se determinó en este punto: puede ser un cobro previo por recordPayment(), un REFUND/nota de crédito aplicado a la misma factura, o un desfase entre ar.amount y la porción que esta AR representa en la factura.',
            );
          }
        } else {
          // Fallback legacy (§5.1 del diseño) -- sin vínculo resoluble,
          // comportamiento sin cambios.
          await createIdempotentPaymentWithClient(this.financialRepo, client, {
            id: randomUUID(),
            businessId: ar.businessId,
            customerId: ar.companyCustomerId,
            type: 'PAYMENT',
            amount: ar.amount,
            currency: ar.currency,
            status: 'SETTLED',
            idempotencyKey,
            notes,
            settledInvoiceId: null,
          });
        }
      }

      const updated = await this.arRepo.markCollectedWithClient(client, id);
      if (updated) return updated;

      // La fila AR SÍ está lockeada desde el arranque de esta transacción
      // (más arriba en este mismo método, `await this.arRepo.lockForUpdate(client, id)`)
      // -- eso es lo que serializa a los
      // concurrentes entre sí. Si aun así el UPDATE no afectó filas es
      // porque otra transacción concurrente ya aplicó el MISMO PAYMENT
      // idempotente y ya commiteó COBRADO antes de que esta llegara acá --
      // no un invariante roto. El `getById` de abajo corre sobre el pool,
      // no sobre `client`, a propósito: ya no compite por el lock de la
      // fila (esta transacción está por terminar) y necesita ver el commit
      // ajeno, que bajo READ COMMITTED sólo es visible en una lectura nueva.
      const current = await this.arRepo.getById(id);
      if (current?.status === 'COBRADO') return current;
      throw new Error(
        `markCollected: la fila "${id}" quedó en un estado inesperado (${current?.status ?? 'no encontrada'}) en medio de la transacción -- no debería pasar`,
      );
    });
    return collection ? { ...updatedAr, collection } : updatedAr;
  }
}
