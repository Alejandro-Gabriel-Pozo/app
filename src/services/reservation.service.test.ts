import { describe, it, expect, beforeEach } from 'vitest';
import { ReservationStatus } from '../types/enums.js';
import { BookableResource, Customer } from '../domain/entities.js';
import { ReservationService } from './reservation.service.js';
import { InMemoryReservationRepository } from '../repositories/in-memory.reservation.repository.js';
import { InMemoryResourceRepository } from '../repositories/in-memory.resource.repository.js';
import { InMemoryOccupancyRepository } from '../repositories/in-memory.occupancy.repository.js';
import { InMemoryResourceLockRepository } from '../repositories/in-memory.resource-lock.repository.js';
import { InMemoryBookableServiceRepository } from '../repositories/in-memory.bookable-service.repository.js';
import { InMemoryCustomerRateRepository } from '../repositories/in-memory.customer-rate.repository.js';
import { InMemoryOperatingHoursRepository } from '../repositories/in-memory.operating-hours.repository.js';
import { InMemoryHousekeepingRepository } from '../repositories/in-memory.housekeeping.repository.js';
import { HousekeepingTask } from '../domain/housekeeping-task.js';
import { InvalidReservationError, ResourceNotFoundError } from '../domain/errors.js';
import type { ICategoryRepository } from '../repositories/category.repository.js';
import type { DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

// ---------------------------------------------------------------------------
// Mocks mínimos para dependencias de infraestructura
// ---------------------------------------------------------------------------

/** No valida categorías — permite tests que no necesiten esa lógica. */
class NullCategoryRepository implements ICategoryRepository {
  async findById() { return null; }
  async findAll() { return []; }
  async countActive() { return 0; }
  async create(): Promise<never> { throw new Error('NullCategoryRepository.create() no implementado — no debería llamarse en estos tests.'); }
  async update(): Promise<never> { throw new Error('NullCategoryRepository.update() no implementado — no debería llamarse en estos tests.'); }
  async deactivate() {}
}

/** Acumula eventos en memoria para poder inspeccionarlos en los tests. */
class InMemoryDomainEventRepository implements DomainEventRepository {
  public events: unknown[] = [];

  async insertWithClient(_client: SqlClient, event: unknown): Promise<void> {
    this.events.push(event);
  }

  async getPending() { return []; }
  async markDispatched() {}
}

/**
 * Ejecuta el work directamente sin abrir una transacción real.
 * Suficiente para unit tests: lo que importa es que el servicio
 * llama a saveWithClient e insertWithClient de forma atómica.
 */
class InMemoryTransactionManager implements TransactionManager {
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const noopClient: SqlClient = {
      async query() { return { rows: [], rowCount: 0 }; },
    };
    return work(noopClient);
  }
}

// ---------------------------------------------------------------------------
// Suite principal
// ---------------------------------------------------------------------------

/** businessId de prueba — requerido desde fix/reservation-businessid-required. */
const TEST_BUSINESS_ID = 'biz-test';

