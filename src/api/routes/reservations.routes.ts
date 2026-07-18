/**
 * @file reservations.routes.ts
 * @description Rutas de gestión de reservas con control de acceso por rol.
 *
 * ## Aislamiento multi-tenant
 * Cada handler construye sus repositorios y ReservationService con req.db
 * (SqlClient inyectado por tenantMiddleware). El TransactionManager es
 * stateless y se reutiliza del container global.
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
import { SqlResourceRepository }    from '../../repositories/sql.resource.repository.js';
import { SqlReservationRepository } from '../../repositories/sql.reservation.repository.js';
import { SqlCustomerRepository }    from '../../repositories/sql.customer.repository.js';
import { SqlOccupancyRepository }   from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }    from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository } from '../../repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from '../../repositories/sql.financial-transaction.repository.js';
import { ReservationService }       from '../../services/reservation.service.js';

const READERS    = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;
const MANAGERS   = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;
const COMPLETERS = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;

/** Construye todos los repositorios y el servicio usando req.db del tenant. */
function buildService(req: Request, container: AppContainer): {
  reservationService: ReservationService;
  reservationRepo: SqlReservationRepository;
  customerRepo: SqlCustomerRepository;
  financialRepo: SqlFinancialTransactionRepository;
} {
  const resourceRepo    = new SqlResourceRepository(req.db);
  const reservationRepo = new SqlReservationRepository(req.db, resourceRepo);
  const customerRepo    = new SqlCustomerRepository(req.db);
  const occupancyRepo   = new SqlOccupancyRepository(req.db);
  const categoryRepo    = new SqlCategoryRepository(req.db);
  const domainEventRepo = new SqlDomainEventRepository(req.db);
  const financialRepo   = new SqlFinancialTransactionRepository(req.db);

  const reservationService = new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    container.transactionManager,
  );

  return { reservationService, reservationRepo, customerRepo, financialRepo };
}

export function createReservationsRouter(container: AppContainer): Router {
  const router = Router();

  router.get('/', authorize(READERS), async (req, res, next) => {
    try {
      const { reservationRepo } = buildService(req, container);
      const reservations = await reservationRepo.getAll();
      res.json(reservations.map(toReservationDto));
    } catch (err) { next(err); }
  });

  router.get('/:id', authorize(READERS), async (req, res, next) => {
    try {
      const id = routeParam(req.params.id);
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.getReservation(id);
      if (!reservation) throw new ReservationNotFoundError(id);
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  router.get('/:id/charges', authorize(MANAGERS), async (req, res, next) => {
    try {
      const id = routeParam(req.params.id);
      const { reservationService, financialRepo } = buildService(req, container);

      const reservation = await reservationService.getReservation(id);
      if (!reservation) throw new ReservationNotFoundError(id);

      const charges = await financialRepo.getByReservationId(id);

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
      const { reservationService, customerRepo } = buildService(req, container);

      const existingCustomer = await customerRepo.getById(body.customer.id);
      if (!existingCustomer) {
        res.status(404).json({
          code: 'CUSTOMER_NOT_FOUND',
          message: `No existe un cliente con id "${body.customer.id}"`,
        });
        return;
      }

      const reservation = await reservationService.createReservation({
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
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.confirmReservation(
        routeParam(req.params.id),
      );
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  router.post('/:id/cancel', authorize(MANAGERS), async (req, res, next) => {
    try {
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.cancelReservation(
        routeParam(req.params.id),
      );
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  router.post('/:id/complete', authorize(COMPLETERS), async (req, res, next) => {
    try {
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.completeReservation(
        routeParam(req.params.id),
      );
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  return router;
}
