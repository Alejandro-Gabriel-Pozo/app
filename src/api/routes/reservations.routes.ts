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
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { ReservationService } from '../../services/reservation.service.js';
import type { AuthenticatedUser } from '../../security/user.types.js';
import { UserRole } from '../../types/enums.js';

export function createReservationsRouter(service: ReservationService): Router {
  const router = Router();

  // ── GET /reservations ──────────────────────────────────────────────────────
  router.get(
    '/',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const businessId = req.user!.businessId!;
        const reservations = await service.listReservations(businessId);
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
        const businessId = req.user!.businessId!;
        const reservation = await service.getReservationById(req.params.id!, businessId);
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
        const businessId = user.businessId!;

        // Clientes externos usan su customer_id del JWT; staff usa el del body.
        const customerId =
          user.role === UserRole.CUSTOMER
            ? user.customerId!
            : req.body.customerId;

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
        const businessId = req.user!.businessId!;
        const updated = await service.updateReservation(
          req.params.id!,
          req.body,
          businessId,
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
        const businessId = req.user!.businessId!;
        const reservation = await service.confirmReservation(req.params.id!, businessId);
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
        const businessId = req.user!.businessId!;
        const reservation = await service.cancelReservation(req.params.id!, businessId);
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
        const businessId = req.user!.businessId!;
        const reservation = await service.completeReservation(req.params.id!, businessId);
        res.json(reservation);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
