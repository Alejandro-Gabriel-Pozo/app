/**
 * @file reservation.service.ts
 * @description Servicio de dominio para gestión de reservas.
 *
 * ## Responsabilidades
 * - Orquestar la creación, confirmación, cancelación y completado de reservas.
 * - Validar disponibilidad del recurso antes de crear una reserva.
 * - Delegar la persistencia a los repositorios inyectados.
 * - Registrar ocupación en el repositorio de ocupación al confirmar o completar.
 *
 * ## Correcciones aplicadas respecto a la versión anterior
 * - `requireReservation` lanzaba `InvalidReservationError` (→ HTTP 409) cuando la
 *   reserva no existía. Ahora lanza `ReservationNotFoundError` (→ HTTP 404), que es
 *   el comportamiento semánticamente correcto.
 */

import { ResourceType } from '../types/enums.js';
import { Reservation } from '../domain/Reservation.js';
import { Customer } from '../domain/entities.js';
import { PreferenceDetailsByResource } from '../types/preferences.types.js';
import {
  InvalidReservationError,
  ResourceNotFoundError,
  ReservationNotFoundError,
} from '../domain/errors.js';
import { validatePreferences } from './validation.factory.js';
import { ReservationRepository } from '../repositories/reservation.repository.js';
import { ResourceRepository } from '../repositories/resource.repository.js';
import { OccupancyRepository } from '../repositories/occupancy.repository.js';

export class ReservationService {
  constructor(
    private readonly reservationRepository: ReservationRepository,
    private readonly resourceRepository: ResourceRepository,
    /**
     * Opcional para mantener compatibilidad con entornos sin tracking de ocupación.
     * Si no se inyecta, `confirmReservation` y `completeReservation` funcionan
     * correctamente pero no registran datos de ocupación.
     */
    private readonly occupancyRepository?: OccupancyRepository,
  ) {}

  /**
   * Crea una nueva reserva si el recurso está disponible en el rango solicitado.
   *
   * @param params - Datos de la reserva a crear
   * @returns La reserva creada en estado `PENDING`
   *
   * @throws {ResourceNotFoundError}   Si `resourceId` no existe
   * @throws {InvalidReservationError} Si el recurso no está disponible en el rango
   * @throws {ValidationError}         Si `details` no cumple el schema del tipo de recurso
   *
   * @swagger
   * /api/reservations:
   *   post:
   *     summary: Crear reserva
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       201:
   *         description: Reserva creada en estado PENDING
   *       409:
   *         description: Recurso no disponible en el rango solicitado
   *       404:
   *         description: Recurso no encontrado
   */
  async createReservation<T extends ResourceType>(params: {
    id: string;
    resourceType: T;
    resourceId: string;
    customer: Customer;
    startTime: Date;
    endTime: Date;
    details: PreferenceDetailsByResource[T];
  }): Promise<Reservation<T>> {
    const resource = await this.resourceRepository.getById(params.resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(params.resourceId);
    }

    // Validar preferencias según el tipo de recurso antes de verificar disponibilidad,
    // para que los errores de validación lleguen primero al cliente (400 antes que 409).
    const validatedDetails = validatePreferences(
      params.resourceType,
      params.details,
    );

    const activeReservations =
      await this.reservationRepository.getActiveForResourceInRange(
        params.resourceId,
        params.startTime,
        params.endTime,
      );

    const isAvailable = resource.isAvailable(
      params.startTime,
      params.endTime,
      activeReservations.map((r) => r.toSnapshot()),
    );

    if (!isAvailable) {
      throw new InvalidReservationError(
        `El recurso ${params.resourceId} no está disponible en el rango solicitado`,
      );
    }

    const reservation = new Reservation(
      params.resourceType,
      params.id,
      params.customer,
      resource,
      params.startTime,
      params.endTime,
      validatedDetails,
    );

    await this.reservationRepository.save(reservation);
    return reservation;
  }

