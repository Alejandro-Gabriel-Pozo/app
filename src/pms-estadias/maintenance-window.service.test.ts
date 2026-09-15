import { describe, it, expect, beforeEach } from 'vitest';
import { MaintenanceWindowService } from './maintenance-window.service.js';
import { InMemoryMaintenanceWindowRepository } from './in-memory.maintenance-window.repository.js';
import { BookableResource } from '../reservas/resource.entities.js';
import { MaintenanceWindowConflictError, MaintenanceWindowNotFoundError, ResourceNotFoundError } from '../domain/errors.js';
import type { ResourceRepository } from '../reservas/resource.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';

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

/**
 * D-03 (15/09/2026) — a diferencia de la versión anterior (devolvía un
 * único `conflicts` fijo para CUALQUIER rango), ahora `createWindow()`
 * llama a `getActiveForResourceInRange()` hasta dos veces con rangos
 * DISTINTOS (tramo cierto / tramo incierto) — el fake necesita
 * diferenciar por rango para poder probar los dos tramos por separado.
 * `resolver` recibe el rango pedido y decide qué devolver; default: nada.
 * `saveWithClient` solo registra la llamada (no hay estado real que
 * mutar acá — el fake de más abajo, FailingOnMarkedReservationRepository,
 * es el que necesita fallar a propósito para el test de atomicidad).
 */
class FakeReservationRepository implements Pick<ReservationRepository, 'getActiveForResourceInRange' | 'saveWithClient'> {
  calls: { start: Date; end: Date }[] = [];
  saved: Reservation[] = [];
  resolver: (start: Date, end: Date) => Reservation[] = () => [];

  async getActiveForResourceInRange(_resourceId: string, start: Date, end: Date): Promise<Reservation[]> {
    this.calls.push({ start, end });
    return this.resolver(start, end);
  }

  async saveWithClient(_client: SqlClient, reservation: Reservation): Promise<void> {
    this.saved.push(reservation);
  }
}

class FakeBusinessProfileRepository implements Pick<BusinessProfileRepository, 'get'> {
  horizonDays = 30;
  async get() {
    return {
      timezone: 'America/Argentina/Buenos_Aires',
      maintenanceHorizonDays: this.horizonDays,
    } as Awaited<ReturnType<BusinessProfileRepository['get']>>;
  }
}

/**
 * Ejecuta el work directamente sin abrir una transacción real -- suficiente
 * para verificar que el servicio llama a saveWithClient/insertWithClient de
 * forma atómica (una sola invocación de run() envolviendo todos los
 * writes), NO que Postgres revierta de verdad ante un fallo a mitad de
 * camino -- eso requiere un test de integración contra TEST_DATABASE_URL
 * (no disponible en esta sesión, ver el bloque "atomicidad" más abajo).
 */
class InMemoryTransactionManager implements TransactionManager {
  runCount = 0;
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    this.runCount++;
    const noopClient: SqlClient = {
      async query() { return { rows: [], rowCount: 0 }; },
    };
    return work(noopClient);
  }
}

/** Reloj fijo -- "hoy" = 2026-08-24 (huso America/Argentina/Buenos_Aires), mismo día que usan los fixtures de startDate de este archivo. */
const FROZEN_TODAY = () => new Date('2026-08-24T15:00:00Z');