describe('ReservationService', () => {
  let reservationRepo: InMemoryReservationRepository;
  let resourceRepo: InMemoryResourceRepository;
  let occupancyRepo: InMemoryOccupancyRepository;
  let categoryRepo: NullCategoryRepository;
  let eventRepo: InMemoryDomainEventRepository;
  let txManager: InMemoryTransactionManager;
  let lockRepo: InMemoryResourceLockRepository;
  let bookableServiceRepo: InMemoryBookableServiceRepository;
  let customerRateRepo: InMemoryCustomerRateRepository;
  let operatingHoursRepo: InMemoryOperatingHoursRepository;
  let housekeepingRepo: InMemoryHousekeepingRepository;
  let service: ReservationService;

  const table = new BookableResource('t1', 'Mesa Ventana', 50, 'cat-table', {
    shape: 'RECTANGLE',
    width: 120,
    height: 80,
    positionX: 0,
    positionY: 0,
    rotationDegrees: 0,
  });

  const customer = new Customer('cust-1', 'Ana García', 'ana@example.com');

  beforeEach(async () => {
    reservationRepo      = new InMemoryReservationRepository();
    resourceRepo         = new InMemoryResourceRepository();
    occupancyRepo         = new InMemoryOccupancyRepository();
    categoryRepo          = new NullCategoryRepository();
    eventRepo             = new InMemoryDomainEventRepository();
    txManager             = new InMemoryTransactionManager();
    lockRepo              = new InMemoryResourceLockRepository();
    bookableServiceRepo   = new InMemoryBookableServiceRepository();
    customerRateRepo      = new InMemoryCustomerRateRepository();
    operatingHoursRepo    = new InMemoryOperatingHoursRepository();
    housekeepingRepo      = new InMemoryHousekeepingRepository();

    service = new ReservationService(
      reservationRepo,
      resourceRepo,
      occupancyRepo,
      categoryRepo,
      eventRepo,
      txManager,
      lockRepo,
      bookableServiceRepo,
      customerRateRepo,
      operatingHoursRepo,
      housekeepingRepo,
    );

    await resourceRepo.save(table);
  });

  // -------------------------------------------------------------------------
  describe('createReservation', () => {
    it('debe crear una reserva cuando el recurso está disponible', async () => {
      const reservation = await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: { guests: 2 },
      });

      expect(reservation.id).toBe('res-1');
      expect(reservation.status).toBe(ReservationStatus.PENDING);
      expect(await reservationRepo.getById('res-1')).toBeDefined();
    });

    it('debe rechazar si el recurso no existe', async () => {
      await expect(
        service.createReservation({
          id: 'res-1',
          resourceId: 'missing',
          customer,
          startTime: new Date('2026-07-01T20:00:00'),
          endTime:   new Date('2026-07-01T22:00:00'),
          details: {},
        }),
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it('debe rechazar si hay solapamiento con otra reserva activa', async () => {
      await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });

      await expect(
        service.createReservation({
          id: 'res-2',
          resourceId: 't1',
          customer,
          startTime: new Date('2026-07-01T21:00:00'),
          endTime:   new Date('2026-07-01T23:00:00'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si el recurso está marcado OUT_OF_SERVICE por housekeeping', async () => {
      const task = HousekeepingTask.create({
        businessId: TEST_BUSINESS_ID,
        resourceId: 't1',
        shift: 'MORNING',
        scheduledFor: new Date('2026-07-01T08:00:00'),
      });
      task.setOutOfService('Cañería rota');
      housekeepingRepo.seed(task);

      await expect(
        service.createReservation({
          id: 'res-1',
          resourceId: 't1',
          customer,
          startTime: new Date('2026-07-01T20:00:00'),
          endTime:   new Date('2026-07-01T22:00:00'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    // docs/criterios-datos.md R2/R11: getById() ya no filtra por active,
    // así que este chequeo tiene que ser explícito en el servicio — antes
    // lo hacía gratis (y sin querer) el filtro implícito de getById().
    it('debe rechazar si el recurso está desactivado (active: false)', async () => {
      const inactiveTable = new BookableResource(
        't-inactive', 'Mesa Desactivada', 50, 'cat-table',
        { shape: 'RECTANGLE', width: 120, height: 80, positionX: 0, positionY: 0, rotationDegrees: 0 },
        1, null, null, null, /* active */ false,
      );
      await resourceRepo.save(inactiveTable);

      await expect(
        service.createReservation({
          id: 'res-1',
          resourceId: 't-inactive',
          customer,
          startTime: new Date('2026-07-01T20:00:00'),
          endTime:   new Date('2026-07-01T22:00:00'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });
  });

  // -------------------------------------------------------------------------
  describe('checkAvailability — recurso desactivado', () => {
    it('devuelve false (no lanza) para un recurso con active: false, mismo contrato que OUT_OF_SERVICE', async () => {
      const inactiveTable = new BookableResource(
        't-inactive', 'Mesa Desactivada', 50, 'cat-table',
        { shape: 'RECTANGLE', width: 120, height: 80, positionX: 0, positionY: 0, rotationDegrees: 0 },
        1, null, null, null, /* active */ false,
      );
      await resourceRepo.save(inactiveTable);

      const available = await service.checkAvailability(
        't-inactive',
        new Date('2026-07-01T20:00:00'),
        new Date('2026-07-01T22:00:00'),
      );

      expect(available).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('findAvailableResourceInCategory', () => {
    const table2 = new BookableResource('t2', 'Mesa Patio', 50, 'cat-table', {
      shape: 'RECTANGLE', width: 120, height: 80, positionX: 0, positionY: 0, rotationDegrees: 0,
    });

    beforeEach(async () => {
      await resourceRepo.save(table2);
    });

    it('devuelve el único recurso libre de la categoría cuando el otro está ocupado', async () => {
      // t1 queda ocupada 20:00-22:00
      await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });

      const found = await service.findAvailableResourceInCategory({
        categoryId: 'cat-table',
        startTime:  new Date('2026-07-01T20:00:00'),
        endTime:    new Date('2026-07-01T22:00:00'),
      });

      // Antes de este cambio, pedir directamente "t1" acá hubiera devuelto
      // "no disponible" — el punto de este método es que la categoría sí
      // tiene lugar (t2), aunque el primer candidato (t1) esté ocupado.
      expect(found?.id).toBe('t2');
    });

    it('devuelve null si ningún recurso de la categoría está libre', async () => {
      await service.createReservation({
        id: 'res-1', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });
      await service.createReservation({
        id: 'res-2', resourceId: 't2', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });

      const found = await service.findAvailableResourceInCategory({
        categoryId: 'cat-table',
        startTime:  new Date('2026-07-01T20:00:00'),
        endTime:    new Date('2026-07-01T22:00:00'),
      });

      expect(found).toBeNull();
    });

    it('el resourceId encontrado se puede usar directo en createReservation', async () => {
      await service.createReservation({
        id: 'res-1', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });

      const found = await service.findAvailableResourceInCategory({
        categoryId: 'cat-table',
        startTime:  new Date('2026-07-01T20:00:00'),
        endTime:    new Date('2026-07-01T22:00:00'),
      });

      const reservation = await service.createReservation({
        id: 'res-2',
        resourceId: found!.id,
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });

      expect(reservation.resource.id).toBe('t2');
    });
  });

  // -------------------------------------------------------------------------
  describe('confirmReservation', () => {
    it('debe confirmar, registrar ocupación y emitir evento', async () => {
      await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });

      // businessId es obligatorio desde fix/reservation-businessid-required.
      // Los eventos de dominio se persisten con este ID — no puede ser vacío.
      const confirmed = await service.confirmReservation('res-1', TEST_BUSINESS_ID);

      expect(confirmed.status).toBe(ReservationStatus.CONFIRMED);

      const snapshots = await occupancyRepo.getAllSnapshots();
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0]!.resourceId).toBe('t1');

      expect(eventRepo.events).toHaveLength(1);
      expect((eventRepo.events[0] as { eventType: string }).eventType)
        .toBe('reservation.confirmed');
    });
  });

  // -------------------------------------------------------------------------
  describe('completeReservation', () => {
    it('debe completar y emitir evento reservation.completed', async () => {
      await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });
      await service.confirmReservation('res-1', TEST_BUSINESS_ID);
      eventRepo.events = []; // reset — solo nos interesa el evento de complete

      // businessId es obligatorio desde fix/reservation-businessid-required.
      const completed = await service.completeReservation('res-1', TEST_BUSINESS_ID);

      expect(completed.status).toBe(ReservationStatus.COMPLETED);
      expect(eventRepo.events).toHaveLength(1);
      expect((eventRepo.events[0] as { eventType: string }).eventType)
        .toBe('reservation.completed');
    });
  });

  // -------------------------------------------------------------------------
  describe('checkAvailability', () => {
    it('debe retornar false cuando hay conflicto', async () => {
      await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });

      const available = await service.checkAvailability(
        't1',
        new Date('2026-07-01T21:00:00'),
        new Date('2026-07-01T23:00:00'),
      );

      expect(available).toBe(false);
    });

    it('debe retornar false cuando el recurso está OUT_OF_SERVICE, sin conflicto de horario', async () => {
      const task = HousekeepingTask.create({
        businessId: TEST_BUSINESS_ID,
        resourceId: 't1',
        shift: 'MORNING',
        scheduledFor: new Date('2026-07-01T08:00:00'),
      });
      task.setOutOfService();
      housekeepingRepo.seed(task);

      const available = await service.checkAvailability(
        't1',
        new Date('2026-07-01T20:00:00'),
        new Date('2026-07-01T22:00:00'),
      );

      expect(available).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('updateReservation', () => {
    async function createBase(id = 'res-1') {
      return service.createReservation({
        id,
        resourceId: 't1',
        customer,
        startTime: new Date('2026-08-01T19:00:00Z'),
        endTime:   new Date('2026-08-01T21:00:00Z'),
        details: {},
      });
    }

    it('debe actualizar solo startTime manteniendo endTime existente', async () => {
      await createBase();
      const updated = await service.updateReservation('res-1', {
        startTime: new Date('2026-08-01T18:00:00Z'),
      });
      expect(updated.startTime).toEqual(new Date('2026-08-01T18:00:00Z'));
      expect(updated.endTime).toEqual(new Date('2026-08-01T21:00:00Z'));
      expect(updated.status).toBe(ReservationStatus.PENDING);
    });

    it('debe actualizar solo endTime manteniendo startTime existente', async () => {
      await createBase();
      const updated = await service.updateReservation('res-1', {
        endTime: new Date('2026-08-01T22:00:00Z'),
      });
      expect(updated.startTime).toEqual(new Date('2026-08-01T19:00:00Z'));
      expect(updated.endTime).toEqual(new Date('2026-08-01T22:00:00Z'));
    });

    it('debe actualizar startTime y endTime juntos', async () => {
      await createBase();
      const updated = await service.updateReservation('res-1', {
        startTime: new Date('2026-08-01T17:00:00Z'),
        endTime:   new Date('2026-08-01T19:00:00Z'),
      });
      expect(updated.startTime).toEqual(new Date('2026-08-01T17:00:00Z'));
      expect(updated.endTime).toEqual(new Date('2026-08-01T19:00:00Z'));
    });

    it('no regenera reservation_lines al editar horario — quedan igual que al crear', async () => {
      const created = await createBase();
      const updated = await service.updateReservation('res-1', {
        startTime: new Date('2026-08-01T18:00:00Z'),
      });
      expect(updated.lines).toEqual(created.lines);
    });

    it('debe rechazar si endTime <= startTime (solo startTime enviado)', async () => {
      await createBase();
      await expect(
        service.updateReservation('res-1', {
          startTime: new Date('2026-08-01T22:00:00Z'),
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si endTime <= startTime (solo endTime enviado)', async () => {
      await createBase();
      await expect(
        service.updateReservation('res-1', {
          endTime: new Date('2026-08-01T18:00:00Z'),
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si la reserva no está en PENDING', async () => {
      await createBase();
      await service.confirmReservation('res-1', TEST_BUSINESS_ID);
      await expect(
        service.updateReservation('res-1', {
          startTime: new Date('2026-08-01T18:00:00Z'),
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si no se envía ningún campo', async () => {
      await createBase();
      await expect(
        service.updateReservation('res-1', {}),
      ).rejects.toThrow(InvalidReservationError);
    });
  });

  // -------------------------------------------------------------------------
  describe('resource locks — recursos físicos compartidos', () => {
    const silla1 = new BookableResource('silla-1', 'Silla 1', 30, 'cat-servicios', null);
    const silla2 = new BookableResource('silla-2', 'Silla 2', 30, 'cat-servicios', null);
    const estilista = new BookableResource('estilista-ana', 'Estilista Ana', 0, 'cat-servicios', null);

    beforeEach(async () => {
      await resourceRepo.save(silla1);
      await resourceRepo.save(silla2);
      await resourceRepo.save(estilista);

      bookableServiceRepo.seed({
        id: 'svc-corte', categoryId: 'cat-servicios', name: 'Corte',
        bookingMode: 'slot', durationMinutes: 30, price: 20,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seed({
        id: 'svc-tintura', categoryId: 'cat-servicios', name: 'Tintura',
        bookingMode: 'slot', durationMinutes: 90, price: 50,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      // Ambos servicios comparten la estilista, aunque cada uno tiene su
      // propia silla como recurso primario.
      lockRepo.seed([
        { serviceId: 'svc-corte',   resourceId: 'estilista-ana', sortOrder: 0 },
        { serviceId: 'svc-tintura', resourceId: 'estilista-ana', sortOrder: 0 },
      ]);
    });

    it('bloquea una reserva si el recurso físico compartido está ocupado, aunque el recurso primario esté libre', async () => {
      await service.createReservation({
        id: 'res-corte',
        resourceId: 'silla-1',
        serviceId: 'svc-corte',
        customer,
        startTime: new Date('2026-07-01T10:00:00'),
        endTime:   new Date('2026-07-01T10:30:00'),
        details: {},
      });

      // silla-2 (el recurso primario de Tintura) está libre — pero la
      // estilista ya está ocupada por la reserva de Corte en ese rango.
      await expect(
        service.createReservation({
          id: 'res-tintura',
          resourceId: 'silla-2',
          serviceId: 'svc-tintura',
          customer,
          startTime: new Date('2026-07-01T10:15:00'),
          endTime:   new Date('2026-07-01T11:45:00'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('permite reservar si el recurso físico compartido está libre en ese rango', async () => {
      await service.createReservation({
        id: 'res-corte',
        resourceId: 'silla-1',
        serviceId: 'svc-corte',
        customer,
        startTime: new Date('2026-07-01T10:00:00'),
        endTime:   new Date('2026-07-01T10:30:00'),
        details: {},
      });

      const tintura = await service.createReservation({
        id: 'res-tintura',
        resourceId: 'silla-2',
        serviceId: 'svc-tintura',
        customer,
        startTime: new Date('2026-07-01T11:00:00'), // después de que termina Corte
        endTime:   new Date('2026-07-01T12:30:00'),
        details: {},
      });

      expect(tintura.id).toBe('res-tintura');
    });

    it('un servicio sin locks registrados se comporta igual que antes (solo chequea el recurso primario)', async () => {
      bookableServiceRepo.seed({
        id: 'svc-sin-locks', categoryId: 'cat-servicios', name: 'Servicio simple',
        bookingMode: 'slot', durationMinutes: 30, price: 10,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      const reservation = await service.createReservation({
        id: 'res-simple',
        resourceId: 't1',
        serviceId: 'svc-sin-locks',
        customer,
        startTime: new Date('2026-07-01T10:00:00'),
        endTime:   new Date('2026-07-01T10:30:00'),
        details: {},
      });

      expect(reservation.id).toBe('res-simple');
    });

    it('checkAvailability con serviceId considera los recursos bloqueados, no solo el primario', async () => {
      await service.createReservation({
        id: 'res-corte',
        resourceId: 'silla-1',
        serviceId: 'svc-corte',
        customer,
        startTime: new Date('2026-07-01T10:00:00'),
        endTime:   new Date('2026-07-01T10:30:00'),
        details: {},
      });

      // silla-2 en sí está libre, pero la estilista (bloqueada por svc-tintura) no.
      const available = await service.checkAvailability(
        'silla-2',
        new Date('2026-07-01T10:15:00'),
        new Date('2026-07-01T10:45:00'),
        undefined,
        'svc-tintura',
      );

      expect(available).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('reserva por duración (sin endTime explícito)', () => {
    beforeEach(() => {
      bookableServiceRepo.seed({
        id: 'svc-60min', categoryId: 'cat-table', name: 'Servicio 60min',
        bookingMode: 'slot', durationMinutes: 60, price: 20,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seed({
        id: 'svc-sin-duracion', categoryId: 'cat-table', name: 'Servicio sin duración',
        bookingMode: 'block', durationMinutes: null, price: 20,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
    });

    it('calcula endTime a partir de duration_minutes cuando no se envía', async () => {
      const reservation = await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        serviceId: 'svc-60min',
        customer,
        startTime: new Date('2026-07-01T10:00:00'),
        details: {},
      });

      expect(reservation.endTime).toEqual(new Date('2026-07-01T11:00:00'));
    });

    it('rechaza si no hay endTime ni serviceId', async () => {
      await expect(
        service.createReservation({
          id: 'res-1',
          resourceId: 't1',
          customer,
          startTime: new Date('2026-07-01T10:00:00'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('rechaza si el serviceId no tiene duration_minutes configurado y no hay endTime', async () => {
      await expect(
        service.createReservation({
          id: 'res-1',
          resourceId: 't1',
          serviceId: 'svc-sin-duracion',
          customer,
          startTime: new Date('2026-07-01T10:00:00'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('un endTime explícito siempre tiene prioridad sobre la duración derivada', async () => {
      const reservation = await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        serviceId: 'svc-60min',
        customer,
        startTime: new Date('2026-07-01T10:00:00'),
        endTime:   new Date('2026-07-01T10:20:00'),
        details: {},
      });

      expect(reservation.endTime).toEqual(new Date('2026-07-01T10:20:00'));
    });
  });

  // -------------------------------------------------------------------------
  describe('resolución de precio — tarifas especiales', () => {
    it('sin tarifa especial y sin serviceId, usa el basePrice del recurso', async () => {
      const reservation = await service.createReservation({
        id: 'res-precio-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T09:00:00'),
        endTime:   new Date('2026-07-01T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(50); // table.basePrice
    });

    it('sin tarifa especial y con serviceId, usa el precio de catálogo del servicio', async () => {
      bookableServiceRepo.seed({
        id: 'svc-precio', categoryId: 'cat-table', name: 'Servicio con precio',
        bookingMode: 'slot', durationMinutes: 30, price: 35,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      const reservation = await service.createReservation({
        id: 'res-precio-2',
        resourceId: 't1',
        serviceId: 'svc-precio',
        customer,
        startTime: new Date('2026-07-01T09:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(35);
    });

    it('con tarifa especial de cliente+recurso, la usa en vez del basePrice de catálogo', async () => {
      customerRateRepo.seed([{
        id: 'rate-1', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: 't1', serviceId: null, price: 40, active: true,
      }]);

      const reservation = await service.createReservation({
        id: 'res-precio-3',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T09:00:00'),
        endTime:   new Date('2026-07-01T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(40);
    });

    it('con tarifa especial de cliente+servicio, la prioriza sobre el precio de catálogo del servicio', async () => {
      bookableServiceRepo.seed({
        id: 'svc-precio-2', categoryId: 'cat-table', name: 'Servicio con precio 2',
        bookingMode: 'slot', durationMinutes: 30, price: 35,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      customerRateRepo.seed([{
        id: 'rate-2', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: null, serviceId: 'svc-precio-2', price: 15, active: true,
      }]);

      const reservation = await service.createReservation({
        id: 'res-precio-4',
        resourceId: 't1',
        serviceId: 'svc-precio-2',
        customer,
        startTime: new Date('2026-07-01T09:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(15);
    });

    it('bookingMode "block" (alojamiento): multiplica el precio por la cantidad de noches', async () => {
      bookableServiceRepo.seed({
        id: 'svc-noche', categoryId: 'cat-table', name: 'Noche de hotel',
        bookingMode: 'block', durationMinutes: null, price: 100,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      // Check-in 10/07 15:00, check-out 13/07 10:00 = 3 noches por fecha
      // calendario, aunque no sean 72hs exactas.
      const reservation = await service.createReservation({
        id: 'res-noche-1',
        resourceId: 't1',
        serviceId: 'svc-noche',
        customer,
        startTime: new Date('2026-07-10T15:00:00'),
        endTime:   new Date('2026-07-13T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(300); // 100 * 3 noches

      // reservation_lines: una fila por noche, todas al mismo precio
      // unitario hoy (no hay motor de tarifas por temporada todavía), y la
      // suma debe coincidir exacto con totalPrice.
      expect(reservation.lines).toHaveLength(3);
      expect(reservation.lines.every(l => l.price === 100)).toBe(true);
      expect(reservation.lines.reduce((sum, l) => sum + l.price, 0)).toBe(300);
      expect(reservation.lines.map(l => l.unitDate.toISOString().slice(0, 10))).toEqual([
        '2026-07-10', '2026-07-11', '2026-07-12',
      ]);
    });

    it('bookingMode "slot" (o sin servicio): una única línea, igual al totalPrice', async () => {
      const reservation = await service.createReservation({
        id: 'res-linea-unica',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });

      expect(reservation.lines).toHaveLength(1);
      expect(reservation.lines[0]!.price).toBe(reservation.totalPrice);
    });

    it('bookingMode "block": rechaza checkout el mismo día que checkin', async () => {
      bookableServiceRepo.seed({
        id: 'svc-noche-2', categoryId: 'cat-table', name: 'Noche de hotel 2',
        bookingMode: 'block', durationMinutes: null, price: 100,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      await expect(
        service.createReservation({
          id: 'res-noche-2',
          resourceId: 't1',
          serviceId: 'svc-noche-2',
          customer,
          startTime: new Date('2026-07-10T15:00:00'),
          endTime:   new Date('2026-07-10T20:00:00'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('bookingMode "block" con tarifa especial: la tarifa también se multiplica por noches', async () => {
      bookableServiceRepo.seed({
        id: 'svc-noche-3', categoryId: 'cat-table', name: 'Noche de hotel 3',
        bookingMode: 'block', durationMinutes: null, price: 100,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      customerRateRepo.seed([{
        id: 'rate-noche', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: null, serviceId: 'svc-noche-3', price: 80, active: true,
      }]);

      const reservation = await service.createReservation({
        id: 'res-noche-3',
        resourceId: 't1',
        serviceId: 'svc-noche-3',
        customer,
        startTime: new Date('2026-07-10T15:00:00'),
        endTime:   new Date('2026-07-12T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(160); // 80 * 2 noches
    });
  });

  // -------------------------------------------------------------------------
  describe('getAvailableSlots — horario de atención (negocio + override por recurso)', () => {
    const barbero = new BookableResource('barbero-1', 'Barbero Juan', 20, 'cat-table', null);

    beforeEach(async () => {
      await resourceRepo.save(barbero);
      bookableServiceRepo.seed({
        id: 'svc-corte-1h', categoryId: 'cat-table', name: 'Corte',
        bookingMode: 'slot', durationMinutes: 60, price: 20,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
    });

    // Lunes 2026-08-17 — coincide con dayOfWeek=0 (lunes) en la resolución
    // (date.getUTCDay() + 6) % 7 usada por getAvailableSlots.
    const LUNES = new Date('2026-08-17T00:00:00.000Z');

    it('sin horario configurado (ni recurso ni negocio) devuelve lista vacía', async () => {
      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES);
      expect(slots).toEqual([]);
    });

    it('usa el horario del negocio cuando el recurso no tiene uno propio', async () => {
      operatingHoursRepo.seedBusiness([
        { id: 'bh-1', dayOfWeek: 0, startTime: '09:00:00', endTime: '11:00:00' },
      ]);

      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES);
      expect(slots).toHaveLength(2); // 09:00 y 10:00, turnos de 60min
    });

    it('el horario propio del recurso reemplaza al del negocio, no se combina', async () => {
      operatingHoursRepo.seedBusiness([
        { id: 'bh-1', dayOfWeek: 0, startTime: '08:00:00', endTime: '18:00:00' },
      ]);
      operatingHoursRepo.seedResource('barbero-1', [
        { id: 'rh-1', dayOfWeek: 0, startTime: '14:00:00', endTime: '18:00:00' },
      ]);

      const slots = await service.getAvailableSlots('svc-corte-1h', 'barbero-1', LUNES);

      // Horarios en hora de Argentina (UTC-3): 14:00 ART = 17:00 UTC.
      expect(slots).toHaveLength(4); // solo 14-18, no 8-18 del negocio
      expect(slots[0]).toContain('T17:00');
      expect(slots.every((s) => new Date(s).getUTCHours() >= 17)).toBe(true);
    });

    it('horario cortado (mañana + tarde) genera turnos en ambas ventanas', async () => {
      operatingHoursRepo.seedBusiness([
        { id: 'bh-1', dayOfWeek: 0, startTime: '09:00:00', endTime: '13:00:00' },
        { id: 'bh-2', dayOfWeek: 0, startTime: '14:00:00', endTime: '18:00:00' },
      ]);

      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES);
      expect(slots).toHaveLength(8); // 4 + 4
    });

    it('un turno ya reservado no aparece entre los disponibles', async () => {
      operatingHoursRepo.seedBusiness([
        { id: 'bh-1', dayOfWeek: 0, startTime: '09:00:00', endTime: '11:00:00' },
      ]);

      // 09:00 ART (horario del negocio) = 12:00 UTC.
      await service.createReservation({
        id: 'res-ocupado',
        resourceId: 't1',
        serviceId: 'svc-corte-1h',
        customer,
        startTime: new Date('2026-08-17T12:00:00.000Z'),
        details: {},
      });

      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES);
      expect(slots).toHaveLength(1);
      expect(slots[0]).toContain('T13:00');
    });

    it('rechaza si el servicio no es "slot" o no tiene duración configurada', async () => {
      bookableServiceRepo.seed({
        id: 'svc-alojamiento', categoryId: 'cat-table', name: 'Noche',
        bookingMode: 'block', durationMinutes: null, price: 100,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      await expect(
        service.getAvailableSlots('svc-alojamiento', 't1', LUNES),
      ).rejects.toThrow(InvalidReservationError);
    });
  });
});