  /**
   * Confirma una reserva existente y registra la ocupación del recurso.
   *
   * @param id - ID de la reserva a confirmar
   * @returns La reserva actualizada en estado `CONFIRMED`
   *
   * @throws {ReservationNotFoundError} Si la reserva no existe          → HTTP 404
   * @throws {InvalidReservationError}  Si la transición de estado falla  → HTTP 409
   *
   * @swagger
   * /api/reservations/{id}/confirm:
   *   post:
   *     summary: Confirmar reserva
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Reserva confirmada
   *       404:
   *         description: Reserva no encontrada
   *       409:
   *         description: Transición de estado inválida
   */
  async confirmReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.confirm();
    await this.reservationRepository.save(reservation);
    await this.recordOccupancy(reservation);
    return reservation;
  }

  /**
   * Cancela una reserva existente.
   *
   * @param id - ID de la reserva a cancelar
   * @returns La reserva actualizada en estado `CANCELLED`
   *
   * @throws {ReservationNotFoundError} Si la reserva no existe          → HTTP 404
   * @throws {InvalidReservationError}  Si la transición de estado falla  → HTTP 409
   *
   * @swagger
   * /api/reservations/{id}/cancel:
   *   post:
   *     summary: Cancelar reserva
   *     security:
   *       - BearerAuth: []
   */
  async cancelReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.cancel();
    await this.reservationRepository.save(reservation);
    return reservation;
  }

  /**
   * Completa una reserva confirmada y registra la ocupación final.
   *
   * @param id - ID de la reserva a completar
   * @returns La reserva actualizada en estado `COMPLETED`
   *
   * @throws {ReservationNotFoundError} Si la reserva no existe          → HTTP 404
   * @throws {InvalidReservationError}  Si la transición de estado falla  → HTTP 409
   *
   * @swagger
   * /api/reservations/{id}/complete:
   *   post:
   *     summary: Completar reserva
   *     security:
   *       - BearerAuth: []
   */
  async completeReservation(id: string): Promise<Reservation> {
    const reservation = await this.requireReservation(id);
    reservation.complete();
    await this.reservationRepository.save(reservation);
    await this.recordOccupancy(reservation);
    return reservation;
  }

  /**
   * Verifica si un recurso está disponible en un rango de tiempo dado.
   *
   * @param resourceId           - ID del recurso a consultar
   * @param startTime            - Inicio del rango
   * @param endTime              - Fin del rango
   * @param excludeReservationId - ID de reserva a ignorar (útil al modificar una reserva)
   * @returns `true` si el recurso está libre en el rango
   *
   * @throws {ResourceNotFoundError} Si el recurso no existe
   */
  async checkAvailability(
    resourceId: string,
    startTime: Date,
    endTime: Date,
    excludeReservationId?: string,
  ): Promise<boolean> {
    const resource = await this.resourceRepository.getById(resourceId);
    if (!resource) {
      throw new ResourceNotFoundError(resourceId);
    }

    const activeReservations =
      await this.reservationRepository.getActiveForResourceInRange(
        resourceId,
        startTime,
        endTime,
      );

    return resource.isAvailable(
      startTime,
      endTime,
      activeReservations.map((r) => r.toSnapshot()),
      excludeReservationId,
    );
  }

  /**
   * Obtiene una reserva por su ID.
   *
   * @param id - ID de la reserva
   * @returns La reserva si existe, `undefined` en caso contrario
   */
  async getReservation(id: string): Promise<Reservation | undefined> {
    return this.reservationRepository.getById(id);
  }

  // ---------------------------------------------------------------------------
  // Métodos privados
  // ---------------------------------------------------------------------------

  /**
   * Obtiene una reserva o lanza `ReservationNotFoundError` si no existe.
   *
   * ## FIX: error semántico corregido
   * La versión anterior lanzaba `InvalidReservationError` (código `INVALID_RESERVATION`),
   * que el error handler mapeaba a HTTP 409 (Conflict). Una reserva inexistente debe
   * retornar HTTP 404 (Not Found), de ahí el cambio a `ReservationNotFoundError`.
   *
   * @param id - ID de la reserva requerida
   * @throws {ReservationNotFoundError} Si no existe → HTTP 404
   */
  private async requireReservation(id: string): Promise<Reservation> {
    const reservation = await this.reservationRepository.getById(id);
    if (!reservation) {
      // ✅ CORREGIDO: era `InvalidReservationError` → HTTP 409
      //              ahora es `ReservationNotFoundError` → HTTP 404
      throw new ReservationNotFoundError(id);
    }
    return reservation;
  }

  /**
   * Registra ocupación en el repositorio correspondiente.
   * No-op si `occupancyRepository` no fue inyectado.
   *
   * @param reservation - Reserva cuya ocupación se va a registrar
   */
  private async recordOccupancy(reservation: Reservation): Promise<void> {
    if (!this.occupancyRepository) {
      return;
    }

    await this.occupancyRepository.recordReservation(
      reservation.resource.id,
      reservation.resource.name,
      reservation.startTime,
      reservation.endTime,
      reservation.status,
    );
  }
}
