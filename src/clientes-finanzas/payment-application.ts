/**
 * @file payment-application.ts
 * @description O2-F2 (03/09/2026, decisión #7 del checkpoint
 * `docs/continuidad-o2-f2-facturas-consolidadas-2026-09-03.md`) — primitiva
 * financiera compartida entre `CustomerAccountService.recordPayment()`
 * (camino de conciliación manual, O2-F1) y `AccountsReceivableService.markCollected()`
 * (camino de cobro corporativo, O2-F2). Ninguno de los dos servicios llama al
 * otro service-a-service -- rompería el criterio de bounded context de este
 * repo (`app-main/CLAUDE.md`, "Bounded contexts"). Esta primitiva no tiene
 * estado propio, recibe el `client` transaccional ya abierto por el caller
 * (mismo patrón que `domain/audit.ts::updateWithAudit()`).
 *
 * Extraída de `CustomerAccountService` sin cambiar su comportamiento
 * observable -- ver los tests de O2-F1 (unit + integración Postgres real)
 * corridos después de este refactor.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { FinancialTransaction, FinancialTransactionRepository } from './financial-transaction.repository.js';
import { round2 } from '../domain/money.js';

/**
 * O2F2-B (erp-audit-orchestrator/architecture-governor, 03/09/2026) --
 * advisory lock de Postgres sobre el hash de una clave de idempotencia.
 * Serializa TODAS las llamadas concurrentes que comparten la misma clave
 * (un reintento de transporte con la request original todavía en vuelo),
 * sin necesitar una fila física que representar "esta operación" --
 * a diferencia de `AccountsReceivableService.markCollected()`
 * (`AccountsReceivableRepository.lockForUpdate()`), acá la clave la provee
 * el caller y puede cubrir N escrituras (N allocations de
 * `CustomerAccountService.recordPayment()`), así que no hay una sola fila
 * 1:1 para lockear.
 *
 * Tiene que ser la PRIMERA operación dentro de la transacción del caller,
 * antes de cualquier chequeo de idempotencia -- si corre después, dos
 * llamadas genuinamente concurrentes pueden pasar el chequeo las dos antes
 * de que ninguna commitee.
 *
 * `_xact`: el lock se libera solo al COMMIT/ROLLBACK, nunca hace falta un
 * unlock explícito. `hashtext()` devuelve un entero de 32 bits -- dos
 * claves distintas pueden colisionar y compartir el mismo lock; el único
 * efecto es serialización de más entre operaciones no relacionadas, nunca
 * una incorrección. Alcance del advisory lock: por base de datos -- como
 * este repo usa una BD por negocio (`req.db`), el espacio de claves ya
 * queda aislado por tenant sin ningún trabajo extra acá.
 */
export async function acquireIdempotencyLock(client: SqlClient, idempotencyKey: string): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [idempotencyKey]);
}

export interface CappedPaymentApplication {
  invoiceId: string;
  requestedAmount: number;
  appliedAmount: number;
  excessAmount: number;
}

/**
 * Relee el saldo de la factura CON `FOR UPDATE` (sin `OF i` desde §7.1) dentro de la
 * transacción del caller (A8.1/A8.2 -- serializa dos aplicaciones
 * concurrentes contra la misma factura, el segundo espera al primero y lee
 * el saldo YA descontado) y capa `requestedAmount` a ese saldo. El
 * excedente se preserva siempre -- nunca se pierde ni se rechaza el pago
 * completo (regla del dueño, O2-F1, reaplicada acá).
 */
export async function applyCappedPaymentToInvoice(
  invoiceRepo: Pick<InvoiceRepository, 'getOutstandingForUpdate'>,
  client: SqlClient,
  invoiceId: string,
  requestedAmount: number,
): Promise<CappedPaymentApplication> {
  const outstanding = await invoiceRepo.getOutstandingForUpdate(client, invoiceId);
  const appliedAmount = round2(Math.min(requestedAmount, Math.max(outstanding, 0)));
  const excessAmount = round2(requestedAmount - appliedAmount);
  return { invoiceId, requestedAmount, appliedAmount, excessAmount };
}

export interface CappedRefundApplication {
  invoiceId: string;
  requestedAmount: number;
  appliedAmount: number;
  unallocatedAmount: number;
}

/**
 * BRECHA-REFUND-01 Fase 3 (05/09/2026, architecture-governor) --
 * NO es `applyCappedPaymentToInvoice()` con el signo dado vuelta. Un
 * reembolso no capa contra `outstanding` (que ya resta los REFUND -- daría
 * siempre 0 contra las facturas que un reembolso ataca). Capa contra
 * `getRefundableForUpdate()` -- ver su docblock en `invoice.repository.ts`
 * para los dos invariantes (plata que entró, valor del comprobante).
 * `unallocatedAmount` es el resto sin factura que cubrir -- espejo de
 * `excessAmount`, mismo criterio: nunca se pierde, queda como chunk
 * ledger-only (decisión del dueño, confirmada para reembolsos: Q-A, nunca
 * más de lo cobrado -- por eso acá "lo que sobra" es remanente del reparto
 * entre varias facturas, no un monto que exceda lo cobrado en total, ya
 * capado antes de entrar a este reparto).
 */
export async function applyCappedRefundToInvoice(
  invoiceRepo: Pick<InvoiceRepository, 'getRefundableForUpdate'>,
  client: SqlClient,
  invoiceId: string,
  requestedAmount: number,
): Promise<CappedRefundApplication> {
  const refundable = await invoiceRepo.getRefundableForUpdate(client, invoiceId);
  const appliedAmount = round2(Math.min(requestedAmount, Math.max(refundable, 0)));
  const unallocatedAmount = round2(requestedAmount - appliedAmount);
  return { invoiceId, requestedAmount, appliedAmount, unallocatedAmount };
}

/**
 * Crea una fila `PAYMENT` (u otro tipo) dentro de la transacción del
 * caller, o devuelve la fila ya existente si el mismo `idempotencyKey` ya
 * se usó en un intento anterior que sí llegó a commitear (reintento de red
 * tras un éxito, o carrera concurrente resuelta por el `ON CONFLICT DO
 * NOTHING` de `createWithClient`). `amount <= 0` sin fila previa no crea
 * nada -- una fila en cero no documenta ningún movimiento real, y sin
 * `idempotencyKey` no hay forma de saber si "ya existe".
 */
export async function createIdempotentPaymentWithClient(
  financialRepo: Pick<FinancialTransactionRepository, 'createWithClient' | 'getByIdempotencyKey'>,
  client: SqlClient,
  tx: Omit<FinancialTransaction, 'createdAt'>,
): Promise<FinancialTransaction | null> {
  if (tx.idempotencyKey) {
    const existing = await financialRepo.getByIdempotencyKey(tx.idempotencyKey);
    if (existing) return existing;
  }
  if (tx.amount <= 0) return null;
  const createdTx = await financialRepo.createWithClient(client, tx);
  if (createdTx) return createdTx;
  // ON CONFLICT DO NOTHING -- otro intento concurrente con el mismo
  // idempotencyKey ganó la carrera entre el chequeo de arriba y este
  // insert; la fila real es la suya.
  const existing = tx.idempotencyKey ? await financialRepo.getByIdempotencyKey(tx.idempotencyKey) : undefined;
  if (!existing) {
    throw new Error('createIdempotentPaymentWithClient: createWithClient() devolvió null sin idempotencyKey -- no debería pasar');
  }
  return existing;
}
