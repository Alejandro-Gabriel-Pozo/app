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
 *
 * ## SERVICE -- Bloque C (docs/diseno-factura-borrador-2026-08-31.md §29,
 * 15/09/2026)
 * `resolveServiceUnitPrice()` resuelve el precio de un ítem SERVICE contra
 * `service_items.price` (catálogo de servicios administrativos/
 * intangibles). A diferencia de PRODUCT/PRODUCT_VARIANT, es precio FIJO --
 * §29.7.7 punto 3 (resuelto por el dueño): SERVICE no participa de
 * `customer_rates`/`rate_catalog`, sin excepción por cliente. Por eso no
 * comparte `resolveUnitPrice()` (que sí consulta tarifas especiales) --
 * es una resolución más simple, con su propio método.
 */

import type { ProductService } from './product.service.js';
import type { ProductId, ProductVariantId } from './product.entities.js';
import type { ICustomerRateRepository } from '../clientes-finanzas/customer-rate.repository.js';
import type { ServiceItemRepository } from './service-item.repository.js';
import { ServiceItemNotFoundError } from '../domain/errors.js';

export class OrderPricingService {
  constructor(
    private readonly productService: ProductService,
    private readonly customerRateRepository: ICustomerRateRepository,
    /**
     * Bloque C (§29, 15/09/2026) -- resuelve `unitPrice` server-side para
     * ítems SERVICE (precio fijo del catálogo, sin tarifas especiales). Ver
     * resolveServiceUnitPrice() más abajo.
     */
    private readonly serviceItemRepository: ServiceItemRepository,
  ) {}

  /**
   * Precio unitario efectivo + tasa de IVA (D8) + qué `CustomerRate` se
   * aplicó, si hubo alguna (D7, 22/08/2026 -- para el reporte "tarifas
   * aplicadas", `ReportService.generateAppliedRatesReport()`).
   * `customerId` puede ser `null` -- venta de mostrador sin cliente
   * (`orders.customer_id` es nullable en la base, aunque hoy
   * `CreateOrderSchema` lo exige siempre desde la API -- ver
   * docs/diseno-scope-multinivel-tarifas-2026-08-22.md sección 2). Sin
   * cliente no hay tarifa especial posible: se resuelve directo al precio
   * base/override de variante.
   *
   * `ivaRate` es SIEMPRE el del producto padre (nunca de la variante --
   * D8 lo modela a nivel producto) -- `target.product.ivaRate`, `null` si
   * no tiene override (el caller lo persiste tal cual en `order_items.
   * iva_rate`; `InvoiceService` recién ahí cae al default del negocio).
   */
  async resolveUnitPrice(params: {
    customerId: string | null;
    productId: ProductId;
    variantId: ProductVariantId | undefined;
    locationId: string;
  }): Promise<{ unitPrice: number; ivaRate: number | null; appliedCustomerRateId: string | null }> {
    const target = await this.productService.resolveTarget(params.productId, params.variantId, params.locationId);
    const ivaRate = target.product.ivaRate;

    if (!params.customerId) return { unitPrice: target.effectivePrice, ivaRate, appliedCustomerRateId: null };

    const rate = await this.customerRateRepository.findActiveForCustomerAndProduct(
      params.customerId, params.productId, target.product.categoryId ?? '',
    );
    if (!rate) return { unitPrice: target.effectivePrice, ivaRate, appliedCustomerRateId: null };

    return {
      unitPrice: this.resolveRateAmount(rate, target.effectivePrice),
      ivaRate,
      appliedCustomerRateId: rate.id,
    };
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

  /**
   * Bloque C (§29, 15/09/2026) -- precio server-side para un ítem SERVICE.
   * Precio fijo de `service_items.price`, sin tarifa especial de cliente
   * (§29.7.7 punto 3) -- a diferencia de `resolveUnitPrice()`, no consulta
   * `ICustomerRateRepository`. `ivaRate` es siempre `null`: `service_items`
   * no tiene columna `iva_rate` propia (mismo estado que `products` sin
   * override -- `InvoiceService` cae al `default_iva_rate` del negocio).
   * `findById()` NO filtra por `active`/`deleted_at` (R2, mismo criterio
   * que el resto del catálogo) -- un `service_item` pausado o borrado
   * lógicamente igual resuelve precio acá; R11 (bloqueo hacia adelante de
   * un ítem pausado) queda declarado como deuda backlog en §29.7.1, mismo
   * estado que PRODUCT hoy (`ProductService.resolveTarget()` tampoco
   * chequea `active`) -- no es una regresión nueva de este bloque.
   */
  async resolveServiceUnitPrice(serviceItemId: string): Promise<{ unitPrice: number; ivaRate: number | null; appliedCustomerRateId: string | null }> {
    const serviceItem = await this.serviceItemRepository.findById(serviceItemId);
    if (!serviceItem) throw new ServiceItemNotFoundError(serviceItemId);

    return { unitPrice: serviceItem.price, ivaRate: null, appliedCustomerRateId: null };
  }
}
