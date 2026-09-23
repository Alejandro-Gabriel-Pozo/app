/**
 * @file invoice-pending-expiry.worker.ts
 * @description Bloque 4 del ADR `docs/diseno-invoice-retry-reverse-window-guard-
 * 2026-09-23.md` (23/09/2026, hallazgo `ISSUE-BEFORE-REVERSE-WINDOW-001`,
 * §3.3/§3.4/§6) -- libera facturas `PENDING` cuyo `pending_since` venció sin
 * resolverse (ni `ISSUED`, ni `REJECTED`, ni `FAILED_UNCERTAIN`). Cierra la
 * ventana retry-vs-reverse: mueve la factura a `FAILED_UNCERTAIN` (con
 * `afip_contacted: true` -- A8.6, se sabe que la marca "en vuelo" quedó
 * colgada, pero no si AFIP terminó procesando el pedido) y, si la factura
 * tiene una `credit_note_request` propia (`tx.type === 'ADJUSTMENT'`, la
 * escala a `EN_REVISION_MANUAL` (vía `transitionCreditNoteRequestAfterFailure()`,
 * `credit-note-request-failure-transition.ts` -- el MISMO método que
 * `InvoiceService.issue()`/`reconcileAfterFailure()` ya usan) EN LA MISMA
 * TRANSACCIÓN que el `UPDATE` de la factura -- condición de test OBLIGATORIA
 * del gate `architecture-governor` (ADR §6, "Bloque 4", condición (i) del
 * veredicto de ronda 10): P-2 (Bloque 3, §3.9) depende de esta garantía de
 * atomicidad para ser sólido sin invertir el orden de locks -- si el worker
 * pudiera dejar una factura `FAILED_UNCERTAIN` ambigua con su
 * `credit_note_request` todavía `PENDIENTE`, el guard de P-2 podría no ver
 * esa `PENDIENTE` a tiempo, reabriendo el 500 genérico que P-2 existe para
 * cerrar. Ver `src/tests/integration/invoice-pending-expiry-worker.integration.test.ts`
 * para el test de rollback forzado que lo prueba contra Postgres real, no
 * solo asumido del diseño.
 *
 * Mismo patrón `setInterval` + `poll()` que `OutboxWorker`/
 * `ReservationHoldExpiryWorker` (su precedente más cercano) -- sin cola de
 * eventos: lee directo `invoices` vía `InvoiceRepository.getPendingExpiredInvoiceIds()`.
 *
 * Cada factura vencida se procesa en su PROPIA transacción -- si una falla
 * (ej. `credit_note_request` en un estado inesperado que
 * `transitionCreditNoteRequestAfterFailure()` no tolera), no bloquea a las
 * demás del mismo ciclo (mismo criterio que
 * `ReservationHoldExpiryWorker.expireOne()`). El `UPDATE` de
 * `expirePendingWithClient()` re-evalúa `status = 'PENDING' AND
 * pending_since < NOW() - N` DENTRO de la transacción -- no compara contra
 * un valor leído afuera (ver su docblock, `invoice.repository.ts`) -- así
 * que una carrera entre el poll y ese `UPDATE` (un reintento humano que se
 * adelantó, u otro ciclo del worker) se salta sola, sin condición de
 * carrera.
 *
 * **DEFENSIVE_DEVELOPING.md §3 (multi-tenant) -- este worker corre POR
 * TENANT, nunca contra un pool compartido.** Mismo wiring que
 * `OutboxWorker`/`ReservationHoldExpiryWorker`: instanciado en
 * `outbox.registry.ts::ensureTenantWorker()`, con el `InvoiceRepository` y
 * el `CreditNoteRequestRepository` construidos sobre `req.db` (el
 * `SqlClient` DEL TENANT que el caller ya resolvió), y el
 * `TransactionManager` sobre `rawPool` (el pool crudo DEL TENANT) -- nunca
 * `getPlatformRawPool()`. Un worker por tenant activo, igual que sus dos
 * hermanos.
 */

import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { CreditNoteRequestRepoForFailureTransition } from '../facturacion/credit-note-request-failure-transition.js';
import { transitionCreditNoteRequestAfterFailure } from '../facturacion/credit-note-request-failure-transition.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { logger } from '../logger.js';

export class InvoicePendingExpiryWorker {
  private intervalId: ReturnType<typeof setInterval> | undefined = undefined;
  private polling = false;

  constructor(
    private readonly businessId: string,
    private readonly invoiceRepository: Pick<InvoiceRepository, 'getPendingExpiredInvoiceIds' | 'expirePendingWithClient'>,
    private readonly creditNoteRequestRepository: CreditNoteRequestRepoForFailureTransition,
    private readonly transactionManager: TransactionManager,
    private readonly thresholdMs: number,
    private readonly pollIntervalMs = 60_000,
  ) {}

  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => void this.poll(), this.pollIntervalMs);
    logger.info(
      { businessId: this.businessId, pollIntervalMs: this.pollIntervalMs, thresholdMs: this.thresholdMs },
      '[InvoicePendingExpiryWorker] Iniciado',
    );
  }

  async stop(): Promise<void> {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const candidateIds = await this.invoiceRepository.getPendingExpiredInvoiceIds(this.thresholdMs);
      for (const invoiceId of candidateIds) {
        try {
          await this.expireOne(invoiceId);
        } catch (err) {
          logger.error({ err, invoiceId, businessId: this.businessId }, '[InvoicePendingExpiryWorker] Error venciendo factura PENDING');
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private async expireOne(invoiceId: string): Promise<void> {
    await this.transactionManager.run(async (client: SqlClient) => {
      const expired = await this.invoiceRepository.expirePendingWithClient(client, invoiceId, this.thresholdMs);
      // `null` -- otra transacción ya la sacó de PENDING entre el poll y
      // acá (un reintento humano, u otro ciclo de este mismo worker que
      // corrió en paralelo contra otro tenant no aplica -- esto es
      // POR TENANT, pero un poll solapado del MISMO worker si un ciclo
      // tarda más que pollIntervalMs sí podría, ver ReservationHoldExpiryWorker
      // para el mismo razonamiento): no hay nada más que hacer con esta
      // fila en este ciclo, se salta sin error.
      if (!expired) return;

      // Bloque 4 (§3.9 del ADR) -- transitionCreditNoteRequestAfterFailure()
      // ya es un no-op si la factura no tiene credit_note_request propia
      // (camino CHARGE/REFUND-sin-NC) -- no hace falta consultar tx.type
      // acá, mismo criterio que issue()/reconcileAfterFailure() en
      // invoice.service.ts (ninguno de los 3 call-sites automáticos
      // chequea el tipo antes de llamar). DENTRO de la MISMA transacción
      // que el UPDATE de arriba -- condición de test obligatoria (ADR §6,
      // condición (i)).
      await transitionCreditNoteRequestAfterFailure(
        this.creditNoteRequestRepository,
        client,
        expired.id,
        { toState: 'EN_REVISION_MANUAL' },
      );

      logger.info(
        { invoiceId: expired.id, financialTransactionId: expired.financialTransactionId, businessId: this.businessId },
        '[InvoicePendingExpiryWorker] Factura PENDING vencida -> FAILED_UNCERTAIN',
      );
    });
  }
}
