/**
 * @file inventory.handlers.ts
 * @description Handlers de inventario del OutboxWorker — primer caso real
 * del patrón "Inventario recibe eventos de venta y recalcula stock"
 * (docs/arquitectura-monolito-modular.md sección 3). Separado de
 * outbox.handlers.ts (financiero) a propósito — mismo espíritu que la
 * sección 4 de ese doc, aunque no se reorganizó `src/` por dominio todavía.
 *
 * ## Disparador: order.confirmed, no order.completed
 * El stock baja cuando el pedido se compromete a vender esos ítems
 * (DRAFT -> CONFIRMED, ej. se manda a cocina), no cuando se cobra
 * (CONFIRMED -> COMPLETED) — entre confirmar y cobrar el producto ya se
 * está usando.
 *
 * ## Reserva de dos pasos (D1, 15/08/2026 — criterios-negocio.md A8.7/A8.8)
 * OrderService.confirmOrder() ya no solo valida: RESERVA stock atómicamente
 * (reserved_quantity) dentro de su propia transacción, antes de emitir el
 * evento. Este handler ya no decrementa stock desde cero — CONSOLIDA la
 * reserva que confirmOrder() ya tomó (stock_quantity y reserved_quantity
 * bajan juntos, ProductService.commitReservedStock). Si la reserva no
 * alcanza acá (0 filas en la UPDATE), es una inconsistencia real — no un
 * chequeo de negocio esperable — y el evento queda sin despachar (dead-
 * letter tras maxRetries, ver A9.5/outbox.worker.ts).
 *
 * ## Orden entre order.confirmed y order.cancelled del MISMO agregado
 * El OutboxWorker pide los eventos ordenados por id ASC, pero NO garantiza
 * que uno termine de procesarse antes de que el siguiente empiece a
 * intentarse — un order.confirmed trabado reintentando (o ya en
 * dead-letter) no bloquea que order.cancelled de la misma orden se
 * despache antes. Sin coordinación, eso podía dejar la reserva liberada
 * dos veces, o consolidada después de haber sido liberada. Se resuelve sin
 * tocar el worker: OUT (consolidación) y RESERVATION_RELEASED (liberación
 * sin consolidar) compiten por el MISMO casillero en stock_movements
 * (índice único parcial por order_item_id, schema.sql BLOQUE 13) — el que
 * llega primero gana, el que pierde ve el conflicto (createWithClient
 * devuelve false) y no vuelve a tocar stock. Mismo patrón insert-then-act
 * de siempre, aplicado una vez más.
 *
 * ## Orden canónico de locks (deadlock)
 * canonicalStockItemOrder() ordena los ítems de una orden por
 * (variantId ?? productId) antes de reservar/consolidar/liberar — mismo
 * criterio en OrderService.confirmOrder() y acá, para que dos transacciones
 * concurrentes que tocan los mismos productos siempre pidan los locks en el
 * mismo orden global.
 *
 * ## Idempotencia
 * Insert-then-act: primero se intenta insertar la fila en stock_movements.
 * Si la fila NO se insertó (ya existía — reintento del at-least-once, o
 * perdió la carrera del casillero compartido), NO se vuelve a tocar stock.
 */

import { randomUUID } from 'crypto';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { StockMovementRepository } from '../repositories/stock-movement.repository.js';
import type { ProductService } from '../services/product.service.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { OutboxWorker } from './outbox.worker.js';

const SYSTEM_ACTOR = 'system:outbox';

/**
 * Subconjunto de OrderItem relevante para stock — viaja en el payload de
 * order.confirmed/order.cancelled (A10.2, payload autocontenido).
 */
export interface StockItemSnapshot {
  orderItemId: string;
  productId: string;
  productVariantId: string | null;
  quantity: number;
}

/**
 * Orden canónico por (variantId ?? productId) — evita deadlock entre
 * transacciones concurrentes que tocan los mismos productos en distinto
 * orden (confirmOrder(), este handler, y el resto de la reserva de dos
 * pasos de D1). Usado tanto acá como en OrderService.confirmOrder().
 */
export function canonicalStockItemOrder<T extends { productId: string; productVariantId: string | null }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) =>
    (a.productVariantId ?? a.productId).localeCompare(b.productVariantId ?? b.productId),
  );
}

export function registerInventoryHandlers(
  worker: OutboxWorker,
  productService: ProductService,
  stockMovementRepo: StockMovementRepository,
  transactionManager: TransactionManager,
): void {
  worker
    .on('order.confirmed', handleOrderConfirmedStock(productService, stockMovementRepo, transactionManager))
    .on('order.cancelled', handleOrderCancelledStock(productService, stockMovementRepo, transactionManager));
}

