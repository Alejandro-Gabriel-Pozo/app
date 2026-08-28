import type { SqlClient } from './sql.client.js';

/**
 * RESERVATION_RELEASED (D1, 15/08/2026) no es un movimiento físico — no
 * representa un cambio de stock_quantity, a diferencia de los otros cuatro.
 * Registra que una reserva (reserved_quantity) se liberó sin llegar a
 * consolidarse en un descuento real (orden cancelada antes de que el
 * outbox la procesara). Ver schema.sql BLOQUE 5/13 para el índice de
 * exclusión mutua con OUT que lo usa.
 */
export type StockMovementType = 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN' | 'RESERVATION_RELEASED' | 'TRANSFER' | 'WASTE' | 'PRODUCTION' | 'CONSUMPTION';

/**
 * Efecto de un movimiento sobre el stock FÍSICO del producto de su propia
 * fila (`stock_quantity` en `inventory_levels`).
 *
 * - `INCREASE` / `DECREASE`: mueve stock físico en esa dirección.
 * - `RELOCATE`: neto cero sobre el total del negocio, mueve entre
 *   ubicaciones (solo `TRANSFER`).
 * - `RESERVED_ONLY`: no toca stock físico; libera `reserved_quantity`
 *   (solo `RESERVATION_RELEASED`, ver docblock de abajo).
 * - `SIGNED_BY_CALLER`: la dirección la decide el caller, no el tipo —
 *   un ajuste puede sumar o restar según lo que haya dado el conteo.
 */
export type StockEffect = 'INCREASE' | 'DECREASE' | 'RELOCATE' | 'RESERVED_ONLY' | 'SIGNED_BY_CALLER';

/** Qué columnas de ubicación usa el movimiento — ver `chk_stock_movements_location`. */
export type LocationMode = 'SINGLE' | 'FROM_TO';

export interface StockMovementRule {
  stockEffect: StockEffect;
  locationMode: LocationMode;
  /** `chk_waste_requires_reason` en schema.sql. */
  requiresWasteReason: boolean;
  /**
   * `chk_consumption_requires_destination` en schema.sql (27/08/2026,
   * adoptado de `proyecto script` — DESTINOS_CONSUMO). Concepto propio, NO
   * un alias de `requiresWasteReason`: una merma es pérdida, un consumo
   * interno es costo operativo — ver docblock de `consumption_destinations`
   * en schema.sql para el porqué de no compartir el mismo catálogo.
   */
  requiresConsumptionDestination: boolean;
  /** `chk_adjustment_requires_notes` en schema.sql. */
  requiresNotes: boolean;
  /**
   * `false` = el tipo existe en el CHECK de la tabla y en esta unión, pero
   * todavía NO lo escribe ningún camino de la aplicación. No es código
   * muerto: son los casilleros reservados de las dos features diferidas
   * a propósito en `docs/diseno-inventario-carve-out.md`
   * ("deliberadamente fuera de este diseño").
   */
  implemented: boolean;
  /** Para qué se usa, en el vocabulario del negocio (A5.1). */
  descripcion: string;
}

/**
 * ÚNICA FUENTE DE VERDAD de las reglas por tipo de movimiento de stock
 * (27/08/2026).
 *
 * **Por qué existe:** `criterios-negocio.md` A6.1 — *"Una máquina de estados
 * se declara una sola vez. Como dato, no como `if`"*. Hasta este cambio las
 * reglas por tipo estaban repartidas en cuatro lugares sin un dueño único:
 * los CHECK de `schema.sql` (ubicación, motivo de merma, notas), los
 * docblocks de este archivo, y —lo más frágil— el conocimiento implícito de
 * cada call site, que sabía por su cuenta si tenía que llamar a
 * `incrementStock`, `decrementStock` o `transferStock`. Un grep de
 * `movementType ===` sobre todo `src/` no devolvía **ni una sola** línea: la
 * dirección del stock no estaba declarada en ningún lado, solo ejercida.
 *
 * Adoptado del proyecto de referencia `proyecto script` (NQNTUR, ERP-lite
 * sobre Apps Script), que resuelve lo mismo con su mapa `TRANSICIONES` en
 * `Movimientos.js` — un solo objeto que declara, por proceso, signo de
 * stock, filtros y si dispara consumo de receta. Cumplía A6.1 mejor que
 * este repo para stock; se trae el patrón, no el código.
 *
 * **Alcance honesto de lo que centraliza hoy:** este mapa DECLARA las
 * reglas y `SqlStockMovementRepository.createWithClient()` las EXIGE en el
 * único punto de escritura. Lo que todavía NO unifica es la *aplicación*
 * del stock: `incrementStock`/`decrementStock`/`transferStock` son métodos
 * distintos con firmas distintas, así que cada call site sigue eligiendo
 * cuál llamar. Unificar eso es un refactor aparte y más riesgoso — lo que
 * cierra este cambio es que la regla ya no se pueda contradecir en silencio
 * entre un call site y otro, porque hay un lugar donde está escrita y un
 * guard que la verifica.
 */
