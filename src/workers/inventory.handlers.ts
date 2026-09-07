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
 * El OutboxWorker NO garantiza orden estricto de procesamiento — ni siquiera
 * dentro del mismo agregado. `getPending` ordena por `retry_count ASC, id ASC`
 * (ORDER-13/O5, 07/09/2026): un order.confirmed trabado reintentando (o ya en
 * dead-letter) no bloquea que order.cancelled de la misma orden se despache
 * antes, y ahora además un order.confirmed que ya falló una vez se procesa
 * DESPUÉS de un order.cancelled posterior aunque tenga id menor. Sin
 * coordinación, eso podía dejar la reserva liberada
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
 *
 * ## Liberación automática si order.confirmed cae en dead-letter (A8.7, 16/08/2026)
 * Hasta acá, si `handleOrderConfirmedStock` fallaba las `maxRetries` veces
 * seguidas (ej. la tenant DB caída un rato largo), el evento pasaba a
 * dead-letter (punto 2 de `pendientes-2026-08-15.md`) pero la reserva de
 * stock quedaba tomada indefinidamente — nadie más podía vender ese
 * producto hasta un reintento manual desde el panel. `handleOrderConfirmedDeadLetterRelease`
 * (registrado vía `OutboxWorker.onDeadLetter`, no vía `.on()`) reusa el
 * MISMO mecanismo de `releaseReservationHold` que ya usaba
 * `handleOrderCancelledStock`: intenta reclamar el casillero
 * OUT/RESERVATION_RELEASED de cada ítem. Dos resultados posibles:
 * - Gana la carrera (el OUT nunca se había insertado, la reserva nunca se
 *   consolidó) → libera `reserved_quantity`, el producto vuelve a estar
 *   disponible para otra orden.
 * - Pierde la carrera (el OUT SÍ se había insertado — ej. la consolidación
 *   de este mismo evento tuvo éxito en un intento anterior, pero el
 *   evento completo siguió fallando por OTRO handler en el mismo
 *   `Promise.all`, como el financiero) → no hace nada más, el índice único
 *   ya lo protege de un doble movimiento.
 *
 * **Trade-off aceptado a propósito (documentado en A8.7):** si más tarde
 * alguien reintenta manualmente ese `order.confirmed` ya dead-letrado y
 * esta vez el intento no falla, `handleOrderConfirmedStock` va a perder la
 * carrera del casillero (ya lo ganó `RESERVATION_RELEASED`) y NO va a
 * consolidar — el evento se marca despachado igual, pero el stock nunca
 * baja para esa orden. Es preferible a dejar el producto bloqueado sin
 * límite: la orden queda con su stock permanentemente desincronizado (ya
 * documentado como gap conocido), pero deja de tomar rehenes al resto del
 * inventario. No cubre el TTL por tiempo real, solo el límite de
 * reintentos — alcanza la letra de A8.7 ("TTL de expiración O límite de
 * reintentos").
 */

import { randomUUID } from 'crypto';
import type { DomainEvent } from '../repositories/domain-event.repository.js';
import type { StockMovementRepository } from '../repositories/stock-movement.repository.js';
import type { ProductService } from '../pos-menu/product.service.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { OutboxWorker } from './outbox.worker.js';

const SYSTEM_ACTOR = 'system:outbox';

/**
 * Fallback para eventos encolados antes de la Fase 1 del carve-out de
 * inventario (16/08/2026) que todavía no tienen `locationId` en su
 * payload (pendientes o en dead-letter al momento del deploy). Mismo valor
 * que usa el backfill de schema.sql — todo lo que existía antes de esta
 * migración vivía en `loc-default`.
 */
const DEFAULT_LOCATION_ID = 'loc-default';

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
  // Prefijo `inventory:` — escuchan los MISMOS order.confirmed/order.cancelled
  // que los handlers financieros, así que el casillero de `processed_events`
  // tiene que ser distinto o uno taparía al otro (28/08/2026, A10.3).
  // El casillero NO reemplaza el insert-then-act sobre `stock_movements` que
  // documenta la sección "Idempotencia" de arriba: ese sigue siendo la
  // defensa real contra la carrera entre order.confirmed y order.cancelled
  // del mismo agregado, que es una carrera entre DOS eventos distintos y por
  // lo tanto entre dos casilleros distintos.
  worker
    .on('order.confirmed', handleOrderConfirmedStock(productService, stockMovementRepo, transactionManager), { name: 'inventory:order.confirmed' })
    .on('order.cancelled', handleOrderCancelledStock(productService, stockMovementRepo, transactionManager), { name: 'inventory:order.cancelled' })
    .onDeadLetter(
      'order.confirmed',
      handleOrderConfirmedDeadLetterRelease(productService, stockMovementRepo, transactionManager),
    );
}

// ---------------------------------------------------------------------------
// Handlers individuales (exportados para testear en aislamiento)
// ---------------------------------------------------------------------------

/**
 * Intenta reclamar el casillero compartido OUT/RESERVATION_RELEASED de un
 * ítem e, insertar RESERVATION_RELEASED y ganar la carrera. Si gana,
 * libera la reserva (`reserved_quantity`) sin tocar `stock_quantity` — el
 * bien nunca se consumió físicamente. Si pierde (ya había un OUT, o un
 * RESERVATION_RELEASED de un intento anterior), no hace nada más: el
 * índice único ya evita el doble movimiento.
 *
 * Compartido por `handleOrderCancelledStock` (cancelación explícita) y
 * `handleOrderConfirmedDeadLetterRelease` (A8.7, la reserva nunca terminó
 * de consolidarse) — misma operación, dos disparadores distintos.
 *
 * @returns true si ganó la carrera y liberó la reserva; false si el
 *   casillero ya estaba tomado (por un RESERVATION_RELEASED anterior o por
 *   un OUT que ya consolidó) — el caller decide qué hacer con ese caso.
 */
