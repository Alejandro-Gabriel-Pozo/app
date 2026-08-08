/**
 * @file reservations.routes.ts
 *
 * Permisos por endpoint:
 *
 * GET  /reservations          — FRONT_DESK (OWNER, ADMIN, RECEPTIONIST)
 * GET  /reservations/:id      — FRONT_DESK
 * POST /reservations          — BOOKING (+ CUSTOMER desde portal)
 * PUT  /reservations/:id      — FRONT_DESK
 * POST /reservations/:id/confirm   — FRONT_DESK
 * POST /reservations/:id/cancel    — FRONT_DESK
 * POST /reservations/:id/complete  — FRONT_DESK
 *
 * El ReservationService se construye por request usando req.db (SqlClient
 * del tenant inyectado por tenantMiddleware). Patrón idéntico a housekeeping
 * y stays en app.ts.
 */

import { Router }                        from 'express';
import { authenticate, authorize }       from '../../security/auth.middleware.js';
import { Roles }                         from '../../security/roles.js';
import { ReservationService }            from '../../services/reservation.service.js';
import { SqlReservationRepository }      from '../../repositories/sql.reservation.repository.js';
import { SqlResourceRepository }         from '../../repositories/sql.resource.repository.js';
import { SqlOccupancyRepository }        from '../../repositories/sql.occupancy.repository.js';
import { SqlCategoryRepository }         from '../../repositories/sql.category.repository.js';
import { SqlDomainEventRepository }      from '../../repositories/sql.domain-event.repository.js';
import { PgTransactionManager }          from '../../db/pg.transaction-manager.js';
import { getPlatformRawPool }            from '../../container.js';
import type { AuthenticatedUser }        from '../../security/user.types.js';
import { UserRole }                      from '../../types/enums.js';

function buildReservationService(req: import('express').Request): ReservationService {
  const db = req.db;
  const resourceRepo        = new SqlResourceRepository(db);
  const reservationRepo     = new SqlReservationRepository(db, resourceRepo);
  const occupancyRepo       = new SqlOccupancyRepository(db);
  const categoryRepo        = new SqlCategoryRepository(db);
  const domainEventRepo     = new SqlDomainEventRepository(db);
  const transactionManager  = new PgTransactionManager(getPlatformRawPool());
  return new ReservationService(
    reservationRepo,
    resourceRepo,
    occupancyRepo,
    categoryRepo,
    domainEventRepo,
    transactionManager,
  );
}

export function createReservationsRouter(): Router {
  const router = Router();

  // ── GET /reservations ──────────────────────────────────────────────────────
  router.get(
    '/',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const resourceRepo = new SqlResourceRepository(req.db);
        const repo = new SqlReservationRepository(req.db, resourceRepo);
        const reservations = await repo.getAll();
        res.json(reservations);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reservations/:id ──────────────────────────────────────────────────
  router.get(
    '/:id',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const resourceRepo = new SqlResourceRepository(req.db);
        const repo = new SqlReservationRepository(req.db, resourceRepo);
        const reservation = await repo.getById(req.params['id'] as string);
        if (!reservation) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Reserva no encontrada' });
          return;
        }
        res.json(reservation);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /reservations ─────────────────────────────────────────────────────
  router.post(
    '/',
    authenticate(),
    authorize(Roles.BOOKING),
    async (req, res, next) => {
      try {
        const user = req.user as AuthenticatedUser;
        const businessId = user.businessId as string;

        const customerId =
          user.role === UserRole.CUSTOMER
            ? user.customerId!
            : req.body.customerId;

        const service = buildReservationService(req);
        const reservation = await service.createReservation({
          ...req.body,
          customerId,
          businessId,
        });
        res.status(201).json(reservation);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PUT /reservations/:id ──────────────────────────────────────────────────
  router.put(
    '/:id',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const service = buildReservationService(req);
        const updated = await service.updateReservation(
          req.params['id'] as string,
          req.body,
        );
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /reservations/:id/confirm ────────────────────────────────────────
  router.post(
    '/:id/confirm',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const service = buildReservationService(req);
        const reservation = await service.confirmReservation(req.params['id'] as string, businessId);
        res.json(reservation);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /reservations/:id/cancel ─────────────────────────────────────────
  router.post(
    '/:id/cancel',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const service = buildReservationService(req);
        const reservation = await service.cancelReservation(req.params['id'] as string, businessId);
        res.json(reservation);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /reservations/:id/complete ───────────────────────────────────────
  router.post(
    '/:id/complete',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId as string;
        const service = buildReservationService(req);
        const reservation = await service.completeReservation(req.params['id'] as string, businessId);
        res.json(reservation);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
