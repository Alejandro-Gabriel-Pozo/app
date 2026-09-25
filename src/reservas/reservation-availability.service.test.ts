import { describe, it, expect, beforeEach } from 'vitest';
import { BookableResource } from './resource.entities.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { Reservation } from './Reservation.js';
import { ReservationAvailabilityService } from './reservation-availability.service.js';
import { InMemoryReservationRepository } from './in-memory.reservation.repository.js';
import { InMemoryResourceRepository } from './in-memory.resource.repository.js';
import { InMemoryOccupancyRepository } from './in-memory.occupancy.repository.js';
import { InMemoryResourceLockRepository } from './in-memory.resource-lock.repository.js';
import { InMemoryBookableServiceRepository } from './in-memory.bookable-service.repository.js';
import { InMemoryMaintenanceWindowRepository } from '../pms-estadias/in-memory.maintenance-window.repository.js';
import { InvalidReservationError } from '../domain/errors.js';
import type { ICategoryRepository } from './category.repository.js';
import type { ResourceCategory } from './resource-category.types.js';
import type { SqlClient } from '../repositories/sql.client.js';

/**
 * Bug 1 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md sección
 * 5.2) — cupo compartido: un recurso con `capacity > 1` cuya categoría
 * tiene `isExclusive = false` debe permitir varias reservas simultáneas
 * hasta llenar `capacity`, contando por `partySize` en vez de bloquear
 * ante cualquier solapamiento.
 */

/** Categoría configurable por test — mismo patrón que category.service.test.ts. */
class FakeCategoryRepository implements ICategoryRepository {
  constructor(private readonly categories: Map<string, ResourceCategory>) {}
  async findById(id: string) { return this.categories.get(id) ?? null; }
  async findAll() { return [...this.categories.values()]; }
  async countActive() { return this.categories.size; }
  async create(): Promise<never> { throw new Error('no usado en este test'); }
  async update(): Promise<never> { throw new Error('no usado en este test'); }
  async deactivate() {}
}

function makeCategory(id: string, isExclusive: boolean, isLodging = false): ResourceCategory {
  const now = new Date();
  return { id, name: id, fields: [], active: true, isLodging, isExclusive, createdAt: now, updatedAt: now };
}

const businessProfileRepo = {
  async get() {
    return {
      id: 'default', displayName: null, contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires',
      defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
      legalName: null, taxId: null, taxIdType: null, taxCondition: null,
      fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
      fiscalAddressPostalCode: null, fiscalAddressCountry: null,
      afipSalesPoint: null, afipCuit: null,
      defaultIvaRate: 21, pricesIncludeIva: true,
      defaultDepositPercentage: null, depositHoldHours: null,
      customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
      createdAt: new Date(), updatedAt: new Date(),
    };
  },
};

const noopClient: SqlClient = { async query() { return { rows: [], rowCount: 0 }; } };

const customer = new Customer('cust-1', 'Ana García', 'ana@example.com');

function makeReservation(id: string, resource: BookableResource, partySize: number, startTime: Date, endTime: Date): Reservation {
  return new Reservation({
    id, customer, resource, startTime, endTime, details: {},
    totalPrice: 100, reservationNumber: 1, appliedCustomerRateId: null,
    assignmentStatus: 'ASSIGNED',
    partySize,
  });
}

