/**
 * @file reservation-pricing.service.ts
 * @description Cascada de precio de una reserva — grupo "precios" extraído
 * de `reservation.service.ts` (Fase 6, docs/auditoria-modularidad.md,
 * hallazgo B1). Única razón de cambio: cómo se cotiza una reserva. No
 * toca disponibilidad, locks, ni el ciclo de vida de la reserva — eso
 * sigue en `ReservationService` (orquestador) y
 * `ReservationAvailabilityService`.
 *
 * D9-Parte 1 (pendientes-2026-08-22.md,
 * docs/diseno-scope-multinivel-tarifas-2026-08-22.md): las tarifas
 * especiales ya no son solo a nivel ÍTEM (resource_id/service_id) — un
 * cliente puede tener una activa a nivel CATEGORÍA o BUCKET
 * (ALOJAMIENTO/TURNOS/SERVICIOS) también. `ICustomerRateRepository.
 * findActiveForCustomerAndResource/Service` ya resuelve la más específica
 * de las que apliquen (ítem > categoría > bucket) — este servicio solo le
 * pasa `categoryId`/`isLodging`, no decide entre niveles. `isLodging`
 * (ALOJAMIENTO vs. TURNOS) se resuelve acá vía `ICategoryRepository`
 * porque `PhysicalResource` no lo trae (solo `categoryId`) — ver
 * `resource_categories.is_lodging` en `schema.sql`.
 */

import type { PhysicalResource } from './resource.entities.js';
import type { BookableService } from './bookable-service.types.js';
import { InvalidReservationError, RatePlanNotAvailableError } from '../domain/errors.js';
import type { ICustomerRateRepository } from '../clientes-finanzas/customer-rate.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type { ICategoryRepository } from './category.repository.js';
import type { IDepositPolicyRepository } from './deposit-policy.repository.js';

export class ReservationPricingService {
  constructor(
    private readonly customerRateRepository:    ICustomerRateRepository,
    private readonly bookableServiceRepository: IBookableServiceRepository,
    private readonly categoryRepository:        ICategoryRepository,
    /**
     * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md)
     * -- resuelve el % de seña. Opcional para no romper callers que todavía
     * no la necesitan (tests unitarios de la cascada de precio, que no
     * llaman a `resolveDepositAmount()`); `resolveDepositAmount()` explota
     * si se invoca sin haberla inyectado.
     */
    private readonly depositPolicyRepository?: IDepositPolicyRepository,
  ) {}

  /**
   * Monto de seña para una reserva de ALOJAMIENTO/TURNOS (resourceId) o
   * SERVICIOS (serviceId) -- mismo criterio de especificidad que la
   * cascada de precio: política de `deposit_policies` más específica
   * (ítem > categoría > bucket) o, si no hay ninguna activa, el default
   * general del negocio (`business_profile.default_deposit_percentage`).
   * Sin ninguna de las dos, `0` -- confirmado con el dueño (22/08/2026):
   * sin política de seña configurada, `confirmReservation()` sigue sin
   * exigir ningún pago previo, exactamente como siempre. `0` no es un
   * caso especial: con `deposit=0` la cascada de CHARGE en
   * `handleReservationConfirmed` (outbox.handlers.ts) crea una sola
   * CHARGE por el saldo (=`totalPrice`), PENDING -- el mismo camino de
   * siempre, sin rama aparte. Redondeo a centavos, mismo criterio que
   * `resolveRateAmount()`.
   */
  async resolveDepositAmount(params: {
    resourceId: string;
    serviceId: string | undefined;
    resource: PhysicalResource;
    service: BookableService | null;
    totalPrice: number;
    defaultDepositPercentage: number | null;
  }): Promise<number> {
    if (!this.depositPolicyRepository) {
      throw new Error('resolveDepositAmount(): IDepositPolicyRepository no fue inyectado en ReservationPricingService.');
    }
    if (params.totalPrice <= 0) return 0;

    let percentage: number | null = null;

    if (params.serviceId) {
      const policy = await this.depositPolicyRepository.findActiveForService(
        params.serviceId,
        params.service?.categoryId ?? '',
      );
      percentage = policy?.percentage ?? null;
    } else {
      const resourceCategory = await this.categoryRepository.findById(params.resource.categoryId);
      const policy = await this.depositPolicyRepository.findActiveForResource(
        params.resourceId,
        params.resource.categoryId,
        resourceCategory?.isLodging ?? false,
      );
      percentage = policy?.percentage ?? null;
    }

    percentage ??= params.defaultDepositPercentage;
    if (percentage == null) return 0;

    return Math.round(params.totalPrice * (percentage / 100) * 100) / 100;
  }

