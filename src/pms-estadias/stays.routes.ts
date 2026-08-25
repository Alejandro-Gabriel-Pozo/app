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
 * | POST /stays/check-in               | FRONT_DESK | Check-in (crea Stay). `overrideHousekeeping: true` requiere además MANAGEMENT (403 si no) — gating de limpieza, 25/08/2026 |
 * | POST /stays/:id/check-out          | FRONT_DESK | Check-out (cierra Stay) |
 * | POST /stays/:id/no-show            | FRONT_DESK | Marcar NO_SHOW |
 * | POST /stays/:id/transfer-to-receivable | MANAGEMENT | Transfiere el saldo pendiente a cuenta por cobrar de una empresa (A1, paso 2) |
 * | GET  /stays/:id/folio               | FRONT_DESK | Saldo + transacciones de la estadía (A1, paso 6) |
 *
 * authenticate() fue removido de cada handler: app.ts lo aplica
 * globalmente sobre /api/* antes de tenantMiddleware. Doble authenticate()
 * causaba 401 UNAUTHORIZED al re-leer el header en el segundo pase.
 *
 * ## exactOptionalPropertyTypes — campos opcionales en DTOs
 * Usar spread condicional: `...(notes !== undefined && { notes })`
 * CheckOutInput.notes?: string no acepta `undefined` explícito.
 */

import { Router } from 'express';
import { authorize } from '../security/auth.middleware.js';
import { Roles } from '../security/roles.js';
import type { StayService } from './stay.service.js';
import type { AccountsReceivableService } from '../clientes-finanzas/accounts-receivable.service.js';
import { CheckInSchema, CheckOutSchema, TransferToReceivableSchema } from '../api/schemas/stay.schemas.js';

export function createStaysRouter(
  service: StayService,
  arService: AccountsReceivableService,
): Router {
  const router = Router();

  // ── GET /stays (estadías activas) ───────────────────────────────────────────
  router.get(
    '/',
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
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const body = CheckInSchema.parse(req.body);
        // A6.6 — el rol condiciona la transición en el SERVIDOR, no alcanza
        // con ocultar el botón en el front. overrideHousekeeping=true pide
        // saltear el gating de limpieza (25/08/2026) -- rechazo explícito
        // si quien lo pide no es MANAGEMENT, en vez de ignorarlo en
        // silencio (que dejaría creer al front que se aplicó cuando no).
        if (body.overrideHousekeeping && !(req.user!.permissionGroups ?? []).includes(Roles.MANAGEMENT)) {
          res.status(403).json({
            code: 'FORBIDDEN',
            message: 'Solo un encargado puede forzar el check-in con la limpieza sin inspeccionar.',
          });
          return;
        }
        const stay = await service.checkIn({
          reservationId: body.reservationId,
          resourceId:    body.resourceId,
          businessId:    req.user!.businessId as string,
          assignedBy:    req.user!.id,
          ...(body.notes !== undefined && { notes: body.notes }),
          ...(body.overrideHousekeeping !== undefined && { overrideHousekeeping: body.overrideHousekeeping }),
        });
        res.status(201).json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /stays/:id/check-out ─────────────────────────────────────────────
  router.post(
    '/:id/check-out',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const body = CheckOutSchema.parse(req.body);
        const stay = await service.checkOut({
          stayId:     String(req.params['id']),
          businessId: req.user!.businessId as string,
          ...(body.notes !== undefined && { notes: body.notes }),
          ...(body.nextCleaningShift !== undefined && { nextCleaningShift: body.nextCleaningShift }),
        });
        res.json(stay.toJSON());
      } catch (err) { next(err); }
    },
  );

  // ── POST /stays/:id/no-show ──────────────────────────────────────────────
  router.post(
    '/:id/no-show',
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

  // ── GET /stays/:id/folio ─────────────────────────────────────────────────
  router.get(
    '/:id/folio',
    authorize(Roles.FRONT_DESK),
    async (req, res, next) => {
      try {
        const folio = await service.getFolio(
          String(req.params['id']),
          req.user!.businessId as string,
        );
        res.json(folio);
      } catch (err) { next(err); }
    },
  );

  // ── POST /stays/:id/transfer-to-receivable ──────────────────────────────
  // Solo MANAGEMENT (OWNER, ADMIN) puede autorizar esta transferencia —
  // decisión explícita del dueño del proyecto (A1, paso 2).
  router.post(
    '/:id/transfer-to-receivable',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const body = TransferToReceivableSchema.parse(req.body);
        const ar = await arService.transferStayBalanceToReceivable({
          stayId:            String(req.params['id']),
          businessId:        req.user!.businessId as string,
          companyCustomerId: body.companyCustomerId,
          transferredBy:     req.user!.id,
          notes:             body.notes ?? null,
        });
        res.status(201).json(ar);
      } catch (err) { next(err); }
    },
  );

  return router;
}
