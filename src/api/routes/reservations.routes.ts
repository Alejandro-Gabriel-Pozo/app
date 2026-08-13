/**
 * @file reservations.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET  /reservations                  — FRONT_DESK (OWNER, ADMIN, RECEPTIONIST)
 * GET  /reservations/:id              — FRONT_DESK
 * POST /reservations                  — BOOKING (empleados + CUSTOMER desde portal)
 * PUT  /reservations/:id              — FRONT_DESK
 * POST /reservations/:id/confirm      — FRONT_DESK
 * POST /reservations/:id/cancel       — FRONT_DESK
 * POST /reservations/:id/complete     — FRONT_DESK
 *
 * authenticate() fue removido de cada handler: app.ts lo aplica
 * globalmente sobre /api/* antes de tenantMiddleware. Tenerlo dos
 * veces causaba 401 UNAUTHORIZED porque el segundo intento re-leía
 * el header Authorization en un contexto donde req.user ya existía
 * pero el flujo bifurcaba.
 *
 * ## Transacciones (fix C1)
 * buildReservationService usa buildTenantTransactionManager(req) —
 * construido sobre el pool raw del TENANT, no el pool de plataforma.
 * Ver src/db/tenant-context.ts para el detalle.
 *
 * ## Validación (resource-locks, gestión + wiring)
 * POST y PUT antes NO validaban con Zod — hacían `...req.body` directo
 * hacia el service. Ahora usan CreateReservationSchema/UpdateReservationSchema
 * (src/api/schemas/request.schemas.ts), que ya existían pero nunca se
 * llamaban. De paso: `id` se genera server-side con randomUUID() en vez de
 * confiar en un `req.body.id` que ni siquiera estaba documentado — antes,
 * si el caller no lo mandaba, `new Reservation({id: undefined, ...})`
 * explotaba con un TypeError crudo (`undefined.trim()`) en vez de un 400 claro.
 *
 * ## Asignación diferida (auditoría de deuda estructural, item #4)
 * POST /reservations acepta `resourceId` (recurso puntual, flujo de
 * siempre) O `categoryId` (el servicio elige el primer recurso libre de
 * esa categoría vía ReservationService.findAvailableResourceInCategory).
 * Si no hay ninguno libre, responde 409 NO_RESOURCE_AVAILABLE en vez de
 * crear la reserva.
 *
 * ## Respuestas — toReservationDto (encontrado al construir detalle/edición)
 * Todos los handlers antes respondían con `res.json(reservation)` — el
 * objeto de dominio crudo. `Reservation.status` es un getter sobre el campo
 * privado `_status`; `JSON.stringify` de una clase NO serializa getters
 * (solo propiedades propias), así que el JSON real tenía `_status`, nunca
 * `status`. `customer` también viajaba como la instancia completa de
 * `Customer` (con `displayName`/`contactMethods`, sin `fullName`/`email`
 * planos — esos también son getters). El frontend esperaba `status` y
 * `customer.fullName`/`email` desde siempre; nunca los recibió. Ahora todas
 * las respuestas pasan por `toReservationDto()` (el mismo mapper que ya
 * usaba customer.routes.ts).
 */

import { Router }                        from 'express';
import type { Request }                  from 'express';
import { randomUUID }                    from 'node:crypto';
import { authorize }                     from '../../security/auth.middleware.js';
import { Roles }                         from '../../security/roles.js';
import { ReservationService }            from '../../services/reservation.service.js';
import { SqlReservationRepository }      from '../../repositories/sql.reservation.repository.js';
import { SqlResourceRepository }         from '../../repositories/sql.resource.repository.js';
import { SqlOccupancyRepository }        from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }         from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository }      from '../../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository }     from '../../repositories/sql.resource-lock.repository.js';
import { SqlBookableServiceRepository }  from '../../repositories/sql.bookable-service.repository.js';
import { SqlCustomerRepository }         from '../../repositories/sql.customer.repository.js';
import { SqlCustomerRateRepository }     from '../../repositories/sql.customer-rate.repository.js';
import { SqlOperatingHoursRepository }   from '../../repositories/sql.operating-hours.repository.js';
import { SqlHousekeepingRepository }     from '../../repositories/housekeeping.repository.js';
import { buildTenantTransactionManager } from '../../db/tenant-context.js';
import { CreateReservationSchema, UpdateReservationSchema } from '../schemas/request.schemas.js';
import { toReservationDto }              from '../mappers/reservation.mapper.js';

