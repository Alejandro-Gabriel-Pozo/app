/**
 * @file maintenance-window.service.ts
 * @description Caso de uso de ventanas de mantenimiento (24/08/2026,
 * docs/diseno-housekeeping-ventana-mantenimiento-2026-08-24.md). El
 * bloqueo de disponibilidad en sí vive en
 * `ReservationAvailabilityService.evaluateMaintenanceWindows()` — este
 * servicio es el CRUD (crear/cerrar/listar) que usan las rutas.
 */

import { DateTime } from 'luxon';
import { MaintenanceWindow } from './maintenance-window.js';
import type { MaintenanceWindowRepository } from './maintenance-window.repository.js';
import type { ResourceRepository } from '../reservas/resource.repository.js';
import type { ReservationRepository } from '../reservas/reservation.repository.js';
import type { Reservation } from '../reservas/Reservation.js';
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
import type { BusinessProfile } from '../domain/business-profile.entities.js';
import type { TransactionManager } from '../db/transaction-manager.js';
import type { SqlClient } from '../repositories/sql.client.js';
import { ResourceNotFoundError, MaintenanceWindowConflictError, MaintenanceWindowNotFoundError } from '../domain/errors.js';
import { combineDateAndTime } from '../reservas/reservation-time.utils.js';

export interface CreateMaintenanceWindowInput {
  businessId: string;
  resourceId: string;
  /** 'YYYY-MM-DD'. */
  startDate: string;
  /** 'YYYY-MM-DD', opcional — sin esto, la ventana queda ABIERTA ("hasta nuevo aviso"). */
  endDate?: string | null;
  reason?: string | null;
  createdBy: string;
}

/**
 * D-03 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §6).
 */
export interface CreateMaintenanceWindowResult {
  window: MaintenanceWindow;
  /**
   * Reservas CONFIRMED/PENDING que caían en el tramo incierto (más allá
   * del horizonte configurado) de una ventana ABIERTA nueva — no
   * bloquearon el alta, pero quedaron `needsMaintenanceReview = true`.
   * Vacío en el caso normal (ventana con `endDate`, o sin ninguna reserva
   * más allá del horizonte).
   */
  needsReviewReservationIds: string[];
}

