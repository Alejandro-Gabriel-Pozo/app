// =============================================================================
// repositories/order.repository.ts — Interfaz + filtros para Order
// =============================================================================

import type {
  Order,
  OrderStatus,
  CreateOrderInput,
  UpdateOrderInput,
} from './order.entities.js';
import type { AppliedRateReportRow } from '../clientes-finanzas/customer-rate.repository.js';
import type { SqlClient } from '../repositories/sql.client.js';

// ---------------------------------------------------------------------------
// Primitiva única de transición de estado (ORDER-04/05/08/14, 02/09/2026)
// ---------------------------------------------------------------------------

/**
 * Qué es una transición de una orden, como dato.
 *
 * Antes cada transición era su propia implementación: `cancelWithClient`,
 * `completeWithClient`, `markServed`, y `confirmOrder` escribiendo por la vía
 * genérica de `updateWithClient`. Cuatro caminos con cuatro guardas distintas
 * -- y la cuarta no tenía ninguna (ORDER-04). Ahora la transición es un dato y
 * el camino es uno solo: `transitionWithClient`.
 *
 * Toda guarda es una **allowlist positiva**. Nunca una exclusión: un estado
 * nuevo en el enum tiene que ser agregado a mano acá para ser aceptado, no
 * entrar por omisión.
 */
export interface OrderTransitionSpec {
  /** Estados de origen aceptados. Allowlist: lo que no está, no pasa. */
  desde:   readonly OrderStatus[];
  /** Estado destino. `null` = no se toca `status` (el caso de markServed). */
  hacia:   OrderStatus | null;
  /** Columna de sello temporal, escrita en el MISMO UPDATE que la transición. */
  sella:   OrderStampColumn;
  /** Condición extra sobre la fila. Hoy sólo markServed la usa. */
  ademas?: 'served_at IS NULL';
}

/**
 * Columnas de sello permitidas. Es una allowlist porque `sella` se interpola
 * en el SQL: aunque hoy sólo puede venir de las constantes de abajo, la
 * primitiva la valida contra esta lista antes de construir la sentencia.
 */
export const ORDER_STAMP_COLUMNS = ['confirmed_at', 'completed_at', 'cancelled_at', 'served_at'] as const;
export type OrderStampColumn = typeof ORDER_STAMP_COLUMNS[number];

/**
 * Los cinco desenlaces posibles. `rowCount === undefined` NO es uno de ellos:
 * la primitiva lanza, porque no poder saber si la fila cambió no es un
 * resultado de negocio.
 *
 * - `CAMBIO`: la fila cambió efectivamente. **Es la única señal autoritativa
 *   para publicar el evento y disparar efectos** (reservar stock, auditar).
 *   Trae la orden ANTES (`previa`) y DESPUÉS (`order`) del UPDATE.
 * - `YA_ESTABA`: la orden ya estaba en el estado pedido. 200 idempotente,
 *   sin evento y **sin repetir efectos** -- que es lo que evita ORDER-05.
 * - `NO_ELEGIBLE`: estado conocido que no admite esta transición. 409.
 * - `ESTADO_DESCONOCIDO`: `status` fuera del enum. Fail-closed, 409 con
 *   código propio -- nunca se lo trata como "no elegible" a secas.
 * - `NO_EXISTE`: no hay orden con ese id. 404.
 */
export type OrderTransitionOutcome =
  | { resultado: 'CAMBIO';             previa: Order; order: Order }
  | { resultado: 'YA_ESTABA';          order: Order }
  | { resultado: 'NO_ELEGIBLE';        order: Order }
  | { resultado: 'ESTADO_DESCONOCIDO'; order: Order }
  | { resultado: 'NO_EXISTE' };

/**
 * Las cuatro transiciones del ciclo de vida, completas. Esto es todo lo que
 * hay que leer para saber qué puede pasarle a una orden.
 *
 * `CONFIRMAR` sella `confirmed_at` (ORDER-14): antes nadie escribía esa
 * columna -- ni el INSERT, ni un DEFAULT, ni un trigger -- así que estaba en
 * NULL para todas las órdenes que existieron y los cuatro reportes que
 * filtran por ella devolvían siempre vacío.
 */
export const TRANSICION_CONFIRMAR: OrderTransitionSpec = {
  desde: ['DRAFT'], hacia: 'CONFIRMED', sella: 'confirmed_at',
};
export const TRANSICION_COMPLETAR: OrderTransitionSpec = {
  desde: ['CONFIRMED'], hacia: 'COMPLETED', sella: 'completed_at',
};
export const TRANSICION_CANCELAR: OrderTransitionSpec = {
  desde: ['DRAFT', 'CONFIRMED'], hacia: 'CANCELLED', sella: 'cancelled_at',
};
/**
 * markServed no cambia `status` (servedAt es independiente, schema.sql
 * BLOQUE 14): `hacia: null`. Su idempotencia tampoco se mide contra el
 * estado sino contra `served_at`, por eso lleva `ademas`.
 */
export const TRANSICION_SERVIR: OrderTransitionSpec = {
  desde: ['CONFIRMED'], hacia: null, sella: 'served_at', ademas: 'served_at IS NULL',
};

export interface ListOrdersFilter {
  businessId:  string;
  customerId?: string;
  status?:     OrderStatus;
  from?:       Date;
  to?:         Date;
  limit?:      number;
  offset?:     number;
}

// ---------------------------------------------------------------------------
// D7 (22/08/2026, pendientes-2026-08-19.md sección D) — reportes POS
// ---------------------------------------------------------------------------

