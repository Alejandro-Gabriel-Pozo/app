/**
 * @file stays.routes.ts
 * @description Endpoints de Check-in / Check-out.
 *
 * ## Permisos por endpoint
 *
 * | Endpoint | Roles | Descripción |
 * |---|---|---|
 * | GET  /stays                        | FRONT_DESK | Todas las estadías activas |
 * | GET  /stays/:id                    | FRONT_DESK | Detalle de estadía |
 * | GET  /stays/reservation/:rid       | FRONT_DESK | Stay de una reserva |
 * | GET  /stays/resource/:rid          | STAFF      | Ocupación actual de habitación |
 * | POST /stays/check-in               | FRONT_DESK | Check-in (crea Stay) |
 * | POST /stays/:id/check-out          | FRONT_DESK | Check-out (cierra Stay) |
 * | POST /stays/:id/no-show            | FRONT_DESK | Marcar NO_SHOW |
 *
 * ## exactOptionalPropertyTypes — campos opcionales en DTOs
 * CheckOutInput define `notes?: string` y `nextCleaningShift?: string`
 * (propiedades opcionales SIN undefined explícito en el tipo).
 *
 * Con exactOptionalPropertyTypes=true:
 *   { notes: undefined }  ← NO assignable a CheckOutInput  → TS2379
 *   { notes: 'texto'  }  ← SÍ assignable
 *   {}                    ← SÍ assignable (clave ausente)
 *
 * Solución: spread condicional para incluir la clave solo si tiene valor.
 *
 * NO hacer:
 *   service.checkOut({ stayId, businessId, notes: req.body.notes })  // TS2379
 *
 * SÍ hacer:
 *   service.checkOut({
 *     stayId, businessId,
 *     ...(notes !== undefined && { notes }),
 *     ...(shift !== undefined && { nextCleaningShift: shift }),
 *   })
 */

import { Router } from 'express';
import { authenticate, authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { StayService } from '../../services/stay.service.js';

export function createStaysRouter(service: StayService): Router {
  const router = Router();

  // ── GET /stays (estadías activas) ───────────────────────────────────────────
  router.get(
    '/',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const stays = await service.getActiveStays(req.user!.businessId as string);
        res.json(stays.map(s => s.toJSON()));
      } catch (err) { next(err); }
    },
  );

  // ── GET /stays/reservation/:reservationId ───────────────────────────────
  router.get(
    '/reservation/:reservationId',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const stay = await service.getStayByReservation(
          String(req.params['reservationId']),
          req.user!.businessId as string,
        );
        if (!stay) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Estadía no encontrada para esa reserva' });
          return;
        }
        res.json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── GET /stays/resource/:resourceId ─────────────────────────────────────
  router.get(
    '/resource/:resourceId',
    authenticate(),
    authorize(Roles.STAFF),
    async (req, res, next) => {
      try {
        const stay = await service.getActiveStayForResource(
          String(req.params['resourceId']),
          req.user!.businessId as string,
        );
        if (!stay) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Habitación libre' });
          return;
        }
        res.json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── GET /stays/:id ──────────────────────────────────────────────────────────
  router.get(
    '/:id',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const stay = await service.getStayById(
          String(req.params['id']),
          req.user!.businessId as string,
        );
        if (!stay) {
          res.status(404).json({ code: 'NOT_FOUND', message: 'Estadía no encontrada' });
          return;
        }
        res.json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /stays/check-in ─────────────────────────────────────────────────
  router.post(
    '/check-in',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const notes = req.body.notes as string | undefined;
        const stay = await service.checkIn({
          reservationId: req.body.reservationId as string,
          resourceId:    req.body.resourceId as string,
          businessId:    req.user!.businessId as string,
          assignedBy:    req.user!.id,
          ...(notes !== undefined && { notes }),
        });
        res.status(201).json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /stays/:id/check-out ─────────────────────────────────────────────
  router.post(
    '/:id/check-out',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        // Spread condicional obligatorio con exactOptionalPropertyTypes.
        // Si notes o nextCleaningShift son undefined, NO incluir la clave
        // en el objeto — CheckOutInput.notes?: string no acepta undefined.
        const notes = req.body.notes as string | undefined;
        const shift = req.body.nextCleaningShift as string | undefined;
        const stay = await service.checkOut({
          stayId:    String(req.params['id']),
          businessId: req.user!.businessId as string,
          ...(notes !== undefined && { notes }),
          ...(shift !== undefined && { nextCleaningShift: shift }),
        });
        res.json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /stays/:id/no-show ──────────────────────────────────────────────
  router.post(
    '/:id/no-show',
    authenticate(),
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const stay = await service.markNoShow(
          String(req.params['id']),
          req.user!.businessId as string,
        );
        res.json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  return router;
}
