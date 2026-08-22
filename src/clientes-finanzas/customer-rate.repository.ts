/**
 * @file customer-rate.repository.ts
 * @description Interfaz para tarifas especiales (precios negociados por cliente).
 *
 * Una fila = un override de precio para un cliente sobre UN resource_id XOR
 * UN service_id (nunca ambos, nunca ninguno — chk_customer_rate_target en
 * db/schema.sql). ReservationService.resolvePrice() la consulta para decidir
 * el total_price de una reserva antes de la tarifa de catálogo.
 *
 * D5 (pendientes-2026-08-19.md, decisión confirmada con el dueño
 * 22/08/2026): el override es, excluyente (chk_customer_rate_pricing_mode
 * en schema.sql):
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

export interface CustomerRate {
  id: string;
  businessId: string;
  customerId: string;
  resourceId: string | null;
  serviceId: string | null;
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
 * Exactamente uno de `fixedPrice`/`discountPercentage`/`rateCatalogId` —
 * el caller (ruta HTTP) ya validó esto contra el body con Zod antes de
 * llegar acá. En el modo `rateCatalogId`, la fila NO guarda su propio %
 * (queda NULL en la base) — se resuelve en cada lectura, ver docblock de
 * la interfaz arriba.
 */
export type CreateCustomerRateDto = {
  id: string;
  businessId: string;
  customerId: string;
  resourceId?: string | null;
  serviceId?: string | null;
  notes?: string | null;
} & (
  | { fixedPrice: number; discountPercentage?: undefined; rateCatalogId?: undefined }
  | { fixedPrice?: undefined; discountPercentage: number; rateCatalogId?: undefined }
  | { fixedPrice?: undefined; discountPercentage?: undefined; rateCatalogId: string }
);

export interface ICustomerRateRepository {
  findActiveForCustomerAndResource(customerId: string, resourceId: string): Promise<CustomerRate | undefined>;
  findActiveForCustomerAndService(customerId: string, serviceId: string): Promise<CustomerRate | undefined>;

  /** Por id, sin filtro de `active` — usado para auditar la desactivación (necesita el estado ANTES). */
  findById(id: string, businessId: string): Promise<CustomerRate | undefined>;

  /** Todas las tarifas activas de un cliente — usado por la vista de edición (Fase 3). */
  getByCustomerId(customerId: string): Promise<CustomerRate[]>;

  create(dto: CreateCustomerRateDto): Promise<CustomerRate>;

  /** Soft — pone active=FALSE, no borra la fila. */
  deactivate(id: string): Promise<void>;
}
