/**
 * @file reservation-pricing.service.test.ts
 * @description D-1 (docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §8
 * "D-1" — cerrado como no-op estructural, con test de regresión, Ronda 16,
 * revierte D-1'/D-1) — test de regresión que reemplaza la columna
 * `priced_with_resource_id`/`resource_price_frozen` descartada: para una
 * reserva de ALOJAMIENTO con `serviceId`, el precio NUNCA depende del
 * `resourceId` puntual asignado — el recurso HABILITA, el servicio es lo
 * que se vende y se cobra (docs/diseno-precio-servicio-vs-recurso-2026-08-27.md).
 *
 * Objetivo: que este archivo falle el día que `resolveUnitPrice()` (o el
 * método que en ese momento resuelva el componente de precio de una
 * reserva de alojamiento con servicio) empiece a leer
 * `resourceId`/`resource.basePrice` para ese cálculo — forzando, en ese
 * momento, a retomar el diseño de "congelar qué recurso se usó para
 * cotizar" en vez de dejarlo pasar en silencio.
 *
 * Archivo nuevo (G-2.2, gate 18) — no existía ningún test unitario dedicado
 * a `ReservationPricingService` antes de este, pese a que su propio
 * docblock ya mencionaba "tests unitarios de la cascada de precio".
 * Construye `ReservationPricingService` en aislamiento (3-4 dependencias
 * por constructor, sin locks ni transacción) — no pasa por
 * `ReservationService`/`createReservation()` completo (eso lo cubren los
 * 19 tests de `reservation.service.test.ts`, describe `D9-Parte 1`, que
 * siguen siendo la cerca de "el precio de alojamiento entra por la rama de
 * servicio"; este archivo es la cerca de "el precio de alojamiento NO
 * varía por `resourceId`", una capa más abajo y más barata de correr).
 *
 * Si este test se rompe, el precio de alojamiento con servicio empezó a
 * depender del recurso puntual asignado — retomar el diseño de "congelar
 * qué recurso se usó para cotizar" antes de seguir
 * (docs/diseno-reserva-por-tipo-unidad-2026-09-24.md, §8 "D-1", Ronda 16,
 * 25/09/2026 — reemplaza D-1'/D-1, descartadas por redundancia con
 * resource_id; decisión de origen: docs/diseno-precio-servicio-vs-recurso-2026-08-27.md).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ReservationPricingService } from './reservation-pricing.service.js';
import { PhysicalResource } from './resource.entities.js';
import { InMemoryCustomerRateRepository } from '../clientes-finanzas/in-memory.customer-rate.repository.js';
import { InMemoryBookableServiceRepository } from './in-memory.bookable-service.repository.js';
import type { ICategoryRepository } from './category.repository.js';
import type { BookableService } from './bookable-service.types.js';

/** Categoría de ALOJAMIENTO única — todo este archivo cotiza sobre ella. */
class LodgingCategoryRepository implements ICategoryRepository {
  async findById() {
    return {
      id: 'cat-lodging', name: 'Habitaciones', fields: [], active: true,
      isLodging: true, isExclusive: true, createdAt: new Date(), updatedAt: new Date(),
    };
  }
  async findAll() { return []; }
  async countActive() { return 0; }
  async create(): Promise<never> { throw new Error('no usado en estos tests'); }
  async update(): Promise<never> { throw new Error('no usado en estos tests'); }
  async deactivate() {}
}

const CUSTOMER_ID = 'cust-1';
const SERVICE_ID = 'svc-estadia';
const SERVICE_CATALOG_PRICE = 80;

// Dos recursos de la MISMA categoría, `basePrice` deliberadamente DISTINTO
// entre sí — la diferencia es la que haría fallar el test si el precio
// empezara a depender del recurso.
const resourceA = new PhysicalResource('room-a', 'Habitación A', 100, 'cat-lodging');
const resourceB = new PhysicalResource('room-b', 'Habitación B', 500, 'cat-lodging');

const service: BookableService = {
  id: SERVICE_ID, categoryId: 'cat-lodging', name: 'Estadía',
  bookingMode: 'block', durationMinutes: null, price: SERVICE_CATALOG_PRICE,
  active: true, createdAt: new Date(), updatedAt: new Date(),
};

// bookingMode: 'block' cotiza por NOCHE — 2 noches (no 1), a propósito
// (G-2.4, gate 18): comparar `totalPrice` directo contra el precio
// esperado de una sola noche daría un falso-rojo con más de 1 noche. La
// aserción real de este archivo es por LÍNEA, no por `totalPrice`.
const START = new Date('2026-07-01T00:00:00Z');
const END   = new Date('2026-07-03T00:00:00Z'); // 2 noches

function baseParams(resource: PhysicalResource, ratePlanId?: string) {
  return {
    customerId: CUSTOMER_ID,
    resourceId: resource.id,
    serviceId: SERVICE_ID,
    ratePlanId,
    resource,
    service,
    startTime: START,
    endTime: END,
  };
}