  /**
   * Resuelve el precio a cobrar Y su desglose en `ReservationLine`s (una
   * por noche si `bookingMode: 'block'`, una única línea para todo lo
   * demás — ver reservation_lines en db/schema.sql).
   *
   * El precio UNITARIO (por noche o por turno) se resuelve con el mismo
   * orden que antes: tarifa especial de cliente+servicio > precio de
   * catálogo del servicio > tarifa especial de cliente+recurso > precio
   * base del recurso. Todas las líneas de una misma reserva reciben hoy el
   * mismo precio unitario — no existe (todavía) nada que lo varíe por
   * fecha dentro de la misma reserva; `buildLines()` es la estructura que
   * lo permitiría el día que exista un motor de tarifas por temporada, no
   * ese motor en sí. `totalPrice` es la suma de las líneas, no un cálculo
   * aparte — evita que las dos cosas puedan desincronizarse.
   */
  async resolvePrice(params: {
    customerId: string;
    resourceId: string;
    serviceId: string | undefined;
    ratePlanId: string | undefined;
    resource: PhysicalResource;
    service: BookableService | null;
    startTime: Date;
    endTime: Date;
  }): Promise<{
    totalPrice: number;
    lines: Array<{ unitDate: Date; price: number }>;
    /** D7 (22/08/2026) -- qué CustomerRate se aplicó, si hubo alguna. Ver docblock de resolveUnitPrice(). */
    appliedCustomerRateId: string | null;
  }> {
    // 'block' cotiza por noche (calculateNights). 'slot' y 'event' cotizan
    // como 1 unidad -- precio plano por turno o por evento completo, no
    // por día/noche. Para 'event' esto es una decisión explícita
    // (confirmada con el dueño, 18/08/2026, docs/auditoria-modularidad.md
    // Fase 4): un evento (ej. salón o mesa reservada en exclusiva) se
    // cobra como un bloque único con precio fijo, sea cual sea su
    // duración real -- no como una serie de unidades repetidas.
    const units = params.service?.bookingMode === 'block'
      ? this.calculateNights(params.startTime, params.endTime)
      : 1;

    const { unitPrice, appliedCustomerRateId } = await this.resolveUnitPrice(params);
    const lines = this.buildLines(params.startTime, units, unitPrice);
    const totalPrice = lines.reduce((sum, line) => sum + line.price, 0);

    return { totalPrice, lines, appliedCustomerRateId };
  }

  /**
   * Cascada de precio (spec de mejoras PMS, 18/08/2026 — agrega el escalón
   * de `ratePlanId`, ver docs/pendientes-2026-08-18.md punto M):
   * tarifa especial cliente+servicio > tarifa elegida (`ratePlanId`) >
   * precio de catálogo del servicio > tarifa especial cliente+recurso >
   * precio base del recurso. La tarifa especial de cliente sigue ganando
   * primero a propósito — es un descuento ya negociado, no debería perderse
   * porque alguien eligió una tarifa pública en el medio.
   */
  private async resolveUnitPrice(params: {
    customerId: string;
    resourceId: string;
    serviceId: string | undefined;
    ratePlanId: string | undefined;
    resource: PhysicalResource;
    service: BookableService | null;
    startTime?: Date;
    endTime?: Date;
  }): Promise<{ unitPrice: number; appliedCustomerRateId: string | null }> {
    if (params.serviceId) {
      // categoryId del SERVICIO -- '' si `service` no vino cargado (mismo
      // caso ya tolerado por requireServicePrice más abajo). '' nunca
      // matchea un category_id real, así que el nivel CATEGORÍA
      // simplemente no aporta candidatas en ese caso -- ítem y bucket
      // ('SERVICIOS') siguen funcionando igual.
      const serviceRate = await this.customerRateRepository.findActiveForCustomerAndService(
        params.customerId,
        params.serviceId,
        params.service?.categoryId ?? '',
      );
      if (serviceRate) {
        // El % se aplica contra el precio de CATÁLOGO del servicio (no
        // contra la tarifa elegida ni el precio base del recurso) -- es el
        // mismo escalón que ganaría si esta tarifa especial no existiera
        // (ver cascada en el docblock de la clase). D9: esto NO cambia por
        // el nivel del scope (ítem/categoría/bucket) -- el eje servicio
        // sigue ganando entre ejes con cualquier nivel (decisión
        // confirmada con el dueño, docs/diseno-scope-multinivel-tarifas-2026-08-22.md).
        return {
          unitPrice: this.resolveRateAmount(serviceRate, this.requireServicePrice(params)),
          appliedCustomerRateId: serviceRate.id,
        };
      }

      if (params.ratePlanId) {
        // ratePlanId es un escalón DISTINTO de CustomerRate (D7,
        // 22/08/2026) -- elegir un rate_plan público no es un descuento
        // negociado, así que no cuenta como "tarifa aplicada" para ese reporte.
        return {
          unitPrice: await this.resolveRatePlanPrice(params.ratePlanId, params.startTime, params.endTime),
          appliedCustomerRateId: null,
        };
      }

      if (params.service) return { unitPrice: params.service.price, appliedCustomerRateId: null };
    }

    const resourceCategory = await this.categoryRepository.findById(params.resource.categoryId);
    const resourceRate = await this.customerRateRepository.findActiveForCustomerAndResource(
      params.customerId,
      params.resourceId,
      params.resource.categoryId,
      resourceCategory?.isLodging ?? false,
    );
    if (resourceRate) {
      return {
        unitPrice: this.resolveRateAmount(resourceRate, params.resource.basePrice),
        appliedCustomerRateId: resourceRate.id,
      };
    }

    return { unitPrice: params.resource.basePrice, appliedCustomerRateId: null };
  }