export class MaintenanceWindowService {
  constructor(
    private readonly maintenanceWindowRepository: MaintenanceWindowRepository,
    private readonly resourceRepository: Pick<ResourceRepository, 'getById'>,
    private readonly reservationRepository: Pick<ReservationRepository, 'getActiveForResourceInRange' | 'saveWithClient'>,
    private readonly businessProfileRepository: Pick<BusinessProfileRepository, 'get'>,
    /**
     * D-03 (15/09/2026) — el INSERT de la ventana y el UPDATE de
     * `needs_maintenance_review` sobre N reservas del tramo incierto son
     * una sola operación atómica (atomic-state-mutation). Wireado desde
     * `app.ts` con `buildTenantTransactionManager(req)`, mismo criterio
     * que `StayService`/`AccountsReceivableService` (Bug 5, 11/09/2026).
     */
    private readonly transactionManager: TransactionManager,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * D-03 (15/09/2026, docs/decisiones-auditoria-fase2-2026-09-15.md §6,
   * grounding ERP — 5 de 6 sistemas de referencia coinciden) — reemplaza
   * el horizonte fijo de 10 años por `business_profile.maintenance_horizon_days`,
   * partiendo el rango evaluado de una ventana ABIERTA (`endDate == null`)
   * en dos tramos:
   *
   * - **Tramo cierto** — `[startDate, min(endDate, hoy + horizonte)]`
   *   (para una ventana con `endDate`, es el rango completo — el horizonte
   *   NO aplica ahí, ver comentario más abajo). Una reserva CONFIRMED/
   *   PENDING acá sigue bloqueando el alta (`MaintenanceWindowConflictError`),
   *   igual que antes de este cambio — fuerza a resolverla primero
   *   (reasignar o cancelar).
   * - **Tramo incierto** — solo existe para `endDate == null`, es todo lo
   *   que queda más allá de `hoy + horizonte`. Una reserva ahí YA NO
   *   bloquea: la ventana se crea igual, la reserva queda
   *   `needsMaintenanceReview = true` (`Reservation.markNeedsMaintenanceReview()`)
   *   y su id viaja en `needsReviewReservationIds` de la respuesta.
   *
   * El horizonte NUNCA se aplica a una ventana con `endDate` fijo —
   * aplicarlo ahí sería una regresión real: dejaría pasar sin bloquear ni
   * marcar una reserva DENTRO del rango acotado, contradiciendo a
   * `ReservationAvailabilityService.evaluateMaintenanceWindows()`
   * (reservation-availability.service.ts:90-98), que tampoco usa horizonte
   * para ventanas con fin fijo.
   */
  async createWindow(input: CreateMaintenanceWindowInput): Promise<CreateMaintenanceWindowResult> {
    const resource = await this.resourceRepository.getById(input.resourceId);
    if (!resource) throw new ResourceNotFoundError(input.resourceId);

    const profile = await this.businessProfileRepository.get();
    const rangeStart = combineDateAndTime(new Date(input.startDate), '00:00:00', profile.timezone);
    const isOpenEnded = input.endDate == null;

    let toFlag: Reservation[] = [];

    if (!isOpenEnded) {
      // Ventana CON fecha de fin -- sin horizonte, rango completo tal cual
      // se evaluaba antes de este cambio. Sin tramo incierto: nada que
      // marcar para revisión.
      const rangeEnd = combineDateAndTime(new Date(input.endDate as string), '23:59:59', profile.timezone);
      const conflicting = await this.reservationRepository.getActiveForResourceInRange(
        input.resourceId, rangeStart, rangeEnd,
      );
      if (conflicting.length > 0) {
        throw new MaintenanceWindowConflictError(input.resourceId, conflicting.map((r) => r.id));
      }
    } else {
      // Techo práctico para la query del tramo incierto -- no hay un
      // límite de negocio real ("hasta nuevo aviso" es indefinido), pero
      // getActiveForResourceInRange() necesita un Date concreto. Ya NO
      // decide bloqueo (eso lo hace el horizonte de abajo), solo acota la
      // búsqueda de reservas a marcar -- mismo valor "unbounded" práctico
      // que usaba este método completo antes de D-03.
      const practicalInfinity = DateTime.fromJSDate(rangeStart).plus({ years: 10 }).toJSDate();
      const horizonEnd = this.resolveHorizonEndInstant(profile);

      if (horizonEnd.getTime() >= rangeStart.getTime()) {
        // La ventana empieza dentro del horizonte -- hay tramo cierto real.
        const certainConflicts = await this.reservationRepository.getActiveForResourceInRange(
          input.resourceId, rangeStart, horizonEnd,
        );
        if (certainConflicts.length > 0) {
          throw new MaintenanceWindowConflictError(input.resourceId, certainConflicts.map((r) => r.id));
        }

        const uncertainStart = new Date(horizonEnd.getTime() + 1000);
        if (uncertainStart.getTime() <= practicalInfinity.getTime()) {
          toFlag = await this.reservationRepository.getActiveForResourceInRange(
            input.resourceId, uncertainStart, practicalInfinity,
          );
        }
      } else {
        // La ventana arranca MÁS ALLÁ del horizonte ya de entrada -- todo
        // el rango pedido es tramo incierto, no hay tramo cierto que
        // bloquee nada.
        toFlag = await this.reservationRepository.getActiveForResourceInRange(
          input.resourceId, rangeStart, practicalInfinity,
        );
      }
    }

    const window = MaintenanceWindow.create({
      businessId: input.businessId,
      resourceId: input.resourceId,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      reason: input.reason ?? null,
      createdBy: input.createdBy,
    });

    // atomic-state-mutation: el INSERT de la ventana y el UPDATE de
    // needs_maintenance_review de cada reserva del tramo incierto son una
    // sola operación lógica -- si cualquiera falla, ninguna queda creada.
    await this.transactionManager.run(async (client: SqlClient) => {
      await this.maintenanceWindowRepository.saveWithClient(client, window);
      for (const reservation of toFlag) {
        reservation.markNeedsMaintenanceReview();
        await this.reservationRepository.saveWithClient(client, reservation);
      }
    });

    return { window, needsReviewReservationIds: toFlag.map((r) => r.id) };
  }

  /**
   * `hoy + maintenanceHorizonDays`, fin del día de negocio (23:59:59) en
   * el huso del negocio -- mismo cálculo que
   * `ReservationAvailabilityService.evaluateMaintenanceWindows()`. Usa
   * `this.now()` (inyectable, default `new Date()`) en vez de
   * `DateTime.now()` directo -- mismo patrón que `ReservationService.now`
   * -- para que los tests puedan fijar "hoy" y verificar el borde del
   * horizonte de forma determinística.
   */
  private resolveHorizonEndInstant(profile: BusinessProfile): Date {
    const today = DateTime.fromJSDate(this.now()).setZone(profile.timezone).toISODate()!;
    return combineDateAndTime(
      DateTime.fromISO(today, { zone: profile.timezone }).plus({ days: profile.maintenanceHorizonDays }).toJSDate(),
      '23:59:59',
      profile.timezone,
    );
  }

  /** Cierra la ventana — única forma de liberar el recurso. `closeDate` default: hoy (fecha de negocio). */
  async closeWindow(id: string, businessId: string, closedBy: string, closeDate?: string): Promise<MaintenanceWindow> {
    const window = await this.maintenanceWindowRepository.findById(id, businessId);
    if (!window) throw new MaintenanceWindowNotFoundError(id);

    const profile = await this.businessProfileRepository.get();
    const today = DateTime.now().setZone(profile.timezone).toISODate()!;

    window.close(closedBy, closeDate ?? today);
    await this.maintenanceWindowRepository.update(window);
    return window;
  }

  async listByResource(resourceId: string, businessId: string): Promise<MaintenanceWindow[]> {
    return this.maintenanceWindowRepository.findByResource(resourceId, businessId);
  }

  /** Ventanas todavía relevantes (abiertas o con fin futuro) del negocio — pantalla de gestión. */
  async listActive(businessId: string): Promise<MaintenanceWindow[]> {
    const profile = await this.businessProfileRepository.get();
    const today = DateTime.now().setZone(profile.timezone).toISODate()!;
    return this.maintenanceWindowRepository.findAllActive(businessId, today);
  }
}
