/**
 * @file reservation.service.ts
 * @description Orquestador del ciclo de vida de una reserva (crear,
 * editar, confirmar, cancelar, completar). Compone tres servicios más
 * chicos, cada uno con una única razón de cambio (Fase 6,
 * docs/auditoria-modularidad.md, hallazgo B1 — antes las 4 responsabilidades
 * vivían mezcladas en esta misma clase de ~1000 líneas):
 *
 * - `ReservationPricingService` (reservation-pricing.service.ts) — cascada
 *   de precio y desglose en líneas.
 * - `ReservationAvailabilityService` (reservation-availability.service.ts)
 *   — conflictos, resource_locks, ventanas de mantenimiento, registro de ocupación.
 * - `ReservationScheduleService` (reservation-schedule.service.ts) —
 *   grilla de turnos disponibles de un servicio `slot`, a partir del
 *   horario de atención (usa `ReservationAvailabilityService.
 *   checkAvailability()` para filtrarla, no reimplementa el chequeo).
 *
 * El constructor y la firma pública de cada método (`createReservation`,
 * `updateReservation`, `confirmReservation`, `cancelReservation`,
 * `completeReservation`, `checkAvailability`, `getReservation`,
 * `findAvailableResourceInCategory`, `getAvailableSlots`) quedaron
 * IDÉNTICOS a como estaban — ningún caller (rutas, tests) necesitó
 * cambiar una sola línea por este reordenamiento. Internamente, este
 * orquestador instancia los tres servicios con las mismas dependencias
 * que ya recibía, y delega en vez de tener la lógica inline.
 *
 * ## Historial de cambios previos (antes de la Fase 6)
 * - `withTransaction` se recibe como `TransactionManager` inyectado.
 * - `occupancyRepository`, `categoryRepository` y `domainEventRepository`
 *   son dependencias obligatorias.
 * - `businessId` se recibe como parámetro explícito en los métodos que
 *   emiten eventos de dominio (confirmReservation, cancelReservation,
 *   completeReservation) — el servicio NO lee process.env.BUSINESS_ID.
 * - `createReservation`/`updateReservation` corren dentro de
 *   `transactionManager.run()`, con `getActiveForResourceInRangeWithLock()`
 *   (SELECT ... FOR UPDATE) para serializar el chequeo de disponibilidad +
 *   INSERT/UPSERT (fallback sin lock si el repositorio no lo implementa,
 *   como los mocks en tests).
 * - Resource locks (`IResourceLockRepository`): `createReservation` y
 *   `updateReservation` verifican disponibilidad de TODOS los recursos que
 *   el servicio asociado bloquea, no solo el `resourceId` principal.
 * - Reserva por duración: `endTime` es opcional si viene `serviceId` con
 *   `duration_minutes` configurado.
 * - Cuentas corrientes / tarifas especiales: `createReservation` resuelve
 *   `totalPrice` ANTES de construir la reserva (`reservations.total_price`
 *   es NOT NULL sin default). `confirmReservation` manda `totalPrice` en
 *   el payload de `reservation.confirmed` para que el worker de outbox
 *   pueda crear el CHARGE correspondiente.
 * - `checkAvailability`/disponibilidad consultan `maintenanceWindowRepository`
 *   (24/08/2026, reemplaza a `housekeepingRepository.isOutOfService()`) —
 *   un recurso con una ventana de mantenimiento vigente no se puede
 *   reservar, ver `docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md`.
 */

import { Reservation }                  from './Reservation.js';
import type { ReservationCustomer } from './reservation-customer.entities.js';
import type { PhysicalResource } from './resource.entities.js';
import {
  DomainError,
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
  NoPriceAdjustmentPendingError,
  DepositNotPaidError,
  LodgingRequiresServiceError,
  ReservationChargeInvoicedError,
  ReservationConcurrentlyModifiedError,
  AssignmentCategoryMismatchError,
  AssignmentCombinedChangeError,
  ReservationAlreadyAssignedError,
  ResourceOccupiedError,
} from '../domain/errors.js';
import { recordFieldChangesWithClient } from '../domain/audit.js';
import type { InvoiceRepository, InvoiceLinkage } from '../facturacion/invoice.repository.js';
import { BookableServiceNotFoundError } from './bookable-service.service.js';
import type { ReservationLine, AutoAssignAllResult, AutoAssignAllItemResult } from './reservation.types.js';
import { validateDetailsAgainstFields } from './category.service.js';
import type { ReservationRepository }        from './reservation.repository.js';
import { RESERVATIONS_MAX_LIMIT }            from './reservation.repository.js';
import type { ResourceRepository }           from './resource.repository.js';
import type { OccupancyRepository }          from './occupancy.repository.js';
import type { ICategoryRepository }          from './category.repository.js';
import type { DomainEventRepository }        from '../repositories/domain-event.repository.js';
import type { AuditLogRepository }           from '../repositories/audit-log.repository.js';
import { auditReservationTransition }        from './reservation-audit.js';
import type { IResourceLockRepository }      from './resource-lock.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type { BookableService } from './bookable-service.types.js';
import type { ResourceCategory } from './resource-category.types.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { ICustomerRateRepository } from '../clientes-finanzas/customer-rate.repository.js';
import type { IOperatingHoursRepository } from '../platform/operating-hours.repository.js';
import type { MaintenanceWindowRepository } from '../pms-estadias/maintenance-window.repository.js';
/**
 * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §8 A6.1
 * paso 7) — `assignDeferred()` necesita filtrar contra `Stay`s activas del
 * recurso candidato. Import de TIPO desde `stay.repository.ts` (no de
 * `stay.service.ts`, que sí importa de este archivo -- ver
 * `ResourceOccupiedError` en `domain/errors.ts` para el riesgo de ciclo que
 * esto evita). Mismo precedente que `MaintenanceWindowRepository` arriba:
 * `stay.repository.ts` no importa nada de `reservas`.
 */
import type { StayRepository } from '../pms-estadias/stay.repository.js';
import type { IDepositPolicyRepository } from './deposit-policy.repository.js';
import type { CancellationPolicyRepository } from './cancellation-policy.repository.js';
import { buildCancellationPolicySnapshot } from './cancellation-policy.repository.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { FinancialTransactionRepository } from '../clientes-finanzas/financial-transaction.repository.js';
import type { NumberSequenceRepository } from '../repositories/number-sequence.repository.js';
import type { TransactionManager }           from '../db/transaction-manager.js';
import type { SqlClient }                    from '../repositories/sql.client.js';
import { ReservationPricingService }      from './reservation-pricing.service.js';
import { ReservationAvailabilityService } from './reservation-availability.service.js';
import { ReservationScheduleService }     from './reservation-schedule.service.js';
import { resolveEndTime, qualifiesForDateComparison, isPastStart, deriveCalendarDate, todayInBusinessTimezone } from './reservation-time.utils.js';
import { logger } from '../logger.js';

// Re-exportado para que `pms-estadias/stay.service.ts` (único consumidor
// externo) siga importando `combineDateAndTime` desde acá sin cambios —
// la implementación real vive en reservation-time.utils.ts junto con
// `resolveEndTime`, la otra función pura que comparten los servicios de
// este módulo.
export { combineDateAndTime } from './reservation-time.utils.js';

/**
 * J1 (23/08/2026, pendientes-2026-08-23.md) — margen para no rechazar un
 * walk-in "reservar ahora mismo" por la latencia normal entre que el
 * frontend arma el timestamp y la request llega al server. Valor
 * confirmado con el dueño (AskUserQuestion).
 */
const PAST_START_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §8
 * "`updateReservation()` en relación con `assignDeferred()`", B-3 Ronda
 * 15) — comparación estructural de `details` (JSONB, Postgres puede
 * reordenar las claves al persistir) para el discriminador de
 * `updateReservation()`. NO usa `JSON.stringify()` liso (falso positivo
 * si el orden de claves difiere) ni `diffFields()` (`domain/audit.ts`,
 * misma fragilidad — corregirla ahí queda fuera de alcance de 4.3).
 * Serializa cada valor con las claves de cada objeto ORDENADAS
 * alfabéticamente en cualquier nivel de anidamiento, insensible al orden
 * en que Postgres las haya persistido. No existe ningún `deepEqual`
 * compartido en este repo (verificado) — local a este punto.
 */
/**
 * Fase 3, "Auto Assign All" (docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md
 * §3.4) — clasifica el error de UNA reserva del batch en el `outcome` que
 * corresponde, sin relanzar (el `for` de `autoAssignAllForCategory()`
 * sigue con la siguiente reserva, §4.2). `ReservationAlreadyAssignedError`
 * es una carrera BENIGNA con otra operación (otro `PUT`/check-in/completar,
 * u otra corrida concurrente del propio batch, §4.4) — no es realmente un
 * "fallo" del batch, así que se reporta aparte de `FAILED`. Cualquier otro
 * `DomainError` expone su `code`/`message` reales (mismo criterio que el
 * resto del repo, A7.1: nunca datos de cliente). Un error NO tipado se
 * loguea con el detalle completo y se expone al frontend solo como
 * `INTERNAL_ERROR`, sin filtrar nada interno.
 */
function classifyFailure(
  reservationId: string,
  previousResourceId: string,
  err: unknown,
): AutoAssignAllItemResult {
  if (err instanceof ReservationAlreadyAssignedError) {
    return {
      reservationId,
      previousResourceId,
      outcome: 'SKIPPED_ALREADY_ASSIGNED',
      code: err.code,
      message: err.message,
    };
  }
  if (err instanceof DomainError) {
    return {
      reservationId,
      previousResourceId,
      outcome: 'FAILED',
      code: err.code,
      message: err.message,
    };
  }
  logger.error(
    { reservationId, err },
    'auto-assign-all: error no tipado al procesar una reserva del batch',
  );
  return {
    reservationId,
    previousResourceId,
    outcome: 'FAILED',
    code: 'INTERNAL_ERROR',
    message: 'Error interno al procesar esta reserva -- ver logs del servidor.',
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(record[k])}`).join(',')}}`;
}

export class ReservationService {
  private readonly pricing:      ReservationPricingService;
  private readonly availability: ReservationAvailabilityService;
  private readonly schedule:     ReservationScheduleService;

