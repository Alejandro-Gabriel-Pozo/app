import { describe, it, expect } from 'vitest';
import { CancellationRefundService } from './cancellation-refund.service.js';
import { Reservation } from './Reservation.js';
import { PhysicalResource } from './resource.entities.js';
import { Customer } from '../clientes-finanzas/customer.entities.js';
import { ReservationStatus } from '../types/enums.js';
import type { ReservationRepository } from './reservation.repository.js';
import type { CancellationPolicyRepository, CancellationPolicy } from './cancellation-policy.repository.js';
import type { FinancialTransactionRepository, FinancialTransaction } from '../clientes-finanzas/financial-transaction.repository.js';
import type { InvoiceRepository } from '../facturacion/invoice.repository.js';
import type { Invoice } from '../facturacion/invoice.entities.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { ReservationNotFoundError, ReservationNotCancelledError, NothingToRefundError, RefundBaseChangedError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function makeReservation(overrides: {
  status?: ReservationStatus;
  checkinInDays?: number;
  /**
   * CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) -- por default
   * `undefined` (Reservation.ts defaultea a `null`, camino LIVE_AT_CANCELLATION,
   * comportamiento de siempre). Pasar un snapshot real ejercita la rama
   * nueva de `CancellationRefundService.resolveRefundPercentage()`.
   * `Reservation.freezeCancellationPolicy()` exige estado CONFIRMED -- para
   * poder construir un fixture ya CANCELLED con snapshot (el caso real que
   * este service necesita probar) esto NO pasa por ese método: arma la
   * reserva vía `restore()` con `initialStatus` ya en el estado pedido y
   * `cancellationPolicySnapshot` en el prop de construcción directamente
   * (mismo mecanismo que usa `SqlReservationRepository.rowToReservation()`
   * al reconstruir desde una fila real -- no hace falta pasar por
   * confirm()+freeze() en un test que solo verifica lectura).
   */
  cancellationPolicySnapshot?: Reservation['cancellationPolicySnapshot'];
} = {}): Reservation {
  const resource = new PhysicalResource('room-1', 'Habitación 1', 100, 'cat-1', null, 2);
  const customer = new Customer('cust-1', 'Juan Garcia', 'juan@example.com');
  const start = daysFromNow(overrides.checkinInDays ?? 10);
  return Reservation.restore({
    id: 'res-1',
    customer,
    resource,
    startTime: start,
    endTime: new Date(start.getTime() + 60 * 60 * 1000),
    details: {},
    totalPrice: 1000,
    reservationNumber: 1,
    appliedCustomerRateId: null,
    initialStatus: overrides.status ?? ReservationStatus.CANCELLED,
    cancellationPolicySnapshot: overrides.cancellationPolicySnapshot ?? null,
  });
}

class FakeReservationRepository implements Pick<ReservationRepository, 'getById'> {
  constructor(private readonly reservation: Reservation | undefined) {}
  async getById(): Promise<Reservation | undefined> { return this.reservation; }
}

// CANCEL-POLICY-SCOPE-BASE-001 Bloque 1 (14/09/2026): las 18 fixtures de
// `tier`/`FakePolicyRepository` de este archivo declaran
// `policyResolutionTiming: 'LIVE_AT_CANCELLATION'` a propósito -- ejercitan
// el camino de SIEMPRE (reserva sin `cancellationPolicySnapshot`, resuelve
// contra `FakePolicyRepository`/la tabla en vivo). No se tocan en el
// Bloque 2: siguen siendo la cobertura de la rama `null` de
// `resolveRefundPercentage()`. La rama `SNAPSHOT_AT_BOOKING` (reserva CON
// `cancellationPolicySnapshot` no-nulo, resuelve en memoria contra el
// ladder congelado, nunca toca `FakePolicyRepository`) tiene su propio
// describe más abajo, `CancellationRefundService -- CANCEL-POLICY-SCOPE-BASE-001
// Bloque 2 (snapshot congelado)`.
class FakePolicyRepository implements Pick<CancellationPolicyRepository, 'findApplicableTier'> {
  /**
   * CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 -- contador de invocaciones. La
   * rama `SNAPSHOT_AT_BOOKING` de `resolveRefundPercentage()` no debe
   * llamar nunca a `findApplicableTier()` (resuelve en memoria contra el
   * ladder congelado) -- este contador es lo que prueba esa ausencia, no
   * solo que el RESULTADO final coincida por casualidad con el tier vivo.
   */
  public calls = 0;
  constructor(private readonly tier: CancellationPolicy | null) {}
  async findApplicableTier(): Promise<CancellationPolicy | null> {
    this.calls += 1;
    return this.tier;
  }
}

