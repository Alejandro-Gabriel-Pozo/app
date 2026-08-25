import { describe, it, expect, beforeEach } from 'vitest';
import { MaintenanceWindowService } from './maintenance-window.service.js';
import { InMemoryMaintenanceWindowRepository } from './in-memory.maintenance-window.repository.js';
import { BookableResource } from '../reservas/resource.entities.js';
import { MaintenanceWindowConflictError, MaintenanceWindowNotFoundError, ResourceNotFoundError } from '../domain/errors.js';
import type { ResourceRepository } from '../reservas/resource.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { Reservation } from '../reservas/Reservation.js';

const BUSINESS_ID = 'biz-1';

/** Recurso fijo -- getById() devuelve este mismo para cualquier id excepto 'missing'. */
const resource = new BookableResource('room-1', 'Habitación 1', 50, 'cat-1', {
  shape: 'RECTANGLE', width: 100, height: 100, positionX: 0, positionY: 0, rotationDegrees: 0,
}, 2);

class FakeResourceRepository implements Pick<ResourceRepository, 'getById'> {
  async getById(id: string) {
    return id === 'missing' ? undefined : resource;
  }
}

/** Devuelve `conflicts` en cualquier consulta -- lo que el test necesite simular. */
class FakeReservationRepository implements Pick<ReservationRepository, 'getActiveForResourceInRange'> {
  conflicts: Reservation[] = [];
  async getActiveForResourceInRange(): Promise<Reservation[]> {
    return this.conflicts;
  }
}

class FakeBusinessProfileRepository implements Pick<BusinessProfileRepository, 'get'> {
  async get() {
    return { timezone: 'America/Argentina/Buenos_Aires' } as Awaited<ReturnType<BusinessProfileRepository['get']>>;
  }
}

describe('MaintenanceWindowService', () => {
  let repo: InMemoryMaintenanceWindowRepository;
  let resourceRepo: FakeResourceRepository;
  let reservationRepo: FakeReservationRepository;
  let businessProfileRepo: FakeBusinessProfileRepository;
  let service: MaintenanceWindowService;

  beforeEach(() => {
    repo = new InMemoryMaintenanceWindowRepository();
    resourceRepo = new FakeResourceRepository();
    reservationRepo = new FakeReservationRepository();
    businessProfileRepo = new FakeBusinessProfileRepository();
    service = new MaintenanceWindowService(repo, resourceRepo, reservationRepo, businessProfileRepo);
  });

  describe('createWindow', () => {
    it('crea la ventana cuando no hay reservas conflictivas', async () => {
      const window = await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2026-08-24', endDate: '2026-08-30', createdBy: 'user-1',
      });
      expect(window.resourceId).toBe('room-1');
      expect(await repo.findById(window.id, BUSINESS_ID)).not.toBeNull();
    });

    it('rechaza si el recurso no existe', async () => {
      await expect(
        service.createWindow({
          businessId: BUSINESS_ID, resourceId: 'missing',
          startDate: '2026-08-24', createdBy: 'user-1',
        }),
      ).rejects.toThrow(ResourceNotFoundError);
    });

    it('rechaza si hay una reserva CONFIRMED/PENDING dentro del rango de la ventana', async () => {
      reservationRepo.conflicts = [{ id: 'res-1' } as Reservation];

      await expect(
        service.createWindow({
          businessId: BUSINESS_ID, resourceId: 'room-1',
          startDate: '2026-08-24', endDate: '2026-08-30', createdBy: 'user-1',
        }),
      ).rejects.toThrow(MaintenanceWindowConflictError);
    });

    it('ventana ABIERTA (sin endDate) también chequea conflictos -- horizonte de 10 años', async () => {
      reservationRepo.conflicts = [{ id: 'res-1' } as Reservation];

      await expect(
        service.createWindow({
          businessId: BUSINESS_ID, resourceId: 'room-1',
          startDate: '2026-08-24', createdBy: 'user-1',
        }),
      ).rejects.toThrow(MaintenanceWindowConflictError);
    });
  });

  describe('closeWindow', () => {
    it('cierra una ventana existente', async () => {
      const window = await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2026-08-24', createdBy: 'user-1',
      });

      const closed = await service.closeWindow(window.id, BUSINESS_ID, 'user-2', '2026-09-01');
      expect(closed.endDate).toBe('2026-09-01');
      expect(closed.closedBy).toBe('user-2');
    });

    it('rechaza si la ventana no existe', async () => {
      await expect(
        service.closeWindow('missing-id', BUSINESS_ID, 'user-2'),
      ).rejects.toThrow(MaintenanceWindowNotFoundError);
    });

    it('rechaza si la ventana pertenece a otro negocio', async () => {
      const window = await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2026-08-24', createdBy: 'user-1',
      });

      await expect(
        service.closeWindow(window.id, 'otro-negocio', 'user-2'),
      ).rejects.toThrow(MaintenanceWindowNotFoundError);
    });
  });

  describe('listByResource / listActive', () => {
    it('listByResource devuelve todas las ventanas del recurso (histórico incluido)', async () => {
      await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2026-08-24', endDate: '2026-08-30', createdBy: 'user-1',
      });
      const windows = await service.listByResource('room-1', BUSINESS_ID);
      expect(windows).toHaveLength(1);
    });

    it('listActive devuelve solo ventanas todavía relevantes del negocio', async () => {
      await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2026-08-24', createdBy: 'user-1',
      });
      const windows = await service.listActive(BUSINESS_ID);
      expect(windows).toHaveLength(1);
    });
  });
});
