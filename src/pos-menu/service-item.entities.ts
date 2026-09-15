// =============================================================================
// domain/service-item.entities.ts — Entidad de dominio: ServiceItem
// =============================================================================
// Catálogo de servicios administrativos/intangibles ("Cargo por cancelación",
// "Costo de envío", "Diferencia de tarifa") — item_type de primera clase de
// order_items, sin forzarlos dentro de `products` (Alternativa B de
// docs/diseno-factura-borrador-2026-08-31.md §29.4/§29.5, decisión del
// dueño). Bloque B de 4 (schema ya aplicado en Bloque A, `ffd9ed1`, v56):
// SOLO entidad + repositorio + rutas CRUD acá — el wiring de precio/
// descripción en OrderPricingService/InvoiceService y ORDER_ITEM_TYPES en
// request.schemas.ts quedan para los Bloques C/D, con su propio gate.
//
// Sigue el patrón ESTRUCTURAL de `Product` (§29.7.2 del diseño: un MAESTRO
// no puede depender de una FK opcional para resolver su propio tenant, a
// diferencia de `bookable_services`/`resource_categories`) — de ahí que
// viva en `src/pos-menu/`, junto a `product.entities.ts`. Sin `sku`/R1 ni
// variantes: mismo estado que el resto del catálogo (R1/R6 incumplidas a
// propósito, backlog general, Parte 7 de docs/criterios-datos.md).
// =============================================================================

export type ServiceItemId = string;

export interface ServiceItem {
  id: ServiceItemId;
  businessId: string;
  /** FK a resource_categories, nullable, ON DELETE RESTRICT — §29.7.7 punto 1 (resuelto 15/09/2026). */
  categoryId: string | null;
  name: string;
  description: string | null;
  /** Precio fijo del catálogo — sin tarifas especiales (§29.7.7 punto 3: resuelto, no participa de customer_rates/rate_catalog). */
  price: number;
  active: boolean;
  /**
   * `active` (pausado) + `deleted_at` (borrado permanente) desde el día uno
   * en el schema (R3 cumplida, a diferencia de `products` que hoy solo
   * tiene `active` — ver comentario en schema.sql BLOQUE 23). Este Bloque
   * (B) solo implementa el camino de pausado: DELETE /api/service-items/:id
   * pone `active = false`, nunca toca `deleted_at` — el borrado permanente
   * no tiene endpoint todavía (fuera de alcance, no decidido).
   */
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateServiceItemInput {
  businessId: string;
  categoryId?: string | null;
  name: string;
  description?: string | null;
  price: number;
}

export interface UpdateServiceItemInput {
  categoryId?: string | null;
  name?: string;
  description?: string | null;
  price?: number;
  active?: boolean;
}
