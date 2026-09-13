/**
 * @file customer-account.service.ts
 * @description Cuenta corriente de un cliente — envuelve el ledger ya
 * correcto de `financial-transaction.repository.ts` (creado en una sesión
 * anterior, usado hasta hoy únicamente por el outbox worker) con las dos
 * operaciones que le faltaban para ser una feature real: ver el estado de
 * cuenta y registrar un pago manual.
 *
 * ## Conciliación de pagos (I4, 23/08/2026, pendientes-2026-08-23.md —
 * verificación de auditoría externa)
 * Hasta ahora `recordPayment()` creaba un único PAYMENT sin destino — no
 * había forma de decir qué factura estaba cancelando ("Registrar Pago"
 * ciego). `allocations` en `recordPayment()` espeja el patrón que
 * `CancellationRefundService.confirmRefund()` ya usaba del lado del
 * reembolso (`reversedInvoiceId`): una fila PAYMENT por factura elegida,
 * más un resto sin asociar si el monto pagado excede lo seleccionado.
 */

import { randomUUID } from 'node:crypto';
import type { CustomerRepository } from './customer.repository.js';
import type {
  FinancialTransaction,
  FinancialTransactionRepository,
  PaymentMethod,
} from './financial-transaction.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import { CustomerNotFoundError, InvoiceNotFoundError, ValidationError } from '../domain/errors.js';
import { round2 } from '../domain/money.js';
import { applyCappedPaymentToInvoice, createIdempotentPaymentWithClient, acquireIdempotencyLock, canonicalInvoiceLockOrder } from './payment-application.js';

export interface CustomerStatement {
  customerId: string;
  balance: number;
  transactions: FinancialTransaction[];
}

/** I4 — una factura ISSUED de un cliente con saldo pendiente > 0, para el modal de conciliación de "Registrar Pago". */
export interface OutstandingInvoice {
  invoiceId: string;
  cbteTipo: number;
  cbteNro: number | null;
  impTotal: number;
  outstanding: number;
  issuedAt: Date | null;
}

export class CustomerAccountService {
  constructor(
    private readonly financialRepo: FinancialTransactionRepository,
    private readonly customerRepo: CustomerRepository,
    private readonly businessProfileRepo: BusinessProfileRepository,
    private readonly invoiceRepo: Pick<
      InvoiceRepository,
      'getById' | 'getOutstandingByCustomerId' | 'getOutstandingForUpdate'
    >,
    private readonly transactionManager: TransactionManager,
  ) {}

  /** I4 — facturas pendientes de cobro de este cliente, para el modal de conciliación. */
  async getOutstandingInvoices(customerId: string): Promise<OutstandingInvoice[]> {
    const invoices = await this.invoiceRepo.getOutstandingByCustomerId(customerId);
    return invoices.map((inv) => ({
      invoiceId: inv.id,
      cbteTipo: inv.cbteTipo,
      cbteNro: inv.cbteNro,
      impTotal: inv.impTotal,
      outstanding: inv.outstanding,
      issuedAt: inv.issuedAt,
    }));
  }

  async getStatement(customerId: string): Promise<CustomerStatement> {
    const customer = await this.customerRepo.getById(customerId);
    if (!customer) throw new CustomerNotFoundError(customerId);

    const [balance, transactions] = await Promise.all([
      this.financialRepo.getNetBalanceByCustomerId(customerId),
      this.financialRepo.getByCustomerId(customerId),
    ]);

    return { customerId, balance, transactions };
  }