function buildReservationService(req: Request): ReservationService {
  const db                    = req.db;
  const resourceRepo          = new SqlResourceRepository(db);
  const reservationRepo       = new SqlReservationRepository(db, resourceRepo);
  const occupancyRepo         = new SqlOccupancyRepository(db);
  const categoryRepo          = new SqlCategoryRepository(db);
  const domainEventRepo       = new SqlDomainEventRepository(db);
  const resourceLockRepo      = new SqlResourceLockRepository(db);
  const bookableServiceRepo   = new SqlBookableServiceRepository(db);
  const customerRateRepo      = new SqlCustomerRateRepository(db);
  const operatingHoursRepo    = new SqlOperatingHoursRepository(db);
  const housekeepingRepo      = new SqlHousekeepingRepository(db);
  const transactionManager    = buildTenantTransactionManager(req);
  return new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    transactionManager,
    resourceLockRepo,
    bookableServiceRepo,
    customerRateRepo,
    operatingHoursRepo,
    housekeepingRepo,
  );
}

export function createReservationsRouter(): Router {
  const router = Router();

  // ── GET /reservations ──────────────────────────────────────────────────────
  router.get(
    '/',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const resourceRepo = new SqlResourceRepository(req.db);
        const repo         = new SqlReservationRepository(req.db, resourceRepo);
        const reservations = await repo.getAll();
        res.json(reservations.map(toReservationDto));
      } catch (err) { next(err); }
    },
  );

  // ── GET /reservations/:id ────────────────────────────────────────────────
  router.get(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const resourceRepo = new SqlResourceRepository(req.db);
        const repo         = new SqlReservationRepository(req.db, resourceRepo);
        const reservation  = await repo.getById(req.params['id']!);
        if (!reservation) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
          return;
        }
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations ─────────────────────────────────────────────────────
  router.post(
    '/',
    authorize(Roles.BOOKING),
    async (req, res, next) => {
      try {
        const body = CreateReservationSchema.parse(req.body);

        const customer = await new SqlCustomerRepository(req.db).getById(body.customer.id);
        if (!customer) {
          res.status(404).json({ code: 'CUSTOMER_NOT_FOUND', message: `Cliente con id "${body.customer.id}" no encontrado` });
          return;
        }

        const service = buildReservationService(req);

        // resourceId directo (flujo de siempre) o resuelto por categoría
        // (asignación diferida — ver findAvailableResourceInCategory).
        let resourceId = body.resourceId;
        if (!resourceId && body.categoryId) {
          const available = await service.findAvailableResourceInCategory({
            categoryId: body.categoryId,
            startTime:  new Date(body.startTime),
            ...(body.serviceId !== undefined && { serviceId: body.serviceId }),
            ...(body.endTime   !== undefined && { endTime: new Date(body.endTime) }),
          });
          if (!available) {
            res.status(409).json({
              code:    'NO_RESOURCE_AVAILABLE',
              message: `No hay ningún recurso disponible de la categoría "${body.categoryId}" en ese rango.`,
            });
            return;
          }
          resourceId = available.id;
        }

        const reservation = await service.createReservation({
          id:         randomUUID(),
          resourceId: resourceId!, // garantizado por el refine de CreateReservationSchema + el bloque anterior
          customer,
          startTime:  new Date(body.startTime),
          details:    body.details,
          ...(body.serviceId !== undefined && { serviceId: body.serviceId }),
          ...(body.endTime   !== undefined && { endTime: new Date(body.endTime) }),
        });
        res.status(201).json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── PUT /reservations/:id ────────────────────────────────────────────────
  router.put(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const body = UpdateReservationSchema.parse(req.body);
        const service = buildReservationService(req);
        const updated = await service.updateReservation(req.params['id']!, {
          ...(body.startTime !== undefined && { startTime: new Date(body.startTime) }),
          ...(body.endTime   !== undefined && { endTime: new Date(body.endTime) }),
          ...(body.details   !== undefined && { details: body.details }),
        });
        res.json(toReservationDto(updated));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/confirm ──────────────────────────────────────
  router.post(
    '/:id/confirm',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service     = buildReservationService(req);
        const reservation = await service.confirmReservation(
          req.params['id']!,
          req.user!.businessId as string,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/cancel ───────────────────────────────────────
  router.post(
    '/:id/cancel',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service     = buildReservationService(req);
        const reservation = await service.cancelReservation(
          req.params['id']!,
          req.user!.businessId as string,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations/:id/complete ─────────────────────────────────────
  router.post(
    '/:id/complete',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service     = buildReservationService(req);
        const reservation = await service.completeReservation(
          req.params['id']!,
          req.user!.businessId as string,
        );
        res.json(toReservationDto(reservation));
      } catch (err) { next(err); }
    },
  );

  return router;
}
