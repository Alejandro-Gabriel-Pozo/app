/**
 * @file reservations.routes.ts
 * @description Rutas de gestión de reservas con control de acceso por rol.
 *
 * ## GET / — Filtros + Paginación
 * Acepta: status, resourceId, customerId, from, to, page, limit.
 * Responde: { data, total, page, limit, totalPages }
 * getFiltered() y countFiltered() corren en paralelo (Promise.all).
 *
 * ## PATCH /:id
 * Modifica una reserva PENDING. Body: { startTime?, endTime?, details? }
 *
 * ## Nota: exactOptionalPropertyTypes
 * El tsconfig usa exactOptionalPropertyTypes: true.
 * compact() elimina las claves con valor undefined antes de armar
 * los objetos de filtro/update, evitando TS2379.
 */

import { Router, Request } from 'express';
import { randomUUID } from 'node:crypto';
import { AppContainer } from '../../container.js';
import { Customer } from '../../domain/entities.js';
import { ReservationNotFoundError } from '../../domain/errors.js';
import { routeParam } from '../utils/params.js';
import { UserRole } from '../../types/enums.js';
import { toReservationDto } from '../mappers/reservation.mapper.js';
import { authorize } from '../../security/auth.middleware.js';
import {
  CreateReservationSchema,
  UpdateReservationSchema,
  ReservationListQuerySchema,
} from '../schemas/request.schemas.js';
import { SqlResourceRepository }            from '../../repositories/sql.resource.repository.js';
import { SqlReservationRepository }         from '../../repositories/sql.reservation.repository.js';
import { SqlCustomerRepository }            from '../../repositories/sql.customer.repository.js';
import { SqlOccupancyRepository }           from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }            from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository }         from '../../repositories/sql.domain-event.repository.js';
import { SqlFinancialTransactionRepository } from '../../repositories/sql.financial-transaction.repository.js';
import { ReservationService }               from '../../services/reservation.service.js';

const READERS    = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;
const MANAGERS   = [UserRole.ADMIN, UserRole.RECEPTIONIST] as const;
const COMPLETERS = [UserRole.ADMIN, UserRole.RECEPTIONIST, UserRole.WAITER] as const;

/**
 * Elimina las propiedades cuyo valor es `undefined`.
 * Necesario para respetar exactOptionalPropertyTypes: true — pasar
 * { key: undefined } es distinto a omitir la clave por completo.
 */
function compact<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

function buildService(req: Request, container: AppContainer) {
  const db = req.db!;
  const resourceRepo    = new SqlResourceRepository(db);
  const reservationRepo = new SqlReservationRepository(db, resourceRepo);
  const customerRepo    = new SqlCustomerRepository(db);
  const occupancyRepo   = new SqlOccupancyRepository(db);
  const categoryRepo    = new SqlCategoryRepository(db);
  const domainEventRepo = new SqlDomainEventRepository(db);
  const financialRepo   = new SqlFinancialTransactionRepository(db);
  const reservationService = new ReservationService(
    reservationRepo, resourceRepo, occupancyRepo, categoryRepo, domainEventRepo, container.transactionManager,
  );
  return { reservationService, reservationRepo, customerRepo, financialRepo };
}

export function createReservationsRouter(container: AppContainer): Router {
  const router = Router();

  // GET / — lista paginada con filtros opcionales
  router.get('/', authorize(READERS), async (req, res, next) => {
    try {
      const parsed = ReservationListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({
          code:   'VALIDATION_ERROR',
          errors: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
        return;
      }
      const { status, resourceId, customerId, from, to, page, limit } = parsed.data;
      const { reservationRepo } = buildService(req, container);

      // compact() garantiza que no se pasen claves con valor undefined
      // (requerido por exactOptionalPropertyTypes: true)
      const filters = compact({
        status,
        resourceId,
        customerId,
        from: from ? new Date(from) : undefined,
        to:   to   ? new Date(to)   : undefined,
      });

      const [reservations, total] = await Promise.all([
        reservationRepo.getFiltered({ ...filters, page, limit }),
        reservationRepo.countFiltered(filters),
      ]);
      res.json({
        data:       reservations.map(toReservationDto),
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      });
    } catch (err) { next(err); }
  });

  // GET /:id
  router.get('/:id', authorize(READERS), async (req, res, next) => {
    try {
      const id = routeParam(req.params.id);
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.getReservation(id);
      if (!reservation) throw new ReservationNotFoundError(id);
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  // GET /:id/charges
  router.get('/:id/charges', authorize(MANAGERS), async (req, res, next) => {
    try {
      const id = routeParam(req.params.id);
      const { reservationService, financialRepo } = buildService(req, container);
      const reservation = await reservationService.getReservation(id);
      if (!reservation) throw new ReservationNotFoundError(id);
      const charges = await financialRepo.getByReservationId(id);
      res.json(charges.map((c) => ({
        id: c.id, type: c.type, amount: c.amount, currency: c.currency,
        status: c.status, reservationId: c.reservationId, customerId: c.customerId, createdAt: c.createdAt,
      })));
    } catch (err) { next(err); }
  });

  // POST /
  router.post('/', authorize(MANAGERS), async (req, res, next) => {
    try {
      const body = CreateReservationSchema.parse(req.body);
      const { reservationService, customerRepo } = buildService(req, container);
      const existingCustomer = await customerRepo.getById(body.customer.id);
      if (!existingCustomer) {
        res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: `No existe un cliente con id "${body.customer.id}"` });
        return;
      }
      const reservation = await reservationService.createReservation({
        id:         randomUUID(),
        resourceId: body.resourceId,
        customer:   new Customer(existingCustomer.id, existingCustomer.fullName, existingCustomer.email),
        startTime:  new Date(body.startTime),
        endTime:    new Date(body.endTime),
        details:    body.details as Record<string, unknown>,
      });
      res.status(201).json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  // PATCH /:id
  router.patch('/:id', authorize(MANAGERS), async (req, res, next) => {
    try {
      const id = routeParam(req.params.id);
      const parsed = UpdateReservationSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          code:   'VALIDATION_ERROR',
          errors: parsed.error.errors.map((e) => ({ path: e.path.join('.'), message: e.message })),
        });
        return;
      }
      const { startTime, endTime, details } = parsed.data;
      const { reservationService } = buildService(req, container);

      // compact() elimina las claves undefined antes de pasar a updateReservation
      const updatePayload = compact({
        startTime: startTime ? new Date(startTime) : undefined,
        endTime:   endTime   ? new Date(endTime)   : undefined,
        details:   details   as Record<string, unknown> | undefined,
      });

      const reservation = await reservationService.updateReservation(id, updatePayload);
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  // POST /:id/confirm
  router.post('/:id/confirm', authorize(MANAGERS), async (req, res, next) => {
    try {
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.confirmReservation(routeParam(req.params.id), req.businessId!);
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  // POST /:id/cancel
  router.post('/:id/cancel', authorize(MANAGERS), async (req, res, next) => {
    try {
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.cancelReservation(routeParam(req.params.id), req.businessId!);
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  // POST /:id/complete
  router.post('/:id/complete', authorize(COMPLETERS), async (req, res, next) => {
    try {
      const { reservationService } = buildService(req, container);
      const reservation = await reservationService.completeReservation(routeParam(req.params.id), req.businessId!);
      res.json(toReservationDto(reservation));
    } catch (err) { next(err); }
  });

  return router;
}