async function releaseReservationHold(
  client: SqlClient,
  productService: ProductService,
  stockMovementRepo: StockMovementRepository,
  businessId: string,
  locationId: string,
  item: StockItemSnapshot,
  notes: string | null,
): Promise<boolean> {
  const released = await stockMovementRepo.createWithClient(client, randomUUID(), {
    businessId,
    productId:        item.productVariantId ? null : item.productId,
    productVariantId: item.productVariantId,
    movementType:     'RESERVATION_RELEASED',
    quantity:         item.quantity,
    orderItemId:      item.orderItemId,
    createdBy:        SYSTEM_ACTOR,
    notes,
    locationId,
  });

  if (!released) return false; // ya liberado antes, o el OUT ya ganó el casillero -- nada más que hacer

  await productService.releaseReservedStock(
    client,
    item.productId,
    item.productVariantId ?? undefined,
    locationId,
    item.quantity,
  );
  return true;
}

export function handleOrderConfirmedStock(
  productService: ProductService,
  stockMovementRepo: StockMovementRepository,
  transactionManager: TransactionManager,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { items, locationId } = event.payload as { items?: StockItemSnapshot[]; locationId?: string };
    if (!items || items.length === 0) return; // orden sin productos (ej. solo cargo a la habitación)
    const loc = locationId ?? DEFAULT_LOCATION_ID;

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
          locationId:       loc,
        });

        // false = ya existía OUT (reintento) o perdió la carrera contra un
        // RESERVATION_RELEASED (la orden se canceló antes) -- no consolidar.
        if (!inserted) continue;

        await productService.commitReservedStock(
          client,
          item.productId,
          item.productVariantId ?? undefined,
          loc,
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
    const { previousStatus, wasServed, items, locationId } = event.payload as {
      previousStatus?: string;
      wasServed?: boolean;
      items?: StockItemSnapshot[];
      locationId?: string;
    };

    // Si la orden nunca pasó por CONFIRMED, nunca se reservó -- nada que liberar ni restaurar.
    if (previousStatus !== 'CONFIRMED' || !items || items.length === 0) return;
    const loc = locationId ?? DEFAULT_LOCATION_ID;

    await transactionManager.run(async (client) => {
      for (const item of canonicalStockItemOrder(items)) {
        // Intenta reclamar el mismo casillero que OUT (handleOrderConfirmedStock).
        // Gana quien llega primero -- no depende de qué evento se despache antes.
        const releasedReservation = await releaseReservationHold(
          client, productService, stockMovementRepo, event.businessId, loc, item, null,
        );

        if (releasedReservation) continue; // ganamos la carrera -- nunca se tocó stock físico

        // No se insertó -- pero eso solo no distingue POR QUÉ: puede ser un
        // reintento de este mismo RESERVATION_RELEASED (at-least-once, ya
        // liberado, nada más que hacer) o que OUT ganó el casillero (sí hay
        // que evaluar restaurar). Desambiguar antes de decidir.
        const alreadyReleased = await stockMovementRepo.hasMovement(
          client, item.orderItemId,
          item.productVariantId ? null : item.productId, item.productVariantId,
          'RESERVATION_RELEASED',
        );
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
          locationId:       loc,
        });

        if (!inserted) continue; // ya restaurado -- reintento at-least-once

        await productService.incrementStock(
          client,
          event.businessId,
          item.productId,
          item.productVariantId ?? undefined,
          loc,
          item.quantity,
        );
      }
    });
  };
}

/**
 * Compensación de dead-letter para `order.confirmed` (A8.7, 16/08/2026).
 * Registrada vía `OutboxWorker.onDeadLetter`, no vía `.on()` — corre una
 * sola vez, cuando el evento ya agotó `maxRetries` y `handleOrderConfirmedStock`
 * nunca logró consolidar (o si consolidó, `releaseReservationHold` va a
 * perder la carrera y no hacer nada, ver docblock del archivo).
 *
 * No revierte la orden ni el evento — solo libera el hold de stock para
 * que otra orden pueda usarlo. El evento queda en dead-letter, visible en
 * el panel (`GET /api/system/outbox/dead-letter`) para diagnóstico manual.
 */
export function handleOrderConfirmedDeadLetterRelease(
  productService: ProductService,
  stockMovementRepo: StockMovementRepository,
  transactionManager: TransactionManager,
) {
  return async (event: DomainEvent): Promise<void> => {
    const { items, locationId } = event.payload as { items?: StockItemSnapshot[]; locationId?: string };
    if (!items || items.length === 0) return;
    const loc = locationId ?? DEFAULT_LOCATION_ID;

    await transactionManager.run(async (client) => {
      for (const item of canonicalStockItemOrder(items)) {
        await releaseReservationHold(
          client, productService, stockMovementRepo, event.businessId, loc, item,
          `auto-release: order.confirmed en dead-letter (evento id=${event.id ?? '?'})`,
        );
      }
    });
  };
}