describe('ReservationAvailabilityService — cupo compartido (Bug 1)', () => {
  let resourceRepo: InMemoryResourceRepository;
  let reservationRepo: InMemoryReservationRepository;
  let resourceLockRepo: InMemoryResourceLockRepository;
  let categories: Map<string, ResourceCategory>;
  let service: ReservationAvailabilityService;

  const start = new Date('2026-07-01T10:00:00Z');
  const end   = new Date('2026-07-01T12:00:00Z');

  beforeEach(() => {
    resourceRepo = new InMemoryResourceRepository();
    reservationRepo = new InMemoryReservationRepository();
    resourceLockRepo = new InMemoryResourceLockRepository();
    categories = new Map();

    service = new ReservationAvailabilityService(
      resourceRepo,
      resourceLockRepo,
      reservationRepo,
      new InMemoryMaintenanceWindowRepository(),
      new InMemoryOccupancyRepository(),
      new InMemoryBookableServiceRepository(),
      businessProfileRepo,
      new FakeCategoryRepository(categories),
    );
  });

  describe('recurso de cupo compartido (isExclusive = false)', () => {
    it('permite varias reservas hasta llenar capacity', async () => {
      categories.set('cat-tour', makeCategory('cat-tour', false));
      const tour = new BookableResource('tour-1', 'Tour a caballo', 100, 'cat-tour', null, 3);
      await resourceRepo.save(tour);
      await reservationRepo.save(makeReservation('r1', tour, 1, start, end));
      await reservationRepo.save(makeReservation('r2', tour, 1, start, end));

      // 2/3 ocupados, pide 1 más -- entra.
      await expect(
        service.assertAllResourcesAvailable(noopClient, ['tour-1'], start, end, undefined, 1),
      ).resolves.toBeUndefined();
    });

    it('rechaza cuando el partySize pedido supera el cupo restante', async () => {
      categories.set('cat-tour', makeCategory('cat-tour', false));
      const tour = new BookableResource('tour-1', 'Tour a caballo', 100, 'cat-tour', null, 3);
      await resourceRepo.save(tour);
      await reservationRepo.save(makeReservation('r1', tour, 2, start, end));

      // 2/3 ocupados, pide 2 más (llegaría a 4) -- rechaza.
      await expect(
        service.assertAllResourcesAvailable(noopClient, ['tour-1'], start, end, undefined, 2),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('una reserva COMPLETED no cuenta contra el cupo', async () => {
      categories.set('cat-tour', makeCategory('cat-tour', false));
      const tour = new BookableResource('tour-1', 'Tour a caballo', 100, 'cat-tour', null, 2);
      await resourceRepo.save(tour);
      const completed = makeReservation('r1', tour, 2, start, end);
      completed.confirm();
      completed.complete();
      await reservationRepo.save(completed);

      await expect(
        service.assertAllResourcesAvailable(noopClient, ['tour-1'], start, end, undefined, 2),
      ).resolves.toBeUndefined();
    });
  });

  describe('recurso exclusivo (isExclusive = true) — comportamiento binario sin cambios', () => {
    it('rechaza cualquier solapamiento sin importar capacity', async () => {
      categories.set('cat-room', makeCategory('cat-room', true));
      const room = new BookableResource('room-1', 'Habitación 1', 100, 'cat-room', null, 4);
      await resourceRepo.save(room);
      await reservationRepo.save(makeReservation('r1', room, 1, start, end));

      // partySize=1, muy por debajo de capacity=4 -- igual rechaza: exclusivo es binario.
      await expect(
        service.assertAllResourcesAvailable(noopClient, ['room-1'], start, end, undefined, 1),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('categoría no resuelta cae a exclusivo por default (conservador)', async () => {
      // Sin categoría cargada en el mapa -- findById() devuelve null.
      const room = new BookableResource('room-2', 'Habitación 2', 100, 'cat-inexistente', null, 4);
      await resourceRepo.save(room);
      await reservationRepo.save(makeReservation('r1', room, 1, start, end));

      await expect(
        service.assertAllResourcesAvailable(noopClient, ['room-2'], start, end, undefined, 1),
      ).rejects.toThrow(InvalidReservationError);
    });
  });

  describe('checkAvailability() — mismo criterio, versión de solo lectura', () => {
    it('cupo compartido: true mientras quede lugar, false cuando se llena', async () => {
      categories.set('cat-tour', makeCategory('cat-tour', false));
      const tour = new BookableResource('tour-1', 'Tour', 100, 'cat-tour', null, 2);
      await resourceRepo.save(tour);
      await reservationRepo.save(makeReservation('r1', tour, 1, start, end));

      expect(await service.checkAvailability('tour-1', start, end, undefined, undefined, 1)).toBe(true);
      expect(await service.checkAvailability('tour-1', start, end, undefined, undefined, 2)).toBe(false);
    });
  });

  /**
   * Fase 0 (docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6) —
   * `countAvailableInCategory()`, el método que sostiene
   * `GET /reservations/availability-by-category`. Todas las categorías de
   * este `describe` se crean con `isLodging: true` (tercer argumento de
   * `makeCategory()`) — es el único caso dentro de alcance del endpoint
   * (422 `CATEGORY_NOT_LODGING` si no lo es, chequeado en el handler, no
   * acá — el método en sí no valida `isLodging`, ver su docblock).
   */
  describe('countAvailableInCategory() — Fase 0 (cupo restante por categoría)', () => {
    it('cuenta 0/0 para una categoría sin recursos', async () => {
      categories.set('cat-empty', makeCategory('cat-empty', true, true));
      const result = await service.countAvailableInCategory({
        categoryId: 'cat-empty',
        startTime: start,
        endTime: end,
      });
      expect(result).toEqual({ total: 0, available: 0 });
    });

    it('cuenta todos los recursos libres, no solo el primero (a diferencia de findAvailableResourceInCategory)', async () => {
      categories.set('cat-room', makeCategory('cat-room', true, true));
      const roomA = new BookableResource('room-a', 'Habitación A', 100, 'cat-room');
      const roomB = new BookableResource('room-b', 'Habitación B', 100, 'cat-room');
      await resourceRepo.save(roomA);
      await resourceRepo.save(roomB);
      // Ninguna reserva -- las dos están libres.

      const result = await service.countAvailableInCategory({
        categoryId: 'cat-room',
        startTime: start,
        endTime: end,
      });
      expect(result).toEqual({ total: 2, available: 2 });
    });

    /**
     * N4 (decisión del dueño vía `AskUserQuestion`, 24/09/2026, §6/§9 del
     * diseño) — "unidades libres para TODO el rango pedido", no un mínimo
     * por noche. Un recurso libre la PRIMERA noche pero ocupado la SEGUNDA
     * no cuenta como disponible -- si el conteo mirara solo el primer día
     * (la implementación "más simple/rápida" que el dueño rechazó), esta
     * habitación aparecería como libre cuando en realidad
     * `findAvailableResourceInCategory()`/`checkAvailability()` -- el mismo
     * mecanismo que usa el alta real -- la rechazarían.
     */
    it('N4 — un recurso ocupado solo en una noche del rango NO cuenta como disponible', async () => {
      categories.set('cat-room', makeCategory('cat-room', true, true));
      const roomFree    = new BookableResource('room-free', 'Libre todo el rango', 100, 'cat-room');
      const roomPartial = new BookableResource('room-partial', 'Ocupada la segunda noche', 100, 'cat-room');
      await resourceRepo.save(roomFree);
      await resourceRepo.save(roomPartial);

      // Rango pedido: 2 noches, 1-3 de agosto (checkout el 3).
      const rangeStart = new Date('2026-08-01T00:00:00Z');
      const rangeEnd   = new Date('2026-08-03T00:00:00Z');

      // roomPartial está libre la NOCHE 1 (1-2 ago) pero ocupada la NOCHE 2
      // (2-3 ago) -- una implementación "primer día" la contaría como libre.
      await reservationRepo.save(makeReservation(
        'r-partial', roomPartial, 1,
        new Date('2026-08-02T00:00:00Z'), new Date('2026-08-03T00:00:00Z'),
      ));

      const result = await service.countAvailableInCategory({
        categoryId: 'cat-room',
        startTime: rangeStart,
        endTime: rangeEnd,
      });

      // Mismo resultado que preguntarle a checkAvailability() por el rango
      // completo, uno por uno -- la garantía de equivalencia semántica del
      // diseño.
      expect(await service.checkAvailability('room-free', rangeStart, rangeEnd)).toBe(true);
      expect(await service.checkAvailability('room-partial', rangeStart, rangeEnd)).toBe(false);
      expect(result).toEqual({ total: 2, available: 1 });
    });

    /**
     * C-5 (Ronda 14, gate `architecture-governor` sobre el diseño) —
     * `serviceId` opcional, mismo comportamiento-por-omisión que
     * `findAvailableResourceInCategory()`/`checkAvailability()`: sin él, el
     * conteo no ve los recursos que un servicio bloquea vía
     * `resource_locks`, y puede contar como libre una unidad que el alta
     * real (con `serviceId`) rechazaría.
     */
    it('serviceId filtra por resource_locks del servicio -- sin él, el conteo puede sobreestimar', async () => {
      categories.set('cat-room', makeCategory('cat-room', true, true));
      const room = new BookableResource('room-1', 'Habitación con shuttle', 100, 'cat-room');
      // Recurso compartido que el servicio bloquea además de la habitación
      // (ej. un shuttle de traslado) -- categoría propia, no resuelta en el
      // mapa de test, cae a exclusivo por default (conservador).
      const shuttle = new BookableResource('shuttle-1', 'Shuttle', 0, 'cat-shuttle');
      await resourceRepo.save(room);
      await resourceRepo.save(shuttle);
      resourceLockRepo.seed([{ serviceId: 'svc-transfer', resourceId: 'shuttle-1', sortOrder: 0 }]);
      // El shuttle está ocupado en el rango pedido -- room-1 en sí está libre.
      await reservationRepo.save(makeReservation('r-shuttle', shuttle, 1, start, end));

      const withoutServiceId = await service.countAvailableInCategory({
        categoryId: 'cat-room',
        startTime: start,
        endTime: end,
      });
      expect(withoutServiceId).toEqual({ total: 1, available: 1 });

      const withServiceId = await service.countAvailableInCategory({
        categoryId: 'cat-room',
        startTime: start,
        endTime: end,
        serviceId: 'svc-transfer',
      });
      expect(withServiceId).toEqual({ total: 1, available: 0 });
    });

    it('rechaza un rango inválido (endTime <= startTime), mismo criterio que checkAvailability()', async () => {
      categories.set('cat-room', makeCategory('cat-room', true, true));
      await expect(
        service.countAvailableInCategory({ categoryId: 'cat-room', startTime: end, endTime: start }),
      ).rejects.toThrow(InvalidReservationError);
    });
  });
});