describe('MaintenanceWindowService', () => {
  let repo: InMemoryMaintenanceWindowRepository;
  let resourceRepo: FakeResourceRepository;
  let reservationRepo: FakeReservationRepository;
  let businessProfileRepo: FakeBusinessProfileRepository;
  let txManager: InMemoryTransactionManager;
  let service: MaintenanceWindowService;

  beforeEach(() => {
    repo = new InMemoryMaintenanceWindowRepository();
    resourceRepo = new FakeResourceRepository();
    reservationRepo = new FakeReservationRepository();
    businessProfileRepo = new FakeBusinessProfileRepository();
    txManager = new InMemoryTransactionManager();
    service = new MaintenanceWindowService(repo, resourceRepo, reservationRepo, businessProfileRepo, txManager, FROZEN_TODAY);
  });

  describe('createWindow', () => {
    it('crea la ventana cuando no hay reservas conflictivas', async () => {
      const { window, needsReviewReservationIds } = await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2026-08-24', endDate: '2026-08-30', createdBy: 'user-1',
      });
      expect(window.resourceId).toBe('room-1');
      expect(needsReviewReservationIds).toEqual([]);
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

    it('rechaza si hay una reserva CONFIRMED/PENDING dentro del rango de una ventana CON fecha de fin', async () => {
      reservationRepo.resolver = () => [{ id: 'res-1' } as Reservation];

      await expect(
        service.createWindow({
          businessId: BUSINESS_ID, resourceId: 'room-1',
          startDate: '2026-08-24', endDate: '2026-08-30', createdBy: 'user-1',
        }),
      ).rejects.toThrow(MaintenanceWindowConflictError);
    });

    it('(c) ventana CON fecha de fin: el horizonte NO aplica -- una reserva dentro del rango bloquea aunque esté más allá del horizonte configurado (la regresión que D-03 evita)', async () => {
      // Horizonte de 30 días desde "hoy" (24/08) termina el 23/09. Esta
      // reserva conflictiva cae el 15/12 -- lejos del horizonte, pero
      // DENTRO del endDate de la ventana (31/12). Con horizonte aplicado
      // por error, esto NO bloquearía -- es exactamente la regresión que
      // D-03 dice evitar.
      reservationRepo.resolver = () => [{ id: 'res-lejana' } as Reservation];

      await expect(
        service.createWindow({
          businessId: BUSINESS_ID, resourceId: 'room-1',
          startDate: '2026-08-24', endDate: '2026-12-31', createdBy: 'user-1',
        }),
      ).rejects.toThrow(MaintenanceWindowConflictError);

      // Un solo llamado a getActiveForResourceInRange, con el rango
      // completo pedido -- confirma que no se partió en tramos.
      expect(reservationRepo.calls).toHaveLength(1);
      expect(reservationRepo.calls[0]!.start.toISOString().slice(0, 10)).toBe('2026-08-24');
      // 2026-12-31 23:59:59 ART (UTC-3) = 2027-01-01T02:59:59Z.
      expect(reservationRepo.calls[0]!.end.toISOString().slice(0, 10)).toBe('2027-01-01');
    });

    // ------------------------------------------------------------------
    // D-03 -- ventana ABIERTA (endDate == null), horizonte partido en dos
    // tramos. "Hoy" = 2026-08-24 (FROZEN_TODAY), horizonte = 30 días
    // (horizonDays default) => el tramo cierto termina el 2026-09-23.
    // ------------------------------------------------------------------

    it('(a) ventana ABIERTA -- reserva DENTRO del horizonte sigue bloqueando (regresión del comportamiento actual, con horizonte corto en vez de 10 años)', async () => {
      reservationRepo.resolver = (start) => {
        // Dentro del tramo cierto (antes del 2026-09-23 23:59:59 ART).
        return start.getTime() < new Date('2026-09-24T00:00:00Z').getTime()
          ? [{ id: 'res-cercana' } as Reservation]
          : [];
      };

      await expect(
        service.createWindow({
          businessId: BUSINESS_ID, resourceId: 'room-1',
          startDate: '2026-08-24', createdBy: 'user-1',
        }),
      ).rejects.toThrow(MaintenanceWindowConflictError);

      // No debe haber quedado nada persistido -- ni ventana ni marca.
      expect(await repo.findByResource('room-1', BUSINESS_ID)).toHaveLength(0);
    });

    it('(b) ventana ABIERTA -- reserva MÁS ALLÁ del horizonte no bloquea, la ventana se crea, la reserva queda marcada y aparece en la respuesta', async () => {
      const farReservation = {
        id: 'res-lejana',
        markNeedsMaintenanceReview: () => { farReservation.needsMaintenanceReview = true; },
        needsMaintenanceReview: false,
      } as unknown as Reservation & { needsMaintenanceReview: boolean };

      reservationRepo.resolver = (start) => {
        // Nada en el tramo cierto; la reserva lejana solo aparece en el
        // tramo incierto (rango que arranca justo después del horizonte).
        return start.getTime() > new Date('2026-09-23T12:00:00Z').getTime()
          ? [farReservation]
          : [];
      };

      const { window, needsReviewReservationIds } = await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2026-08-24', createdBy: 'user-1',
      });

      expect(window.isOpenEnded).toBe(true);
      expect(needsReviewReservationIds).toEqual(['res-lejana']);
      expect(await repo.findById(window.id, BUSINESS_ID)).not.toBeNull();

      // El mutador de dominio se llamó de verdad (no solo se ignoró el
      // conflicto) y la reserva se persistió dentro de la transacción.
      expect(farReservation.needsMaintenanceReview).toBe(true);
      expect(reservationRepo.saved).toContain(farReservation);
    });

    it('startDate ya más allá del horizonte de entrada: todo el rango pedido es tramo incierto, nada bloquea', async () => {
      reservationRepo.resolver = () => [{
        id: 'res-x',
        markNeedsMaintenanceReview() {},
      } as unknown as Reservation];

      const { needsReviewReservationIds } = await service.createWindow({
        businessId: BUSINESS_ID, resourceId: 'room-1',
        startDate: '2027-06-01', createdBy: 'user-1',
      });

      expect(needsReviewReservationIds).toEqual(['res-x']);
    });

    it('(d) atomicidad -- si falla el UPDATE de needsMaintenanceReview de una reserva del tramo incierto, createWindow() propaga el error (wiring: una sola invocación de transactionManager.run() envolviendo ventana + reservas — NO reemplaza una verificación de rollback real contra Postgres, ver reporte de la sesión: requiere TEST_DATABASE_URL, no disponible acá)', async () => {
      const boom = new Error('UPDATE de needs_maintenance_review falló');
      const farReservation = {
        id: 'res-lejana',
        markNeedsMaintenanceReview: () => {},
      } as unknown as Reservation;

      reservationRepo.resolver = (start) => (
        start.getTime() > new Date('2026-09-23T12:00:00Z').getTime() ? [farReservation] : []
      );
      reservationRepo.saveWithClient = async () => { throw boom; };

      await expect(
        service.createWindow({
          businessId: BUSINESS_ID, resourceId: 'room-1',
          startDate: '2026-08-24', createdBy: 'user-1',
        }),
      ).rejects.toThrow(boom);

      // Confirma que todo el trabajo (INSERT de ventana + UPDATE de
      // reservas) corrió DENTRO de una sola llamada a run() -- el
      // límite transaccional está bien declarado en el código. Lo que
      // este test NO puede probar es que Postgres haya revertido el
      // INSERT de la ventana de verdad (InMemoryTransactionManager no
      // hace rollback) -- por eso sigue pendiente contra un entorno real.
      expect(txManager.runCount).toBe(1);
    });
  });

  describe('closeWindow', () => {
    it('cierra una ventana existente', async () => {
      const { window } = await service.createWindow({
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
      const { window } = await service.createWindow({
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