/** Ventas agregadas por producto/variante en un período (órdenes CONFIRMED/COMPLETED). */
export interface SalesByProductRow {
  productId: string;
  productVariantId: string | null;
  productName: string;
  variantName: string | null;
  quantitySold: number;
  totalRevenue: number;
  orderCount: number;
}

/** Ticket promedio de las órdenes CONFIRMED/COMPLETED en un período. */
export interface TicketSummaryReport {
  orderCount: number;
  totalRevenue: number;
  averageTicket: number;
}

/** Ver `AppliedRateReportRow` en `clientes-finanzas/customer-rate.repository.js` -- el reporte cruza pos-menu y reservas, vive con CustomerRate, el dueño real del concepto. */

export interface IOrderRepository {
  getById(id: string): Promise<Order | undefined>;
  getAll(filter: ListOrdersFilter): Promise<Order[]>;
  create(input: CreateOrderInput): Promise<Order>;
  update(id: string, input: UpdateOrderInput): Promise<Order | undefined>;
  /**
   * ORDER-04/08 (02/09/2026) -- `cancel()`, `complete()` y `markServed()`
   * se ELIMINARON de este contrato.
   *
   * Eran mutaciones de estado que corrían con el `SqlClient` de la
   * instancia, en autocommit: su `SELECT ... FOR UPDATE` tomaba y soltaba
   * el lock en la misma sentencia, o sea que no protegía nada. Presentarlas
   * como camino equivalente al transaccional habría sido exactamente la
   * ruta paralela sin las mismas guardas que este bloque vino a eliminar.
   *
   * Ningún código las consumía: `OrderService` usa `transitionWithClient`
   * dentro de `transactionManager.run()`, que es el único camino. Se
   * borran en vez de documentarse.
   *
   * Si alguna vez hace falta transicionar una orden fuera de un servicio,
   * el camino es abrir una transacción y llamar a la primitiva -- no
   * reintroducir un atajo en autocommit.
   */
  /**
   * ORDER-17 (05/09/2026) -- `addItem()`/`removeItem()` (autocommit) se
   * ELIMINARON de este contrato, mismo criterio que ORDER-04/08 de arriba.
   *
   * `addItem()` chequeaba `(this.db as unknown as {_pool?})._pool` para
   * decidir si abría su propio `BEGIN`/`FOR UPDATE`/`COMMIT` a mano -- pero
   * ningún `SqlClient` real (el que arma `tenant.middleware.ts` para
   * `req.db`) expone `_pool`, así que esa rama nunca corría en producción.
   * El único camino real caía siempre a `addItemWithClient()` SIN
   * transacción propia ni recálculo de `total_amount` -- cada ítem
   * agregado después de crear la orden se servía y descontaba stock, pero
   * `orders.total_amount` nunca se movía de su valor original, así que el
   * `CHARGE` que emite `order.confirmed` se queda corto (o en cero, si la
   * orden se creó vacía). No es una carrera: pasaba SIEMPRE, sin
   * necesitar concurrencia.
   *
   * `removeItem()` hacía `DELETE FROM order_items WHERE id = $1` -- SIN
   * `AND order_id = $2` -- pese a recibir `orderId` como parámetro. El
   * servicio valida que la orden del path esté `DRAFT`, pero el `DELETE`
   * borraba cualquier ítem con ese id sin importar de qué orden fuera:
   * pasando el id de una orden `DRAFT` propia y el `itemId` de una orden
   * `CONFIRMED`/ya facturada del mismo tenant, se borraba una línea de la
   * orden equivocada. Las dos sentencias (`DELETE` + `UPDATE` del total)
   * corrían además sueltas, en autocommit, sin ninguna transacción entre
   * sí.
   *
   * Reemplazadas por `addItemWithClient()`/`removeItemWithClient()` (ver
   * `IOrderRepositoryWithClient`), usadas por `OrderService.addItem()`/
   * `removeItem()` dentro de `transactionManager.run()` con
   * `getByIdForUpdate()` -- mismo patrón que `confirmOrder()`/
   * `cancelOrder()` ya usan: lock real, releído bajo lock, ninguna mutación
   * fuera de la transacción.
   */

  /** D7 — ventas por producto/variante, órdenes CONFIRMED/COMPLETED en [from, to] (por confirmed_at). */
  getSalesByProduct(from: Date, to: Date): Promise<SalesByProductRow[]>;
  /** D7 — ticket promedio de órdenes CONFIRMED/COMPLETED en [from, to]. */
  getTicketSummary(from: Date, to: Date): Promise<TicketSummaryReport>;
  /** D7 — tarifas especiales aplicadas en order_items de órdenes CONFIRMED/COMPLETED en [from, to]. */
  getAppliedRatesReport(from: Date, to: Date): Promise<AppliedRateReportRow[]>;
  /**
   * ORDER-01/02 (02/09/2026) -- lectura del agregado raíz CON LOCK, dentro
   * de la transacción del caller (`SELECT id FROM orders WHERE id = $1 FOR
   * UPDATE`, después relee la fila completa). Vivía solo en
   * `IOrderRepositoryWithClient` (uso interno de `OrderService`); subida acá
   * (05/09/2026, ORDER-10, architecture-governor) para que `InvoiceService`
   * -- que ya depende de `Pick<IOrderRepository, 'getById'>` -- pueda
   * releer el status de la orden BAJO EL MISMO LOCK que `cancelOrder()`
   * antes de facturar, y cerrar así la ventana de carrera entre las dos
   * (ver `OrderCancelledCannotInvoiceError`). Nunca exponer un equivalente
   * en autocommit -- ver el comentario de arriba sobre por qué se borraron
   * `cancel()`/`complete()`.
   */
  getByIdForUpdate(client: SqlClient, id: string): Promise<Order | undefined>;
}