class FakeFinancialTransactionRepository implements
  Pick<FinancialTransactionRepository, 'getCollectedPaymentTotalForReservation' | 'createWithClient' | 'getByIdempotencyKey' | 'getByReservationId'> {
  public created: Array<Omit<FinancialTransaction, 'createdAt'>> = [];
  private readonly byIdempotencyKey = new Map<string, FinancialTransaction>();
  constructor(private readonly collected: number) {}
  async getCollectedPaymentTotalForReservation(): Promise<number> { return this.collected; }
  async getByIdempotencyKey(idempotencyKey: string): Promise<FinancialTransaction | undefined> {
    return this.byIdempotencyKey.get(idempotencyKey);
  }
  /** BRECHA-REFUND-01 Fase 3 -- solo lo que confirmRefund() necesita del
   * pre-chequeo de reintento serie: las filas ya creadas por esta fake. */
  async getByReservationId(): Promise<FinancialTransaction[]> {
    return [...this.byIdempotencyKey.values()];
  }
  async createWithClient(_client: SqlClient, tx: Omit<FinancialTransaction, 'createdAt'>): Promise<FinancialTransaction> {
    this.created.push(tx);
    const created: FinancialTransaction = { ...tx, createdAt: new Date() };
    if (tx.idempotencyKey) this.byIdempotencyKey.set(tx.idempotencyKey, created);
    return created;
  }
}

class FakeInvoiceRepository implements Pick<InvoiceRepository, 'getByReservationId' | 'getRefundableForUpdate'> {
  /** BRECHA-REFUND-01 Fase 3 -- por defecto, "refundable" = impTotal (como
   * si estuviera íntegramente cobrada y nada reembolsado todavía) -- misma
   * capa que el comportamiento viejo (Math.min(remaining, impTotal)), para
   * que los tests existentes de reparto no cambien de resultado. Los
   * tests de Fase 3 que necesiten simular "ya se reembolsó parte" usan
   * `refundableOverride`.
   */
  public refundableOverride = new Map<string, number>();
  public lockedInvoiceIds: string[] = [];
  constructor(private readonly invoices: Invoice[]) {}
  async getByReservationId(): Promise<Invoice[]> { return this.invoices; }
  async getRefundableForUpdate(_client: SqlClient, invoiceId: string): Promise<number> {
    this.lockedInvoiceIds.push(invoiceId);
    if (this.refundableOverride.has(invoiceId)) return this.refundableOverride.get(invoiceId)!;
    return this.invoices.find((inv) => inv.id === invoiceId)?.impTotal ?? 0;
  }
}

class FakeBusinessProfileRepository implements Pick<BusinessProfileRepository, 'get'> {
  async get(): Promise<BusinessProfile> {
    const now = new Date();
    return {
      id: 'default', displayName: null, contactEmail: null,
      currency: 'ARS', timezone: 'America/Argentina/Buenos_Aires', defaultCheckInTime: '14:00:00', defaultCheckOutTime: '11:00:00',
      legalName: 'Hotel Test SRL', taxId: '20111111112', taxIdType: 'CUIT', taxCondition: 'Responsable Inscripto',
      fiscalAddressLine1: null, fiscalAddressCity: null, fiscalAddressState: null,
      fiscalAddressPostalCode: null, fiscalAddressCountry: null, afipSalesPoint: 3, afipCuit: null,
      defaultIvaRate: 21, pricesIncludeIva: true,
      defaultDepositPercentage: null, depositHoldHours: null, customerNumberPrefix: 'CLI', reservationNumberPrefix: 'RES',
      maintenanceHorizonDays: 30,
      createdAt: now, updatedAt: now,
    };
  }
}

class InMemoryTransactionManager implements TransactionManager {
  /** BRECHA-REFUND-01 Fase 3 -- queries crudas emitidas sobre `client` (el
   * advisory lock de acquireIdempotencyLock), para poder aseverar que se
   * pidió sin depender de un mock que lo trague en silencio (mismo
   * criterio que FakeTransactionManager en accounts-receivable.service.test.ts). */
  public rawQueries: { sql: string; params: unknown[] | undefined }[] = [];
  async run<T>(work: (client: SqlClient) => Promise<T>): Promise<T> {
    const client: SqlClient = {
      query: async (sql: string, params?: unknown[]) => {
        this.rawQueries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      },
    };
    return work(client);
  }
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = new Date();
  return {
    id: 'inv-1', businessId: 'biz-1', financialTransactionId: 'ft-1', customerId: 'cust-1',
    idempotencyKey: 'invoice:ft-1', environment: 'homologacion',
    ptoVta: 3, cbteTipo: 6, cbteNro: 1,
    concepto: 2, docTipo: 99, docNro: '0', condicionIvaReceptorId: 5,
    moneda: 'PES', impNeto: 826.45, impIva: 173.55, impTotal: 1000,
    cae: 'CAE-1', caeVto: '2026-09-01',
    status: 'ISSUED', afipContacted: true, emisorCuit: '20111111112',
    paymentMethod: null, cardInstallments: null,
    afipRequest: {}, afipResponse: {}, errorMessage: null,
    createdAt: now, issuedAt: now,
    ...overrides,
  };
}

