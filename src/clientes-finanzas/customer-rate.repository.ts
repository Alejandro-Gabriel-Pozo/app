/**
 * @file customer-rate.repository.ts
 * @description Interfaz para tarifas especiales (precios negociados por cliente).
 *
 * Una fila = un override de precio para un cliente sobre un SCOPE — desde
 * D9-Parte 1 (pendientes-2026-08-22.md,
 * docs/diseno-scope-multinivel-tarifas-2026-08-22.md) hay 5 modos de
 * scope posibles, exactamente uno (`chk_customer_rate_scope` en
 * db/schema.sql):
 *   - `resourceId`/`serviceId`/`productId` — nivel ÍTEM (antes solo los
 *     primeros dos existían; `productId` se agregó en D9-Parte 1 con la
 *     API rechazándolo hasta D9-Parte 2 -- ya habilitado, lo consulta
 *     `OrderPricingService`, pos-menu/order-pricing.service.ts)
 *   - `categoryId` — nivel CATEGORÍA (una sola columna: resources/
 *     bookable_services/products ya comparten `resource_categories`)
 *   - `bucket` — nivel BUCKET (`'ALOJAMIENTO'|'TURNOS'|'SERVICIOS'|'PRODUCTOS'`;
 *     ALOJAMIENTO/TURNOS no son tablas, se derivan de
 *     `resource_categories.is_lodging`)
 *
 * `ReservationPricingService.resolveUnitPrice()` la consulta para decidir
 * el precio unitario de una reserva — de las filas activas que alcanzan
 * al ítem concreto (a cualquiera de los 3 niveles), gana la más
 * específica (ítem > categoría > bucket).
 *
 * D5 (pendientes-2026-08-19.md, decisión confirmada con el dueño
 * 22/08/2026): el PRECIO (ortogonal al scope de arriba) es, excluyente
 * (chk_customer_rate_pricing_mode en schema.sql):
 *   (A) un monto FIJO (`fixedPrice`)
 *   (B) un % DE DESCUENTO propio de la fila (`discountPercentage`)
 *   (C) una referencia VIVA a `rate_catalog` (`rateCatalogId`)
 *
 * En el modo (C), `discountPercentage` en el objeto que devuelve este
 * repositorio ya viene RESUELTO vía JOIN a `rate_catalog` (no es lo que
 * hay en la columna de la fila, que queda NULL) — el resto del dominio
 * (ReservationPricingService) no necesita saber de qué modo salió el %,
 * solo usa el valor efectivo. Ver rate-catalog.repository.ts para el
 * porqué es una referencia viva y no una copia (decisión explícita del
 * dueño, corregida ANTES de cualquier deploy real).
 */

/**
 * D7 (22/08/2026, pendientes-2026-08-19.md sección D) — cuántas veces se
 * aplicó esta CustomerRate (y a quién) en un período. Vive acá, no en
 * `pos-menu/order.repository.ts` ni en `reservas/reservation.repository.ts`
 * por separado, porque el reporte cruza los dos bounded contexts (una
 * tarifa se puede aplicar en una orden POS o en una reserva) — este es el
 * dueño real del concepto "tarifa aplicada", no uno de los dos
 * consumidores. `ReportService` combina las filas de
 * `IOrderRepository.getAppliedRatesReport()` y
 * `ReservationRepository.getAppliedRatesReport()` (mismo shape, orígenes
 * distintos) en un solo reporte.
 */
export interface AppliedRateReportRow {
  customerRateId: string;
  customerId: string;
  customerName: string;
  timesApplied: number;
  totalAmount: number;
}

