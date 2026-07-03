/**
 * @file reservations.routes.ts
 * @description Rutas de gestión de reservas con control de acceso por rol.
 *
 * ## Matriz de permisos
 *
 * | Operación                  | ADMIN | RECEPTIONIST | WAITER |
 * |----------------------------|-------|--------------|--------|
 * | GET /           (listar)   | ✅    | ✅           | ✅     |
 * | GET /:id        (detalle)  | ✅    | ✅           | ✅     |
 * | POST /          (crear)    | ✅    | ✅           | ❌     |
 * | POST /:id/confirm          | ✅    | ✅           | ❌     |
 * | POST /:id/cancel           | ✅    | ✅           | ❌     |
 * | POST /:id/complete         | ✅    | ✅           | ✅     |
 *
 * ## Justificación de diseño
 *
 * - **WAITER puede completar**: el mesero es quien marca la mesa como libre
 *   al final del servicio, pero no puede crear ni cancelar reservas.
 * - **WAITER no puede crear**: evita reservas fantasma creadas desde sala.
 * - `authenticate()` ya corrió en `app.ts`, así que `req.user` siempre existe
 *   cuando llegamos aquí. `authorize()` solo comprueba el rol.
 *
 * ## Integridad del cliente en POST /
 * El body incluye `customer.id`. Se valida contra `customerRepository` antes
 * de crear la reserva para evitar reservas huérfanas (asignadas a un ID
 * ficticio que no corresponde a ningún cliente registrado).
 */
 
import { Router, Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { AppContainer } from '../../container.js';
import { Customer } from '../../domain/entities.js';
import { ReservationNotFoundError } from '../../domain/errors.js';
import { routeParam } from '../utils/params.js';
import { ResourceType, UserRole } from '../../types/enums.js';
import { PreferenceDetailsByResource } from '../../types/preferences.types.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import { authorize } from '../../security/auth.middleware.js';
import {
  CreateReservationSchema,
  validateDetailsForType,
} from '../schemas/request.schemas.js';
 
/** Roles que pueden leer reservas — todos los autenticados */
const READERS = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;
 
/** Roles que pueden crear, confirmar o cancelar reservas */
const MANAGERS = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;
 
/** Roles que pueden completar reservas (incluye WAITER para el cierre de mesa) */
const COMPLETERS = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;
 
export function createReservationsRouter(container: AppContainer): Router {
  const router = Router();
 
  /**
   * @swagger
   * /api/reservations:
   *   get:
   *     summary: Listar todas las reservas
   *     tags: [Reservations]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Lista de reservas
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/ReservationResponse'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   */
  router.get(
    '/',
    authorize(READERS),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const reservations = await container.reservationRepository.getAll();
        res.json(reservations.map(toReservationDto));
      } catch (err) {
        next(err);
      }
    },
  );
 
  /**
   * @swagger
   * /api/reservations/{id}:
   *   get:
   *     summary: Obtener detalle de una reserva
   *     tags: [Reservations]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Reserva encontrada
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/ReservationResponse'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       404:
   *         $ref: '#/components/responses/NotFound'
   */
  router.get(
    '/:id',
    authorize(READERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = routeParam(req.params.id);
        const reservation = await container.reservationService.getReservation(id);
        if (!reservation) {
          throw new ReservationNotFoundError(id);
        }
        res.json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );
 
  /**
   * @swagger
   * /api/reservations:
   *   post:
   *     summary: Crear una nueva reserva
   *     description: >
   *       `customer.id` debe corresponder a un cliente registrado en la BD.
   *       Si el ID no existe, se retorna 404 con código `CUSTOMER_NOT_FOUND`.
   *     tags: [Reservations]
   *     security:
   *       - BearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateReservation'
   *     responses:
   *       201:
   *         description: Reserva creada en estado PENDING
   *       400:
   *         $ref: '#/components/responses/ValidationError'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       404:
   *         description: Cliente no encontrado (customer.id inválido)
   *       409:
   *         description: Recurso no disponible en el rango solicitado
   */
  router.post(
    '/',
    authorize(MANAGERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = CreateReservationSchema.parse(req.body);
        validateDetailsForType(body.resourceType, body.details);

        // Validar que el cliente exista en la BD antes de crear la reserva.
        // Evita reservas huérfanas asignadas a IDs ficticios que nunca
        // aparecerían en /customer/me/reservations del cliente real.
        const existingCustomer = await container.customerRepository.getById(
          body.customer.id,
        );
        if (!existingCustomer) {
          res.status(404).json({
            code: 'CUSTOMER_NOT_FOUND',
            message: `No existe un cliente con id "${body.customer.id}"`,
          });
          return;
        }
 
        const reservation = await container.reservationService.createReservation({
          id: randomUUID(),
          resourceType: body.resourceType,
          resourceId: body.resourceId,
          customer: new Customer(
            existingCustomer.id,
            existingCustomer.fullName,
            existingCustomer.email,
          ),
          startTime: new Date(body.startTime),
          endTime: new Date(body.endTime),
          details: body.details as PreferenceDetailsByResource[ResourceType],
        });
 
        res.status(201).json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );
 
  /**
   * @swagger
   * /api/reservations/{id}/confirm:
   *   post:
   *     summary: Confirmar una reserva (PENDING → CONFIRMED)
   *     tags: [Reservations]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Reserva confirmada
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       404:
   *         $ref: '#/components/responses/NotFound'
   *       409:
   *         description: Transición de estado inválida
   */
  router.post(
    '/:id/confirm',
    authorize(MANAGERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = routeParam(req.params.id);
        const reservation = await container.reservationService.confirmReservation(id);
        res.json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );
 
  /**
   * @swagger
   * /api/reservations/{id}/cancel:
   *   post:
   *     summary: Cancelar una reserva
   *     tags: [Reservations]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Reserva cancelada
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       404:
   *         $ref: '#/components/responses/NotFound'
   */
  router.post(
    '/:id/cancel',
    authorize(MANAGERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = routeParam(req.params.id);
        const reservation = await container.reservationService.cancelReservation(id);
        res.json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );
 
  /**
   * @swagger
   * /api/reservations/{id}/complete:
   *   post:
   *     summary: Completar una reserva (CONFIRMED → COMPLETED)
   *     description: >
   *       Disponible también para WAITER: el mesero marca la mesa como libre
   *       al finalizar el servicio.
   *     tags: [Reservations]
   *     security:
   *       - BearerAuth: []
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Reserva completada
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       403:
   *         $ref: '#/components/responses/Forbidden'
   *       404:
   *         $ref: '#/components/responses/NotFound'
   */
  router.post(
    '/:id/complete',
    authorize(COMPLETERS),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const id = routeParam(req.params.id);
        const reservation = await container.reservationService.completeReservation(id);
        res.json(toReservationDto(reservation));
      } catch (err) {
        next(err);
      }
    },
  );
 
  return router;
}
 