function buildService(opts: {
  reservation?: Reservation | undefined;
  tier?: CancellationPolicy | null;
  collected?: number;
  invoices?: Invoice[];
}) {
  const financialRepo = new FakeFinancialTransactionRepository(opts.collected ?? 0);
  const invoiceRepo = new FakeInvoiceRepository(opts.invoices ?? []);
  const transactionManager = new InMemoryTransactionManager();
  const policyRepo = new FakePolicyRepository(opts.tier ?? null);
  const service = new CancellationRefundService(
    new FakeReservationRepository('reservation' in opts ? opts.reservation : makeReservation()),
    policyRepo,
    financialRepo,
    invoiceRepo,
    new FakeBusinessProfileRepository(),
    transactionManager,
  );
  return { service, financialRepo, invoiceRepo, transactionManager, policyRepo };
}

// ---------------------------------------------------------------------------

describe('CancellationRefundService.previewRefund', () => {
  it('exige que la reserva exista', async () => {
    const { service } = buildService({ reservation: undefined });
    await expect(service.previewRefund('res-1', 'biz-1')).rejects.toThrow(ReservationNotFoundError);
  });

  it('exige que la reserva esté CANCELLED', async () => {
    const { service } = buildService({ reservation: makeReservation({ status: ReservationStatus.CONFIRMED }) });
    await expect(service.previewRefund('res-1', 'biz-1')).rejects.toThrow(ReservationNotCancelledError);
  });

  it('sin política aplicable, 0% y refundAmount 0 (sin comportamiento automático)', async () => {
    const { service } = buildService({ collected: 1000, tier: null });
    const preview = await service.previewRefund('res-1', 'biz-1');
    expect(preview.refundPercentage).toBe(0);
    expect(preview.refundAmount).toBe(0);
    expect(preview.collected).toBe(1000);
  });

  it('calcula el reembolso solo sobre lo cobrado, según el tramo aplicable', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
    });
    const preview = await service.previewRefund('res-1', 'biz-1');
    expect(preview.refundAmount).toBe(500);
  });
});