  constructor(
    private readonly reservationRepository:   ReservationRepository,
    private readonly resourceRepository:      ResourceRepository,
    occupancyRepository:     OccupancyRepository,
    private readonly categoryRepository:      ICategoryRepository,
    private readonly domainEventRepository:   DomainEventRepository,
    private readonly transactionManager:      TransactionManager,
    resourceLockRepository:  IResourceLockRepository,
    private readonly bookableServiceRepository: IBookableServiceRepository,
    customerRateRepository:  ICustomerRateRepository,
    operatingHoursRepository: IOperatingHoursRepository,
    /** 24/08/2026 — reemplaza a HousekeepingRepository (isOutOfService), ver docblock del archivo. */
    maintenanceWindowRepository: MaintenanceWindowRepository,
    /** C1-Fase A — resuelve el % de seña (deposit_policies), reenviado a ReservationPricingService. */
    depositPolicyRepository: IDepositPolicyRepository,
    /** C1-Fase A — `default_deposit_percentage`/`deposit_hold_hours` (política general del negocio, A2.9). */
    private readonly businessProfileRepository: Pick<BusinessProfileRepository, 'get'>,
    /**
     * C1-Fase A — gate de `confirmReservation()` (`getSettledPaymentTotalForReservation`).
     * RESERVA-10 (05/09/2026) — también `getByReservationId()`, para
     * `findBlockingInvoiceLinkage()` en `cancelReservation()`. Solo
     * lectura, no crea movimientos financieros (eso sigue siendo trabajo
     * exclusivo del outbox worker, A10).
     */
    private readonly financialTransactionRepository: Pick<FinancialTransactionRepository, 'getSettledPaymentTotalForReservation' | 'getByReservationId'>,
    /**
     * RESERVA-10 (05/09/2026, architecture-governor) — mismo criterio que
     * `OrderService` del lado pos-menu: depende de la INTERFAZ
     * `InvoiceRepository` de `facturacion`, nunca del repositorio concreto
     * ni de `InvoiceService` (bounded contexts, `app-main/CLAUDE.md`).
     * `resolveInvoiceLinkage()` ya distingue `NONE`/`NOT_ISSUED`/`ISSUED`
     * y cubre facturas individuales y consolidadas.
     */
    private readonly invoiceRepo: Pick<InvoiceRepository, 'resolveInvoiceLinkage'>,
    /** D6 (22/08/2026) — número operativo, resuelto una sola vez en createReservation(). */
    private readonly numberSequenceRepository: NumberSequenceRepository,
    /**
     * CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) -- solo
     * `findAll()`: `confirmReservation()` congela (R9) el ladder ACTIVO
     * completo de tramos del negocio, no un tramo puntual (ver
     * `buildCancellationPolicySnapshot()`, cancellation-policy.repository.ts).
     * `CancellationRefundService` es quien sigue usando `findApplicableTier()`
     * para el camino LIVE_AT_CANCELLATION -- no se toca acá.
     */
    private readonly cancellationPolicyRepository: Pick<CancellationPolicyRepository, 'findAll'>,
    /**
     * D-10 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md #8) --
     * A6.5: `confirmReservation()`/`cancelReservation()`/`completeReservation()`
     * dejaban de rastro NADA en `audit_log` (a diferencia del escape con
     * Nota de Crédito, `ReservationCancelForCreditNote`, que sí auditaba).
     * SIN default a propósito -- F2-12 (misma auditoría) señaló que un
     * parámetro nuevo con default no rompe `tsc --noEmit` si alguno de los
     * 3 composition roots (`reservations.routes.ts`,
     * `bookable-services.routes.ts`, `customer.routes.ts`) se olvida de
     * actualizarse; requerido, el compilador los obliga a los tres.
     * `Pick<..., 'recordWithClient'>` -- mismo recorte que ya usa
     * `ReservationCancelForCreditNote`, que comparte el helper
     * `auditReservationTransition()` con este servicio (`reservation-audit.ts`).
     */
    private readonly auditLogRepo: Pick<AuditLogRepository, 'recordWithClient'>,
    /**
     * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §8
     * A6.1 paso 7) — `assignDeferred()` filtra el recurso candidato contra
     * `Stay`s activas (el chequeo de disponibilidad de `reservations` no ve
     * `stays`). `Pick<..., 'findActiveByResource'>` — mismo recorte que ya
     * usa `auditLogRepo` arriba, no la interfaz completa. 20º parámetro,
     * obligatorio y sin default, mismo criterio que `auditLogRepo`: sin
     * esta dependencia, `assignDeferred()` no puede protegerse contra un
     * upgrade que le quite la habitación a un huésped ya en check-in.
     */
    private readonly stayRepository: Pick<StayRepository, 'findActiveByResource'>,
    /**
     * J1 (23/08/2026) — reloj inyectable para el guard de "no crear/mover
     * una reserva al pasado". Opcional con default real: los ~101
     * call-sites de producción no necesitan tocarse. Los tests que
     * construyen fixtures con fechas fijas (`reservation.service.test.ts`)
     * inyectan un reloj congelado anterior a esas fechas.
     */
    private readonly now: () => Date = () => new Date(),
  ) {
    this.pricing = new ReservationPricingService(
      customerRateRepository,
      this.bookableServiceRepository,
      this.categoryRepository,
      depositPolicyRepository,
    );
    this.availability = new ReservationAvailabilityService(
      this.resourceRepository,
      resourceLockRepository,
      this.reservationRepository,
      maintenanceWindowRepository,
      occupancyRepository,
      this.bookableServiceRepository,
      this.businessProfileRepository,
      this.categoryRepository,
    );
    this.schedule = new ReservationScheduleService(
      this.bookableServiceRepository,
      operatingHoursRepository,
      this.resourceRepository,
      this.availability,
    );
  }