// ---------------------------------------------------------------------------
// Handlers individuales (exportados para testear en aislamiento)
// ---------------------------------------------------------------------------

export function handleOrderConfirmedStock(
  productService: ProductService,
  stockMovementRepo: StockMovementRepository,
  transactionManager: TransactionManager,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { items } = event.payload as { items?: StockItemSnapshot[] };
    if (!items || items.length === 0) return; // orden sin productos (ej. solo cargo a la habitación)

    await transactionManager.run(async (client) => {
      for (const item of canonicalStockItemOrder(items)) {
        // Compite con RESERVATION_RELEASED (handleOrderCancelledStock) por
        // el mismo casillero (order_item_id) -- el que inserta primero gana.
        const inserted = await stockMovementRepo.createWithClient(client, randomUUID(), {
          businessId:       event.businessId,
          productId:        item.productVariantId ? null : item.productId,
          productVariantId: item.productVariantId,
          movementType:     'OUT',
          quantity:         item.quantity,
          orderItemId:      item.orderItemId,
          createdBy:        SYSTEM_ACTOR,
          notes:            null,
        });

        // false = ya existía OUT (reintento) o perdió la carrera contra un
        // RESERVATION_RELEASED (la orden se canceló antes) -- no consolidar.
        if (!inserted) continue;

        await productService.commitReservedStock(
          client,
          item.productId,
          item.productVariantId ?? undefined,
          item.quantity,
        );
      }
    });
  };
}

export function handleOrderCancelledStock(
  productService: ProductService,
  stockMovementRepo: StockMovementRepository,
  transactionManager: TransactionManager,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { previousStatus, wasServed, items } = event.payload as {
      previousStatus?: string;
      wasServed?: boolean;
      items?: StockItemSnapshot[];
    };

    // Si la orden nunca pasó por CONFIRMED, nunca se reservó -- nada que liberar ni restaurar.
    if (previousStatus !== 'CONFIRMED' || !items || items.length === 0) return;

    await transactionManager.run(async (client) => {
      for (const item of canonicalStockItemOrder(items)) {
        // Intenta reclamar el mismo casillero que OUT (handleOrderConfirmedStock).
        // Gana quien llega primero -- no depende de qué evento se despache antes.
        const releasedReservation = await stockMovementRepo.createWithClient(client, randomUUID(), {
          businessId:       event.businessId,
          productId:        item.productVariantId ? null : item.productId,
          productVariantId: item.productVariantId,
          movementType:     'RESERVATION_RELEASED',
          quantity:         item.quantity,
          orderItemId:      item.orderItemId,
          createdBy:        SYSTEM_ACTOR,
          notes:            null,
        });

        if (releasedReservation) {
          // Ganamos la carrera: el outbox todavía no había consolidado esta
          // reserva. Nunca se tocó stock físico -- solo se libera el hold.
          await productService.releaseReservedStock(
            client,
            item.productId,
            item.productVariantId ?? undefined,
            item.quantity,
          );
          continue;
        }

        // No se insertó -- pero eso solo no distingue POR QUÉ: puede ser un
        // reintento de este mismo RESERVATION_RELEASED (at-least-once, ya
        // liberado, nada más que hacer) o que OUT ganó el casillero (sí hay
        // que evaluar restaurar). Desambiguar antes de decidir.
        const alreadyReleased = await stockMovementRepo.hasMovement(client, item.orderItemId, 'RESERVATION_RELEASED');
        if (alreadyReleased) continue;

        // OUT ganó el casillero -- la reserva ya se consolidó (stock físico
        // ya bajó). Si el bien ya se sirvió (wasServed), se consumió
        // físicamente -- no restaurar (regla de oro, manual de inventario
        // sección 5).
        if (wasServed) continue;

        const inserted = await stockMovementRepo.createWithClient(client, randomUUID(), {
          businessId:       event.businessId,
          productId:        item.productVariantId ? null : item.productId,
          productVariantId: item.productVariantId,
          movementType:     'RETURN',
          quantity:         item.quantity,
          orderItemId:      item.orderItemId,
          createdBy:        SYSTEM_ACTOR,
          notes:            null,
        });

        if (!inserted) continue; // ya restaurado -- reintento at-least-once

        await productService.incrementStock(
          client,
          item.productId,
          item.productVariantId ?? undefined,
          item.quantity,
        );
      }
    });
  };
}