describe('CancellationRefundService.confirmRefund', () => {
  it('no crea una fila REFUND de $0 (NothingToRefundError)', async () => {
    const { service } = buildService({ collected: 1000, tier: null });
    await expect(service.confirmRefund('res-1', 'biz-1', 'user-1')).rejects.toThrow(NothingToRefundError);
  });

  it('sin facturas ISSUED, crea un único REFUND ledger-only (reversedInvoiceId null)', async () => {
    const { service, financialRepo } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(500);
    expect(created[0]?.reversedInvoiceId).toBeNull();
    expect(created[0]?.type).toBe('REFUND');
    expect(created[0]?.status).toBe('SETTLED');
    expect(created[0]?.confirmedBy).toBe('user-1');
    expect(financialRepo.created).toHaveLength(1);
  });

  it('una sola factura ISSUED cubre el reembolso completo', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [makeInvoice({ id: 'inv-deposito', impTotal: 500, issuedAt: daysFromNow(-5) })],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(500);
    expect(created[0]?.reversedInvoiceId).toBe('inv-deposito');
  });

  it('reparto LIFO: consume primero la factura más nueva (saldo), después la más vieja (seña)', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        makeInvoice({ id: 'inv-sena', impTotal: 300, issuedAt: daysFromNow(-10) }),
        makeInvoice({ id: 'inv-saldo', impTotal: 500, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(3);
    // 1000 a devolver: consume inv-saldo (500, más nueva) primero.
    expect(created[0]?.reversedInvoiceId).toBe('inv-saldo');
    expect(created[0]?.amount).toBe(500);
    // Después inv-sena (300, la única que queda).
    expect(created[1]?.reversedInvoiceId).toBe('inv-sena');
    expect(created[1]?.amount).toBe(300);
    // Remanente (1000 - 500 - 300 = 200) sin factura que cubrir -- ledger-only.
    expect(created[2]?.reversedInvoiceId).toBeNull();
    expect(created[2]?.amount).toBe(200);
  });

  it('F-A (05/09/2026) -- ignora Notas de Crédito ya emitidas en el reparto, aunque estén ISSUED y sean las más nuevas', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        makeInvoice({ id: 'inv-original', cbteTipo: 6, impTotal: 500, issuedAt: daysFromNow(-10) }),
        // NC de un reembolso anterior -- misma tabla, ISSUED, y más nueva
        // que la factura original. Con el bug viejo, el LIFO la habría
        // elegido primero.
        makeInvoice({ id: 'nc-anterior', cbteTipo: 8, impTotal: 300, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBe('inv-original');
  });

  it('bloque 3.1 (08/09/2026) -- rechaza con ReservationOnConsolidatedInvoiceError si la única factura ISSUED es consolidada (financialTransactionId null)', async () => {
    const { service, financialRepo } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        makeInvoice({ id: 'inv-consolidada', financialTransactionId: null, impTotal: 1000, issuedAt: daysFromNow(-1) }),
      ],
    });
    await expect(service.confirmRefund('res-1', 'biz-1', 'user-1'))
      .rejects.toMatchObject({ code: 'RESERVATION_ON_CONSOLIDATED_INVOICE' });
    // Cero filas creadas -- el guard corta ANTES del loop de locks/reparto.
    expect(financialRepo.created).toHaveLength(0);
  });

  it('bloque 3.1 -- rechaza TODO el reembolso aunque también haya una factura DIRECTA reembolsable (todo-o-nada, no reparte solo contra la directa)', async () => {
    const { service, financialRepo, invoiceRepo } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        makeInvoice({ id: 'inv-directa', financialTransactionId: 'ft-directa', impTotal: 400, issuedAt: daysFromNow(-10) }),
        makeInvoice({ id: 'inv-consolidada', financialTransactionId: null, impTotal: 600, issuedAt: daysFromNow(-1) }),
      ],
    });
    await expect(service.confirmRefund('res-1', 'biz-1', 'user-1'))
      .rejects.toMatchObject({ code: 'RESERVATION_ON_CONSOLIDATED_INVOICE' });
    expect(financialRepo.created).toHaveLength(0);
    // Ningún lock tomado -- el guard corre ANTES del loop canónico.
    expect(invoiceRepo.lockedInvoiceIds).toHaveLength(0);
  });

  it('bloque 3.1 -- regresión negativa: con SOLO facturas directas, el guard no dispara y el reparto sigue funcionando', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        makeInvoice({ id: 'inv-directa', financialTransactionId: 'ft-directa', impTotal: 1000, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBe('inv-directa');
  });

  it('ignora facturas no ISSUED (PENDING/REJECTED) en el reparto', async () => {
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        makeInvoice({ id: 'inv-pending', status: 'PENDING', impTotal: 500, issuedAt: null }),
        makeInvoice({ id: 'inv-issued', status: 'ISSUED', impTotal: 500, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBe('inv-issued');
  });

  it('BRECHA-REFUND-01 Fase 3 -- pide el advisory lock como primera operación de la transacción', async () => {
    const { service, transactionManager } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [],
    });
    await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(transactionManager.rawQueries[0]?.sql).toContain('pg_advisory_xact_lock');
  });

  it('BRECHA-REFUND-01 Fase 3 -- lockea las facturas candidatas en orden CANÓNICO (por id), no en el orden LIFO de negocio', async () => {
    const { service, invoiceRepo } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        // LIFO por issuedAt elegiría inv-b (más nueva) antes que inv-a --
        // el orden canónico (por id) es el opuesto.
        makeInvoice({ id: 'inv-a', impTotal: 300, issuedAt: daysFromNow(-10) }),
        makeInvoice({ id: 'inv-b', impTotal: 500, issuedAt: daysFromNow(-1) }),
      ],
    });
    await service.confirmRefund('res-1', 'biz-1', 'user-1');
    // Los primeros 2 locks (fase de pre-lock canónico) van en orden por id,
    // ANTES de que arranque el reparto LIFO (que relockea, ya sostenido,
    // en su propio orden -- inv-b primero).
    expect(invoiceRepo.lockedInvoiceIds.slice(0, 2)).toEqual(['inv-a', 'inv-b']);
  });

  it('BRECHA-REFUND-01 Fase 3 -- reintento sobre la MISMA reserva (misma clave de idempotencia) devuelve las filas ya creadas, no duplica', async () => {
    const { service, financialRepo } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [makeInvoice({ id: 'inv-1', impTotal: 500, issuedAt: daysFromNow(-1) })],
    });

    const first = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    const second = await service.confirmRefund('res-1', 'biz-1', 'user-1');

    expect(first.map((tx) => tx.id)).toEqual(second.map((tx) => tx.id));
    // Un solo INSERT real por chunk -- el reintento devolvió lo existente
    // vía getByIdempotencyKey, no volvió a crear.
    expect(financialRepo.created).toHaveLength(first.length);
  });

  it('BRECHA-REFUND-01 Fase 3 -- reintento EN SERIE después de un reembolso 100% ya comprometido no revienta con NothingToRefundError', async () => {
    // La fake genérica de arriba usa un `collected` fijo -- no reproduce el
    // caso real: `getCollectedPaymentTotalForReservation()` recalcula desde
    // el ledger, y ya sale neto del REFUND que el primer llamado dejó
    // asentado. Esta fake recalcula de verdad (paid - Σ REFUND commiteado)
    // para ejercitar el mismo camino que el test de integración contra
    // Postgres.
    //
    // Modela el CORTE DE COMMIT: el método real lee por el POOL, no por el
    // `client` transaccional, así que NO ve los REFUND que una transacción
    // en vuelo todavía no commiteó. La fake genérica los ve en `this.created`
    // apenas se insertan -- sin este corte, el guard de BRECHA-REFUND-01-B
    // (relectura de `collected` antes del COMMIT) dispararía contra la
    // inserción de su propia transacción. `commit()` lo llama el test para
    // marcar que una transacción anterior ya cerró.
    class DynamicCollectedFinancialTransactionRepository extends FakeFinancialTransactionRepository {
      private committedRefunded = 0;
      constructor(private readonly paid: number) { super(0); }
      commit(): void {
        this.committedRefunded = this.created
          .filter((tx) => tx.type === 'REFUND')
          .reduce((sum, tx) => sum + tx.amount, 0);
      }
      override async getCollectedPaymentTotalForReservation(): Promise<number> {
        return this.paid - this.committedRefunded;
      }
    }
    const financialRepo = new DynamicCollectedFinancialTransactionRepository(1000);
    const service = new CancellationRefundService(
      new FakeReservationRepository(makeReservation()),
      new FakePolicyRepository({ id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' }),
      financialRepo,
      new FakeInvoiceRepository([]),
      new FakeBusinessProfileRepository(),
      new InMemoryTransactionManager(),
    );

    const first = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    // La primera transacción cerró -- recién ahora el "pool" ve su REFUND.
    financialRepo.commit();
    // Sin el pre-chequeo de reintento, este segundo llamado vería
    // collected = 1000 - 1000 = 0 y lanzaría NothingToRefundError en vez de
    // devolver lo ya creado -- exactamente lo que rompía la promesa de
    // idempotencia del docblock de confirmRefund().
    const second = await service.confirmRefund('res-1', 'biz-1', 'user-1');

    expect(second.map((tx) => tx.id)).toEqual(first.map((tx) => tx.id));
    expect(financialRepo.created).toHaveLength(first.length);
  });

  it('architecture-governor (05/09/2026) -- el re-chequeo BAJO el lock corta antes de tocar ninguna factura, aunque el camino rápido (fuera del lock) no haya visto nada todavía', async () => {
    // Simula el lado perdedor de una carrera genuina: el chequeo de fuera
    // del lock (primera llamada a getByReservationId) no ve nada todavía
    // -- como si el ganador no hubiese hecho commit aún --, pero para
    // cuando este llamado adquiere el lock, el ganador ya comprometió. El
    // fake devuelve vacío la primera vez y la fila ya creada de ahí en
    // adelante, sin depender de un contador de invocaciones fijo (el
    // pre-chequeo rápido y el re-chequeo bajo el lock son dos llamadas
    // reales a getByReservationId()).
    let callCount = 0;
    const winnerRow: FinancialTransaction = {
      id: 'refund-del-ganador', businessId: 'biz-1', customerId: 'cust-1', reservationId: 'res-1',
      type: 'REFUND', amount: 500, currency: 'ARS', status: 'SETTLED',
      idempotencyKey: 'refund:cancellation:res-1:sin-asignar', reversedInvoiceId: null,
      createdAt: new Date(),
    };
    class RaceLoserFinancialTransactionRepository extends FakeFinancialTransactionRepository {
      override async getByReservationId(): Promise<FinancialTransaction[]> {
        callCount += 1;
        return callCount === 1 ? [] : [winnerRow];
      }
    }
    const financialRepo = new RaceLoserFinancialTransactionRepository(1000);
    const invoiceRepo = new FakeInvoiceRepository([]);
    const service = new CancellationRefundService(
      new FakeReservationRepository(makeReservation()),
      new FakePolicyRepository({ id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 50, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' }),
      financialRepo,
      invoiceRepo,
      new FakeBusinessProfileRepository(),
      new InMemoryTransactionManager(),
    );

    const result = await service.confirmRefund('res-1', 'biz-1', 'user-1');

    expect(result).toEqual([winnerRow]);
    // Ni una factura lockeada, ni un INSERT real -- el re-chequeo bajo el
    // lock cortó ANTES de la fase de pre-lockeo canónico y del reparto.
    expect(invoiceRepo.lockedInvoiceIds).toHaveLength(0);
    expect(financialRepo.created).toHaveLength(0);
  });

  it('CERCA #21 (pendientes-2026-09-08.md) -- nunca emite dos chunks REFUND con el mismo reversedInvoiceId en la misma llamada', async () => {
    // Invariante hoy trivial por construcción: el for de reparto itera una
    // vez por factura de `issuedInvoices` (`getByReservationId()`, que solo
    // ve facturas 1:1 con ESTA reserva) y empuja a lo sumo un chunk por
    // vuelta. Se cerca EXPLÍCITAMENTE acá porque el bloque 3.1 del plan
    // (`docs/plan-cierre-cancelacion-nc-y-deuda-estructural-2026-09-08.md`)
    // va a mover `getByReservationId()` a un UNION que también trae
    // facturas consolidadas -- compartibles entre reservas -- y es el punto
    // donde el tope N5 (#21) se vuelve alcanzable. Si este test empieza a
    // fallar al tocar 3.1, es la señal de que el chequeo per-llamada ya no
    // alcanza y hace falta el tope real (bloque 2.4, bajo gate propio).
    const { service } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [
        makeInvoice({ id: 'inv-a', impTotal: 200, issuedAt: daysFromNow(-10) }),
        makeInvoice({ id: 'inv-b', impTotal: 300, issuedAt: daysFromNow(-5) }),
        makeInvoice({ id: 'inv-c', impTotal: 500, issuedAt: daysFromNow(-1) }),
      ],
    });
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    const invoiceIds = created.map((tx) => tx.reversedInvoiceId).filter((id): id is string => id !== null);
    expect(invoiceIds).toHaveLength(new Set(invoiceIds).size);
    expect(invoiceIds).toEqual(['inv-c', 'inv-b', 'inv-a']);
  });

  it('BRECHA-REFUND-01 Fase 3 -- capa contra getRefundableForUpdate(), no contra impTotal a secas (Q-A: nunca más de lo cobrado)', async () => {
    const { service, invoiceRepo } = buildService({
      collected: 1000,
      tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
      invoices: [makeInvoice({ id: 'inv-1', impTotal: 1000, issuedAt: daysFromNow(-1) })],
    });
    // Simula que ya se reembolsaron 700 de esta factura por otro camino --
    // solo quedan 300 reembolsables, aunque impTotal siga siendo 1000.
    invoiceRepo.refundableOverride.set('inv-1', 300);

    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');

    expect(created).toHaveLength(2);
    expect(created[0]?.reversedInvoiceId).toBe('inv-1');
    expect(created[0]?.amount).toBe(300);
    // El resto (1000 - 300 = 700) sin factura que lo cubra -- ledger-only.
    expect(created[1]?.reversedInvoiceId).toBeNull();
    expect(created[1]?.amount).toBe(700);
  });
});

