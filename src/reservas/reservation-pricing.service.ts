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
import type { BookableService, RatePlan } from './bookable-service.types.js';
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
   * El precio se resuelve con el mismo orden que antes: tarifa especial de
   * cliente+servicio > tarifa elegida (`ratePlanId`) > precio de catálogo
   * del servicio > tarifa especial de cliente+recurso > precio base del
   * recurso. Cuando el escalón que gana es una tarifa elegida (`ratePlanId`)
   * de un servicio `block`, el precio se resuelve POR NOCHE contra la fecha
   * de cada línea (temporada, 28/08/2026, pendientes-2026-08-27.md ítem 5 —
   * antes era el mismo precio para todas las noches, resuelto una sola vez
   * contra el inicio de la reserva; una estadía que cruzaba un cambio de
   * temporada cobraba TODAS las noches a la tarifa del día de entrada). Los
   * demás escalones (tarifa de cliente, catálogo, precio base) siguen sin
   * variar por fecha — no tienen concepto de temporada, ver
   * resolveUnitPrice(). `totalPrice` es la suma de las líneas, no un
   * cálculo aparte — evita que las dos cosas puedan desincronizarse.
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

    const { priceForDate, appliedCustomerRateId } = await this.resolveUnitPrice(params);
    const lines = this.buildLines(params.startTime, units, priceForDate);
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
  }): Promise<{ priceForDate: (unitDate: Date) => number; appliedCustomerRateId: string | null }> {
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
        // Sin variación por fecha -- un descuento negociado por cliente no
        // tiene concepto de temporada.
        const amount = this.resolveRateAmount(serviceRate, this.requireServicePrice(params));
        return { priceForDate: () => amount, appliedCustomerRateId: serviceRate.id };
      }

      if (params.ratePlanId) {
        // ratePlanId es un escalón DISTINTO de CustomerRate (D7,
        // 22/08/2026) -- elegir un rate_plan público no es un descuento
        // negociado, así que no cuenta como "tarifa aplicada" para ese
        // reporte.
        //
        // Temporada (28/08/2026) -- el operador elige un PLAN por NOMBRE
        // (ej. "Con desayuno"), no una fila puntual: pueden existir varias
        // filas activas con ese mismo (service_id, name), cada una vigente
        // en un rango de fechas distinto (excl_rate_plans_overlapping_
        // validity en schema.sql garantiza que nunca se solapan). Se
        // resuelven TODAS acá, UNA sola vez (no una consulta por noche) --
        // resolveSeasonalPrice() elige, para cada unitDate, la fila
        // vigente esa fecha.
        const chosenPlan = await this.bookableServiceRepository.findRatePlanById(params.ratePlanId);
        if (!chosenPlan) throw new RatePlanNotAvailableError(params.ratePlanId, 'no existe');
        if (!chosenPlan.active) throw new RatePlanNotAvailableError(params.ratePlanId, 'está desactivada');

        const siblings = await this.bookableServiceRepository.findRatePlansByService(chosenPlan.serviceId);
        const seasonRows = siblings.filter((rp) => rp.name.toLowerCase() === chosenPlan.name.toLowerCase());
        const fallbackPrice = this.requireServicePrice(params);

        return {
          priceForDate: (unitDate) => this.resolveSeasonalPrice(seasonRows, unitDate, fallbackPrice),
          appliedCustomerRateId: null,
        };
      }

      if (params.service) {
        const price = params.service.price;
        return { priceForDate: () => price, appliedCustomerRateId: null };
      }
    }

    const resourceCategory = await this.categoryRepository.findById(params.resource.categoryId);
    const resourceRate = await this.customerRateRepository.findActiveForCustomerAndResource(
      params.customerId,
      params.resourceId,
      params.resource.categoryId,
      resourceCategory?.isLodging ?? false,
    );
    if (resourceRate) {
      const amount = this.resolveRateAmount(resourceRate, params.resource.basePrice);
      return { priceForDate: () => amount, appliedCustomerRateId: resourceRate.id };
    }

    const basePrice = params.resource.basePrice;
    return { priceForDate: () => basePrice, appliedCustomerRateId: null };
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
   * Temporada (28/08/2026) — para UNA noche puntual, busca entre
   * `seasonRows` (todas las filas activas que comparten (service_id, name)
   * con el plan elegido por el operador/cliente) la que tiene vigencia
   * sobre esa fecha. `validFrom`/`validTo` son fechas de calendario
   * (YYYY-MM-DD), INCLUSIVE en los dos extremos — comparación por string
   * ISO, mismo criterio que ya usaba la versión anterior de este chequeo
   * (`resolveRatePlanPrice()`, ahora reemplazado). NULL en cualquier
   * extremo = sin límite de ese lado. `excl_rate_plans_overlapping_validity`
   * (schema.sql) garantiza que nunca hay dos filas del mismo nombre
   * vigentes la misma fecha -- como mucho una matchea.
   *
   * Sin ninguna fila que cubra la fecha (hueco de configuración -- nadie
   * cargó la temporada de esa noche), cae al precio de CATÁLOGO del
   * servicio (`fallbackPrice`) -- mismo fallback que ya existía para "sin
   * ratePlanId elegido en absoluto". Un hueco puntual en una noche no debe
   * romper la cotización completa de la estadía (A3.x: nunca 0/null).
   */
  private resolveSeasonalPrice(seasonRows: RatePlan[], unitDate: Date, fallbackPrice: number): number {
    const dateStr = unitDate.toISOString().slice(0, 10);
    const match = seasonRows.find((rp) =>
      (!rp.validFrom || dateStr >= rp.validFrom) && (!rp.validTo || dateStr <= rp.validTo),
    );
    return match ? match.price : fallbackPrice;
  }

  /**
   * `unitDate` de cada línea: día calendario de `startTime` + i. Se calcula
   * en UTC — mismo criterio que `calculateNights()` — para no depender de
   * la zona horaria del proceso. `priceForDate()` puede variar por noche
   * (temporada, 28/08/2026) o ser constante (el resto de los escalones de
   * la cascada) — ver resolveUnitPrice().
   */
  private buildLines(
    startTime: Date,
    units: number,
    priceForDate: (unitDate: Date) => number,
  ): Array<{ unitDate: Date; price: number }> {
    const lines: Array<{ unitDate: Date; price: number }> = [];
    for (let i = 0; i < units; i++) {
      const unitDate = new Date(Date.UTC(
        startTime.getFullYear(),
        startTime.getMonth(),
        startTime.getDate() + i,
      ));
      lines.push({ unitDate, price: priceForDate(unitDate) });
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
