import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ReservationStatus } from '../types/enums.js';
import { BookableResource } from './resource.entities.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { Reservation } from './Reservation.js';
import { ReservationService } from './reservation.service.js';
import { InMemoryReservationRepository } from './in-memory.reservation.repository.js';
import { InMemoryResourceRepository } from './in-memory.resource.repository.js';
import { InMemoryOccupancyRepository } from './in-memory.occupancy.repository.js';
import { InMemoryResourceLockRepository } from './in-memory.resource-lock.repository.js';
import { InMemoryBookableServiceRepository } from './in-memory.bookable-service.repository.js';
import { InMemoryCustomerRateRepository } from '../clientes-finanzas/in-memory.customer-rate.repository.js';
import { InMemoryDepositPolicyRepository } from './in-memory.deposit-policy.repository.js';
import { InMemoryOperatingHoursRepository } from '../platform/in-memory.operating-hours.repository.js';
import { InMemoryMaintenanceWindowRepository } from '../pms-estadias/in-memory.maintenance-window.repository.js';
import { InMemoryNumberSequenceRepository } from '../repositories/in-memory.number-sequence.repository.js';
import { MaintenanceWindow } from '../pms-estadias/maintenance-window.js';
import { InvalidReservationError, ResourceNotFoundError, RatePlanNotAvailableError, NoPriceAdjustmentPendingError, DepositNotPaidError, ReservationChargeInvoicedError } from '../domain/errors.js';
import type { ICategoryRepository } from './category.repository.js';
import type { DomainEventRepository } from '../repositories/domain-event.repository.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import type { FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceLinkage } from '../facturacion/invoice.repository.js';

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
  async recordFailure() { return false; }
  async countDeadLettered() { return 0; }
  async getDeadLettered() { return []; }
  async retryDeadLettered() {}
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

/**
 * J1 (23/08/2026, pendientes-2026-08-23.md) — reloj congelado para el
 * guard de "no crear/mover una reserva al pasado". Todos los fixtures de
 * `startTime` de este archivo usan fechas 2026-07/08/09; esta fecha es
 * anterior a todas ellas, así que el guard nunca las rechaza.
 */
