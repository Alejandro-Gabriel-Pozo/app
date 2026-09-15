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
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
  NoPriceAdjustmentPendingError,
  DepositNotPaidError,
  LodgingRequiresServiceError,
  ReservationChargeInvoicedError,
} from '../domain/errors.js';
import type { InvoiceRepository, InvoiceLinkage } from '../facturacion/invoice.repository.js';
import { BookableServiceNotFoundError } from './bookable-service.service.js';
import type { ReservationLine } from './reservation.types.js';
import { validateDetailsAgainstFields } from './category.service.js';
import type { ReservationRepository }        from './reservation.repository.js';
import type { ResourceRepository }           from './resource.repository.js';
import type { OccupancyRepository }          from './occupancy.repository.js';
import type { ICategoryRepository }          from './category.repository.js';
import type { DomainEventRepository }        from '../repositories/domain-event.repository.js';
import type { AuditLogRepository }           from '../repositories/audit-log.repository.js';
import { auditReservationTransition }        from './reservation-audit.js';
import type { IResourceLockRepository }      from './resource-lock.repository.js';
import type { IBookableServiceRepository } from './bookable-service.repository.js';
import type { ICustomerRateRepository } from '../clientes-finanzas/customer-rate.repository.js';
import type { IOperatingHoursRepository } from '../platform/operating-hours.repository.js';
import type { MaintenanceWindowRepository } from '../pms-estadias/maintenance-window.repository.js';
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
import { resolveEndTime } from './reservation-time.utils.js';

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

    // J1 (23/08/2026, pendientes-2026-08-23.md) — no puede vivir en el
    // constructor de Reservation: Reservation.restore() comparte el mismo
    // constructor y reconstruye reservas históricas leídas de la base
    // (prácticamente todas, su startTime ya "pasó" con solo el paso del
    // tiempo). El guard va acá, en el caso de uso de ALTA.
    if (params.startTime.getTime() < this.now().getTime() - PAST_START_TOLERANCE_MS) {
      throw new InvalidReservationError('No se puede crear una reserva con fecha/hora de inicio en el pasado.');
    }

    const category = await this.categoryRepository.findById(resource.categoryId);
    if (category) {
      validateDetailsAgainstFields(params.details, category.fields);
    }

    // Se busca una sola vez y se reusa para resolveEndTime Y resolvePrice —
    // antes resolveEndTime la buscaba por su cuenta, y hoy además hace falta
    // para cotizar la reserva.
    const service = params.serviceId
      ? await this.bookableServiceRepository.findById(params.serviceId)
      : null;

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
    const businessProfile = await this.businessProfileRepository.get();
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
      });

      await this.reservationRepository.saveWithClient(client, reservation);
    });

    return reservation;
  }

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
  ): Promise<Reservation> {
    const existing = await this.requireReservation(id);

    // Calendario de PMS (18/08/2026) — drag-to-move/resize necesita poder
    // editar una reserva CONFIRMED, no solo PENDING (mover una reserva ya
    // confirmada de habitación/fecha es el caso de uso principal del
    // tape-chart). Sigue bloqueado para CANCELLED/COMPLETED (A6.4, estados
    // terminales no se reabren). totalPrice/lines quedan congelados igual
    // que antes — este cambio no toca esa decisión ya tomada.
    if (existing.status !== 'PENDING' && existing.status !== 'CONFIRMED') {
      throw new InvalidReservationError(
        `Solo se pueden modificar reservas en estado PENDING o CONFIRMED. Estado actual: ${existing.status}`,
      );
    }

    if (
      !changes.startTime && !changes.endTime && !changes.details && !changes.resourceId
      && changes.adultos === undefined && changes.ninos === undefined && changes.ratePlanId === undefined
    ) {
      throw new InvalidReservationError(
        'Debés enviar al menos un campo para modificar: startTime, endTime, details, resourceId, adultos, ninos o ratePlanId',
      );
    }

    const newStartTime = changes.startTime ?? existing.startTime;
    const newEndTime   = changes.endTime   ?? existing.endTime;

    // J1 (23/08/2026, pendientes-2026-08-23.md) — solo dispara cuando se
    // está moviendo el inicio (drag-to-move del calendario); editar otros
    // campos de una reserva vieja sigue permitido, no se toca acá.
    // Confirmado con el dueño: mover una reserva al pasado se bloquea
    // igual que crearla en el pasado.
    if (
      changes.startTime !== undefined
      && newStartTime.getTime() < this.now().getTime() - PAST_START_TOLERANCE_MS
    ) {
      throw new InvalidReservationError('No se puede mover una reserva a una fecha/hora de inicio en el pasado.');
    }
    const rawDetails   = changes.details   ?? (existing.details as Record<string, unknown>);
    const newRatePlanId = changes.ratePlanId !== undefined ? changes.ratePlanId : existing.ratePlanId;
    const newAdultos   = changes.adultos !== undefined ? changes.adultos : existing.adultos;
    const newNinos     = changes.ninos   !== undefined ? changes.ninos   : existing.ninos;

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

    let updated!: Reservation;

    await this.transactionManager.run(async (client: SqlClient) => {
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
      });

      await this.reservationRepository.saveWithClient(client, updated);
    });

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

  async completeReservation(id: string, businessId: string, changedBy: string): Promise<Reservation> {
    if (!businessId) throw new Error('businessId es obligatorio en completeReservation');
    if (!changedBy) throw new Error('changedBy es obligatorio en completeReservation (A6.5)');

    let reservation!: Reservation;

    // Bug 3 (25/08/2026) — mismo criterio que cancelReservation()/
    // confirmReservation(), ver docblock de arriba.
    await this.transactionManager.run(async (client: SqlClient) => {
      reservation = await this.requireReservationWithLock(client, id);
      const previousStatus = reservation.status;
      reservation.complete();

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