export const STOCK_MOVEMENT_RULES: Record<StockMovementType, StockMovementRule> = {
  IN: {
    stockEffect: 'INCREASE',
    locationMode: 'SINGLE',
    requiresWasteReason: false,
    requiresConsumptionDestination: false,
    requiresNotes: false,
    implemented: false, // reservado para Compras/Proveedores (fase diferida)
    descripcion: 'Entrada de mercadería (recepción de una compra).',
  },
  OUT: {
    stockEffect: 'DECREASE',
    locationMode: 'SINGLE',
    requiresWasteReason: false,
    requiresConsumptionDestination: false,
    requiresNotes: false,
    implemented: true,
    descripcion: 'Salida por venta consolidada — la genera el outbox al confirmar una orden.',
  },
  ADJUSTMENT: {
    stockEffect: 'SIGNED_BY_CALLER',
    locationMode: 'SINGLE',
    requiresWasteReason: false,
    requiresConsumptionDestination: false,
    requiresNotes: true,
    implemented: false, // reservado para Conteo físico (fase diferida)
    descripcion: 'Corrección de stock contra un conteo. Exige notas: un ajuste sin explicación no es auditable.',
  },
  RETURN: {
    stockEffect: 'INCREASE',
    locationMode: 'SINGLE',
    requiresWasteReason: false,
    requiresConsumptionDestination: false,
    requiresNotes: false,
    implemented: true,
    descripcion: 'Devolución al stock por cancelación de una orden ya confirmada.',
  },
  RESERVATION_RELEASED: {
    stockEffect: 'RESERVED_ONLY',
    locationMode: 'SINGLE',
    requiresWasteReason: false,
    requiresConsumptionDestination: false,
    requiresNotes: false,
    implemented: true,
    descripcion: 'Liberación de una reserva que nunca llegó a descontar stock físico (orden cancelada antes de consolidarse).',
  },
  TRANSFER: {
    stockEffect: 'RELOCATE',
    locationMode: 'FROM_TO',
    requiresWasteReason: false,
    requiresConsumptionDestination: false,
    requiresNotes: false,
    implemented: true,
    descripcion: 'Movimiento entre dos ubicaciones del mismo negocio. Neto cero sobre el total.',
  },
  WASTE: {
    stockEffect: 'DECREASE',
    locationMode: 'SINGLE',
    requiresWasteReason: true,
    requiresConsumptionDestination: false,
    requiresNotes: false,
    implemented: true,
    descripcion: 'Pérdida de mercadería (vencida, rota, robada). Exige motivo para poder agrupar y atacar la causa.',
  },
  PRODUCTION: {
    stockEffect: 'INCREASE',
    locationMode: 'SINGLE',
    requiresWasteReason: false,
    requiresConsumptionDestination: false,
    requiresNotes: false,
    implemented: true,
    descripcion: 'Producción de un compuesto: suma el producto terminado y consume su receta (los componentes no llevan fila propia).',
  },
  /**
   * 27/08/2026, adoptado de `proyecto script` (DESTINOS_CONSUMO) —
   * pendientes-2026-08-27.md. Antes de este tipo, un consumo interno
   * (comida de personal, degustación, elaboración interna) se registraba
   * como WASTE porque era el único tipo que decrementaba stock fuera de una
   * venta -- eso mezclaba costo operativo con pérdida real y distorsionaba
   * "porcentaje de merma por período" (manual-inventario.md §10). Mismo
   * efecto sobre el stock que WASTE, catálogo de motivo propio
   * (`consumption_destinations`, nunca `waste_reasons`).
   */
  CONSUMPTION: {
    stockEffect: 'DECREASE',
    locationMode: 'SINGLE',
    requiresWasteReason: false,
    requiresConsumptionDestination: true,
    requiresNotes: false,
    implemented: true,
    descripcion: 'Consumo interno (personal, degustación, evento, elaboración interna). Costo operativo, no pérdida -- no cuenta como merma.',
  },
};

/** D7 (22/08/2026) — una fila por producto/variante + motivo de merma, agregada en un período. */
export interface WasteReportRow {
  productId: string | null;
  productVariantId: string | null;
  productName: string | null;
  variantName: string | null;
  wasteReasonId: string;
  wasteReasonName: string;
  totalQuantity: number;
  movementCount: number;
}