const FROZEN_TEST_NOW = () => new Date('2020-01-01T00:00:00Z');

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
  let maintenanceWindowRepo: InMemoryMaintenanceWindowRepository;
  let depositPolicyRepo: InMemoryDepositPolicyRepository;
  let financialTransactionRepo: FakePaymentLedger;
  let invoiceRepo: FakeInvoiceRepositoryForReservations;
  let numberSequenceRepo: InMemoryNumberSequenceRepository;
  let service: ReservationService;

  /** Sin política de seña -- comportamiento default (deposit_amount = 0, gate nunca se activa). */
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

  /**
   * Ledger mínimo para probar el gate de `confirmReservation()` (C1-Fase A)
   * sin necesitar `CustomerAccountService`/`FinancialTransaction` completos
   * -- ReservationService solo LEE `getSettledPaymentTotalForReservation`,
   * nunca escribe. `setPaid()` simula que un operador ya registró el cobro.
   */
  class FakePaymentLedger {
    private paid = new Map<string, number>();
    // RESERVA-10 (05/09/2026) -- charges por reserva, para
    // findBlockingInvoiceLinkage(). Vacío por default: no bloquea ninguna
    // cancelación existente salvo que un test explícito llame a seed().
    private charges = new Map<string, FinancialTransaction[]>();
    setPaid(reservationId: string, amount: number): void { this.paid.set(reservationId, amount); }
    async getSettledPaymentTotalForReservation(reservationId: string): Promise<number> {
      return this.paid.get(reservationId) ?? 0;
    }
    seedCharge(reservationId: string, tx: FinancialTransaction): void {
      const existing = this.charges.get(reservationId) ?? [];
      this.charges.set(reservationId, [...existing, tx]);
    }
    async getByReservationId(reservationId: string): Promise<FinancialTransaction[]> {
      return this.charges.get(reservationId) ?? [];
    }
  }

  /**
   * RESERVA-10 (05/09/2026) -- fake mínimo, solo `resolveInvoiceLinkage()`.
   * Por default cualquier `financialTransactionId` resuelve a
   * `{ kind: 'NONE' }` (sin factura) para no bloquear ninguna cancelación
   * existente; `seed()` carga un linkage puntual para los tests del guard.
   */
  class FakeInvoiceRepositoryForReservations {
    private readonly byChargeId = new Map<string, InvoiceLinkage>();
    seed(financialTransactionId: string, linkage: InvoiceLinkage): void {
      this.byChargeId.set(financialTransactionId, linkage);
    }
    async resolveInvoiceLinkage(financialTransactionId: string): Promise<InvoiceLinkage> {
      return this.byChargeId.get(financialTransactionId) ?? { kind: 'NONE' };
    }
  }

  // K3 (23/08/2026, pendientes-2026-08-23.md) — capacity=4 (antes caía al
  // default de 1): createReservation() ahora deriva partySize real de
  // adultos+ninos, y varios tests de "adultos/ninos" de este archivo usan
  // combinaciones de hasta 4 personas contra este mismo recurso compartido.
  const table = new BookableResource('t1', 'Mesa Ventana', 50, 'cat-table', {
    shape: 'RECTANGLE',
    width: 120,
    height: 80,
    positionX: 0,
    positionY: 0,
    rotationDegrees: 0,
  }, 4);

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
    maintenanceWindowRepo = new InMemoryMaintenanceWindowRepository();
    depositPolicyRepo     = new InMemoryDepositPolicyRepository();
    financialTransactionRepo = new FakePaymentLedger();
    invoiceRepo           = new FakeInvoiceRepositoryForReservations();
    numberSequenceRepo    = new InMemoryNumberSequenceRepository();

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
      maintenanceWindowRepo,
      depositPolicyRepo,
      businessProfileRepo,
      financialTransactionRepo,
      invoiceRepo,
      numberSequenceRepo,
      FROZEN_TEST_NOW,
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

    it('Bug 2 (25/08/2026) — lockea los recursos (ordenados por id) antes de chequear disponibilidad', async () => {
      // Segundo recurso, id menor a 't1' a propósito -- si el fix ordenara
      // mal (o no ordenara), este test lo detecta.
      const other = new BookableResource('a-other', 'Otro recurso', 30, 'cat-table', null, 4);
      await resourceRepo.save(other);
      // 27/08/2026: el fixture referenciaba 'svc-1' sin sembrarlo nunca. Pasaba
      // en silencio (endTime explícito + fallback de precio a basePrice); el
      // guard de serviceId inexistente (R15) lo destapó. El test es sobre el
      // ORDEN de lockByIds, así que el servicio solo tiene que existir.
      bookableServiceRepo.seed({
        id: 'svc-1', categoryId: 'cat-table', name: 'Servicio de locks',
        bookingMode: 'slot', durationMinutes: null, price: 30,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      lockRepo.seed([{ serviceId: 'svc-1', resourceId: 'a-other', sortOrder: 0 }]);

      const lockSpy = vi.spyOn(resourceRepo, 'lockByIds');

      await service.createReservation({
        id: 'res-1',
        resourceId: 't1',
        serviceId: 'svc-1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });

      expect(lockSpy).toHaveBeenCalledOnce();
      const [, lockedIds] = lockSpy.mock.calls[0]!;
      expect(lockedIds).toEqual(['a-other', 't1']); // orden alfabético, no el orden de resolveLockedResourceIds()
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

    it('debe rechazar si el recurso tiene una ventana de mantenimiento vigente que se solapa', async () => {
      // 24/08/2026 — reemplaza al viejo test de OUT_OF_SERVICE (housekeeping):
      // el mecanismo de bloqueo ahora es maintenance_windows, no un status
      // de HousekeepingTask. Ventana con endDate fijo que cubre por completo
      // el rango de la reserva ('2026-07-01') -- endDate 2026-12-31 queda
      // >= "hoy" real (findActiveByResourceId lo filtra por eso), así el
      // test no depende de la fecha real del sistema en el momento de correr.
      const window = MaintenanceWindow.create({
        businessId: TEST_BUSINESS_ID, resourceId: 't1',
        startDate: '2026-01-01', endDate: '2026-12-31',
        reason: 'Cañería rota', createdBy: 'user-1',
      });
      maintenanceWindowRepo.seed(window);

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
  // J1 (23/08/2026, pendientes-2026-08-23.md) — no se puede crear/mover una
  // reserva a una fecha/hora de inicio en el pasado. `service` usa
  // FROZEN_TEST_NOW (2020-01-01) como reloj, así que "pasado"/"futuro" se
  // definen relativo a esa fecha, no al reloj real.
  // -------------------------------------------------------------------------
  describe('J1 — startTime en el pasado', () => {
    it('rechaza crear con startTime claramente en el pasado', async () => {
      await expect(
        service.createReservation({
          id: 'res-past', resourceId: 't1', customer,
          startTime: new Date('2019-01-01T20:00:00Z'), endTime: new Date('2019-01-01T22:00:00Z'),
          details: {},
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('acepta crear con startTime dentro de la tolerancia de 5 minutos', async () => {
      const withinTolerance = new Date(FROZEN_TEST_NOW().getTime() - 2 * 60 * 1000);
      const reservation = await service.createReservation({
        id: 'res-within-tolerance', resourceId: 't1', customer,
        startTime: withinTolerance, endTime: new Date(withinTolerance.getTime() + 60 * 60 * 1000),
        details: {},
      });
      expect(reservation.id).toBe('res-within-tolerance');
    });

    it('rechaza mover (updateReservation) el startTime a una fecha ya pasada', async () => {
      await service.createReservation({
        id: 'res-move-past', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00Z'), endTime: new Date('2026-07-01T22:00:00Z'),
        details: {},
      });

      await expect(
        service.updateReservation('res-move-past', { startTime: new Date('2019-01-01T20:00:00Z') }),
      ).rejects.toThrow(InvalidReservationError);
    });
  });

  // -------------------------------------------------------------------------
  // adultos/ninos — desglose de huéspedes (18/08/2026, spec de mejoras PMS)
  // -------------------------------------------------------------------------
  describe('adultos/ninos (desglose de huéspedes)', () => {
    it('crea la reserva con adultos y ninos informados', async () => {
      const reservation = await service.createReservation({
        id: 'res-guests-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
        adultos: 2,
        ninos: 1,
      });
      expect(reservation.adultos).toBe(2);
      expect(reservation.ninos).toBe(1);
    });

    it('sin adultos/ninos informados, quedan en null (no aplica)', async () => {
      const reservation = await service.createReservation({
        id: 'res-guests-2',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
      });
      expect(reservation.adultos).toBeNull();
      expect(reservation.ninos).toBeNull();
    });

    it('ninos default 0 si se informa adultos sin ninos', async () => {
      const reservation = await service.createReservation({
        id: 'res-guests-3',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T20:00:00'),
        endTime:   new Date('2026-07-01T22:00:00'),
        details: {},
        adultos: 3,
      });
      expect(reservation.adultos).toBe(3);
      expect(reservation.ninos).toBeNull();
    });

    it('rechaza adultos = 0', async () => {
      await expect(
        service.createReservation({
          id: 'res-guests-4', resourceId: 't1', customer,
          startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
          details: {}, adultos: 0,
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('rechaza ninos negativo', async () => {
      await expect(
        service.createReservation({
          id: 'res-guests-5', resourceId: 't1', customer,
          startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
          details: {}, adultos: 1, ninos: -1,
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('rechaza ninos sin adultos informado', async () => {
      await expect(
        service.createReservation({
          id: 'res-guests-6', resourceId: 't1', customer,
          startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
          details: {}, ninos: 1,
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('updateReservation permite corregir adultos/ninos ("cambio de última hora" en check-in)', async () => {
      await service.createReservation({
        id: 'res-guests-7', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
        details: {}, adultos: 2, ninos: 0,
      });

      const updated = await service.updateReservation('res-guests-7', { adultos: 3, ninos: 1 });
      expect(updated.adultos).toBe(3);
      expect(updated.ninos).toBe(1);
    });

    it('updateReservation con solo adultos/ninos no toca fechas ni recurso', async () => {
      const created = await service.createReservation({
        id: 'res-guests-8', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
        details: {},
      });

      const updated = await service.updateReservation('res-guests-8', { adultos: 1 });
      expect(updated.adultos).toBe(1);
      expect(updated.startTime).toEqual(created.startTime);
      expect(updated.resource.id).toBe(created.resource.id);
    });

    // K3 (23/08/2026, pendientes-2026-08-23.md) — Reservation.ts ya validaba
    // partySize > resource.capacity, pero createReservation() nunca lo
    // recibía (caía siempre al default 1 de la entidad). Estos tests
    // prueban que ahora sí se deriva de adultos+ninos y de verdad valida
    // contra la capacidad real del recurso.
    it('deriva partySize de adultos+ninos y lo persiste en la reserva', async () => {
      const roomCap2 = new BookableResource(
        't-cap2', 'Habitación doble', 80, 'cat-room',
        { shape: 'RECTANGLE', width: 120, height: 80, positionX: 0, positionY: 0, rotationDegrees: 0 },
        2,
      );
      await resourceRepo.save(roomCap2);

      const reservation = await service.createReservation({
        id: 'res-partysize-1', resourceId: 't-cap2', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
        details: {}, adultos: 1, ninos: 1,
      });
      expect(reservation.partySize).toBe(2);
    });

    it('rechaza cuando adultos+ninos supera la capacidad real del recurso', async () => {
      const roomCap2 = new BookableResource(
        't-cap2', 'Habitación doble', 80, 'cat-room',
        { shape: 'RECTANGLE', width: 120, height: 80, positionX: 0, positionY: 0, rotationDegrees: 0 },
        2,
      );
      await resourceRepo.save(roomCap2);

      await expect(
        service.createReservation({
          id: 'res-partysize-2', resourceId: 't-cap2', customer,
          startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
          details: {}, adultos: 3, ninos: 2,
        }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('acepta partySize explícito para negocios de recurso 1:1 (sin adultos/ninos)', async () => {
      const reservation = await service.createReservation({
        id: 'res-partysize-3', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
        details: {}, partySize: 1,
      });
      expect(reservation.partySize).toBe(1);
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

    // Regresión (19/08/2026): email.handlers.ts necesita saber si la
    // reserva es de una categoría de alojamiento para formatear
    // Desde/Hasta con el check-in/check-out ESTÁNDAR del negocio en vez de
    // convertir el instante crudo (que para alojamiento es solo una marca
    // de día calendario, no un horario real).
    it('el payload de reservation.confirmed incluye isLodging según la categoría del recurso', async () => {
      const lodgingCategoryRepo: ICategoryRepository = {
        async findById() {
          return {
            id: 'cat-table', name: 'Habitaciones', fields: [], active: true,
            isLodging: true, isExclusive: true, createdAt: new Date(), updatedAt: new Date(),
          };
        },
        async findAll() { return []; },
        async countActive() { return 0; },
        async create(): Promise<never> { throw new Error('no usado en este test'); },
        async update(): Promise<never> { throw new Error('no usado en este test'); },
        async deactivate() {},
      };
      const lodgingService = new ReservationService(
        reservationRepo, resourceRepo, occupancyRepo, lodgingCategoryRepo,
        eventRepo, txManager, lockRepo, bookableServiceRepo,
        customerRateRepo, operatingHoursRepo, maintenanceWindowRepo,
        depositPolicyRepo, businessProfileRepo, financialTransactionRepo, invoiceRepo, numberSequenceRepo,
        FROZEN_TEST_NOW,
      );

      // 27/08/2026 — una reserva de ALOJAMIENTO necesita servicio
      // (LodgingRequiresServiceError). Este test es sobre el payload del
      // evento, no sobre el precio: alcanza con que el servicio exista.
      // 'slot' y no 'block' a propósito: la reserva de este test es de 20:00 a
      // 22:00 del mismo día (0 noches), y 'block' exigiría al menos una.
      // Un servicio 'slot' sobre un recurso de alojamiento es un caso
      // legítimo y el guard nuevo lo permite explícitamente.
      bookableServiceRepo.seed({
        id: 'svc-estadia', categoryId: 'cat-table', name: 'Actividad en el hotel',
        bookingMode: 'slot', durationMinutes: null, price: 50,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      await lodgingService.createReservation({
        id: 'res-lodging', resourceId: 't1', serviceId: 'svc-estadia', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });
      await lodgingService.confirmReservation('res-lodging', TEST_BUSINESS_ID);

      const event = eventRepo.events[0] as { payload: { isLodging: boolean } };
      expect(event.payload.isLodging).toBe(true);
    });
  });

  describe('cancelReservation — RESERVA-10 (05/09/2026) -- guard fail-closed contra factura vinculada', () => {
    function makeCharge(reservationId: string, chargeId: string): FinancialTransaction {
      return {
        id: chargeId, businessId: TEST_BUSINESS_ID, customerId: customer.id,
        reservationId, type: 'CHARGE', amount: 100, currency: 'ARS', status: 'SETTLED',
        createdAt: new Date(),
      };
    }

    async function crearYConfirmar(id = 'res-1'): Promise<void> {
      await service.createReservation({
        id, resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });
      await service.confirmReservation(id, TEST_BUSINESS_ID);
    }

    it('rechaza cancelar si el cargo tiene una factura ISSUED (CAE real de AFIP)', async () => {
      await crearYConfirmar('res-1');
      const chargeId = 'charge-res-1';
      financialTransactionRepo.seedCharge('res-1', makeCharge('res-1', chargeId));
      invoiceRepo.seed(chargeId, { kind: 'ISSUED', invoiceId: 'inv-1' });

      await expect(service.cancelReservation('res-1', TEST_BUSINESS_ID))
        .rejects.toThrow(ReservationChargeInvoicedError);

      // La reserva sigue como estaba -- ningún evento de cancelación salió.
      expect(eventRepo.events.some((e) => (e as { eventType: string }).eventType === 'reservation.cancelled')).toBe(false);
    });

    it('rechaza cancelar si el cargo tiene una factura NOT_ISSUED en PENDING', async () => {
      await crearYConfirmar('res-1');
      const chargeId = 'charge-res-1';
      financialTransactionRepo.seedCharge('res-1', makeCharge('res-1', chargeId));
      invoiceRepo.seed(chargeId, { kind: 'NOT_ISSUED', invoiceId: 'inv-1', status: 'PENDING', afipContacted: false });

      await expect(service.cancelReservation('res-1', TEST_BUSINESS_ID))
        .rejects.toThrow(ReservationChargeInvoicedError);
    });

    it('rechaza cancelar si la factura quedó FAILED_UNCERTAIN habiendo contactado a AFIP (A8.6)', async () => {
      await crearYConfirmar('res-1');
      const chargeId = 'charge-res-1';
      financialTransactionRepo.seedCharge('res-1', makeCharge('res-1', chargeId));
      invoiceRepo.seed(chargeId, { kind: 'NOT_ISSUED', invoiceId: 'inv-1', status: 'FAILED_UNCERTAIN', afipContacted: true });

      await expect(service.cancelReservation('res-1', TEST_BUSINESS_ID))
        .rejects.toThrow(ReservationChargeInvoicedError);
    });

    it('permite cancelar si la factura fue REJECTED por AFIP (no hay comprobante real)', async () => {
      await crearYConfirmar('res-1');
      const chargeId = 'charge-res-1';
      financialTransactionRepo.seedCharge('res-1', makeCharge('res-1', chargeId));
      invoiceRepo.seed(chargeId, { kind: 'NOT_ISSUED', invoiceId: 'inv-1', status: 'REJECTED', afipContacted: true });

      const cancelled = await service.cancelReservation('res-1', TEST_BUSINESS_ID);
      expect(cancelled.status).toBe(ReservationStatus.CANCELLED);
    });

    it('permite cancelar si la factura quedó FAILED_UNCERTAIN SIN contactar a AFIP', async () => {
      await crearYConfirmar('res-1');
      const chargeId = 'charge-res-1';
      financialTransactionRepo.seedCharge('res-1', makeCharge('res-1', chargeId));
      invoiceRepo.seed(chargeId, { kind: 'NOT_ISSUED', invoiceId: 'inv-1', status: 'FAILED_UNCERTAIN', afipContacted: false });

      const cancelled = await service.cancelReservation('res-1', TEST_BUSINESS_ID);
      expect(cancelled.status).toBe(ReservationStatus.CANCELLED);
    });

    it('permite cancelar si el cargo no tiene ninguna factura vinculada (caso normal)', async () => {
      await crearYConfirmar('res-1');
      financialTransactionRepo.seedCharge('res-1', makeCharge('res-1', 'charge-res-1'));
      // sin invoiceRepo.seed(): resuelve a { kind: 'NONE' } por default.

      const cancelled = await service.cancelReservation('res-1', TEST_BUSINESS_ID);
      expect(cancelled.status).toBe(ReservationStatus.CANCELLED);
    });

    it('ignora un PAYMENT de la misma reserva -- sólo mira los CHARGE', async () => {
      await crearYConfirmar('res-1');
      financialTransactionRepo.seedCharge('res-1', {
        id: 'pay-res-1', businessId: TEST_BUSINESS_ID, customerId: customer.id,
        reservationId: 'res-1', type: 'PAYMENT', amount: 100, currency: 'ARS', status: 'SETTLED',
        createdAt: new Date(),
      });
      // Un PAYMENT con una factura ISSUED vinculada NO debería bloquear --
      // el guard filtra por type === 'CHARGE' antes de resolver linkage.
      invoiceRepo.seed('pay-res-1', { kind: 'ISSUED', invoiceId: 'inv-1' });

      const cancelled = await service.cancelReservation('res-1', TEST_BUSINESS_ID);
      expect(cancelled.status).toBe(ReservationStatus.CANCELLED);
    });
  });

  // -------------------------------------------------------------------------
  // C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md)
  // -------------------------------------------------------------------------
  describe('seña/depósito (C1-Fase A)', () => {
    /** Devuelve el mismo perfil que businessProfileRepo, con overrides puntuales. */
    function makeBusinessProfileRepo(overrides: { defaultDepositPercentage?: number | null; depositHoldHours?: number | null }) {
      return {
        async get() {
          const base = await businessProfileRepo.get();
          return { ...base, ...overrides };
        },
      };
    }

    it('sin política de seña configurada, deposit_amount es 0 y confirmar no exige ningún pago', async () => {
      const reservation = await service.createReservation({
        id: 'res-nosena', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });
      expect(reservation.depositAmount).toBe(0);
      expect(reservation.depositDueBy).toBeNull();

      // Sin pago registrado (financialTransactionRepo por default no tiene nada
      // en FakePaymentLedger) y aun así confirma -- el gate no se activa con deposit=0.
      const confirmed = await service.confirmReservation('res-nosena', TEST_BUSINESS_ID);
      expect(confirmed.status).toBe(ReservationStatus.CONFIRMED);
    });

    it('con % default del negocio, deposit_amount se resuelve como % del total y confirmar sin pago falla', async () => {
      const depositService = new ReservationService(
        reservationRepo, resourceRepo, occupancyRepo, categoryRepo,
        eventRepo, txManager, lockRepo, bookableServiceRepo,
        customerRateRepo, operatingHoursRepo, maintenanceWindowRepo,
        depositPolicyRepo, makeBusinessProfileRepo({ defaultDepositPercentage: 30 }), financialTransactionRepo, invoiceRepo, numberSequenceRepo,
        FROZEN_TEST_NOW,
      );

      const reservation = await depositService.createReservation({
        id: 'res-sena30', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });
      // t1 tiene basePrice=50 -- 30% = 15.
      expect(reservation.depositAmount).toBe(15);

      await expect(depositService.confirmReservation('res-sena30', TEST_BUSINESS_ID))
        .rejects.toThrow(DepositNotPaidError);
    });

    it('confirma una vez que el pago registrado cubre la seña', async () => {
      const depositService = new ReservationService(
        reservationRepo, resourceRepo, occupancyRepo, categoryRepo,
        eventRepo, txManager, lockRepo, bookableServiceRepo,
        customerRateRepo, operatingHoursRepo, maintenanceWindowRepo,
        depositPolicyRepo, makeBusinessProfileRepo({ defaultDepositPercentage: 30 }), financialTransactionRepo, invoiceRepo, numberSequenceRepo,
        FROZEN_TEST_NOW,
      );

      await depositService.createReservation({
        id: 'res-sena-pagada', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });

      financialTransactionRepo.setPaid('res-sena-pagada', 15);

      const confirmed = await depositService.confirmReservation('res-sena-pagada', TEST_BUSINESS_ID);
      expect(confirmed.status).toBe(ReservationStatus.CONFIRMED);
    });

    it('un override de deposit_policies a nivel recurso gana sobre el default del negocio', async () => {
      depositPolicyRepo.seed({
        id: 'dp-1', businessId: TEST_BUSINESS_ID,
        resourceId: 't1', serviceId: null, categoryId: null, bucket: null,
        percentage: 50, active: true,
      });
      const depositService = new ReservationService(
        reservationRepo, resourceRepo, occupancyRepo, categoryRepo,
        eventRepo, txManager, lockRepo, bookableServiceRepo,
        customerRateRepo, operatingHoursRepo, maintenanceWindowRepo,
        depositPolicyRepo, makeBusinessProfileRepo({ defaultDepositPercentage: 30 }), financialTransactionRepo, invoiceRepo, numberSequenceRepo,
        FROZEN_TEST_NOW,
      );

      const reservation = await depositService.createReservation({
        id: 'res-override', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });
      // t1 basePrice=50 -- override de 50% (no el default de 30%) = 25.
      expect(reservation.depositAmount).toBe(25);
    });

    it('deposit_due_by se calcula a partir de deposit_hold_hours cuando hay seña', async () => {
      const depositService = new ReservationService(
        reservationRepo, resourceRepo, occupancyRepo, categoryRepo,
        eventRepo, txManager, lockRepo, bookableServiceRepo,
        customerRateRepo, operatingHoursRepo, maintenanceWindowRepo,
        depositPolicyRepo, makeBusinessProfileRepo({ defaultDepositPercentage: 30, depositHoldHours: 24 }), financialTransactionRepo, invoiceRepo, numberSequenceRepo,
        FROZEN_TEST_NOW,
      );

      const before = Date.now();
      const reservation = await depositService.createReservation({
        id: 'res-hold', resourceId: 't1', customer,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'), details: {},
      });
      expect(reservation.depositDueBy).not.toBeNull();
      const diffHours = (reservation.depositDueBy!.getTime() - before) / (60 * 60 * 1000);
      expect(diffHours).toBeGreaterThan(23.9);
      expect(diffHours).toBeLessThan(24.1);
    });

    it('Reservation.expire(): PENDING -> EXPIRED es válida y terminal', () => {
      const reservation = Reservation.restore({
        id: 'res-expire', customer, resource: table,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
        details: {}, totalPrice: 50, initialStatus: ReservationStatus.PENDING, reservationNumber: 1,
        appliedCustomerRateId: null,
      });

      expect(reservation.allowedTransitions).toEqual(['CONFIRMED', 'CANCELLED', 'EXPIRED']);
      reservation.expire();
      expect(reservation.status).toBe(ReservationStatus.EXPIRED);
      expect(reservation.allowedTransitions).toEqual([]);
      expect(() => reservation.expire()).toThrow(InvalidReservationError);
    });

    it('Reservation.expire(): CONFIRMED -> EXPIRED es inválida (solo desde PENDING)', () => {
      const reservation = Reservation.restore({
        id: 'res-confirmed', customer, resource: table,
        startTime: new Date('2026-07-01T20:00:00'), endTime: new Date('2026-07-01T22:00:00'),
        details: {}, totalPrice: 50, initialStatus: ReservationStatus.CONFIRMED, reservationNumber: 2,
        appliedCustomerRateId: null,
      });

      expect(() => reservation.expire()).toThrow(InvalidReservationError);
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

    it('debe retornar false cuando el recurso tiene una ventana de mantenimiento vigente, sin conflicto de horario', async () => {
      // 24/08/2026 — reemplaza al viejo test de OUT_OF_SERVICE (housekeeping):
      // ver comentario del test equivalente en el describe de createReservation.
      const window = MaintenanceWindow.create({
        businessId: TEST_BUSINESS_ID, resourceId: 't1',
        startDate: '2026-01-01', endDate: '2026-12-31',
        reason: null, createdBy: 'user-1',
      });
      maintenanceWindowRepo.seed(window);

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

    it('D7 (22/08/2026) -- PENDING recalcula appliedCustomerRateId si aparece una tarifa especial nueva', async () => {
      await createBase();
      customerRateRepo.seed([{
        id: 'rate-update-1', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: 't1', serviceId: null, productId: null, categoryId: null, bucket: null,
        fixedPrice: 30, discountPercentage: null, rateCatalogId: null, active: true,
      }]);

      const updated = await service.updateReservation('res-1', {
        startTime: new Date('2026-08-01T18:00:00Z'),
      });

      expect(updated.appliedCustomerRateId).toBe('rate-update-1');
      expect(updated.totalPrice).toBe(30);
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

    it('debe permitir editar una reserva CONFIRMED (drag-to-move del calendario de PMS)', async () => {
      await createBase();
      await service.confirmReservation('res-1', TEST_BUSINESS_ID);
      const updated = await service.updateReservation('res-1', {
        startTime: new Date('2026-08-01T18:00:00Z'),
      });
      expect(updated.status).toBe('CONFIRMED');
    });

    it('debe reasignar el recurso (drag-to-move a otra habitación) y validar disponibilidad contra el nuevo', async () => {
      const otherTable = new BookableResource('t-drag-target', 'Mesa Drag', 50, 'cat-table', null);
      await resourceRepo.save(otherTable);
      await createBase();
      const updated = await service.updateReservation('res-1', {
        resourceId: 't-drag-target',
      });
      expect(updated.resource.id).toBe('t-drag-target');
      // El recurso original queda libre para esas horas.
      const stillAvailable = await service.checkAvailability(
        't1',
        new Date('2026-08-01T19:00:00Z'),
        new Date('2026-08-01T21:00:00Z'),
      );
      expect(stillAvailable).toBe(true);
    });

    it('debe rechazar reasignar a un recurso ocupado en ese horario', async () => {
      const otherTable = new BookableResource('t-drag-busy', 'Mesa Ocupada', 50, 'cat-table', null);
      await resourceRepo.save(otherTable);
      await createBase('res-1');
      await service.createReservation({
        id: 'res-busy',
        resourceId: 't-drag-busy',
        customer,
        startTime: new Date('2026-08-01T19:00:00Z'),
        endTime:   new Date('2026-08-01T21:00:00Z'),
        details: {},
      });
      await expect(
        service.updateReservation('res-1', { resourceId: 't-drag-busy' }),
      ).rejects.toThrow(InvalidReservationError);
    });

    it('debe rechazar si la reserva está en un estado terminal (CANCELLED/COMPLETED)', async () => {
      await createBase();
      await service.confirmReservation('res-1', TEST_BUSINESS_ID);
      await service.cancelReservation('res-1', TEST_BUSINESS_ID);
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

    // -----------------------------------------------------------------------
    // Recotización al editar (18/08/2026, reportado por el dueño: "el precio
    // no varía al editar/redimensionar"). Alcance confirmado: solo PENDING
    // recalcula, CONFIRMED sigue congelado (ya generó un CHARGE financiero
    // por el total viejo — ver comentario en reservation.service.ts).
    // -----------------------------------------------------------------------
    describe('recotización al editar (PENDING sí, CONFIRMED no)', () => {
      beforeEach(() => {
        bookableServiceRepo.seed({
          id: 'svc-noche-reprice', categoryId: 'cat-table', name: 'Noche de hotel',
          bookingMode: 'block', durationMinutes: null, price: 100,
          active: true, createdAt: new Date(), updatedAt: new Date(),
        });
      });

      it('extender una reserva PENDING (más noches) recalcula totalPrice y regenera las líneas', async () => {
        const created = await service.createReservation({
          id: 'res-extend',
          resourceId: 't1',
          serviceId: 'svc-noche-reprice',
          customer,
          startTime: new Date('2026-09-01T15:00:00Z'),
          endTime:   new Date('2026-09-03T10:00:00Z'), // 2 noches = 200
          details: {},
        });
        expect(created.totalPrice).toBe(200);

        const updated = await service.updateReservation('res-extend', {
          endTime: new Date('2026-09-05T10:00:00Z'), // 4 noches = 400
        });

        expect(updated.totalPrice).toBe(400);
        expect(updated.lines).toHaveLength(4);
      });

      it('achicar una reserva PENDING (menos noches) recalcula totalPrice hacia abajo', async () => {
        await service.createReservation({
          id: 'res-shrink',
          resourceId: 't1',
          serviceId: 'svc-noche-reprice',
          customer,
          startTime: new Date('2026-09-01T15:00:00Z'),
          endTime:   new Date('2026-09-05T10:00:00Z'), // 4 noches = 400
          details: {},
        });

        const updated = await service.updateReservation('res-shrink', {
          endTime: new Date('2026-09-02T10:00:00Z'), // 1 noche = 100
        });

        expect(updated.totalPrice).toBe(100);
        expect(updated.lines).toHaveLength(1);
      });

      it('editar una reserva CONFIRMED sigue sin recalcular el precio (ya tiene un CHARGE emitido)', async () => {
        await service.createReservation({
          id: 'res-confirmed-noprice',
          resourceId: 't1',
          serviceId: 'svc-noche-reprice',
          customer,
          startTime: new Date('2026-09-01T15:00:00Z'),
          endTime:   new Date('2026-09-03T10:00:00Z'), // 2 noches = 200
          details: {},
        });
        await service.confirmReservation('res-confirmed-noprice', TEST_BUSINESS_ID);

        const updated = await service.updateReservation('res-confirmed-noprice', {
          endTime: new Date('2026-09-05T10:00:00Z'), // sería 4 noches = 400 si recotizara
        });

        expect(updated.status).toBe('CONFIRMED');
        expect(updated.totalPrice).toBe(200); // congelado, no 400
      });
    });

    // Bug real encontrado el 19/08/2026 (sesión del ajuste de precio de
    // reservas CONFIRMED, mientras se tocaba este mismo restore()):
    // Reservation.restore() defaultea requestedCheckInTime/CheckOutTime/
    // scheduleApprovalStatus/scheduleApprovedBy/scheduleChargeAmount a
    // null si no se pasan explícitamente, y el UPSERT real
    // (sql.reservation.repository.ts) los escribe sin condicional — CUALQUIER
    // updateReservation() (incluido el drag-to-move/resize del calendario,
    // punto G) borraba en silencio un pedido de horario especial pendiente/
    // aprobado (punto N). No detectado antes porque ningún test comparaba
    // estos campos antes/después de un update.
    it('updateReservation NO borra un pedido de horario especial (early check-in/late check-out) ya aprobado', async () => {
      const seeded = Reservation.restore({
        id: 'res-schedule-preserve',
        customer,
        resource: table,
        startTime: new Date('2026-09-01T15:00:00Z'),
        endTime:   new Date('2026-09-03T10:00:00Z'),
        details: {},
        initialStatus: ReservationStatus.CONFIRMED,
        totalPrice: 0,
        requestedCheckOutTime:  '13:00',
        scheduleApprovalStatus: 'APPROVED',
        scheduleApprovedBy:     'user-front-desk-1',
        scheduleChargeAmount:   500,
        reservationNumber:      42,
        appliedCustomerRateId:  null,
      });
      await reservationRepo.save(seeded);

      const updated = await service.updateReservation('res-schedule-preserve', {
        resourceId: 't1', // mismo recurso, pero fuerza el camino de reasignación/restore
      });

      expect(updated.requestedCheckOutTime).toBe('13:00');
      expect(updated.scheduleApprovalStatus).toBe('APPROVED');
      expect(updated.scheduleApprovedBy).toBe('user-front-desk-1');
      expect(updated.scheduleChargeAmount).toBe(500);
      // D6 (22/08/2026) — mismo criterio que el resto de este test: el
      // número operativo tampoco puede perderse en un restore() de update.
      expect(updated.reservationNumber).toBe(42);
    });

    // Bug seña/mantenimiento (27/08/2026, pendientes-2026-08-27.md) — misma
    // familia que el test de arriba: updateReservation() no reenviaba
    // depositAmount/depositDueBy/needsMaintenanceReview a Reservation.restore(),
    // que los defaultea a 0/null/false, y el UPSERT los escribía sin
    // condicional. Editar/mover una reserva con seña cobrada la ponía en $0 en
    // silencio (dinero, A3.9) y apagaba el snapshot de mantenimiento (A6.x).
    it('updateReservation NO borra la seña ni el snapshot de mantenimiento (deposit/needsMaintenanceReview)', async () => {
      const dueBy = new Date('2026-08-30T23:59:00Z');
      const seeded = Reservation.restore({
        id: 'res-deposit-preserve',
        customer,
        resource: table,
        startTime: new Date('2026-09-01T15:00:00Z'),
        endTime:   new Date('2026-09-03T10:00:00Z'),
        details: {},
        initialStatus: ReservationStatus.CONFIRMED, // CONFIRMED no recotiza: totalPrice queda congelado
        totalPrice: 200,
        depositAmount: 50,
        depositDueBy: dueBy,
        needsMaintenanceReview: true,
        reservationNumber: 77,
        appliedCustomerRateId: null,
      });
      await reservationRepo.save(seeded);

      const updated = await service.updateReservation('res-deposit-preserve', {
        resourceId: 't1', // fuerza el camino de restore, igual que el test de horario especial
      });

      expect(updated.depositAmount).toBe(50);
      expect(updated.depositDueBy).toEqual(dueBy);
      expect(updated.needsMaintenanceReview).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('previewPriceAdjustment / confirmPriceAdjustment (reserva CONFIRMED) — 19/08/2026, pendientes-2026-08-18.md punto I', () => {
    beforeEach(() => {
      bookableServiceRepo.seed({
        id: 'svc-noche-adjust', categoryId: 'cat-table', name: 'Noche de hotel',
        bookingMode: 'block', durationMinutes: null, price: 100,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
    });

    it('previewPriceAdjustment devuelve null para una reserva PENDING (no aplica)', async () => {
      await service.createReservation({
        id: 'res-preview-pending', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-03T10:00:00Z'),
        details: {},
      });
      expect(await service.previewPriceAdjustment('res-preview-pending')).toBeNull();
    });

    it('previewPriceAdjustment devuelve null si no hay diferencia (mismas fechas)', async () => {
      await service.createReservation({
        id: 'res-preview-same', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-03T10:00:00Z'), // 200
        details: {},
      });
      await service.confirmReservation('res-preview-same', TEST_BUSINESS_ID);
      expect(await service.previewPriceAdjustment('res-preview-same')).toBeNull();
    });

    it('previewPriceAdjustment muestra la diferencia positiva al extender una reserva CONFIRMED', async () => {
      await service.createReservation({
        id: 'res-preview-extend', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-03T10:00:00Z'), // 200
        details: {},
      });
      await service.confirmReservation('res-preview-extend', TEST_BUSINESS_ID);
      // totalPrice sigue congelado en 200 -- solo cambian fechas/lo que costaría hoy.
      await service.updateReservation('res-preview-extend', { endTime: new Date('2026-09-05T10:00:00Z') }); // 4 noches

      const preview = await service.previewPriceAdjustment('res-preview-extend');
      expect(preview).toEqual({ currentTotalPrice: 200, recalculatedTotalPrice: 400, difference: 200 });
    });

    it('previewPriceAdjustment muestra la diferencia negativa al achicar una reserva CONFIRMED', async () => {
      await service.createReservation({
        id: 'res-preview-shrink', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-05T10:00:00Z'), // 400
        details: {},
      });
      await service.confirmReservation('res-preview-shrink', TEST_BUSINESS_ID);
      await service.updateReservation('res-preview-shrink', { endTime: new Date('2026-09-02T10:00:00Z') }); // 1 noche

      const preview = await service.previewPriceAdjustment('res-preview-shrink');
      expect(preview).toEqual({ currentTotalPrice: 400, recalculatedTotalPrice: 100, difference: -300 });
    });

    it('confirmPriceAdjustment aplica el nuevo totalPrice/lines y emite reservation.price_adjusted con el monto con signo', async () => {
      await service.createReservation({
        id: 'res-confirm-adjust', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-03T10:00:00Z'), // 200
        details: {},
      });
      await service.confirmReservation('res-confirm-adjust', TEST_BUSINESS_ID);
      eventRepo.events = []; // solo nos interesa el evento del ajuste, no el de confirmación
      await service.updateReservation('res-confirm-adjust', { endTime: new Date('2026-09-05T10:00:00Z') });

      const updated = await service.confirmPriceAdjustment('res-confirm-adjust', TEST_BUSINESS_ID, 'user-manager-1');

      expect(updated.totalPrice).toBe(400);
      expect(updated.lines).toHaveLength(4);
      expect(eventRepo.events).toHaveLength(1);
      expect(eventRepo.events[0]).toMatchObject({
        eventType: 'reservation.price_adjusted',
        payload: expect.objectContaining({
          reservationId: 'res-confirm-adjust',
          amount: 200,
          previousTotalPrice: 200,
          newTotalPrice: 400,
          confirmedByUserId: 'user-manager-1',
        }),
      });
    });

    it('confirmPriceAdjustment rechaza si no se informa confirmedByUserId', async () => {
      await service.createReservation({
        id: 'res-confirm-noattr', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-03T10:00:00Z'),
        details: {},
      });
      await service.confirmReservation('res-confirm-noattr', TEST_BUSINESS_ID);
      await service.updateReservation('res-confirm-noattr', { endTime: new Date('2026-09-05T10:00:00Z') });

      await expect(service.confirmPriceAdjustment('res-confirm-noattr', TEST_BUSINESS_ID, ''))
        .rejects.toThrow('confirmedByUserId es obligatorio');
    });

    it('confirmPriceAdjustment con una reserva achicada emite un ajuste NEGATIVO (nota de crédito)', async () => {
      await service.createReservation({
        id: 'res-confirm-credit', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-05T10:00:00Z'), // 400
        details: {},
      });
      await service.confirmReservation('res-confirm-credit', TEST_BUSINESS_ID);
      eventRepo.events = [];
      await service.updateReservation('res-confirm-credit', { endTime: new Date('2026-09-02T10:00:00Z') }); // 1 noche

      const updated = await service.confirmPriceAdjustment('res-confirm-credit', TEST_BUSINESS_ID, 'user-manager-1');

      expect(updated.totalPrice).toBe(100);
      expect(eventRepo.events[0]).toMatchObject({
        payload: expect.objectContaining({ amount: -300, previousTotalPrice: 400, newTotalPrice: 100 }),
      });
    });

    it('confirmPriceAdjustment rechaza con NoPriceAdjustmentPendingError si no hay diferencia que confirmar', async () => {
      await service.createReservation({
        id: 'res-confirm-nodiff', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-03T10:00:00Z'),
        details: {},
      });
      await service.confirmReservation('res-confirm-nodiff', TEST_BUSINESS_ID);

      await expect(service.confirmPriceAdjustment('res-confirm-nodiff', TEST_BUSINESS_ID, 'user-manager-1'))
        .rejects.toThrow(NoPriceAdjustmentPendingError);
    });

    it('confirmPriceAdjustment rechaza una reserva que no está CONFIRMED', async () => {
      await service.createReservation({
        id: 'res-confirm-pending', resourceId: 't1', serviceId: 'svc-noche-adjust', customer,
        startTime: new Date('2026-09-01T15:00:00Z'), endTime: new Date('2026-09-03T10:00:00Z'),
        details: {},
      });

      await expect(service.confirmPriceAdjustment('res-confirm-pending', TEST_BUSINESS_ID, 'user-manager-1'))
        .rejects.toThrow(InvalidReservationError);
    });

    // Bug needsMaintenanceReview (27/08/2026, pendientes-2026-08-27.md) — el
    // restore() de confirmPriceAdjustment tampoco reenviaba
    // needsMaintenanceReview (la NOTA previa lo dejaba documentado sin
    // corregir). Un ajuste de precio apagaba el snapshot de mantenimiento en
    // silencio. Se siembra una CONFIRMED con totalPrice congelado desfasado
    // para que el ajuste dispare sin pasar por updateReservation — aísla este
    // restore().
    it('confirmPriceAdjustment NO borra el snapshot de mantenimiento (needsMaintenanceReview)', async () => {
      const seeded = Reservation.restore({
        id: 'res-adjust-maint',
        customer,
        resource: table,
        serviceId: 'svc-noche-adjust',
        startTime: new Date('2026-09-01T15:00:00Z'),
        endTime:   new Date('2026-09-05T10:00:00Z'), // 4 noches = $400 hoy
        details: {},
        initialStatus: ReservationStatus.CONFIRMED,
        totalPrice: 200, // congelado/desfasado a propósito → ajuste pendiente de $200
        needsMaintenanceReview: true,
        reservationNumber: 88,
        appliedCustomerRateId: null,
      });
      await reservationRepo.save(seeded);

      const updated = await service.confirmPriceAdjustment('res-adjust-maint', TEST_BUSINESS_ID, 'user-manager-1');

      expect(updated.totalPrice).toBe(400); // el ajuste se aplicó
      expect(updated.needsMaintenanceReview).toBe(true); // y el snapshot sobrevivió
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
      // D7 (22/08/2026) -- sin tarifa especial, appliedCustomerRateId queda null.
      expect(reservation.appliedCustomerRateId).toBeNull();
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
        resourceId: 't1', serviceId: null, productId: null, categoryId: null, bucket: null, fixedPrice: 40, discountPercentage: null, rateCatalogId: null, active: true,
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
      // D7 (22/08/2026) -- se congela qué CustomerRate se usó (reporte "tarifas aplicadas").
      expect(reservation.appliedCustomerRateId).toBe('rate-1');
    });

    it('D5: tarifa especial de cliente+recurso como % de descuento, calcula contra basePrice del recurso', async () => {
      // t1 tiene basePrice=50 (ver arriba) -- 20% de descuento = 40.
      customerRateRepo.seed([{
        id: 'rate-pct-1', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: 't1', serviceId: null, productId: null, categoryId: null, bucket: null, fixedPrice: null, discountPercentage: 20, rateCatalogId: null, active: true,
      }]);

      const reservation = await service.createReservation({
        id: 'res-precio-pct-1',
        resourceId: 't1',
        customer,
        startTime: new Date('2026-07-01T09:00:00'),
        endTime:   new Date('2026-07-01T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(40);
    });

    it('D5: tarifa especial de cliente+servicio como % de descuento, calcula contra el precio de catálogo del servicio', async () => {
      bookableServiceRepo.seed({
        id: 'svc-precio-pct', categoryId: 'cat-table', name: 'Servicio con precio pct',
        bookingMode: 'slot', durationMinutes: 30, price: 40,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      // 25% de descuento sobre 40 = 30.
      customerRateRepo.seed([{
        id: 'rate-pct-2', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: null, serviceId: 'svc-precio-pct', productId: null, categoryId: null, bucket: null, fixedPrice: null, discountPercentage: 25, rateCatalogId: null, active: true,
      }]);

      const reservation = await service.createReservation({
        id: 'res-precio-pct-2',
        resourceId: 't1',
        serviceId: 'svc-precio-pct',
        customer,
        startTime: new Date('2026-07-01T09:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(30);
    });

    it('D9-Parte 1: tarifa a nivel BUCKET (ALOJAMIENTO) se aplica a un recurso de una categoría de alojamiento', async () => {
      const lodgingCategoryRepo: ICategoryRepository = {
        async findById() {
          return {
            id: 'cat-table', name: 'Habitaciones', fields: [], active: true,
            isLodging: true, isExclusive: true, createdAt: new Date(), updatedAt: new Date(),
          };
        },
        async findAll() { return []; },
        async countActive() { return 0; },
        async create(): Promise<never> { throw new Error('no usado en este test'); },
        async update(): Promise<never> { throw new Error('no usado en este test'); },
        async deactivate() {},
      };
      const lodgingService = new ReservationService(
        reservationRepo, resourceRepo, occupancyRepo, lodgingCategoryRepo,
        eventRepo, txManager, lockRepo, bookableServiceRepo,
        customerRateRepo, operatingHoursRepo, maintenanceWindowRepo,
        depositPolicyRepo, businessProfileRepo, financialTransactionRepo, invoiceRepo, numberSequenceRepo,
        FROZEN_TEST_NOW,
      );
      // 27/08/2026 — decisión del dueño, docs/diseno-precio-servicio-vs-
      // recurso-2026-08-27.md: desde que una reserva de ALOJAMIENTO exige
      // servicio (LodgingRequiresServiceError), la cascada entra siempre por
      // la rama de SERVICIO y retorna ahí -- nunca llega a la del recurso.
      // Eso deja inalcanzables los dos alcances que se resolvían por recurso:
      // `resource_id` y `bucket = 'ALOJAMIENTO'`.
      //
      // Se aceptó a propósito ("re-scopear las tarifas"): en alojamiento una
      // tarifa especial se define sobre el SERVICIO o sobre la CATEGORÍA (que
      // sí sigue funcionando -- el servicio pertenece a la misma categoría
      // que el recurso). Este test dejó de verificar que el bucket se aplica
      // y pasa a ser la cerca que avisa si alguien lo revive sin querer.
      //
      // Mismo cortocircuito, mismo criterio, en `deposit_policies` (C1-A):
      // una política de seña con `bucket = 'ALOJAMIENTO'` tampoco se alcanza.
      customerRateRepo.seed([{
        id: 'rate-bucket-aloj', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: null, serviceId: null, productId: null, categoryId: null, bucket: 'ALOJAMIENTO',
        fixedPrice: null, discountPercentage: 30, rateCatalogId: null, active: true,
      }]);
      bookableServiceRepo.seed({
        id: 'svc-estadia-bucket', categoryId: 'cat-table', name: 'Estadía',
        bookingMode: 'slot', durationMinutes: null, price: 50,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      const reservation = await lodgingService.createReservation({
        id: 'res-bucket-aloj', resourceId: 't1', serviceId: 'svc-estadia-bucket', customer,
        startTime: new Date('2026-07-01T09:00:00'), endTime: new Date('2026-07-01T10:00:00'), details: {},
      });

      // 50 (precio de catálogo del servicio), NO 35: el 30% del bucket
      // ALOJAMIENTO ya no interviene.
      expect(reservation.totalPrice).toBe(50);
    });

    it('D9-Parte 1: el eje servicio sigue ganando aunque su tarifa sea de nivel BUCKET y la del recurso sea de nivel ÍTEM (default confirmado, no al revés)', async () => {
      bookableServiceRepo.seed({
        id: 'svc-axis', categoryId: 'cat-table', name: 'Servicio eje',
        bookingMode: 'slot', durationMinutes: 30, price: 999,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      customerRateRepo.seed([
        // Eje SERVICIO -- nivel BUCKET (el más débil posible).
        {
          id: 'rate-axis-service', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
          resourceId: null, serviceId: null, productId: null, categoryId: null, bucket: 'SERVICIOS',
          fixedPrice: 7, discountPercentage: null, rateCatalogId: null, active: true,
        },
        // Eje RECURSO -- nivel ÍTEM (el más fuerte posible).
        {
          id: 'rate-axis-resource', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
          resourceId: 't1', serviceId: null, productId: null, categoryId: null, bucket: null,
          fixedPrice: 999, discountPercentage: null, rateCatalogId: null, active: true,
        },
      ]);

      const reservation = await service.createReservation({
        id: 'res-axis', resourceId: 't1', serviceId: 'svc-axis', customer,
        startTime: new Date('2026-07-01T09:00:00'), details: {},
      });

      // Gana el eje servicio (7), no el ítem del eje recurso (999).
      expect(reservation.totalPrice).toBe(7);
    });

    it('con tarifa especial de cliente+servicio, la prioriza sobre el precio de catálogo del servicio', async () => {
      bookableServiceRepo.seed({
        id: 'svc-precio-2', categoryId: 'cat-table', name: 'Servicio con precio 2',
        bookingMode: 'slot', durationMinutes: 30, price: 35,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      customerRateRepo.seed([{
        id: 'rate-2', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: null, serviceId: 'svc-precio-2', productId: null, categoryId: null, bucket: null, fixedPrice: 15, discountPercentage: null, rateCatalogId: null, active: true,
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
        resourceId: null, serviceId: 'svc-noche-3', productId: null, categoryId: null, bucket: null, fixedPrice: 80, discountPercentage: null, rateCatalogId: null, active: true,
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

    // -------------------------------------------------------------------
    // Rate Plans (18/08/2026, spec de mejoras PMS) — precio por tipo de
    // habitación en vez de por recurso físico. Cascada: tarifa especial
    // cliente+servicio > ratePlanId elegido > catálogo del servicio >
    // tarifa especial cliente+recurso > basePrice del recurso.
    // -------------------------------------------------------------------
    it('con ratePlanId, usa el precio de la tarifa en vez del catálogo del servicio', async () => {
      bookableServiceRepo.seed({
        id: 'svc-doble', categoryId: 'cat-table', name: 'Habitación Doble',
        bookingMode: 'block', durationMinutes: null, price: 15000,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seedRatePlan({
        id: 'rp-rack', serviceId: 'svc-doble', name: 'Rack', price: 20000,
        includesBreakfast: false, cancellationPolicy: null,
        validFrom: null, validTo: null, active: true,
        createdAt: new Date(), updatedAt: new Date(),
      });

      const reservation = await service.createReservation({
        id: 'res-rate-plan-1', resourceId: 't1', serviceId: 'svc-doble', ratePlanId: 'rp-rack',
        customer,
        startTime: new Date('2026-07-10T15:00:00'), endTime: new Date('2026-07-11T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(20000); // 1 noche, precio de la tarifa, no los 15000 del servicio
      expect(reservation.ratePlanId).toBe('rp-rack');
    });

    it('la tarifa especial de cliente+servicio sigue ganando por sobre ratePlanId', async () => {
      bookableServiceRepo.seed({
        id: 'svc-doble-2', categoryId: 'cat-table', name: 'Habitación Doble 2',
        bookingMode: 'block', durationMinutes: null, price: 15000,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seedRatePlan({
        id: 'rp-rack-2', serviceId: 'svc-doble-2', name: 'Rack', price: 20000,
        includesBreakfast: false, cancellationPolicy: null,
        validFrom: null, validTo: null, active: true,
        createdAt: new Date(), updatedAt: new Date(),
      });
      customerRateRepo.seed([{
        id: 'rate-negociada', businessId: TEST_BUSINESS_ID, customerId: 'cust-1',
        resourceId: null, serviceId: 'svc-doble-2', productId: null, categoryId: null, bucket: null, fixedPrice: 12000, discountPercentage: null, rateCatalogId: null, active: true,
      }]);

      const reservation = await service.createReservation({
        id: 'res-rate-plan-2', resourceId: 't1', serviceId: 'svc-doble-2', ratePlanId: 'rp-rack-2',
        customer,
        startTime: new Date('2026-07-10T15:00:00'), endTime: new Date('2026-07-11T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(12000); // el descuento negociado gana, no la tarifa pública
    });

    it('rechaza un ratePlanId inexistente', async () => {
      bookableServiceRepo.seed({
        id: 'svc-doble-3', categoryId: 'cat-table', name: 'Habitación Doble 3',
        bookingMode: 'block', durationMinutes: null, price: 15000,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });

      await expect(
        service.createReservation({
          id: 'res-rate-plan-3', resourceId: 't1', serviceId: 'svc-doble-3', ratePlanId: 'rp-inexistente',
          customer,
          startTime: new Date('2026-07-10T15:00:00'), endTime: new Date('2026-07-11T10:00:00'),
          details: {},
        }),
      ).rejects.toThrow(RatePlanNotAvailableError);
    });

    it('rechaza una tarifa desactivada', async () => {
      bookableServiceRepo.seed({
        id: 'svc-doble-4', categoryId: 'cat-table', name: 'Habitación Doble 4',
        bookingMode: 'block', durationMinutes: null, price: 15000,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seedRatePlan({
        id: 'rp-vieja', serviceId: 'svc-doble-4', name: 'Discontinuada', price: 18000,
        includesBreakfast: false, cancellationPolicy: null,
        validFrom: null, validTo: null, active: false,
        createdAt: new Date(), updatedAt: new Date(),
      });

      await expect(
        service.createReservation({
          id: 'res-rate-plan-4', resourceId: 't1', serviceId: 'svc-doble-4', ratePlanId: 'rp-vieja',
          customer,
          startTime: new Date('2026-07-10T15:00:00'), endTime: new Date('2026-07-11T10:00:00'),
          details: {},
        }),
      ).rejects.toThrow(RatePlanNotAvailableError);
    });

    // Temporada (28/08/2026, pendientes-2026-08-27.md ítem 5) -- antes esto
    // RECHAZABA la reserva completa (RatePlanNotAvailableError) si la fecha
    // de INICIO caía fuera de la vigencia de la fila elegida. Ahora resuelve
    // por noche: sin ninguna fila de temporada que cubra esa noche puntual,
    // cae al precio de CATÁLOGO del servicio (mismo fallback que "sin
    // ratePlanId elegido") en vez de romper toda la cotización -- un hueco
    // de configuración en una noche no debe impedir reservar.
    it('sin ninguna fila de temporada vigente esa noche, cae al precio de catálogo (ya no rechaza)', async () => {
      bookableServiceRepo.seed({
        id: 'svc-doble-5', categoryId: 'cat-table', name: 'Habitación Doble 5',
        bookingMode: 'block', durationMinutes: null, price: 15000,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seedRatePlan({
        id: 'rp-temporada', serviceId: 'svc-doble-5', name: 'Temporada baja', price: 12000,
        includesBreakfast: false, cancellationPolicy: null,
        validFrom: '2026-06-01', validTo: '2026-06-30', active: true,
        createdAt: new Date(), updatedAt: new Date(),
      });

      // La reserva es en julio, la única fila de "Temporada baja" solo vale en junio.
      const reservation = await service.createReservation({
        id: 'res-rate-plan-5', resourceId: 't1', serviceId: 'svc-doble-5', ratePlanId: 'rp-temporada',
        customer,
        startTime: new Date('2026-07-10T15:00:00'), endTime: new Date('2026-07-11T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(15000); // precio de catálogo de svc-doble-5, no 12000 ni un error
    });

    // El bug real reportado (pendientes-2026-08-27.md): una estadía que
    // cruza el cambio de temporada cobraba TODAS las noches a la tarifa del
    // día de entrada. Dos filas "Estadía" con el MISMO nombre y vigencias
    // consecutivas sin solapar (permitido desde este fix, ver
    // excl_rate_plans_overlapping_validity en schema.sql) -- cada noche debe
    // cobrar la que le corresponde.
    it('una estadía que cruza el cambio de temporada cobra cada noche a SU tarifa, no todas a la del día de entrada', async () => {
      bookableServiceRepo.seed({
        id: 'svc-cruce-temporada', categoryId: 'cat-table', name: 'Cabaña Lago',
        bookingMode: 'block', durationMinutes: null, price: 10000,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seedRatePlan({
        id: 'rp-alta', serviceId: 'svc-cruce-temporada', name: 'Estadía', price: 15000,
        includesBreakfast: false, cancellationPolicy: null,
        validFrom: '2026-02-01', validTo: '2026-02-28', active: true,
        createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seedRatePlan({
        id: 'rp-baja', serviceId: 'svc-cruce-temporada', name: 'Estadía', price: 10000,
        includesBreakfast: false, cancellationPolicy: null,
        validFrom: '2026-03-01', validTo: null, active: true,
        createdAt: new Date(), updatedAt: new Date(),
      });

      // 28/02 (alta) -> 05/03 (baja): 5 noches (28-feb, 1/2/3/4-mar) --
      // 1 a $15000 + 4 a $10000.
      const reservation = await service.createReservation({
        id: 'res-cruce-temporada', resourceId: 't1', serviceId: 'svc-cruce-temporada', ratePlanId: 'rp-alta',
        customer,
        startTime: new Date('2026-02-28T15:00:00'), endTime: new Date('2026-03-05T10:00:00'),
        details: {},
      });

      expect(reservation.lines).toHaveLength(5);
      expect(reservation.lines.map((l) => l.price)).toEqual([15000, 10000, 10000, 10000, 10000]);
      expect(reservation.totalPrice).toBe(15000 + 10000 * 4); // 55000, NO 15000 * 5 (75000, el bug reportado)
    });

    it('acepta una tarifa vigente dentro de su rango validFrom/validTo', async () => {
      bookableServiceRepo.seed({
        id: 'svc-doble-6', categoryId: 'cat-table', name: 'Habitación Doble 6',
        bookingMode: 'block', durationMinutes: null, price: 15000,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
      bookableServiceRepo.seedRatePlan({
        id: 'rp-vigente', serviceId: 'svc-doble-6', name: 'Temporada alta', price: 25000,
        includesBreakfast: true, cancellationPolicy: null,
        validFrom: '2026-07-01', validTo: '2026-07-31', active: true,
        createdAt: new Date(), updatedAt: new Date(),
      });

      const reservation = await service.createReservation({
        id: 'res-rate-plan-6', resourceId: 't1', serviceId: 'svc-doble-6', ratePlanId: 'rp-vigente',
        customer,
        startTime: new Date('2026-07-10T15:00:00'), endTime: new Date('2026-07-11T10:00:00'),
        details: {},
      });

      expect(reservation.totalPrice).toBe(25000);
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
    const ART = 'America/Argentina/Buenos_Aires';

    it('sin horario configurado (ni recurso ni negocio) devuelve lista vacía', async () => {
      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES, ART);
      expect(slots).toEqual([]);
    });

    it('usa el horario del negocio cuando el recurso no tiene uno propio', async () => {
      operatingHoursRepo.seedBusiness([
        { id: 'bh-1', dayOfWeek: 0, startTime: '09:00:00', endTime: '11:00:00' },
      ]);

      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES, ART);
      expect(slots).toHaveLength(2); // 09:00 y 10:00, turnos de 60min
    });

    it('el horario propio del recurso reemplaza al del negocio, no se combina', async () => {
      operatingHoursRepo.seedBusiness([
        { id: 'bh-1', dayOfWeek: 0, startTime: '08:00:00', endTime: '18:00:00' },
      ]);
      operatingHoursRepo.seedResource('barbero-1', [
        { id: 'rh-1', dayOfWeek: 0, startTime: '14:00:00', endTime: '18:00:00' },
      ]);

      const slots = await service.getAvailableSlots('svc-corte-1h', 'barbero-1', LUNES, ART);

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

      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES, ART);
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

      const slots = await service.getAvailableSlots('svc-corte-1h', 't1', LUNES, ART);
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
        service.getAvailableSlots('svc-alojamiento', 't1', LUNES, ART),
      ).rejects.toThrow(InvalidReservationError);
    });
  });

  // -------------------------------------------------------------------------
  // combineDateAndTime — DST (18/08/2026, política A4.7, criterios-negocio.md)
  //
  // Golden values contra transiciones REALES de America/Santiago 2024
  // (verificadas empíricamente contra luxon 3.7 antes de escribir este
  // test — ver docblock de combineDateAndTime en reservation.service.ts):
  // - Fin de DST (ambigüedad): 2024-04-06 23:59:59 (GMT-3) -> repite hasta
  //   2024-04-06 23:00:00 (GMT-4). Política: toma el offset ESTÁNDAR
  //   (GMT-4, la ocurrencia más tardía).
  // - Inicio de DST (hueco): 2024-09-07 23:59:59 (GMT-4) salta directo a
  //   2024-09-08 01:00:00 (GMT-3) — 00:00 a 00:59 no existen. Política:
  //   avanza por el tamaño del salto (1h), aterriza en un instante válido.
  //
  // Argentina no tiene DST desde 2009 (por eso el resto de la suite usa
  // ART sin sobresaltos) — Chile sí, y es el caso real que motivó no dejar
  // esto sin resolver (ver roadmap de expansión a Chile/Brasil/Paraguay).
  // -------------------------------------------------------------------------
  describe('combineDateAndTime — DST (huso con horario de verano)', () => {
    const SANTIAGO = 'America/Santiago';

    beforeEach(() => {
      bookableServiceRepo.seed({
        id: 'svc-dst-test', categoryId: 'cat-table', name: 'Turno corto',
        bookingMode: 'slot', durationMinutes: 15, price: 10,
        active: true, createdAt: new Date(), updatedAt: new Date(),
      });
    });

    it('hora inexistente (hueco de primavera): avanza por el tamaño del salto, no rechaza ni pierde el horario', async () => {
      // 2024-09-08 es domingo -> dayOfWeek = (0 + 6) % 7 = 6.
      operatingHoursRepo.seedBusiness([
        { id: 'bh-gap', dayOfWeek: 6, startTime: '00:00:00', endTime: '02:00:00' },
      ]);

      const slots = await service.getAvailableSlots(
        'svc-dst-test', 't1', new Date('2024-09-08T00:00:00.000Z'), SANTIAGO,
      );

      // 00:00 (inexistente) se alinea con el instante real de 01:00 (offset
      // ya en horario de verano, GMT-3) -> 2024-09-08T04:00:00Z. Confirma
      // que ninguna franja se pierde ni se rechaza por el hueco.
      expect(slots).toEqual([
        '2024-09-08T04:00:00.000Z',
        '2024-09-08T04:15:00.000Z',
        '2024-09-08T04:30:00.000Z',
        '2024-09-08T04:45:00.000Z',
      ]);
    });

    it('hora ambigua (vuelta de otoño): toma el offset estándar, no el de verano', async () => {
      // 2024-04-06 es sábado -> dayOfWeek = (6 + 6) % 7 = 5.
      operatingHoursRepo.seedBusiness([
        { id: 'bh-ambiguous', dayOfWeek: 5, startTime: '23:00:00', endTime: '23:45:00' },
      ]);

      const slots = await service.getAvailableSlots(
        'svc-dst-test', 't1', new Date('2024-04-06T00:00:00.000Z'), SANTIAGO,
      );

      // 23:00-23:45 ocurre DOS veces esa noche (GMT-3 primero, GMT-4
      // después) — la política A4.7 toma la ocurrencia más tardía (GMT-4,
      // estándar): 23:00 GMT-4 = 2024-04-07T03:00:00Z, no 02:00:00Z (que
      // sería la ocurrencia en horario de verano, GMT-3).
      //
      // TEST-DST-001 (06/09/2026): estos golden values los FUERZA ahora
      // `combineDateAndTime`, no el default de luxon — con el tzdata de ICU
      // 78 luxon resuelve esa hora ambigua al offset de verano (02:00:00Z),
      // que es lo que rompía este test antes del fix.
      expect(slots).toEqual([
        '2024-04-07T03:00:00.000Z',
        '2024-04-07T03:15:00.000Z',
        '2024-04-07T03:30:00.000Z',
      ]);
    });

    it('hora ambigua en el hemisferio norte (America/New_York): también toma el offset estándar', async () => {
      // Vuelta de otoño de EE.UU.: 2024-11-03 02:00 EDT -> 01:00 EST, así
      // que 01:00-01:59 ocurre dos veces. Las reglas de DST de EE.UU. no
      // cambian desde 2007 y están en todo tzdata -> golden values
      // estables, a diferencia de Chile (TEST-DST-001). Prueba que la
      // política A4.7 no es específica de Santiago.
      // 2024-11-03 es domingo -> dayOfWeek = (0 + 6) % 7 = 6.
      operatingHoursRepo.seedBusiness([
        { id: 'bh-ambiguous-ny', dayOfWeek: 6, startTime: '01:00:00', endTime: '01:45:00' },
      ]);

      const slots = await service.getAvailableSlots(
        'svc-dst-test', 't1', new Date('2024-11-03T00:00:00.000Z'), 'America/New_York',
      );

      // 01:00 EST (estándar, la ocurrencia más tardía) = 2024-11-03T06:00:00Z,
      // no 05:00:00Z (que sería 01:00 EDT, verano).
      expect(slots).toEqual([
        '2024-11-03T06:00:00.000Z',
        '2024-11-03T06:15:00.000Z',
        '2024-11-03T06:30:00.000Z',
      ]);
    });
  });
});
