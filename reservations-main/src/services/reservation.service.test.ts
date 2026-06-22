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
});
