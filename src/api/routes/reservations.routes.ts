/**
 * @file reservations.routes.ts
 * @description Rutas de gestión de reservas con control de acceso por rol.
 *
 * ## Matriz de permisos
 *
 * | Operación                     | ADMIN | RECEPTIONIST | WAITER |
 * |-------------------------------|-------|--------------|--------|
 * | GET /           (listar)      | ✅    | ✅           | ✅     |
 * | GET /:id        (detalle)     | ✅    | ✅           | ✅     |
 * | GET /:id/charges              | ✅    | ✅           | ❌     |
 * | POST /          (crear)       | ✅    | ✅           | ❌     |
 * | POST /:id/confirm             | ✅    | ✅           | ❌     |
 * | POST /:id/cancel              | ✅    | ✅           | ❌     |
 * | POST /:id/complete            | ✅    | ✅           | ✅     |
 */

import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppContainer } from '../../container.js';
import { Customer } from '../../domain/entities.js';
import { ReservationNotFoundError } from '../../domain/errors.js';
import { routeParam } from '../utils/params.js';
import { UserRole } from '../../types/enums.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import { authorize } from '../../security/auth.middleware.js';
import { CreateReservationSchema } from '../schemas/request.schemas.js';

const READERS    = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;
const MANAGERS   = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;
const COMPLETERS = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;

export function createReservationsRouter(container: AppContainer): Router {
  const router = Router();

  router.get('/', authorize(READERS), async (_req, res, next) => {
    try {
      const reservations = await container.reservationRepository.getAll();
      res.json(reservations.map(toReservationDto));
    } catch (err) { next(err); }
  });

  router.get('/:id', authorize(READERS), async (req, res, next) => {
    try {
      const id = routeParam(req.params.id);
      const reservation = await container.reservationService.getReservation(id);
      if (!reservation) throw new ReservationNotFoundError(id);
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  /**
   * GET /api/reservations/:id/charges
   *
   * Devuelve todos los movimientos financieros asociados a una reserva.
   * Solo ADMIN y RECEPTIONIST pueden ver datos financieros.
   *
   * Respuestas:
   * - 200: array de FinancialTransaction (puede ser vacío si no hay cargos)
   * - 404: reserva no encontrada
   * - 503: ledger no disponible en modo in-memory
   */
  router.get('/:id/charges', authorize(MANAGERS), async (req, res, next) => {
    try {
      const id = routeParam(req.params.id);

      // Verificar que la reserva existe antes de consultar el ledger.
      const reservation = await container.reservationService.getReservation(id);
      if (!reservation) throw new ReservationNotFoundError(id);

      // En modo in-memory no hay ledger — responder con 503 descriptivo.
      if (!container.financialTransactionRepository) {
        res.status(503).json({
          code:    'LEDGER_UNAVAILABLE',
          message: 'El ledger financiero no está disponible en modo in-memory. Conectá DATABASE_URL para activarlo.',
        });
        return;
      }

      const charges = await container.financialTransactionRepository.getByReservationId(id);

      res.json(charges.map((c) => ({
        id:            c.id,
        type:          c.type,
        amount:        c.amount,
        currency:      c.currency,
        status:        c.status,
        reservationId: c.reservationId,
        customerId:    c.customerId,
        createdAt:     c.createdAt,
      })));
    } catch (err) { next(err); }
  });

  router.post('/', authorize(MANAGERS), async (req, res, next) => {
    try {
      const body = CreateReservationSchema.parse(req.body);

      const existingCustomer = await container.customerRepository.getById(body.customer.id);
      if (!existingCustomer) {
        res.status(404).json({
          code: 'CUSTOMER_NOT_FOUND',
          message: `No existe un cliente con id "${body.customer.id}"`,
        });
        return;
      }

      const reservation = await container.reservationService.createReservation({
        id: randomUUID(),
        resourceId: body.resourceId,
        customer: new Customer(
          existingCustomer.id,
          existingCustomer.fullName,
          existingCustomer.email,
        ),
        startTime: new Date(body.startTime),
        endTime:   new Date(body.endTime),
        details:   body.details as Record<string, unknown>,
      });

      res.status(201).json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  router.post('/:id/confirm', authorize(MANAGERS), async (req, res, next) => {
    try {
      const reservation = await container.reservationService.confirmReservation(
        routeParam(req.params.id),
      );
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  router.post('/:id/cancel', authorize(MANAGERS), async (req, res, next) => {
    try {
      const reservation = await container.reservationService.cancelReservation(
        routeParam(req.params.id),
      );
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  router.post('/:id/complete', authorize(COMPLETERS), async (req, res, next) => {
    try {
      const reservation = await container.reservationService.completeReservation(
        routeParam(req.params.id),
      );
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  return router;
}
