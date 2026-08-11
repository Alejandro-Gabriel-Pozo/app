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
 */

import { Router }                        from 'express';
import { authorize }                     from '../../security/auth.middleware.js';
import { Roles }                         from '../../security/roles.js';
import { ReservationService }            from '../../services/reservation.service.js';
import { SqlReservationRepository }      from '../../repositories/sql.reservation.repository.js';
import { SqlResourceRepository }         from '../../repositories/sql.resource.repository.js';
import { SqlOccupancyRepository }        from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }         from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository }      from '../../repositories/sql.domain-event.repository.js';
import { SqlResourceLockRepository }     from '../../repositories/sql.resource-lock.repository.js';
import { buildTenantTransactionManager } from '../../db/tenant-context.js';
import type { AuthenticatedUser }        from '../../security/user.types.js';
import { UserRole }                      from '../../types/enums.js';

function buildReservationService(req: import('express').Request): ReservationService {
  const db                  = req.db;
  const resourceRepo        = new SqlResourceRepository(db);
  const reservationRepo     = new SqlReservationRepository(db, resourceRepo);
  const occupancyRepo       = new SqlOccupancyRepository(db);
  const categoryRepo        = new SqlCategoryRepository(db);
  const domainEventRepo     = new SqlDomainEventRepository(db);
  const resourceLockRepo    = new SqlResourceLockRepository(db);
  const transactionManager  = buildTenantTransactionManager(req);
  return new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    transactionManager,
    resourceLockRepo,
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
        res.json(reservations);
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
        res.json(reservation);
      } catch (err) { next(err); }
    },
  );

  // ── POST /reservations ─────────────────────────────────────────────────────
  router.post(
    '/',
    authorize(Roles.BOOKING),
    async (req, res, next) => {
      try {
        const user       = req.user as AuthenticatedUser;
        const businessId = user.businessId as string;

        // CUSTOMER — el customerId viene del JWT, no del body (anti-IDOR)
        const customerId =
          user.role === UserRole.CUSTOMER
            ? user.customerId!
            : req.body.customerId;

        const service     = buildReservationService(req);
        const reservation = await service.createReservation({
          ...req.body,
          customerId,
          businessId,
        });
        res.status(201).json(reservation);
      } catch (err) { next(err); }
    },
  );

  // ── PUT /reservations/:id ────────────────────────────────────────────────
  router.put(
    '/:id',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service = buildReservationService(req);
        const updated  = await service.updateReservation(req.params['id']!, req.body);
        res.json(updated);
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
        res.json(reservation);
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
        res.json(reservation);
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
        res.json(reservation);
      } catch (err) { next(err); }
    },
  );

  return router;
}
