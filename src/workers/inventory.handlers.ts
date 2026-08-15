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
 * ## Por qué no hay try/catch para "sin stock" acá
 * OrderService.confirmOrder() ya valida stock disponible ANTES de emitir
 * el evento (checkStock, síncrono) — para cuando este handler corre, la
 * falta de stock ya debería ser imposible salvo una condición de carrera
 * genuina entre el chequeo y el decremento real. Si decrementStock() igual
 * falla acá, el evento queda sin despachar y el OutboxWorker lo reintenta
 * cada 5s indefinidamente (no tiene dead-letter, ver A9.5 en
 * criterios-negocio.md — alertar sobre esto es un gap ya conocido, no
 * introducido por este handler).
 *
 * ## Idempotencia
 * Insert-then-act: primero se intenta insertar la fila en stock_movements
 * (ON CONFLICT DO NOTHING sobre (order_item_id, movement_type)). Si la
 * fila NO se insertó (ya existía — reintento del at-least-once), NO se
 * vuelve a tocar stock. Esto evita el problema clásico de "decrementar dos
 * veces porque el evento se reprocesó".
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
      for (const item of items) {
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

        // false = ya existía este movimiento (reintento at-least-once) -- no tocar stock de nuevo.
        if (!inserted) continue;

        await productService.decrementStock(
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

    // Si la orden nunca pasó por CONFIRMED, el stock nunca bajó -- nada que restaurar.
    // Si ya se sirvió (wasServed), el bien se consumió físicamente -- cancelar
    // después no debe restaurar stock de algo que ya no existe (regla de oro,
    // manual de inventario sección 5: "se restaura stock solo si el bien
    // físico no se llegó a usar").
    if (previousStatus !== 'CONFIRMED' || wasServed || !items || items.length === 0) return;

    await transactionManager.run(async (client) => {
      for (const item of items) {
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

        if (!inserted) continue;

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
