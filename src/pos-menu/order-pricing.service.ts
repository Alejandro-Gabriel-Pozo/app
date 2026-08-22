/**
 * @file order-pricing.service.ts
 * @description Resolución de precio server-side para ítems PRODUCT/
 * PRODUCT_VARIANT de una orden (D9-Parte 2,
 * docs/diseno-scope-multinivel-tarifas-2026-08-22.md).
 *
 * Hallazgo hecho al empezar D9-Parte 2 (no estaba en el diseño original):
 * hasta esta pasada `order.service.ts` armaba cada línea con el `unitPrice`
 * que mandaba el cliente, SIN ningún paso de resolución server-side -- ni
 * siquiera contra el precio real del producto, sin hablar todavía de
 * tarifas especiales. Decisión del dueño: el servidor pasa a tener
 * autoridad completa sobre el precio de estos dos itemType. `unitPrice`
 * deja de aceptarse como input para ellos (`CreateOrderItemSchema`,
 * request.schemas.ts) -- lo resuelve este servicio.
 *
 * Mismo algoritmo que `ReservationPricingService` (reservas/
 * reservation-pricing.service.ts): precio base (`ProductService.
 * resolveTarget()`, ya resuelve la herencia has_variants) con la tarifa
 * especial del cliente aplicada si existe una activa. A diferencia de
 * reservas, PRODUCTOS es un eje único -- no hay "servicio vs. recurso" en
 * POS, `ICustomerRateRepository.findActiveForCustomerAndProduct()` ya
 * resuelve la más específica entre ítem/categoría/bucket ('PRODUCTOS').
 *
 * Los ítems RESERVATION (order_items.item_type) NO pasan por acá -- no
 * tienen (todavía) ningún paso de resolución server-side, siguen tomando
 * `unitPrice` tal cual lo manda el caller. Es un eje distinto, fuera del
 * alcance de D9 (ver order.service.ts, resolveUnitPrice()).
 */

import type { ProductService } from './product.service.js';
import type { ProductId, ProductVariantId } from './product.entities.js';
import type { ICustomerRateRepository } from '../clientes-finanzas/customer-rate.repository.js';

export class OrderPricingService {
  constructor(
    private readonly productService: ProductService,
    private readonly customerRateRepository: ICustomerRateRepository,
  ) {}

  /**
   * Precio unitario efectivo de un ítem PRODUCT/PRODUCT_VARIANT.
   * `customerId` puede ser `null` -- venta de mostrador sin cliente
   * (`orders.customer_id` es nullable en la base, aunque hoy
   * `CreateOrderSchema` lo exige siempre desde la API -- ver
   * docs/diseno-scope-multinivel-tarifas-2026-08-22.md sección 2). Sin
   * cliente no hay tarifa especial posible: se resuelve directo al precio
   * base/override de variante.
   */
  async resolveUnitPrice(params: {
    customerId: string | null;
    productId: ProductId;
    variantId: ProductVariantId | undefined;
    locationId: string;
  }): Promise<number> {
    const target = await this.productService.resolveTarget(params.productId, params.variantId, params.locationId);
    if (!params.customerId) return target.effectivePrice;

    const rate = await this.customerRateRepository.findActiveForCustomerAndProduct(
      params.customerId, params.productId, target.product.categoryId ?? '',
    );
    if (!rate) return target.effectivePrice;

    return this.resolveRateAmount(rate, target.effectivePrice);
  }

  /**
   * D5 -- una CustomerRate es un monto fijo O un % de descuento (exactamente
   * uno de los dos, `chk_customer_rate_pricing_mode`). Redondeo a centavos,
   * mismo criterio que `ReservationPricingService.resolveRateAmount()`.
   */
  private resolveRateAmount(rate: { fixedPrice: number | null; discountPercentage: number | null }, basePrice: number): number {
    if (rate.fixedPrice !== null) return rate.fixedPrice;
    return Math.round(basePrice * (1 - rate.discountPercentage! / 100) * 100) / 100;
  }
}
