/**
 * @file reports.routes.ts
 *
 * Permisos:
 * - Reportes operativos (ocupación) — MANAGEMENT (OWNER, ADMIN)
 * - HOUSEKEEPING y RECEPTIONIST no tienen acceso a reportes
 *
 * `authenticate()` local sacado de cada handler (14/08/2026): app.ts ya lo
 * aplica globalmente sobre /api/* antes de tenantMiddleware — mismo fix
 * que ya tenían housekeeping/reservations/resources/stays/users.routes.ts.
 * Acá quedó pendiente y se volvió un bug real recién con el cambio de
 * roles (security/roles.ts): el authenticate() global resuelve
 * permissionGroups vía un hook; un authenticate() local sin ese hook
 * pisaba req.user y los dejaba undefined, así que authorize(Roles.X)
 * rechazaba con 403 a todo el mundo.
 */

import { Router } from 'express';
import { authorize } from '../../security/auth.middleware.js';
import { Roles } from '../../security/roles.js';
import type { ReportService } from '../../services/report.service.js';

export function createReportsRouter(service: ReportService): Router {
  const router = Router();

  // ── GET /reports/occupancy ─────────────────────────────────────────────────
  // Reporte diario de ocupación por recurso en un período.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/occupancy',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateOccupancyReport(
          new Date(from),
          new Date(to),
        );
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/occupancy/summary ────────────────────────────────────────
  // Resumen ejecutivo: promedio, top/bottom recursos.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, limit=5 (opcional)
  router.get(
    '/occupancy/summary',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to, limit } = req.query as { from: string; to: string; limit?: string };
        const topLimit = limit ? parseInt(limit, 10) : 5;
        const summary = await service.generateOccupancySummary(
          req.businessId!,
          new Date(from),
          new Date(to),
          topLimit,
        );
        res.json(summary);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/occupancy/by-category ───────────────────────────────────
  // Ocupación agrupada por categoría de recurso.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/occupancy/by-category',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateOccupancyByResourceType(
          req.businessId!,
          new Date(from),
          new Date(to),
        );
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/occupancy/underutilized ──────────────────────────────────
  // Recursos con ocupación por debajo de un umbral.
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD, threshold=30 (opcional, %)
  router.get(
    '/occupancy/underutilized',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to, threshold } = req.query as {
          from: string;
          to: string;
          threshold?: string;
        };
        const thresholdValue = threshold ? parseFloat(threshold) : 30;
        const resources = await service.getUnderutilizedResources(
          req.businessId!,
          new Date(from),
          new Date(to),
          thresholdValue,
        );
        res.json(resources);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/accounts-receivable ──────────────────────────────────────
  // Cuentas por cobrar agrupadas por empresa, para el cierre de mes (A1, paso 5).
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/accounts-receivable',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateAccountsReceivableReport(
          new Date(from),
          new Date(to),
        );
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/pos/sales-by-product ─────────────────────────────────────
  // Ventas por producto/variante (D7, pendientes-2026-08-19.md sección D).
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/pos/sales-by-product',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateSalesByProductReport(new Date(from), new Date(to));
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/pos/waste ─────────────────────────────────────────────────
  // Mermas por producto/variante + motivo (D7).
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/pos/waste',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateWasteReport(new Date(from), new Date(to));
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/pos/ticket-summary ───────────────────────────────────────
  // Ticket promedio (D7).
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/pos/ticket-summary',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateTicketSummaryReport(new Date(from), new Date(to));
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/crm/new-vs-recurring ─────────────────────────────────────
  // Clientes nuevos vs. recurrentes (D7).
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/crm/new-vs-recurring',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateNewVsRecurringReport(new Date(from), new Date(to));
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /reports/crm/applied-rates ────────────────────────────────────────
  // Tarifas especiales aplicadas, combinando POS + Reservas (D7).
  // Query params: from=YYYY-MM-DD, to=YYYY-MM-DD
  router.get(
    '/crm/applied-rates',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { from, to } = req.query as { from: string; to: string };
        const report = await service.generateAppliedRatesReport(new Date(from), new Date(to));
        res.json(report);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /reports/occupancy/purge ───────────────────────────────────────
  // Elimina registros de ocupación anteriores a una fecha.
  // Query params: before=YYYY-MM-DD
  router.delete(
    '/occupancy/purge',
    authorize(Roles.MANAGEMENT),
    async (req, res, next) => {
      try {
        const { before } = req.query as { before: string };
        const deleted = await service.purgeOldRecords(new Date(before));
        res.json({ deleted });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