  async createReservation(params: {
    id: string;
    resourceId: string;
    customer: ReservationCustomer;
    startTime: Date;
    endTime?: Date;
    details: Record<string, unknown>;
    serviceId?: string;
    /** Tarifa elegida (spec de mejoras PMS, 18/08/2026) — requiere serviceId; ver ReservationPricingService.resolvePrice(). */
    ratePlanId?: string;
    /** Desglose de huéspedes (hotelería, 18/08/2026) — null/omitido = no aplica a este tipo de reserva. */
    adultos?: number | null;
    ninos?: number | null;
    /** K3 (23/08/2026) — explícito para negocios de recurso 1:1 (barbería/spa). Alojamiento lo deriva de adultos+ninos, ver más abajo. */
    partySize?: number;
    /**
     * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6
     * Fase 2 ítem 1, B2) — señal explícita de que esta alta entró por
     * `categoryId` (sin `resourceId`), reenviada TAL CUAL desde
     * `reservations.routes.ts` (`!body.resourceId && !!body.categoryId`,
     * el mismo booleano que ya decide la rama de
     * `findAvailableResourceInCategory()` ahí — no se recalcula acá).
     * `resourceId` sigue siendo obligatorio en este método (la ruta ya lo
     * resolvió a un recurso concreto, provisorio o no) — esta señal solo
     * decide el `assignmentStatus` inicial, no cambia la resolución del
     * recurso.
     */
    enteredByCategory?: boolean;
  }): Promise<Reservation> {
    const resource = await this.resourceRepository.getById(params.resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(params.resourceId);
    }
    // getById() ya no filtra por active (docs/criterios-datos.md R2) — un
    // recurso pausado no se puede usar en una reserva NUEVA (R11), chequeo
    // explícito acá. assertAllResourcesAvailable() más abajo repite este
    // chequeo para los recursos bloqueados por el servicio, pero ESTE
    // fetch pasa por acá primero para construir el precio/la entidad, así
    // que falla rápido sin esperar a la transacción.
    if (!resource.active) {
      throw new InvalidReservationError(`El recurso ${params.resourceId} está desactivado.`);
    }

    // J1-TZ (27/09/2026, docs/diseno-j1-fecha-alojamiento-huso-negocio-2026-09-27.md)
    // -- category/service/businessProfile se ADELANTAN acá: los 3 ya se
    // buscaban sin condición más abajo (líneas originales de este método),
    // así que esto no duplica ninguna consulta -- solo hace falta conocerlos
    // ANTES de decidir si J1 compara instante crudo o fecha calendario.
    const category = await this.categoryRepository.findById(resource.categoryId);
    // Se busca una sola vez y se reusa para resolveEndTime Y resolvePrice —
    // antes resolveEndTime la buscaba por su cuenta, y hoy además hace falta
    // para cotizar la reserva.
    const service = params.serviceId
      ? await this.bookableServiceRepository.findById(params.serviceId)
      : null;
    const businessProfile = await this.businessProfileRepository.get();

    // J1 (23/08/2026, pendientes-2026-08-23.md) — no puede vivir en el
    // constructor de Reservation: Reservation.restore() comparte el mismo
    // constructor y reconstruye reservas históricas leídas de la base
    // (prácticamente todas, su startTime ya "pasó" con solo el paso del
    // tiempo). El guard va acá, en el caso de uso de ALTA.
    //
    // J1-TZ (27/09/2026) — J1 original comparaba SIEMPRE instante crudo
    // contra `now()` con 5 min de tolerancia. Para alojamiento (o
    // `bookingMode='block'`) con `startTime` como MARCA de fecha calendario
    // (medianoche UTC, convención del comentario E1 de confirmReservation()
    // más abajo en este archivo -- fechas de alojamiento en el email,
    // citado por nombre y no por línea, SCHEMA-ANCHOR-DRIFT-001),
    // esa comparación cruda rechazaba cargar/mover a "hoy" casi todo el día
    // de negocio en husos como Argentina (UTC-3) — ver el diseño para la
    // medición real. `qualifiesForDateComparison()` decide cuál de las 2
    // reglas aplica; `slot` queda SIEMPRE en instante crudo, aunque el
    // recurso sea de alojamiento (manda horario real, no marca).
    if (
      isPastStart(
        params.startTime,
        qualifiesForDateComparison(category?.isLodging ?? false, service?.bookingMode, params.startTime),
        businessProfile.timezone,
        this.now,
        PAST_START_TOLERANCE_MS,
      )
    ) {
      throw new InvalidReservationError('No se puede crear una reserva con fecha/hora de inicio en el pasado.');
    }

    if (category) {
      validateDetailsAgainstFields(params.details, category.fields);
    }

    // 27/08/2026, docs/diseno-precio-servicio-vs-recurso-2026-08-27.md.
    // Mismo criterio que el guard J1 de arriba: va en el caso de uso de
    // ALTA, no en el constructor de Reservation (restore() reconstruye
    // reservas históricas que se crearon antes de esta regla y tienen que
    // seguir leyéndose — R10/R2).
    //
    // (a) Un `serviceId` que no resuelve fallaba en SILENCIO cuando el
    //     caller además mandaba `endTime`: resolveEndTime() solo exige el
    //     servicio para derivar la duración, y la cascada de precio caía al
    //     `basePrice` del recurso como si no se hubiera pedido ninguno.
    //     R15 — una referencia rota falla fuerte, nunca degrada.
    if (params.serviceId && !service) {
      throw new BookableServiceNotFoundError(params.serviceId);
    }

    // (b) En ALOJAMIENTO el precio vive en el SERVICIO ("Estadía"), no en el
    //     recurso: la habitación habilita, no es lo que se cobra. Sin
    //     servicio la estadía cotizaba `resource.base_price` como monto
    //     ÚNICO (units = 1 salvo bookingMode 'block') — una noche y diez
    //     noches salían lo mismo — y quedaban inertes los rate plans,
    //     resource_locks y la asignación automática por categoría (K4).
    //     No se exige `bookingMode === 'block'`: un servicio 'slot' sobre un
    //     recurso de alojamiento es legítimo (actividad guiada con horario).
    //     Fuera de alojamiento no aplica: una mesa de restaurante se reserva
    //     sin servicio a propósito, con base_price = 0.
    if (category?.isLodging && !service) {
      throw new LodgingRequiresServiceError(category.name);
    }

    const endTime = await resolveEndTime(params.serviceId, params.startTime, params.endTime, service);

    const { totalPrice, lines, appliedCustomerRateId } = await this.pricing.resolvePrice({
      customerId: params.customer.id,
      resourceId: params.resourceId,
      serviceId:  params.serviceId,
      ratePlanId: params.ratePlanId,
      resource,
      service,
      startTime:  params.startTime,
      endTime,
    });

    // C1-Fase A (docs/diseno-sena-deposito-fase-a-2026-08-22.md) --
    // deposit_amount se resuelve y congela ACÁ (R9), igual que totalPrice
    // dos líneas arriba -- no se recalcula si la política cambia después.
    // Sin CHARGE todavía: se crea recién al confirmar (handleReservationConfirmed,
    // outbox.handlers.ts), junto con el de saldo -- ver docblock de
    // confirmReservation() más abajo para el porqué de no crearlo acá.
    // (businessProfile ya se buscó más arriba, para J1-TZ -- se reusa acá.)
    const depositAmount = await this.pricing.resolveDepositAmount({
      resourceId: params.resourceId,
      serviceId:  params.serviceId,
      resource,
      service,
      totalPrice,
      defaultDepositPercentage: businessProfile.defaultDepositPercentage,
    });
    const depositDueBy = depositAmount > 0 && businessProfile.depositHoldHours != null
      ? new Date(Date.now() + businessProfile.depositHoldHours * 60 * 60 * 1000)
      : null;

    // Obtener recursos adicionales bloqueados por el servicio (si aplica)
    const lockedResourceIds = await this.availability.resolveLockedResourceIds(
      params.serviceId,
      params.resourceId,
    );

    // D6 (22/08/2026) — número operativo, resuelto UNA vez acá (el único
    // alta real de una reserva) — nunca en updateReservation()/
    // confirmPriceAdjustment(), que reenvían el mismo número que ya tenía.
    const reservationNumber = await this.numberSequenceRepository.next('RESERVATION');

    // K3 (23/08/2026, pendientes-2026-08-23.md) — Reservation.ts SÍ valida
    // partySize > resource.capacity, pero hasta acá nunca se le pasaba el
    // dato real: caía siempre al default de la entidad (1). Se deriva de
    // adultos+ninos cuando vienen informados (hotelería); para negocios de
    // recurso 1:1 (barbería/spa) se puede mandar partySize explícito, o
    // dejar que la entidad siga defaulteando a 1.
    const partySize = params.partySize
      ?? (params.adultos != null ? params.adultos + (params.ninos ?? 0) : undefined);

    let reservation!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
      // Verificar disponibilidad de todos los recursos (principal + bloqueados)
      // partySize (Bug 1, 25/08/2026) -- solo importa para recursos de cupo
      // compartido, ver docblock de assertAllResourcesAvailable().
      await this.availability.assertAllResourcesAvailable(
        client,
        lockedResourceIds,
        params.startTime,
        endTime,
        undefined,
        partySize,
      );

      // 24/08/2026 — la disponibilidad ya pasó (si hubiera bloqueado, la
      // llamada de arriba ya tiró). Esto es aparte: ¿el recurso PRINCIPAL
      // tiene una ventana de mantenimiento ABIERTA cuyo horizonte no llega
      // hasta esta fecha? Se acepta la reserva igual, queda marcada para
      // revisión humana en vez de reasignarse sola.
      const needsMaintenanceReview = await this.availability.needsMaintenanceReview(
        params.resourceId,
        params.startTime,
        endTime,
      );

      reservation = new Reservation({
        id:        params.id,
        customer:  params.customer,
        resource,
        startTime: params.startTime,
        endTime,
        details:   params.details,
        ...(params.serviceId !== undefined && { serviceId: params.serviceId }),
        ratePlanId: params.ratePlanId ?? null,
        adultos: params.adultos ?? null,
        ninos:   params.ninos ?? null,
        ...(partySize !== undefined && { partySize }),
        totalPrice,
        depositAmount,
        depositDueBy,
        reservationNumber,
        appliedCustomerRateId,
        needsMaintenanceReview,
        // Bug 2 (25/08/2026) — snapshot R9 de resource_categories.is_exclusive
        // (mismo `category` ya resuelto arriba para validateDetailsAgainstFields,
        // sin query extra). Lo usa el EXCLUDE constraint de respaldo
        // (reservations_no_overlap_exclusive), que no puede resolverlo con un
        // JOIN en tiempo real.
        isExclusiveResource: category?.isExclusive ?? false,
        lines: lines.map((line, i) => ({
          id:            `${params.id}-L${i + 1}`,
          reservationId: params.id,
          unitDate:      line.unitDate,
          price:         line.price,
        })),
        // v11/Fase 2 (25/09/2026, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md
        // §6 Fase 2 ítem 1) — activación real del marcado: el alta por
        // `categoryId` de una categoría `is_lodging = TRUE` nace
        // `PENDING_ASSIGNMENT` (el recurso resuelto arriba es un candidato
        // PROVISORIO, reoptimizable) -- cualquier otro camino (resourceId
        // explícito, o categoryId de una categoría que no es alojamiento,
        // ej. turnos) sigue naciendo `ASSIGNED`, comportamiento idéntico a
        // Fase 1.
        assignmentStatus: params.enteredByCategory && category?.isLodging ? 'PENDING_ASSIGNMENT' : 'ASSIGNED',
      });

      await this.reservationRepository.saveWithClient(client, reservation);
    });

    return reservation;
  }

  /**
   * `businessId`/`changedBy` (v11, Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md
   * §8 "`updateReservation()` en relación con `assignDeferred()`",
   * Requisito de implementación, consecuencia directa de C1) — nuevos,
   * necesarios para poder llamar a `assignDeferred(client, id,
   * changes.resourceId, businessId, changedBy)` en el discriminador de
   * abajo, que `assignDeferred()` exige (filtro de `Stay` activa por
   * `businessId`, auditoría A6.5 por `changedBy`). El diseño solo declara
   * `businessId` como parámetro nuevo explícito -- `changedBy` no estaba
   * nombrado ahí, pero `assignDeferred()` lo exige igual para su paso 11
   * (auditoría de la transición); se agrega con el mismo criterio
   * (sourceado en la ruta desde `req.user!.id`, mismo patrón que
   * `confirmReservation()`/`completeReservation()`) -- ver el reporte de
   * implementación para el detalle de esta desviación.
   */
  async updateReservation(
    id: string,
    changes: {
      startTime?: Date;
      endTime?: Date;
      details?: Record<string, unknown>;
      resourceId?: string;
      /** Desglose de huéspedes (hotelería, 18/08/2026) — ver docblock de createReservation. */
      adultos?: number | null;
      ninos?: number | null;
      /** Tarifa elegida (spec de mejoras PMS, 18/08/2026) — recotiza si sigue PENDING, ver más abajo. */
      ratePlanId?: string | null;
    },
    businessId: string,
    changedBy: string,
  ): Promise<Reservation> {
    // Guard de forma, no depende del estado de la fila -- no hace falta
    // leer ni lockear nada para saber que no vino ningún campo.
    if (
      !changes.startTime && !changes.endTime && !changes.details && !changes.resourceId
      && changes.adultos === undefined && changes.ninos === undefined && changes.ratePlanId === undefined
    ) {
      throw new InvalidReservationError(
        'Debés enviar al menos un campo para modificar: startTime, endTime, details, resourceId, adultos, ninos o ratePlanId',
      );
    }
    // v11 (Fase 2) — businessId/changedBy son obligatorios desde acá
    // (necesarios para el discriminador que puede invocar assignDeferred(),
    // ver docblock de arriba) — mismo criterio fail-loud que el resto de
    // los métodos de este archivo (confirmReservation()/cancelReservation()/
    // completeReservation()).
    if (!businessId) throw new Error('businessId es obligatorio en updateReservation');
    if (!changedBy) throw new Error('changedBy es obligatorio en updateReservation (A6.5)');

    // Pre-chequeo FUERA de la transacción, mismo criterio que el `preCheck`
    // de confirmReservation() (más abajo en este archivo): NO es la
    // protección real contra la carrera -- eso lo da requireReservationWithLock()
    // de acá abajo -- solo evita abrir una transacción para un id que ni
    // siquiera existe. UPDATE-RESERVATION-LOCK-ORDER-001 (24/09/2026) --
    // además de eso, ahora también se reusa DENTRO de la transacción para
    // decidir qué recursos lockear ANTES del lock de la fila (ver más
    // abajo) -- por eso se guarda el resultado en vez de descartarlo.
    const preCheck = await this.requireReservation(id);

    // J1-TZ (27/09/2026, docs/diseno-j1-fecha-alojamiento-huso-negocio-2026-09-27.md)
    // -- se resuelve ACÁ, junto a `preCheck`, ANTES de abrir la transacción
    // (no adentro: `businessProfileRepository.get()` usa el pool directo,
    // tomaría una conexión extra mientras se sostienen locks). Es seguro
    // decidir con estos valores aunque `preCheck` quede desactualizado: el
    // guard de coherencia de más abajo (`existing.resource.id !== preCheck.resource.id
    // || existing.serviceId !== preCheck.serviceId`) aborta la transacción
    // entera con `ReservationConcurrentlyModifiedError` si el recurso o el
    // servicio cambiaron entre esta lectura y el lock real de la fila -- así
    // que si estos valores quedaron obsoletos, ni siquiera se llega a
    // evaluar el guard J1-TZ de abajo con ellos.
    //
    // Todo el bloque queda condicionado a que el PUT traiga `startTime`
    // (si no, J1 no dispara y no hace falta leer nada de esto -- p.ej.
    // estadias/page.tsx:135, que solo cambia adultos/ninos en cada check-in).
    let j1EffectiveCategory: ResourceCategory | null = null;
    let j1Service: BookableService | null = null;
    let j1BusinessProfile: BusinessProfile | null = null;
    if (changes.startTime !== undefined) {
      if (changes.resourceId && changes.resourceId !== preCheck.resource.id) {
        // HAY reasignación -- la categoría relevante es la del recurso
        // EFECTIVO (el nuevo), no la del viejo. Consulta nueva de recurso,
        // sí hace falta acá para conocer su categoryId.
        const newResource = await this.resourceRepository.getById(changes.resourceId);
        j1EffectiveCategory = newResource ? await this.categoryRepository.findById(newResource.categoryId) : null;
      } else {
        // NO hay reasignación -- `preCheck.resource` ya tiene `categoryId`,
        // sin consulta nueva de recurso.
        j1EffectiveCategory = await this.categoryRepository.findById(preCheck.resource.categoryId);
      }
      j1Service = preCheck.serviceId ? await this.bookableServiceRepository.findById(preCheck.serviceId) : null;
      j1BusinessProfile = await this.businessProfileRepository.get();
    }

    let updated!: Reservation;
    // (B-2, corrección post-gate sobre Fase 2 de 4.3) — `true` solo si esta
    // llamada pasó por `assignDeferred()` (rama de arriba, D-2): distingue
    // "esta invocación confirmó una asignación diferida" de una
    // reasignación normal de una reserva ya `ASSIGNED` (drag-to-move), que
    // NO necesita registrar ocupación acá porque nunca la salteó (B-1 solo
    // saltea mientras `PENDING_ASSIGNMENT`). Se fija DENTRO del callback,
    // en el mismo `if` que decide la rama — no se recalcula después, para
    // no depender de comparar `updated`/`existing` fuera de la transacción.
    let wentThroughAssignDeferred = false;

    await this.transactionManager.run(async (client: SqlClient) => {
      // UPDATE-RESERVATION-LOCK-ORDER-001 (24/09/2026, corrección del gate
      // `architecture-governor` sobre UPDATE-RESERVATION-LOST-STATUS-001,
      // ver docblock de ReservationConcurrentlyModifiedError en
      // domain/errors.ts) -- lockear el RECURSO primero, la FILA de la
      // reserva después: mismo orden que createReservation() y el resto del
      // código -- convención derivada del paso 1 de
      // docs/conocimiento/playbook-locks-exclusividad.md (el recurso se
      // lockea antes de evaluar disponibilidad), no una cita textual de ese
      // documento. La primera versión de UPDATE-RESERVATION-
      // LOST-STATUS-001 invertía ese orden (fila primero, recurso recién
      // adentro de assertAllResourcesAvailable() más abajo) -- eso abre un
      // deadlock ABBA real: una transacción tiene la fila R1 y espera el
      // recurso A, otra tiene A y espera R1.
      //
      // Para decidir QUÉ recursos lockear hace falta saber el recurso
      // candidato ANTES de tener el lock de la fila -- se usa `preCheck`
      // (la lectura SIN lock de arriba) para eso. `effectiveResourceId`:
      // el `resourceId` nuevo si el PUT lo trae, o el que la reserva ya
      // tenía según `preCheck` si no.
      const effectiveResourceId = changes.resourceId ?? preCheck.resource.id;
      const lockSet = await this.availability.resolveLockedResourceIds(
        preCheck.serviceId ?? undefined,
        effectiveResourceId,
      );
      await this.resourceRepository.lockByIds(client, [...lockSet].sort());

      // UPDATE-RESERVATION-LOST-STATUS-001 (24/09/2026, confirmado por
      // architecture-governor) -- releer CON LOCK, antes de calcular
      // cualquier cambio (ahora: recién DESPUÉS de lockear los recursos de
      // arriba). Antes de este fix, `existing` se leía sin lock y ANTES de
      // abrir la transacción: si en paralelo otra operación
      // (confirmReservation, cancelReservation, o el worker
      // reservation-hold-expiry.worker.ts) cambiaba el status de la MISMA
      // reserva y hacía commit antes de que este UPSERT terminara,
      // `initialStatus: existing.status` pisaba ese cambio con el status
      // VIEJO (lost update, A8.1 criterios-negocio.md) -- podía resucitar
      // una reserva CANCELLED, o revertir una CONFIRMED a PENDING después
      // de que `reservation.confirmed` ya hubiera disparado el CHARGE.
      // Mismo patrón que ya usan confirmReservation/cancelReservation/
      // completeReservation/confirmPriceAdjustment
      // (requireReservationWithLock, Bug 3, 25/08/2026) --
      // updateReservation() era el único método de este archivo que mutaba
      // una reserva sin pasar por ese lock. Todo lo que antes se calculaba
      // con `existing` (leído afuera) se recalcula acá adentro con
      // `existing` (ahora la lectura lockeada) -- así cualquier cambio
      // concurrente que ya hizo commit se ve reflejado antes de decidir qué
      // escribir, no solo para `status` sino para todo snapshot que este
      // método reenvía tal cual (depositAmount, cancellationPolicySnapshot,
      // etc. -- ver comentarios más abajo).
      const existing = await this.requireReservationWithLock(client, id);

      // Guard de coherencia (UPDATE-RESERVATION-LOCK-ORDER-001) -- `preCheck`
      // se leyó SIN lock, antes de decidir `lockSet` de arriba. Si la
      // reserva cambió de recurso o de servicio en paralelo entre esa
      // lectura y el lock real de la fila (otra transacción concurrente hizo
      // commit en el medio), `lockSet` quedó calculado sobre datos
      // obsoletos -- pudo no incluir el recurso real de la reserva. Seguir
      // adelante decidiendo qué escribir sobre un lock parcial/equivocado
      // es exactamente la clase de carrera que este fix vino a cerrar del
      // otro lado (status) -- acá se aborta y se pide reintento en vez de
      // arriesgar la misma clase de bug para resourceId/serviceId.
      if (existing.resource.id !== preCheck.resource.id || existing.serviceId !== preCheck.serviceId) {
        throw new ReservationConcurrentlyModifiedError(id);
      }

      // Calendario de PMS (18/08/2026) — drag-to-move/resize necesita poder
      // editar una reserva CONFIRMED, no solo PENDING (mover una reserva ya
      // confirmada de habitación/fecha es el caso de uso principal del
      // tape-chart). Sigue bloqueado para CANCELLED/COMPLETED (A6.4, estados
      // terminales no se reabren). totalPrice/lines quedan congelados igual
      // que antes — este cambio no toca esa decisión ya tomada. Chequeado
      // acá adentro (contra la lectura lockeada), no antes de abrir la tx:
      // es exactamente el campo que la carrera de UPDATE-RESERVATION-LOST-
      // STATUS-001 podía cambiar por debajo mientras este método corría.
      if (existing.status !== 'PENDING' && existing.status !== 'CONFIRMED') {
        throw new InvalidReservationError(
          `Solo se pueden modificar reservas en estado PENDING o CONFIRMED. Estado actual: ${existing.status}`,
        );
      }

      const newStartTime = changes.startTime ?? existing.startTime;
      const newEndTime   = changes.endTime   ?? existing.endTime;

      // J1 (23/08/2026, pendientes-2026-08-23.md) — solo dispara cuando se
      // está moviendo el inicio (drag-to-move del calendario); editar otros
      // campos de una reserva vieja sigue permitido, no se toca acá.
      // Confirmado con el dueño: mover una reserva al pasado se bloquea
      // igual que crearla en el pasado.
      //
      // J1-TZ (27/09/2026, docs/diseno-j1-fecha-alojamiento-huso-negocio-2026-09-27.md)
      // -- mismo criterio que en createReservation(): para alojamiento (o
      // `bookingMode='block'`) con `newStartTime` como marca de fecha
      // calendario, compara fecha en huso de negocio en vez de instante
      // crudo. `j1EffectiveCategory`/`j1Service`/`j1BusinessProfile` ya se
      // resolvieron afuera de la transacción, junto a `preCheck` -- el guard
      // se queda en este mismo lugar, sin reordenar nada de lo que sigue
      // (D-2/ASSIGNMENT_COMBINED_CHANGE más abajo).
      if (
        changes.startTime !== undefined
        && isPastStart(
          newStartTime,
          qualifiesForDateComparison(j1EffectiveCategory?.isLodging ?? false, j1Service?.bookingMode, newStartTime),
          j1BusinessProfile!.timezone,
          this.now,
          PAST_START_TOLERANCE_MS,
        )
      ) {
        throw new InvalidReservationError('No se puede mover una reserva a una fecha/hora de inicio en el pasado.');
      }
      const rawDetails   = changes.details   ?? (existing.details as Record<string, unknown>);
      const newRatePlanId = changes.ratePlanId !== undefined ? changes.ratePlanId : existing.ratePlanId;
      const newAdultos   = changes.adultos !== undefined ? changes.adultos : existing.adultos;
      const newNinos     = changes.ninos   !== undefined ? changes.ninos   : existing.ninos;

      // v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §8
      // "updateReservation() en relación con assignDeferred()") --
      // discriminador de asignación diferida. Se evalúa ACÁ, entre el
      // guard de status (arriba) y la resolución de recurso/categoría/
      // precio (abajo) -- la condición usa `existing` (la lectura BAJO
      // lock), nunca `preCheck`.
      if (existing.assignmentStatus === 'PENDING_ASSIGNMENT' && changes.resourceId) {
        // D-2 (decisión del dueño, Ronda 14) -- combinar resourceId con un
        // cambio REAL (por VALOR, no por mera presencia del campo) de
        // fechas/ratePlanId/details/adultos/ninos se rechaza: "no combinar
        // la confirmación de una asignación diferida con ningún otro
        // cambio de la reserva". `undefined` (campo ausente del body)
        // nunca es un "cambio real" -- no hay valor nuevo que comparar.
        const hasRealOtherChange =
          (changes.startTime !== undefined && changes.startTime.getTime() !== existing.startTime.getTime())
          || (changes.endTime !== undefined && changes.endTime.getTime() !== existing.endTime.getTime())
          || (changes.ratePlanId !== undefined && changes.ratePlanId !== existing.ratePlanId)
          || (changes.details !== undefined && stableStringify(changes.details) !== stableStringify(existing.details))
          || (changes.adultos !== undefined && changes.adultos !== existing.adultos)
          || (changes.ninos !== undefined && changes.ninos !== existing.ninos);

        if (hasRealOtherChange) {
          throw new AssignmentCombinedChangeError(id);
        }

        // Confirma (mismo resourceId) o reasigna (distinto) -- assignDeferred()
        // resuelve `isSameResource` por su cuenta (su propio paso 4). El
        // recurso candidato YA está lockeado desde el paso 2 real de este
        // método (`effectiveResourceId` es exactamente `changes.resourceId`
        // en esta rama), así que `assignDeferred()` no necesita ningún
        // pre-lock propio acá -- su paso 1 (lock de fila) y, si corresponde
        // reasignación real, su paso 8 (re-chequeo de disponibilidad, que
        // re-lockea el recurso) son no-ops sobre locks que esta transacción
        // ya tiene. `assignDeferred()` ya persistió esta reserva (su propio
        // paso 10) -- el resto del método (resolución de recurso/categoría/
        // precio/disponibilidad, restore(), saveWithClient()) se saltea por
        // completo: no queda ningún caso real en que se necesite un
        // recálculo posterior dentro de este mismo PUT (D-2 ya intercepta
        // arriba cualquier combinación con otro cambio real).
        updated = await this.assignDeferred(client, id, changes.resourceId, businessId, changedBy);
        wentThroughAssignDeferred = true;
        return;
      }

      // Reasignación de recurso (drag-to-move) — resuelve el recurso NUEVO
      // antes de validar detalles/disponibilidad, para que todo lo demás
      // (fields de categoría, locks, chequeo de ocupación) corra contra el
      // recurso correcto.
      let resource = existing.resource;
      if (changes.resourceId && changes.resourceId !== existing.resource.id) {
        const newResource = await this.resourceRepository.getById(changes.resourceId);
        if (!newResource) throw new ResourceNotFoundError(changes.resourceId);
        // getById() no filtra por active (R2) — mismo chequeo explícito que
        // createReservation() para una reserva nueva.
        if (!newResource.active) {
          throw new InvalidReservationError(`El recurso ${changes.resourceId} está desactivado.`);
        }
        resource = newResource;
      }

      const category = await this.categoryRepository.findById(resource.categoryId);
      if (category) {
        validateDetailsAgainstFields(rawDetails, category.fields);
      }

      // Bug 2 (25/08/2026) — recalcula el snapshot SOLO si hubo reasignación
      // de recurso (mismo criterio R9 que totalPrice/lines más abajo: no se
      // resincroniza en cada edición si el negocio cambia is_exclusive de la
      // categoría después de creada la reserva).
      const reassigned = changes.resourceId !== undefined && changes.resourceId !== existing.resource.id;
      const isExclusiveResource = reassigned
        ? (category?.isExclusive ?? false)
        : existing.isExclusiveResource;

      // Recursos bloqueados por el servicio, sobre el recurso EFECTIVO
      // (el nuevo si hubo reasignación, el mismo de siempre si no)
      const lockedResourceIds = await this.availability.resolveLockedResourceIds(
        existing.serviceId ?? undefined,
        resource.id,
      );

      // Recotización (18/08/2026, a pedido explícito del dueño — reportado
      // como "el precio no varía al editar"). Antes NUNCA se recalculaba,
      // a propósito (ver historial de este comentario en git blame). Ahora
      // se recalcula SOLO si la reserva sigue PENDING: una CONFIRMED ya
      // generó un CHARGE financiero (clientes-finanzas) por el total viejo
      // — pisar `totalPrice` sin un movimiento de ajuste explícito
      // desincroniza la reserva del cobro ya emitido (A3.9, criterios-
      // negocio.md: "todo movimiento tiene contrapartida"). Ese ajuste para
      // CONFIRMED queda pendiente aparte, requiere diseñarlo (ver
      // pendientes-2026-08-18.md) — no se improvisa acá.
      let totalPrice = existing.totalPrice;
      let lines = existing.lines;
      let appliedCustomerRateId = existing.appliedCustomerRateId;
      if (existing.status === 'PENDING') {
        const service = existing.serviceId
          ? await this.bookableServiceRepository.findById(existing.serviceId)
          : null;
        const priced = await this.pricing.resolvePrice({
          customerId: existing.customer.id,
          resourceId: resource.id,
          serviceId:  existing.serviceId ?? undefined,
          ratePlanId: newRatePlanId ?? undefined,
          resource,
          service,
          startTime:  newStartTime,
          endTime:    newEndTime,
        });
        totalPrice = priced.totalPrice;
        lines = priced.lines.map((line, i) => ({
          id:            `${id}-L${i + 1}`,
          reservationId: id,
          unitDate:      line.unitDate,
          price:         line.price,
        }));
        appliedCustomerRateId = priced.appliedCustomerRateId;
      }

      // partySize (Bug 1, 25/08/2026): updateReservation() no lo recalcula
      // (permanece congelado desde la creación, mismo criterio que ya
      // aplicaba antes de esta sesión) -- se reenvía existing.partySize tal
      // cual para que el chequeo de cupo compartido sea consistente con lo
      // que la reserva ya tiene.
      await this.availability.assertAllResourcesAvailable(
        client,
        lockedResourceIds,
        newStartTime,
        newEndTime,
        id, // excluir la reserva actual del chequeo
        existing.partySize,
      );

      updated = Reservation.restore({
        id:            existing.id,
        customer:      existing.customer,
        resource,
        startTime:     newStartTime,
        endTime:       newEndTime,
        details:       rawDetails,
        initialStatus: existing.status,
        serviceId:     existing.serviceId,
        partySize:     existing.partySize,
        notes:         existing.notes,
        orderItemId:   existing.orderItemId,
        adultos:       newAdultos,
        ninos:         newNinos,
        ratePlanId:    newRatePlanId,
        totalPrice,
        lines,
        // Bug real encontrado de paso (19/08/2026, sesión del ajuste de
        // precio de reservas CONFIRMED): faltaban acá, así que CUALQUIER
        // updateReservation() (incluido el drag-to-move/resize del
        // calendario, punto G) borraba en silencio un pedido de horario
        // especial pendiente/aprobado (punto N) — Reservation.restore()
        // los defaultea a null si no se pasan explícitamente, y el UPSERT
        // los escribe sin condicional (sql.reservation.repository.ts).
        requestedCheckInTime:   existing.requestedCheckInTime,
        requestedCheckOutTime:  existing.requestedCheckOutTime,
        scheduleApprovalStatus: existing.scheduleApprovalStatus,
        scheduleApprovedBy:     existing.scheduleApprovedBy,
        scheduleChargeAmount:   existing.scheduleChargeAmount,
        reservationNumber:      existing.reservationNumber,
        // Bug seña/mantenimiento (27/08/2026, pendientes-2026-08-27.md) —
        // MISMA familia que requestedCheckInTime/scheduleApprovalStatus/
        // isExclusiveResource: Reservation.restore() defaultea a 0/null/false
        // los props no pasados, y el UPSERT los escribe sin condicional
        // (sql.reservation.repository.ts $23/$24/$27). Sin reenviarlos, editar
        // fechas/recurso de una reserva PENDING o CONFIRMED (incl. drag-to-move
        // del calendario) borraba la seña ya cobrada (dinero, A3.9) y apagaba
        // el snapshot de mantenimiento (protección del EXCLUDE constraint,
        // A6.x) en silencio. Son snapshot (R9): se preservan tal cual, NO se
        // recalcula la seña acá — eso es resolveDepositAmount()/C1-A, fuera de
        // alcance de este fix.
        depositAmount:          existing.depositAmount,
        depositDueBy:           existing.depositDueBy,
        appliedCustomerRateId,
        needsMaintenanceReview: existing.needsMaintenanceReview,
        isExclusiveResource,
        // CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) -- MISMA
        // familia de bug que requestedCheckInTime/depositAmount/
        // isExclusiveResource de arriba: Reservation.restore() defaultea a
        // `null` los props no pasados, y el UPSERT los escribe sin
        // condicional. Sin reenviarlo, mover/editar una reserva ya
        // CONFIRMED (drag-to-move del calendario incluido -- este método
        // acepta PENDING y CONFIRMED, ver guard más arriba) borraría en
        // silencio el ladder ya congelado al confirmar, dejando la
        // cancelación posterior caer a regla viva sin que nadie lo haya
        // decidido. No se recalcula acá -- el ladder representa "qué regía
        // al CONFIRMAR", independiente de que las fechas se editen después.
        cancellationPolicySnapshot: existing.cancellationPolicySnapshot,
        // v11/Fase 1 — MISMA familia de bug que requestedCheckInTime/
        // depositAmount/isExclusiveResource/cancellationPolicySnapshot de
        // arriba: Reservation.restore() NO tiene default para este campo
        // (a propósito, G-1) — a diferencia de esos otros, olvidarlo acá
        // no cae en silencio a un valor por defecto, tira
        // InvalidReservationError. Se reenvía tal cual: updateReservation()
        // no reasigna recurso por categoría (eso es Fase 2), así que el
        // assignment_status de una reserva no cambia por esta operación.
        assignmentStatus: existing.assignmentStatus,
      });

      // D-03 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §6)
      // -- única limpieza de `needsMaintenanceReview` decidida por el
      // dueño (AskUserQuestion): se apaga SOLO cuando la reserva se
      // reasigna a OTRO recurso. `reassigned` ya está resuelto arriba
      // (mismo booleano que decide `isExclusiveResource`) -- no cancelar,
      // no cerrar la ventana: ver docblock de
      // `Reservation.clearNeedsMaintenanceReview()`.
      if (reassigned) {
        updated.clearNeedsMaintenanceReview();
      }

      await this.reservationRepository.saveWithClient(client, updated);
    });

    // (B-2) — §8 del diseño: "después de que la transacción haga commit",
    // registrar ocupación sobre la entidad que `assignDeferred()` devolvió.
    // Sin esto, una reasignación por PUT de una `PENDING_ASSIGNMENT` a un
    // recurso concreto confirmaba la asignación pero nunca dejaba ninguna
    // fila en `occupancy_records` (B-1 la saltea mientras estaba
    // PENDING_ASSIGNMENT, y nada más la registraba después).
    if (wentThroughAssignDeferred) {
      await this.availability.recordOccupancy(updated);
    }

    return updated;
  }

  /**
   * Recalcula precio + líneas para una reserva con SUS fechas/recurso
   * ACTUALES (no un candidato hipotético) — usada tanto por
   * `previewPriceAdjustment` como por `confirmPriceAdjustment`, un solo
   * lugar para la cascada de precio en vez de reimplementarla dos veces.
   */
  private async recalculatePriceFor(
    existing: Reservation,
  ): Promise<{ totalPrice: number; lines: ReservationLine[]; appliedCustomerRateId: string | null }> {
    const service = existing.serviceId
      ? await this.bookableServiceRepository.findById(existing.serviceId)
      : null;
    const priced = await this.pricing.resolvePrice({
      customerId: existing.customer.id,
      resourceId: existing.resource.id,
      serviceId:  existing.serviceId ?? undefined,
      ratePlanId: existing.ratePlanId ?? undefined,
      resource:   existing.resource,
      service,
      startTime:  existing.startTime,
      endTime:    existing.endTime,
    });
    return {
      totalPrice: priced.totalPrice,
      lines: priced.lines.map((line, i) => ({
        id:            `${existing.id}-L${i + 1}`,
        reservationId: existing.id,
        unitDate:      line.unitDate,
        price:         line.price,
      })),
      appliedCustomerRateId: priced.appliedCustomerRateId,
    };
  }

  /**
   * Ajuste de precio de una reserva CONFIRMED (19/08/2026, pendientes-2026-
   * 08-18.md punto I, decisión del dueño 19/08/2026). `updateReservation()`
   * deja `totalPrice`/`lines` congelados para CONFIRMED (A3.9 — ya hay un
   * CHARGE emitido) — este método es el "¿y si recalculara?" de solo
   * lectura: compara ese valor congelado contra lo que el precio
   * ACTUAL de la reserva (fechas/recurso ya editados) daría hoy. `null` si
   * no aplica (no está CONFIRMED) o si no hay diferencia real que ajustar.
   */
  async previewPriceAdjustment(id: string): Promise<{
    currentTotalPrice: number;
    recalculatedTotalPrice: number;
    difference: number;
  } | null> {
    const existing = await this.requireReservation(id);
    if (existing.status !== 'CONFIRMED') return null;

    const recalculated = await this.recalculatePriceFor(existing);
    const difference = recalculated.totalPrice - existing.totalPrice;
    if (difference === 0) return null;

    return {
      currentTotalPrice: existing.totalPrice,
      recalculatedTotalPrice: recalculated.totalPrice,
      difference,
    };
  }

  /**
   * Aplica el ajuste que `previewPriceAdjustment` mostró — a pedido
   * EXPLÍCITO de un empleado, nunca automático (elegido por sobre el
   * auto-cobro para evitar un ajuste financiero mal disparado sin revisión
   * humana). Actualiza `totalPrice`/`lines` de la reserva y deja un evento
   * de dominio (`reservation.price_adjusted`) para que el outbox worker
   * cree el movimiento en `clientes-finanzas` — mismo camino async que
   * `reservation.confirmed`→CHARGE (A10, un solo mecanismo para crear
   * movimientos financieros, no uno nuevo por feature). El movimiento es
   * `ADJUSTMENT` con `amount` con signo: positivo si el nuevo precio es
   * mayor (cargo extra), negativo si es menor (nota de crédito) — `type
   * ADJUSTMENT` ya está excluido de la conciliación de caja
   * (`getCashMovementsTotal`, cash-register), es el tipo correcto para una
   * corrección de libro que no es un cobro/pago real de efectivo.
   *
   * `confirmedByUserId` (19/08/2026, corrección a pedido explícito del
   * dueño): identity_id de quien autoriza — la ruta que llama a este
   * método exige `Roles.MANAGEMENT`, NO el mismo `Roles.FRONT_DESK` que
   * puede editar las fechas/recurso que generaron el ajuste. Sin esa
   * separación, la misma persona que estira una reserva podría también
   * "confirmar" el cargo resultante con un segundo click — la revisión
   * manual dejaría de ser una revisión real. Se persiste en
   * `financial_transactions.confirmed_by`, mismo criterio que
   * `reservations.schedule_approved_by`.
   */
  async confirmPriceAdjustment(id: string, businessId: string, confirmedByUserId: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en confirmPriceAdjustment');
    if (!confirmedByUserId) throw new Error('confirmedByUserId es obligatorio en confirmPriceAdjustment');

    let updated!: Reservation;

    // Bug 3 (25/08/2026) — a diferencia de confirmar/cancelar/completar,
    // acá la carrera NO es sobre `status` (un ajuste de precio no lo
    // cambia) sino sobre `totalPrice`: dos llamadas concurrentes podían
    // leer el mismo `existing.totalPrice` FUERA de la transacción, calcular
    // la MISMA `difference`, y las dos aplicarla — dos eventos
    // `reservation.price_adjusted` (dos ADJUSTMENT financieros) para un
    // solo cambio real de precio. Fix: todo el cálculo se mueve ADENTRO de
    // la transacción, contra el `totalPrice` recién LOCKEADO (no el leído
    // antes de esperar el lock) — la segunda llamada, tras esperar a que la
    // primera haga COMMIT, recalcula la MISMA `recalculated.totalPrice`
    // (determinística) contra un `locked.totalPrice` que ya es igual a esa
    // cifra → `difference = 0` → `NoPriceAdjustmentPendingError`, sin
    // segundo evento.
    await this.transactionManager.run(async (client: SqlClient) => {
      const locked = await this.requireReservationWithLock(client, id);
      if (locked.status !== 'CONFIRMED') {
        throw new InvalidReservationError(
          `Solo se puede ajustar el precio de una reserva CONFIRMED. Estado actual: ${locked.status}`,
        );
      }

      const recalculated = await this.recalculatePriceFor(locked);
      const difference = recalculated.totalPrice - locked.totalPrice;
      if (difference === 0) throw new NoPriceAdjustmentPendingError(id);

      updated = Reservation.restore({
        id:            locked.id,
        customer:      locked.customer,
        resource:      locked.resource,
        startTime:     locked.startTime,
        endTime:       locked.endTime,
        details:       locked.details as Record<string, unknown>,
        initialStatus: locked.status,
        serviceId:     locked.serviceId,
        partySize:     locked.partySize,
        notes:         locked.notes,
        orderItemId:   locked.orderItemId,
        adultos:       locked.adultos,
        ninos:         locked.ninos,
        ratePlanId:    locked.ratePlanId,
        totalPrice:    recalculated.totalPrice,
        lines:         recalculated.lines,
        requestedCheckInTime:   locked.requestedCheckInTime,
        requestedCheckOutTime:  locked.requestedCheckOutTime,
        scheduleApprovalStatus: locked.scheduleApprovalStatus,
        scheduleApprovedBy:     locked.scheduleApprovedBy,
        scheduleChargeAmount:   locked.scheduleChargeAmount,
        reservationNumber:      locked.reservationNumber,
        depositAmount:          locked.depositAmount,
        depositDueBy:           locked.depositDueBy,
        appliedCustomerRateId:  recalculated.appliedCustomerRateId,
        // Bug 2 (25/08/2026) — sin esto, cada ajuste de precio resetearía
        // el snapshot a `false` en silencio (Reservation.restore() defaultea
        // los props no pasados), apagando la protección del EXCLUDE
        // constraint para esta reserva.
        //
        // needsMaintenanceReview (27/08/2026, pendientes-2026-08-27.md) —
        // tenía el MISMO problema acá (no se reenviaba, caía a `false`); la
        // NOTA previa que lo dejaba "sin corregir, fuera de alcance de Bug 2"
        // ya no aplica: se reenvía junto con isExclusiveResource. Mismo patrón
        // de bug ya corregido para requestedCheckInTime/scheduleApprovalStatus.
        needsMaintenanceReview: locked.needsMaintenanceReview,
        isExclusiveResource:    locked.isExclusiveResource,
        // CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 -- mismo motivo que en
        // updateReservation(): sin reenviarlo, todo ajuste de precio sobre
        // una reserva CONFIRMED borraría en silencio el ladder ya
        // congelado al confirmar.
        cancellationPolicySnapshot: locked.cancellationPolicySnapshot,
        // v11/Fase 1 — mismo motivo que en updateReservation(): sin
        // default, se reenvía tal cual. Un ajuste de precio no toca la
        // asignación de recurso.
        assignmentStatus: locked.assignmentStatus,
      });

      await this.reservationRepository.saveWithClient(client, updated);
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   id,
        eventType:     'reservation.price_adjusted',
        payload: {
          reservationId: id,
          customerId:    locked.customer.id,
          // Con signo -- outbox.handlers.ts lo pasa tal cual como `amount`
          // del ADJUSTMENT. Positivo = cargo extra, negativo = nota de
          // crédito (A10.2, payload autocontenido).
          amount:             difference,
          // Quién autorizó el ajuste (19/08/2026, a pedido explícito del
          // dueño) — mismo criterio de accountability que
          // reservations.schedule_approved_by. La ruta que llama a este
          // método exige Roles.MANAGEMENT, no el mismo FRONT_DESK que edita
          // fechas: separa "quien pide el cambio" de "quien aprueba la plata".
          confirmedByUserId,
          previousTotalPrice: locked.totalPrice,
          newTotalPrice:      recalculated.totalPrice,
        },
      });
    });

    return updated;
  }

  /**
   * C1-Fase A (22/08/2026, docs/diseno-sena-deposito-fase-a-2026-08-22.md)
   * — "regla de oro": no confirma sin la seña cobrada. El gate compara
   * `PAYMENT` `SETTLED` acumulados contra `deposit_amount` (congelado al
   * crear la reserva) — no depende de que exista un `CHARGE` todavía. El
   * `CHARGE(depósito)` recién se crea acá, `SETTLED` directo (ya está
   * pagado, es un hecho consumado — mismo criterio que un `PAYMENT`
   * manual), junto con el `CHARGE(saldo)` `PENDING` que reemplaza a la
   * única `CHARGE` que este evento creaba antes de esta fase (ver
   * `handleReservationConfirmed`, outbox.handlers.ts). Cero cambios en
   * `handleReservationCompleted`/`checkOut()` — el saldo sigue flotando
   * `PENDING` hasta que el folio cierra, exactamente como hacía la única
   * CHARGE de antes.
   */
  async confirmReservation(id: string, businessId: string, changedBy: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en confirmReservation');
    if (!changedBy) throw new Error('changedBy es obligatorio en confirmReservation (A6.5)');

    // Pre-chequeo FUERA de la transacción -- financial_transactions es otra
    // tabla, no hace falta el lock de reservations para leerla. No es la
    // protección real contra la carrera (eso lo da el getByIdWithLock +
    // transitionTo() de abajo) -- solo evita abrir una transacción para un
    // caso obviamente inválido.
    const preCheck = await this.requireReservation(id);
    if (preCheck.depositAmount > 0) {
      const paidSoFar = await this.financialTransactionRepository.getSettledPaymentTotalForReservation(id);
      if (paidSoFar < preCheck.depositAmount) {
        throw new DepositNotPaidError(id, preCheck.depositAmount, paidSoFar);
      }
    }

    // email.handlers.ts necesita saber si esto es alojamiento (E1) para
    // formatear Desde/Hasta como día calendario + horario ESTÁNDAR del
    // negocio, no como el instante crudo -- startTime/endTime de una
    // reserva de alojamiento son "medianoche UTC de ese día" (marca de
    // fecha, ver comentario de Reservas en appfrontend-main), sin
    // significado real de hora. Aplicarles el huso del negocio como si
    // fueran un instante real corría el horario mostrado (bug reportado
    // 19/08/2026: "Desde"/"Hasta" mostraban 9pm-9pm sin relación con el
    // check-in/check-out configurado). El recurso no cambia al confirmar,
    // así que categoryId es el mismo con o sin lock.
    const category = await this.categoryRepository.findById(preCheck.resource.categoryId);

    // CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 (14/09/2026) -- resuelto FUERA
    // de la transacción, mismo criterio que `category` arriba y que el
    // catálogo/config que CancellationRefundService.confirmRefund() ya
    // saca del lock a propósito (ver su comentario ":147-153"):
    // `cancellation_policies` es una tabla de catálogo/config ajena a la
    // fila de `reservations` que el FOR UPDATE de abajo va a lockear, no
    // participa de ninguna carrera que ese lock deba cubrir. `null` (nada
    // que congelar) es un resultado válido y frecuente -- ver
    // `buildCancellationPolicySnapshot()`.
    const cancellationPolicies = await this.cancellationPolicyRepository.findAll(businessId);
    const cancellationPolicySnapshot = buildCancellationPolicySnapshot(cancellationPolicies, this.now());

    let reservation!: Reservation;

    // Bug 3 (25/08/2026) — la lectura + `.confirm()` se mueven ADENTRO de
    // la transacción, con FOR UPDATE sobre esta fila puntual. Sin esto,
    // dos confirmaciones concurrentes (o el worker de expiración vs. el
    // huésped confirmando justo a tiempo) podían generar dos eventos
    // `reservation.confirmed` (dos CHARGEs) -- con el lock, la segunda ve
    // el estado ya CONFIRMED y `transitionTo()` la rechaza ANTES de que
    // el evento se inserte.
    await this.transactionManager.run(async (client: SqlClient) => {
      reservation = await this.requireReservationWithLock(client, id);
      const previousStatus = reservation.status;
      reservation.confirm();
      // CANCEL-POLICY-SCOPE-BASE-001 Bloque 2 -- misma transacción que el
      // UPDATE de abajo (atomic-state-mutation: una sola operación
      // lógica). Si `saveWithClient()`/el INSERT de evento fallan y la
      // transacción hace rollback, el snapshot en memoria se descarta
      // junto con la transición de estado -- nunca queda a medio poblar
      // en la fila real (no hay ningún `await` entre este `.freezeCancellationPolicy()`
      // y el `saveWithClient()` de abajo que pueda dejarlos desincronizados).
      reservation.freezeCancellationPolicy(cancellationPolicySnapshot);

      await this.reservationRepository.saveWithClient(client, reservation);
      // D-10 -- misma transacción que el UPDATE de arriba (atomic-state-mutation).
      await auditReservationTransition(
        client, this.auditLogRepo, reservation.id, previousStatus, reservation.status, changedBy,
      );
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   reservation.id,
        eventType:     'reservation.confirmed',
        payload: {
          reservationId: reservation.id,
          customerId:    reservation.customer.id,
          resourceId:    reservation.resource.id,
          startTime:     reservation.startTime.toISOString(),
          endTime:       reservation.endTime.toISOString(),
          // outbox.handlers.ts lee esto para crear el CHARGE — antes faltaba
          // acá, así que se salteaba en silencio (totalPrice null/≤0).
          totalPrice:    reservation.totalPrice,
          // C1-Fase A -- handleReservationConfirmed necesita separar
          // depósito (ya cobrado, SETTLED) de saldo (PENDING, = totalPrice -
          // depositAmount) en vez de una sola CHARGE por el total.
          depositAmount: reservation.depositAmount,
          // email.handlers.ts (punto 5/E5, 15/08/2026) — payload autocontenido
          // (A10.2): no relee customer/resource, ya los tiene acá.
          customerEmail: reservation.customer.email ?? null,
          customerName:  reservation.customer.fullName,
          resourceName:  reservation.resource.name,
          isLodging:     category?.isLodging ?? false,
          // v11/Fase 1 (25/09/2026, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md
          // §6) — email.handlers.ts lo usa SOLO para alojamiento
          // (isLodging), en vez de resourceName, cuando está presente
          // (`?? resourceName` ahí es compatibilidad con eventos viejos
          // reprocesados que no traen este campo). `category` ya está
          // resuelto arriba, mismo query que ya usa `isLodging`.
          categoryName: category?.name,
        },
      });
    });

    await this.availability.recordOccupancy(reservation);
    return reservation;
  }

  /**
   * RESERVA-10 (05/09/2026, architecture-governor) -- mismo método que
   * `OrderService.findBlockingInvoiceLinkage()` (pos-menu), portado acá.
   * Recorre los `CHARGE` de la reserva y bloquea si alguno ya tiene una
   * factura `ISSUED`, o `NOT_ISSUED` en `PENDING`/`FAILED_UNCERTAIN`+
   * `afipContacted` -- nunca `REJECTED` (AFIP ya dijo que no, no hay
   * comprobante real). Se llama DESPUÉS de `requireReservationWithLock()`
   * -- el lock de `reservations` ya está tomado, así que esta lectura
   * queda serializada contra cualquier `requestInvoice()` concurrente que
   * compita por el mismo lock (ver `ReservationCancelledCannotInvoiceError`
   * del otro lado, en `InvoiceService.requestInvoice()`).
   */
  private async findBlockingInvoiceLinkage(reservationId: string): Promise<InvoiceLinkage & { kind: 'ISSUED' | 'NOT_ISSUED' } | null> {
    const charges = (await this.financialTransactionRepository.getByReservationId(reservationId))
      .filter((tx) => tx.type === 'CHARGE');
    for (const charge of charges) {
      const linkage = await this.invoiceRepo.resolveInvoiceLinkage(charge.id);
      if (linkage.kind === 'ISSUED') return linkage;
      if (linkage.kind === 'NOT_ISSUED' && (linkage.status === 'PENDING' || (linkage.status === 'FAILED_UNCERTAIN' && linkage.afipContacted))) {
        return linkage;
      }
    }
    return null;
  }

  async cancelReservation(id: string, businessId: string, changedBy: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en cancelReservation');
    if (!changedBy) throw new Error('changedBy es obligatorio en cancelReservation (A6.5)');

    let reservation!: Reservation;

    // Bug 3 (25/08/2026) — lectura+mutación adentro de la transacción, ver
    // docblock de confirmReservation(). Cubre gratis la doble cancelación:
    // la segunda ve el estado ya CANCELLED y transitionTo() la rechaza.
    await this.transactionManager.run(async (client: SqlClient) => {
      reservation = await this.requireReservationWithLock(client, id);
      const previousStatus = reservation.status;
      reservation.cancel();

      // RESERVA-10 (05/09/2026, architecture-governor) -- puerta
      // fail-closed: si el cargo de la reserva ya tiene un comprobante
      // fiscal vivo, la cancelación se rechaza ACÁ, DENTRO de la
      // transacción -- el rollback deshace también la transición que
      // `reservation.cancel()` ya aplicó en memoria (todavía no
      // persistida). Mismo alcance que ORDER-10 Bloque 1: sin escape
      // administrativo todavía (Nota de Crédito), doctrina del dueño del
      // producto.
      const blocking = await this.findBlockingInvoiceLinkage(reservation.id);
      if (blocking) {
        throw new ReservationChargeInvoicedError(
          reservation.id, blocking.invoiceId, blocking.kind === 'ISSUED' ? 'ISSUED' : blocking.status,
        );
      }

      await this.reservationRepository.saveWithClient(client, reservation);
      // D-10 -- misma transacción que el UPDATE de arriba (atomic-state-mutation).
      await auditReservationTransition(
        client, this.auditLogRepo, reservation.id, previousStatus, reservation.status, changedBy,
      );
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   reservation.id,
        eventType:     'reservation.cancelled',
        payload: {
          reservationId: reservation.id,
          customerId:    reservation.customer.id,
          resourceId:    reservation.resource.id,
          cancelledAt:   new Date().toISOString(),
        },
      });
    });

    return reservation;
  }

  /**
   * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6/§8,
   * sub-alcance "completar confirma la asignación") — `preCheck` (SIN
   * lock, patrón NUEVO — este método antes entraba directo a
   * `requireReservationWithLock()`) decide ÚNICAMENTE qué recurso
   * pre-lockear, ANTES de la fila (H2: la optimización de FK de un
   * `UPDATE` que no cambia el valor no aplica si la MISMA transacción ya
   * escribió la fila antes — el UPSERT de `assignDeferred()` seguido del
   * propio `.complete()`/`saveWithClient()` de este método es exactamente
   * ese caso). La DECISIÓN de invocar `assignDeferred()` — y el guard de
   * coherencia — se toman SIEMPRE con `locked` (la lectura BAJO lock),
   * nunca con `preCheck` (evita un 409 espurio si otra operación ya
   * asignó la reserva entre `preCheck` y el lock de fila).
   */
  async completeReservation(id: string, businessId: string, changedBy: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en completeReservation');
    if (!changedBy) throw new Error('changedBy es obligatorio en completeReservation (A6.5)');

    const preCheck = await this.requireReservation(id);

    let reservation!: Reservation;

    // Bug 3 (25/08/2026) — mismo criterio que cancelReservation()/
    // confirmReservation(), ver docblock de arriba.
    await this.transactionManager.run(async (client: SqlClient) => {
      // v11/Fase 2 (C-4, Ronda 15) — el lock del recurso, si corresponde,
      // es la PRIMERA sentencia DENTRO de la transacción, nunca antes de
      // abrirla (`lockByIds()` recibe el `client` transaccional). Si
      // `preCheck` ya ve ASSIGNED, no se lockea ningún recurso nuevo acá.
      if (preCheck.assignmentStatus === 'PENDING_ASSIGNMENT') {
        await this.resourceRepository.lockByIds(client, [preCheck.resource.id]);
      }

      let locked = await this.requireReservationWithLock(client, id);

      // v11/Fase 2 (N-2, Ronda 14/15) — tabla de 6 casos completa en el
      // diseño. La decisión SIEMPRE se toma con `locked`, nunca con
      // `preCheck`.
      if (locked.assignmentStatus === 'PENDING_ASSIGNMENT') {
        // Guard acotado (2 campos): si `preCheck` no vio PENDING_ASSIGNMENT,
        // o si el recurso bajo lock no coincide con el que `preCheck`
        // pre-lockeó, el recurso correcto nunca se lockeó -- invocar
        // assignDeferred() acá violaría N1 (recurso SIEMPRE lockeado ANTES
        // que la fila). Aborta y pide reintento.
        const guardTriggers =
          preCheck.assignmentStatus !== 'PENDING_ASSIGNMENT'
          || locked.resource.id !== preCheck.resource.id;
        if (guardTriggers) {
          throw new ReservationConcurrentlyModifiedError(id, 'cambió de estado de asignación o de recurso candidato');
        }
        // Caso normal: mismo recurso que ya tenía ("completar" nunca
        // reasigna) -- isSameResource siempre verdadero en esta rama, por
        // construcción. El recurso ya está lockeado desde arriba, así que
        // el paso 1 de assignDeferred() (lock de fila) es un no-op y sus
        // pasos 5-8 se saltean por completo.
        locked = await this.assignDeferred(client, id, locked.resource.id, businessId, changedBy);
      }
      // Si `locked.assignmentStatus === 'ASSIGNED'` (incluido el caso de
      // carrera donde `preCheck` vio PENDING_ASSIGNMENT pero otra
      // operación ya asignó la reserva antes de que "completar" tomara su
      // lock de fila) -- NO invoca assignDeferred(): sigue por la rama
      // ASSIGNED normal, sin ningún error de conflicto. El lock del
      // recurso tomado de más (si lo hubo) es inocuo.

      // B4 -- encadenamiento obligatorio: si assignDeferred() corrió, TODO
      // lo que sigue (.complete(), saveWithClient(), y post-commit
      // recordOccupancy()) usa la entidad NUEVA que devolvió (`locked`,
      // reasignada arriba), nunca la lectura original -- de lo contrario el
      // UPSERT final pisaría la transición recién hecha.
      const previousStatus = locked.status;
      locked.complete();
      reservation = locked;

      await this.reservationRepository.saveWithClient(client, reservation);
      // D-10 -- misma transacción que el UPDATE de arriba (atomic-state-mutation).
      await auditReservationTransition(
        client, this.auditLogRepo, reservation.id, previousStatus, reservation.status, changedBy,
      );
      await this.domainEventRepository.insertWithClient(client, {
        businessId,
        aggregateType: 'RESERVATION',
        aggregateId:   reservation.id,
        eventType:     'reservation.completed',
        payload: {
          reservationId: reservation.id,
          customerId:    reservation.customer.id,
          resourceId:    reservation.resource.id,
          completedAt:   new Date().toISOString(),
        },
      });
    });

    await this.availability.recordOccupancy(reservation);
    return reservation;
  }

  /**
   * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §8
   * A6.1) — operación de aplicación única que confirma una asignación
   * provisoria (`PENDING_ASSIGNMENT`) sobre un recurso concreto. Los
   * CUATRO caminos reales (`PUT /reservations/:id`, `autoAssignAllForCategory()`
   * ("Auto Assign All", Fase 3,
   * docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md), check-in,
   * completar) la invocan en vez de reimplementarla cada uno por su lado.
   *
   * Recibe el `client` de la transacción del CALLER — no abre su propia
   * transacción, porque `checkIn()`/`updateReservation()`/`completeReservation()`/
   * `autoAssignAllForCategory()` necesitan componerla dentro de la suya. El
   * CALLER es responsable de lockear el recurso candidato (`resourceId`)
   * ANTES de invocar esta operación, cuando corresponda (N1: nunca se toma
   * el lock de un recurso mientras ya se tiene tomada una fila de
   * `reservations`) — ver la tabla de orden de locks por caller en el
   * diseño (§8 A6.1 del documento base, §3.5 del documento de Fase 3 para
   * el caller nuevo).
   *
   * `recordOccupancy()` NO se llama acá — cada caller lo hace por su
   * cuenta, DESPUÉS de que su propia transacción haga commit exitosamente
   * (`SqlOccupancyRepository` no tiene variante `WithClient`).
   *
   * @param expectedDateRange - F3-6 (Fase 3, "Auto Assign All", §3.3 del
   *   documento de Fase 3) — opcional, 6to parámetro. Los 3 callers
   *   preexistentes (`PUT`, check-in, completar) nunca lo pasan —
   *   comportamiento idéntico para ellos. Solo `autoAssignAllForCategory()`
   *   lo usa: compara `locked.startTime/endTime` (la relectura BAJO lock,
   *   autoritativa) contra el rango que el batch tenía en su lectura SIN
   *   lock — si difieren, la reserva cambió de fechas en paralelo (vía
   *   `PUT`, panel o portal, C7) entre esa lectura y este lock, y la
   *   validación de disponibilidad que el batch ya hizo (fuera de esta
   *   transacción) quedó calculada sobre un rango que ya no es el vigente.
   *   Sin este chequeo, la rama "confirmar el mismo recurso" (que se salta
   *   los pasos 5-8 de acá abajo, ver el `if (!isSameResource)` más
   *   adelante) no tiene NINGUNA otra validación de disponibilidad fresca.
   */
  async assignDeferred(
    client: SqlClient,
    reservationId: string,
    resourceId: string,
    businessId: string,
    changedBy: string,
    expectedDateRange?: { startTime: Date; endTime: Date },
  ): Promise<Reservation> {
    // Paso 1 — lock de la reserva (no-op si el caller ya la tenía
    // lockeada). Única fuente de verdad para el resto de los pasos.
    const locked = await this.requireReservationWithLock(client, reservationId);

    // Paso 2 — re-chequeo de estado bajo lock: el chequeo de concurrencia
    // real. Sin esto, dos llamadas concurrentes sobre la misma reserva
    // podrían ejecutar el resto de los pasos dos veces.
    if (locked.assignmentStatus !== 'PENDING_ASSIGNMENT') {
      throw new ReservationAlreadyAssignedError(reservationId);
    }

    // Paso 2.5 (F3-6, Fase 3 "Auto Assign All") — guard de coherencia de
    // fechas, solo si el caller lo pide. Va DESPUÉS del re-chequeo de
    // assignmentStatus (paso 2, arriba): si la reserva ya fue asignada por
    // otra operación concurrente, ese es el error más informativo
    // (ReservationAlreadyAssignedError) -- "cambió de fechas" solo importa
    // si todavía sigue siendo una PENDING_ASSIGNMENT genuina. Y ANTES del
    // allowlist de status (paso 3, abajo).
    if (
      expectedDateRange
      && (locked.startTime.getTime() !== expectedDateRange.startTime.getTime()
        || locked.endTime.getTime() !== expectedDateRange.endTime.getTime())
    ) {
      throw new ReservationConcurrentlyModifiedError(reservationId, 'cambió de fechas');
    }

    // Paso 3 — allowlist de status.
    if (locked.status !== 'PENDING' && locked.status !== 'CONFIRMED') {
      throw new InvalidReservationError(
        `Solo se puede confirmar la asignación de reservas en estado PENDING o CONFIRMED. Estado actual: ${locked.status}`,
      );
    }

    // Paso 4 — ¿es la MISMA unidad, bajo lock? Relectura autoritativa,
    // recalculada acá, no asumida.
    const isSameResource = resourceId === locked.resource.id;

    let resource: PhysicalResource = locked.resource;
    let isExclusiveResourceValue = locked.isExclusiveResource;
    let shouldClearMaintenanceReview = false;

    if (!isSameResource) {
      // Paso 5 — carga y validación del recurso nuevo. Ya está lockeado
      // por el pre-lock que el caller tomó antes de invocar esta
      // operación (contrato de N1) — esta carga es una lectura normal
      // sobre una fila que la propia transacción ya tiene tomada.
      const newResource = await this.resourceRepository.getById(resourceId);
      if (!newResource) {
        throw new ResourceNotFoundError(resourceId);
      }
      if (!newResource.active) {
        throw new InvalidReservationError(`El recurso ${resourceId} está desactivado.`);
      }
      const newCategory = await this.categoryRepository.findById(newResource.categoryId);

      // Paso 6 — restricción de categoría. La categoría "original" se
      // deriva EN VIVO de `locked.resource.categoryId`.
      if (newResource.categoryId !== locked.resource.categoryId) {
        throw new AssignmentCategoryMismatchError(reservationId);
      }

      // Paso 7 — filtro de Stay activa en el recurso candidato. La tabla
      // `stays` no tiene columnas de rango de fechas -- se usa el
      // predicado que el check-in YA usa hoy para este mismo propósito.
      // Excluye explícitamente una Stay de la propia reserva que se está
      // asignando (para no rechazarla contra su propio check-in).
      const activeStay = await this.stayRepository.findActiveByResource(resourceId, businessId);
      if (activeStay && activeStay.reservationId !== locked.id) {
        throw new ResourceOccupiedError(resourceId);
      }

      // Paso 8 — re-chequeo de disponibilidad + snapshot condicional. Esta
      // llamada vuelve a lockear `resourceId` vía su propio `lockByIds()`
      // interno -- el MISMO recurso que el pre-lock del caller ya lockeó,
      // o, si llegó sin ese pre-lock, lo lockea acá por primera vez, sin
      // diferencia funcional (Postgres permite `FOR UPDATE` repetido sobre
      // la misma fila dentro de la misma transacción, no-op).
      await this.availability.assertAllResourcesAvailable(
        client, [resourceId], locked.startTime, locked.endTime, locked.id, locked.partySize,
      );

      resource = newResource;
      isExclusiveResourceValue = newCategory?.isExclusive ?? false;
      shouldClearMaintenanceReview = true;
    }

    // Paso 9 — no-recotización: puramente declarativo, nada que calcular
    // ni saltear acá. Si la llamada intentó combinar fechas/ratePlanId con
    // la confirmación, eso ya se rechazó ANTES de llegar acá
    // (responsabilidad del caller, ver el discriminador de
    // `updateReservation()`).

    // Paso 10 — la escritura real. Único punto donde `assignment_status`
    // cambia de valor de verdad.
    const updated = locked.assignConcreteResource(resource, isExclusiveResourceValue);
    if (shouldClearMaintenanceReview) {
      updated.clearNeedsMaintenanceReview();
    }
    await this.reservationRepository.saveWithClient(client, updated);

    // Paso 11 — auditoría de la transición (A6.5), dentro de la misma
    // transacción. (C-1, corrección post-gate sobre Fase 2 de 4.3) — solo
    // se registra `resourceId` si el recurso REALMENTE cambió
    // (`!isSameResource`, paso 4 de acá arriba): completar/check-in sobre
    // el mismo recurso provisorio (el caso más común) no pasa por acá, así
    // que no queda un cambio "de X a X" ruidoso en la auditoría (A6.5,
    // mismo criterio que `diffFields()` de `domain/audit.ts` — no aplica
    // literal porque `resourceId` no es un campo plano de `Reservation`,
    // vive anidado en `resource.id`).
    const fieldChanges: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [
      { field: 'assignmentStatus', oldValue: 'PENDING_ASSIGNMENT', newValue: 'ASSIGNED' },
    ];
    if (!isSameResource) {
      fieldChanges.push({ field: 'resourceId', oldValue: locked.resource.id, newValue: updated.resource.id });
    }
    await recordFieldChangesWithClient(client, this.auditLogRepo, 'reservations', reservationId, fieldChanges, changedBy);

    return updated;
  }

  /**
   * v11 (Fase 2, docs/diseno-reserva-por-tipo-unidad-2026-09-24.md §6
   * sub-alcance "check-in confirma la asignación", B-2 Ronda 13) —
   * expuesto para que `StayService.checkIn()` (que no tiene, ni va a
   * tener, ningún acceso directo a `this.availability`) pueda registrar
   * ocupación DESPUÉS de que su propia transacción haga commit, sobre la
   * entidad que devolvió `assignDeferred()`. Delega internamente a la
   * misma implementación que ya usan `confirmReservation()`/
   * `completeReservation()` desde DENTRO de esta clase.
   */
  async recordOccupancy(reservation: Reservation): Promise<void> {
    return this.availability.recordOccupancy(reservation);
  }

  /**
   * @param serviceId - Opcional. Si se especifica, además del `resourceId`
   *   principal se verifican todos los recursos que ese servicio bloquea
   *   (`resource_locks`) — sin esto, un servicio con recursos compartidos
   *   podía reportarse "disponible" mirando solo su recurso primario.
   */
  async checkAvailability(
    resourceId: string,
    startTime: Date,
    endTime: Date,
    excludeReservationId?: string,
    serviceId?: string,
    /** Bug 1 (25/08/2026) — ver docblock en ReservationAvailabilityService.checkAvailability(). */
    partySize?: number,
  ): Promise<boolean> {
    return this.availability.checkAvailability(resourceId, startTime, endTime, excludeReservationId, serviceId, partySize);
  }

  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.reservationRepository.getById(id);
  }

  async findAvailableResourceInCategory(params: {
    categoryId: string;
    startTime: Date;
    endTime?: Date;
    serviceId?: string;
  }): Promise<PhysicalResource | null> {
    return this.availability.findAvailableResourceInCategory(params);
  }

  async getAvailableSlots(serviceId: string, resourceId: string, date: Date, timezone: string): Promise<string[]> {
    return this.schedule.getAvailableSlots(serviceId, resourceId, date, timezone);
  }

  /**
   * Fase 3, "Auto Assign All"
   * (docs/diseno-reserva-por-tipo-unidad-fase-3-2026-09-27.md §3.4/§5) —
   * resuelve automáticamente TODAS las reservas `PENDING_ASSIGNMENT` de
   * `categoryId` cuya llegada es HOY (fecha de negocio): para cada una,
   * primero confirma la MISMA unidad provisoria si sigue libre (Paso A,
   * sin reoptimizar el conjunto — decisión del dueño F3-4), y solo si no
   * lo está busca una alternativa en la categoría (Paso B, fallback
   * greedy-alfabético existente, `findAvailableResourceInCategory()`).
   *
   * Filtrado por fecha, 2 capas (§2.2 del diseño, mismo criterio que
   * J1-TZ): capa 1 (SQL, sobre-inclusiva) trae una ventana de 3 días
   * alrededor de la medianoche UTC de "hoy" (huso de negocio); capa 2 (JS,
   * exacta) filtra con `deriveCalendarDate() === todayBusinessDate`, la
   * MISMA función que J1-TZ. `totalPending` se deriva de la capa 2
   * (`filtered.length`), NUNCA de un conteo SQL aproximado (B1, v3 del
   * diseño) — el tope operativo (`RESERVATIONS_MAX_LIMIT`) se aplica
   * DESPUÉS de la capa 2, sobre filas ya exactas.
   *
   * SECUENCIAL, nunca `Promise.all` (§4.1 del diseño): no es un requisito
   * de corrección (cada transacción revalida bajo lock), es una decisión
   * de CALIDAD del resultado — procesar en paralelo podría hacer que dos
   * reservas del propio batch resuelvan el MISMO alternativo en el
   * fallback, y la segunda fallaría con un `InvalidReservationError`
   * espurio pese a que existía OTRO recurso libre.
   *
   * El batch como operación HTTP siempre responde 200 con un reporte
   * estructurado — una reserva que falla NO aborta las demás (§4.2); el
   * `for` sigue con la siguiente, vía `classifyFailure()`.
   */
  async autoAssignAllForCategory(
    categoryId: string,
    businessId: string,
    changedBy: string,
  ): Promise<AutoAssignAllResult> {
    const category = await this.categoryRepository.findById(categoryId);
    const categoryName = category?.name ?? '';

    const businessProfile = await this.businessProfileRepository.get();
    const todayBusinessDate = todayInBusinessTimezone(this.now(), businessProfile.timezone);

    // Capa 1 (SQL, sobre-inclusiva a propósito, §2.2) — ventana de 3 días
    // alrededor de la medianoche UTC de "hoy" (huso de negocio): generosa
    // para cubrir cualquier offset real (-12 a +14) sin descartar por SQL
    // ninguna fila que la capa 2 (exacta) todavía necesite evaluar.
    const todayUtcMidnight = new Date(`${todayBusinessDate}T00:00:00.000Z`);
    const todayWindow = {
      from: new Date(todayUtcMidnight.getTime() - 24 * 60 * 60 * 1000),
      to:   new Date(todayUtcMidnight.getTime() + 2 * 24 * 60 * 60 * 1000),
    };
    // (B1, v3) Red de seguridad exclusivamente contra un volumen anormal
    // en la ventana de 3 días -- NO el tope operativo de 200, que se
    // aplica después, sobre las filas ya filtradas exactamente (capa 2).
    const safetyLimit = RESERVATIONS_MAX_LIMIT * 5;

    const candidates = await this.reservationRepository.getPendingAssignmentByCategory(
      categoryId, todayWindow, safetyLimit,
    );

    // Capa 2 (JS, exacta) — la MISMA función que ya usa J1-TZ, sin
    // reimplementar la lógica de marca-vs-instante.
    const filtered = candidates.filter(
      (r) => deriveCalendarDate(r.startTime, businessProfile.timezone) === todayBusinessDate,
    );

    const totalPending = filtered.length;
    const processed = Math.min(totalPending, RESERVATIONS_MAX_LIMIT);
    const pendingList = filtered.slice(0, processed);

    // (B1, v3) truncated: por conteo real, O porque la capa SQL alcanzó su
    // propio tope de seguridad (caso degenerado, no el camino normal —
    // honest-degradation, se loguea, nunca se ignora en silencio).
    const sqlSafetyLimitReached = candidates.length >= safetyLimit;
    if (sqlSafetyLimitReached) {
      logger.error(
        { categoryId, safetyLimit },
        'auto-assign-all: la ventana SQL de 3 días alcanzó el LIMIT de seguridad -- volumen anormal para una categoría, revisar.',
      );
    }
    const truncated = totalPending > processed || sqlSafetyLimitReached;

    const items: AutoAssignAllItemResult[] = [];
    let confirmedSameResource = 0;
    let reassigned = 0;
    let skippedAlreadyAssigned = 0;
    let failed = 0;

    for (const queuedReservation of pendingList) {   // SECUENCIAL, nunca Promise.all -- ver §4.1
      try {
        // Paso A — optimista, fuera de la transacción, barato: ¿sigue
        // disponible su PROPIA provisoria?
        const ownStillFree = await this.availability.checkAvailability(
          queuedReservation.resource.id,
          queuedReservation.startTime,
          queuedReservation.endTime,
          queuedReservation.id,
          queuedReservation.serviceId ?? undefined,
          queuedReservation.partySize,
        );

        let candidateResourceId: string;
        let outcome: 'CONFIRMED_SAME_RESOURCE' | 'REASSIGNED';

        if (ownStillFree) {
          candidateResourceId = queuedReservation.resource.id;
          outcome = 'CONFIRMED_SAME_RESOURCE';
        } else {
          // Paso B — solo si A dio false: buscar alternativa en la
          // categoría, excluyéndose a sí misma (F3-2).
          const candidate = await this.availability.findAvailableResourceInCategory(
            {
              categoryId,
              startTime: queuedReservation.startTime,
              endTime:   queuedReservation.endTime,
              ...(queuedReservation.serviceId && { serviceId: queuedReservation.serviceId }),
              partySize: queuedReservation.partySize,
            },
            queuedReservation.id,
          );
          if (!candidate) {
            // Sin candidato -- FAILED sin abrir ninguna transacción (no
            // hay nada que lockear todavía). El batch sigue con la
            // siguiente reserva.
            items.push({
              reservationId: queuedReservation.id,
              previousResourceId: queuedReservation.resource.id,
              outcome: 'FAILED',
              code: 'NO_RESOURCE_AVAILABLE',
              message: `No hay ningún recurso disponible de la categoría "${categoryId}" para la reserva "${queuedReservation.id}".`,
            });
            failed++;
            continue;
          }
          candidateResourceId = candidate.id;
          outcome = 'REASSIGNED';
        }

        let assigned!: Reservation;
        await this.transactionManager.run(async (client: SqlClient) => {
          // PRIMERA sentencia dentro de la transacción -- lockea Y valida
          // el candidato, ANTES de lockear la fila (N1). Necesario incluso
          // en la rama CONFIRMED_SAME_RESOURCE porque assignDeferred() se
          // salta su propia validación cuando isSameResource (documento
          // base, paso 4).
          //
          // (C1 del gate) -- no alcanza con lockear/validar solo
          // candidateResourceId: si la reserva tiene serviceId, ese
          // servicio puede tener resource_locks que checkAvailability()
          // SÍ valida (Paso A, arriba) pero que un chequeo acotado a un
          // solo id no cubre. Mismo patrón que updateReservation().
          const lockSet = await this.availability.resolveLockedResourceIds(
            queuedReservation.serviceId ?? undefined, candidateResourceId,
          );
          await this.availability.assertAllResourcesAvailable(
            client, [...lockSet].sort(), queuedReservation.startTime, queuedReservation.endTime,
            queuedReservation.id, queuedReservation.partySize,
          );

          assigned = await this.assignDeferred(
            client, queuedReservation.id, candidateResourceId, businessId, changedBy,
            { startTime: queuedReservation.startTime, endTime: queuedReservation.endTime },   // F3-6
          );
        });

        // (N1 del gate) recordOccupancy() en su PROPIO try/catch, fuera
        // del try que rodea la transacción -- si falla acá, la reserva YA
        // quedó ASSIGNED (commit ya ocurrió), así que reportarla FAILED
        // mentiría: una re-corrida del batch no la vuelve a ver (ya no es
        // PENDING_ASSIGNMENT). El outcome real se reporta igual, con
        // `occupancyRecorded: false` y un log de error -- una
        // reconciliación manual (mecanismo ya existente para otros casos
        // de `recordOccupancy()`) puede corregir el contador después.
        let occupancyRecorded = true;
        try {
          await this.availability.recordOccupancy(assigned);
        } catch (err) {
          occupancyRecorded = false;
          logger.error(
            { reservationId: queuedReservation.id, err },
            'auto-assign-all: recordOccupancy falló post-commit',
          );
        }

        items.push({
          reservationId: queuedReservation.id,
          previousResourceId: queuedReservation.resource.id,
          outcome,
          newResourceId: assigned.resource.id,
          ...(!occupancyRecorded && { occupancyRecorded: false }),
        });
        if (outcome === 'CONFIRMED_SAME_RESOURCE') confirmedSameResource++;
        else reassigned++;
      } catch (err) {
        // NO relanza -- sigue con la siguiente reserva del batch (§4.2).
        const item = classifyFailure(queuedReservation.id, queuedReservation.resource.id, err);
        items.push(item);
        if (item.outcome === 'SKIPPED_ALREADY_ASSIGNED') skippedAlreadyAssigned++;
        else failed++;
      }
    }

    return {
      categoryId,
      categoryName,
      totalPending,
      processed,
      truncated,
      confirmedSameResource,
      reassigned,
      skippedAlreadyAssigned,
      failed,
      items,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers privados
  // ---------------------------------------------------------------------------

  private async requireReservation(id: string): Promise<Reservation> {
    const reservation = await this.reservationRepository.getById(id);
    if (!reservation) {
      throw new ReservationNotFoundError(id);
    }
    return reservation;
  }

  /**
   * Bug 3 (25/08/2026, docs/auditoria-tecnica-infra-reservas.md) — igual
   * que requireReservation() pero con SELECT ... FOR UPDATE (dentro de una
   * transacción activa). Usar SIEMPRE que se vaya a mutar el estado de una
   * reserva (confirmar/cancelar/completar/ajustar precio) — sin esto, dos
   * transiciones concurrentes sobre la MISMA reserva (ej. el worker de
   * expiración de depósito vs. el huésped confirmando justo a tiempo, o un
   * doble-clic en "Cancelar") podían perder una transición en silencio.
   * `getByIdWithLock` es opcional en la interfaz (mismo criterio que
   * `getActiveForResourceInRangeWithLock?`) — cae a `getById()` sin lock
   * en repos que no lo implementan (in-memory, tests unitarios).
   */
  private async requireReservationWithLock(client: SqlClient, id: string): Promise<Reservation> {
    const reservation = this.reservationRepository.getByIdWithLock
      ? await this.reservationRepository.getByIdWithLock(client, id)
      : await this.reservationRepository.getById(id);
    if (!reservation) {
      throw new ReservationNotFoundError(id);
    }
    return reservation;
  }
}