describe('ReservationPricingService — D-1: precio de alojamiento con servicio NO depende del resourceId', () => {
  let customerRateRepo: InMemoryCustomerRateRepository;
  let bookableServiceRepo: InMemoryBookableServiceRepository;
  let categoryRepo: LodgingCategoryRepository;
  let pricing: ReservationPricingService;

  beforeEach(() => {
    customerRateRepo = new InMemoryCustomerRateRepository();
    bookableServiceRepo = new InMemoryBookableServiceRepository();
    categoryRepo = new LodgingCategoryRepository();
    pricing = new ReservationPricingService(customerRateRepo, bookableServiceRepo, categoryRepo);
  });

  // -------------------------------------------------------------------
  // Sub-rama (iii) — precio de catálogo del servicio (sin CustomerRate,
  // sin ratePlanId).
  // -------------------------------------------------------------------
  describe('sub-rama (iii): precio de catálogo', () => {
    it('cotiza al precio de catálogo del servicio, IGUAL sin importar el recurso', async () => {
      const resultA = await pricing.resolvePrice(baseParams(resourceA));
      const resultB = await pricing.resolvePrice(baseParams(resourceB));

      expect(resultA.lines).toHaveLength(2);
      expect(resultA.lines.every((l) => l.price === SERVICE_CATALOG_PRICE)).toBe(true);
      expect(resultB.lines.every((l) => l.price === SERVICE_CATALOG_PRICE)).toBe(true);
      expect(resultA.totalPrice).toBe(resultB.totalPrice);
      expect(resultA.totalPrice).toBe(SERVICE_CATALOG_PRICE * 2);
    });
  });

  // -------------------------------------------------------------------
  // Sub-rama (i) — tarifa especial cliente+servicio con % de descuento.
  // Mismo patrón que el test D5 ya existente en reservation.service.test.ts
  // (discountPercentage: 25 sobre un catálogo de 40 -> 30): acá, 25% sobre
  // 80 -> 60.
  // -------------------------------------------------------------------
  describe('sub-rama (i): tarifa cliente+servicio con % de descuento', () => {
    beforeEach(() => {
      customerRateRepo.seed([{
        id: 'rate-svc-1', businessId: 'biz-1', customerId: CUSTOMER_ID,
        resourceId: null, serviceId: SERVICE_ID, productId: null, categoryId: null, bucket: null,
        fixedPrice: null, discountPercentage: 25, rateCatalogId: null, active: true,
      }]);
    });

    it('cotiza el % de descuento sobre el precio de CATÁLOGO del servicio, NUNCA sobre resource.basePrice', async () => {
      const expected = 80 * (1 - 25 / 100); // 60

      const resultA = await pricing.resolvePrice(baseParams(resourceA));
      const resultB = await pricing.resolvePrice(baseParams(resourceB));

      expect(resultA.lines.every((l) => l.price === expected)).toBe(true);
      expect(resultB.lines.every((l) => l.price === expected)).toBe(true);
      expect(resultA.appliedCustomerRateId).toBe('rate-svc-1');
      expect(resultA.totalPrice).toBe(resultB.totalPrice);
    });
  });

  // -------------------------------------------------------------------
  // Sub-rama (ii) — ratePlanId elegido.
  // -------------------------------------------------------------------
  describe('sub-rama (ii): ratePlanId', () => {
    const RATE_PLAN_PRICE = 120;

    beforeEach(() => {
      // validFrom/validTo null = sin límite de fecha -- cubre las 2 noches
      // del rango del test con un único valor conocido de antemano.
      bookableServiceRepo.seedRatePlan({
        id: 'rp-1', serviceId: SERVICE_ID, name: 'Con desayuno', price: RATE_PLAN_PRICE,
        includesBreakfast: true, cancellationPolicy: null, validFrom: null, validTo: null,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
    });

    it('cotiza al precio del rate plan elegido, IGUAL sin importar el recurso', async () => {
      const resultA = await pricing.resolvePrice(baseParams(resourceA, 'rp-1'));
      const resultB = await pricing.resolvePrice(baseParams(resourceB, 'rp-1'));

      expect(resultA.lines.every((l) => l.price === RATE_PLAN_PRICE)).toBe(true);
      expect(resultB.lines.every((l) => l.price === RATE_PLAN_PRICE)).toBe(true);
      expect(resultA.totalPrice).toBe(resultB.totalPrice);
      expect(resultA.totalPrice).toBe(RATE_PLAN_PRICE * 2);
    });
  });

  // -------------------------------------------------------------------
  // Caso adicional (G-2.3, gate 18) — demuestra que el escalón de tarifa
  // cliente+RECURSO queda inalcanzable para alojamiento: toda reserva de
  // alojamiento SIEMPRE tiene serviceId, así que la cascada retorna dentro
  // del bloque `if (params.serviceId)` sin llegar nunca al escalón de
  // `findActiveForCustomerAndResource()`.
  // -------------------------------------------------------------------
  describe('escalón de tarifa cliente+RECURSO — inalcanzable para alojamiento', () => {
    beforeEach(() => {
      customerRateRepo.seed([{
        id: 'rate-resource-a', businessId: 'biz-1', customerId: CUSTOMER_ID,
        resourceId: resourceA.id, serviceId: null, productId: null, categoryId: null, bucket: null,
        fixedPrice: 999, discountPercentage: null, rateCatalogId: null, active: true,
      }]);
    });

    it('el precio es IDÉNTICO al de la sub-rama activa (catálogo), incluso consultando exactamente el recurso que la tarifa apunta', async () => {
      const resultA = await pricing.resolvePrice(baseParams(resourceA));
      const resultB = await pricing.resolvePrice(baseParams(resourceB));

      // La tarifa de $999 fijo sobre resourceA se ignora por completo --
      // el precio sigue siendo el de catálogo del servicio (sub-rama iii).
      expect(resultA.lines.every((l) => l.price === SERVICE_CATALOG_PRICE)).toBe(true);
      expect(resultA.appliedCustomerRateId).toBeNull();
      expect(resultA.totalPrice).toBe(resultB.totalPrice);
    });
  });
});