  /**
   * D5 (pendientes-2026-08-19.md) -- una CustomerRate es un monto fijo O un
   * % de descuento contra `basePrice` (chk_customer_rate_pricing_mode,
   * schema.sql garantiza exactamente uno de los dos). Redondeo a centavos
   * -- mismo criterio que invoice.service.ts (Math.round(n*100)/100), la
   * plata nunca se deja con arrastre de flotante.
   */
  private resolveRateAmount(rate: { fixedPrice: number | null; discountPercentage: number | null }, basePrice: number): number {
    if (rate.fixedPrice !== null) return rate.fixedPrice;
    return Math.round(basePrice * (1 - rate.discountPercentage! / 100) * 100) / 100;
  }

  /**
   * Base para calcular un % de descuento de SERVICIO -- distinta de
   * `resource.basePrice` (que ya viene siempre garantizado en `params`).
   * `params.service` puede ser null en la práctica (ver el fallback de la
   * línea de abajo en el caso sin tarifa especial) -- con un % activo eso
   * ya no es un caso silencioso: sin precio de catálogo no hay contra qué
   * calcular el descuento, así que se corta con un error claro en vez de
   * inventar una base (0, basePrice del recurso, etc.).
   */
  private requireServicePrice(params: { serviceId: string | undefined; service: BookableService | null }): number {
    if (!params.service) {
      throw new InvalidReservationError(
        `No se pudo resolver el precio de catálogo del servicio "${params.serviceId}" para calcular el % de descuento de la tarifa especial.`,
      );
    }
    return params.service.price;
  }

  /**
   * Valida que la tarifa elegida exista, esté activa, y que el rango de la
   * reserva caiga dentro de su vigencia (`validFrom`/`validTo`, fechas de
   * calendario) — chequea la fecha de INICIO únicamente; una estadía que
   * empieza dentro de la vigencia pero termina después queda fuera de
   * alcance de esta pasada (simplificación deliberada, mismo criterio que
   * el resto de "no resolver todos los bordes sin caso de uso real").
   */
  private async resolveRatePlanPrice(ratePlanId: string, startTime: Date | undefined, _endTime: Date | undefined): Promise<number> {
    const ratePlan = await this.bookableServiceRepository.findRatePlanById(ratePlanId);
    if (!ratePlan) throw new RatePlanNotAvailableError(ratePlanId, 'no existe');
    if (!ratePlan.active) throw new RatePlanNotAvailableError(ratePlanId, 'está desactivada');

    if (startTime) {
      const dateStr = startTime.toISOString().slice(0, 10);
      if (ratePlan.validFrom && dateStr < ratePlan.validFrom) {
        throw new RatePlanNotAvailableError(ratePlanId, `no es válida hasta ${ratePlan.validFrom}`);
      }
      if (ratePlan.validTo && dateStr > ratePlan.validTo) {
        throw new RatePlanNotAvailableError(ratePlanId, `dejó de ser válida el ${ratePlan.validTo}`);
      }
    }

    return ratePlan.price;
  }

  /**
   * `unitDate` de cada línea: día calendario de `startTime` + i. Se calcula
   * en UTC — mismo criterio que `calculateNights()` — para no depender de
   * la zona horaria del proceso.
   */
  private buildLines(
    startTime: Date,
    units: number,
    unitPrice: number,
  ): Array<{ unitDate: Date; price: number }> {
    const lines: Array<{ unitDate: Date; price: number }> = [];
    for (let i = 0; i < units; i++) {
      const unitDate = new Date(Date.UTC(
        startTime.getFullYear(),
        startTime.getMonth(),
        startTime.getDate() + i,
      ));
      lines.push({ unitDate, price: unitPrice });
    }
    return lines;
  }

  /**
   * Cantidad de noches entre dos fechas, contando por día calendario (no por
   * bloques de 24hs exactas) — un check-in a las 15:00 y check-out a las
   * 10:00 del día siguiente son 1 noche, no 0.79. Mínimo 1: una reserva de
   * alojamiento con checkout el mismo día de checkin no es válida.
   */
  private calculateNights(startTime: Date, endTime: Date): number {
    const start = Date.UTC(startTime.getFullYear(), startTime.getMonth(), startTime.getDate());
    const end   = Date.UTC(endTime.getFullYear(), endTime.getMonth(), endTime.getDate());
    const nights = Math.round((end - start) / 86_400_000);

    if (nights < 1) {
      throw new InvalidReservationError(
        'Una reserva por noches debe tener al menos 1 noche (checkout posterior a checkin)',
      );
    }

    return nights;
  }
}
