/**
 * @file reservation-pricing.service.ts
 * @description Cascada de precio de una reserva — grupo "precios" extraído
 * de `reservation.service.ts` (Fase 6, docs/auditoria-modularidad.md,
 * hallazgo B1). Única razón de cambio: cómo se cotiza una reserva. No
 * toca disponibilidad, locks, ni el ciclo de vida de la reserva — eso
 * sigue en `ReservationService` (orquestador) y
 * `ReservationAvailabilityService`.
 */

import type { PhysicalResource } from './resource.entities.js';
import type { BookableService } from './bookable-service.types.js';
import { InvalidReservationError, RatePlanNotAvailableError } from '../domain/errors.js';
import type { ICustomerRateRepository } from '../clientes-finanzas/customer-rate.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';

export class ReservationPricingService {
  constructor(
    private readonly customerRateRepository:    ICustomerRateRepository,
    private readonly bookableServiceRepository: IBookableServiceRepository,
  ) {}

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
  }): Promise<{ totalPrice: number; lines: Array<{ unitDate: Date; price: number }> }> {
    const units = params.service?.bookingMode === 'block'
      ? this.calculateNights(params.startTime, params.endTime)
      : 1;

    const unitPrice = await this.resolveUnitPrice(params);
    const lines = this.buildLines(params.startTime, units, unitPrice);
    const totalPrice = lines.reduce((sum, line) => sum + line.price, 0);

    return { totalPrice, lines };
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
  }): Promise<number> {
    if (params.serviceId) {
      const serviceRate = await this.customerRateRepository.findActiveForCustomerAndService(
        params.customerId,
        params.serviceId,
      );
      if (serviceRate) return serviceRate.price;

      if (params.ratePlanId) {
        return this.resolveRatePlanPrice(params.ratePlanId, params.startTime, params.endTime);
      }

      if (params.service) return params.service.price;
    }

    const resourceRate = await this.customerRateRepository.findActiveForCustomerAndResource(
      params.customerId,
      params.resourceId,
    );
    if (resourceRate) return resourceRate.price;

    return params.resource.basePrice;
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