describe('CancellationRefundService.confirmRefund -- BRECHA-REFUND-01-B (guard optimista)', () => {
  // `getCollectedPaymentTotalForReservation()` se llama dos veces dentro de
  // `confirmRefund()`: una para calcular `refundAmount` y otra en el guard,
  // justo antes del COMMIT. Esta fake devuelve un valor distinto por
  // llamada para simular un PAYMENT/REFUND concurrente que commiteó en el
  // medio, por un camino que el `FOR UPDATE` sobre `invoices` no cubre.
  class ShiftingCollectedRepository extends FakeFinancialTransactionRepository {
    private calls = 0;
    constructor(private readonly values: number[]) { super(0); }
    override async getCollectedPaymentTotalForReservation(): Promise<number> {
      const v = this.values[Math.min(this.calls, this.values.length - 1)]!;
      this.calls += 1;
      return v;
    }
  }

  function buildWithShiftingCollected(values: number[]) {
    const financialRepo = new ShiftingCollectedRepository(values);
    const service = new CancellationRefundService(
      new FakeReservationRepository(makeReservation()),
      new FakePolicyRepository({ id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' }),
      financialRepo,
      new FakeInvoiceRepository([]),
      new FakeBusinessProfileRepository(),
      new InMemoryTransactionManager(),
    );
    return { service, financialRepo };
  }

  it('aborta con RefundBaseChangedError si `collected` SUBIÓ entre el cálculo y el INSERT (PAYMENT concurrente)', async () => {
    const { service } = buildWithShiftingCollected([1000, 1300]);
    await expect(service.confirmRefund('res-1', 'biz-1', 'user-1'))
      .rejects.toMatchObject({ code: 'REFUND_BASE_CHANGED' });
  });

  it('aborta también si `collected` BAJÓ entre el cálculo y el INSERT (REFUND concurrente de otro flujo) -- `!==`, no `>`', async () => {
    const { service } = buildWithShiftingCollected([1000, 700]);
    await expect(service.confirmRefund('res-1', 'biz-1', 'user-1'))
      .rejects.toThrow(RefundBaseChangedError);
  });

  it('no dispara el guard cuando `collected` no cambió -- el camino feliz sigue creando el reembolso', async () => {
    const { service, financialRepo } = buildWithShiftingCollected([1000, 1000]);
    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
    expect(created).toHaveLength(1);
    expect(created[0]?.amount).toBe(1000);
    expect(financialRepo.created).toHaveLength(1);
  });
});

describe('CancellationRefundService.confirmRefund -- REFUND-ISSUED-RACE-01 Block B (10/09/2026, guard hermano de BRECHA-REFUND-01-B)', () => {
  // `InvoiceRepository.getByReservationId()` se llama dos veces dentro de
  // `confirmRefund()`: una para leer `issuedInvoices` (`:189`, foto inicial)
  // y otra en el re-chequeo, justo antes del COMMIT (`:367`). Esta fake
  // devuelve un set MAYOR en la segunda llamada -- simula una factura que
  // pasó de PENDING a ISSUED (`markIssued()`, por el pool, sin tx) en la
  // ventana entre las dos lecturas. Mismo patrón que `ShiftingCollectedRepository`
  // de arriba (BRECHA-REFUND-01-B), aplicado al invoice repo en vez del
  // financial repo -- este archivo no corre contra Postgres real (eso lo
  // hace `src/tests/integration/refund-issued-race.integration.test.ts`,
  // que necesita `TEST_DATABASE_URL` a mano y no forma parte de CI); este
  // unitario es la única cobertura del guard nuevo que SÍ corre en CI.
  class ShiftingIssuedInvoicesRepository extends FakeInvoiceRepository {
    private calls = 0;
    constructor(private readonly snapshots: Invoice[][]) { super(snapshots[0] ?? []); }
    override async getByReservationId(): Promise<Invoice[]> {
      const snapshot = this.snapshots[Math.min(this.calls, this.snapshots.length - 1)]!;
      this.calls += 1;
      return snapshot;
    }
  }

  function buildWithShiftingIssuedInvoices(snapshots: Invoice[][]) {
    const financialRepo = new FakeFinancialTransactionRepository(1000);
    const invoiceRepo = new ShiftingIssuedInvoicesRepository(snapshots);
    const service = new CancellationRefundService(
      new FakeReservationRepository(makeReservation()),
      new FakePolicyRepository({ id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 100, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' }),
      financialRepo,
      invoiceRepo,
      new FakeBusinessProfileRepository(),
      new InMemoryTransactionManager(),
    );
    return { service, financialRepo, invoiceRepo };
  }

  it('M2 -- aborta con RefundInvoiceSetChangedError si aparece una factura ISSUED nueva entre la foto inicial y el re-chequeo', async () => {
    const nuevaIssued = makeInvoice({ id: 'inv-nueva', impTotal: 1000, issuedAt: daysFromNow(-1) });
    const { service } = buildWithShiftingIssuedInvoices([[], [nuevaIssued]]);

    await expect(service.confirmRefund('res-1', 'biz-1', 'user-1'))
      .rejects.toMatchObject({ code: 'REFUND_INVOICE_SET_CHANGED' });
  });

  it('no dispara el guard cuando el set de ISSUED no cambió -- el camino feliz sigue creando el reembolso (mata el mutante que degrada a "size > 0")', async () => {
    const yaVista = makeInvoice({ id: 'inv-a', impTotal: 1000, issuedAt: daysFromNow(-1) });
    const { service, financialRepo } = buildWithShiftingIssuedInvoices([[yaVista], [yaVista]]);

    const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');

    expect(created).toHaveLength(1);
    expect(created[0]?.reversedInvoiceId).toBe('inv-a');
    expect(financialRepo.created).toHaveLength(1);
  });
});

describe('CancellationRefundService -- CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (snapshot congelado)', () => {
  // Ladder congelado de ejemplo: 100% a >=7 días, 0% a <7. El `tier` LIVE
  // de cada test de abajo es deliberadamente DISTINTO al que el snapshot
  // daría -- si `resolveRefundPercentage()` tocara la tabla en vivo por
  // error (bug de regresión: alguien vuelve a poner `findApplicableTier()`
  // incondicional), el resultado observado cambiaría y el test lo detecta,
  // no solo por número sino porque `policyRepo.calls` también se verifica.
  const SNAPSHOT_LADDER = {
    version: 1 as const,
    frozenAt: '2026-01-01T00:00:00.000Z',
    tiers: [
      { minDaysBeforeCheckin: 7, refundPercentage: 100 },
      { minDaysBeforeCheckin: 0, refundPercentage: 0 },
    ],
  };
  // Tier LIVE "trampa": si el service ignorara el snapshot y cayera igual a
  // la tabla en vivo, daría 10% en vez del 100%/0% que dicta el ladder
  // congelado -- cualquiera de los dos valores lo delataría.
  const LIVE_TRAP_TIER: CancellationPolicy = {
    id: 'p-live-trap', businessId: 'biz-1', minDaysBeforeCheckin: 0,
    refundPercentage: 10, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION',
  };

  describe('previewRefund', () => {
    it('resuelve el % contra el ladder congelado, no contra la tabla en vivo (checkinInDays=10 -> tramo 100%)', async () => {
      const { service, policyRepo } = buildService({
        reservation: makeReservation({ checkinInDays: 10, cancellationPolicySnapshot: SNAPSHOT_LADDER }),
        tier: LIVE_TRAP_TIER,
        collected: 1000,
      });
      const preview = await service.previewRefund('res-1', 'biz-1');
      expect(preview.refundPercentage).toBe(100);
      expect(preview.refundAmount).toBe(1000);
      // La tabla en vivo nunca se consultó -- prueba que la rama realmente
      // bifurca, no que el resultado coincidiera por casualidad.
      expect(policyRepo.calls).toBe(0);
    });

    it('resuelve el tramo de menor anticipación cuando falta poco para el check-in (checkinInDays=2 -> tramo 0%)', async () => {
      const { service, policyRepo } = buildService({
        reservation: makeReservation({ checkinInDays: 2, cancellationPolicySnapshot: SNAPSHOT_LADDER }),
        tier: LIVE_TRAP_TIER,
        collected: 1000,
      });
      const preview = await service.previewRefund('res-1', 'biz-1');
      expect(preview.refundPercentage).toBe(0);
      expect(preview.refundAmount).toBe(0);
      expect(policyRepo.calls).toBe(0);
    });

    it('sin snapshot (null, reserva vieja o política LIVE al confirmar) sigue resolviendo contra la tabla en vivo -- comportamiento sin cambios', async () => {
      const { service, policyRepo } = buildService({
        reservation: makeReservation({ checkinInDays: 10, cancellationPolicySnapshot: null }),
        tier: { id: 'p-1', businessId: 'biz-1', minDaysBeforeCheckin: 7, refundPercentage: 40, active: true, policyResolutionTiming: 'LIVE_AT_CANCELLATION' },
        collected: 1000,
      });
      const preview = await service.previewRefund('res-1', 'biz-1');
      expect(preview.refundPercentage).toBe(40);
      expect(policyRepo.calls).toBe(1);
    });
  });

  describe('confirmRefund', () => {
    it('crea el REFUND con el monto que dicta el ladder congelado, ignorando la tabla en vivo', async () => {
      const { service, financialRepo, policyRepo } = buildService({
        reservation: makeReservation({ checkinInDays: 10, cancellationPolicySnapshot: SNAPSHOT_LADDER }),
        tier: LIVE_TRAP_TIER,
        collected: 1000,
        invoices: [],
      });
      const created = await service.confirmRefund('res-1', 'biz-1', 'user-1');
      expect(created).toHaveLength(1);
      expect(created[0]?.amount).toBe(1000);
      expect(policyRepo.calls).toBe(0);
      expect(financialRepo.created).toHaveLength(1);
    });

    it('NothingToRefundError cuando el tramo congelado da 0% (mismo guard que el camino LIVE)', async () => {
      const { service } = buildService({
        reservation: makeReservation({ checkinInDays: 2, cancellationPolicySnapshot: SNAPSHOT_LADDER }),
        tier: LIVE_TRAP_TIER,
        collected: 1000,
        invoices: [],
      });
      await expect(service.confirmRefund('res-1', 'biz-1', 'user-1')).rejects.toThrow(NothingToRefundError);
    });

    it('ningún tramo del ladder aplica (anticipación negativa, sin tramo min=0 en el snapshot) -> 0%, NothingToRefundError', async () => {
      const ladderSinTramoCero = {
        version: 1 as const,
        frozenAt: '2026-01-01T00:00:00.000Z',
        tiers: [{ minDaysBeforeCheckin: 7, refundPercentage: 100 }],
      };
      const { service } = buildService({
        reservation: makeReservation({ checkinInDays: -1, cancellationPolicySnapshot: ladderSinTramoCero }),
        collected: 1000,
        invoices: [],
      });
      await expect(service.confirmRefund('res-1', 'biz-1', 'user-1')).rejects.toThrow(NothingToRefundError);
    });
  });
});
