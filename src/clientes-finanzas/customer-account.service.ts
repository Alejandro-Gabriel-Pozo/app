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
import type { SqlClient } from '../repositories/sql.client.js';
import { CustomerNotFoundError, InvoiceNotFoundError, ValidationError } from '../domain/errors.js';
import { round2 } from '../domain/money.js';

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
    /** I4 — conciliación: qué factura(s) salda este pago y cuánto de cada una. */
    allocations?: { invoiceId: string; amount: number }[];
  }): Promise<FinancialTransaction[]> {
    const customer = await this.customerRepo.getById(params.customerId);
    if (!customer) throw new CustomerNotFoundError(params.customerId);

    const { currency } = await this.businessProfileRepo.get();

    const allocations = params.allocations ?? [];

    if (allocations.length === 0) {
      // Comportamiento previo, sin cambios -- un único PAYMENT sin destino.
      // paymentMethod: si es 'CASH', create() vincula la fila al turno OPEN
      // del negocio automáticamente (ver SqlFinancialTransactionRepository.insert()).
      const created = await this.financialRepo.create({
        id: randomUUID(),
        businessId: params.businessId,
        customerId: params.customerId,
        reservationId: params.reservationId ?? null,
        type: 'PAYMENT',
        amount: params.amount,
        currency,
        status: 'SETTLED',
        idempotencyKey: params.idempotencyKey ?? null,
        notes: params.notes ?? null,
        paymentMethod: params.paymentMethod ?? null,
        cardInstallments: params.cardInstallments ?? null,
        cardSurchargeAmount: params.cardSurchargeAmount ?? null,
      });

      if (created) return [created];

      // create() devolvió null: la idempotencyKey ya existía — no es un
      // error, es el mismo pago de un reintento. Se devuelve la fila real.
      const existing = params.idempotencyKey
        ? await this.financialRepo.getByIdempotencyKey(params.idempotencyKey)
        : undefined;
      if (!existing) {
        throw new Error('recordPayment: create() devolvió null sin idempotencyKey — no debería pasar');
      }
      return [existing];
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
    // la misma transacción. Orden estable por id -- mismo criterio que
    // `ResourceRepository.lockByIds()` -- para que dos pagos concurrentes
    // que tocan las mismas facturas las bloqueen siempre en el mismo orden
    // y ninguno espere en deadlock.
    const consolidatedMap = new Map<string, number>();
    for (const a of allocations) {
      consolidatedMap.set(a.invoiceId, round2((consolidatedMap.get(a.invoiceId) ?? 0) + a.amount));
    }
    const consolidatedAllocations = [...consolidatedMap.entries()]
      .map(([invoiceId, amount]) => ({ invoiceId, amount }))
      .sort((a, b) => a.invoiceId.localeCompare(b.invoiceId));

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
        // mismo saldo viejo y sobre-aplican los dos.
        const outstanding = await this.invoiceRepo.getOutstandingForUpdate(client, alloc.invoiceId);
        const applied = round2(Math.min(alloc.amount, Math.max(outstanding, 0)));
        const excess = round2(alloc.amount - applied);
        unassigned = round2(unassigned + excess);

        const tx = await this.createPaymentChunkWithClient(client, {
          id: randomUUID(),
          businessId: params.businessId,
          customerId: params.customerId,
          reservationId: params.reservationId ?? null,
          type: 'PAYMENT',
          amount: applied,
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
      const unassignedTx = await this.createPaymentChunkWithClient(client, {
        id: randomUUID(),
        businessId: params.businessId,
        customerId: params.customerId,
        reservationId: params.reservationId ?? null,
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

  /**
   * O2-F1 (03/09/2026) -- crea una fila PAYMENT dentro de la transacción de
   * `recordPayment()`, o devuelve la fila ya existente si el mismo
   * `idempotencyKey` ya se usó en un intento anterior que sí llegó a
   * commitear (reintento de red tras un éxito). `amount <= 0` sin fila
   * previa no crea nada -- una fila en cero no documenta ningún movimiento
   * real, y sin `idempotencyKey` no hay forma de saber si "ya existe".
   */
  private async createPaymentChunkWithClient(
    client: SqlClient,
    tx: Omit<FinancialTransaction, 'createdAt'>,
  ): Promise<FinancialTransaction | null> {
    if (tx.idempotencyKey) {
      const existing = await this.financialRepo.getByIdempotencyKey(tx.idempotencyKey);
      if (existing) return existing;
    }
    if (tx.amount <= 0) return null;
    const createdTx = await this.financialRepo.createWithClient(client, tx);
    if (createdTx) return createdTx;
    // ON CONFLICT DO NOTHING -- otro intento concurrente con el mismo
    // idempotencyKey ganó la carrera entre el chequeo de arriba y este
    // insert; la fila real es la suya.
    const existing = tx.idempotencyKey ? await this.financialRepo.getByIdempotencyKey(tx.idempotencyKey) : undefined;
    if (!existing) {
      throw new Error('createPaymentChunkWithClient: createWithClient() devolvió null sin idempotencyKey -- no debería pasar');
    }
    return existing;
  }
}
