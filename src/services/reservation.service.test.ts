import { describe, it, expect, beforeEach } from 'vitest';
import {
  ResourceType,
  TableShape,
  TableLocation,
  ReservationStatus,
} from '../types/enums.js';
import { Customer } from '../domain/entities.js';
import { ReservationService } from './reservation.service.js';
import { InMemoryReservationRepository } from '../repositories/in-memory.reservation.repository.js';
import { InMemoryResourceRepository } from '../repositories/in-memory.resource.repository.js';
import { InMemoryOccupancyRepository } from '../repositories/in-memory.occupancy.repository.js';
import { TableResource } from '../domain/entities.js';
import { InvalidReservationError, ResourceNotFoundError } from '../domain/errors.js';

describe('ReservationService', () => {
  let reservationRepo: InMemoryReservationRepository;
  let resourceRepo: InMemoryResourceRepository;
  let occupancyRepo: InMemoryOccupancyRepository;
  let service: ReservationService;

  const table = new TableResource('t1', 'Mesa Ventana', 50, {
    shape: TableShape.RECTANGLE,
    width: 120,
    height: 80,
    positionX: 0,
    positionY: 0,
    rotationDegrees: 0,
  });

  const customer = new Customer('cust-1', 'Ana García', 'ana@example.com');

  beforeEach(async () => {
    reservationRepo = new InMemoryReservationRepository();
    resourceRepo = new InMemoryResourceRepository();
    occupancyRepo = new InMemoryOccupancyRepository();
    service = new ReservationService(
      reservationRepo,
      resourceRepo,
      occupancyRepo,
    );
    await resourceRepo.save(table);
  });

  describe('createReservation', () => {
    it('debe crear una reserva cuando el recurso está disponible', async () => {
      const start = new Date('2026-07-01T20:00:00');
      const end = new Date('2026-07-01T22:00:00');

      const reservation = await service.createReservation({
        id: 'res-1',
        resourceType: ResourceType.RESTAURANT_TABLE,
        resourceId: 't1',
        customer,
        startTime: start,
        endTime: end,
        details: { allergies: [], tableLocation: TableLocation.WINDOW },
      });

      expect(reservation.id).toBe('res-1');
      expect(reservation.status).toBe(ReservationStatus.PENDING);
      expect(await reservationRepo.getById('res-1')).toBeDefined();
    });

    it('debe rechazar si el recurso no existe', async () => {
      await expect(
        service.createReservation({
          id: 'res-1',
          resourceType: ResourceType.RESTAURANT_TABLE,
          resourceId: 'missing',
          customer,
          startTime: new Date('2026-07-01T20:00:00'),
          endTime: new Date('2026-07-01T22:00:00'),
          details: { allergies: [], tableLocation: TableLocation.WINDOW },
        }),
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it('debe rechazar si hay solapamiento con otra reserva activa', async () => {
      const start = new Date('2026-07-01T20:00:00');
      const end = new Date('2026-07-01T22:00:00');

      await service.createReservation({
        id: 'res-1',
        resourceType: ResourceType.RESTAURANT_TABLE,
        resourceId: 't1',
        customer,
        startTime: start,
        endTime: end,
        details: { allergies: [], tableLocation: TableLocation.WINDOW },
      });

      await expect(
        service.createReservation({
          id: 'res-2',
          resourceType: ResourceType.RESTAURANT_TABLE,
          resourceId: 't1',
          customer,
          startTime: new Date('2026-07-01T21:00:00'),
          endTime: new Date('2026-07-01T23:00:00'),
          details: { allergies: [], tableLocation: TableLocation.INSIDE },
        }),
      ).rejects.toThrow(InvalidReservationError);
    });
  });

  describe('confirmReservation', () => {
    it('debe confirmar y registrar ocupación', async () => {
      const start = new Date('2026-07-01T20:00:00');
      const end = new Date('2026-07-01T22:00:00');

      await service.createReservation({
        id: 'res-1',
        resourceType: ResourceType.RESTAURANT_TABLE,
        resourceId: 't1',
        customer,
        startTime: start,
        endTime: end,
        details: { allergies: [], tableLocation: TableLocation.WINDOW },
      });

      const confirmed = await service.confirmReservation('res-1');
      expect(confirmed.status).toBe(ReservationStatus.CONFIRMED);

      const snapshots = await occupancyRepo.getAllSnapshots();
      expect(snapshots.length).toBeGreaterThan(0);
      expect(snapshots[0].resourceId).toBe('t1');
    });
  });

  describe('checkAvailability', () => {
    it('debe retornar false cuando hay conflicto', async () => {
      const start = new Date('2026-07-01T20:00:00');
      const end = new Date('2026-07-01T22:00:00');

      await service.createReservation({
        id: 'res-1',
        resourceType: ResourceType.RESTAURANT_TABLE,
        resourceId: 't1',
        customer,
        startTime: start,
        endTime: end,
        details: { allergies: [], tableLocation: TableLocation.WINDOW },
      });

      const available = await service.checkAvailability(
        't1',
        new Date('2026-07-01T21:00:00'),
        new Date('2026-07-01T23:00:00'),
      );

      expect(available).toBe(false);
    });
  });

  describe('updateReservation', () => {
    // Crea una reserva PENDING base reutilizable en cada test
    async function createBaseReservation(id = 'res-1') {
      return service.createReservation({
        id,
        resourceType: ResourceType.RESTAURANT_TABLE,
        resourceId: 't1',
        customer,
        startTime: new Date('2026-08-01T19:00:00Z'),
        endTime:   new Date('2026-08-01T21:00:00Z'),
        details: { allergies: [], tableLocation: TableLocation.WINDOW },
      });
    }

    it('debe actualizar solo startTime manteniendo endTime existente', async () => {
      await createBaseReservation();

      const updated = await service.updateReservation('res-1', {
        startTime: new Date('2026-08-01T18:00:00Z'),
      });

      expect(updated.startTime).toEqual(new Date('2026-08-01T18:00:00Z'));
      expect(updated.endTime).toEqual(new Date('2026-08-01T21:00:00Z'));
      expect(updated.status).toBe(ReservationStatus.PENDING);
    });

    it('debe actualizar solo endTime manteniendo startTime existente', async () => {
      await createBaseReservation();

      const updated = await service.updateReservation('res-1', {
        endTime: new Date('2026-08-01T22:00:00Z'),
      });

      expect(updated.startTime).toEqual(new Date('2026-08-01T19:00:00Z'));
      expect(updated.endTime).toEqual(new Date('2026-08-01T22:00:00Z'));
    });

    it('debe actualizar startTime y endTime juntos', async () => {
      await createBaseReservation();

      const updated = await service.updateReservation('res-1', {
        startTime: new Date('2026-08-01T17:00:00Z'),
        endTime:   new Date('2026-08-01T19:00:00Z'),
      });

      expect(updated.startTime).toEqual(new Date('2026-08-01T17:00:00Z'));
      expect(updated.endTime).toEqual(new Date('2026-08-01T19:00:00Z'));
    });

    it('debe rechazar si endTime <= startTime después del merge (solo startTime enviado)', async () => {
      await createBaseReservation(); // endTime = 21:00

      // Enviamos un startTime posterior al endTime existente (21:00)
      await expect(
        service.updateReservation('res-1', {
          startTime: new Date('2026-08-01T22:00:00Z'), // > endTime existente 21:00
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si endTime <= startTime después del merge (solo endTime enviado)', async () => {
      await createBaseReservation(); // startTime = 19:00

      // Enviamos un endTime anterior al startTime existente (19:00)
      await expect(
        service.updateReservation('res-1', {
          endTime: new Date('2026-08-01T18:00:00Z'), // < startTime existente 19:00
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si la reserva no está en PENDING', async () => {
      await createBaseReservation();
      await service.confirmReservation('res-1'); // PENDING → CONFIRMED

      await expect(
        service.updateReservation('res-1', {
          startTime: new Date('2026-08-01T18:00:00Z'),
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si no se envía ningún campo', async () => {
      await createBaseReservation();

      await expect(
        service.updateReservation('res-1', {}),
      ).rejects.toThrow(InvalidReservationError);
    });
  });
});