/** 27/08/2026 — gemelo de `WasteReportRow` para `movementType='CONSUMPTION'`. */
export interface ConsumptionReportRow {
  productId: string | null;
  productVariantId: string | null;
  productName: string | null;
  variantName: string | null;
  consumptionDestinationId: string;
  consumptionDestinationName: string;
  totalQuantity: number;
  movementCount: number;
}

export interface StockMovement {
  id: string;
  businessId: string;
  productId: string | null;
  productVariantId: string | null;
  movementType: StockMovementType;
  quantity: number;
  orderItemId: string | null;
  createdBy: string;
  notes: string | null;
  createdAt: Date;
  /**
   * Fase 1 del carve-out de inventario (16/08/2026) — ubicación del
   * movimiento. NULL solo para TRANSFER (usa fromLocationId/toLocationId
   * en su lugar), obligatorio para el resto — ver chk_stock_movements_location
   * en schema.sql BLOQUE 5.
   */
  locationId: string | null;
  fromLocationId: string | null;
  toLocationId: string | null;
  /**
   * Fase 2 del carve-out de inventario (17/08/2026) — motivo de la merma.
   * Obligatorio cuando movementType = 'WASTE' (chk_waste_requires_reason en
   * schema.sql BLOQUE 5), NULL para el resto de los tipos.
   */
  wasteReasonId: string | null;
  /**
   * 27/08/2026 — gemelo de `wasteReasonId` para movementType = 'CONSUMPTION'
   * (chk_consumption_requires_destination). NULL para el resto de los tipos,
   * incluido WASTE — son dos catálogos distintos a propósito.
   */
  consumptionDestinationId: string | null;
}

export type CreateStockMovementInput = Omit<StockMovement, 'id' | 'createdAt' | 'fromLocationId' | 'toLocationId' | 'wasteReasonId' | 'consumptionDestinationId'> & {
  /** Solo TRANSFER los usa — el resto de los tipos los deja undefined (se guardan NULL). */
  fromLocationId?: string | null;
  toLocationId?: string | null;
  /** Solo WASTE lo usa — el resto de los tipos lo deja undefined (se guarda NULL). */
  wasteReasonId?: string | null;
  /** Solo CONSUMPTION lo usa — el resto de los tipos lo deja undefined (se guarda NULL). */
  consumptionDestinationId?: string | null;
};

export interface StockMovementRepository {
  /**
   * Inserta el movimiento con ON CONFLICT DO NOTHING sobre
   * (order_item_id, movement_type) — idempotencia real (A8.5/R13): el
   * OutboxWorker reintrega at-least-once, este es el mecanismo que
   * garantiza que un mismo order_item nunca genere dos OUT (o dos RETURN).
   *
   * @returns true si se insertó una fila nueva (primera vez que se procesa
   *   este evento para este ítem) — false si ya existía (reintento,
   *   no-op esperado, el caller NO debe tocar stock de nuevo).
   */
  createWithClient(client: SqlClient, id: string, input: CreateStockMovementInput): Promise<boolean>;

  /**
   * ¿Existe un movimiento de ese tipo para ese order_item+producto/variante?
   * Usado para desambiguar, del lado del que PIERDE la carrera del
   * casillero compartido OUT/RESERVATION_RELEASED (D1, 15/08/2026), entre
   * dos casos que un `createWithClient` que devuelve false no distingue:
   * "ya inserté yo este mismo tipo antes" (reintento at-least-once — no
   * hacer nada más) vs. "el otro tipo ganó la carrera" (sí hay que actuar
   * distinto).
   *
   * Fase 3 del carve-out de inventario (17/08/2026) — recibe también
   * productId/productVariantId: un order_item compuesto (receta explotada)
   * puede tener VARIOS componentes con casilleros independientes bajo el
   * mismo order_item_id; sin esto, `hasMovement` no podría distinguir cuál
   * de ellos ya se resolvió. Para un ítem simple (el caso de siempre) es
   * exactamente la misma pregunta que antes.
   */
  hasMovement(
    client: SqlClient,
    orderItemId: string,
    productId: string | null,
    productVariantId: string | null,
    movementType: StockMovementType,
  ): Promise<boolean>;

  /** D7 (22/08/2026) — reporte de mermas (movementType='WASTE') agrupado por producto/variante + motivo, en un período. */
  getWasteReport(from: Date, to: Date): Promise<WasteReportRow[]>;

  /** 27/08/2026 — gemelo de `getWasteReport()` para movementType='CONSUMPTION'. */
  getConsumptionReport(from: Date, to: Date): Promise<ConsumptionReportRow[]>;
}