  /**
   * Registra un pago manual (efectivo, transferencia, etc.) contra la
   * cuenta del cliente. Se asienta directo como SETTLED — a diferencia de
   * los CHARGE que crea el outbox al confirmar una reserva, un pago
   * recibido en mostrador no tiene un estado PENDING intermedio con sentido.
   *
   * Idempotente vía `idempotencyKey`: si el caller reintenta el mismo pago
   * (ej. timeout de red seguido de un click de "reintentar"), no se
   * duplica — se devuelve la(s) transacción(es) ya creada(s).
   *
   * `allocations` (I4, 23/08/2026) — qué factura(s) salda este pago y
   * cuánto de cada una. Sin `allocations` (u omitido): comportamiento
   * previo sin cambios, una sola fila PAYMENT sin asociar a ninguna
   * factura. Con `allocations`: una fila PAYMENT por factura elegida
   * (`settledInvoiceId`), más una fila extra sin asociar si `amount`
   * excede lo asignado — nunca al revés (asignar más de lo pagado es un
   * error de validación, no se acepta).
   *
   * Devuelve siempre un array — 1 elemento en el caso simple, N con
   * `allocations`.
   */
  async recordPayment(params: {
    customerId: string;
    businessId: string;
    amount: number;
    paymentMethod?: PaymentMethod;
    /** Cuotas de un pago con tarjeta — solo tiene efecto si paymentMethod es 'CARD' (Gap Tango #3). */
    cardInstallments?: number;
    /** Cuánto de `amount` es recargo financiero por tarjeta — solo con 'CARD'. */
    cardSurchargeAmount?: number;
    notes?: string;
    idempotencyKey?: string;
    /**
     * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md)
     * — cobro de la seña o del saldo de una reserva puntual. `null`
     * (default) = pago genérico contra la cuenta del cliente, sin asociar
     * a ninguna reserva (comportamiento sin cambios).
     */
    reservationId?: string | null;
    /**
     * `CITY-LEDGER-OVERTRANSFER-PAYMENT-001` (13/09/2026, decisión del
     * dueño con grounding ERP -- 5/5 sistemas de referencia vinculan el
     * pago a su documento en el momento de crearlo, ninguno hace fallback
     * de FK al leer el saldo). `null`/`undefined` (default) = pago sin
     * estadía asociada, comportamiento sin cambios. El caller (la ruta)
     * resuelve esto -- este servicio no importa `StayRepository` a
     * propósito (bounded context, `clientes-finanzas` no conoce
     * `pms-estadias`), mismo patrón que `reservationId` ya usa.
     */
    stayId?: string | null;
    /** I4 — conciliación: qué factura(s) salda este pago y cuánto de cada una. */
    allocations?: { invoiceId: string; amount: number }[];
  }): Promise<FinancialTransaction[]> {
    const customer = await this.customerRepo.getById(params.customerId);
    if (!customer) throw new CustomerNotFoundError(params.customerId);

    const { currency } = await this.businessProfileRepo.get();

    const allocations = params.allocations ?? [];

    if (allocations.length === 0) {
      // Residual B-1 / 3.2-b (13/09/2026) -- transaccionalizado (antes:
      // `this.financialRepo.create()` suelto por el pool, sin transacción
      // ni client). Mismo patrón que la rama `allocations` unas líneas más
      // abajo: `createIdempotentPaymentWithClient()` ya resuelve el
      // camino "amount <= 0 no crea nada" + "ON CONFLICT DO NOTHING ->
      // releer por idempotencyKey" -- no hace falta reimplementarlo acá.
      // Sin `acquireIdempotencyLock()` a propósito: esa lock existe para
      // el caso multi-escritura de la rama `allocations` (el excedente de
      // una factura depende del saldo releído DESPUÉS del insert
      // anterior, dentro de la misma llamada) -- acá hay un solo insert,
      // y el `ON CONFLICT DO NOTHING` de `createWithClient` ya serializa
      // dos llamadas concurrentes con la misma key sin necesitar un lock
      // explícito.
      // paymentMethod: si es 'CASH', createWithClient() vincula la fila
      // al turno OPEN del negocio automáticamente (ver
      // SqlFinancialTransactionRepository.insert()).
      const created = await this.transactionManager.run((client) =>
        createIdempotentPaymentWithClient(this.financialRepo, client, {
          id: randomUUID(),
          businessId: params.businessId,
          customerId: params.customerId,
          reservationId: params.reservationId ?? null,
          stayId: params.stayId ?? null,
          type: 'PAYMENT',
          amount: params.amount,
          currency,
          status: 'SETTLED',
          idempotencyKey: params.idempotencyKey ?? null,
          notes: params.notes ?? null,
          paymentMethod: params.paymentMethod ?? null,
          cardInstallments: params.cardInstallments ?? null,
          cardSurchargeAmount: params.cardSurchargeAmount ?? null,
        }),
      );

      if (created) return [created];

      // null acá significa: amount <= 0 y ninguna fila previa para esa
      // idempotencyKey (con o sin key). Gate architecture-governor
      // (13/09/2026) encontró que el comentario anterior afirmaba una
      // equivalencia falsa: `SqlFinancialTransactionRepository.insert()`
      // NO tiene guard de amount (verificado, líneas 71-203) -- el
      // `create()` viejo SÍ insertaba una fila en amount <= 0 y la
      // devolvía. Este `throw` es un cambio de comportamiento
      // deliberado, no un "como antes": impide crear un PAYMENT en cero,
      // que el propio docblock de `createIdempotentPaymentWithClient` ya
      // declara sin sentido ("una fila en cero no documenta ningún
      // movimiento real"). Hoy es inalcanzable por HTTP --
      // `RecordPaymentSchema.amount` exige `z.number().positive()`
      // (`src/api/schemas/request.schemas.ts:366`), único caller real
      // (`customers.routes.ts:920`) -- pero si algún día se llama con
      // amount <= 0 sin pasar por ese schema, ahora falla fuerte en vez
      // de crear una fila que no representa ningún movimiento.
      throw new Error('recordPayment: createIdempotentPaymentWithClient() devolvió null (amount <= 0 sin fila previa para la idempotencyKey) — no debería pasar por el schema HTTP');
    }

    // Con allocations: cada factura elegida tiene que existir, ser de este
    // cliente, y estar ISSUED -- mismo criterio de guardia multi-tenant que
    // el resto del repo (no confiar en un id que vino del cliente sin
    // verificar a quién pertenece).
    //
    // O2-F1 (03/09/2026, decisión del dueño: opción B -- truncamiento
    // controlado) -- consolidar allocations duplicadas por factura antes de
    // validar: el cliente puede mandar la misma factura dos veces en la
    // misma request (ej. el modal arma el array a mano), y procesarlas por
    // separado abriría dos locks distintos sobre la misma fila dentro de
    // la misma transacción. Orden CANÓNICO compartido (LOCK-ORDER-001,
    // 05/09/2026, `canonicalInvoiceLockOrder()`) -- mismo comparador que
    // usa `CancellationRefundService.confirmRefund()` para lockear
    // `invoices`: los dos únicos sitios que sostienen más de un lock de
    // esa tabla a la vez tienen que ordenar igual, o dos transacciones
    // concurrentes que tocan las mismas facturas pueden ABBA-deadlockear.
    const consolidatedMap = new Map<string, number>();
    for (const a of allocations) {
      consolidatedMap.set(a.invoiceId, round2((consolidatedMap.get(a.invoiceId) ?? 0) + a.amount));
    }
    const consolidatedAllocations = canonicalInvoiceLockOrder(
      [...consolidatedMap.entries()].map(([invoiceId, amount]) => ({ invoiceId, amount })),
      (a) => a.invoiceId,
    );

    const allocatedTotal = round2(consolidatedAllocations.reduce((sum, a) => sum + a.amount, 0));
    if (allocatedTotal > params.amount) {
      throw new ValidationError(
        `La suma de lo asignado a facturas (${allocatedTotal}) no puede superar el monto pagado (${params.amount})`,
      );
    }
    for (const alloc of consolidatedAllocations) {
      const invoice = await this.invoiceRepo.getById(alloc.invoiceId);
      if (!invoice) throw new InvoiceNotFoundError(alloc.invoiceId);
      if (invoice.customerId !== params.customerId) {
        throw new ValidationError(`La factura "${alloc.invoiceId}" no pertenece a este cliente`);
      }
      if (invoice.status !== 'ISSUED') {
        throw new ValidationError(`La factura "${alloc.invoiceId}" no está ISSUED (status: ${invoice.status})`);
      }
    }

    // Lo no asignado explícitamente por el caller (paga más de lo que
    // suman las allocations) es la primera parte del "sin asignar" -- la
    // segunda parte (excedente por factura ya saldada) se suma abajo,
    // dentro de la transacción, a medida que se relee el saldo real.
    const preRemainder = round2(params.amount - allocatedTotal);

    const created: FinancialTransaction[] = [];
    await this.transactionManager.run(async (client) => {
      // O2F2-B (erp-audit-orchestrator/architecture-governor, 03/09/2026) --
      // sin esto, dos recordPayment() concurrentes con la MISMA
      // idempotencyKey (reintento de red con la request original todavía
      // en vuelo) pasan el chequeo `existingAlloc` de más abajo los dos
      // antes de que ninguno commitee, y el perdedor de la carrera por el
      // lock de la factura termina acreditando un crédito sin asignar que
      // el cliente no pagó de más. Detalle completo del mecanismo:
      // payment-application.ts::acquireIdempotencyLock(). Sin
      // idempotencyKey no hay nada que correlacionar entre dos llamadas
      // (son pagos genuinamente distintos) -- no se serializan a propósito.
      if (params.idempotencyKey) {
        await acquireIdempotencyLock(client, params.idempotencyKey);
      }

      let unassigned = preRemainder;
      let first = true;

      for (const alloc of consolidatedAllocations) {
        const allocKey = params.idempotencyKey ? `${params.idempotencyKey}:${alloc.invoiceId}` : null;

        // Reintento de un intento anterior ya comprometido: esa transacción
        // ya aplicó y ya derivó su excedente -- no se vuelve a lockear la
        // factura ni a recalcular (el saldo real ya cambió desde
        // entonces, y como el commit fue atómico, si esta fila existe la
        // fila "sin asignar" de esa misma vez también existe).
        const existingAlloc = allocKey ? await this.financialRepo.getByIdempotencyKey(allocKey) : undefined;
        if (existingAlloc) {
          created.push(existingAlloc);
          first = false;
          continue;
        }

        // Saldo releído CON lock dentro de la transacción, justo antes de
        // aplicar (A8.1/A8.2): si dos pagos concurrentes llegan acá para
        // la misma factura, el segundo espera a que el primero commitee y
        // lee el saldo YA descontado -- nunca los dos aplican contra el
        // mismo saldo viejo y sobre-aplican los dos. O2-F2 (03/09/2026) --
        // extraído a payment-application.ts, compartido con
        // AccountsReceivableService.markCollected() (decisión #7 del
        // checkpoint), sin cambiar el comportamiento de acá.
        const { appliedAmount, excessAmount } = await applyCappedPaymentToInvoice(
          this.invoiceRepo, client, alloc.invoiceId, alloc.amount,
        );
        unassigned = round2(unassigned + excessAmount);

        const tx = await createIdempotentPaymentWithClient(this.financialRepo, client, {
          id: randomUUID(),
          businessId: params.businessId,
          customerId: params.customerId,
          reservationId: params.reservationId ?? null,
          stayId: params.stayId ?? null,
          type: 'PAYMENT',
          amount: appliedAmount,
          currency,
          status: 'SETTLED',
          idempotencyKey: allocKey,
          notes: params.notes ?? null,
          paymentMethod: params.paymentMethod ?? null,
          // cardInstallments/cardSurchargeAmount son del PAGO completo, no
          // por factura -- ponerlos en cada fila los contaría N veces en
          // cualquier reporte que sume esta columna. Van solo en la primera.
          cardInstallments: first ? (params.cardInstallments ?? null) : null,
          cardSurchargeAmount: first ? (params.cardSurchargeAmount ?? null) : null,
          settledInvoiceId: alloc.invoiceId,
        });
        if (tx) created.push(tx);
        first = false;
      }

      // Una única fila combinada para todo lo sin asignar (remainder de
      // entrada + excedente por factura ya saldada) -- preserva el monto
      // total recibido y queda trazable como crédito del cliente, nunca
      // se pierde ni se descarta (regla del dueño, O2-F1).
      const unassignedKey = params.idempotencyKey ? `${params.idempotencyKey}:sin-asignar` : null;
      const unassignedTx = await createIdempotentPaymentWithClient(this.financialRepo, client, {
        id: randomUUID(),
        businessId: params.businessId,
        customerId: params.customerId,
        reservationId: params.reservationId ?? null,
        stayId: params.stayId ?? null,
        type: 'PAYMENT',
        amount: unassigned,
        currency,
        status: 'SETTLED',
        idempotencyKey: unassignedKey,
        notes: params.notes ?? null,
        paymentMethod: params.paymentMethod ?? null,
        cardInstallments: first ? (params.cardInstallments ?? null) : null,
        cardSurchargeAmount: first ? (params.cardSurchargeAmount ?? null) : null,
        settledInvoiceId: null,
      });
      if (unassignedTx) created.push(unassignedTx);
    });
    return created;
  }
}
