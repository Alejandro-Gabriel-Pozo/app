/**
 * @file order-cancel-for-credit-note.ts
 * @description Implementación de `OrderCancelPort` (definido en
 * `src/facturacion/cancel-order-with-credit-note.service.ts`) — el pedazo
 * "cancelar la ORDEN" del escape administrativo del ADR común
 * `docs/diseno-cancelacion-con-nota-credito-comun-2026-09-06.md` (sub-bloque 4).
 *
 * ## Por qué vive acá y no en el orquestador (ADR §4, F5 capa iv)
 * `TRANSICION_CANCELAR`, `transitionWithClient` y `expandStockItemsFromSnapshot`
 * son del dominio `pos-menu/`. Si el orquestador (en `src/facturacion/`) los
 * importara, cruzaría la cerca. Este archivo es el único punto donde el
 * escape toca la máquina de estados de la orden; el orquestador solo conoce
 * la interfaz `OrderCancelPort`.
 *
 * ## Qué hace, dentro de la tx2 del orquestador (mismo cuerpo que
 * `OrderService.cancelOrder()` MENOS dos cosas)
 *  1. `transitionWithClient(client, orderId, TRANSICION_CANCELAR)` — misma
 *     primitiva, misma allowlist (`DRAFT|CONFIRMED → CANCELLED`, sella
 *     `cancelled_at`).
 *  2. Fila de `audit_log` (`field='status'`, actor real = quien autorizó el
 *     escape) en la misma tx.
 *  3. Evento `order.cancelled` con el MISMO payload que la cancelación
 *     normal (`orderId`, `previousStatus`, `wasServed`, `locationId`,
 *     `items` expandidos del snapshot) — decisión del dueño + grounding
 *     ERPNext (`on_cancel` es path-independiente): el escape NO emite un
 *     evento propio, emite el de siempre.
 *
 * Lo que NO hace (a diferencia de `cancelOrder()`):
 *  - **No** llama a `findBlockingInvoiceLinkage()`: la factura viva es
 *    justamente la que la Nota de Crédito ya compensó — bloquear acá sería
 *    el bug.
 *  - **No** abre su propia `transactionManager.run()`: corre dentro de la
 *    tx2 del orquestador (la transición + el settle del `ADJUSTMENT` + el
 *    settle del CARGO son una sola unidad atómica — N1.a).
 *
 * ## Costo declarado (residual #3, se salda en el sub-bloque 5)
 * `handleOrderCancelled` → `registrarDesenlace()` va a ver un `CARGO` con
 * comprobante fiscal vinculado y lo escala a `grave` (`CARGO_CON_COMPROBANTE_VIVO`)
 * por cada escape, hasta que el sub-bloque 5 enseñe a `registrarDesenlace()`
 * a reconocer un CARGO ya compensado por NC. Registrado en
 * `docs/pendientes-2026-09-06.md`.
 */

import type { SqlClient } from '../repositories/sql.client.js';
import type { DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { AuditLogRepository } from '../repositories/audit-log.repository.js';
import type { OrderCancelPort } from '../facturacion/cancel-order-with-credit-note.service.js';
import type { IOrderRepositoryWithClient } from './order.service.js';
import { expandStockItemsFromSnapshot } from './order.service.js';
import { TRANSICION_CANCELAR, type OrderTransitionOutcome } from './order.repository.js';

export class OrderCancelForCreditNote implements OrderCancelPort {
  constructor(
    private readonly orderRepo: Pick<IOrderRepositoryWithClient, 'transitionWithClient'>,
    private readonly domainEventRepository: Pick<DomainEventRepository, 'insertWithClient'>,
    private readonly auditLogRepo: Pick<AuditLogRepository, 'recordWithClient'>,
  ) {}

  async cancelForCreditNote(
    client: SqlClient,
    orderId: string,
    changedBy: string,
  ): Promise<OrderTransitionOutcome> {
    const outcome = await this.orderRepo.transitionWithClient(client, orderId, TRANSICION_CANCELAR);
    if (outcome.resultado !== 'CAMBIO') return outcome;

    const { previa, order: updated } = outcome;
    const previousStatus = previa.status;
    const wasServed = previa.servedAt !== null;

    if (!this.auditLogRepo.recordWithClient) {
      throw new Error(
        'OrderCancelForCreditNote requiere un AuditLogRepository con recordWithClient — una cancelación sin rastro no es aceptable (A6.5).',
      );
    }
    await this.auditLogRepo.recordWithClient(client, [{
      entity: 'orders', entityId: updated.id, field: 'status',
      oldValue: previousStatus, newValue: 'CANCELLED', changedBy,
    }]);

    await this.domainEventRepository.insertWithClient(client, {
      businessId: updated.businessId,
      aggregateType: 'ORDER',
      aggregateId: updated.id,
      eventType: 'order.cancelled',
      payload: {
        orderId: updated.id,
        previousStatus,
        wasServed,
        locationId: updated.locationId,
        items: expandStockItemsFromSnapshot(previa.items),
      },
    });

    return outcome;
  }
}
