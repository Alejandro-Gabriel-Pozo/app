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
import type { BusinessProfileRepository } from '../repositories/business-profile.repository.js';
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

export class MaintenanceWindowService {
  constructor(
    private readonly maintenanceWindowRepository: MaintenanceWindowRepository,
    private readonly resourceRepository: Pick<ResourceRepository, 'getById'>,
    private readonly reservationRepository: Pick<ReservationRepository, 'getActiveForResourceInRange'>,
    private readonly businessProfileRepository: Pick<BusinessProfileRepository, 'get'>,
  ) {}

  /**
   * Decisión confirmada con el dueño (AskUserQuestion, 24/08/2026): no se
   * puede abrir la ventana si hay una reserva CONFIRMED/PENDING que caiga
   * dentro de sus fechas — fuerza a resolverla primero (reasignar o
   * cancelar) en vez de dejar la reserva y la ventana en un estado
   * ambiguo. Ventana ABIERTA (sin `endDate`): se chequea contra un
   * horizonte lejano (10 años) como "unbounded" práctico — cualquier
   * reserva futura sobre un recurso que se saca de servicio indefinidamente
   * es un conflicto real, sin importar cuán lejos esté.
   */
  async createWindow(input: CreateMaintenanceWindowInput): Promise<MaintenanceWindow> {
    const resource = await this.resourceRepository.getById(input.resourceId);
    if (!resource) throw new ResourceNotFoundError(input.resourceId);

    const profile = await this.businessProfileRepository.get();
    const rangeStart = combineDateAndTime(new Date(input.startDate), '00:00:00', profile.timezone);
    const rangeEnd = input.endDate
      ? combineDateAndTime(new Date(input.endDate), '23:59:59', profile.timezone)
      : DateTime.fromJSDate(rangeStart).plus({ years: 10 }).toJSDate();

    const conflicting = await this.reservationRepository.getActiveForResourceInRange(
      input.resourceId,
      rangeStart,
      rangeEnd,
    );
    if (conflicting.length > 0) {
      throw new MaintenanceWindowConflictError(input.resourceId, conflicting.map((r) => r.id));
    }

    const window = MaintenanceWindow.create({
      businessId: input.businessId,
      resourceId: input.resourceId,
      startDate: input.startDate,
      endDate: input.endDate ?? null,
      reason: input.reason ?? null,
      createdBy: input.createdBy,
    });
    await this.maintenanceWindowRepository.save(window);
    return window;
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