export interface CustomerRate {
  id: string;
  businessId: string;
  customerId: string;
  resourceId: string | null;
  serviceId: string | null;
  /** Nivel ÍTEM nuevo (D9-Parte 1) — columna en schema desde ya, API la rechaza hasta D9-Parte 2. */
  productId: string | null;
  /** Nivel CATEGORÍA (D9-Parte 1) — FK a `resource_categories`, compartida por los 3 tipos de ítem. */
  categoryId: string | null;
  /** Nivel BUCKET (D9-Parte 1) — `'ALOJAMIENTO'|'TURNOS'|'SERVICIOS'|'PRODUCTOS'`, null si el scope es ítem/categoría. */
  bucket: string | null;
  /** Monto fijo absoluto. Excluyente con `discountPercentage`/`rateCatalogId`. */
  fixedPrice: number | null;
  /**
   * % de descuento EFECTIVO sobre el precio base del recurso/servicio
   * (0 < x <= 100) — propio de la fila (modo B) o resuelto en vivo desde
   * `rate_catalog` (modo C, `rateCatalogId` seteado). Nunca junto con
   * `fixedPrice`.
   */
  discountPercentage: number | null;
  /** Si viene del catálogo: de qué entrada. El % de arriba se resuelve desde acá en cada lectura, no se copia. */
  rateCatalogId: string | null;
  active: boolean;
  notes?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Exactamente uno de `fixedPrice`/`discountPercentage`/`rateCatalogId`
 * (precio) y exactamente uno de `resourceId`/`serviceId`/`productId`/
 * `categoryId`/`bucket` (scope) — el caller (ruta HTTP) ya validó las dos
 * cosas contra el body con Zod antes de llegar acá. En el modo
 * `rateCatalogId`, la fila NO guarda su propio % (queda NULL en la
 * base) — se resuelve en cada lectura, ver docblock de la interfaz
 * arriba.
 */
export type CreateCustomerRateDto = {
  id: string;
  businessId: string;
  customerId: string;
  resourceId?: string | null;
  serviceId?: string | null;
  productId?: string | null;
  categoryId?: string | null;
  bucket?: string | null;
  notes?: string | null;
} & (
  | { fixedPrice: number; discountPercentage?: undefined; rateCatalogId?: undefined }
  | { fixedPrice?: undefined; discountPercentage: number; rateCatalogId?: undefined }
  | { fixedPrice?: undefined; discountPercentage?: undefined; rateCatalogId: string }
);

export interface ICustomerRateRepository {
  /**
   * Mejor tarifa activa para un recurso concreto — de las candidatas que
   * lo alcanzan (`resource_id` propio, `category_id` de su categoría, o
   * `bucket` ALOJAMIENTO/TURNOS según `isLodging` de esa categoría), la
   * más específica. `categoryId`/`isLodging` los resuelve el caller
   * (`ReservationPricingService`, ya tiene `resource.categoryId` y
   * consulta `ICategoryRepository` para `isLodging`) — este repositorio
   * no conoce `resource_categories` más que para comparar valores.
   */
  findActiveForCustomerAndResource(
    customerId: string, resourceId: string, categoryId: string, isLodging: boolean,
  ): Promise<CustomerRate | undefined>;

  /** Idem para un servicio — bucket fijo `'SERVICIOS'`, sin split (a diferencia de recursos, no hay is_lodging). */
  findActiveForCustomerAndService(
    customerId: string, serviceId: string, categoryId: string,
  ): Promise<CustomerRate | undefined>;

  /**
   * Idem para un producto (D9-Parte 2) — bucket fijo `'PRODUCTOS'`, sin
   * split. Consultado por `OrderPricingService` (pos-menu/order-pricing.
   * service.ts), no por `ReservationPricingService` — es el único de los
   * 3 ejes de ítem que vive en el bounded context de POS, no en reservas.
   */
  findActiveForCustomerAndProduct(
    customerId: string, productId: string, categoryId: string,
  ): Promise<CustomerRate | undefined>;

  /** Por id, sin filtro de `active` — usado para auditar la desactivación (necesita el estado ANTES). */
  findById(id: string, businessId: string): Promise<CustomerRate | undefined>;

  /** Todas las tarifas activas de un cliente — usado por la vista de edición (Fase 3). */
  getByCustomerId(customerId: string): Promise<CustomerRate[]>;

  create(dto: CreateCustomerRateDto): Promise<CustomerRate>;

  /** Soft — pone active=FALSE, no borra la fila. */
  deactivate(id: string): Promise<void>;
}
