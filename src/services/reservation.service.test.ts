import { describe, it, expect, beforeEach } from 'vitest';
import { ReservationStatus } from '../types/enums.js';
import { BookableResource, Customer } from '../domain/entities.js';
import { ReservationService } from './reservation.service.js';
import { InMemoryReservationRepository } from '../repositories/in-memory.reservation.repository.js';
import { InMemoryResourceRepository } from '../repositories/in-memory.resource.repository.js';
import { InMemoryOccupancyRepository } from '../repositories/in-memory.occupancy.repository.js';
import { InvalidReservationError, ResourceNotFoundError } from '../domain/errors.js';
import { ICategoryRepository } from '../repositories/category.repository.js';
import { DomainEventRepository } from '../repositories/domain-event.repository.js';
import { TransactionManager } from '../db/transaction-manager.js';
import { SqlClient } from '../repositories/sql.client.js';

// ---------------------------------------------------------------------------
// Mocks mínimos para dependencias de infraestructura
// ---------------------------------------------------------------------------

/** No valida categorías — permite tests que no necesiten esa lógica. */
class NullCategoryRepository implements ICategoryRepository {
  async findById() { return undefined; }
  async findAll() { return []; }
  async findByBusinessId() { return []; }
  async save() {}
  async delete() {}
}

/** Acumula eventos en memoria para poder inspeccionarlos en los tests. */
class InMemoryDomainEventRepository implements DomainEventRepository {
  public events: unknown[] = [];

  async insertWithClient(_client: SqlClient, event: unknown): Promise<void> {
    this.events.push(event);
  }

  async getPending() { return []; }
  async markAsProcessed() {}
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

describe('ReservationService', () => {
  let reservationRepo: InMemoryReservationRepository;
  let resourceRepo: InMemoryResourceRepository;
  let occupancyRepo: InMemoryOccupancyRepository;
  let categoryRepo: NullCategoryRepository;
  let eventRepo: InMemoryDomainEventRepository;
  let txManager: InMemoryTransactionManager;
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
    reservationRepo = new InMemoryReservationRepository();
    resourceRepo    = new InMemoryResourceRepository();
    occupancyRepo   = new InMemoryOccupancyRepository();
    categoryRepo    = new NullCategoryRepository();
    eventRepo       = new InMemoryDomainEventRepository();
    txManager       = new InMemoryTransactionManager();

    service = new ReservationService(
      reservationRepo,
      resourceRepo,
      occupancyRepo,
      categoryRepo,
      eventRepo,
      txManager,
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

      const confirmed = await service.confirmReservation('res-1');

      expect(confirmed.status).toBe(ReservationStatus.CONFIRMED);

      const snapshots = await occupancyRepo.getAllSnapshots();
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0].resourceId).toBe('t1');

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
      await service.confirmReservation('res-1');
      eventRepo.events = []; // reset — solo nos interesa el evento de complete

      const completed = await service.completeReservation('res-1');

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
      await service.confirmReservation('res-1');
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
});
